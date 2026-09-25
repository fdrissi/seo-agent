import { z } from 'zod';
import { normalizedContentHash } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import type { Db } from '../../database/db.js';
import { redactString } from '../../security/redact.js';
import type { LlmClient } from '../llm/types.js';

/**
 * Normalization of Reddit Scraper dataset items into discovery signals
 * (`content_signals`, origin `apify_reddit`).
 *
 * - Items are UNTRUSTED data: their text is stored and classified, never
 *   interpreted as instructions; nothing in an item can change configuration,
 *   budgets, prompts, or approvals.
 * - Personal data is minimized by default: only an allowlist of non-personal
 *   fields is requested from the dataset and kept locally; author/profile
 *   fields, user_profile items, and communities are dropped; user handles,
 *   e-mail addresses, and phone-like numbers inside text are masked.
 * - Each signal keeps its source link and posting date, the collection
 *   window, and explicit limitations. Engagement is recorded as engagement,
 *   never as search volume.
 */

export const SIGNAL_TYPES = ['question', 'objection', 'complaint', 'comparison', 'unmet_need', 'tool_idea'] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/** Non-personal post fields kept (dataset field names from docs/integration-contracts.md). */
export const POST_FIELDS = ['dataType', 'id', 'postUrl', 'title', 'body', 'communityName', 'parsedCommunityName', 'upVotes', 'score', 'upvoteRatio', 'commentsCount', 'createdAt', 'searchTerm', 'over18'] as const;
/** Non-personal comment fields kept. */
export const COMMENT_FIELDS = ['dataType', 'id', 'url', 'postId', 'parentKind', 'depth', 'body', 'subredditName', 'score', 'commentUpVotes', 'commentCreatedAt', 'postTitle', 'searchTerm'] as const;
/** Server-side field allowlist for dataset reads (`fields` parameter). */
export const DATASET_FIELDS: readonly string[] = [...new Set<string>([...POST_FIELDS, ...COMMENT_FIELDS])];

export const TRANSFORMATION_VERSION = 'apify-reddit-normalize@1';
export const HEURISTIC_METHOD = 'heuristic-en@1';

export const REDDIT_LIMITATIONS =
  'User-reported Reddit content collected via Apify: not verified product facts and not a representative survey of customers or the market. ' +
  'Engagement (votes, comments) is not search volume. Heuristic classification is English-pattern based and approximate.';

export interface NormalizedRedditItem {
  /** `${dataType}:${id}` (dedupe key per the actor README). */
  key: string;
  dataType: 'post' | 'comment';
  itemId: string;
  /** Minimized signal text that is stored. */
  text: string;
  /** Minimized text used for classification (title + body excerpt). */
  context: string;
  title: string | null;
  url: string | null;
  postedAt: string | null;
  community: string | null;
  searchTerm: string | null;
  engagement: { score: number | null; upVotes: number | null; commentsCount: number | null; upvoteRatio: number | null };
}

export interface NormalizeResult {
  items: NormalizedRedditItem[];
  skipped: Record<string, number>;
  duplicates: number;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Strip control characters and collapse whitespace; bound the length. */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Mask user handles, e-mail addresses, and phone-like numbers in free text,
 * and credential-shaped strings (someone else's leaked key is never stored).
 */
export function minimizePersonalData(text: string): string {
  return redactString(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(^|[^A-Za-z0-9])(\/?)(?:u|user)\/[A-Za-z0-9_-]{2,}/gi, '$1$2u/[user]')
    .replace(/(^|\s)@[A-Za-z0-9_]{2,}/g, '$1@[user]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m));
}

/** Only http(s) links are kept; profile links are dropped as personal data. */
export function safeLink(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (/\/(u|user)\/[^/]+/i.test(u.pathname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const REMOVED_BODY = /^\[(deleted|removed)\]$/i;

export function normalizeDatasetItems(raw: readonly unknown[]): NormalizeResult {
  const items: NormalizedRedditItem[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  let duplicates = 0;
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);

  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      skip('not an object');
      continue;
    }
    const o = r as Record<string, unknown>;
    const dataType = str(o.dataType);
    if (dataType !== 'post' && dataType !== 'comment') {
      skip(`dataType ${dataType ?? 'missing'} not used (personal-data minimization / out of scope)`);
      continue;
    }
    const id = str(o.id);
    if (!id) {
      skip('missing id');
      continue;
    }
    const key = `${dataType}:${id}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    if (o.over18 === true) {
      skip('NSFW');
      continue;
    }
    if (dataType === 'post') {
      const title = minimizePersonalData(cleanText(o.title, 300));
      const bodyRaw = cleanText(o.body, 2000);
      const body = REMOVED_BODY.test(bodyRaw) ? '' : minimizePersonalData(bodyRaw);
      const text = title || body.slice(0, 500);
      if (!text) {
        skip('empty text');
        continue;
      }
      items.push({
        key,
        dataType,
        itemId: id,
        text,
        context: [title, body.slice(0, 600)].filter(Boolean).join('\n'),
        title: title || null,
        url: safeLink(o.postUrl),
        postedAt: isoOrNull(o.createdAt),
        community: cleanText(o.communityName ?? o.parsedCommunityName, 100) || null,
        searchTerm: cleanText(o.searchTerm, 200) || null,
        engagement: { score: num(o.score), upVotes: num(o.upVotes), commentsCount: num(o.commentsCount), upvoteRatio: num(o.upvoteRatio) },
      });
    } else {
      const bodyRaw = cleanText(o.body, 2000);
      if (!bodyRaw || REMOVED_BODY.test(bodyRaw)) {
        skip('empty or removed comment');
        continue;
      }
      const body = minimizePersonalData(bodyRaw);
      const sub = cleanText(o.subredditName, 100);
      items.push({
        key,
        dataType,
        itemId: id,
        text: body.slice(0, 500),
        context: body.slice(0, 800),
        title: minimizePersonalData(cleanText(o.postTitle, 300)) || null,
        url: safeLink(o.url),
        postedAt: isoOrNull(o.commentCreatedAt),
        community: sub ? `r/${sub.replace(/^r\//i, '')}` : null,
        searchTerm: cleanText(o.searchTerm, 200) || null,
        engagement: { score: num(o.score), upVotes: num(o.commentUpVotes), commentsCount: null, upvoteRatio: null },
      });
    }
  }
  return { items, skipped, duplicates };
}

/**
 * Deterministic English heuristics, in priority order. They are a cheap first
 * pass, not ground truth; an LLM classifier can be injected instead.
 */
const RULES: Array<[SignalType, RegExp]> = [
  [
    'comparison',
    /\b(vs\.?|versus|compared (to|with)|comparison|alternatives? (to|for)|better than|worse than|switch(ed|ing)? (from|to)|instead of|which (one )?(is )?(better|best)|or should i)\b/i,
  ],
  [
    'tool_idea',
    /\b(is there|looking for|need|want|know of|recommend|any)\b.{0,40}\b(tools?|apps?|calculators?|templates?|spreadsheets?|plugins?|extensions?|generators?|checklists?|software)\b|\bwish (there was|there were|someone (would )?(build|make))\b|\b(calculator|spreadsheet|template|checklist) (for|to)\b/i,
  ],
  ['objection', /\b(too expensive|overpriced|not worth|worth (it|the money)|is it worth|hidden (fees|costs)|lock-?in|cancell?ation (fee|policy)|skeptic(al)?|hesita(nt|ting)|red flags?|concerns? about|legit|scam)\b/i],
  [
    'complaint',
    /\b(frustrat\w*|annoy\w*|terrible|awful|horrible|hate|worst|broken|disappoint\w*|waste of|rip-?off|doesn'?t work|does not work|stopped working|keeps? (crashing|failing)|buggy|useless|nightmare|fed up|complain\w*|problems? with|issues? with)\b/i,
  ],
  ['unmet_need', /\b(wish (i|it|they|there)|can'?t find|cannot find|no (good |easy )?way to|is there (any|a) way|struggl\w+ (to|with)|need help|looking for (a|an|some)|how (can|do) (i|we) (find|get))\b/i],
];
const QUESTION_START = /^(how|what|why|when|where|which|who|can|could|should|would|is|are|does|do|did|has|have|anyone|anybody|any)\b/i;

export function classifySignal(text: string): { type: SignalType | null; matched: SignalType[] } {
  const matched: SignalType[] = [];
  for (const [type, re] of RULES) if (re.test(text)) matched.push(type);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).slice(0, 8);
  if (sentences.some((s) => /\?\s*$/.test(s.trim()) || (QUESTION_START.test(s.trim()) && s.trim().length > 10))) matched.push('question');
  return { type: matched[0] ?? null, matched };
}

export interface ClassificationResult {
  method: string;
  types: Map<string, SignalType | null>;
  /**
   * Optional salient customer phrasing per item key: a short phrase that
   * appears VERBATIM in the (already minimized) item text, never paraphrased
   * or invented by a model. Stored as a signal attribute.
   */
  phrases?: Map<string, string>;
}

export type SignalClassifier = (items: NormalizedRedditItem[]) => Promise<ClassificationResult | null>;

export function heuristicClassify(items: readonly NormalizedRedditItem[]): ClassificationResult {
  const types = new Map<string, SignalType | null>();
  for (const it of items) {
    // Posts: the title is the strongest signal; fall back to title + body.
    const primary = classifySignal(it.dataType === 'post' && it.title ? it.title : it.context);
    types.set(it.key, primary.type ?? classifySignal(it.context).type);
  }
  return { method: HEURISTIC_METHOD, types };
}

const llmOutputSchema = z.object({
  items: z.array(z.object({ id: z.string(), signalType: z.enum(SIGNAL_TYPES).nullable(), customerPhrase: z.string().max(400).nullable().optional() })),
});

const MAX_PHRASE_CHARS = 160;

function looseNorm(s: string): string {
  return s.normalize('NFC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A customer phrase is kept only when, after personal-data minimization, it
 * appears verbatim (case/whitespace-insensitive) in the item's minimized text:
 * customer language is quoted, never generated.
 */
export function verifiedCustomerPhrase(item: Pick<NormalizedRedditItem, 'context' | 'text' | 'title'>, phrase: string | null | undefined): string | null {
  if (!phrase) return null;
  const p = minimizePersonalData(cleanText(phrase, MAX_PHRASE_CHARS)).replace(/^["'\s]+|["'\s]+$/g, '');
  if (p.length < 3) return null;
  const hay = looseNorm([item.title ?? '', item.text, item.context].join('\n'));
  return hay.includes(looseNorm(p)) ? p : null;
}

/** Outcome of one LLM classification attempt (reported so callers never present a heuristic fallback as an LLM result). */
export type LlmClassifierOutcome =
  | { ok: true; method: string; classified: number; phrases: number }
  | { ok: false; status: string; reason: string };

/**
 * Optional LLM classifier. The integrator supplies the prompt id (prompt
 * templates live under prompts/). Items are passed as untrusted evidence
 * (trust class `user_reported`), minimized text only; no author data exists
 * to send. Returns null (heuristics are used) when the model is not
 * configured or the call fails.
 */
export function llmSignalClassifier(
  llm: LlmClient,
  opts: { siteId: string; runId: string; promptId: string; maxItems?: number; /** Called once per classification attempt with the outcome (LLM result or why heuristics are used). */ onResult?: (r: LlmClassifierOutcome) => void },
): SignalClassifier {
  return async (items) => {
    if (!llm.isConfigured('cheap')) {
      opts.onResult?.({ ok: false, status: 'not_configured', reason: 'no cheap model is configured for the LLM Gateway' });
      return null;
    }
    const batch = items.slice(0, opts.maxItems ?? 100);
    const res = await llm.structured({
      siteId: opts.siteId,
      runId: opts.runId,
      role: 'classifier',
      tier: 'cheap',
      promptId: opts.promptId,
      variables: { allowedTypes: SIGNAL_TYPES.join(', ') },
      evidence: batch.map((i) => ({ id: i.key, label: `reddit ${i.dataType}`, text: i.context, trustClass: 'user_reported' as const, ...(i.url ? { url: i.url } : {}) })),
      schema: llmOutputSchema,
      schemaName: 'reddit_signal_classification',
    });
    if (!res.ok) {
      opts.onResult?.({ ok: false, status: res.status, reason: res.reason });
      return null;
    }
    const byKey = new Map(batch.map((i) => [i.key, i]));
    const types = new Map<string, SignalType | null>();
    const phrases = new Map<string, string>();
    for (const r of res.value.items) {
      const it = byKey.get(r.id);
      if (!it || types.has(r.id)) continue;
      types.set(r.id, r.signalType);
      const phrase = r.signalType ? verifiedCustomerPhrase(it, r.customerPhrase) : null;
      if (phrase) phrases.set(r.id, phrase);
    }
    const classified = types.size;
    // Items the model skipped fall back to heuristics.
    const fallback = heuristicClassify(items.filter((i) => !types.has(i.key)));
    for (const [k, v] of fallback.types) types.set(k, v);
    const method = `llm:${res.promptVersion}:${res.model}+${HEURISTIC_METHOD}`;
    opts.onResult?.({ ok: true, method, classified, phrases: phrases.size });
    return { method, types, ...(phrases.size ? { phrases } : {}) };
  };
}

export interface PersistSignalsInput {
  siteId: string;
  apifyRunId: string;
  items: readonly NormalizedRedditItem[];
  classification: ClassificationResult;
  collectedAt: string;
  collectionWindow: Record<string, unknown>;
  rawRef: string | null;
  isSynthetic: boolean;
  limitations?: string;
}

export interface PersistSignalsResult {
  created: number;
  /** Items already recorded as an occurrence of their signal (e.g. the same item collected again). */
  duplicates: number;
  /** Repeat occurrences: a different item with the same normalized text as an existing signal (recurrence + supporting example). */
  occurrences: number;
  unclassified: number;
  byType: Record<string, number>;
}

/**
 * Store classified items as content signals with a `sources` row (trust class
 * `user_reported`, or `synthetic`) and an `evidence` excerpt. Unclassified
 * items are not stored as signals. Signals are unique per (site, origin,
 * normalized text hash); every supporting item (the first and each repeat
 * from another post/comment or a later run) is recorded in
 * `apify_signal_occurrences` with its own source link and evidence excerpt,
 * so recurrence and supporting examples are kept. Re-processing the same item
 * is idempotent.
 */
export function persistSignals(db: Db, input: PersistSignalsInput): PersistSignalsResult {
  const out: PersistSignalsResult = { created: 0, duplicates: 0, occurrences: 0, unclassified: 0, byType: {} };
  const limitations = (input.isSynthetic ? 'SYNTHETIC FIXTURE DATA (not real Reddit content). ' : '') + (input.limitations ?? REDDIT_LIMITATIONS);
  const trustClass = input.isSynthetic ? 'synthetic' : 'user_reported';
  db.transaction(() => {
    for (const it of input.items) {
      const type = input.classification.types.get(it.key) ?? null;
      if (!type) {
        out.unclassified++;
        continue;
      }
      const hash = normalizedContentHash(it.text.toLowerCase());
      const existing = db.get<{ id: string; signal_type: string }>(
        `SELECT id, signal_type FROM content_signals WHERE site_id = ? AND origin = 'apify_reddit' AND normalized_hash = ?`,
        [input.siteId, hash],
      );
      if (existing) {
        const seen = db.get<{ id: string }>('SELECT id FROM apify_signal_occurrences WHERE site_id = ? AND signal_id = ? AND item_key = ?', [input.siteId, existing.id, it.key]);
        if (seen) {
          out.duplicates++;
          continue;
        }
      }
      const sourceId = newId('src');
      db.run(
        `INSERT OR IGNORE INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at, published_at, raw_ref, content_hash, metadata_json)
         VALUES (?, ?, 'reddit', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          input.siteId,
          trustClass,
          it.url,
          it.title,
          input.collectedAt,
          it.postedAt,
          input.rawRef,
          hash,
          JSON.stringify({ dataType: it.dataType, itemKey: it.key, community: it.community, searchTerm: it.searchTerm, apifyRunId: input.apifyRunId, classification: input.classification.method, transformation: TRANSFORMATION_VERSION }),
        ],
      );
      const src =
        db.get<{ id: string }>('SELECT id FROM sources WHERE id = ?', [sourceId]) ??
        db.get<{ id: string }>(`SELECT id FROM sources WHERE site_id = ? AND source_type = 'reddit' AND url IS ? AND content_hash = ?`, [input.siteId, it.url, hash]);
      const date = it.postedAt ? it.postedAt.slice(0, 10) : null;
      const signalId = existing?.id ?? newId('sig');
      const phrase = input.classification.phrases?.get(it.key) ?? null;
      let evidenceId: string | null = null;
      if (src) {
        evidenceId = newId('ev');
        db.run(
          `INSERT INTO evidence (id, site_id, source_id, kind, summary, excerpt, locator_json, value_json, date_range_start, date_range_end, collected_at, transformation_version)
           VALUES (?, ?, ?, 'excerpt', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            evidenceId,
            input.siteId,
            src.id,
            `Reddit ${it.dataType} (${existing ? `${existing.signal_type}, repeat occurrence` : type}); user-reported`,
            it.text,
            JSON.stringify({ itemKey: it.key, apifyRunId: input.apifyRunId, signalId }),
            JSON.stringify({ engagement: it.engagement, ...(phrase ? { customerPhrase: phrase, customerPhraseNote: 'verbatim from the minimized item text (user-reported)' } : {}) }),
            date,
            date,
            input.collectedAt,
            TRANSFORMATION_VERSION,
          ],
        );
      }
      if (!existing) {
        db.run(
          `INSERT INTO content_signals (id, site_id, origin, signal_type, text, normalized_hash, url, posted_at, collected_at, collection_window_json, engagement_json,
             limitations, source_id, apify_run_id, content_item_id, is_synthetic)
           VALUES (?, ?, 'apify_reddit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          [
            signalId,
            input.siteId,
            type,
            it.text,
            hash,
            it.url,
            it.postedAt,
            input.collectedAt,
            JSON.stringify({ ...input.collectionWindow, searchTerm: it.searchTerm, community: it.community, ...(phrase ? { customerPhrase: phrase } : {}) }),
            JSON.stringify({ ...it.engagement, note: 'Engagement is not search volume.' }),
            limitations,
            src?.id ?? null,
            input.apifyRunId,
            input.isSynthetic ? 1 : 0,
          ],
        );
        out.created++;
        out.byType[type] = (out.byType[type] ?? 0) + 1;
      } else {
        out.occurrences++;
      }
      db.run(
        `INSERT INTO apify_signal_occurrences (id, site_id, signal_id, apify_run_id, item_key, source_id, evidence_id, url, posted_at, collected_at, is_synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('occ'), input.siteId, signalId, input.apifyRunId, it.key, src?.id ?? null, evidenceId, it.url, it.postedAt, input.collectedAt, input.isSynthetic ? 1 : 0],
      );
    }
  });
  return out;
}

/** Occurrence count (recurrence) and supporting example links per apify_reddit signal of a site. */
export function signalOccurrences(db: Db, siteId: string, signalId: string): { count: number; examples: Array<{ itemKey: string; url: string | null; postedAt: string | null; apifyRunId: string | null }> } {
  const rows = db.all<{ item_key: string; url: string | null; posted_at: string | null; apify_run_id: string | null }>(
    'SELECT item_key, url, posted_at, apify_run_id FROM apify_signal_occurrences WHERE site_id = ? AND signal_id = ? ORDER BY collected_at, item_key',
    [siteId, signalId],
  );
  return { count: rows.length, examples: rows.map((r) => ({ itemKey: r.item_key, url: r.url, postedAt: r.posted_at, apifyRunId: r.apify_run_id })) };
}
