import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../database/db.js';
import { errorMessage } from '../core/errors.js';
import { matchRecordedBaseline } from './baseline.js';
import { parseNoteStructure } from './frontmatter.js';
import { VAULT_FOLDERS } from './types.js';
import { extractWikilinks } from './wikilinks.js';
import type { VaultNoteRow } from './writer.js';

/**
 * `vault check`: read-only health check of a site vault.
 * - broken and ambiguous wikilinks (path-aware links resolve from the vault
 *   root; bare names resolve by unique file name, like Obsidian)
 * - conflict artifacts and notes whose generated region was edited (the next
 *   render will create a conflict artifact instead of overwriting)
 * - malformed notes (unsafe YAML, broken markers), duplicate note ids,
 *   symlinks (never followed), leftover temp files, missing tracked notes
 * - stale duplicates: content notes written by earlier versions of the
 *   `content` commands (their own paths and ids) for records that the vault
 *   renderer now presents in its own note; nothing updates them any more
 */

export type VaultIssueCode =
  | 'broken_link'
  | 'ambiguous_link'
  | 'conflict_artifact'
  | 'edited_generated_region'
  | 'malformed_note'
  | 'duplicate_id'
  | 'symlink'
  | 'temp_file'
  | 'missing_tracked_note'
  | 'missing_folder'
  | 'stale_duplicate';

export interface VaultCheckIssue {
  severity: 'error' | 'warning' | 'info';
  code: VaultIssueCode;
  relPath: string;
  detail: string;
  target?: string;
  line?: number;
}

export interface VaultCheckReport {
  vaultDir: string;
  exists: boolean;
  notesScanned: number;
  linksChecked: number;
  issues: VaultCheckIssue[];
  counts: { errors: number; warnings: number; info: number };
  ok: boolean;
}

const CONFLICT_RE = /\.conflict-\d{8}T\d{6}Z(?:-\d+)?\.md$/;

/**
 * Note types written by earlier versions of the `content` commands
 * (src/content/notes.ts wrote them next to the vault renderer's notes, with
 * their own paths and ids). The vault renderer is now the only writer of
 * content notes; for each legacy type, the id of the note that presents the
 * same record now. `vault render` marks tracked legacy notes stale (stale.ts).
 */
export const LEGACY_CONTENT_NOTE_TYPES: Readonly<Record<string, { label: string; currentId: (fm: Record<string, unknown>, siteId: string) => string | null }>> = {
  content_item: { label: 'content opportunity', currentId: (fm) => itemIdOf(fm) },
  content_brief: { label: 'content brief', currentId: (fm) => (itemIdOf(fm) ? `${itemIdOf(fm)}.brief` : null) },
  content_draft: { label: 'content draft', currentId: (fm) => (itemIdOf(fm) ? `${itemIdOf(fm)}.draft` : null) },
  content_pipeline: { label: 'content pipeline', currentId: (fm, siteId) => `content-farm-${typeof fm.site === 'string' && fm.site ? fm.site : siteId}` },
};

function itemIdOf(fm: Record<string, unknown>): string | null {
  if (typeof fm.content_item_id === 'string' && fm.content_item_id) return fm.content_item_id;
  const id = typeof fm.id === 'string' ? fm.id : '';
  return id.startsWith('content-item-') ? id.slice('content-item-'.length) || null : null;
}

/** The legacy content-note type of a parsed note (by its `type`, or the id prefix those notes used), or null. */
export function legacyContentNoteType(fm: Record<string, unknown>): string | null {
  const type = typeof fm.type === 'string' ? fm.type : typeof fm.kind === 'string' ? fm.kind : '';
  if (type in LEGACY_CONTENT_NOTE_TYPES) return type;
  const id = typeof fm.id === 'string' ? fm.id : '';
  const byPrefix: Array<[string, string]> = [['content-item-', 'content_item'], ['content-brief-', 'content_brief'], ['content-draft-', 'content_draft'], ['content-pipeline-', 'content_pipeline']];
  return byPrefix.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git']);

interface FileEntry {
  relPath: string;
  abs: string;
}

function walk(vaultDir: string, issues: VaultCheckIssue[]): { notes: FileEntry[]; allFiles: string[] } {
  const notes: FileEntry[] = [];
  const allFiles: string[] = [];
  const visit = (dirAbs: string, dirRel: string) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({ severity: 'warning', code: 'symlink', relPath: rel, detail: 'Symlink inside the vault; seo-agent never follows or writes through it.' });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/^\..+\.tmp-\d+-[0-9a-f]+$/.test(entry.name)) {
        issues.push({ severity: 'warning', code: 'temp_file', relPath: rel, detail: 'Leftover temporary file from an interrupted write; safe to delete.' });
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      allFiles.push(rel);
      if (entry.name.toLowerCase().endsWith('.md')) notes.push({ relPath: rel, abs });
    }
  };
  visit(vaultDir, '');
  return { notes, allFiles };
}

export function checkVault(opts: { db: Db; siteId: string; vaultDir: string }): VaultCheckReport {
  const { db, siteId, vaultDir } = opts;
  const issues: VaultCheckIssue[] = [];
  const report = (): VaultCheckReport => {
    const counts = { errors: 0, warnings: 0, info: 0 };
    for (const i of issues) counts[i.severity === 'error' ? 'errors' : i.severity === 'warning' ? 'warnings' : 'info']++;
    return { vaultDir, exists, notesScanned, linksChecked, issues, counts, ok: counts.errors === 0 };
  };
  let notesScanned = 0;
  let linksChecked = 0;
  const exists = existsSync(vaultDir) && lstatSync(vaultDir).isDirectory() && !lstatSync(vaultDir).isSymbolicLink();
  if (!exists) {
    issues.push({ severity: 'error', code: 'missing_folder', relPath: '.', detail: 'The site vault does not exist. Run `npm run cli -- vault init`.' });
    return report();
  }
  for (const folder of VAULT_FOLDERS) {
    if (!existsSync(path.join(vaultDir, folder))) issues.push({ severity: 'info', code: 'missing_folder', relPath: folder, detail: 'Standard folder is missing (`vault init` recreates missing folders without overwriting anything).' });
  }
  const { notes, allFiles } = walk(vaultDir, issues);
  const pathSet = new Set(allFiles.map((f) => f.toLowerCase()));
  const byBasename = new Map<string, string[]>();
  for (const f of allFiles) {
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    const list = byBasename.get(base) ?? [];
    list.push(f);
    byBasename.set(base, list);
  }
  const ids = new Map<string, string[]>();
  const legacy: Array<{ relPath: string; id: string; type: string; currentId: string | null; marked: boolean }> = [];

  for (const note of notes) {
    notesScanned++;
    const raw = readFileSync(note.abs, 'utf8');
    const isConflict = CONFLICT_RE.test(note.relPath);
    const isBackup = note.relPath.startsWith('14 System Logs/Conflicts/');
    if (isConflict) {
      issues.push({ severity: 'warning', code: 'conflict_artifact', relPath: note.relPath, detail: 'Conflict artifact: a generated note was not overwritten because it had human edits. Review, resolve, then delete this file.' });
    }
    let bodyForLinks = raw;
    try {
      const parsed = parseNoteStructure(raw, note.relPath);
      bodyForLinks = parsed.body;
      const id = parsed.frontmatter.id;
      if (typeof id === 'string' && id && !isConflict && !isBackup) {
        const list = ids.get(id) ?? [];
        list.push(note.relPath);
        ids.set(id, list);
      }
      const legacyType = isConflict || isBackup || note.relPath.startsWith('Templates/') ? null : legacyContentNoteType(parsed.frontmatter);
      if (legacyType) legacy.push({ relPath: note.relPath, id: typeof id === 'string' ? id : '', type: legacyType, currentId: LEGACY_CONTENT_NOTE_TYPES[legacyType]!.currentId(parsed.frontmatter, siteId), marked: parsed.frontmatter.status === 'stale' });
      // Wikilinks inside text properties (Obsidian requires them to be quoted).
      for (const v of Object.values(parsed.frontmatter)) {
        const values = Array.isArray(v) ? v : [v];
        for (const x of values) if (typeof x === 'string' && x.includes('[[')) bodyForLinks += `\n${x}`;
      }
    } catch (err) {
      issues.push({ severity: 'error', code: 'malformed_note', relPath: note.relPath, detail: errorMessage(err) });
      const split = raw.indexOf('\n---', 3);
      bodyForLinks = raw.startsWith('---') && split !== -1 ? raw.slice(split + 4) : raw;
    }
    if (note.relPath.startsWith('Templates/') || isConflict || isBackup) continue;
    const dir = note.relPath.includes('/') ? note.relPath.slice(0, note.relPath.lastIndexOf('/')) : '';
    for (const link of extractWikilinks(bodyForLinks)) {
      const target = link.target.replace(/\\$/, '').trim();
      if (!target) continue; // same-note heading/block link
      linksChecked++;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // URI-style links are not vault links
      const bare = target.replace(/\.md$/i, '');
      // Obsidian resolves "name" to "name.md"; a dotted name may also be a real file with an extension.
      const candidates = /\.md$/i.test(target) ? [`${bare}.md`] : [`${bare}.md`, target];
      if (target.includes('/')) {
        const found = candidates.some((c) => {
          const normalized = path.posix.normalize(c);
          if (pathSet.has(normalized.toLowerCase())) return true;
          const relative = path.posix.normalize(dir ? `${dir}/${c}` : c);
          return !relative.startsWith('..') && pathSet.has(relative.toLowerCase());
        });
        if (!found) issues.push({ severity: 'error', code: 'broken_link', relPath: note.relPath, target: link.target, line: link.line, detail: `Wikilink target does not exist: ${link.raw}` });
        continue;
      }
      const matches = [...new Set(candidates.flatMap((c) => byBasename.get(c.toLowerCase()) ?? []))];
      if (matches.length === 1) continue;
      if (matches.length === 0) {
        issues.push({ severity: 'error', code: 'broken_link', relPath: note.relPath, target: link.target, line: link.line, detail: `Wikilink target does not exist: ${link.raw}` });
      } else {
        issues.push({ severity: 'warning', code: 'ambiguous_link', relPath: note.relPath, target: link.target, line: link.line, detail: `Shortest-path link matches ${matches.length} notes (${matches.join(', ')}); use a full vault path.` });
      }
    }
  }

  for (const [id, paths] of ids) {
    if (paths.length > 1) issues.push({ severity: 'warning', code: 'duplicate_id', relPath: paths[0]!, detail: `Note id "${id}" is used by ${paths.length} notes: ${paths.join(', ')}` });
  }

  // Content notes written by earlier versions of the `content` commands: a second, stale note for a record.
  for (const l of legacy) {
    const label = LEGACY_CONTENT_NOTE_TYPES[l.type]!.label;
    const current = l.currentId ? (ids.get(l.currentId) ?? []).filter((p) => p !== l.relPath) : [];
    const cleanup = 'Copy any text you added to it into that note (outside its generated markers), then delete this file; seo-agent never deletes notes.';
    const state = l.marked ? 'is marked stale (`vault render` removed its old generated content)' : 'is no longer updated, so its stage, status, and approval text may be out of date';
    issues.push({
      severity: 'warning',
      code: 'stale_duplicate',
      relPath: l.relPath,
      ...(current[0] ? { target: current[0] } : {}),
      detail: current.length
        ? `Stale duplicate: this ${label} note${l.id ? ` (id "${l.id}")` : ''} was written by an earlier version of the \`content\` commands and ${state}. The current note for the same record is ${current[0]} (\`vault render\` keeps it up to date). ${cleanup}`
        : `Stale duplicate: this ${label} note${l.id ? ` (id "${l.id}")` : ''} was written by an earlier version of the \`content\` commands and ${state}. The vault renderer presents the same record in its own note: run \`npm run cli -- vault render --only content\` to create it${l.currentId ? ` (id "${l.currentId}")` : ''}, then ${cleanup.charAt(0).toLowerCase()}${cleanup.slice(1)}`,
    });
  }

  // Tracked generated notes: missing files and edited generated regions.
  const rows = db.all<VaultNoteRow>('SELECT * FROM vault_notes WHERE site_id = ? ORDER BY rel_path', [siteId]);
  for (const row of rows) {
    const abs = path.join(vaultDir, ...row.rel_path.split('/'));
    if (!existsSync(abs)) {
      if (row.ownership !== 'human') issues.push({ severity: 'info', code: 'missing_tracked_note', relPath: row.rel_path, detail: 'Tracked generated note is missing on disk; the next render recreates it.' });
      continue;
    }
    if (row.ownership === 'human') continue;
    try {
      if (lstatSync(abs).isSymbolicLink()) continue;
      const parsed = parseNoteStructure(readFileSync(abs, 'utf8'), row.rel_path);
      if (!parsed.location) {
        issues.push({ severity: 'warning', code: 'edited_generated_region', relPath: row.rel_path, detail: 'Generated markers were removed; the next render will create a conflict artifact instead of overwriting.' });
        continue;
      }
      if (!matchRecordedBaseline(row, parsed.frontmatter, parsed.location.region)) {
        issues.push({
          severity: 'warning',
          code: 'edited_generated_region',
          relPath: row.rel_path,
          detail: 'Generated content was edited by hand. The next render will write a conflict artifact and leave this note unchanged. Move edits outside the markers or run `vault resolve`.',
        });
      }
    } catch {
      /* malformed notes are reported above */
    }
    if (row.conflict_path && existsSync(path.join(vaultDir, ...row.conflict_path.split('/')))) {
      issues.push({ severity: 'info', code: 'conflict_artifact', relPath: row.rel_path, target: row.conflict_path, detail: `Open conflict recorded for this note: ${row.conflict_path}` });
    }
  }

  return report();
}
