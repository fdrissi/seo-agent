import { newId } from '../core/ids.js';
import type { TrustClass } from '../core/modes.js';
import { recordAudit } from '../database/audit.js';
import { json, parseJson, type Db } from '../database/db.js';
import { normalizedTextHash } from './text.js';
import {
  DEFAULT_LIMITATIONS,
  IN_PRODUCTION_STAGES,
  type BriefGateResult,
  type CollectionWindow,
  type BriefRecord,
  type ContentBrief,
  type ContentDecision,
  type ContentItem,
  type ContentSignal,
  type ContentStage,
  type DraftPackage,
  type DraftRecord,
  type DraftStatus,
  type Intent,
  type QualityCheck,
  type QualityReason,
  type SignalInput,
  type SignalOrigin,
  type SignalType,
  type Verdict,
  type AiReviewRecord,
} from './types.js';

/**
 * SQLite persistence for the content pipeline. Every query is scoped by
 * site_id and parameterized. JSON columns are validated by the schema.
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

interface SignalRow {
  id: string;
  site_id: string;
  origin: string;
  signal_type: string;
  text: string;
  normalized_hash: string;
  url: string | null;
  posted_at: string | null;
  collected_at: string;
  collection_window_json: string | null;
  engagement_json: string | null;
  limitations: string;
  source_id: string | null;
  apify_run_id: string | null;
  content_item_id: string | null;
  is_synthetic: number;
}

/**
 * Normalize a stored collection window. Other writers (e.g. the Apify adapter)
 * store run metadata instead of start/end/description; it is mapped here and
 * the original fields are preserved under `details`.
 */
export function normalizeWindow(raw: unknown): CollectionWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const known = new Set(['start', 'end', 'timeZone', 'description', 'details']);
  const extra = Object.fromEntries(Object.entries(w).filter(([k]) => !known.has(k)));
  const start = str(w.start) ?? str(w.postedAfter);
  const end = str(w.end) ?? str(w.postedBefore) ?? (str(w.runFinishedAt)?.slice(0, 10) ?? null);
  const parts = Object.entries(extra)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v)}`);
  const description = str(w.description) ?? (parts.length ? `Collected with ${parts.join(', ')}` : 'Collection window not recorded');
  const details = { ...(w.details && typeof w.details === 'object' ? (w.details as Record<string, unknown>) : {}), ...extra };
  return { start, end, timeZone: str(w.timeZone), description, ...(Object.keys(details).length ? { details } : {}) };
}

export function rowToSignal(r: SignalRow): ContentSignal {
  return {
    id: r.id,
    siteId: r.site_id,
    origin: r.origin as SignalOrigin,
    signalType: r.signal_type as SignalType,
    text: r.text,
    normalizedHash: r.normalized_hash,
    url: r.url,
    postedAt: r.posted_at,
    collectedAt: r.collected_at,
    collectionWindow: normalizeWindow(parseJson<unknown>(r.collection_window_json, null)),
    engagement: parseJson(r.engagement_json, null),
    limitations: r.limitations,
    sourceId: r.source_id,
    apifyRunId: r.apify_run_id,
    contentItemId: r.content_item_id,
    isSynthetic: r.is_synthetic === 1,
  };
}

/**
 * Insert or refresh a signal. The unique key is (site, origin, normalized
 * hash); re-collection refreshes window/engagement but never re-links an
 * already assigned signal.
 */
export function upsertSignal(db: Db, siteId: string, input: SignalInput, now: string): ContentSignal {
  const text = input.text.trim();
  const hash = normalizedTextHash(text);
  const row = db.get<SignalRow>(
    `INSERT INTO content_signals (id, site_id, origin, signal_type, text, normalized_hash, url, posted_at, collected_at,
       collection_window_json, engagement_json, limitations, source_id, apify_run_id, content_item_id, is_synthetic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (site_id, origin, normalized_hash) DO UPDATE SET
       collected_at = excluded.collected_at,
       collection_window_json = excluded.collection_window_json,
       engagement_json = excluded.engagement_json,
       limitations = excluded.limitations,
       url = COALESCE(excluded.url, content_signals.url),
       posted_at = COALESCE(excluded.posted_at, content_signals.posted_at),
       source_id = COALESCE(excluded.source_id, content_signals.source_id)
     RETURNING *`,
    [
      newId('sig'),
      siteId,
      input.origin,
      input.signalType,
      text,
      hash,
      input.url ?? null,
      input.postedAt ?? null,
      now,
      json(input.collectionWindow ?? null),
      json(input.engagement ?? null),
      input.limitations ?? DEFAULT_LIMITATIONS[input.origin],
      input.sourceId ?? null,
      input.apifyRunId ?? null,
      input.isSynthetic ? 1 : 0,
    ],
  );
  return rowToSignal(row!);
}

export function listSignals(db: Db, siteId: string, filter: { ids?: string[]; itemId?: string; unassigned?: boolean; origins?: SignalOrigin[] } = {}): ContentSignal[] {
  const where: string[] = ['site_id = ?'];
  const params: unknown[] = [siteId];
  if (filter.ids) {
    if (filter.ids.length === 0) return [];
    where.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
    params.push(...filter.ids);
  }
  if (filter.itemId) {
    where.push('content_item_id = ?');
    params.push(filter.itemId);
  }
  if (filter.unassigned) where.push('content_item_id IS NULL');
  if (filter.origins) {
    if (filter.origins.length === 0) return [];
    where.push(`origin IN (${filter.origins.map(() => '?').join(', ')})`);
    params.push(...filter.origins);
  }
  return db.all<SignalRow>(`SELECT * FROM content_signals WHERE ${where.join(' AND ')} ORDER BY collected_at, id`, params).map(rowToSignal);
}

export function assignSignals(db: Db, siteId: string, signalIds: string[], itemId: string): void {
  for (const id of signalIds) {
    db.run('UPDATE content_signals SET content_item_id = ? WHERE site_id = ? AND id = ? AND content_item_id IS NULL', [itemId, siteId, id]);
  }
}

// ---------------------------------------------------------------------------
// Sources / evidence / claims (provenance)
// ---------------------------------------------------------------------------

export function ensureSource(
  db: Db,
  s: { siteId: string; sourceType: string; trustClass: TrustClass; url: string; title?: string | null; contentHash: string; retrievedAt: string; metadata?: Record<string, unknown> | null },
): string {
  const existing = db.get<{ id: string }>('SELECT id FROM sources WHERE site_id = ? AND source_type = ? AND url = ? AND content_hash = ?', [s.siteId, s.sourceType, s.url, s.contentHash]);
  if (existing) return existing.id;
  const id = newId('src');
  db.run(
    `INSERT INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at, published_at, raw_ref, content_hash, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [id, s.siteId, s.sourceType, s.trustClass, s.url, s.title ?? null, s.retrievedAt, s.contentHash, json(s.metadata ?? null)],
  );
  return id;
}

export function insertEvidence(
  db: Db,
  e: { siteId: string; sourceId: string; kind: 'metric' | 'excerpt' | 'observation' | 'absence'; summary: string; excerpt?: string | null; locator?: unknown; value?: unknown; dateStart?: string | null; dateEnd?: string | null; collectedAt: string },
): string {
  const id = newId('evd');
  db.run(
    `INSERT INTO evidence (id, site_id, source_id, kind, summary, excerpt, locator_json, value_json, date_range_start, date_range_end, collected_at, transformation_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, e.siteId, e.sourceId, e.kind, e.summary, e.excerpt ?? null, json(e.locator ?? null), json(e.value ?? null), e.dateStart ?? null, e.dateEnd ?? null, e.collectedAt, 'content@1'],
  );
  return id;
}

export function insertClaimEvidence(
  db: Db,
  c: { siteId: string; subjectType: 'brief' | 'draft' | 'quality_review' | 'opportunity'; subjectId: string; claimKey: string; claimText: string; label: string; evidenceId: string | null; support: 'supports' | 'contradicts' | 'context' | 'missing'; createdAt: string },
): void {
  db.run(
    `INSERT INTO claim_evidence (id, site_id, subject_type, subject_id, claim_key, claim_text, claim_label, evidence_id, support, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('clm'), c.siteId, c.subjectType, c.subjectId, c.claimKey, c.claimText, c.label, c.evidenceId, c.support, c.createdAt],
  );
}

// ---------------------------------------------------------------------------
// Clusters (keyword_clusters) and content items
// ---------------------------------------------------------------------------

export function insertCluster(db: Db, siteId: string, c: { label: string; intent: string; method: string; methodVersion: string; metadata: unknown; now: string }): string {
  const id = newId('kcl');
  db.run('INSERT INTO keyword_clusters (id, site_id, label, intent, method, method_version, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    siteId,
    c.label,
    c.intent,
    c.method,
    c.methodVersion,
    json(c.metadata),
    c.now,
  ]);
  return id;
}

export function updateClusterMetadata(db: Db, siteId: string, clusterId: string, metadata: unknown): void {
  db.run('UPDATE keyword_clusters SET metadata_json = ? WHERE site_id = ? AND id = ?', [json(metadata), siteId, clusterId]);
}

export function getClusterMetadata(db: Db, siteId: string, clusterId: string): Record<string, unknown> | null {
  const r = db.get<{ metadata_json: string | null }>('SELECT metadata_json FROM keyword_clusters WHERE site_id = ? AND id = ?', [siteId, clusterId]);
  return r ? parseJson(r.metadata_json, null) : null;
}

interface ItemRow {
  id: string;
  site_id: string;
  title: string;
  primary_question: string | null;
  stage: string;
  decision: string | null;
  decision_reason: string | null;
  intent: string | null;
  cluster_id: string | null;
  target_page_id: string | null;
  why_exists: string | null;
  who_benefits: string | null;
  business_relation: string | null;
  original_value: string | null;
  reader_next_step: string | null;
  demand_json: string | null;
  overlap_json: string | null;
  priority_score: number | null;
  is_synthetic: number;
  created_at: string;
  updated_at: string;
}

export function rowToItem(r: ItemRow): ContentItem {
  return {
    id: r.id,
    siteId: r.site_id,
    title: r.title,
    primaryQuestion: r.primary_question,
    stage: r.stage as ContentStage,
    decision: r.decision as ContentDecision | null,
    decisionReason: r.decision_reason,
    intent: r.intent as Intent | null,
    clusterId: r.cluster_id,
    targetPageId: r.target_page_id,
    whyExists: r.why_exists,
    whoBenefits: r.who_benefits,
    businessRelation: r.business_relation,
    originalValue: r.original_value,
    readerNextStep: r.reader_next_step,
    demand: parseJson(r.demand_json, null),
    overlap: parseJson(r.overlap_json, null),
    priorityScore: r.priority_score,
    isSynthetic: r.is_synthetic === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertItem(
  db: Db,
  i: { siteId: string; title: string; primaryQuestion: string | null; stage: ContentStage; intent: string | null; clusterId: string | null; isSynthetic: boolean; now: string; decision?: ContentDecision | null; decisionReason?: string | null },
): string {
  const id = newId('ci');
  db.run(
    `INSERT INTO content_items (id, site_id, title, primary_question, stage, decision, decision_reason, intent, cluster_id, is_synthetic, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, i.siteId, i.title, i.primaryQuestion, i.stage, i.decision ?? null, i.decisionReason ?? null, i.intent, i.clusterId, i.isSynthetic ? 1 : 0, i.now, i.now],
  );
  return id;
}

const ITEM_COLUMNS: Record<string, string> = {
  title: 'title',
  primaryQuestion: 'primary_question',
  stage: 'stage',
  decision: 'decision',
  decisionReason: 'decision_reason',
  intent: 'intent',
  clusterId: 'cluster_id',
  targetPageId: 'target_page_id',
  whyExists: 'why_exists',
  whoBenefits: 'who_benefits',
  businessRelation: 'business_relation',
  originalValue: 'original_value',
  readerNextStep: 'reader_next_step',
  demand: 'demand_json',
  overlap: 'overlap_json',
  priorityScore: 'priority_score',
  isSynthetic: 'is_synthetic',
};

export type ItemPatch = Partial<Omit<ContentItem, 'id' | 'siteId' | 'createdAt' | 'updatedAt'>>;

export function updateItem(db: Db, siteId: string, id: string, patch: ItemPatch, now: string): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = ITEM_COLUMNS[k];
    if (!col || v === undefined) continue;
    sets.push(`${col} = ?`);
    if (col.endsWith('_json')) params.push(json(v));
    else if (col === 'is_synthetic') params.push(v ? 1 : 0);
    else params.push(v);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(now, siteId, id);
  db.run(`UPDATE content_items SET ${sets.join(', ')} WHERE site_id = ? AND id = ?`, params);
}

export function getItem(db: Db, siteId: string, id: string): ContentItem | null {
  const r = db.get<ItemRow>('SELECT * FROM content_items WHERE site_id = ? AND id = ?', [siteId, id]);
  return r ? rowToItem(r) : null;
}

export function listItems(db: Db, siteId: string, filter: { stages?: readonly ContentStage[]; ids?: string[]; limit?: number } = {}): ContentItem[] {
  const where = ['site_id = ?'];
  const params: unknown[] = [siteId];
  if (filter.stages) {
    if (!filter.stages.length) return [];
    where.push(`stage IN (${filter.stages.map(() => '?').join(', ')})`);
    params.push(...filter.stages);
  }
  if (filter.ids) {
    if (!filter.ids.length) return [];
    where.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
    params.push(...filter.ids);
  }
  params.push(filter.limit ?? 10_000);
  return db
    .all<ItemRow>(`SELECT * FROM content_items WHERE ${where.join(' AND ')} ORDER BY (priority_score IS NULL), priority_score DESC, created_at, id LIMIT ?`, params)
    .map(rowToItem);
}

export function countInProduction(db: Db, siteId: string, excludeItemId?: string): number {
  const params: unknown[] = [siteId, ...IN_PRODUCTION_STAGES];
  let sql = `SELECT COUNT(*) AS n FROM content_items WHERE site_id = ? AND stage IN (${IN_PRODUCTION_STAGES.map(() => '?').join(', ')})`;
  if (excludeItemId) {
    sql += ' AND id != ?';
    params.push(excludeItemId);
  }
  return Number(db.get<{ n: number }>(sql, params)?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

interface BriefRow {
  id: string;
  site_id: string;
  content_item_id: string;
  version: number;
  status: string;
  brief_json: string;
  content_hash: string;
  gate_json: string | null;
  vault_path: string | null;
  prompt_version: string | null;
  model_id: string | null;
  created_at: string;
}

function rowToBrief(r: BriefRow): BriefRecord {
  return {
    id: r.id,
    siteId: r.site_id,
    contentItemId: r.content_item_id,
    version: r.version,
    status: r.status as BriefRecord['status'],
    brief: JSON.parse(r.brief_json) as ContentBrief,
    contentHash: r.content_hash,
    gate: parseJson<BriefGateResult | null>(r.gate_json, null),
    vaultPath: r.vault_path,
    promptVersion: r.prompt_version,
    modelId: r.model_id,
    createdAt: r.created_at,
  };
}

export function insertBrief(
  db: Db,
  b: { siteId: string; itemId: string; brief: ContentBrief; contentHash: string; gate: BriefGateResult; status: BriefRecord['status']; promptVersion: string | null; modelId: string | null; now: string },
): BriefRecord {
  return db.transaction(() => {
    const max = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM content_briefs WHERE site_id = ? AND content_item_id = ?', [b.siteId, b.itemId]);
    const version = (max?.v ?? 0) + 1;
    db.run(`UPDATE content_briefs SET status = 'superseded' WHERE site_id = ? AND content_item_id = ? AND status != 'superseded'`, [b.siteId, b.itemId]);
    const id = newId('brf');
    db.run(
      `INSERT INTO content_briefs (id, site_id, content_item_id, version, status, brief_json, content_hash, gate_json, vault_path, prompt_version, model_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [id, b.siteId, b.itemId, version, b.status, JSON.stringify(b.brief), b.contentHash, json(b.gate), b.promptVersion, b.modelId, b.now],
    );
    return getBrief(db, b.siteId, id)!;
  });
}

export function getBrief(db: Db, siteId: string, id: string): BriefRecord | null {
  const r = db.get<BriefRow>('SELECT * FROM content_briefs WHERE site_id = ? AND id = ?', [siteId, id]);
  return r ? rowToBrief(r) : null;
}

export function latestBrief(db: Db, siteId: string, itemId: string): BriefRecord | null {
  const r = db.get<BriefRow>('SELECT * FROM content_briefs WHERE site_id = ? AND content_item_id = ? ORDER BY version DESC LIMIT 1', [siteId, itemId]);
  return r ? rowToBrief(r) : null;
}

export function setBriefVaultPath(db: Db, siteId: string, id: string, vaultPath: string): void {
  db.run('UPDATE content_briefs SET vault_path = ? WHERE site_id = ? AND id = ?', [vaultPath, siteId, id]);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

interface DraftRow {
  id: string;
  site_id: string;
  content_item_id: string;
  brief_id: string;
  brief_version: number;
  brief_hash: string;
  version: number;
  status: string;
  package_json: string;
  body_hash: string;
  unresolved_facts: number;
  revision_round: number;
  vault_path: string | null;
  prompt_version: string | null;
  model_id: string | null;
  created_at: string;
}

function rowToDraft(r: DraftRow): DraftRecord {
  return {
    id: r.id,
    siteId: r.site_id,
    contentItemId: r.content_item_id,
    briefId: r.brief_id,
    briefVersion: r.brief_version,
    briefHash: r.brief_hash,
    version: r.version,
    status: r.status as DraftStatus,
    pkg: JSON.parse(r.package_json) as DraftPackage,
    bodyHash: r.body_hash,
    unresolvedFacts: r.unresolved_facts,
    revisionRound: r.revision_round,
    vaultPath: r.vault_path,
    promptVersion: r.prompt_version,
    modelId: r.model_id,
    createdAt: r.created_at,
  };
}

export function insertDraft(
  db: Db,
  d: { siteId: string; itemId: string; briefId: string; briefVersion: number; briefHash: string; pkg: DraftPackage; bodyHash: string; unresolvedFacts: number; revisionRound: number; promptVersion: string | null; modelId: string | null; now: string },
): DraftRecord {
  return db.transaction(() => {
    const max = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM content_drafts WHERE site_id = ? AND content_item_id = ?', [d.siteId, d.itemId]);
    const version = (max?.v ?? 0) + 1;
    db.run(`UPDATE content_drafts SET status = 'superseded' WHERE site_id = ? AND content_item_id = ? AND status NOT IN ('superseded', 'published', 'exported')`, [d.siteId, d.itemId]);
    const id = newId('drf');
    db.run(
      `INSERT INTO content_drafts (id, site_id, content_item_id, brief_id, brief_version, brief_hash, version, status, package_json, body_hash, unresolved_facts, revision_round, vault_path, prompt_version, model_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [id, d.siteId, d.itemId, d.briefId, d.briefVersion, d.briefHash, version, JSON.stringify(d.pkg), d.bodyHash, d.unresolvedFacts, d.revisionRound, d.promptVersion, d.modelId, d.now],
    );
    return getDraft(db, d.siteId, id)!;
  });
}

export function getDraft(db: Db, siteId: string, id: string): DraftRecord | null {
  const r = db.get<DraftRow>('SELECT * FROM content_drafts WHERE site_id = ? AND id = ?', [siteId, id]);
  return r ? rowToDraft(r) : null;
}

export function latestDraft(db: Db, siteId: string, itemId: string): DraftRecord | null {
  const r = db.get<DraftRow>('SELECT * FROM content_drafts WHERE site_id = ? AND content_item_id = ? ORDER BY version DESC LIMIT 1', [siteId, itemId]);
  return r ? rowToDraft(r) : null;
}

/**
 * Latest draft of every other item (for template-similarity checks),
 * INCLUDING rejected drafts: a rejected city-substitution page must still
 * count as a sibling, or re-reviewing one of its twins alone would pass.
 */
export function siblingDrafts(db: Db, siteId: string, excludeItemId: string): DraftRecord[] {
  return db
    .all<DraftRow>(
      `SELECT d.* FROM content_drafts d
       WHERE d.site_id = ? AND d.content_item_id != ? AND d.status != 'superseded'
         AND d.version = (SELECT MAX(version) FROM content_drafts d2 WHERE d2.site_id = d.site_id AND d2.content_item_id = d.content_item_id)
       ORDER BY d.created_at`,
      [siteId, excludeItemId],
    )
    .map(rowToDraft);
}

/** Every draft (any version or status) of other items whose brief uses the same programmatic template. */
export function sameTemplateDrafts(db: Db, siteId: string, excludeItemId: string, templateId: string, limit = 500): DraftRecord[] {
  return db
    .all<DraftRow>(
      `SELECT d.* FROM content_drafts d JOIN content_briefs b ON b.id = d.brief_id AND b.site_id = d.site_id
       WHERE d.site_id = ? AND d.content_item_id != ? AND json_extract(b.brief_json, '$.programmatic.templateId') = ?
       ORDER BY d.created_at LIMIT ?`,
      [siteId, excludeItemId, templateId, limit],
    )
    .map(rowToDraft);
}

/** Programmatic template id of a brief, if any. */
export function briefTemplateId(db: Db, siteId: string, briefId: string): string | null {
  const r = db.get<{ t: string | null }>(`SELECT json_extract(brief_json, '$.programmatic.templateId') AS t FROM content_briefs WHERE site_id = ? AND id = ?`, [siteId, briefId]);
  return r?.t ?? null;
}

export function setDraftStatus(db: Db, siteId: string, id: string, status: DraftStatus): void {
  db.run('UPDATE content_drafts SET status = ? WHERE site_id = ? AND id = ?', [status, siteId, id]);
}

export function setDraftVaultPath(db: Db, siteId: string, id: string, vaultPath: string): void {
  db.run('UPDATE content_drafts SET vault_path = ? WHERE site_id = ? AND id = ?', [vaultPath, siteId, id]);
}

// ---------------------------------------------------------------------------
// Quality reviews
// ---------------------------------------------------------------------------

export interface QualityReviewRow {
  id: string;
  subjectType: 'brief' | 'draft';
  subjectId: string;
  verdict: Verdict;
  checks: QualityCheck[] | Record<string, unknown>;
  aiReview: AiReviewRecord | null;
  reasons: QualityReason[];
  revisionRound: number;
  createdAt: string;
}

export function insertQualityReview(
  db: Db,
  q: { siteId: string; subjectType: 'brief' | 'draft'; subjectId: string; verdict: Verdict; deterministic: unknown; aiReview: unknown; reasons: unknown; revisionRound: number; now: string },
): string {
  const id = newId('qrv');
  db.run(
    `INSERT INTO quality_reviews (id, site_id, subject_type, subject_id, verdict, deterministic_json, ai_review_json, reasons_json, revision_round, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, q.siteId, q.subjectType, q.subjectId, q.verdict, JSON.stringify(q.deterministic), json(q.aiReview), JSON.stringify(q.reasons), q.revisionRound, q.now],
  );
  return id;
}

/** Whether a named human accepted this draft's current body (`content mark-reviewed`) and nothing re-reviewed it since. */
export function humanAcceptedDraft(db: Db, siteId: string, draftId: string, bodyHash: string): boolean {
  const r = latestQualityReview(db, siteId, 'draft', draftId);
  if (!r || r.verdict !== 'pass') return false;
  const human = (r.checks as Record<string, unknown>)?.humanReview as { bodyHash?: unknown } | undefined;
  return !!human && human.bodyHash === bodyHash;
}

export function latestQualityReview(db: Db, siteId: string, subjectType: 'brief' | 'draft', subjectId: string): QualityReviewRow | null {
  const r = db.get<{
    id: string;
    subject_type: string;
    subject_id: string;
    verdict: string;
    deterministic_json: string;
    ai_review_json: string | null;
    reasons_json: string;
    revision_round: number;
    created_at: string;
  }>('SELECT * FROM quality_reviews WHERE site_id = ? AND subject_type = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [siteId, subjectType, subjectId]);
  if (!r) return null;
  return {
    id: r.id,
    subjectType: r.subject_type as 'brief' | 'draft',
    subjectId: r.subject_id,
    verdict: r.verdict as Verdict,
    checks: JSON.parse(r.deterministic_json),
    aiReview: parseJson(r.ai_review_json, null),
    reasons: JSON.parse(r.reasons_json),
    revisionRound: r.revision_round,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function audit(db: Db, siteId: string, eventType: string, subjectType: string, subjectId: string, details: Record<string, unknown>, at: Date, actor = 'system'): void {
  recordAudit(db, { siteId, actor, eventType, subjectType, subjectId, details, at });
}
