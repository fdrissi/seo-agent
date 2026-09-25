import { readFileSync, statSync } from 'node:fs';
import type { AppContext } from '../../app/context.js';
import { AppError, ValidationError } from '../../core/errors.js';
import { sha256 } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import { recordAudit } from '../../database/audit.js';
import type { Db } from '../../database/db.js';
import { redact } from '../../security/redact.js';
import { ApifyApiError, createApifyClient, type ApifyClient, type ApifyClientOptions } from './client.js';
import { detectSchemaDocument, diffInputSchemas, inputSchemaHash, parseInputSchema, type ActorInputSchema, type SchemaDiff } from './input-schema.js';
import { DATASET_FIELDS } from './normalize.js';
import { parsePricingRecord, selectCurrentPricing, type PricingRecord } from './pricing.js';
import { REDDIT_SCRAPER_ACTOR_ID, REDDIT_SCRAPER_LISTING, analyzeSchemaForAdapter, type AdapterSchemaAnalysis } from './reddit-adapter.js';
import type { ApifyActor, ApifyBuild } from './types.js';

/**
 * Actor identity, pricing, build pinning, and input-schema storage.
 *
 * - `apify_actor_schemas` (migration 0005) stores each tested schema with its
 *   `schema_hash`. The table is workspace-global (no site_id): a schema
 *   belongs to an actor build, not to a website.
 * - The pin is configuration (`research.apify.build` or
 *   APIFY_CONTENT_ACTOR_BUILD) and must be an immutable build NUMBER such as
 *   "0.0.513"; tags like "latest" float and are never treated as a pin.
 * - A build is runnable only when the most recent stored schema row for the
 *   pinned build number is `verified = 1` (retrieved from the build API for a
 *   SUCCEEDED build of this actor, or an import explicitly attested by the owner).
 * - Drift = the input schema hash differs between the pinned build and a
 *   newer build (or, anomalously, for the same immutable build).
 */

export const BUILD_NUMBER_RE = /^\d+\.\d+\.\d+$/;
export function isBuildNumber(build: string | null | undefined): build is string {
  return !!build && BUILD_NUMBER_RE.test(build);
}

export interface StoredPricingSnapshot {
  retrievedAt: string;
  pricingInfos: unknown[];
  /** The record in force at retrieval time (latest startedAt <= retrievedAt). */
  current: unknown | null;
}

/**
 * README provenance of a build (migration 0250). Only hashes are stored: the
 * README is untrusted documentation text and is never kept or followed.
 */
export interface ReadmeProvenance {
  sha256: string;
  retrievedAt: string;
  length: number;
  /** sha256 of each load-bearing passage (normalized); null when the passage was not found. */
  passages: Record<string, string | null>;
}

/** Output (dataset) schema check recorded with the build (migration 0250). */
export interface OutputSchemaProvenance {
  checkedAt: string;
  fieldCount: number;
  /** Required output fields (or alternatives, e.g. "title/body") absent from the published dataset schema: a run blocker. */
  missingRequired: string[];
  /** Any field the normalizer reads that is absent (informational). */
  missingUsed: string[];
}

export interface BuildProvenance {
  readme: ReadmeProvenance | null;
  outputSchema: OutputSchemaProvenance | null;
}

export interface StoredActorSchema {
  id: string;
  actorId: string;
  actorName: string | null;
  buildId: string | null;
  buildNumber: string | null;
  buildTag: string | null;
  schema: ActorInputSchema;
  schemaHash: string;
  pricing: StoredPricingSnapshot | null;
  source: 'api' | 'import' | 'fixture';
  verified: boolean;
  pinned: boolean;
  fetchedAt: string;
  /** README hash/retrieval date and output-schema check (null for imports and rows recorded before migration 0250). */
  provenance?: BuildProvenance | null;
}

interface SchemaRow {
  id: string;
  actor_id: string;
  actor_name: string | null;
  build_id: string | null;
  build_number: string | null;
  build_tag: string | null;
  input_schema_json: string | null;
  schema_hash: string | null;
  pricing_json: string | null;
  source: 'api' | 'import' | 'fixture';
  verified: number;
  pinned: number;
  fetched_at: string;
  provenance_json?: string | null;
}

function parseProvenance(json: string | null | undefined): BuildProvenance | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<BuildProvenance> | null;
    if (!v || typeof v !== 'object') return null;
    return { readme: v.readme ?? null, outputSchema: v.outputSchema ?? null };
  } catch {
    return null;
  }
}

function fromRow(r: SchemaRow): StoredActorSchema {
  return {
    id: r.id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    buildId: r.build_id,
    buildNumber: r.build_number,
    buildTag: r.build_tag,
    schema: parseInputSchema(r.input_schema_json ?? 'null', `stored schema ${r.id}`),
    schemaHash: r.schema_hash ?? '',
    pricing: r.pricing_json ? (JSON.parse(r.pricing_json) as StoredPricingSnapshot) : null,
    source: r.source,
    verified: r.verified === 1,
    pinned: r.pinned === 1,
    fetchedAt: r.fetched_at,
    provenance: parseProvenance(r.provenance_json),
  };
}

export interface StoreSchemaInput {
  actorId: string;
  actorName: string | null;
  buildId: string | null;
  buildNumber: string | null;
  buildTag: string | null;
  schema: ActorInputSchema;
  pricing: StoredPricingSnapshot | null;
  source: 'api' | 'import' | 'fixture';
  verified: boolean;
  pinned: boolean;
  fetchedAt: string;
  /** README / output-schema provenance retrieved with the build (replaces the stored one when given). */
  provenance?: BuildProvenance | null;
}

// ---------------------------------------------------------------------------
// README provenance and required output fields
// ---------------------------------------------------------------------------

/**
 * Load-bearing README passages the adapter depends on (docs/integration-contracts.md
 * section 7): whether maxPostsCount is per keyword or in total, the RUN-SUMMARY
 * record fields (itemsTotal / requests.failed / emptyReason are read by the
 * completion checks), and the dedupe key (`dataType` + `id`).
 */
export const README_PASSAGES: Readonly<Record<string, { label: string; pattern: RegExp }>> = {
  maxPostsCount: { label: 'maxPostsCount semantics (per keyword or total)', pattern: /maxPostsCount/i },
  runSummary: { label: 'RUN-SUMMARY record fields', pattern: /RUN-SUMMARY|itemsTotal|skippedTotal|emptyReason/ },
  dedupeKey: { label: 'dedupe key (dataType + id)', pattern: /\bde-?dup|\bduplicat/i },
};

const MAX_README_CHARS = 2_000_000;

function normalizePassage(lines: string[]): string {
  return lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Hash a build README and its load-bearing passages (each matching line plus the two following lines). */
export function readmeProvenance(readme: string, retrievedAt: Date): ReadmeProvenance {
  const text = readme.slice(0, MAX_README_CHARS).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const passages: Record<string, string | null> = {};
  for (const [key, def] of Object.entries(README_PASSAGES)) {
    const picked = new Set<number>();
    lines.forEach((l, i) => {
      if (def.pattern.test(l)) for (let j = i; j <= Math.min(lines.length - 1, i + 2); j++) picked.add(j);
    });
    const passage = normalizePassage([...picked].sort((a, b) => a - b).map((i) => lines[i]!));
    passages[key] = passage ? sha256(passage) : null;
  }
  return { sha256: sha256(normalizePassage(lines)), retrievedAt: retrievedAt.toISOString(), length: text.length, passages };
}

export interface ReadmeDrift {
  fromBuild: string | null;
  toBuild: string | null;
  /** Whole-README hash differs. */
  changed: boolean;
  /** Load-bearing passages whose hash differs (appeared, disappeared, or edited). */
  passagesChanged: Array<{ key: string; label: string }>;
  note: string;
}

/** Compare the README provenance of two builds; null when either side was not retrieved. */
export function diffReadmeProvenance(from: { build: string | null; readme: ReadmeProvenance | null }, to: { build: string | null; readme: ReadmeProvenance | null }): ReadmeDrift | null {
  if (!from.readme || !to.readme) return null;
  const changed = from.readme.sha256 !== to.readme.sha256;
  const passagesChanged = Object.entries(README_PASSAGES)
    .filter(([key]) => (from.readme!.passages[key] ?? null) !== (to.readme!.passages[key] ?? null))
    .map(([key, def]) => ({ key, label: def.label }));
  const note = !changed
    ? 'README unchanged between the builds.'
    : passagesChanged.length
      ? `README changed, including load-bearing passages (${passagesChanged.map((p) => p.label).join('; ')}). Re-read those sections before changing the pin: the adapter's bounds, completion checks, or dedupe may no longer match the actor.`
      : 'README changed; no load-bearing passage (maxPostsCount semantics, RUN-SUMMARY fields, dedupe key) changed.';
  return { fromBuild: from.build, toBuild: to.build, changed, passagesChanged, note };
}

/**
 * Output fields the normalizer cannot work without (alternatives separated by
 * "/"): the item discriminator and id (dedupe key), some text, a source link,
 * and a date. A published dataset schema missing any of them blocks runs.
 */
export const REQUIRED_OUTPUT_FIELDS: readonly (readonly string[])[] = [['dataType'], ['id'], ['title', 'body'], ['postUrl', 'url'], ['createdAt']];

export function missingRequiredOutputFields(fields: readonly string[]): string[] {
  const have = new Set(fields);
  return REQUIRED_OUTPUT_FIELDS.filter((alts) => !alts.some((f) => have.has(f))).map((alts) => alts.join('/'));
}

/** Insert (or refresh) a schema row keyed by (actor, build id, schema hash). */
export function storeActorSchema(db: Db, input: StoreSchemaInput): { row: StoredActorSchema; created: boolean } {
  const hash = inputSchemaHash(input.schema);
  return db.transaction(() => {
    // UNIQUE (actor_id, build_id, schema_hash) applies when build_id is known;
    // rows without a build id (imports) are matched on build number + source.
    const existing =
      input.buildId !== null
        ? db.get<SchemaRow>('SELECT * FROM apify_actor_schemas WHERE actor_id = ? AND build_id = ? AND schema_hash = ?', [input.actorId, input.buildId, hash])
        : db.get<SchemaRow>(
            'SELECT * FROM apify_actor_schemas WHERE actor_id = ? AND build_id IS NULL AND schema_hash = ? AND source = ? AND build_number IS ? ORDER BY fetched_at DESC LIMIT 1',
            [input.actorId, hash, input.source, input.buildNumber],
          );
    const provenance = input.provenance ? JSON.stringify(input.provenance) : null;
    if (existing) {
      // An API retrieval of the same build + hash confirms an earlier import.
      const source = input.source === 'api' ? 'api' : existing.source;
      db.run(
        `UPDATE apify_actor_schemas SET actor_name = COALESCE(?, actor_name), build_number = COALESCE(build_number, ?), build_tag = COALESCE(?, build_tag),
           pricing_json = COALESCE(?, pricing_json), source = ?, verified = MAX(verified, ?), pinned = MAX(pinned, ?), fetched_at = ?,
           provenance_json = COALESCE(?, provenance_json) WHERE id = ?`,
        [input.actorName, input.buildNumber, input.buildTag, input.pricing ? JSON.stringify(input.pricing) : null, source, input.verified ? 1 : 0, input.pinned ? 1 : 0, input.fetchedAt, provenance, existing.id],
      );
      return { row: fromRow(db.get<SchemaRow>('SELECT * FROM apify_actor_schemas WHERE id = ?', [existing.id])!), created: false };
    }
    const id = newId('aschema');
    db.run(
      `INSERT INTO apify_actor_schemas (id, actor_id, actor_name, build_id, build_number, build_tag, input_schema_json, schema_hash, pricing_json, source, verified, pinned, fetched_at, provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.actorId,
        input.actorName,
        input.buildId,
        input.buildNumber,
        input.buildTag,
        JSON.stringify(input.schema),
        hash,
        input.pricing ? JSON.stringify(input.pricing) : null,
        input.source,
        input.verified ? 1 : 0,
        input.pinned ? 1 : 0,
        input.fetchedAt,
        provenance,
      ],
    );
    return { row: fromRow(db.get<SchemaRow>('SELECT * FROM apify_actor_schemas WHERE id = ?', [id])!), created: true };
  });
}

/** Most recent stored schema row for a build number (or build id). */
export function findSchemaForBuild(db: Db, actorId: string, build: string): StoredActorSchema | undefined {
  const r = db.get<SchemaRow>(
    `SELECT * FROM apify_actor_schemas WHERE actor_id = ? AND (build_number = ? OR build_id = ?) ORDER BY fetched_at DESC, rowid DESC LIMIT 1`,
    [actorId, build, build],
  );
  return r ? fromRow(r) : undefined;
}

export function listStoredSchemas(db: Db, actorId: string): StoredActorSchema[] {
  return db.all<SchemaRow>('SELECT * FROM apify_actor_schemas WHERE actor_id = ? ORDER BY fetched_at DESC, rowid DESC', [actorId]).map(fromRow);
}

/** Latest pricing snapshot stored for the actor (any build row). */
export function latestPricingSnapshot(db: Db, actorId: string): StoredPricingSnapshot | null {
  const r = db.get<{ pricing_json: string }>(
    'SELECT pricing_json FROM apify_actor_schemas WHERE actor_id = ? AND pricing_json IS NOT NULL ORDER BY fetched_at DESC, rowid DESC LIMIT 1',
    [actorId],
  );
  return r ? (JSON.parse(r.pricing_json) as StoredPricingSnapshot) : null;
}

export function pricingSnapshotFromActor(actor: ApifyActor, retrievedAt: Date): StoredPricingSnapshot {
  const infos = Array.isArray(actor.pricingInfos) ? actor.pricingInfos : [];
  let current: unknown = null;
  let bestAt = -Infinity;
  for (const raw of infos) {
    const rec = parsePricingRecord(raw);
    const at = rec?.startedAt ? Date.parse(rec.startedAt) : NaN;
    if (!Number.isNaN(at) && at <= retrievedAt.getTime() && at > bestAt) {
      bestAt = at;
      current = raw;
    }
  }
  return { retrievedAt: retrievedAt.toISOString(), pricingInfos: infos, current };
}

/** Pricing record in force at `now`, from a stored snapshot. */
export function pricingFromSnapshot(s: StoredPricingSnapshot | null, now: Date): PricingRecord | null {
  if (!s) return null;
  return selectCurrentPricing(s.pricingInfos, now);
}

export interface PricingSummary {
  model: string;
  startedAt: string | null;
  events: Array<{ key: string; title: string | null; price: string; oneTime: boolean; primary: boolean }>;
}

export function summarizePricing(p: PricingRecord | null): PricingSummary | null {
  if (!p) return null;
  return {
    model: p.pricingModel,
    startedAt: p.startedAt,
    events: (p.events ?? []).map((e) => ({
      key: e.key,
      title: e.title,
      price:
        e.flatPriceMicros !== null
          ? `$${(e.flatPriceMicros / 1_000_000).toString()}`
          : e.tieredPricesMicros
            ? Object.entries(e.tieredPricesMicros)
                .map(([t, m]) => `${t} $${(m / 1_000_000).toString()}`)
                .join(', ')
            : 'unknown',
      oneTime: e.isOneTime,
      primary: e.isPrimary,
    })),
  };
}

/** Log a free (non-chargeable) read in the provider request log. */
export async function loggedRead<T>(ctx: Pick<AppContext, 'requests' | 'siteId' | 'synthetic'>, endpoint: string, params: unknown, fn: () => Promise<T>, externalId?: (r: T) => string | null): Promise<T> {
  const { id } = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'apify', endpoint, method: 'GET', isPaid: false, params, isSynthetic: ctx.synthetic });
  ctx.requests.markSubmitted(id);
  try {
    const r = await fn();
    const ext = externalId?.(r) ?? null;
    ctx.requests.complete(id, { status: 'succeeded', httpStatus: 200, ...(ext ? { externalId: ext } : {}) });
    return r;
  } catch (err) {
    ctx.requests.complete(id, { status: 'failed', httpStatus: err instanceof ApifyApiError ? err.httpStatus : null, error: err });
    throw err;
  }
}

export interface SchemaDriftReport {
  fromBuild: string | null;
  toBuild: string | null;
  fromHash: string;
  toHash: string;
  diff: SchemaDiff;
  /** Adapter compatibility of the newer schema (forced-off fields, blockers). */
  compatibility: AdapterSchemaAnalysis;
  note: string;
}

export interface InspectedBuild {
  buildId: string;
  buildNumber: string | null;
  tag: string | null;
  status: string | null;
  schemaSource: 'build' | 'openapi' | 'unavailable';
  schemaHash: string | null;
  storedRowId: string | null;
  created: boolean;
  verified: boolean;
  pinned: boolean;
  compatibility: AdapterSchemaAnalysis | null;
  /**
   * Output (dataset) schema check: the fields the normalizer reads must exist.
   * `missingRequired` (dataType, id, title/body, postUrl/url, createdAt) blocks
   * runs of this build. Null when the build publishes no dataset schema.
   */
  outputSchema: { fieldCount: number; missingUsedFields: string[]; missingRequired?: string[] } | null;
  /** README hash and retrieval date (null when the build returned no README). */
  readme?: ReadmeProvenance | null;
  /** Problems that make this build unrunnable (e.g. required output fields missing). */
  blockers?: string[];
  problems: string[];
}

/** Dataset field names from `actorDefinition.storages.dataset.fields.properties` (contract section 7, item 7). */
export function outputFieldsOf(build: ApifyBuild): string[] | null {
  const def = build.actorDefinition as { storages?: { dataset?: { fields?: { properties?: unknown } } } } | null | undefined;
  const props = def?.storages?.dataset?.fields?.properties;
  return props && typeof props === 'object' && !Array.isArray(props) ? Object.keys(props) : null;
}

export interface InspectResult {
  actorId: string;
  identity: { id: string; username: string | null; name: string | null; title: string | null; isPublic: boolean | null; isDeprecated: boolean | null; notice: string | null; modifiedAt: string | null };
  identityWarnings: string[];
  pricing: PricingSummary | null;
  pricingNote: string;
  latestBuild: InspectedBuild | null;
  pinnedBuild: { configured: string | null; source: string; isBuildNumber: boolean; resolved: InspectedBuild | null; note: string };
  drift: SchemaDriftReport[];
  /** README drift between the pinned and the latest build (null when not comparable: same build, or a README missing). */
  readmeDrift?: ReadmeDrift | null;
  unresolved: string[];
  nextSteps: string[];
  tokenPresent: boolean;
  checkedAt: string;
}

function pinSource(ctx: Pick<AppContext, 'secrets' | 'config'>): string {
  const src = ctx.secrets.sourceOf('APIFY_CONTENT_ACTOR_BUILD');
  if ((src === 'env' || src === 'secrets-file') && ctx.secrets.get('APIFY_CONTENT_ACTOR_BUILD')) return `env:APIFY_CONTENT_ACTOR_BUILD (${src})`;
  return ctx.config.research.apify.build ? 'site-config:research.apify.build' : 'unset';
}

/** Extract the input schema from a build, falling back to its OpenAPI definition. */
async function schemaFromBuild(ctx: AppContext, client: ApifyClient, build: ApifyBuild): Promise<{ schema: ActorInputSchema | null; source: 'build' | 'openapi' | 'unavailable'; problems: string[] }> {
  const problems: string[] = [];
  if (build.inputSchema !== null && build.inputSchema !== undefined) {
    try {
      return { schema: parseInputSchema(build.inputSchema, `build ${build.id} inputSchema`), source: 'build', problems };
    } catch (err) {
      problems.push((err as Error).message);
    }
  } else problems.push(`build ${build.id} has no inputSchema`);
  try {
    const doc = await loggedRead(ctx, 'apify.build.openapi', { buildId: build.id }, () => client.getBuildOpenApi(build.id));
    const detected = detectSchemaDocument(doc, `build ${build.id} openapi.json`);
    return { schema: detected.schema, source: 'openapi', problems };
  } catch (err) {
    problems.push(`OpenAPI definition unavailable: ${(err as Error).message}`);
  }
  return { schema: null, source: 'unavailable', problems };
}

/**
 * Inspect the configured actor with FREE reads only: live identity, pricing,
 * tagged builds, the latest build's input schema, and the pinned build's
 * schema. Stores tested schemas with their hash and reports drift.
 */
export async function inspectActor(ctx: AppContext, opts: { client?: ApifyClient; clientOptions?: Partial<ApifyClientOptions>; build?: string } = {}): Promise<InspectResult> {
  const actorId = ctx.settings.apify.actorId;
  if (ctx.offline) {
    throw new AppError('INTEGRATION_UNAVAILABLE', 'apify inspect needs network access (offline/demo mode is active).', { hint: 'Run without --offline in a live workspace, or import an exported schema with `apify import-schema <file>`.' });
  }
  const client = opts.client ?? createApifyClient(ctx, opts.clientOptions);
  const now = ctx.clock.now();
  const checkedAt = now.toISOString();
  const unresolved: string[] = [];
  const nextSteps: string[] = [];

  const actor = await loggedRead(ctx, 'apify.actor.get', { actorId }, () => client.getActor(actorId), (a) => a.id);
  const identityWarnings: string[] = [];
  if (actor.id !== actorId) identityWarnings.push(`Requested actor ${actorId} but the API returned ${actor.id}.`);
  if (actorId !== REDDIT_SCRAPER_ACTOR_ID) {
    identityWarnings.push(`Configured actor ${actorId} is not the authoritative Reddit Scraper actor ${REDDIT_SCRAPER_ACTOR_ID}; the Reddit adapter will refuse to run it (substitution needs owner approval).`);
  } else if (actor.username !== REDDIT_SCRAPER_LISTING.username || actor.name !== REDDIT_SCRAPER_LISTING.name) {
    identityWarnings.push(
      `Live identity is ${actor.username ?? '?'}/${actor.name ?? '?'} (listed as ${REDDIT_SCRAPER_LISTING.username}/${REDDIT_SCRAPER_LISTING.name}). The Actor ID stays authoritative; review the listing before running.`,
    );
  }
  if (actor.isDeprecated) identityWarnings.push('The actor is marked deprecated.');
  if (actor.notice && actor.notice !== 'NONE') identityWarnings.push(`Actor notice: ${actor.notice}`);

  const pricingSnap = pricingSnapshotFromActor(actor, now);
  const pricingRecord = pricingFromSnapshot(pricingSnap, now);
  const pricing = summarizePricing(pricingRecord);
  let pricingNote = pricingRecord
    ? 'Record in force = latest pricingInfos.startedAt <= now (inference; see integration-contracts). Tier mapping is unverified: estimates use the highest tier price.'
    : 'No parseable pricing record in force: paid runs will be refused until pricing is verified.';
  if (pricingRecord && pricingRecord.pricingModel !== 'PAY_PER_EVENT') pricingNote += ` Pricing model ${pricingRecord.pricingModel} is not supported by the estimator.`;

  const tagged = actor.taggedBuilds ?? {};
  const latestTag = tagged.latest ?? null;
  const pinned = opts.build ?? ctx.settings.apify.build;
  const pinnedIsNumber = isBuildNumber(pinned);

  const inspectBuild = async (buildId: string, tag: string | null): Promise<InspectedBuild> => {
    const problems: string[] = [];
    let build: ApifyBuild;
    try {
      build = await loggedRead(ctx, 'apify.build.get', { buildId }, () => client.getBuild(buildId), (b) => b.id);
    } catch (err) {
      return { buildId, buildNumber: null, tag, status: null, schemaSource: 'unavailable', schemaHash: null, storedRowId: null, created: false, verified: false, pinned: false, compatibility: null, outputSchema: null, problems: [`build fetch failed: ${(err as Error).message}`] };
    }
    const outFields = outputFieldsOf(build);
    const blockers: string[] = [];
    const outputSchema = outFields
      ? { fieldCount: outFields.length, missingUsedFields: DATASET_FIELDS.filter((f) => !outFields.includes(f)), missingRequired: missingRequiredOutputFields(outFields) }
      : null;
    if (outputSchema?.missingRequired.length) {
      blockers.push(
        `output schema drift: the dataset schema lacks required field(s) ${outputSchema.missingRequired.join(', ')}; the normalizer could not read its items, so runs of this build are refused`,
      );
    }
    if (outputSchema?.missingUsedFields.length) problems.push(`output schema lacks fields the normalizer reads: ${outputSchema.missingUsedFields.join(', ')}`);
    if (!outputSchema) problems.push('build publishes no dataset output schema; output fields are unconfirmed');
    const readme = typeof build.readme === 'string' && build.readme.trim() ? readmeProvenance(build.readme, now) : null;
    if (!readme) problems.push('build returned no README; its documentation (maxPostsCount semantics, RUN-SUMMARY fields, dedupe key) could not be reconfirmed');
    const provenance: BuildProvenance = {
      readme,
      outputSchema: outputSchema ? { checkedAt, fieldCount: outputSchema.fieldCount, missingRequired: outputSchema.missingRequired, missingUsed: outputSchema.missingUsedFields } : null,
    };
    const extracted = await schemaFromBuild(ctx, client, build);
    if (!extracted.schema) problems.push(...extracted.problems);
    if (!extracted.schema) {
      return { buildId, buildNumber: build.buildNumber ?? null, tag, status: build.status ?? null, schemaSource: 'unavailable', schemaHash: null, storedRowId: null, created: false, verified: false, pinned: false, compatibility: null, outputSchema, readme, blockers, problems };
    }
    const hash = inputSchemaHash(extracted.schema);
    let verified = build.status === 'SUCCEEDED';
    if (!verified) problems.push(`build status is ${build.status ?? 'unknown'}, not SUCCEEDED`);
    if (build.actId && build.actId !== actor.id) {
      verified = false;
      problems.push(`build belongs to actor ${build.actId}, not ${actor.id}`);
    }
    // Builds are immutable: a different schema for an already-verified build id is an anomaly.
    const prior = ctx.db.get<{ schema_hash: string }>(
      `SELECT schema_hash FROM apify_actor_schemas WHERE actor_id = ? AND build_id = ? AND verified = 1 AND source = 'api' ORDER BY fetched_at DESC LIMIT 1`,
      [actorId, build.id],
    );
    if (prior && prior.schema_hash !== hash) {
      verified = false;
      problems.push(`schema for immutable build ${build.id} changed since it was verified (hash ${prior.schema_hash.slice(0, 12)} -> ${hash.slice(0, 12)}); stored unverified`);
    }
    // Builds are immutable: a README that changed for the same build is reported (the new hash is stored).
    const priorProv = ctx.db.get<{ provenance_json: string | null }>(
      `SELECT provenance_json FROM apify_actor_schemas WHERE actor_id = ? AND build_id = ? AND provenance_json IS NOT NULL ORDER BY fetched_at DESC, rowid DESC LIMIT 1`,
      [actorId, build.id],
    );
    const priorReadme = parseProvenance(priorProv?.provenance_json)?.readme ?? null;
    if (priorReadme && readme && priorReadme.sha256 !== readme.sha256) {
      const d = diffReadmeProvenance({ build: build.buildNumber ?? null, readme: priorReadme }, { build: build.buildNumber ?? null, readme });
      problems.push(`README of build ${build.buildNumber ?? build.id} changed since ${priorReadme.retrievedAt}${d?.passagesChanged.length ? ` (load-bearing: ${d.passagesChanged.map((p) => p.label).join('; ')})` : ''}`);
    }
    const isPinned = pinnedIsNumber && build.buildNumber === pinned;
    const stored = storeActorSchema(ctx.db, {
      actorId,
      actorName: actor.username && actor.name ? `${actor.username}/${actor.name}` : (actor.name ?? null),
      buildId: build.id,
      buildNumber: build.buildNumber ?? null,
      buildTag: tag,
      schema: extracted.schema,
      pricing: pricingSnap,
      source: 'api',
      verified,
      pinned: isPinned,
      fetchedAt: checkedAt,
      provenance,
    });
    return {
      buildId: build.id,
      buildNumber: build.buildNumber ?? null,
      tag,
      status: build.status ?? null,
      schemaSource: extracted.source,
      schemaHash: hash,
      storedRowId: stored.row.id,
      created: stored.created,
      verified: stored.row.verified && verified,
      pinned: isPinned,
      compatibility: analyzeSchemaForAdapter(extracted.schema),
      outputSchema,
      readme,
      blockers,
      problems,
    };
  };

  let latestBuild: InspectedBuild | null = null;
  if (latestTag?.buildId) latestBuild = await inspectBuild(latestTag.buildId, 'latest');
  else unresolved.push('The actor reports no "latest" tagged build.');

  // Resolve the pinned build.
  let pinnedResolved: InspectedBuild | null = null;
  let pinnedNote = '';
  if (!pinned) {
    pinnedNote = 'No build is pinned. Runs are refused until a verified build number is pinned.';
    if (latestBuild?.verified && latestBuild.buildNumber) {
      nextSteps.push(`Review the schema above, then pin it: set research.apify.build: "${latestBuild.buildNumber}" in config/sites/${ctx.siteId}.yaml (or APIFY_CONTENT_ACTOR_BUILD=${latestBuild.buildNumber} in the workspace secrets file).`);
    }
  } else if (!pinnedIsNumber) {
    const t = tagged[pinned];
    pinnedNote = `"${pinned}" is not a build number${t?.buildNumber ? ` (tag currently -> ${t.buildNumber})` : ''}. Tags float between builds and are never treated as a pin.`;
    nextSteps.push(`Pin an immutable build number instead${t?.buildNumber ? `, e.g. research.apify.build: "${t.buildNumber}"` : ''}.`);
  } else if (latestBuild?.buildNumber === pinned) {
    // A copy: redact() renders repeated object references as "[Circular]" in CLI output.
    pinnedResolved = structuredClone(latestBuild);
    pinnedNote = 'The pinned build is the current latest build.';
  } else {
    let buildId: string | null = Object.values(tagged).find((t) => t?.buildNumber === pinned)?.buildId ?? null;
    buildId ??= ctx.db.get<{ build_id: string }>('SELECT build_id FROM apify_actor_schemas WHERE actor_id = ? AND build_number = ? AND build_id IS NOT NULL ORDER BY fetched_at DESC LIMIT 1', [actorId, pinned])?.build_id ?? null;
    if (!buildId) {
      try {
        const list = await loggedRead(ctx, 'apify.actor.builds.list', { actorId }, () => client.listBuilds(actorId, { limit: 1000, desc: true }));
        buildId = list.items.find((b) => b.buildNumber === pinned)?.id ?? null;
      } catch (err) {
        unresolved.push(`Could not list builds to resolve pinned build ${pinned} (builds-list endpoint is unverified): ${(err as Error).message}`);
      }
    }
    if (buildId) {
      pinnedResolved = await inspectBuild(buildId, null);
      pinnedNote = pinnedResolved.verified ? `Pinned build ${pinned} verified.` : `Pinned build ${pinned} could not be verified.`;
    } else {
      pinnedNote = `Pinned build ${pinned} could not be resolved to a build id.`;
      unresolved.push(pinnedNote);
      nextSteps.push(`If the build API is not accessible, export build ${pinned}'s input schema and run \`apify import-schema <file> --build ${pinned}\`.`);
    }
  }

  // Drift: compare the pinned schema with the latest build's schema.
  const drift: SchemaDriftReport[] = [];
  const pinnedRow = pinnedIsNumber ? findSchemaForBuild(ctx.db, actorId, pinned) : undefined;
  const latestRow = latestBuild?.storedRowId ? ctx.db.get<SchemaRow>('SELECT * FROM apify_actor_schemas WHERE id = ?', [latestBuild.storedRowId]) : undefined;
  if (pinnedRow && latestRow && latestRow.schema_hash && pinnedRow.schemaHash !== latestRow.schema_hash) {
    const next = fromRow(latestRow);
    const report: SchemaDriftReport = {
      fromBuild: pinnedRow.buildNumber,
      toBuild: next.buildNumber,
      fromHash: pinnedRow.schemaHash,
      toHash: next.schemaHash,
      diff: diffInputSchemas(pinnedRow.schema, next.schema),
      compatibility: analyzeSchemaForAdapter(next.schema),
      note: 'The newer build has a different input schema. Review the diff and adapter compatibility before changing the pin; the pinned build keeps running unchanged.',
    };
    drift.push(report);
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.schema_drift', subjectType: 'apify_actor', subjectId: actorId, details: { fromBuild: report.fromBuild, toBuild: report.toBuild, diff: report.diff }, at: now });
  } else if (!pinnedRow && latestBuild?.storedRowId) {
    // No pin yet: compare with the previously verified schema of another build, if any.
    const prev = ctx.db.get<SchemaRow>(
      `SELECT * FROM apify_actor_schemas WHERE actor_id = ? AND verified = 1 AND id != ? AND (build_id IS NOT ? OR build_id IS NULL) ORDER BY fetched_at DESC, rowid DESC LIMIT 1`,
      [actorId, latestBuild.storedRowId, latestBuild.buildId],
    );
    if (prev && latestRow?.schema_hash && prev.schema_hash !== latestRow.schema_hash) {
      const a = fromRow(prev);
      const b = fromRow(latestRow);
      drift.push({ fromBuild: a.buildNumber, toBuild: b.buildNumber, fromHash: a.schemaHash, toHash: b.schemaHash, diff: diffInputSchemas(a.schema, b.schema), compatibility: analyzeSchemaForAdapter(b.schema), note: 'Schema differs from the previously verified schema.' });
    }
  }
  // README drift: pinned build vs latest build (documentation the adapter depends on).
  let readmeDrift: ReadmeDrift | null = null;
  if (pinnedRow && latestRow && pinnedRow.id !== latestRow.id && pinnedRow.buildNumber !== latestRow.build_number) {
    readmeDrift = diffReadmeProvenance(
      { build: pinnedRow.buildNumber, readme: pinnedRow.provenance?.readme ?? null },
      { build: latestRow.build_number, readme: parseProvenance(latestRow.provenance_json)?.readme ?? null },
    );
    if (readmeDrift?.changed) {
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor: 'system',
        eventType: 'apify.readme_drift',
        subjectType: 'apify_actor',
        subjectId: actorId,
        details: { fromBuild: readmeDrift.fromBuild, toBuild: readmeDrift.toBuild, passagesChanged: readmeDrift.passagesChanged.map((p) => p.key) },
        at: now,
      });
    }
    if (!readmeDrift && pinnedRow.buildNumber && latestRow.build_number) {
      unresolved.push(`README drift between pinned build ${pinnedRow.buildNumber} and latest build ${latestRow.build_number} could not be checked (a README was not retrieved for one of them; re-run \`apify inspect --build ${pinnedRow.buildNumber}\`).`);
    }
  }
  for (const b of [latestBuild, pinnedResolved]) {
    for (const blocker of b?.blockers ?? []) {
      const line = `Build ${b!.buildNumber ?? b!.buildId}: ${blocker}.`;
      if (!unresolved.includes(line)) unresolved.push(line);
    }
  }
  if (pinnedResolved && !pinnedResolved.verified) unresolved.push(`Pinned build ${pinned} is not verified: ${pinnedResolved.problems.join('; ') || 'unknown reason'}`);
  if (latestBuild && latestBuild.schemaSource === 'unavailable') {
    unresolved.push(`Input schema of build ${latestBuild.buildNumber ?? latestBuild.buildId} is not accessible (${latestBuild.problems.join('; ')}).`);
    nextSteps.push('Export the actor input schema from the Apify console and run `apify import-schema <file> --build <number>`.');
  }
  if (!client.hasToken) nextSteps.push('APIFY_TOKEN is not set: reads worked without it, but runs need it (workspace secrets file, never chat).');

  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'apify.inspected',
    subjectType: 'apify_actor',
    subjectId: actorId,
    details: {
      latestBuild: latestBuild?.buildNumber ?? null,
      pinned: pinned ?? null,
      drift: drift.length,
      readmeDrift: readmeDrift ? { changed: readmeDrift.changed, passagesChanged: readmeDrift.passagesChanged.map((p) => p.key) } : null,
      latestReadmeSha256: latestBuild?.readme?.sha256 ?? null,
      unresolved: unresolved.length,
    },
    at: now,
  });

  return {
    actorId,
    identity: {
      id: actor.id,
      username: actor.username ?? null,
      name: actor.name ?? null,
      title: actor.title ?? null,
      isPublic: actor.isPublic ?? null,
      isDeprecated: actor.isDeprecated ?? null,
      notice: actor.notice ?? null,
      modifiedAt: actor.modifiedAt ?? null,
    },
    identityWarnings,
    pricing,
    pricingNote,
    latestBuild,
    pinnedBuild: { configured: pinned ?? null, source: pinSource(ctx), isBuildNumber: pinnedIsNumber, resolved: pinnedResolved, note: pinnedNote },
    drift,
    readmeDrift,
    unresolved,
    nextSteps,
    tokenPresent: client.hasToken,
    checkedAt,
  };
}

export interface ImportResult {
  status: 'attested' | 'unresolved';
  storedRowId: string;
  created: boolean;
  kind: string;
  actorId: string;
  buildNumber: string | null;
  schemaHash: string;
  propertyCount: number;
  verified: boolean;
  compatibility: AdapterSchemaAnalysis;
  detail: string;
  nextSteps: string[];
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Import an exported input schema (raw schema, build JSON, or build OpenAPI
 * document) when the build API cannot be used. Imported schemas are stored
 * UNVERIFIED (integration unresolved) unless the owner explicitly attests the
 * exact build number it came from.
 */
export function importActorSchema(ctx: AppContext, file: string, opts: { build?: string; attest?: boolean } = {}): ImportResult {
  const actorId = ctx.settings.apify.actorId;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new AppError('NOT_FOUND', `Schema file not found: ${file}`);
  }
  if (size > MAX_IMPORT_BYTES) throw new ValidationError(`Schema file is larger than ${MAX_IMPORT_BYTES} bytes; refusing to import.`);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ValidationError(`Schema file is not valid JSON: ${(err as Error).message}`);
  }
  const detected = detectSchemaDocument(doc, 'import file');
  if (detected.actorId && detected.actorId !== actorId) {
    throw new ValidationError(`The exported build belongs to actor ${detected.actorId}, not the configured actor ${actorId}.`);
  }
  const buildNumber = opts.build ?? detected.buildNumber;
  if (opts.build && detected.buildNumber && opts.build !== detected.buildNumber) {
    throw new ValidationError(`--build ${opts.build} does not match the build number in the file (${detected.buildNumber}).`);
  }
  if (buildNumber && !isBuildNumber(buildNumber)) throw new ValidationError(`"${buildNumber}" is not a build number such as 0.0.513.`);
  if (opts.attest && !buildNumber) throw new ValidationError('Attesting an imported schema requires the exact build number (--build <number>).');

  const now = ctx.clock.now();
  const pinned = ctx.settings.apify.build;
  const verified = !!opts.attest;
  const stored = storeActorSchema(ctx.db, {
    actorId,
    actorName: null,
    buildId: detected.buildId,
    buildNumber: buildNumber ?? null,
    buildTag: null,
    schema: detected.schema,
    pricing: null,
    source: 'import',
    verified,
    pinned: !!buildNumber && buildNumber === pinned,
    fetchedAt: now.toISOString(),
  });
  const compatibility = analyzeSchemaForAdapter(detected.schema);
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'cli',
    eventType: opts.attest ? 'apify.schema_imported_attested' : 'apify.schema_imported',
    subjectType: 'apify_actor_schema',
    subjectId: stored.row.id,
    details: redact({ file: file.split(/[\\/]/).pop(), kind: detected.kind, buildNumber: buildNumber ?? null, schemaHash: stored.row.schemaHash, attested: !!opts.attest }),
    at: now,
  });
  const nextSteps: string[] = [];
  if (!verified) {
    nextSteps.push('This schema is stored UNVERIFIED: runs stay refused. When network access to the build API works, run `apify inspect` to verify it.');
    nextSteps.push('If you exported it yourself from the exact build you intend to pin, re-run with `--build <number> --attest` (recorded in the audit log as owner attestation).');
  }
  if (!pinned && buildNumber) nextSteps.push(`Pin the build: research.apify.build: "${buildNumber}" in config/sites/${ctx.siteId}.yaml.`);
  if (!compatibility.ok) nextSteps.push(`The adapter cannot run this schema: ${compatibility.errors.join(' ')}`);
  return {
    status: verified ? 'attested' : 'unresolved',
    storedRowId: stored.row.id,
    created: stored.created,
    kind: detected.kind,
    actorId,
    buildNumber: buildNumber ?? null,
    schemaHash: stored.row.schemaHash,
    propertyCount: Object.keys(detected.schema.properties).length,
    verified,
    compatibility,
    detail: verified
      ? `Imported schema attested by the owner for build ${buildNumber}. Pricing is not part of an import; run \`apify inspect\` to retrieve verified pricing before paid runs.`
      : 'Integration unresolved: the imported schema is not verified against a live build.',
    nextSteps,
  };
}

export type RunnableSchema =
  | { ok: true; actorId: string; build: string; row: StoredActorSchema }
  | { ok: false; state: 'misconfigured' | 'disabled'; detail: string; nextStep: string };

/** The stored, verified schema of the pinned build, or an actionable reason why runs are refused. */
export function resolveRunnableSchema(ctx: Pick<AppContext, 'db' | 'settings' | 'siteId'>): RunnableSchema {
  const actorId = ctx.settings.apify.actorId;
  if (actorId !== REDDIT_SCRAPER_ACTOR_ID) {
    return {
      ok: false,
      state: 'misconfigured',
      detail: `Configured actor ${actorId} is not the authoritative Reddit Scraper actor ${REDDIT_SCRAPER_ACTOR_ID}. The adapter never substitutes another actor.`,
      nextStep: `Restore research.apify.actorId / APIFY_CONTENT_ACTOR_ID to ${REDDIT_SCRAPER_ACTOR_ID}; a different actor needs owner approval and its own adapter.`,
    };
  }
  const build = ctx.settings.apify.build;
  if (!build) {
    return { ok: false, state: 'misconfigured', detail: 'No Apify build is pinned; unpinned builds are never run.', nextStep: `Run \`apify inspect\`, review the schema, then set research.apify.build in config/sites/${ctx.siteId}.yaml.` };
  }
  if (!isBuildNumber(build)) {
    return { ok: false, state: 'misconfigured', detail: `Pinned build "${build}" is a tag, not an immutable build number; tags are never run.`, nextStep: 'Pin a build number such as 0.0.513 (see `apify inspect`).' };
  }
  const row = findSchemaForBuild(ctx.db, actorId, build);
  if (!row) {
    return { ok: false, state: 'misconfigured', detail: `No stored input schema for pinned build ${build}.`, nextStep: 'Run `apify inspect` (free read) to retrieve and verify it, or `apify import-schema <file> --build <number>`.' };
  }
  if (!row.verified) {
    return {
      ok: false,
      state: 'misconfigured',
      detail: `The stored schema for build ${build} is not verified (${row.source === 'import' ? 'imported, unresolved' : 'verification failed or schema drift for an immutable build'}).`,
      nextStep: 'Run `apify inspect` to verify it against the build API, or re-import with --attest if you exported it from exactly this build.',
    };
  }
  const missingOut = row.provenance?.outputSchema?.missingRequired ?? [];
  if (missingOut.length) {
    return {
      ok: false,
      state: 'misconfigured',
      detail: `Output schema drift: the dataset schema of pinned build ${build} lacks required field(s) ${missingOut.join(', ')} (checked ${row.provenance!.outputSchema!.checkedAt}); the normalizer could not read its items, so no paid run is started.`,
      nextStep: 'Run `apify inspect`, review the output fields, and pin a build whose dataset schema has dataType, id, title/body, postUrl/url, and createdAt (or update the adapter first).',
    };
  }
  return { ok: true, actorId, build, row };
}
