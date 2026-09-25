import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import { sha256, normalizedContentHash } from '../core/hash.js';
import type { TrustClass } from '../core/modes.js';
import { siteVaultDir } from '../config/paths.js';
import { safeResolve } from '../security/paths.js';
import { parseJson } from '../database/db.js';
import { ingestDocument, propagateMissing, type DocumentInput, type IngestOutcome, type MemoryCtx } from './documents.js';
import { firstHeading, fmString, parseMarkdown, stripComments, stripGeneratedRegions } from './markdown.js';
import type { MemorySourceType } from './types.js';

/**
 * Collectors turn authoritative records into memory documents:
 *
 * | source type          | origin                                              | trust class                                   |
 * |----------------------|-----------------------------------------------------|-----------------------------------------------|
 * | business_note        | vault `01 Business/**.md` (human text only)         | owner_approved only when the exact content was imported by the validated business-note sync (business_note_versions.status='imported'); otherwise user_reported. Frontmatter can never grant trust. |
 * | source_excerpt       | evidence (kind='excerpt') + sources (non-metric)    | the source's trust_class                       |
 * | competitor_finding   | competitor_changes (+ competitor notes)             | scraped_untrusted (notes: user_reported)       |
 * | brief                | content_briefs (latest version per content item)    | model_generated (synthetic when flagged)       |
 * | experiment_summary   | experiments                                         | first_party_measurement for concluded outcomes, else model_generated |
 * | rejected_proposal    | recommendations/content_items with status rejected  | model_generated, status 'rejected'             |
 * | approved_learning    | learnings (approved; superseded kept as superseded) | owner_approved                                  |
 * | decision             | decisions                                           | owner_approved when decided by an owner, else model_generated |
 *
 * Never collected: metric tables (GSC/GA4/PageSpeed rows), secrets, raw API
 * responses, VaultWriter conflict artifacts (`<name>.conflict-<ts>.md`; the
 * human note is the source of truth). Sources of metric types (gsc, ga4,
 * pagespeed, url_inspection, dataforseo) are excluded from excerpts.
 *
 * In a synthetic (demo) workspace every document is stored with trust class
 * 'synthetic' (enforced in ingestDocument), whatever the table above says.
 */

export const BUSINESS_FOLDER = '01 Business';
const MAX_NOTE_BYTES = 1_000_000;
const MAX_NOTES = 5_000;
/** VaultWriter conflict artifacts (same pattern the business-note sync skips). */
const CONFLICT_ARTIFACT_RE = /\.conflict-\d{8}T\d{6}Z/;
const METRIC_SOURCE_TYPES = ['gsc', 'ga4', 'pagespeed', 'url_inspection', 'dataforseo'];

export interface CollectOptions {
  /** Override the default business-note trust decision (integration hook). Must never trust frontmatter. */
  businessNoteTrust?: (relPath: string, raw: string) => TrustClass;
  /** Default language when a note/record does not state one. Defaults to the first configured market language, else 'und'. */
  defaultLanguage?: string;
  /** Maximum business notes scanned per run (default 5,000). Above it the set is reported incomplete and nothing is deleted. */
  maxBusinessNotes?: number;
}

export interface CollectedSet {
  sourceType: MemorySourceType;
  documents: DocumentInput[];
  /** False when the source could not be read (e.g. vault missing): deletion propagation is skipped for it. */
  complete: boolean;
  /** Ref namespaces owned by this collector: only documents under them are deleted when their source disappears. */
  ownedPrefixes: string[];
  notes?: string[];
}

function defaultLanguage(ctx: MemoryCtx, opts: CollectOptions): string {
  return opts.defaultLanguage ?? ctx.config.market.languages[0] ?? 'und';
}

function dateOnly(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const m = /^\d{4}-\d{2}-\d{2}/.exec(v);
  return m ? m[0] : null;
}

function renderValue(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => `${'  '.repeat(depth)}- ${renderValue(x, depth + 1).replace(/\n/g, ' ')}`).join('\n');
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined && x !== '')
      .map(([k, x]) => (typeof x === 'object' ? `${'  '.repeat(depth)}- ${k}:\n${renderValue(x, depth + 1)}` : `${'  '.repeat(depth)}- ${k}: ${renderValue(x, depth + 1)}`))
      .join('\n');
  }
  return String(v);
}

/** Render a JSON object (e.g. a brief) as readable Markdown sections. */
export function renderJsonAsMarkdown(obj: unknown): string {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return renderValue(obj);
  return Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `## ${k.replace(/[_-]+/g, ' ')}\n\n${renderValue(v)}`)
    .join('\n\n');
}

interface NoteScan {
  max: number;
  files: string[];
  /** True when the scan stopped at the cap: the file set is incomplete. */
  truncated: boolean;
  conflictArtifacts: number;
  oversized: number;
}

function listMarkdownFiles(root: string, base: string, acc: NoteScan): void {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (acc.truncated) return;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(root, entry.name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue; // never follow symlinks out of the vault
    if (st.isDirectory()) {
      listMarkdownFiles(abs, base, acc);
      continue;
    }
    if (!st.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    if (CONFLICT_ARTIFACT_RE.test(entry.name)) {
      acc.conflictArtifacts++;
      continue;
    }
    if (st.size > MAX_NOTE_BYTES) {
      acc.oversized++;
      continue;
    }
    if (acc.files.length >= acc.max) {
      acc.truncated = true;
      return;
    }
    acc.files.push(path.relative(base, abs).split(path.sep).join('/'));
  }
}

/** Trust for a business note: owner_approved only for content imported by the validated business-note sync. */
export function defaultBusinessNoteTrust(ctx: MemoryCtx, relPath: string, raw: string): TrustClass {
  const hashes = [sha256(raw), normalizedContentHash(raw)];
  const row = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM business_note_versions WHERE site_id = ? AND note_path = ? AND status = 'imported' AND content_hash IN (?, ?)`,
    [ctx.siteId, relPath, hashes[0], hashes[1]],
  );
  return (row?.n ?? 0) > 0 ? 'owner_approved' : 'user_reported';
}

export function collectBusinessNotes(ctx: MemoryCtx & Pick<AppContext, 'paths'>, opts: CollectOptions = {}): CollectedSet {
  const vaultDir = siteVaultDir(ctx.paths, ctx.siteId);
  const folder = path.join(vaultDir, BUSINESS_FOLDER);
  if (!existsSync(folder)) return { sourceType: 'business_note', documents: [], complete: false, ownedPrefixes: [`${BUSINESS_FOLDER}/`], notes: [`Vault folder not found: ${BUSINESS_FOLDER} (run setup/vault init)`] };
  const scan: NoteScan = { max: Math.max(1, opts.maxBusinessNotes ?? MAX_NOTES), files: [], truncated: false, conflictArtifacts: 0, oversized: 0 };
  listMarkdownFiles(folder, vaultDir, scan);
  const notes: string[] = [];
  if (scan.truncated) {
    notes.push(
      `${BUSINESS_FOLDER} has more than ${scan.max} notes: only the first ${scan.max} (by path) were ingested, and deletion propagation was skipped for business notes so nothing is removed because of the cap.`,
    );
  }
  if (scan.conflictArtifacts) notes.push(`${scan.conflictArtifacts} vault conflict artifact(s) (*.conflict-<timestamp>.md) were not ingested (the human note is the source of truth); resolve them in Obsidian.`);
  if (scan.oversized) notes.push(`${scan.oversized} note(s) larger than ${MAX_NOTE_BYTES} bytes were not ingested; an earlier ingested version of such a note is marked deleted so stale text is not retrieved (split the note into smaller notes).`);
  const docs: DocumentInput[] = [];
  for (const rel of scan.files.sort()) {
    const abs = safeResolve(vaultDir, rel);
    const raw = readFileSync(abs, 'utf8');
    const parsed = parseMarkdown(raw);
    const text = stripComments(stripGeneratedRegions(parsed.body).text);
    if (!text.trim()) continue;
    const fm = parsed.frontmatter;
    const title = fmString(fm, 'title') ?? firstHeading(text) ?? path.basename(rel, '.md');
    const trust = opts.businessNoteTrust ? opts.businessNoteTrust(rel, raw) : defaultBusinessNoteTrust(ctx, rel, raw);
    const mtime = lstatSync(abs).mtime.toISOString().slice(0, 10);
    docs.push({
      sourceType: 'business_note',
      sourceRef: rel,
      title,
      text,
      language: fmString(fm, 'lang', 'language') ?? defaultLanguage(ctx, opts),
      trustClass: trust === 'owner_approved' || trust === 'user_reported' || trust === 'model_generated' || trust === 'synthetic' ? trust : 'user_reported',
      sourceDate: dateOnly(fmString(fm, 'updated', 'modified', 'date')) ?? mtime,
      accessScope: fmString(fm, 'memory_access') === 'owner_only' ? 'owner_only' : 'site',
    });
  }
  return { sourceType: 'business_note', documents: docs, complete: !scan.truncated, ownedPrefixes: [`${BUSINESS_FOLDER}/`], ...(notes.length ? { notes } : {}) };
}

export function collectSourceExcerpts(ctx: MemoryCtx, opts: CollectOptions = {}): CollectedSet {
  const rows = ctx.db.all<{ id: string; summary: string; excerpt: string; collected_at: string; source_type: string; trust_class: TrustClass; url: string | null; title: string | null; retrieved_at: string; published_at: string | null }>(
    `SELECT e.id, e.summary, e.excerpt, e.collected_at, s.source_type, s.trust_class, s.url, s.title, s.retrieved_at, s.published_at
     FROM evidence e JOIN sources s ON s.id = e.source_id AND s.site_id = e.site_id
     WHERE e.site_id = ? AND e.kind = 'excerpt' AND e.excerpt IS NOT NULL AND e.excerpt != ''
       AND s.source_type NOT IN (${METRIC_SOURCE_TYPES.map(() => '?').join(',')})
     ORDER BY e.id`,
    [ctx.siteId, ...METRIC_SOURCE_TYPES],
  );
  return {
    sourceType: 'source_excerpt',
    complete: true,
    ownedPrefixes: ['evidence:'],
    documents: rows.map((r) => ({
      sourceType: 'source_excerpt' as const,
      sourceRef: `evidence:${r.id}`,
      title: (r.title || r.summary || r.url || r.id).slice(0, 200),
      text: r.summary && r.summary !== r.excerpt ? `${r.excerpt}\n\nContext: ${r.summary}` : r.excerpt,
      sourceUrl: r.url,
      language: defaultLanguage(ctx, opts),
      trustClass: r.source_type === 'fixture' ? 'synthetic' : r.trust_class,
      sourceDate: dateOnly(r.published_at) ?? dateOnly(r.retrieved_at),
    })),
  };
}

export function collectCompetitorFindings(ctx: MemoryCtx, opts: CollectOptions = {}): CollectedSet {
  const changes = ctx.db.all<{ id: string; change_type: string; summary: string; detected_at: string; url: string; domain: string; name: string | null }>(
    `SELECT cc.id, cc.change_type, cc.summary, cc.detected_at, cp.url, c.domain, c.name
     FROM competitor_changes cc
     JOIN competitor_pages cp ON cp.id = cc.competitor_page_id AND cp.site_id = cc.site_id
     JOIN competitors c ON c.id = cp.competitor_id AND c.site_id = cc.site_id
     WHERE cc.site_id = ? AND cc.summary IS NOT NULL AND cc.summary != ''
     ORDER BY cc.detected_at, cc.id`,
    [ctx.siteId],
  );
  const notes = ctx.db.all<{ id: string; domain: string; name: string | null; notes: string; first_seen_at: string }>(
    `SELECT id, domain, name, notes, first_seen_at FROM competitors WHERE site_id = ? AND notes IS NOT NULL AND notes != '' ORDER BY id`,
    [ctx.siteId],
  );
  const lang = defaultLanguage(ctx, opts);
  return {
    sourceType: 'competitor_finding',
    complete: true,
    ownedPrefixes: ['competitor_change:', 'competitor:'],
    documents: [
      ...changes.map((r) => ({
        sourceType: 'competitor_finding' as const,
        sourceRef: `competitor_change:${r.id}`,
        title: `${r.name ?? r.domain}: ${r.change_type.replace(/_/g, ' ')}`,
        text: `Competitor ${r.name ?? r.domain} (${r.domain}): ${r.change_type.replace(/_/g, ' ')} detected ${r.detected_at.slice(0, 10)} on ${r.url}.\n\n${r.summary}`,
        sourceUrl: r.url,
        language: lang,
        trustClass: 'scraped_untrusted' as TrustClass,
        sourceDate: dateOnly(r.detected_at),
      })),
      ...notes.map((r) => ({
        sourceType: 'competitor_finding' as const,
        sourceRef: `competitor:${r.id}`,
        title: `Competitor notes: ${r.name ?? r.domain}`,
        text: r.notes,
        language: lang,
        trustClass: 'user_reported' as TrustClass,
        sourceDate: dateOnly(r.first_seen_at),
      })),
    ],
  };
}

export function collectBriefs(ctx: MemoryCtx, opts: CollectOptions = {}): CollectedSet {
  const rows = ctx.db.all<{ id: string; content_item_id: string; version: number; status: string; brief_json: string; vault_path: string | null; created_at: string; item_title: string; is_synthetic: number }>(
    `SELECT b.id, b.content_item_id, b.version, b.status, b.brief_json, b.vault_path, b.created_at, ci.title AS item_title, ci.is_synthetic
     FROM content_briefs b JOIN content_items ci ON ci.id = b.content_item_id AND ci.site_id = b.site_id
     WHERE b.site_id = ? AND b.version = (SELECT MAX(b2.version) FROM content_briefs b2 WHERE b2.content_item_id = b.content_item_id AND b2.site_id = b.site_id)
     ORDER BY b.content_item_id`,
    [ctx.siteId],
  );
  return {
    sourceType: 'brief',
    complete: true,
    ownedPrefixes: ['content_brief:'],
    documents: rows.map((r) => {
      const brief = parseJson<Record<string, unknown>>(r.brief_json, {});
      const lang = typeof brief.language === 'string' ? brief.language : defaultLanguage(ctx, opts);
      return {
        sourceType: 'brief' as const,
        sourceRef: `content_brief:${r.content_item_id}`,
        title: `Brief: ${r.item_title} (v${r.version})`,
        text: `# Brief: ${r.item_title}\n\n${renderJsonAsMarkdown(brief)}`,
        language: lang,
        trustClass: (r.is_synthetic ? 'synthetic' : 'model_generated') as TrustClass,
        status: r.status === 'superseded' ? ('superseded' as const) : ('active' as const),
        recordStatus: r.status,
        sourceDate: dateOnly(r.created_at),
        ...(r.vault_path ? { linkAliases: [r.vault_path] } : {}),
      };
    }),
  };
}

const CONCLUDED = new Set(['positive', 'negative', 'inconclusive']);

export function collectExperimentSummaries(ctx: MemoryCtx, opts: CollectOptions = {}): CollectedSet {
  const rows = ctx.db.all<{
    id: string;
    type: string;
    hypothesis: string;
    proposed_change: string;
    primary_metric: string;
    status: string;
    risks: string;
    outcome_json: string | null;
    observation_start: string | null;
    observation_end: string | null;
    implemented_at: string | null;
    updated_at: string;
  }>(
    `SELECT id, type, hypothesis, proposed_change, primary_metric, status, risks, outcome_json, observation_start, observation_end, implemented_at, updated_at
     FROM experiments WHERE site_id = ? ORDER BY id`,
    [ctx.siteId],
  );
  return {
    sourceType: 'experiment_summary',
    complete: true,
    ownedPrefixes: ['experiment:'],
    documents: rows.map((r) => {
      const outcome = parseJson<unknown>(r.outcome_json, null);
      const parts = [
        `# Experiment (${r.type}) — status: ${r.status.toUpperCase()}`,
        `Hypothesis: ${r.hypothesis}`,
        `Proposed change: ${r.proposed_change}`,
        `Primary metric: ${r.primary_metric}`,
        r.implemented_at ? `Implemented: ${r.implemented_at.slice(0, 10)}` : 'Implemented: not recorded',
        r.observation_start || r.observation_end ? `Observation window: ${r.observation_start ?? '?'} to ${r.observation_end ?? '?'}` : '',
        outcome ? `## Outcome\n\n${renderValue(outcome).slice(0, 4_000)}` : 'Outcome: not evaluated yet',
        `Risks: ${r.risks}`,
      ].filter(Boolean);
      return {
        sourceType: 'experiment_summary' as const,
        sourceRef: `experiment:${r.id}`,
        title: `Experiment ${r.type}: ${r.hypothesis.slice(0, 120)}`,
        text: parts.join('\n\n'),
        language: defaultLanguage(ctx, opts),
        trustClass: (CONCLUDED.has(r.status) ? 'first_party_measurement' : 'model_generated') as TrustClass,
        recordStatus: r.status,
        sourceDate: dateOnly(r.observation_end) ?? dateOnly(r.updated_at),
      };
    }),
  };
}

export function collectRejectedProposals(ctx: MemoryCtx, opts: CollectOptions = {}): CollectedSet {
  const recs = ctx.db.all<{ id: string; title: string; action_type: string; query: string | null; diagnosis: string | null; proposed_change: string | null; hypothesis: string | null; risks: string | null; updated_at: string }>(
    `SELECT id, title, action_type, query, diagnosis, proposed_change, hypothesis, risks, updated_at FROM recommendations WHERE site_id = ? AND status = 'rejected' ORDER BY id`,
    [ctx.siteId],
  );
  const items = ctx.db.all<{ id: string; title: string; primary_question: string | null; decision_reason: string | null; is_synthetic: number; updated_at: string }>(
    `SELECT id, title, primary_question, decision_reason, is_synthetic, updated_at FROM content_items WHERE site_id = ? AND stage = 'rejected' ORDER BY id`,
    [ctx.siteId],
  );
  const reasonFor = (subjectType: string, id: string): string | null => {
    const d = ctx.db.get<{ decision: string; reason: string | null; decided_by: string; decided_at: string }>(
      `SELECT decision, reason, decided_by, decided_at FROM decisions WHERE site_id = ? AND subject_type = ? AND subject_id = ? ORDER BY decided_at DESC LIMIT 1`,
      [ctx.siteId, subjectType, id],
    );
    return d ? `${d.decision}${d.reason ? `: ${d.reason}` : ''} (by ${d.decided_by}, ${d.decided_at.slice(0, 10)})` : null;
  };
  const lang = defaultLanguage(ctx, opts);
  return {
    sourceType: 'rejected_proposal',
    complete: true,
    ownedPrefixes: ['recommendation:', 'content_item:'],
    documents: [
      ...recs.map((r) => {
        const why = reasonFor('recommendation', r.id);
        return {
          sourceType: 'rejected_proposal' as const,
          sourceRef: `recommendation:${r.id}`,
          title: `REJECTED: ${r.title}`,
          text: [
            `# REJECTED proposal: ${r.title}`,
            'Status: REJECTED. This proposal was rejected and is kept as context. It is not a recommendation.',
            why ? `Decision: ${why}` : '',
            `Action type: ${r.action_type}`,
            r.query ? `Query: ${r.query}` : '',
            r.diagnosis ? `Diagnosis: ${r.diagnosis}` : '',
            r.proposed_change ? `Proposed change: ${r.proposed_change}` : '',
            r.hypothesis ? `Hypothesis: ${r.hypothesis}` : '',
            r.risks ? `Risks: ${r.risks}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          language: lang,
          trustClass: 'model_generated' as TrustClass,
          status: 'rejected' as const,
          recordStatus: 'rejected',
          sourceDate: dateOnly(r.updated_at),
        };
      }),
      ...items.map((r) => ({
        sourceType: 'rejected_proposal' as const,
        sourceRef: `content_item:${r.id}`,
        title: `REJECTED content idea: ${r.title}`,
        text: [
          `# REJECTED content idea: ${r.title}`,
          'Status: REJECTED. Kept as context; not a recommendation.',
          r.primary_question ? `Question: ${r.primary_question}` : '',
          r.decision_reason ? `Reason: ${r.decision_reason}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        language: lang,
        trustClass: (r.is_synthetic ? 'synthetic' : 'model_generated') as TrustClass,
        status: 'rejected' as const,
        recordStatus: 'rejected',
        sourceDate: dateOnly(r.updated_at),
      })),
    ],
  };
}

export function collectLearnings(ctx: MemoryCtx, opts: CollectOptions = {}): CollectedSet {
  const rows = ctx.db.all<{ id: string; statement: string; scope: string; status: string; approved_by: string | null; approved_at: string | null; experiment_id: string | null; updated_at: string }>(
    `SELECT id, statement, scope, status, approved_by, approved_at, experiment_id, updated_at FROM learnings WHERE site_id = ? AND status IN ('approved', 'superseded') ORDER BY id`,
    [ctx.siteId],
  );
  return {
    sourceType: 'approved_learning',
    complete: true,
    ownedPrefixes: ['learning:'],
    documents: rows.map((r) => ({
      sourceType: 'approved_learning' as const,
      sourceRef: `learning:${r.id}`,
      title: `Learning: ${r.statement.slice(0, 120)}`,
      text: [`# Learning (${r.status})`, r.statement, `Scope: ${r.scope}`, r.experiment_id ? `From experiment: ${r.experiment_id}` : '', r.approved_by ? `Approved by ${r.approved_by}${r.approved_at ? ` on ${r.approved_at.slice(0, 10)}` : ''}` : '']
        .filter(Boolean)
        .join('\n\n'),
      language: defaultLanguage(ctx, opts),
      trustClass: (r.approved_by ? 'owner_approved' : 'model_generated') as TrustClass,
      status: r.status === 'superseded' ? ('superseded' as const) : ('active' as const),
      recordStatus: r.status,
      sourceDate: dateOnly(r.approved_at) ?? dateOnly(r.updated_at),
    })),
  };
}

export function collectDecisions(ctx: MemoryCtx, opts: CollectOptions = {}): CollectedSet {
  const rows = ctx.db.all<{ id: string; subject_type: string; subject_id: string; decision: string; reason: string | null; decided_by: string; decided_at: string; vault_path: string | null }>(
    `SELECT id, subject_type, subject_id, decision, reason, decided_by, decided_at, vault_path FROM decisions WHERE site_id = ? ORDER BY id`,
    [ctx.siteId],
  );
  return {
    sourceType: 'decision',
    complete: true,
    ownedPrefixes: ['decision:'],
    documents: rows.map((r) => ({
      sourceType: 'decision' as const,
      sourceRef: `decision:${r.id}`,
      title: `Decision: ${r.decision} (${r.subject_type} ${r.subject_id})`,
      text: [`# Decision: ${r.decision}`, `Subject: ${r.subject_type} ${r.subject_id}`, r.reason ? `Reason: ${r.reason}` : 'Reason: not recorded', `Decided by ${r.decided_by} on ${r.decided_at.slice(0, 10)}`].join('\n\n'),
      language: defaultLanguage(ctx, opts),
      trustClass: (/^owner(:|$)/.test(r.decided_by) ? 'owner_approved' : 'model_generated') as TrustClass,
      recordStatus: r.decision,
      sourceDate: dateOnly(r.decided_at),
      ...(r.vault_path ? { linkAliases: [r.vault_path] } : {}),
    })),
  };
}

export interface IngestSummary {
  dryRun: boolean;
  bySourceType: Record<string, { collected: number; created: number; newVersion: number; metadataUpdated: number; unchanged: number; rejected: number; deleted: number }>;
  rejected: Array<{ sourceType: string; sourceRef: string; reason: string; detail: string }>;
  tombstonesCreated: number;
  notes: string[];
}

/**
 * Collect every source, ingest it, and propagate deletions for complete
 * sources. `quiet` suppresses policy logging (for ingests that are simulated
 * and rolled back to plan a dry run).
 */
export function ingestAll(ctx: MemoryCtx & Pick<AppContext, 'paths'>, opts: CollectOptions & { dryRun?: boolean; quiet?: boolean; sourceTypes?: MemorySourceType[] } = {}): IngestSummary {
  const summary: IngestSummary = { dryRun: !!opts.dryRun, bySourceType: {}, rejected: [], tombstonesCreated: 0, notes: [] };
  if (ctx.synthetic) summary.notes.push('Synthetic (demo) workspace: every memory document is stored with trust class "synthetic" and is never shown as owner-approved or measured.');
  const collectors: Array<[MemorySourceType, () => CollectedSet]> = [
    ['business_note', () => collectBusinessNotes(ctx, opts)],
    ['source_excerpt', () => collectSourceExcerpts(ctx, opts)],
    ['competitor_finding', () => collectCompetitorFindings(ctx, opts)],
    ['brief', () => collectBriefs(ctx, opts)],
    ['experiment_summary', () => collectExperimentSummaries(ctx, opts)],
    ['rejected_proposal', () => collectRejectedProposals(ctx, opts)],
    ['approved_learning', () => collectLearnings(ctx, opts)],
    ['decision', () => collectDecisions(ctx, opts)],
  ];
  for (const [type, collect] of collectors) {
    if (opts.sourceTypes && !opts.sourceTypes.includes(type)) continue;
    const set = collect();
    const s = { collected: set.documents.length, created: 0, newVersion: 0, metadataUpdated: 0, unchanged: 0, rejected: 0, deleted: 0 };
    summary.bySourceType[type] = s;
    if (set.notes) summary.notes.push(...set.notes);
    const present = new Set<string>();
    for (const doc of set.documents) {
      const r: IngestOutcome = ingestDocument(ctx, doc, { dryRun: !!opts.dryRun, ...(opts.quiet ? { quiet: true } : {}) });
      if (r.action === 'rejected') {
        s.rejected++;
        summary.rejected.push({ sourceType: type, sourceRef: doc.sourceRef, reason: r.reason ?? 'invalid', detail: r.detail ?? '' });
        // Keep an existing (previously accepted) version rather than deleting it because of a new policy violation.
        if (r.documentId) present.add(doc.sourceRef);
        continue;
      }
      present.add(doc.sourceRef);
      summary.tombstonesCreated += r.tombstones;
      if (r.action === 'created') s.created++;
      else if (r.action === 'new_version') s.newVersion++;
      else if (r.action === 'metadata_updated') s.metadataUpdated++;
      else s.unchanged++;
    }
    if (set.complete) {
      const p = propagateMissing(ctx, type, present, { dryRun: !!opts.dryRun, refPrefixes: set.ownedPrefixes });
      s.deleted = p.deleted.length;
      summary.tombstonesCreated += p.tombstones;
    }
  }
  return summary;
}
