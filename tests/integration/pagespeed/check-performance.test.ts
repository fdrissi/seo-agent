import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPerformance, perfCacheKey, selectPriorityPages } from '../../../src/integrations/pagespeed/check.js';
import { cruxStatus, pagespeedStatus, performanceStatuses } from '../../../src/integrations/pagespeed/status.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { fakeFetch, jsonResponse, type Route } from '../../helpers/fake-fetch.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/pagespeed');
const load = (f: string): unknown => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
const KEY = 'AIzaSyTESTONLYFAKEKEY000000000000000000';
const URL_ = 'https://www.example.test/pricing';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function make(opts: { pagespeed?: boolean; key?: boolean; routes?: Route[]; offline?: boolean; dryRun?: boolean; property?: string } = {}) {
  const f = fakeFetch(opts.routes ?? []);
  ctx = createTestContext({
    config: testSiteConfig({ features: { pagespeed: opts.pagespeed ?? true }, ...(opts.property ? { google: { searchConsoleProperty: opts.property } } : {}) }),
    ...(opts.key === false ? {} : { secrets: { PAGESPEED_API_KEY: KEY } }),
    ...(opts.offline ? {} : { fetch: f }),
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  return { c: ctx, f };
}

const psiRoute = (file = 'psi-page-level.json', status = 200): Route => (req) => (req.url.startsWith('https://pagespeedonline.googleapis.com/') ? jsonResponse(load(file), status) : undefined);
const cruxRoute = (handler: (body: Record<string, unknown>) => Response): Route => (req) => (req.url.startsWith('https://chromeuxreport.googleapis.com/') ? handler(JSON.parse(req.body!)) : undefined);
const cruxPageOk = cruxRoute(() => jsonResponse(load('crux-url-phone.json')));
const MANUAL = { reason: 'manual', justification: 'synthetic test: explicit one-off check' } as const;

/** Mark a URL as a protected (priority) page. */
function protect(c: TestContext, url: string): void {
  const u = new URL(url);
  c.db.run("INSERT INTO pages (id, site_id, url, host, path, first_source, is_protected, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'config', 1, ?, ?)", [`page_${u.pathname}`, c.siteId, url, u.hostname, u.pathname, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
}

/** Two synthetic crawl observations of a URL (different content hash unless `same`). */
function seedObservations(c: TestContext, url: string, opts: { same?: boolean; at?: [string, string] } = {}): void {
  const [t1, t2] = opts.at ?? ['2026-09-20T10:00:00.000Z', '2026-09-23T10:00:00.000Z'];
  for (const [i, at] of [t1, t2].entries()) {
    c.db.run("INSERT INTO crawls (id, site_id, kind, status, is_synthetic, started_at, finished_at) VALUES (?, ?, 'own_site', 'completed', 1, ?, ?)", [`crawl_${i}`, c.siteId, at, at]);
    c.db.run('INSERT INTO crawl_results (id, crawl_id, site_id, requested_url, status_code, fetched_at, title, content_hash) VALUES (?, ?, ?, ?, 200, ?, ?, ?)', [
      `cres_${i}`,
      `crawl_${i}`,
      c.siteId,
      url,
      at,
      'Synthetic page',
      opts.same || i === 0 ? 'hash_a' : 'hash_b',
    ]);
  }
}

describe('checkPerformance', () => {
  it('stores separate lab and field rows with scope, device, timestamp, and tool version', async () => {
    const { c, f } = make({ routes: [psiRoute(), cruxPageOk] });
    protect(c, URL_);
    const r = await checkPerformance(c, URL_, { reason: 'priority_page' });
    expect(r.status).toBe('ok');
    expect(r.justification).toMatchObject({ reason: 'priority_page', detail: 'protected page' });
    expect(r.lab.status).toBe('ok');
    expect(r.lab.data!.performanceScore).toBe(87);
    expect(r.lab.data!.inp).toBeNull();
    expect(r.psiField.scope).toBe('page');
    expect(r.crux).toMatchObject({ status: 'ok', scope: 'page', formFactor: 'PHONE' });
    expect(r.notes.join(' ')).toMatch(/not a business outcome/);
    expect(r.notes.join(' ')).toMatch(/INP is never derived from the lab load/);

    const rows = c.db.all<{ source: string; data_kind: string; field_scope: string | null; device: string; tool_version: string | null; cache_key: string; raw_ref: string | null; checked_at: string; metrics_json: string; is_synthetic: number }>(
      'SELECT * FROM performance_checks WHERE site_id = ? ORDER BY source',
      [c.siteId],
    );
    expect(rows.map((x) => [x.source, x.data_kind, x.field_scope, x.device])).toEqual([
      ['crux_api', 'field', 'page', 'phone'],
      ['psi_field', 'field', 'page', 'mobile'],
      ['psi_lab', 'lab', null, 'mobile'],
    ]);
    expect(rows.find((x) => x.source === 'psi_lab')!.tool_version).toBe('lighthouse 13.0.0');
    expect(rows.find((x) => x.source === 'crux_api')!.tool_version).toBe('crux-api-v1');
    expect(rows.every((x) => x.raw_ref && x.checked_at === '2026-09-24T09:00:00.000Z')).toBe(true);
    expect(rows.find((x) => x.source === 'psi_lab')!.cache_key).toBe(perfCacheKey('psi_lab', URL_, 'mobile', '2026-09-24'));
    const lab = JSON.parse(rows.find((x) => x.source === 'psi_lab')!.metrics_json);
    expect(lab.inp).toBeNull();
    expect(lab.strategy).toBe('MOBILE');
    const crux = JSON.parse(rows.find((x) => x.source === 'crux_api')!.metrics_json);
    expect(crux.cwvAssessment).toBe('pass');
    // Applicable date range (migration 0201): CrUX collection period; lab = the run's UTC day; PSI field = unknown (not reported).
    const ranges = c.db.all<{ source: string; date_range_start: string | null; date_range_end: string | null }>('SELECT source, date_range_start, date_range_end FROM performance_checks WHERE site_id = ? ORDER BY source', [c.siteId]);
    expect(ranges).toEqual([
      { source: 'crux_api', date_range_start: '2026-08-25', date_range_end: '2026-09-21' },
      { source: 'psi_field', date_range_start: null, date_range_end: null },
      { source: 'psi_lab', date_range_start: r.lab.analysisUTCTimestamp!.slice(0, 10), date_range_end: r.lab.analysisUTCTimestamp!.slice(0, 10) },
    ]);
    // The reason is persisted with every stored row and in the audit trail.
    for (const row of rows) expect(JSON.parse(row.metrics_json).justification).toMatchObject({ reason: 'priority_page', detail: 'protected page' });
    const audit = c.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE site_id = ? AND event_type = 'perf.check_requested'", [c.siteId])!;
    expect(JSON.parse(audit.details_json).justification).toMatchObject({ reason: 'priority_page' });

    // Provider requests logged (free, not paid); the key never lands in stored data.
    const reqs = c.db.all<{ provider: string; is_paid: number; status: string; http_status: number }>('SELECT provider, is_paid, status, http_status FROM provider_requests WHERE site_id = ? ORDER BY provider', [c.siteId]);
    expect(reqs).toEqual([
      { provider: 'crux', is_paid: 0, status: 'succeeded', http_status: 200 },
      { provider: 'pagespeed', is_paid: 0, status: 'succeeded', http_status: 200 },
    ]);
    const dump = JSON.stringify(c.db.all('SELECT * FROM performance_checks')) + JSON.stringify(c.db.all('SELECT * FROM provider_requests'));
    expect(dump).not.toContain(KEY);
    for (const row of rows) expect(JSON.stringify(c.raw.load(row.raw_ref!))).not.toContain(KEY);
    // PSI request: GET with strategy and key.
    const psiCall = f.calls.find((x) => x.url.includes('runPagespeed'))!;
    expect(psiCall.method).toBe('GET');
    expect(new URL(psiCall.url).searchParams.get('strategy')).toBe('MOBILE');
  });

  it('caches by url + device + UTC day; --force and a new day re-run', async () => {
    const { c, f } = make({ routes: [psiRoute(), cruxPageOk] });
    await checkPerformance(c, URL_, MANUAL);
    const calls = f.calls.length;
    const again = await checkPerformance(c, URL_, MANUAL);
    expect(again.status).toBe('cached');
    expect(again.lab.status).toBe('cached');
    expect(again.crux.status).toBe('cached');
    expect(f.calls.length).toBe(calls);
    const desktop = await checkPerformance(c, URL_, { ...MANUAL, device: 'desktop' });
    expect(desktop.status).toBe('ok');
    expect(f.calls.length).toBeGreaterThan(calls);
    const n = f.calls.length;
    await checkPerformance(c, URL_, { ...MANUAL, force: true });
    expect(f.calls.length).toBeGreaterThan(n);
    const m = f.calls.length;
    c.clock.advanceMs(24 * 3600 * 1000);
    const tomorrow = await checkPerformance(c, URL_, MANUAL);
    expect(tomorrow.cacheDay).toBe('2026-09-25');
    expect(f.calls.length).toBeGreaterThan(m);
  });

  it('records origin-level CrUX data as origin scope, and unavailable when every level is 404', async () => {
    const { c } = make({ routes: [psiRoute('psi-origin-fallback.json'), cruxRoute((b) => (b.url ? jsonResponse(load('crux-404.json'), 404) : jsonResponse(load('crux-origin.json'))))] });
    seedObservations(c, 'https://www.example.test/new-page');
    const r = await checkPerformance(c, 'https://www.example.test/new-page', { reason: 'material_change' });
    expect(r.justification.evidence).toMatchObject({ changed: ['content_hash'], previous: { contentHash: 'hash_a' }, latest: { contentHash: 'hash_b' } });
    expect(r.psiField.scope).toBe('origin');
    expect(r.crux.scope).toBe('origin');
    expect(r.notes.join(' ')).toMatch(/ORIGIN-level/);
    // One provider_requests row per CrUX HTTP attempt: url+formFactor (404 = no data), then origin+formFactor.
    const crux = c.db.all<{ status: string; http_status: number }>("SELECT status, http_status FROM provider_requests WHERE site_id = ? AND provider = 'crux' ORDER BY created_at, rowid", [c.siteId]);
    expect(crux).toEqual([
      { status: 'succeeded', http_status: 404 },
      { status: 'succeeded', http_status: 200 },
    ]);
    c.cleanup();
    const second = make({ routes: [psiRoute('psi-no-field.json'), cruxRoute(() => jsonResponse(load('crux-404.json'), 404))] });
    const r2 = await checkPerformance(second.c, 'https://www.example.test/tiny', MANUAL);
    expect(r2.status).toBe('ok');
    expect(r2.psiField).toMatchObject({ status: 'unavailable', scope: 'unavailable' });
    expect(r2.crux).toMatchObject({ status: 'unavailable', scope: 'unavailable' });
    const row = second.c.db.get<{ field_scope: string; metrics_json: string }>("SELECT field_scope, metrics_json FROM performance_checks WHERE source = 'crux_api'")!;
    expect(row.field_scope).toBe('unavailable');
    expect(JSON.parse(row.metrics_json).record).toBeNull();
    expect(second.c.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_requests WHERE provider = 'crux'")!.n).toBe(3);
  });

  it('without a key: PSI is attempted keyless (documented optional) and fails honestly; CrUX reports missing credentials', async () => {
    const { c, f } = make({ key: false, routes: [psiRoute('psi-429-keyless.json', 429)] });
    const r = await checkPerformance(c, URL_, MANUAL);
    expect(r.status).toBe('failed');
    expect(r.lab.status).toBe('failed');
    expect(r.lab.error).toMatch(/429/);
    expect(r.crux.status).toBe('missing_credentials');
    expect(r.nextStep).toMatch(/PAGESPEED_API_KEY/);
    expect(f.calls.filter((x) => x.url.includes('runPagespeed'))).toHaveLength(1); // quota 0 without a key: no pointless retry
    expect(f.calls.some((x) => x.url.includes('chromeuxreport'))).toBe(false);
    expect(new URL(f.calls[0]!.url).searchParams.has('key')).toBe(false);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM performance_checks')!.n).toBe(0);
    expect(c.db.get<{ status: string }>("SELECT status FROM provider_requests WHERE provider = 'pagespeed'")!.status).toBe('failed');
  });

  it('retries PSI once on a transient 5xx', async () => {
    let n = 0;
    const { c } = make({ routes: [(req) => (req.url.includes('runPagespeed') ? (++n === 1 ? jsonResponse({ error: { code: 503, message: 'backend' } }, 503) : jsonResponse(load('psi-page-level.json'))) : undefined)] });
    const r = await checkPerformance(c, URL_, { ...MANUAL, sources: ['psi'], sleep: async () => undefined });
    expect(r.lab.status).toBe('ok');
    expect(n).toBe(2);
    expect(r.crux.status).toBe('not_requested');
  });

  it('is disabled, dry-run, offline, and own-site-only honestly', async () => {
    const d = make({ pagespeed: false });
    const off = await checkPerformance(d.c, URL_, MANUAL);
    expect(off.status).toBe('disabled');
    expect(off.nextStep).toMatch(/features.pagespeed/);
    d.c.cleanup();
    const dry = make({ dryRun: true });
    const plan = await checkPerformance(dry.c, URL_, MANUAL);
    expect(plan.status).toBe('dry_run');
    expect(plan.plan!.psiRequest).toContain('strategy=MOBILE');
    expect(plan.plan!.psiRequest).not.toContain('key=');
    expect(dry.f.calls).toHaveLength(0);
    dry.c.cleanup();
    const o = make({ offline: true });
    expect((await checkPerformance(o.c, URL_, MANUAL)).status).toBe('offline');
    await expect(checkPerformance(o.c, 'https://competitor.example.com/', MANUAL)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(checkPerformance(o.c, 'ftp://www.example.test/', MANUAL)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('enforces the reason: priority pages, material changes with crawl evidence, or a written manual justification', async () => {
    const { c, f } = make({ routes: [psiRoute(), cruxPageOk] });
    await expect(checkPerformance(c, 'https://www.example.test/not-a-priority', { reason: 'priority_page' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/not one of this site's 10 priority pages/) });
    await expect(checkPerformance(c, 'https://www.example.test/unchanged', { reason: 'material_change' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/No material change/) });
    seedObservations(c, 'https://www.example.test/unchanged', { same: true });
    await expect(checkPerformance(c, 'https://www.example.test/unchanged', { reason: 'material_change' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(checkPerformance(c, 'https://www.example.test/x', { reason: 'manual' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/justification/) });
    await expect(checkPerformance(c, 'https://www.example.test/x', { reason: 'manual', justification: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.calls).toHaveLength(0); // nothing was requested for unjustified checks
    // The site root is always a priority page.
    const root = await checkPerformance(c, 'https://www.example.test/', { reason: 'priority_page', sources: ['psi'] });
    expect(root.justification).toMatchObject({ reason: 'priority_page', detail: 'site root' });
    // A detected change justifies one check; a later day needs --force for the same change.
    c.db.run('DELETE FROM crawl_results');
    c.db.run('DELETE FROM crawls');
    seedObservations(c, URL_);
    expect((await checkPerformance(c, URL_, { reason: 'material_change', sources: ['psi'] })).status).toBe('ok');
    expect((await checkPerformance(c, URL_, { reason: 'material_change', sources: ['psi'] })).status).toBe('cached'); // same day: cache
    c.clock.advanceMs(24 * 3600 * 1000);
    await expect(checkPerformance(c, URL_, { reason: 'material_change', sources: ['psi'] })).rejects.toMatchObject({ message: expect.stringMatching(/already checked/) });
    expect((await checkPerformance(c, URL_, { reason: 'material_change', sources: ['psi'], force: true })).status).toBe('ok');
    // PSI provider request parameters include the reason (hashed); the manual justification is stored verbatim.
    const manual = await checkPerformance(c, 'https://www.example.test/landing', { ...MANUAL, sources: ['psi'] });
    expect(manual.justification).toEqual({ reason: 'manual', detail: MANUAL.justification, evidence: null });
    const lab = c.db.get<{ metrics_json: string }>("SELECT metrics_json FROM performance_checks WHERE url = 'https://www.example.test/landing' AND source = 'psi_lab'")!;
    expect(JSON.parse(lab.metrics_json).justification.detail).toBe(MANUAL.justification);
  });

  it('never serves a failed (runtime error) Lighthouse run from the cache as a good result', async () => {
    const { c, f } = make({ routes: [psiRoute('psi-runtime-error.json'), cruxPageOk] });
    const first = await checkPerformance(c, URL_, MANUAL);
    expect(first.lab.status).toBe('failed');
    expect(first.lab.error).toMatch(/NO_FCP/);
    expect(first.status).toBe('partial'); // CrUX field data is fine
    const calls = f.calls.length;
    const again = await checkPerformance(c, URL_, MANUAL);
    expect(f.calls.length).toBe(calls); // served from today's cache...
    expect(again.lab.status).toBe('failed'); // ...but as the failure it was
    expect(again.lab.error).toMatch(/runtime error NO_FCP.*--force/);
    expect(again.crux.status).toBe('cached');
    expect(again.status).toBe('partial');
    const labOnly = await checkPerformance(c, URL_, { ...MANUAL, sources: ['psi'] });
    expect(labOnly.status).toBe('failed');
  });

  it('selects only a small set of priority pages', () => {
    const { c } = make();
    const now = '2026-09-24T09:00:00.000Z';
    c.db.run("INSERT INTO pages (id, site_id, url, host, path, first_source, is_protected, first_seen_at, last_seen_at) VALUES ('page_1', ?, 'https://www.example.test/checkout', 'www.example.test', '/checkout', 'config', 1, ?, ?)", [c.siteId, now, now]);
    const pages = selectPriorityPages(c, 3);
    expect(pages[0]).toEqual({ url: 'https://www.example.test/', why: 'site root' });
    expect(pages[1]).toEqual({ url: 'https://www.example.test/checkout', why: 'protected page' });
    expect(pages.length).toBeLessThanOrEqual(3);
  });

  it('ranks GSC top pages only within the configured property, search type, and unsegmented rows', () => {
    const PROPERTY = 'sc-domain:example.test';
    const { c } = make({ property: PROPERTY });
    const batch = 'ingb_synthetic_perf';
    c.db.run(
      `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
       VALUES (?, ?, 'gsc', 'gsc_page_daily', ?, '2026-09-01', '2026-09-20', '{"_synthetic":true}', 'succeeded', 'test@1', 1, '2026-09-21T00:00:00.000Z')`,
      [batch, c.siteId, PROPERTY],
    );
    let n = 0;
    const row = (page: string, clicks: number, extra: { property?: string; searchType?: string; segmentKey?: string } = {}) =>
      c.db.run(
        `INSERT INTO gsc_page_daily (site_id, property, search_type, date, date_tz, page, segment_key, clicks, impressions, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
         VALUES (?, ?, ?, '2026-09-20', 'America/Los_Angeles', ?, ?, ?, ?, 'byPage', 1, 1, 1, ?, ?, '2026-09-21T00:00:00.000Z', 'test@1', 1)`,
        [c.siteId, extra.property ?? PROPERTY, extra.searchType ?? 'web', page, extra.segmentKey ?? '', clicks, clicks * 10, `h${n++}`, batch],
      );
    row('https://www.example.test/scoped', 10);
    row('https://www.example.test/segmented', 500, { segmentKey: 'country=usa;device=MOBILE' });
    row('https://www.example.test/other-property', 400, { property: 'https://www.example.test/' });
    row('https://www.example.test/images', 300, { searchType: 'image' });
    const pages = selectPriorityPages(c, 5).map((p) => p.url);
    expect(pages).toEqual(['https://www.example.test/', 'https://www.example.test/scoped']);
  });

  it('uses only the root and protected pages when no Search Console property is configured', () => {
    const { c } = make();
    expect(selectPriorityPages(c, 5)).toEqual([{ url: 'https://www.example.test/', why: 'site root' }]);
  });
});

describe('pagespeed / crux status', () => {
  it('reports disabled, missing credentials, and configured states without network by default', async () => {
    const d = make({ pagespeed: false });
    expect((await pagespeedStatus(d.c, { network: false })).state).toBe('disabled');
    d.c.cleanup();
    const nokey = make({ key: false });
    const s = await performanceStatuses(nokey.c, { network: true });
    expect(s.map((x) => x.state)).toEqual(['missing_credentials', 'missing_credentials']);
    expect(s[0]!.nextStep).toMatch(/secrets.env/);
    expect(s.every((x) => !x.networkChecked && !x.chargeable)).toBe(true);
    nokey.c.cleanup();
    const k = make();
    expect((await pagespeedStatus(k.c, { network: true })).state).toBe('configured_unverified');
    expect((await cruxStatus(k.c, { network: false })).state).toBe('configured_unverified');
    expect(k.f.calls).toHaveLength(0);
  });

  it('verifies the key with one free CrUX origin query when network checks are allowed', async () => {
    const ok = make({ routes: [cruxRoute(() => jsonResponse(load('crux-404.json'), 404))] });
    const s = await cruxStatus(ok.c, { network: true });
    expect(s).toMatchObject({ state: 'ready', networkChecked: true, chargeable: false });
    expect(JSON.parse(ok.f.calls[0]!.body!)).toMatchObject({ origin: 'https://www.example.test' });
    ok.c.cleanup();
    const bad = make({ routes: [cruxRoute(() => jsonResponse({ error: { code: 403, message: 'Chrome UX Report API has not been used in project', status: 'PERMISSION_DENIED' } }, 403))] });
    const s2 = await cruxStatus(bad.c, { network: true });
    expect(s2.state).toBe('permission_denied');
    expect(s2.nextStep).toMatch(/Enable the Chrome UX Report API/);
  });
});
