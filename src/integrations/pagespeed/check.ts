import type { AppContext } from '../../app/context.js';
import { sleep as defaultSleep } from '../../core/concurrency.js';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { parseRetryAfter } from '../../core/retry.js';
import { dateInZone } from '../../core/time.js';
import { recordAudit } from '../../database/audit.js';
import { json, parseJson } from '../../database/db.js';
import { redactString } from '../../security/redact.js';
import { configuredGscScope } from '../../seo/coverage.js';
import { normalizeUrl } from '../../seo/url.js';
import type { FetchLike } from '../types.js';
import { CRUX_ENDPOINT, CRUX_TOOL_VERSION, queryCruxWithFallback, type CruxFieldResult, type CruxFormFactor, type CruxQueryOutcome } from './crux.js';
import { buildPsiUrl, LIGHTHOUSE_DISCLAIMER, parseGoogleError, parsePsiResponse, PSI_ENDPOINT, PSI_PARSER_VERSION, type ParsedPsi, type PsiCategory, type PsiStrategy } from './psi.js';

/**
 * checkPerformance: explicit, cached performance check for ONE URL.
 *
 * - Runs only for a justified reason, which is ENFORCED and recorded:
 *   `priority_page` must be one of selectPriorityPages(); `material_change`
 *   needs crawl evidence (the latest two observations of the URL differ in
 *   content hash, status, or title, and no check ran since); `manual` needs a
 *   written justification. The reason and its evidence are stored in every
 *   performance_checks row, in the provider-request parameters, and in an
 *   audit event. Nothing iterates the whole site.
 * - Cache: one result per (source, url, device, UTC day). CrUX refreshes daily
 *   (~04:00 UTC), so a same-day repeat reuses the stored rows unless forced.
 *   A cached lab row whose Lighthouse run failed (runtimeError) is reported as
 *   a FAILED lab result, never as a good cached one.
 * - Stores separate performance_checks rows: psi_lab (lab), psi_field and
 *   crux_api (field, with field_scope page | origin | unavailable), each with
 *   device, timestamp, tool version, cache key, and a raw-response reference.
 * - Never invents INP from lab data; never presents a Lighthouse score as a
 *   business outcome. Missing data stays missing (null), never 0.
 * - PSI and CrUX are free Google APIs (no budget reservation), but every
 *   HTTP request is logged in provider_requests (the CrUX fallback chain logs
 *   one row per attempt).
 */

export type PerfDevice = 'mobile' | 'desktop';
export type PerfReason = 'priority_page' | 'material_change' | 'manual';

export interface CheckPerformanceOptions {
  device?: PerfDevice;
  reason: PerfReason;
  /** Written justification; REQUIRED for 'manual', recorded for every reason. */
  justification?: string;
  /** How many priority pages qualify for 'priority_page' (default 10). */
  priorityLimit?: number;
  force?: boolean;
  sources?: ReadonlyArray<'psi' | 'crux'>;
  categories?: readonly PsiCategory[];
  fetch?: FetchLike;
  psiEndpoint?: string;
  cruxEndpoint?: string;
  psiTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Allow URLs outside site.allowedHostnames (e.g. a competitor benchmark). Default false. */
  allowOtherHosts?: boolean;
}

export type SourceStatus = 'ok' | 'cached' | 'not_requested' | 'failed' | 'missing_credentials' | 'unavailable';

/** Why a performance check was allowed to run (persisted with the results). */
export interface PerfJustification {
  reason: PerfReason;
  detail: string;
  evidence: Record<string, unknown> | null;
}

export interface PerformanceCheckResult {
  status: 'ok' | 'partial' | 'cached' | 'failed' | 'disabled' | 'offline' | 'dry_run';
  url: string;
  device: PerfDevice;
  reason: PerfReason;
  justification: PerfJustification;
  cacheDay: string;
  lab: { status: SourceStatus; rowId: string | null; data: ParsedPsi['lab'] | null; checkedAt: string | null; error: string | null; analysisUTCTimestamp: string | null; finalUrl: string | null };
  psiField: { status: SourceStatus; rowId: string | null; scope: 'page' | 'origin' | 'unavailable' | null; data: ParsedPsi['field'] | null; error: string | null };
  crux: { status: SourceStatus; rowId: string | null; scope: 'page' | 'origin' | 'unavailable' | null; formFactor: CruxFormFactor | null; data: CruxFieldResult | null; error: string | null };
  notes: string[];
  plan?: { psiRequest: string | null; cruxRequest: string | null; keyConfigured: boolean };
  nextStep?: string;
  isSynthetic: boolean;
}

export const PERF_UTC_ZONE = 'UTC';

export function perfCacheKey(source: 'psi_lab' | 'psi_field' | 'crux_api', url: string, device: PerfDevice, day: string): string {
  return `${source}|${device}|${day}|${url}`;
}

interface PerfRow {
  id: string;
  metrics_json: string;
  field_scope: string | null;
  checked_at: string;
  device: string;
}

function cached(ctx: AppContext, key: string): PerfRow | undefined {
  return ctx.db.get<PerfRow>('SELECT id, metrics_json, field_scope, checked_at, device FROM performance_checks WHERE site_id = ? AND cache_key = ? ORDER BY checked_at DESC LIMIT 1', [ctx.siteId, key]);
}

/**
 * Applicable date range of an observation (migration 0201): the CrUX
 * collection period for crux_api rows; the UTC day of the run for psi_lab
 * rows; null for psi_field (PageSpeed Insights does not report the period of
 * its embedded field data: unknown, never guessed).
 */
export interface PerfDateRange {
  start: string | null;
  end: string | null;
}

function insertPerf(
  ctx: AppContext,
  input: {
    url: string;
    source: 'psi_lab' | 'psi_field' | 'crux_api';
    kind: 'lab' | 'field';
    scope: 'page' | 'origin' | 'unavailable' | null;
    device: string;
    metrics: unknown;
    toolVersion: string | null;
    cacheKey: string;
    rawRef: string | null;
    dateRange?: PerfDateRange;
  },
): string {
  const id = newId('perf');
  const checkedAt = ctx.clock.now().toISOString();
  const pageId = ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, input.url])?.id ?? null;
  // Grain (migration 0200): one observation per (site, url, source, device, checked_at); an identical-instant repeat is not a new one.
  const r = ctx.db.run(
    `INSERT INTO performance_checks (id, site_id, page_id, url, source, data_kind, field_scope, device, metrics_json, tool_version, cache_key, raw_ref, is_synthetic, checked_at, date_range_start, date_range_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, url, source, device, checked_at) DO NOTHING`,
    [
      id,
      ctx.siteId,
      pageId,
      input.url,
      input.source,
      input.kind,
      input.scope,
      input.device,
      json(input.metrics),
      input.toolVersion,
      input.cacheKey,
      input.rawRef,
      ctx.synthetic ? 1 : 0,
      checkedAt,
      input.dateRange?.start ?? null,
      input.dateRange?.end ?? null,
    ],
  );
  if (r.changes === 0) {
    return ctx.db.get<{ id: string }>('SELECT id FROM performance_checks WHERE site_id = ? AND url = ? AND source = ? AND device = ? AND checked_at = ?', [ctx.siteId, input.url, input.source, input.device, checkedAt])?.id ?? id;
  }
  return id;
}

/** UTC day of an ISO timestamp (or null). */
function utcDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function emptyResult(url: string, device: PerfDevice, justification: PerfJustification, day: string, isSynthetic: boolean): PerformanceCheckResult {
  return {
    status: 'ok',
    url,
    device,
    reason: justification.reason,
    justification,
    cacheDay: day,
    lab: { status: 'not_requested', rowId: null, data: null, checkedAt: null, error: null, analysisUTCTimestamp: null, finalUrl: null },
    psiField: { status: 'not_requested', rowId: null, scope: null, data: null, error: null },
    crux: { status: 'not_requested', rowId: null, scope: null, formFactor: null, data: null, error: null },
    notes: [LIGHTHOUSE_DISCLAIMER],
    isSynthetic,
  };
}

async function runPsi(
  ctx: AppContext,
  fetch: FetchLike,
  url: string,
  strategy: PsiStrategy,
  opts: CheckPerformanceOptions,
  apiKey: string | undefined,
  why: PerfJustification,
): Promise<{ ok: true; parsed: ParsedPsi; rawRef: string } | { ok: false; error: string; httpStatus: number | null; reason: string | null }> {
  const categories = opts.categories ?? ['PERFORMANCE'];
  const req = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'pagespeed', endpoint: 'psi.runPagespeed', method: 'GET', isPaid: false, params: { url, strategy, categories, reason: why.reason, justification: why.detail }, isSynthetic: ctx.synthetic });
  const reqUrl = buildPsiUrl({ url, strategy, categories, apiKey: apiKey ?? null }, opts.psiEndpoint ?? PSI_ENDPOINT);
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms));
  ctx.requests.markSubmitted(req.id);
  let lastError = 'unknown error';
  let lastStatus: number | null = null;
  let lastReason: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(reqUrl, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(opts.psiTimeoutMs ?? 90_000) });
    } catch (err) {
      lastError = redactString((err as Error).message ?? String(err));
      lastStatus = null;
      if (attempt < 2) {
        await sleep(2_000);
        continue;
      }
      break;
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) {
      const rawRef = ctx.raw.save({ siteId: ctx.siteId, provider: 'pagespeed', kind: `psi_${strategy.toLowerCase()}`, payload: body, at: ctx.clock.now() });
      ctx.requests.complete(req.id, { status: 'succeeded', httpStatus: res.status, rawRef });
      return { ok: true, parsed: parsePsiResponse(body, strategy), rawRef };
    }
    const e = parseGoogleError(body, res.status);
    lastError = e.message;
    lastStatus = res.status;
    lastReason = e.reason ?? e.status;
    const retryable = res.status === 429 || res.status >= 500;
    const quotaZero = res.status === 429 && !apiKey;
    if (retryable && !quotaZero && attempt < 2) {
      const wait = Math.min(parseRetryAfter(res.headers.get('retry-after')) ?? 5_000, 30_000);
      await sleep(wait);
      continue;
    }
    break;
  }
  ctx.requests.complete(req.id, { status: 'failed', httpStatus: lastStatus, error: { message: lastError, reason: lastReason } });
  return { ok: false, error: lastError, httpStatus: lastStatus, reason: lastReason };
}

const DEFAULT_PRIORITY_LIMIT = 10;

/**
 * Evidence that a URL changed materially between its two latest crawl
 * observations (content hash, HTTP status, or title), or null. Reads only
 * own-site crawl results for this site.
 */
export function detectMaterialChange(ctx: AppContext, url: string): Record<string, unknown> | null {
  const rows = ctx.db.all<{ id: string; crawl_id: string; content_hash: string | null; status_code: number; title: string | null; fetched_at: string }>(
    `SELECT cr.id, cr.crawl_id, cr.content_hash, cr.status_code, cr.title, cr.fetched_at
       FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id AND c.site_id = cr.site_id
      WHERE cr.site_id = ? AND cr.requested_url = ? AND c.kind IN ('own_site', 'single_page')
        AND cr.status_code IS NOT NULL AND cr.blocked_reason IS NULL
      ORDER BY cr.fetched_at DESC, cr.rowid DESC LIMIT 2`,
    [ctx.siteId, url],
  );
  if (rows.length < 2) return null;
  const [latest, previous] = rows as [(typeof rows)[number], (typeof rows)[number]];
  const changed: string[] = [];
  if ((latest.content_hash ?? '') !== (previous.content_hash ?? '')) changed.push('content_hash');
  if (latest.status_code !== previous.status_code) changed.push('status_code');
  if ((latest.title ?? '') !== (previous.title ?? '')) changed.push('title');
  if (!changed.length) return null;
  const snap = (r: (typeof rows)[number]) => ({ crawlId: r.crawl_id, resultId: r.id, fetchedAt: r.fetched_at, status: r.status_code, contentHash: r.content_hash, title: r.title });
  return { changed, previous: snap(previous), latest: snap(latest) };
}

/** Enforce the "priority pages or material changes only" rule. Throws VALIDATION_FAILED when not justified. */
export function justifyPerformanceCheck(ctx: AppContext, url: string, device: PerfDevice, opts: Pick<CheckPerformanceOptions, 'reason' | 'justification' | 'priorityLimit' | 'force'>): PerfJustification {
  const note = opts.justification?.trim() || null;
  const alternatives = 'Use --reason material_change after a crawl detected a change, or --reason manual --justification "<why>" for an explicit one-off check.';
  if (opts.reason === 'priority_page') {
    const limit = opts.priorityLimit ?? DEFAULT_PRIORITY_LIMIT;
    const hit = selectPriorityPages(ctx, limit).find((p) => p.url === url);
    if (!hit) {
      throw new AppError('VALIDATION_FAILED', `${url} is not one of this site's ${limit} priority pages (site root, protected pages, top pages by GSC clicks); see \`perf priority\`.`, { hint: alternatives });
    }
    return { reason: 'priority_page', detail: note ? `${hit.why}; ${note}` : hit.why, evidence: { priority: hit, priorityLimit: limit } };
  }
  if (opts.reason === 'material_change') {
    const evidence = detectMaterialChange(ctx, url);
    if (!evidence) {
      throw new AppError('VALIDATION_FAILED', `No material change recorded for ${url}: its two latest crawl observations do not differ in content, status, or title (or it was crawled fewer than twice).`, { hint: `Re-crawl the page first (\`crawl page <url>\`). ${alternatives}` });
    }
    const latestAt = (evidence.latest as { fetchedAt: string }).fetchedAt;
    const since = ctx.db.get<{ checked_at: string }>(
      "SELECT checked_at FROM performance_checks WHERE site_id = ? AND url = ? AND source = 'psi_lab' AND device = ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT 1",
      [ctx.siteId, url, device, latestAt],
    );
    // A same-day repeat is fine (it is served from the daily cache); a later day needs --force.
    if (since && !opts.force && dateInZone(new Date(since.checked_at), PERF_UTC_ZONE) !== dateInZone(ctx.clock.now(), PERF_UTC_ZONE)) {
      throw new AppError('VALIDATION_FAILED', `The change observed at ${latestAt} was already checked (${device}) at ${since.checked_at}.`, { hint: 'Pass --force to re-check anyway.' });
    }
    return { reason: 'material_change', detail: note ?? `changed: ${(evidence.changed as string[]).join(', ')}`, evidence };
  }
  if (!note) throw new AppError('VALIDATION_FAILED', 'A manual performance check needs a written justification (--justification "<why>").', { hint: 'Manual checks are explicit exceptions; priority pages and material changes do not need one.' });
  return { reason: 'manual', detail: note, evidence: null };
}

function overallStatus(result: PerformanceCheckResult, needPsi: boolean, needCrux: boolean): PerformanceCheckResult['status'] {
  const states = [needPsi ? result.lab.status : null, needCrux ? result.crux.status : null].filter((s): s is SourceStatus => s !== null);
  const good = states.filter((s) => s === 'ok' || s === 'cached' || s === 'unavailable').length;
  if (good === states.length) return states.every((s) => s === 'cached') ? 'cached' : 'ok';
  return good === 0 ? 'failed' : 'partial';
}

export async function checkPerformance(ctx: AppContext, rawUrl: string, opts: CheckPerformanceOptions): Promise<PerformanceCheckResult> {
  const n = normalizeUrl(rawUrl);
  if (!n) throw new AppError('VALIDATION_FAILED', `Not an http(s) URL: ${rawUrl}`);
  const url = n.url;
  if (!opts.allowOtherHosts && !ctx.config.site.allowedHostnames.map((h) => h.toLowerCase()).includes(n.host.toLowerCase())) {
    throw new AppError('VALIDATION_FAILED', `${n.host} is not one of this site's allowedHostnames; performance checks run for your own priority pages.`);
  }
  const device = opts.device ?? 'mobile';
  const strategy: PsiStrategy = device === 'mobile' ? 'MOBILE' : 'DESKTOP';
  const formFactor: CruxFormFactor = device === 'mobile' ? 'PHONE' : 'DESKTOP';
  const day = dateInZone(ctx.clock.now(), PERF_UTC_ZONE);
  const sources = new Set(opts.sources ?? ['psi', 'crux']);
  const apiKey = ctx.secrets.get('PAGESPEED_API_KEY');

  if (!ctx.settings.features.pagespeed) {
    const notEvaluated: PerfJustification = { reason: opts.reason, detail: 'not evaluated: performance checks are disabled', evidence: null };
    return { ...emptyResult(url, device, notEvaluated, day, ctx.synthetic), status: 'disabled', notes: ['Performance checks are disabled (features.pagespeed: false).'], nextStep: 'Set features.pagespeed: true in the site config (and configure PAGESPEED_API_KEY).' };
  }
  // Every check must be justified (priority page / material change / written manual reason); throws otherwise.
  const why = justifyPerformanceCheck(ctx, url, device, opts);
  const result = emptyResult(url, device, why, day, ctx.synthetic);
  if (ctx.dryRun) {
    return {
      ...result,
      status: 'dry_run',
      plan: {
        psiRequest: sources.has('psi') ? buildPsiUrl({ url, strategy, categories: opts.categories ?? ['PERFORMANCE'] }, opts.psiEndpoint ?? PSI_ENDPOINT) : null,
        cruxRequest: sources.has('crux') ? `POST ${opts.cruxEndpoint ?? CRUX_ENDPOINT} {url, formFactor: ${formFactor}} -> origin fallbacks` : null,
        keyConfigured: !!apiKey,
      },
      notes: ['Dry run: no requests were made and nothing was written.', ...result.notes],
    };
  }

  // Cache lookups (per source, url, device, UTC day).
  const keys = { lab: perfCacheKey('psi_lab', url, device, day), psiField: perfCacheKey('psi_field', url, device, day), crux: perfCacheKey('crux_api', url, device, day) };
  const needPsi = sources.has('psi');
  const needCrux = sources.has('crux');
  let labFromCache = false;
  let cruxFromCache = false;
  if (!opts.force) {
    if (needPsi) {
      const lab = cached(ctx, keys.lab);
      const field = cached(ctx, keys.psiField);
      if (lab) {
        labFromCache = true;
        const data = parseJson<(ParsedPsi['lab'] & { finalUrl?: string | null; analysisUTCTimestamp?: string | null }) | null>(lab.metrics_json, null);
        const labOk = data?.status === 'ok';
        const rt = data?.runtimeError ?? null;
        result.lab = {
          // A stored failed Lighthouse run is served as a failure, never as a good cached result.
          status: labOk ? 'cached' : 'failed',
          rowId: lab.id,
          data,
          checkedAt: lab.checked_at,
          error: labOk
            ? null
            : `Today's stored lab run did not produce usable data (${data?.status ?? 'unknown'}${rt ? `: Lighthouse runtime error ${rt.code ?? ''} ${rt.message ?? ''}`.trimEnd() : ''}); pass --force to re-run.`,
          analysisUTCTimestamp: data?.analysisUTCTimestamp ?? null,
          finalUrl: data?.finalUrl ?? null,
        };
      }
      if (field) result.psiField = { status: 'cached', rowId: field.id, scope: field.field_scope as 'page' | 'origin' | 'unavailable', data: parseJson(field.metrics_json, null), error: null };
    }
    if (needCrux) {
      const c = cached(ctx, keys.crux);
      if (c) {
        cruxFromCache = true;
        result.crux = { status: 'cached', rowId: c.id, scope: c.field_scope as 'page' | 'origin' | 'unavailable', formFactor: null, data: parseJson(c.metrics_json, null), error: null };
      }
    }
  }
  const psiCached = !needPsi || labFromCache;
  const cruxCached = !needCrux || cruxFromCache;
  if (psiCached && cruxCached) {
    result.status = overallStatus(result, needPsi, needCrux);
    result.notes.push(`Reused today's (${day} UTC) stored results; pass --force to re-run.`);
    return result;
  }
  if (ctx.offline) {
    return { ...result, status: labFromCache || cruxFromCache ? 'partial' : 'offline', notes: [...result.notes, 'Network access is disabled (offline/demo mode); no performance requests were made.'] };
  }
  const fetch = opts.fetch ?? ctx.fetch;
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'perf.check_requested',
    subjectType: 'url',
    subjectId: url,
    details: { device, sources: [...sources], force: !!opts.force, justification: why },
    at: ctx.clock.now(),
  });

  if (needPsi && !psiCached) {
    if (!apiKey) result.notes.push('PAGESPEED_API_KEY is not set. PSI documents keyless use, but keyless calls were observed failing with HTTP 429 (quota 0); a key is recommended.');
    const psi = await runPsi(ctx, fetch, url, strategy, opts, apiKey, why);
    if (psi.ok) {
      const p = psi.parsed;
      const labMetrics = { ...p.lab, strategy, finalUrl: p.finalUrl, analysisUTCTimestamp: p.analysisUTCTimestamp, captchaResult: p.captchaResult, parserVersion: PSI_PARSER_VERSION, justification: why };
      const labDay = utcDay(p.analysisUTCTimestamp) ?? day;
      const labRow = insertPerf(ctx, { url, source: 'psi_lab', kind: 'lab', scope: null, device, metrics: labMetrics, toolVersion: p.lighthouseVersion ? `lighthouse ${p.lighthouseVersion}` : null, cacheKey: keys.lab, rawRef: psi.rawRef, dateRange: { start: labDay, end: labDay } });
      result.lab = { status: p.lab.status === 'ok' ? 'ok' : 'failed', rowId: labRow, data: p.lab, checkedAt: ctx.clock.now().toISOString(), error: p.lab.runtimeError ? `Lighthouse runtime error ${p.lab.runtimeError.code ?? ''}: ${p.lab.runtimeError.message ?? ''}`.trim() : null, analysisUTCTimestamp: p.analysisUTCTimestamp, finalUrl: p.finalUrl };
      const fieldMetrics = {
        best: p.field.best,
        page: p.field.page,
        origin: p.field.origin,
        strategy,
        analysisUTCTimestamp: p.analysisUTCTimestamp,
        note: 'Field data embedded in PSI (legacy; Google plans to remove it). Prefer crux_api rows. PSI does not report the collection period of this field data (date range unknown).',
        parserVersion: PSI_PARSER_VERSION,
        justification: why,
      };
      const fieldRow = insertPerf(ctx, { url, source: 'psi_field', kind: 'field', scope: p.field.best, device, metrics: fieldMetrics, toolVersion: 'psi-v5', cacheKey: keys.psiField, rawRef: psi.rawRef, dateRange: { start: null, end: null } });
      result.psiField = { status: p.field.best === 'unavailable' ? 'unavailable' : 'ok', rowId: fieldRow, scope: p.field.best, data: p.field, error: null };
      result.notes.push('INP is never derived from the lab load; see field data for INP.');
    } else {
      result.lab = { ...result.lab, status: 'failed', error: `PSI ${psi.httpStatus ?? 'network'} error: ${psi.error}` };
      result.psiField = { ...result.psiField, status: 'failed', error: 'PSI request failed; no field data from PSI.' };
      if (psi.httpStatus === 429) result.nextStep = apiKey ? 'PSI quota exhausted; wait for the quota to reset.' : 'Create a Google Cloud API key with the PageSpeed Insights API enabled and set PAGESPEED_API_KEY in the workspace secrets file.';
      if (psi.httpStatus === 400 || psi.httpStatus === 403) result.nextStep = 'Check that PAGESPEED_API_KEY is valid and the PageSpeed Insights API is enabled for its project.';
    }
  }

  if (needCrux && !cruxCached) {
    if (!apiKey) {
      result.crux = { ...result.crux, status: 'missing_credentials', scope: 'unavailable', error: 'The CrUX API requires an API key (PAGESPEED_API_KEY with the Chrome UX Report API enabled). Field data unavailable from CrUX.' };
      result.nextStep ??= 'Set PAGESPEED_API_KEY (a Google Cloud API key with the Chrome UX Report API and PageSpeed Insights API enabled).';
    } else {
      // One provider_requests row per HTTP attempt of the fallback chain (up to three).
      const onAttempt = (a: { level: 'page' | 'origin'; formFactor: CruxFormFactor | null; query: Record<string, unknown> }) => {
        const req = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'crux', endpoint: 'crux.queryRecord', method: 'POST', isPaid: false, params: { ...a.query, level: a.level, reason: why.reason, justification: why.detail }, isSynthetic: ctx.synthetic });
        ctx.requests.markSubmitted(req.id);
        return (outcome: CruxQueryOutcome) => {
          if (outcome.status === 'error') ctx.requests.complete(req.id, { status: 'failed', httpStatus: outcome.httpStatus, error: { message: outcome.message, reason: outcome.reason, level: a.level } });
          // 404 NOT_FOUND is a valid "insufficient data" answer, not a failed request.
          else ctx.requests.complete(req.id, { status: 'succeeded', httpStatus: outcome.httpStatus });
        };
      };
      const cr = await queryCruxWithFallback(fetch, apiKey, url, formFactor, { ...(opts.cruxEndpoint ? { endpoint: opts.cruxEndpoint } : {}), onAttempt });
      const rawRef = ctx.raw.save({ siteId: ctx.siteId, provider: 'crux', kind: 'query_record', payload: { attempts: cr.attempts, body: cr.lastBody }, at: ctx.clock.now() });
      if (cr.error) {
        result.crux = { ...result.crux, status: 'failed', data: cr, error: cr.reason };
        if (cr.error.httpStatus === 400 || cr.error.httpStatus === 403) result.nextStep ??= 'Enable the Chrome UX Report API for the project that owns PAGESPEED_API_KEY and check the key restrictions.';
      } else {
        const cruxDevice = cr.scope === 'unavailable' ? (formFactor === 'PHONE' ? 'phone' : 'desktop') : cr.formFactor === null ? 'all' : cr.formFactor === 'PHONE' ? 'phone' : cr.formFactor === 'TABLET' ? 'tablet' : 'desktop';
        const metrics = {
          scope: cr.scope,
          formFactor: cr.formFactor,
          record: cr.record,
          cwvAssessment: cr.record?.cwvAssessment ?? null,
          attempts: cr.attempts,
          reason: cr.reason,
          note: 'Rolling 28-day real-user data (Chrome UX Report). Origin-level data describes the whole origin, not this page.',
          justification: why,
        };
        const period = cr.record?.collectionPeriod ?? null;
        const row = insertPerf(ctx, {
          url,
          source: 'crux_api',
          kind: 'field',
          scope: cr.scope,
          device: cruxDevice,
          metrics,
          toolVersion: CRUX_TOOL_VERSION,
          cacheKey: keys.crux,
          rawRef,
          dateRange: { start: period?.firstDate ?? null, end: period?.lastDate ?? null },
        });
        result.crux = { status: cr.scope === 'unavailable' ? 'unavailable' : 'ok', rowId: row, scope: cr.scope, formFactor: cr.formFactor, data: cr, error: null };
        if (cr.scope === 'origin') result.notes.push('CrUX had no page-level data; the recorded field data is ORIGIN-level.');
        if (cr.scope === 'unavailable') result.notes.push('CrUX field data unavailable (insufficient real-user samples).');
      }
    }
  }

  const status = overallStatus(result, needPsi, needCrux);
  result.status = status === 'cached' ? 'ok' : status;
  return result;
}

/**
 * Priority pages for performance checks: the site root, protected pages, and
 * the top pages by Google organic clicks over the latest 28 days of current
 * GSC rows (when GSC data exists) of the configured property and its primary
 * search type, unsegmented rows only (never summed across properties,
 * search types, or country/device segments). Never the whole site.
 */
export function selectPriorityPages(ctx: AppContext, limit = 5): Array<{ url: string; why: string }> {
  const out: Array<{ url: string; why: string }> = [];
  const add = (url: string, why: string) => {
    const n = normalizeUrl(url)?.url;
    if (n && !out.some((o) => o.url === n) && out.length < limit) out.push({ url: n, why });
  };
  add(ctx.config.site.url, 'site root');
  for (const p of ctx.db.all<{ url: string }>('SELECT url FROM pages WHERE site_id = ? AND is_protected = 1 ORDER BY url LIMIT ?', [ctx.siteId, limit])) add(p.url, 'protected page');
  const scope = configuredGscScope(ctx.config);
  if (!scope) return out; // no Search Console property configured: root + protected pages only
  try {
    const top = ctx.db.all<{ page: string; clicks: number }>(
      `SELECT page, SUM(clicks) AS clicks FROM gsc_page_daily
        WHERE site_id = ? AND property = ? AND search_type = ? AND is_current = 1 AND segment_key = ''
          AND date >= (SELECT date(MAX(date), '-27 days') FROM gsc_page_daily WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_current = 1)
        GROUP BY page ORDER BY clicks DESC, page ASC LIMIT ?`,
      [ctx.siteId, scope.property, scope.searchType, ctx.siteId, scope.property, scope.searchType, limit],
    );
    for (const t of top) add(t.page, `top page by GSC clicks (${t.clicks})`);
  } catch {
    /* GSC tables unavailable: root + protected pages only */
  }
  return out;
}
