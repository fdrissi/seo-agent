import { errorMessage } from '../core/errors.js';
import { callout, code } from './markdown.js';
import type { RenderKind } from './notes.js';
import { all, one, placeholders, type RenderContext } from './render-context.js';
import type { GeneratedNote, ParsedNote, VaultWriter, WriteStatus } from './types.js';
import type { VaultWriteOutcome } from './writer.js';

/**
 * Stale generated notes.
 *
 * SQLite owns the records; a generated entity note presents one of them. When
 * that record no longer exists (for example keywords merged by migration
 * 0203, an owner decision withdrawn from "01 Business/Owner Decisions", a
 * deleted learning), `vault render` would otherwise leave the old note in
 * place, looking current. Instead, the note is marked stale in place:
 *
 * - frontmatter `status: stale` (plus `stale_reason` and the previous
 *   `generated_at` as `last_generated_at`); the note's other generated
 *   properties are removed because they describe a record that is gone;
 * - a STALE banner at the top of the generated region, followed by the last
 *   generated content for reference.
 *
 * The write goes through the VaultWriter, so text outside the generated
 * markers is preserved and an edited generated region produces a conflict
 * artifact instead of being overwritten. Notes are never deleted or moved, and
 * detached (human-owned) notes are never touched. The stale content is
 * deterministic (no timestamps), so re-rendering changes nothing and repeated
 * conflicts are not duplicated.
 */

export const STALE_STATUS = 'stale';
export const STALE_BANNER_TITLE = 'STALE: the record behind this note no longer exists';
export const STALE_CONTENT_HEADING = '## Last generated content (stale, no longer updated)';

export interface StaleNoteOutcome {
  relPath: string;
  noteId: string;
  kind: string;
  title: string;
  /** Write outcome ('unchanged' when the note was already marked stale). */
  status: WriteStatus;
  reason: string;
  conflictPath?: string;
  /**
   * Set for a legacy duplicate (a content note written by an earlier version of
   * the `content` commands): the vault path of the note that presents the same
   * record now, or null when that note is not part of this render.
   */
  supersededBy?: string | null;
}

/** Banner of a legacy duplicate content note (see markSupersededContentNotes). */
export const SUPERSEDED_BANNER_TITLE = 'STALE: duplicate note, no longer updated';

/**
 * Tracked note kinds written by earlier versions of the `content` commands
 * (src/content/notes.ts), with the render key of the note that presents the
 * same record now. The vault renderer is the only writer of content notes.
 */
const LEGACY_CONTENT_KINDS: Record<string, { label: string; key: (rc: RenderContext, noteId: string) => string | null; itemId: (rc: RenderContext, noteId: string) => string | null }> = {
  content_item: { label: 'content opportunity', itemId: (_rc, id) => stripPrefix(id, 'content-item-'), key: (_rc, id) => keyFor('content', stripPrefix(id, 'content-item-')) },
  content_brief: { label: 'content brief', itemId: (rc, id) => itemOfRecord(rc, 'content_briefs', stripPrefix(id, 'content-brief-')), key: (rc, id) => keyFor('brief', itemOfRecord(rc, 'content_briefs', stripPrefix(id, 'content-brief-'))) },
  content_draft: { label: 'content draft', itemId: (rc, id) => itemOfRecord(rc, 'content_drafts', stripPrefix(id, 'content-draft-')), key: (rc, id) => keyFor('draft', itemOfRecord(rc, 'content_drafts', stripPrefix(id, 'content-draft-'))) },
  content_pipeline: { label: 'content pipeline', itemId: () => null, key: () => 'farm' },
};

function stripPrefix(id: string, prefix: string): string | null {
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;
}

function keyFor(kind: string, itemId: string | null): string | null {
  return itemId ? `${kind}:${itemId}` : null;
}

/** The content item of a brief or draft record (fixed table names; bound parameters). */
function itemOfRecord(rc: RenderContext, table: 'content_briefs' | 'content_drafts', id: string | null): string | null {
  if (!id) return null;
  const row = one(rc, `SELECT content_item_id FROM ${table} WHERE site_id = ? AND id = ?`, [rc.ctx.siteId, id]);
  return row ? String(row.content_item_id) : null;
}

interface StaleSource {
  renderKind: RenderKind;
  label: string;
  /** True when the record behind the note still exists for this site. */
  exists: (rc: RenderContext, id: string) => boolean;
}

/** Row existence in a fixed (non-user-supplied) table; the id is a bound parameter. */
const byId =
  (table: string) =>
  (rc: RenderContext, id: string): boolean =>
    !!one(rc, `SELECT 1 AS x FROM ${table} WHERE site_id = ? AND id = ?`, [rc.ctx.siteId, id]);

const byContentItem =
  (table: string) =>
  (rc: RenderContext, itemId: string): boolean =>
    !!one(rc, `SELECT 1 AS x FROM ${table} WHERE site_id = ? AND content_item_id = ? LIMIT 1`, [rc.ctx.siteId, itemId]);

/** Generated entity note kinds and the record each presents (see planEntities in notes.ts). */
const STALE_SOURCES: Record<string, StaleSource> = {
  page: { renderKind: 'pages', label: 'page', exists: byId('pages') },
  keyword: { renderKind: 'keywords', label: 'keyword', exists: byId('keywords') },
  competitor: { renderKind: 'competitors', label: 'competitor', exists: byId('competitors') },
  experiment: { renderKind: 'experiments', label: 'experiment', exists: byId('experiments') },
  source: { renderKind: 'sources', label: 'research source', exists: byId('sources') },
  content_opportunity: { renderKind: 'content', label: 'content opportunity', exists: byId('content_items') },
  brief: { renderKind: 'content', label: 'content brief', exists: byContentItem('content_briefs') },
  draft: { renderKind: 'content', label: 'content draft', exists: byContentItem('content_drafts') },
  decision: { renderKind: 'decisions', label: 'decision', exists: byId('decisions') },
  learning: { renderKind: 'learnings', label: 'learning', exists: byId('learnings') },
};

export const STALE_CHECKED_KINDS = Object.keys(STALE_SOURCES);

/**
 * Record ids a note id may stand for: the id itself, or (for briefs/drafts
 * `<item>.brief` / `<item>.draft`, and for a note id that NotePlan suffixed
 * with `.<kind>` on a collision) the id without that suffix.
 */
function recordIds(noteId: string, kind: string): string[] {
  const out = [noteId];
  let id = noteId;
  const suffixes = kind === 'brief' ? ['.brief'] : kind === 'draft' ? ['.draft'] : [`.${kind}`];
  for (let i = 0; i < 3; i++) {
    const s = suffixes.find((x) => id.endsWith(x));
    if (!s) break;
    id = id.slice(0, -s.length);
    if (id) out.push(id);
  }
  return kind === 'brief' || kind === 'draft' ? out.filter((x) => x !== noteId) : out;
}

function sourceExists(rc: RenderContext, src: StaleSource, noteId: string, kind: string): boolean {
  return recordIds(noteId, kind).some((id) => src.exists(rc, id));
}

function alreadyStale(parsed: ParsedNote): boolean {
  return parsed.frontmatter.status === STALE_STATUS && (parsed.generatedRegion ?? '').includes(STALE_BANNER_TITLE);
}

/** The previous generated content, without an earlier stale banner (never nested). */
function previousContent(parsed: ParsedNote | null): string | null {
  const region = parsed?.generatedRegion ?? null;
  if (region === null) return null;
  if (region.includes(STALE_BANNER_TITLE)) {
    const at = region.indexOf(STALE_CONTENT_HEADING);
    return at >= 0 ? region.slice(at + STALE_CONTENT_HEADING.length).trim() : null;
  }
  return region.trim();
}

export function buildStaleNote(row: { rel_path: string; note_id: string; kind: string }, label: string, parsed: ParsedNote | null): GeneratedNote {
  const fm = parsed?.frontmatter ?? {};
  const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title : row.note_id;
  const ids = recordIds(row.note_id, row.kind);
  const recordId = ids[ids.length - 1] ?? row.note_id;
  const prev = previousContent(parsed);
  const reason = `the ${label} record ${recordId} no longer exists in the database`;
  const sourceIds = Array.isArray(fm.source_ids) ? fm.source_ids.filter((x): x is string => typeof x === 'string') : [];
  const body = [
    callout('warning', STALE_BANNER_TITLE, [
      `The ${label} record this note presented (id ${code(recordId, 120)}) was not found in the database when the vault was last rendered, for example because keywords were merged by a migration or an owner decision was withdrawn.`,
      'seo-agent no longer updates this note. The last generated content is kept below for reference only; do not treat it as current.',
      'Your text outside the generated markers was not changed. seo-agent never deletes notes: delete this one yourself when it is no longer useful.',
    ]),
    '',
    STALE_CONTENT_HEADING,
    '',
    prev && prev.length ? prev : '_The previous generated content could not be read._',
  ].join('\n');
  return {
    relPath: row.rel_path,
    noteId: row.note_id,
    kind: row.kind,
    title,
    frontmatter: {
      source_ids: sourceIds,
      status: STALE_STATUS,
      stale_reason: reason,
      ...(typeof fm.generated_at === 'string' ? { last_generated_at: fm.generated_at } : {}),
      ...(fm.synthetic === true ? { synthetic: true } : {}),
      tags: [`seo-agent/${row.kind}`, 'seo-agent/stale'],
    },
    body,
  };
}

/**
 * Find tracked generated entity notes (of the selected render kinds) that
 * were not planned in this render because their record no longer exists, and
 * mark them stale through the writer. Returns one outcome per stale note;
 * write errors are returned separately and never abort the render.
 */
export function markStaleNotes(
  rc: RenderContext,
  writer: VaultWriter,
  selected: ReadonlySet<RenderKind>,
): { stale: StaleNoteOutcome[]; outcomes: VaultWriteOutcome[]; errors: Array<{ key: string; relPath?: string; error: string }> } {
  const kinds = STALE_CHECKED_KINDS.filter((k) => selected.has(STALE_SOURCES[k]!.renderKind));
  const stale: StaleNoteOutcome[] = [];
  const outcomes: VaultWriteOutcome[] = [];
  const errors: Array<{ key: string; relPath?: string; error: string }> = [];
  if (!kinds.length) return { stale, outcomes, errors };
  const planned = new Set(rc.plan.all().map((r) => r.noteId));
  const rows = all(
    rc,
    `SELECT rel_path, note_id, kind FROM vault_notes WHERE site_id = ? AND ownership <> 'human' AND kind IN (${placeholders(kinds)}) ORDER BY rel_path`,
    [rc.ctx.siteId, ...kinds],
  ).map((r) => ({ rel_path: String(r.rel_path), note_id: String(r.note_id), kind: String(r.kind) }));
  for (const row of rows) {
    const src = STALE_SOURCES[row.kind]!;
    if (planned.has(row.note_id)) continue;
    if (sourceExists(rc, src, row.note_id, row.kind)) continue; // still exists (for example beyond a render limit)
    if (!rc.plan.fileExists(row.rel_path)) continue; // the file is gone: nothing misleading is left on disk
    const key = `stale:${row.note_id}`;
    let parsed: ParsedNote | null = null;
    try {
      parsed = writer.readNote(row.rel_path);
    } catch {
      parsed = null; // unparseable: the writer reports a conflict instead of overwriting it
    }
    const reason = `the ${src.label} record no longer exists in the database`;
    if (parsed && alreadyStale(parsed)) {
      const title = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : row.note_id;
      stale.push({ relPath: row.rel_path, noteId: row.note_id, kind: row.kind, title, status: 'unchanged', reason });
      continue;
    }
    const note = buildStaleNote(row, src.label, parsed);
    try {
      const o = writer.writeGenerated(note) as VaultWriteOutcome;
      const outcome: VaultWriteOutcome = { ...o, noteId: o.noteId ?? note.noteId, kind: o.kind ?? note.kind };
      outcomes.push(outcome);
      stale.push({ relPath: row.rel_path, noteId: row.note_id, kind: row.kind, title: note.title, status: outcome.status, reason, ...(outcome.conflictPath ? { conflictPath: outcome.conflictPath } : {}) });
    } catch (err) {
      errors.push({ key, relPath: row.rel_path, error: `marking a stale note failed: ${errorMessage(err)}` });
    }
  }
  return { stale, outcomes, errors };
}

/**
 * A legacy duplicate content note, marked stale in place: `status: stale`, the
 * reason, `superseded_by` (the current note's path), and a banner that links
 * to the current note. Its old generated content (stage, status, approval
 * text) is NOT kept: the current note presents the same record and stays up
 * to date. Text outside the generated markers is preserved (VaultWriter).
 */
export function buildSupersededNote(
  row: { rel_path: string; note_id: string; kind: string },
  label: string,
  parsed: ParsedNote | null,
  current: { relPath: string; link: string } | null,
  itemId: string | null,
): GeneratedNote {
  const fm = parsed?.frontmatter ?? {};
  const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title : row.note_id;
  const sourceIds = Array.isArray(fm.source_ids) ? fm.source_ids.filter((x): x is string => typeof x === 'string') : [];
  // When the legacy content was last generated: kept once the note is marked (re-rendering changes nothing).
  const lastGeneratedAt = fm.status === STALE_STATUS && typeof fm.last_generated_at === 'string' ? fm.last_generated_at : typeof fm.generated_at === 'string' ? fm.generated_at : null;
  const reason = current
    ? `duplicate: written by an earlier version of the content commands; the current note for this ${label} is ${current.relPath}`
    : `duplicate: written by an earlier version of the content commands; no note of the vault renderer presents this ${label} in this render`;
  const body = [
    callout('warning', SUPERSEDED_BANNER_TITLE, [
      `An earlier version of the \`content\` commands wrote this ${label} note next to the note that \`vault render\` maintains for the same record. Nothing updates it any more, so its previous content (stage, status, approval requests) was removed here; it could read as current.`,
      current ? `The current note is ${current.link}.` : 'No current note presents this record in this render (the record may no longer exist, or it is beyond a render limit); `npm run cli -- vault render --only content` renders every content note that still has a record.',
      'Your text outside the generated markers was not changed. Copy anything you still need into the current note (outside its markers), then delete this note yourself: seo-agent never deletes notes.',
    ]),
  ].join('\n');
  return {
    relPath: row.rel_path,
    noteId: row.note_id,
    kind: row.kind,
    title,
    frontmatter: {
      source_ids: sourceIds,
      status: STALE_STATUS,
      stale_reason: reason,
      superseded_by: current?.relPath ?? null,
      ...(itemId ? { content_item_id: itemId } : {}),
      ...(lastGeneratedAt ? { last_generated_at: lastGeneratedAt } : {}),
      ...(fm.synthetic === true ? { synthetic: true } : {}),
      tags: [`seo-agent/${row.kind}`, 'seo-agent/stale'],
    },
    body,
  };
}

/**
 * Mark tracked legacy content notes (kinds content_item, content_brief,
 * content_draft, content_pipeline; see LEGACY_CONTENT_KINDS) stale in place,
 * linking to the note the vault renderer maintains for the same record. Runs
 * when content notes are rendered. Detached (human-owned) notes and missing
 * files are left alone; an edited generated region gets a conflict artifact.
 */
export function markSupersededContentNotes(
  rc: RenderContext,
  writer: VaultWriter,
  selected: ReadonlySet<RenderKind>,
): { stale: StaleNoteOutcome[]; outcomes: VaultWriteOutcome[]; errors: Array<{ key: string; relPath?: string; error: string }> } {
  const stale: StaleNoteOutcome[] = [];
  const outcomes: VaultWriteOutcome[] = [];
  const errors: Array<{ key: string; relPath?: string; error: string }> = [];
  if (!selected.has('content')) return { stale, outcomes, errors };
  const kinds = Object.keys(LEGACY_CONTENT_KINDS);
  const rows = all(
    rc,
    `SELECT rel_path, note_id, kind FROM vault_notes WHERE site_id = ? AND ownership <> 'human' AND kind IN (${placeholders(kinds)}) ORDER BY rel_path`,
    [rc.ctx.siteId, ...kinds],
  ).map((r) => ({ rel_path: String(r.rel_path), note_id: String(r.note_id), kind: String(r.kind) }));
  for (const row of rows) {
    if (!rc.plan.fileExists(row.rel_path)) continue;
    const legacy = LEGACY_CONTENT_KINDS[row.kind]!;
    const key = legacy.key(rc, row.note_id);
    const ref = key ? rc.plan.get(key) : undefined;
    const current = ref && ref.relPath !== row.rel_path ? { relPath: ref.relPath, link: rc.plan.link(ref.key) } : null;
    let parsed: ParsedNote | null = null;
    try {
      parsed = writer.readNote(row.rel_path);
    } catch {
      parsed = null; // unparseable: the writer reports a conflict instead of overwriting it
    }
    const note = buildSupersededNote(row, legacy.label, parsed, current, legacy.itemId(rc, row.note_id) ?? itemIdFrom(parsed));
    try {
      const o = writer.writeGenerated(note) as VaultWriteOutcome;
      const outcome: VaultWriteOutcome = { ...o, noteId: o.noteId ?? note.noteId, kind: o.kind ?? note.kind };
      outcomes.push(outcome);
      stale.push({ relPath: row.rel_path, noteId: row.note_id, kind: row.kind, title: note.title, status: outcome.status, reason: String(note.frontmatter.stale_reason), supersededBy: current?.relPath ?? null, ...(outcome.conflictPath ? { conflictPath: outcome.conflictPath } : {}) });
    } catch (err) {
      errors.push({ key: `superseded:${row.note_id}`, relPath: row.rel_path, error: `marking a legacy duplicate note stale failed: ${errorMessage(err)}` });
    }
  }
  return { stale, outcomes, errors };
}

function itemIdFrom(parsed: ParsedNote | null): string | null {
  const v = parsed?.frontmatter.content_item_id;
  return typeof v === 'string' && v ? v : null;
}
