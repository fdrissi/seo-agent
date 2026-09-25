import { existsSync, readFileSync } from 'node:fs';
import { AppError, errorMessage } from '../core/errors.js';
import type { Db } from '../database/db.js';
import { parseNoteStructure } from './frontmatter.js';
import { resolveInVault, validateVaultRelPath } from './fs-safe.js';
import { inline, redactVaultText, vaultPathLeaksSecret } from './markdown.js';
import { formatWikilink, noteFileName, shortHash } from './wikilinks.js';

/**
 * Planning pass for a render: every note that will be generated gets a stable
 * vault path BEFORE any body is rendered, so bodies can link to each other
 * with validated, path-aware wikilinks.
 *
 * Path stability: a note id keeps the path recorded in `vault_notes` (as long
 * as it is still in the expected folder), so title changes never rename files
 * or break human links. New notes use a readable name; on a collision with a
 * different note (planned, tracked, or an existing human file) a short
 * deterministic hash of the note id is appended.
 *
 * Untrusted names and titles (GSC queries, page URLs, scraped titles) are
 * redacted before use (secrets never reach file names, links, or titles). A
 * name that still yields an unsafe path falls back to a note-id-based name
 * and is recorded in `errors`; one bad title never aborts the whole render.
 */

/** A note whose readable name was unsafe and was replaced by a note-id-based name. */
export interface PlanError {
  key: string;
  noteId: string;
  relPath: string;
  error: string;
}

export interface NoteRef {
  key: string;
  noteId: string;
  kind: string;
  relPath: string;
  title: string;
}

export interface PlanningWriter {
  readonly vaultDir: string;
  plan?(relPath: string): void;
  unplan?(relPath: string): void;
}

export class NotePlan {
  private readonly byKey = new Map<string, NoteRef>();
  private readonly byPathLower = new Map<string, string>();
  private readonly noteIds = new Set<string>();
  /** Per-note planning problems (unsafe names replaced by a fallback name). */
  readonly errors: PlanError[] = [];

  constructor(
    private readonly db: Db,
    private readonly siteId: string,
    private readonly writer: PlanningWriter,
  ) {}

  /** Register a note. `key` is the entity key used by renderers, e.g. `page:<id>`. */
  add(key: string, input: { noteId: string; kind: string; folder: string; name: string; title: string }): NoteRef {
    const existing = this.byKey.get(key);
    if (existing) return existing;
    let noteId = input.noteId;
    if (this.noteIds.has(noteId)) noteId = `${noteId}.${input.kind}`;
    const folder = input.folder.replace(/^\/+|\/+$/g, '');
    const title = redactVaultText(input.title);
    let relPath: string | null = null;

    const tracked = this.db.get<{ rel_path: string }>('SELECT rel_path FROM vault_notes WHERE site_id = ? AND note_id = ?', [this.siteId, noteId]);
    // A tracked path written before names were redacted may contain a secret: it is not reused.
    if (tracked && tracked.rel_path.startsWith(`${folder}/`) && !this.byPathLower.has(tracked.rel_path.toLowerCase()) && !vaultPathLeaksSecret(tracked.rel_path)) relPath = tracked.rel_path;

    if (!relPath) {
      const base = noteFileName(input.name);
      const candidates = [`${folder}/${base}.md`, `${folder}/${noteFileName(`${base} (${shortHash(noteId)})`)}.md`, `${folder}/${noteFileName(`${base.slice(0, 60)} ${shortHash(noteId, 12)}`)}.md`];
      relPath = candidates.find((c) => this.isFree(c, noteId)) ?? `${folder}/${noteFileName(noteId)}.md`;
    }
    try {
      validateVaultRelPath(relPath, 'generated');
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'UNSAFE_PATH')) throw err;
      // An untrusted name produced an unsafe path: use a safe note-id-based name for this note only.
      const fallback = this.fallbackPath(folder, noteId);
      this.errors.push({ key, noteId, relPath: fallback, error: `unsafe note name replaced by a note-id-based name (${errorMessage(err)})` });
      relPath = fallback;
    }
    const ref: NoteRef = { key, noteId, kind: input.kind, relPath, title };
    this.byKey.set(key, ref);
    this.byPathLower.set(relPath.toLowerCase(), noteId);
    this.noteIds.add(noteId);
    this.writer.plan?.(relPath);
    return ref;
  }

  /** A safe, free, note-id-based path (validated; throws only if the folder itself is invalid). */
  private fallbackPath(folder: string, noteId: string): string {
    const candidates = [`${folder}/${noteFileName(`note ${noteId}`)}.md`, `${folder}/note ${shortHash(noteId, 12)}.md`];
    for (const c of candidates) {
      try {
        validateVaultRelPath(c, 'generated');
      } catch {
        continue;
      }
      if (this.isFree(c, noteId)) return c;
    }
    return validateVaultRelPath(`${folder}/note ${shortHash(`${noteId}:${this.errors.length}`, 16)}.md`, 'generated');
  }

  private isFree(relPath: string, noteId: string): boolean {
    const lower = relPath.toLowerCase();
    const plannedBy = this.byPathLower.get(lower);
    if (plannedBy && plannedBy !== noteId) return false;
    const trackedBy = this.db.get<{ note_id: string }>('SELECT note_id FROM vault_notes WHERE site_id = ? AND lower(rel_path) = ?', [this.siteId, lower]);
    if (trackedBy && trackedBy.note_id !== noteId) return false;
    try {
      const abs = resolveInVault(this.writer.vaultDir, relPath, { createParents: false });
      if (existsSync(abs)) {
        if (trackedBy?.note_id === noteId) return true;
        try {
          const parsed = parseNoteStructure(readFileSync(abs, 'utf8'), relPath);
          return parsed.frontmatter.id === noteId;
        } catch {
          return false;
        }
      }
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Withdraw a planned note (it failed to build or write and does not exist on
   * disk). Notes built afterwards show plain text instead of a link to it.
   */
  remove(key: string): NoteRef | undefined {
    const ref = this.byKey.get(key);
    if (!ref) return undefined;
    this.byKey.delete(key);
    this.byPathLower.delete(ref.relPath.toLowerCase());
    this.noteIds.delete(ref.noteId);
    this.writer.unplan?.(ref.relPath);
    return ref;
  }

  /** True when a regular note file exists at this vault path (symlinks and unsafe paths count as absent). */
  fileExists(relPath: string): boolean {
    try {
      return existsSync(resolveInVault(this.writer.vaultDir, validateVaultRelPath(relPath, 'read', { requireMd: true }), { createParents: false }));
    } catch {
      return false;
    }
  }

  get(key: string): NoteRef | undefined {
    return this.byKey.get(key);
  }

  all(): NoteRef[] {
    return [...this.byKey.values()];
  }

  /** Wikilink to a planned note, or escaped plain text when the entity has no note. */
  link(key: string, alias?: string): string {
    const ref = this.byKey.get(key);
    if (!ref) return alias === undefined ? '' : inline(alias);
    return formatWikilink(ref.relPath, alias ?? ref.title);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }
}
