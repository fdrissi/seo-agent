import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { budgetTimeZone, type AppContext } from '../app/context.js';
import { systemClock, type Clock } from '../core/clock.js';
import { AppError, ValidationError, errorMessage } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { silentLogger, type Logger } from '../core/logger.js';
import { dateInZone } from '../core/time.js';
import { siteVaultDir } from '../config/paths.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import { redactString } from '../security/redact.js';
import { DEFAULT_GENERATED_KEYS, matchRecordedBaseline, parseKeyList } from './baseline.js';
import {
  composeRegion,
  editFrontmatterText,
  generatedContentHash,
  MERGEABLE_LIST_KEYS,
  mergeListProperty,
  neutralizeMarkers,
  normalizePropertyValue,
  parseFrontmatterBlock,
  parseNoteStructure,
  pickProps,
  sanitizePropertyText,
  serializeFrontmatter,
  singleLine,
  type ParsedNoteStructure,
} from './frontmatter.js';
import {
  appendDurable,
  atomicWriteFile,
  ConcurrentModificationError,
  ensureVaultDir,
  resolveInVault,
  validateVaultRelPath,
  type AtomicWriteHooks,
} from './fs-safe.js';
import { codeBlock, inline, markBidiControls, redactVaultMarkdown, redactVaultText, vaultPathLeaksSecret } from './markdown.js';
import type { GeneratedNote, ParsedNote, VaultWriter, WriteOutcome } from './types.js';
import { formatWikilink, noteFileName } from './wikilinks.js';

/**
 * File-backed VaultWriter for one site vault (`<workspace>/vault/<site-id>`).
 *
 * Write algorithm for a generated note:
 * 1. Validate the vault-relative path (no traversal, no hidden/human-only
 *    folders, no symlinked components, no secret-like value) and build the
 *    generated properties (`id`, `type`, `site`, `generated_at`,
 *    `source_ids`, ...). Secrets never enter the vault: the body, the title,
 *    and every generated property value are redacted (registered secrets,
 *    credential shapes, credential URL parameters) before hashing and writing.
 * 2. New file: create it atomically (create-only, never overwrites).
 * 3. Existing file: parse it strictly. If it cannot be parsed, has missing or
 *    malformed markers, belongs to another note id, is untracked, or its
 *    generated properties/region match neither the recorded nor the pending
 *    hash in `vault_notes` (a human edited generated content), write a
 *    conflict artifact `<name>.conflict-<timestamp>.md` next to it and do NOT
 *    overwrite. A note that already holds exactly the new generated content is
 *    adopted instead (for example after a crash between the file write and the
 *    database update).
 * 4. Unchanged generated content: no write ('unchanged').
 * 5. Otherwise merge: the frontmatter is edited in place (generated keys set or
 *    removed; human keys, comments, and key order untouched; shared lists such
 *    as `tags` keep human entries), human text before/after the markers is
 *    copied verbatim, and the region is replaced. The pending hash is recorded
 *    first; the replacement is atomic and guarded by an optimistic check that
 *    the file did not change while we were working.
 */

export const CORE_GENERATED_KEYS = ['id', 'type', 'site', 'generated_at', 'source_ids'] as const;
/** Generated keys whose values are validated identifiers (never sanitized as display text). */
const IDENTIFIER_KEYS = new Set(['id', 'type', 'site', 'generated_at']);
const PROPERTY_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const NOTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
export const SYSTEM_LOG_FOLDER = '14 System Logs';
export const CONFLICT_BACKUP_FOLDER = '14 System Logs/Conflicts';

const HUMAN_AREA = [
  '## Notes',
  '',
  '<!-- Human-owned area: anything outside the generated markers is preserved when seo-agent re-renders this note. -->',
  '',
].join('\n');

export interface VaultNoteRow {
  site_id: string;
  rel_path: string;
  note_id: string;
  kind: string;
  ownership: 'generated' | 'human' | 'mixed';
  last_written_hash: string | null;
  last_generated_hash: string | null;
  last_written_at: string | null;
  conflict_path: string | null;
  generated_keys_json: string | null;
  conflict_detected_at: string | null;
  pending_generated_hash: string | null;
  pending_generated_keys_json: string | null;
}

export interface VaultWriteOutcome extends WriteOutcome {
  noteId: string;
  kind: string;
  /** Why a note was not written (conflicts, detached notes). */
  reason?: string;
  dryRun?: boolean;
}

export interface FileVaultWriterOptions {
  db: Db;
  siteId: string;
  /** Absolute site vault directory, normally `<workspace>/vault/<site-id>`. */
  vaultDir: string;
  /** Workspace vault root (parent of vaultDir). Defaults to dirname(vaultDir). */
  vaultRoot?: string;
  /** IANA zone used to name daily system-log notes. */
  timeZone: string;
  clock?: Clock;
  logger?: Logger;
  /** Compute outcomes without touching files or the database. */
  dryRun?: boolean;
  /** Label every generated note as synthetic (demo). */
  synthetic?: boolean;
  /** Test hooks for atomic-write failure injection. */
  atomicHooks?: AtomicWriteHooks;
}

export interface ResolveResult {
  relPath: string;
  mode: 'use_generated' | 'detach';
  backupPath: string | null;
  nextStep: string;
}

function compactTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function posixBasenameNoExt(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * A generated text property as written to the frontmatter: bidi embedding,
 * override, and isolate controls become visible `[U+XXXX]` markers first (so a
 * right-to-left override in a title or keyword cannot make the property read
 * differently from the stored text), then the text is made inert
 * (`sanitizePropertyText`; marking first means a marker next to `[` or `]` is
 * split like any other bracket and cannot form `[[` or `](`), then redacted.
 * The marking is not part of `redactVaultText`: file names and the secret
 * check on paths use that function and must not gain markers.
 */
function propertyText(value: string): string {
  return redactVaultText(sanitizePropertyText(markBidiControls(value)));
}

function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((k) => sa.has(k));
}

export class FileVaultWriter implements VaultWriter {
  readonly siteId: string;
  readonly vaultDir: string;
  readonly vaultRoot: string;
  readonly dryRun: boolean;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly timeZone: string;
  private readonly synthetic: boolean;
  private readonly hooks: AtomicWriteHooks | undefined;
  private readonly planned = new Set<string>();
  private vaultReady = false;
  /** System-log lines that would have been written in dry-run mode. */
  readonly dryRunLog: string[] = [];

  constructor(opts: FileVaultWriterOptions) {
    this.db = opts.db;
    this.siteId = opts.siteId;
    this.vaultDir = path.resolve(opts.vaultDir);
    this.vaultRoot = path.resolve(opts.vaultRoot ?? path.dirname(this.vaultDir));
    this.timeZone = opts.timeZone;
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.dryRun = !!opts.dryRun;
    this.synthetic = !!opts.synthetic;
    this.hooks = opts.atomicHooks;
  }

  // ---------------------------------------------------------------- planning & links

  /** Register a note that is being generated in this run (valid link target before it is written). */
  plan(relPath: string): void {
    this.planned.add(validateVaultRelPath(relPath, 'link').toLowerCase());
  }

  /** Withdraw a planned note (it failed to build or write), so later links treat it as absent. */
  unplan(relPath: string): void {
    this.planned.delete(relPath.toLowerCase());
  }

  isPlanned(relPath: string): boolean {
    return this.planned.has(relPath.toLowerCase());
  }

  /** True when a regular note file exists at this vault path. */
  exists(relPath: string): boolean {
    const rel = validateVaultRelPath(relPath, 'read');
    const abs = resolveInVault(this.vaultDir, rel, { createParents: false });
    return existsSync(abs);
  }

  /**
   * Path-aware wikilink `[[folder/Note|alias]]`. The target must exist in the
   * vault or be registered as being generated in this run; otherwise NOT_FOUND
   * is thrown (no silent broken links).
   */
  link(toRelPath: string, alias?: string): string {
    const rel = /\.md$/i.test(toRelPath) ? toRelPath : `${toRelPath}.md`;
    validateVaultRelPath(rel, 'link');
    if (!this.isPlanned(rel) && !this.exists(rel)) {
      throw new AppError('NOT_FOUND', `Wikilink target is neither an existing note nor being generated: ${rel}`, {
        hint: 'Plan the target note (writer.plan) before linking, or link only to notes that exist.',
      });
    }
    return formatWikilink(rel, alias);
  }

  // ---------------------------------------------------------------- reads

  readNote(relPath: string): ParsedNote | null {
    const parsed = this.readStructure(relPath);
    if (!parsed) return null;
    return { frontmatter: parsed.frontmatter, body: parsed.body, raw: parsed.raw, generatedRegion: parsed.generatedRegion };
  }

  private readStructure(relPath: string): ParsedNoteStructure | null {
    const rel = validateVaultRelPath(relPath, 'read', { requireMd: true });
    const abs = resolveInVault(this.vaultDir, rel, { createParents: false });
    if (!existsSync(abs)) return null;
    return parseNoteStructure(readFileSync(abs, 'utf8'), rel);
  }

  getRow(relPath: string): VaultNoteRow | undefined {
    return this.db.get<VaultNoteRow>('SELECT * FROM vault_notes WHERE site_id = ? AND rel_path = ?', [this.siteId, relPath]);
  }

  getRowByNoteId(noteId: string): VaultNoteRow | undefined {
    return this.db.get<VaultNoteRow>('SELECT * FROM vault_notes WHERE site_id = ? AND note_id = ?', [this.siteId, noteId]);
  }

  // ---------------------------------------------------------------- generated notes

  /**
   * Generated properties in stable order. Renderer-supplied keys cannot
   * override core keys. Text values come from the database (page titles,
   * scraped source titles, model output), so every text value except the
   * validated identifiers is made inert: no wikilinks, Markdown links, or
   * non-http(s) URIs (see `sanitizePropertyText`), and bidi controls are shown
   * as `[U+XXXX]` markers (`propertyText`). Put links in the body.
   */
  buildGeneratedProperties(note: GeneratedNote, generatedAt: string): Record<string, unknown> {
    const rawSources = note.frontmatter.source_ids;
    const sourceIds = (Array.isArray(rawSources) ? rawSources : rawSources === undefined || rawSources === null ? [] : [rawSources]).map((s) => singleLine(String(s))).filter(Boolean);
    const fm: Record<string, unknown> = {
      id: note.noteId,
      type: note.kind,
      site: this.siteId,
      generated_at: generatedAt,
      source_ids: [...new Set(sourceIds)],
      title: singleLine(note.title),
    };
    for (const [key, value] of Object.entries(note.frontmatter)) {
      if (key in fm) continue;
      if (!PROPERTY_KEY_RE.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new ValidationError(`Invalid generated property name: ${JSON.stringify(key)}`);
      }
      const v = normalizePropertyValue(value, key);
      if (v !== undefined) fm[key] = v;
    }
    if (this.synthetic && !('synthetic' in fm)) fm.synthetic = true;
    if (!('tags' in fm)) fm.tags = [`seo-agent/${note.kind.replace(/[^A-Za-z0-9_-]/g, '_')}`];
    for (const [key, value] of Object.entries(fm)) {
      if (IDENTIFIER_KEYS.has(key)) continue;
      if (typeof value === 'string') fm[key] = propertyText(value);
      else if (Array.isArray(value)) fm[key] = value.map((x) => (typeof x === 'string' ? propertyText(x) : x));
    }
    return fm;
  }

  writeGenerated(note: GeneratedNote): VaultWriteOutcome {
    const relPath = validateVaultRelPath(note.relPath, 'generated');
    if (vaultPathLeaksSecret(relPath)) {
      throw new AppError('UNSAFE_PATH', 'Refusing to write a vault note whose path contains a secret-like value (a registered secret, credential shape, or credential URL parameter).', {
        hint: 'Plan note names through NotePlan/noteFileName, which redact secrets before building file names.',
      });
    }
    if (!NOTE_ID_RE.test(note.noteId)) throw new ValidationError(`Invalid note id: ${JSON.stringify(note.noteId)}`);
    if (!note.kind || !/^[a-z][a-z0-9_]{0,63}$/.test(note.kind)) throw new ValidationError(`Invalid note kind: ${JSON.stringify(note.kind)}`);
    const nowIso = this.clock.now().toISOString();
    const fm = this.buildGeneratedProperties(note, nowIso);
    const body = neutralizeMarkers(redactVaultMarkdown(note.body));
    const newHash = generatedContentHash(fm, body);
    const keys = Object.keys(fm);
    this.planned.add(relPath.toLowerCase());
    const base = { relPath, noteId: note.noteId, kind: note.kind, ...(this.dryRun ? { dryRun: true } : {}) };

    const abs = this.prepareTarget(relPath);
    let row = this.getRow(relPath);

    // Stable ids: the same note id tracked at another path.
    const byId = this.getRowByNoteId(note.noteId);
    let movedFrom: string | null = null;
    if (byId && byId.rel_path !== relPath) {
      const moved = this.handleMovedNote(byId, relPath, abs, note, fm, body, newHash);
      if (moved.outcome) return moved.outcome;
      movedFrom = moved.movedFrom;
      row = this.getRow(relPath);
    }

    if (row && row.ownership === 'human' && row.note_id === note.noteId) {
      return { ...base, status: 'unchanged', reason: 'detached: this note is human-owned (vault resolve --detach); seo-agent no longer updates it' };
    }

    if (!existsSync(abs)) {
      const content = `${serializeFrontmatter(fm)}${composeRegion(body)}\n\n${HUMAN_AREA}`;
      if (!this.dryRun) {
        const inserted = this.markPending(relPath, note, row, newHash, keys);
        try {
          atomicWriteFile(abs, content, { noOverwrite: true, ...(this.hooks ? { hooks: this.hooks } : {}) });
        } catch (err) {
          this.abandonPending(relPath, abs, content, inserted);
          throw err;
        }
        this.upsertRow(relPath, note, sha256(content), newHash, keys, nowIso);
      }
      return { ...base, status: 'created' };
    }

    const raw = readFileSync(abs, 'utf8');
    let parsed: ParsedNoteStructure;
    try {
      parsed = parseNoteStructure(raw, relPath);
    } catch (err) {
      return this.conflict({ note, relPath, fm, body, newHash, diskRaw: raw, diskRegion: null, reason: `the existing note cannot be parsed safely (${errorMessage(err)})`, row });
    }
    if (!parsed.location) {
      return this.conflict({ note, relPath, fm, body, newHash, diskRaw: raw, diskRegion: null, reason: 'the generated markers are missing (the note is human-owned or the markers were removed)', row });
    }
    const diskId = parsed.frontmatter.id;
    if (diskId !== note.noteId) {
      return this.conflict({ note, relPath, fm, body, newHash, diskRaw: raw, diskRegion: parsed.location.region, reason: `a different note (id ${JSON.stringify(diskId ?? null)}) already exists at this path`, row });
    }
    if (!row) {
      const diskHashAll = generatedContentHash(pickProps(parsed.frontmatter, keys), parsed.location.region);
      if (diskHashAll === newHash) {
        if (!this.dryRun) this.upsertRow(relPath, note, sha256(raw), newHash, keys, String(parsed.frontmatter.generated_at ?? nowIso));
        return { ...base, status: 'unchanged', reason: 'adopted an untracked note whose generated content already matches' };
      }
      return this.conflict({
        note, relPath, fm, body, newHash, diskRaw: raw, diskRegion: parsed.location.region, row,
        reason: 'the note is not tracked in the database (for example after a database restore), so seo-agent cannot verify that its generated content is unedited',
      });
    }

    const diskNewHash = generatedContentHash(pickProps(parsed.frontmatter, keys), parsed.location.region);
    const baseline = matchRecordedBaseline(row, parsed.frontmatter, parsed.location.region, keys);
    if (!baseline) {
      if (diskNewHash === newHash) {
        // The note already holds exactly this generated content, but the database does not say so
        // (for example a crash between the file write and the database update). Adopt it.
        if (!this.dryRun) this.upsertRow(relPath, note, sha256(raw), newHash, keys, typeof parsed.frontmatter.generated_at === 'string' ? parsed.frontmatter.generated_at : nowIso);
        return { ...base, status: 'unchanged', reason: 'adopted: the note already contains exactly this generated content' };
      }
      const diskGeneratedAt = parsed.frontmatter.generated_at;
      const staleDb = typeof diskGeneratedAt === 'string' && !!row.last_written_at && diskGeneratedAt > row.last_written_at;
      return this.conflict({
        note, relPath, fm, body, newHash, diskRaw: raw, diskRegion: parsed.location.region, row,
        reason: staleDb
          ? 'the note was written by seo-agent after the database last recorded it (for example after restoring an older database backup), so seo-agent cannot verify that its generated content is unedited'
          : 'generated content (inside the markers or a generated property) was edited since seo-agent last wrote it',
      });
    }
    const prevKeys = baseline.keys;
    if (diskNewHash === newHash && sameKeySet(prevKeys, keys)) {
      if (movedFrom) return { ...base, status: 'updated', reason: `moved from ${movedFrom}` };
      if (!this.dryRun) {
        if (baseline.via === 'pending') {
          // A write whose database update never happened: record what is on disk now.
          this.upsertRow(relPath, note, sha256(raw), newHash, keys, typeof parsed.frontmatter.generated_at === 'string' ? parsed.frontmatter.generated_at : nowIso);
        } else if (baseline.via === 'recorded_legacy') {
          // Same content, recorded with the earlier hash format: re-record the hash only.
          this.upsertRow(relPath, note, row.last_written_hash ?? sha256(raw), newHash, keys, row.last_written_at ?? nowIso);
        } else if (row.conflict_path || row.pending_generated_hash) {
          this.db.run(
            'UPDATE vault_notes SET conflict_path = NULL, conflict_detected_at = NULL, pending_generated_hash = NULL, pending_generated_keys_json = NULL WHERE site_id = ? AND rel_path = ?',
            [this.siteId, relPath],
          );
        }
      }
      return { ...base, status: 'unchanged' };
    }

    // Merge: set generated properties in place; human properties, comments, and key order are kept.
    const prevSet = new Set(prevKeys);
    const desired: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fm)) {
      if (MERGEABLE_LIST_KEYS.has(key)) {
        const mergedList = mergeListProperty(value, parsed.frontmatter[key]);
        if (!mergedList) {
          return this.conflict({ note, relPath, fm, body, newHash, diskRaw: raw, diskRegion: parsed.location.region, row, reason: `the "${key}" property is not a list, so seo-agent cannot add its entries without replacing yours` });
        }
        desired[key] = mergedList;
      } else desired[key] = value;
    }
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (prevSet.has(key) || MERGEABLE_LIST_KEYS.has(key) || !(key in fm)) continue;
      if (!sameCanonical(value, fm[key])) {
        return this.conflict({ note, relPath, fm, body, newHash, diskRaw: raw, diskRegion: parsed.location.region, row, reason: `the human property "${key}" would be replaced by a new generated property` });
      }
    }
    const remove = prevKeys.filter((k) => !(k in fm));
    const fmText = this.mergedFrontmatterText(parsed, desired, remove);
    const content = `---\n${fmText}---\n${parsed.location.prefix}${composeRegion(body)}${parsed.location.suffix}`;
    if (!this.dryRun) {
      this.markPending(relPath, note, row, newHash, keys);
      try {
        atomicWriteFile(abs, content, { expectedCurrent: raw, ...(this.hooks ? { hooks: this.hooks } : {}) });
      } catch (err) {
        this.abandonPending(relPath, abs, content, false);
        if (err instanceof ConcurrentModificationError) {
          const latest = readFileSync(abs, 'utf8');
          return this.conflict({ note, relPath, fm, body, newHash, diskRaw: latest, diskRegion: null, row, reason: 'the note changed on disk while seo-agent was updating it' });
        }
        throw err;
      }
      this.upsertRow(relPath, note, sha256(content), newHash, keys, nowIso);
    }
    return { ...base, status: 'updated' };
  }

  /**
   * Frontmatter for an update: edited in place so human comments, key order,
   * and formatting survive. The edit is verified by parsing it again; if it
   * does not round-trip exactly, the block is re-serialized from values
   * (human values still preserved, comments lost) rather than risking data.
   */
  private mergedFrontmatterText(parsed: ParsedNoteStructure, desired: Record<string, unknown>, remove: string[]): string {
    const human = Object.entries(parsed.frontmatter).filter(([k]) => !(k in desired) && !remove.includes(k));
    const expectedKeys = new Set([...Object.keys(desired), ...human.map(([k]) => k)]);
    const verify = (text: string | null): boolean => {
      if (text === null) return false;
      try {
        const back = parseFrontmatterBlock(text, 'merged frontmatter');
        if (Object.keys(back).length !== expectedKeys.size || !Object.keys(back).every((k) => expectedKeys.has(k))) return false;
        return Object.entries(desired).every(([k, v]) => sameCanonical(back[k], v)) && human.every(([k, v]) => sameCanonical(back[k], v));
      } catch {
        return false;
      }
    };
    const edited = editFrontmatterText(parsed.split.frontmatterText, desired, remove);
    if (edited !== null && verify(edited)) return edited;
    this.logger.warn('Vault frontmatter could not be edited in place; re-serialized from values (YAML comments in it were not kept)', {});
    const merged: Record<string, unknown> = { ...desired };
    for (const [k, v] of human) merged[k] = v;
    return serializeFrontmatter(merged).replace(/^---\n/, '').replace(/---\n$/, '');
  }

  /**
   * Record the hash about to be committed (before the file is replaced), so
   * a crash between the file write and the database update is recognized on
   * the next run. Inserts a placeholder row for a new note; returns true then.
   */
  private markPending(relPath: string, note: GeneratedNote, row: VaultNoteRow | undefined, newHash: string, keys: string[]): boolean {
    if (row) {
      this.db.run('UPDATE vault_notes SET pending_generated_hash = ?, pending_generated_keys_json = ? WHERE site_id = ? AND rel_path = ?', [newHash, JSON.stringify(keys), this.siteId, relPath]);
      return false;
    }
    this.db.run(
      `INSERT INTO vault_notes (site_id, rel_path, note_id, kind, ownership, last_written_hash, last_generated_hash, last_written_at, conflict_path, generated_keys_json, conflict_detected_at, pending_generated_hash, pending_generated_keys_json)
       VALUES (?, ?, ?, ?, 'generated', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [this.siteId, relPath, note.noteId, note.kind, newHash, JSON.stringify(keys)],
    );
    return true;
  }

  /** A write failed. Keep the pending hash only if the new content actually landed on disk. */
  private abandonPending(relPath: string, abs: string, content: string, inserted: boolean): void {
    let landed = false;
    try {
      landed = existsSync(abs) && readFileSync(abs, 'utf8') === content;
    } catch {
      landed = false;
    }
    if (landed) return;
    if (inserted) this.db.run('DELETE FROM vault_notes WHERE site_id = ? AND rel_path = ? AND last_generated_hash IS NULL', [this.siteId, relPath]);
    else this.db.run('UPDATE vault_notes SET pending_generated_hash = NULL, pending_generated_keys_json = NULL WHERE site_id = ? AND rel_path = ?', [this.siteId, relPath]);
  }

  private generatedKeysOf(row: VaultNoteRow, fallback: readonly string[]): string[] {
    return parseKeyList(row.generated_keys_json, fallback);
  }

  private prepareTarget(relPath: string): string {
    if (!this.vaultReady) {
      ensureVaultDir(this.vaultRoot, this.vaultDir, !this.dryRun);
      this.vaultReady = !this.dryRun;
    }
    return resolveInVault(this.vaultDir, relPath, { createParents: !this.dryRun });
  }

  private handleMovedNote(
    byId: VaultNoteRow,
    relPath: string,
    abs: string,
    note: GeneratedNote,
    fm: Record<string, unknown>,
    body: string,
    newHash: string,
  ): { outcome?: VaultWriteOutcome; movedFrom: string | null } {
    let oldAbs: string | null = null;
    try {
      oldAbs = resolveInVault(this.vaultDir, byId.rel_path, { createParents: false });
    } catch {
      oldAbs = null;
    }
    if (!oldAbs || !existsSync(oldAbs)) {
      if (!this.dryRun) this.db.run('DELETE FROM vault_notes WHERE site_id = ? AND rel_path = ?', [this.siteId, byId.rel_path]);
      return { movedFrom: null };
    }
    const oldRaw = readFileSync(oldAbs, 'utf8');
    if (!existsSync(abs) && sha256(oldRaw) === byId.last_written_hash) {
      if (!this.dryRun) {
        // Create-only move: link to the new name, then remove the old name.
        try {
          linkSync(oldAbs, abs);
          unlinkSync(oldAbs);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') return { outcome: this.conflict({ note, relPath, fm, body, newHash, diskRaw: null, diskRegion: null, row: undefined, reason: 'the new path appeared while moving the note' }), movedFrom: null };
          if (existsSync(abs)) throw err;
          renameSync(oldAbs, abs);
        }
        this.db.run('UPDATE vault_notes SET rel_path = ? WHERE site_id = ? AND rel_path = ?', [relPath, this.siteId, byId.rel_path]);
        this.appendSystemLog(`Moved note ${byId.rel_path} -> ${relPath} (id ${note.noteId})`);
        return { movedFrom: byId.rel_path };
      }
      return { outcome: { relPath, noteId: note.noteId, kind: note.kind, status: 'updated', reason: `would move from ${byId.rel_path}`, dryRun: true }, movedFrom: null };
    }
    const outcome = this.conflict({
      note,
      relPath: byId.rel_path,
      fm,
      body,
      newHash,
      diskRaw: oldRaw,
      diskRegion: null,
      row: byId,
      reason: `note id ${note.noteId} is tracked at ${byId.rel_path}, which was edited or cannot move to ${relPath}`,
    });
    return { outcome, movedFrom: null };
  }

  private upsertRow(relPath: string, note: GeneratedNote, writtenHash: string, generatedHash: string, keys: string[], at: string): void {
    this.db.run(
      `INSERT INTO vault_notes (site_id, rel_path, note_id, kind, ownership, last_written_hash, last_generated_hash, last_written_at, conflict_path, generated_keys_json, conflict_detected_at, pending_generated_hash, pending_generated_keys_json)
       VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, NULL, ?, NULL, NULL, NULL)
       ON CONFLICT (site_id, rel_path) DO UPDATE SET
         note_id = excluded.note_id, kind = excluded.kind, ownership = 'generated',
         last_written_hash = excluded.last_written_hash, last_generated_hash = excluded.last_generated_hash,
         last_written_at = excluded.last_written_at, conflict_path = NULL,
         generated_keys_json = excluded.generated_keys_json, conflict_detected_at = NULL,
         pending_generated_hash = NULL, pending_generated_keys_json = NULL`,
      [this.siteId, relPath, note.noteId, note.kind, writtenHash, generatedHash, at, JSON.stringify(keys)],
    );
  }

  // ---------------------------------------------------------------- conflicts

  private conflict(args: {
    note: GeneratedNote;
    relPath: string;
    fm: Record<string, unknown>;
    body: string;
    newHash: string;
    diskRaw: string | null;
    diskRegion: string | null;
    row: VaultNoteRow | undefined;
    reason: string;
  }): VaultWriteOutcome {
    const { note, relPath, newHash, reason } = args;
    const base = { relPath, noteId: note.noteId, kind: note.kind, reason, ...(this.dryRun ? { dryRun: true } : {}) };
    const diskHash = args.diskRaw === null ? null : sha256(args.diskRaw);
    const dir = posixDirname(relPath);
    const name = posixBasenameNoExt(relPath);

    const existing = this.findExistingConflict(dir, name, newHash, diskHash);
    if (existing) {
      if (!this.dryRun && args.row && args.row.conflict_path !== existing) {
        this.db.run('UPDATE vault_notes SET conflict_path = ?, conflict_detected_at = ? WHERE site_id = ? AND rel_path = ?', [existing, this.clock.now().toISOString(), this.siteId, args.row.rel_path]);
      }
      return { ...base, status: 'conflict', conflictPath: existing };
    }
    if (this.dryRun) return { ...base, status: 'conflict' };

    const now = this.clock.now();
    const stamp = compactTimestamp(now);
    let conflictRel = `${dir}/${name}.conflict-${stamp}.md`;
    for (let n = 2; this.exists(conflictRel); n++) conflictRel = `${dir}/${name}.conflict-${stamp}-${n}.md`;
    validateVaultRelPath(conflictRel, 'system');
    const artifactFm = {
      id: `${note.noteId}.conflict-${stamp}`,
      type: 'vault_conflict',
      site: this.siteId,
      generated_at: now.toISOString(),
      source_ids: args.fm.source_ids ?? [],
      conflict_for: relPath,
      conflict_note_id: note.noteId,
      reason: singleLine(reason),
      proposed_hash: newHash,
      disk_hash: diskHash,
      tags: ['seo-agent/conflict'],
    };
    const noteLink = this.exists(relPath) ? formatWikilink(relPath, note.title) : `\`${relPath}\``;
    const lines = [
      `# Conflict: ${inline(note.title, 200)}`,
      '',
      `seo-agent did **not** overwrite ${noteLink} because ${neutralizeMarkers(reason)}.`,
      '',
      '## How to resolve',
      '',
      '1. Compare the proposed generated content below with the note.',
      '2. To keep your edits, move them outside the generated markers (text outside the markers is always preserved).',
      `3. Then run \`npm run cli -- vault resolve "${relPath}" --use-generated\` and \`npm run cli -- vault render\`.`,
      `4. Or, to maintain this note by hand from now on, run \`npm run cli -- vault resolve "${relPath}" --detach\`.`,
      '5. Delete this conflict file when you are done. It is never read as input.',
      '',
    ];
    if (args.diskRegion !== null) lines.push('## Generated region currently on disk', '', codeBlock(args.diskRegion.trim(), 'markdown'), '');
    lines.push('## Proposed generated content', '', codeBlock(args.body.trim(), 'markdown'), '');
    const content = `${serializeFrontmatter(artifactFm)}${lines.join('\n')}`;
    const abs = this.prepareTarget(conflictRel);
    atomicWriteFile(abs, content, { noOverwrite: true });
    if (args.row) {
      this.db.run('UPDATE vault_notes SET conflict_path = ?, conflict_detected_at = ? WHERE site_id = ? AND rel_path = ?', [conflictRel, now.toISOString(), this.siteId, args.row.rel_path]);
    }
    this.logger.warn('Vault conflict: generated note not overwritten', { relPath, conflictPath: conflictRel, reason });
    recordAudit(this.db, { siteId: this.siteId, actor: 'system', eventType: 'vault.conflict', subjectType: 'vault_note', subjectId: note.noteId, details: { relPath, conflictPath: conflictRel, reason }, at: now });
    this.appendSystemLog(`Conflict: ${relPath} was not overwritten (${reason}). Proposed version: ${conflictRel}`);
    return { ...base, status: 'conflict', conflictPath: conflictRel };
  }

  private findExistingConflict(dir: string, name: string, proposedHash: string, diskHash: string | null): string | null {
    let absDir: string;
    try {
      absDir = resolveInVault(this.vaultDir, `${dir}/placeholder.md`, { createParents: false });
    } catch {
      return null;
    }
    const folder = path.dirname(absDir);
    if (!existsSync(folder)) return null;
    const prefix = `${name}.conflict-`;
    for (const f of readdirSync(folder).sort().reverse()) {
      if (!f.startsWith(prefix) || !f.endsWith('.md')) continue;
      try {
        const st = lstatSync(path.join(folder, f));
        if (!st.isFile()) continue;
        const parsed = parseNoteStructure(readFileSync(path.join(folder, f), 'utf8'), f);
        if (parsed.frontmatter.proposed_hash === proposedHash && (parsed.frontmatter.disk_hash ?? null) === diskHash) return `${dir}/${f}`;
      } catch {
        /* ignore unreadable artifacts */
      }
    }
    return null;
  }

  /**
   * Resolve a conflict for a tracked note.
   * - use_generated: back up the current file, accept its current generated
   *   region as the baseline, and re-attach it, so the next render replaces
   *   the region (text outside the markers is still preserved).
   * - detach: mark the note human-owned; seo-agent stops updating it.
   */
  resolveConflict(relPath: string, mode: 'use_generated' | 'detach', actor = 'cli'): ResolveResult {
    const rel = validateVaultRelPath(relPath, 'read', { requireMd: true });
    const row = this.getRow(rel);
    if (!row) throw new AppError('NOT_FOUND', `No generated note is tracked at ${rel}`, { hint: 'Run `vault check` to list tracked notes and conflicts.' });
    const now = this.clock.now();
    if (mode === 'detach') {
      if (!this.dryRun) {
        this.db.run("UPDATE vault_notes SET ownership = 'human', conflict_path = NULL, conflict_detected_at = NULL WHERE site_id = ? AND rel_path = ?", [this.siteId, rel]);
        recordAudit(this.db, { siteId: this.siteId, actor, eventType: 'vault.note_detached', subjectType: 'vault_note', subjectId: row.note_id, details: { relPath: rel }, at: now });
        this.appendSystemLog(`Detached ${rel}: seo-agent will no longer update this note (human-owned).`);
      }
      return { relPath: rel, mode, backupPath: null, nextStep: 'The note is now human-owned. seo-agent will not update it again.' };
    }
    const abs = resolveInVault(this.vaultDir, rel, { createParents: false });
    if (!existsSync(abs)) {
      if (!this.dryRun) this.db.run("UPDATE vault_notes SET ownership = 'generated', conflict_path = NULL, conflict_detected_at = NULL WHERE site_id = ? AND rel_path = ?", [this.siteId, rel]);
      return { relPath: rel, mode, backupPath: null, nextStep: 'The note file is missing; `vault render` will recreate it.' };
    }
    const raw = readFileSync(abs, 'utf8');
    const parsed = parseNoteStructure(raw, rel);
    if (!parsed.location) {
      throw new AppError('CONFLICT', `${rel} has no generated markers, so it cannot be re-attached safely.`, {
        hint: 'Restore the two seo-agent generated markers (see the conflict artifact) or use --detach to keep the note as your own.',
      });
    }
    const keys = this.generatedKeysOf(row, DEFAULT_GENERATED_KEYS);
    const diskHash = generatedContentHash(pickProps(parsed.frontmatter, keys), parsed.location.region);
    const stamp = compactTimestamp(now);
    // The folder is part of the name (notes in different folders can share a base name), and a
    // numeric suffix keeps two resolutions in the same second apart. A backup is never skipped.
    const flat = noteFileName(rel.replace(/\.md$/i, '').split('/').join(' - '), 150);
    let backupRel = `${CONFLICT_BACKUP_FOLDER}/${flat}.backup-${stamp}.md`;
    for (let n = 2; this.exists(backupRel); n++) backupRel = `${CONFLICT_BACKUP_FOLDER}/${flat}.backup-${stamp}-${n}.md`;
    if (!this.dryRun) {
      const backupAbs = this.prepareTarget(validateVaultRelPath(backupRel, 'system'));
      const backup = [
        serializeFrontmatter({ id: `${row.note_id}.backup-${stamp}`, type: 'vault_backup', site: this.siteId, generated_at: now.toISOString(), source_ids: [], backup_of: rel, tags: ['seo-agent/backup'] }),
        `# Backup of ${inline(rel, 300)}`,
        '',
        'Copy of the note taken before `vault resolve --use-generated`. It is shown as a code block so it is never parsed as a live note.',
        '',
        codeBlock(raw, 'markdown'),
        '',
      ].join('\n');
      // Create-only: throws (before the database is touched) if the backup cannot be written.
      atomicWriteFile(backupAbs, backup, { noOverwrite: true });
      this.db.run(
        `UPDATE vault_notes SET ownership = 'generated', last_generated_hash = ?, last_written_hash = ?, generated_keys_json = ?, conflict_path = NULL, conflict_detected_at = NULL,
           pending_generated_hash = NULL, pending_generated_keys_json = NULL WHERE site_id = ? AND rel_path = ?`,
        [diskHash, sha256(raw), JSON.stringify(keys), this.siteId, rel],
      );
      recordAudit(this.db, { siteId: this.siteId, actor, eventType: 'vault.conflict_resolved', subjectType: 'vault_note', subjectId: row.note_id, details: { relPath: rel, mode, backup: backupRel }, at: now });
      this.appendSystemLog(`Resolved conflict for ${rel} (use generated). Backup: ${backupRel}`);
    }
    return { relPath: rel, mode, backupPath: this.dryRun ? null : backupRel, nextStep: 'Run `npm run cli -- vault render` to regenerate the note. Text outside the markers is preserved.' };
  }

  // ---------------------------------------------------------------- system log

  /** Append one redacted line to `14 System Logs/YYYY-MM-DD.md` (append-only). */
  appendSystemLog(line: string): void {
    const now = this.clock.now();
    const date = dateInZone(now, this.timeZone);
    const safe = neutralizeMarkers(redactString(String(line)))
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .trim()
      .slice(0, 2_000);
    const entry = `- ${now.toISOString()} ${safe}\n`;
    if (this.dryRun) {
      this.dryRunLog.push(entry.trimEnd());
      return;
    }
    const rel = validateVaultRelPath(`${SYSTEM_LOG_FOLDER}/${date}.md`, 'system');
    const abs = this.prepareTarget(rel);
    if (!existsSync(abs)) {
      const header = [
        serializeFrontmatter({ id: `system-log-${this.siteId}-${date}`, type: 'system_log', site: this.siteId, generated_at: now.toISOString(), source_ids: [], date, time_zone: this.timeZone, tags: ['seo-agent/system_log'] }),
        `# System log ${date}`,
        '',
        `Append-only log written by seo-agent (${this.timeZone}). Secrets are redacted. Past entries are never rewritten.`,
        '',
      ].join('\n');
      try {
        atomicWriteFile(abs, header, { noOverwrite: true });
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'CONFLICT')) throw err;
      }
    }
    appendDurable(abs, entry);
  }
}

/** Build the file-backed writer for the context's site vault. */
export function createVaultWriter(ctx: AppContext, opts: { dryRun?: boolean; atomicHooks?: AtomicWriteHooks } = {}): FileVaultWriter {
  return new FileVaultWriter({
    db: ctx.db,
    siteId: ctx.siteId,
    vaultDir: siteVaultDir(ctx.paths, ctx.siteId),
    vaultRoot: ctx.paths.vaultRoot,
    timeZone: budgetTimeZone(ctx.config),
    clock: ctx.clock,
    logger: ctx.logger,
    dryRun: opts.dryRun ?? ctx.dryRun,
    synthetic: ctx.synthetic,
    ...(opts.atomicHooks ? { atomicHooks: opts.atomicHooks } : {}),
  });
}
