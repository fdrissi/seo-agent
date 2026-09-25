/**
 * PageSpeed Insights v5 `runPagespeed` adapter (lab data; legacy field data).
 * Contract: docs/integration-contracts.md section 5 (verified 2026-09-24).
 *
 * - GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed
 *   ?url=&strategy=MOBILE|DESKTOP&category=PERFORMANCE[&category=...][&locale=][&key=]
 *   `strategy` is always sent (the documented default is desktop).
 * - `key` is documented as optional, but a keyless call was observed returning
 *   HTTP 429 RESOURCE_EXHAUSTED (quota 0) on 2026-09-24; configure PAGESPEED_API_KEY.
 * - Lab data = `lighthouseResult` (scores 0-1, audits numericValue). A
 *   `runtimeError` means the lab result must be discarded.
 * - Field data: `loadingExperience` is page-level unless `origin_fallback` is
 *   true (then it holds origin data); `originLoadingExperience` is origin-level;
 *   missing `metrics` means no field data. Google plans to remove CrUX data
 *   from PSI: the CrUX API adapter (crux.ts) is the primary field source.
 * - INP is a field metric. It is NEVER derived from a lab load; TBT is only a
 *   lab proxy and is labelled as such.
 * - A Lighthouse score is a lab diagnostic, not a business outcome or a
 *   ranking explanation.
 */

export const PSI_ENDPOINT = 'https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed';
export const PSI_PARSER_VERSION = 'psi-v5-parser@1';
export const LIGHTHOUSE_DISCLAIMER = 'Lighthouse lab data from a single emulated load. It is a diagnostic, not a business outcome or a guaranteed ranking explanation.';
export const INP_LAB_NOTE = 'INP is a field (real-user) metric and is not measured by a lab load; see field data. Total Blocking Time is only a lab proxy.';

export type PsiStrategy = 'MOBILE' | 'DESKTOP';
export type PsiCategory = 'PERFORMANCE' | 'ACCESSIBILITY' | 'BEST_PRACTICES' | 'SEO';

export interface PsiRequest {
  url: string;
  strategy: PsiStrategy;
  categories?: readonly PsiCategory[];
  locale?: string | null;
  apiKey?: string | null;
}

/** Build the request URL. The key is appended last; never log the returned string (redaction masks key=). */
export function buildPsiUrl(req: PsiRequest, endpoint = PSI_ENDPOINT): string {
  const u = new URL(endpoint);
  u.searchParams.set('url', req.url);
  u.searchParams.set('strategy', req.strategy);
  for (const c of req.categories?.length ? req.categories : (['PERFORMANCE'] as const)) u.searchParams.append('category', c);
  if (req.locale) u.searchParams.set('locale', req.locale);
  if (req.apiKey) u.searchParams.set('key', req.apiKey);
  return u.toString();
}

export interface PsiFieldMetric {
  key: string;
  percentile: number | null;
  category: string | null;
  distributions: Array<{ min: number | null; max: number | null; proportion: number }>;
  /** Whether the metric key name is confirmed by official PSI docs. */
  keyVerified: boolean;
  note?: string;
}

export interface PsiFieldData {
  scope: 'page' | 'origin' | 'unavailable';
  source: 'loadingExperience' | 'originLoadingExperience' | null;
  id: string | null;
  overallCategory: string | null;
  originFallback: boolean;
  metrics: Record<string, PsiFieldMetric>;
  reason: string | null;
}

export interface PsiLabData {
  status: 'ok' | 'runtime_error' | 'missing';
  performanceScore: number | null;
  categories: Record<string, number | null>;
  metrics: {
    firstContentfulPaintMs: number | null;
    largestContentfulPaintMs: number | null;
    totalBlockingTimeMs: number | null;
    cumulativeLayoutShift: number | null;
    speedIndexMs: number | null;
    timeToInteractiveMs: number | null;
    serverResponseTimeMs: number | null;
  };
  /** Always null: INP cannot be measured by a lab load. */
  inp: null;
  inpNote: string;
  runWarnings: string[];
  runtimeError: { code: string | null; message: string | null } | null;
  formFactor: string | null;
  lighthouseVersion: string | null;
  fetchTime: string | null;
  disclaimer: string;
}

export interface ParsedPsi {
  requestedUrl: string | null;
  finalUrl: string | null;
  analysisUTCTimestamp: string | null;
  strategy: PsiStrategy;
  lighthouseVersion: string | null;
  captchaResult: string | null;
  lab: PsiLabData;
  field: { page: PsiFieldData; origin: PsiFieldData; best: 'page' | 'origin' | 'unavailable' };
  parserVersion: string;
}

/** Keys named in official PSI docs; others come from secondary sources (unverified). */
const VERIFIED_FIELD_KEYS = new Set(['FIRST_CONTENTFUL_PAINT_MS', 'FIRST_INPUT_DELAY_MS', 'INTERACTION_TO_NEXT_PAINT']);

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseFieldMetrics(metrics: Record<string, unknown>): Record<string, PsiFieldMetric> {
  const out: Record<string, PsiFieldMetric> = {};
  for (const [key, raw] of Object.entries(metrics)) {
    const m = obj(raw);
    if (!m) continue;
    const dists = Array.isArray(m.distributions) ? m.distributions : [];
    const metric: PsiFieldMetric = {
      key,
      percentile: num(m.percentile),
      category: str(m.category),
      distributions: dists.map((d) => {
        const o = obj(d) ?? {};
        return { min: num(o.min), max: num(o.max), proportion: num(o.proportion) ?? 0 };
      }),
      keyVerified: VERIFIED_FIELD_KEYS.has(key),
    };
    if (!metric.keyVerified) metric.note = 'Metric key not confirmed in official PSI docs (unverified).';
    if (key === 'CUMULATIVE_LAYOUT_SHIFT_SCORE') metric.note = 'Unverified key; percentile scale (possibly CLS x 100) is undocumented. Use CrUX API CLS instead.';
    out[key] = metric;
  }
  return out;
}

function parseLoadingExperience(v: unknown, source: 'loadingExperience' | 'originLoadingExperience'): { present: boolean; data: Omit<PsiFieldData, 'scope' | 'reason'> } {
  const le = obj(v);
  const metrics = le ? obj(le.metrics) : null;
  const present = !!metrics && Object.keys(metrics).length > 0;
  return {
    present,
    data: {
      source: present ? source : null,
      id: le ? str(le.id) : null,
      overallCategory: le ? str(le.overall_category) : null,
      originFallback: le?.origin_fallback === true,
      metrics: present ? parseFieldMetrics(metrics!) : {},
    },
  };
}

function unavailable(reason: string): PsiFieldData {
  return { scope: 'unavailable', source: null, id: null, overallCategory: null, originFallback: false, metrics: {}, reason };
}

/** Separate page-level, origin-level, and unavailable field data. Pure. */
export function parsePsiField(response: unknown): ParsedPsi['field'] {
  const r = obj(response) ?? {};
  const le = parseLoadingExperience(r.loadingExperience, 'loadingExperience');
  const ole = parseLoadingExperience(r.originLoadingExperience, 'originLoadingExperience');
  let page: PsiFieldData;
  let origin: PsiFieldData;
  if (le.present && !le.data.originFallback) page = { ...le.data, scope: 'page', reason: null };
  else if (le.present && le.data.originFallback) page = unavailable('No page-level field data: PSI fell back to origin-level data (origin_fallback = true).');
  else page = unavailable('No page-level field data in the response (loadingExperience has no metrics).');
  if (ole.present) origin = { ...ole.data, scope: 'origin', reason: null };
  else if (le.present && le.data.originFallback) origin = { ...le.data, scope: 'origin', reason: 'Origin data taken from loadingExperience (origin_fallback = true).' };
  else origin = unavailable('No origin-level field data in the response.');
  const best = page.scope === 'page' ? 'page' : origin.scope === 'origin' ? 'origin' : 'unavailable';
  return { page, origin, best };
}

function auditValue(audits: Record<string, unknown> | null, id: string): number | null {
  const a = audits ? obj(audits[id]) : null;
  return a ? num(a.numericValue) : null;
}

export function parsePsiLab(response: unknown): PsiLabData {
  const r = obj(response) ?? {};
  const lr = obj(r.lighthouseResult);
  const base: PsiLabData = {
    status: 'missing',
    performanceScore: null,
    categories: {},
    metrics: {
      firstContentfulPaintMs: null,
      largestContentfulPaintMs: null,
      totalBlockingTimeMs: null,
      cumulativeLayoutShift: null,
      speedIndexMs: null,
      timeToInteractiveMs: null,
      serverResponseTimeMs: null,
    },
    inp: null,
    inpNote: INP_LAB_NOTE,
    runWarnings: [],
    runtimeError: null,
    formFactor: null,
    lighthouseVersion: null,
    fetchTime: null,
    disclaimer: LIGHTHOUSE_DISCLAIMER,
  };
  if (!lr) return base;
  const cats = obj(lr.categories) ?? {};
  for (const [k, v] of Object.entries(cats)) {
    const score = num(obj(v)?.score);
    base.categories[k] = score === null ? null : Math.round(score * 100);
  }
  base.performanceScore = base.categories.performance ?? null;
  const audits = obj(lr.audits);
  base.metrics = {
    firstContentfulPaintMs: auditValue(audits, 'first-contentful-paint'),
    largestContentfulPaintMs: auditValue(audits, 'largest-contentful-paint'),
    totalBlockingTimeMs: auditValue(audits, 'total-blocking-time'),
    cumulativeLayoutShift: auditValue(audits, 'cumulative-layout-shift'),
    speedIndexMs: auditValue(audits, 'speed-index'),
    timeToInteractiveMs: auditValue(audits, 'interactive'),
    serverResponseTimeMs: auditValue(audits, 'server-response-time'),
  };
  base.runWarnings = Array.isArray(lr.runWarnings) ? lr.runWarnings.map((w) => String(w)).slice(0, 20) : [];
  base.formFactor = str(obj(lr.configSettings)?.formFactor);
  base.lighthouseVersion = str(lr.lighthouseVersion);
  base.fetchTime = str(lr.fetchTime);
  const rt = obj(lr.runtimeError);
  if (rt && (rt.code || rt.message)) {
    base.runtimeError = { code: str(rt.code), message: str(rt.message) };
    base.status = 'runtime_error';
    // Discard numbers from a failed run (documented: the result may need to be discarded).
    base.performanceScore = null;
    for (const k of Object.keys(base.categories)) base.categories[k] = null;
    for (const k of Object.keys(base.metrics) as Array<keyof PsiLabData['metrics']>) base.metrics[k] = null;
  } else base.status = 'ok';
  return base;
}

export function parsePsiResponse(response: unknown, strategy: PsiStrategy): ParsedPsi {
  const r = obj(response) ?? {};
  const lab = parsePsiLab(response);
  const lr = obj(r.lighthouseResult);
  return {
    requestedUrl: lr ? str(lr.requestedUrl) : null,
    finalUrl: str(r.id) ?? (lr ? (str(lr.finalDisplayedUrl) ?? str(lr.finalUrl)) : null),
    analysisUTCTimestamp: str(r.analysisUTCTimestamp),
    strategy,
    lighthouseVersion: lab.lighthouseVersion,
    captchaResult: str(r.captchaResult),
    lab,
    field: parsePsiField(response),
    parserVersion: PSI_PARSER_VERSION,
  };
}

export interface GoogleApiError {
  code: number | null;
  status: string | null;
  message: string;
  reason: string | null;
}

/** Parse the standard Google API error shape. */
export function parseGoogleError(body: unknown, httpStatus: number): GoogleApiError {
  const e = obj(obj(body)?.error);
  const errors = Array.isArray(e?.errors) ? e!.errors : [];
  const details = Array.isArray(e?.details) ? e!.details : [];
  const reason = str(obj(errors[0])?.reason) ?? str(obj(details.find((d) => obj(d)?.reason))?.reason);
  return { code: num(e?.code) ?? httpStatus, status: str(e?.status), message: str(e?.message) ?? `HTTP ${httpStatus}`, reason };
}
