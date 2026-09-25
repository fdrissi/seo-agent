import type { FactCheckNote, FactResolutionSourceKind, HumanFactResolution } from './types.js';

/**
 * Presentation of fact-check notes, shared by the content pipeline's draft
 * note (src/content/notes.ts) and the vault renderer (`vault render`,
 * src/obsidian/notes-content.ts), so both show a stored note the same way.
 * Dependency-free on purpose (types only): the vault renderer imports it
 * without loading the content pipeline.
 */

/**
 * One fact-check note line. A "verified" status is never shown bare: the
 * writer model's claim reads "model-claimed verified (evidence: <ids>)", a
 * human confirmation names the reviewer and the source, and a claim code
 * downgraded says why.
 */
export function factCheckNoteLine(f: FactCheckNote): string {
  const tail = `${f.statement}${f.note ? ` (${f.note})` : ''}`;
  if (f.humanResolution) {
    const h = f.humanResolution;
    return `- **confirmed by ${h.reviewer}** (human, ${h.at.slice(0, 10)}; source: ${h.source}${h.sourceKind === 'human_supplied' ? '' : ` [${h.sourceKind}]`}): ${tail}`;
  }
  if (f.status === 'verified') return `- model-claimed verified (evidence: ${f.evidenceIds.join(', ') || 'none'}): ${tail}`;
  if (f.downgraded) return `- **${f.status}** (the model claimed verified; ${f.downgraded.reason}): ${tail}`;
  return `- **${f.status}**: ${tail}`;
}

const STATUSES: ReadonlySet<string> = new Set(['verified', 'unverified', 'needs_owner_input']);
const SOURCE_KINDS: ReadonlySet<string> = new Set(['product_fact', 'owner_statement', 'brief_evidence', 'human_supplied']);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * A stored fact-check note (untyped JSON from a draft package) as a
 * FactCheckNote, or null when it is not one (no statement, or a status that is
 * not verified/unverified/needs_owner_input). A human confirmation counts only
 * with a reviewer, a date, and a source; otherwise it is dropped, so the note
 * reads as the model's claim, never as a human's.
 */
export function coerceFactCheckNote(x: unknown): FactCheckNote | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const statement = str(o.statement);
  const status = str(o.status);
  if (statement === null || !statement.trim() || status === null || !STATUSES.has(status)) return null;
  const note: FactCheckNote = {
    statement,
    status: status as FactCheckNote['status'],
    evidenceIds: Array.isArray(o.evidenceIds) ? o.evidenceIds.filter((e): e is string => typeof e === 'string') : [],
    note: str(o.note) ?? '',
  };
  const d = o.downgraded as Record<string, unknown> | null | undefined;
  if (d && typeof d === 'object' && str(d.reason)) note.downgraded = { from: 'verified', reason: str(d.reason)! };
  const h = o.humanResolution as Record<string, unknown> | null | undefined;
  if (h && typeof h === 'object' && str(h.reviewer)?.trim() && str(h.at)?.trim() && str(h.source)?.trim()) {
    const kind = str(h.sourceKind);
    const resolution: HumanFactResolution = {
      marker: str(h.marker) ?? statement,
      action: h.action === 'removed' ? 'removed' : 'confirmed',
      statement: str(h.statement) ?? statement,
      source: str(h.source)!,
      sourceKind: (kind && SOURCE_KINDS.has(kind) ? kind : 'human_supplied') as FactResolutionSourceKind,
      note: str(h.note),
      reviewer: str(h.reviewer)!,
      at: str(h.at)!,
    };
    note.humanResolution = resolution;
  }
  return note;
}
