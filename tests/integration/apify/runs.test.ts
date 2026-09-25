import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext, type AppContext } from '../../../src/app/context.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import {
  confirmNotAccepted,
  resumeApifyRuns,
  runContentResearch,
  listApifyRuns,
  ingestSyntheticDataset,
  outputSchemaDrift,
  planContentResearchBatch,
  runContentResearchBatch,
} from '../../../src/integrations/apify/runs.js';
import { ACTOR_ID, BUILD_ID, FakeApify, OUTPUT_FIELDS, TEST_TOKEN, buildObject, fixtureItems, fixtureSchema } from '../../fixtures/apify/fake-apify.js';
import { testSiteConfig } from '../../helpers/context.js';
import { RT, apifyContext, inspected, type ApifyTestSetup } from './apify-context.js';

const small = { maxItems: 10, maxCommentsPerPost: 2 };

function countRows(s: ApifyTestSetup, table: string): number {
  return s.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`, [s.ctx.siteId])!.n;
}
function reservation(s: ApifyTestSetup) {
  return s.ctx.db.get<{ status: string; estimated_usd_micros: number; actual_usd_micros: number | null; cost_status: string }>(
    `SELECT status, estimated_usd_micros, actual_usd_micros, cost_status FROM budget_reservations WHERE site_id = ? AND provider = 'apify'`,
    [s.ctx.siteId],
  );
}
function startRequest(s: ApifyTestSetup) {
  return s.ctx.db.get<{ status: string; is_paid: number; external_id: string | null; reservation_id: string | null }>(
    `SELECT status, is_paid, external_id, reservation_id FROM provider_requests WHERE site_id = ? AND endpoint = 'apify.actor.runs.start'`,
    [s.ctx.siteId],
  );
}

describe('runContentResearch preconditions (honest statuses, no spend)', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  it('refuses an unpinned build without any network request', async () => {
    s = apifyContext({ build: null });
    const r = await runContentResearch(s.ctx, { runtime: RT });
    expect(r.status).toBe('misconfigured');
    expect(r.detail).toMatch(/No Apify build is pinned/);
    expect(s.fake.calls).toHaveLength(0);
  });

  it('refuses a pinned build whose schema was never verified', async () => {
    s = apifyContext({ build: '0.0.600' });
    await inspectFree(s);
    const r = await runContentResearch(s.ctx, { runtime: RT });
    expect(r.status).toBe('misconfigured');
    expect(r.detail).toMatch(/No stored input schema for pinned build 0\.0\.600/);
    expect(s.fake.startCount).toBe(0);
  });

  it('reports disabled, offline, and missing credentials honestly', async () => {
    s = apifyContext({ features: { apify: false } });
    expect((await runContentResearch(s.ctx, { runtime: RT })).status).toBe('disabled');
    s.ctx.cleanup();
    s = await inspected({ noToken: true });
    const m = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(m.status).toBe('missing_credentials');
    expect(m.nextStep).toMatch(/secrets\.env/);
    expect(m.plan?.capMicros).toBe(80_000);
    s.ctx.offline = true;
    expect((await runContentResearch(s.ctx, { runtime: RT, ...small })).status).toBe('offline');
    expect(s.fake.calls).toHaveLength(0);
  });

  it('dry run returns the plan (cap, bounds, forced-off fields) without network, reservation, or rows', async () => {
    s = await inspected();
    s.ctx.dryRun = true;
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('dry_run');
    expect(r.plan).toMatchObject({ build: '0.0.513', bounds: { posts: 10, comments: 20, results: 30 }, capMicros: 80_000, reserveMicros: 80_000, pricingSource: 'stored' });
    expect(r.plan?.runOptions).toEqual({ build: '0.0.513', timeoutSecs: 300, memoryMbytes: 512, maxItems: 30, maxTotalChargeUsd: '0.08' });
    expect(r.plan?.forcedOff.map((f) => f.field)).toContain('aiAnalysis');
    expect(r.warnings).not.toBe(r.plan?.warnings); // distinct arrays: redact() collapses shared references
    expect(s.fake.calls).toHaveLength(0);
    expect(countRows(s, 'apify_runs')).toBe(0);
    expect(countRows(s, 'budget_reservations')).toBe(0);
  });

  it('requires RESEARCH mode: an explicit spend confirmation is a second requirement, never a bypass (policy external_research)', async () => {
    s = await inspected({ mode: 'ANALYZE' });
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('policy_denied');
    expect(r.detail).toMatch(/\$0\.08/);
    expect(r.nextStep).toMatch(/--mode RESEARCH/);
    const confirmed = await runContentResearch(s.ctx, { runtime: RT, ...small, explicitSpendConfirmation: true });
    expect(confirmed.status).toBe('policy_denied');
    expect(s.fake.startCount).toBe(0);
    expect(countRows(s, 'budget_reservations')).toBe(0);
    s.ctx.mode = 'RESEARCH';
    const ok = await runContentResearch(s.ctx, { runtime: RT, ...small, explicitSpendConfirmation: true });
    expect(ok.status).toBe('completed');
  });

  it('never sends credentials: a search term containing a configured secret is rejected before any request', async () => {
    s = await inspected({ secrets: { LLM_GATEWAY_API_KEY: 'sk-synthetic-gateway-key-0000000000' } });
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small, searchTerms: ['crm sk-synthetic-gateway-key-0000000000'] });
    expect(r.status).toBe('rejected');
    expect(r.errors?.join('\n')).toMatch(/searchTerms\[0\]/);
    expect(JSON.stringify(r)).not.toContain('sk-synthetic-gateway-key');
    const db = await runContentResearch(s.ctx, { runtime: RT, ...small, searchTerms: [`backup ${s.ctx.paths.dbFile}`] });
    expect(db.status).toBe('rejected');
    expect(s.fake.calls).toHaveLength(0);
  });

  it('rejects per-run limits above the configured ones and fields outside the schema', async () => {
    s = await inspected();
    const r = await runContentResearch(s.ctx, { runtime: RT, maxItems: 5000 });
    expect(r.status).toBe('rejected');
    expect(r.errors?.join(' ')).toMatch(/exceeds the configured limit/);
    const x = await runContentResearch(s.ctx, { runtime: RT, ...small, extraInput: { webhooks: [{ requestUrl: 'https://hooks.example.invalid' }] } });
    expect(x.status).toBe('rejected');
    expect(x.errors?.join(' ')).toMatch(/"webhooks" is not a field of the verified input schema/);
    expect(s.fake.startCount).toBe(0);
  });
});

/** A second site in the same workspace/database (the Apify account and token are shared). */
function secondSite(s: ApifyTestSetup): AppContext {
  const config = testSiteConfig({
    site: { id: 'site-b', businessName: 'Site B (synthetic)', url: 'https://www.example-b.test/', allowedHostnames: ['www.example-b.test'] },
    features: { apify: true },
    research: { seedTopics: ['invoicing software'], apify: { build: '0.0.513' } } as never,
  });
  return createAppContext({
    workspaceRoot: s.ctx.paths.root,
    siteId: 'site-b',
    config,
    db: s.ctx.db,
    secrets: new MemorySecretStore({ APIFY_TOKEN: TEST_TOKEN }),
    clock: s.ctx.clock,
    logger: s.ctx.logger,
    fetch: s.fake.fetch,
    offline: false,
    mode: 'RESEARCH',
    migrate: false,
  });
}

async function inspectFree(s: ApifyTestSetup) {
  const { inspectActor } = await import('../../../src/integrations/apify/schema.js');
  await inspectActor(s.ctx, { clientOptions: { sleep: async () => {} } });
  s.fake.calls.length = 0;
}

describe('paid run lifecycle', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  it('reserves and persists rows BEFORE the POST, then fetches paginated results, normalizes, and reconciles usage', async () => {
    s = await inspected();
    let atPost: Record<string, unknown> | null = null;
    s.fake.onStart = () => {
      const row = s.ctx.db.get<{ status: string; provider_request_id: string; reservation_id: string; remote_run_id: string | null }>('SELECT * FROM apify_runs WHERE site_id = ?', [s.ctx.siteId])!;
      const pr = s.ctx.db.get<{ status: string; is_paid: number }>('SELECT status, is_paid FROM provider_requests WHERE id = ?', [row.provider_request_id])!;
      const res = s.ctx.db.get<{ status: string; estimated_usd_micros: number }>('SELECT status, estimated_usd_micros FROM budget_reservations WHERE id = ?', [row.reservation_id])!;
      atPost = { runStatus: row.status, remote: row.remote_run_id, pr: pr.status, paid: pr.is_paid, res: res.status, reserved: res.estimated_usd_micros };
    };
    const r = await runContentResearch(s.ctx, { runtime: { ...RT, datasetPageSize: 5 }, ...small });
    expect(atPost).toEqual({ runStatus: 'submitting', remote: null, pr: 'submitted', paid: 1, res: 'reserved', reserved: 80_000 });
    expect(r.status).toBe('completed');
    expect(s.fake.startCount).toBe(1);

    // The POST: verified params only, provider-side cap, no webhooks/token in the URL, Bearer auth.
    const post = s.fake.callsTo('POST', /\/runs$/)[0]!;
    const q = Object.fromEntries(new URL(post.url).searchParams);
    expect(q).toEqual({ build: '0.0.513', timeout: '300', memory: '512', maxItems: '30', maxTotalChargeUsd: '0.08', restartOnError: '0', waitForFinish: '0' });
    expect(post.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    const body = JSON.parse(post.body!);
    expect(body).toMatchObject({ searchTerms: ['invoicing software'], maxPostsCount: 10, crawlCommentsPerPost: true, maxCommentsPerPost: 2, aiAnalysis: false, customLabels: {}, searchTime: 'month' });
    // MCP delivery explicitly disabled with empty plain-string activation fields; nothing else mcp* is sent.
    expect(Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith('mcp')))).toEqual({ mcpTarget: '', mcpTool: '', mcpServerUrl: '' });
    expect(body).toMatchObject({ startUrls: [], subredditUrls: [] });
    for (const k of Object.keys(body)) expect(fixtureSchema().properties[k]).toBeDefined();

    // Dataset pagination with a server-side field allowlist (no author fields requested).
    const pages = s.fake.callsTo('GET', /\/datasets\//).map((c) => new URL(c.url).searchParams);
    expect(pages.map((p) => p.get('offset'))).toEqual(['0', '5', '10']);
    expect(pages[0]!.get('fields')).toContain('title');
    expect(pages[0]!.get('fields')).not.toContain('author');

    // Run row, provider request, reservation.
    const runs = listApifyRuns(s.ctx);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ processingStatus: 'complete', status: 'SUCCEEDED', itemsFetched: 14, signalsCreated: 8, capMicros: 80_000, usageMicros: 50_000, reservationStatus: 'reconciled' });
    expect(startRequest(s)).toMatchObject({ status: 'succeeded', is_paid: 1, external_id: runs[0]!.remoteRunId });
    expect(reservation(s)).toMatchObject({ status: 'reconciled', estimated_usd_micros: 80_000, actual_usd_micros: 50_000, cost_status: 'actual' });
    expect(r.cost).toMatchObject({ costStatus: 'actual', actualMicros: 50_000, capMicros: 80_000 });
    const ledger = s.ctx.db.get<{ source: string; amount_usd_micros: number }>('SELECT source, amount_usd_micros FROM cost_ledger WHERE site_id = ?', [s.ctx.siteId])!;
    expect(ledger).toEqual({ source: 'provider_reported', amount_usd_micros: 50_000 });
    expect(s.ctx.budgets.report(s.ctx.siteId).providers.find((p) => p.provider === 'apify')!.actualMicros).toBe(50_000);

    // Signals: origin, links, dates, limitations; personal data minimized everywhere it is stored.
    expect(r.signals).toMatchObject({ created: 8, unclassified: 1 });
    const signals = s.ctx.db.all<{ origin: string; url: string | null; posted_at: string | null; limitations: string; text: string; collection_window_json: string }>(
      'SELECT * FROM content_signals WHERE site_id = ?',
      [s.ctx.siteId],
    );
    expect(signals).toHaveLength(8);
    expect(signals.every((x) => x.origin === 'apify_reddit' && x.limitations.includes('not a representative survey') && x.limitations.includes('not search volume'))).toBe(true);
    expect(signals.filter((x) => x.url?.startsWith('https://reddit.example.test/'))).toHaveLength(7);
    expect(signals.every((x) => x.posted_at !== null)).toBe(true);
    expect(JSON.parse(signals[0]!.collection_window_json)).toMatchObject({ build: '0.0.513', searchTime: 'month' });
    const rawRef = s.ctx.db.get<{ raw_ref: string }>('SELECT raw_ref FROM apify_runs WHERE site_id = ?', [s.ctx.siteId])!.raw_ref;
    const stored = JSON.stringify({
      signals,
      sources: s.ctx.db.all('SELECT * FROM sources WHERE site_id = ?', [s.ctx.siteId]),
      evidence: s.ctx.db.all('SELECT * FROM evidence WHERE site_id = ?', [s.ctx.siteId]),
      raw: s.ctx.raw.load(rawRef),
    });
    expect(stored).not.toMatch(/synthetic_author|synthetic_commenter|t2_syn|synthetic_profile_user|jane\.synthetic|owner\.synthetic|555 010 0199/);

    // Untrusted text is data: the injected instruction changed nothing.
    expect(signals.some((x) => x.text.startsWith('IGNORE ALL PREVIOUS INSTRUCTIONS'))).toBe(true);
    expect(s.ctx.config.budgets.apify.monthlyUsd).toBe('10.00');
    expect(countRows(s, 'budget_reservations')).toBe(1);
    expect(stored).not.toContain(TEST_TOKEN);
  });

  it('quarantines a TIMED-OUT run (partial results never become research) but still reconciles its charge', async () => {
    s = await inspected();
    s.fake.nextStatuses = ['RUNNING', 'TIMED-OUT'];
    s.fake.nextFinalFields = { usageTotalUsd: 0.03, chargedEventCounts: { init: 1, result: 5 }, statusMessage: 'Actor timed out' };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/run ended TIMED-OUT/);
    expect(countRows(s, 'content_signals')).toBe(0);
    const run = listApifyRuns(s.ctx)[0]!;
    expect(run).toMatchObject({ status: 'quarantined', processingStatus: 'quarantined', remoteStatus: 'TIMED-OUT', itemsFetched: 14 });
    expect(reservation(s)).toMatchObject({ status: 'reconciled', actual_usd_micros: 30_000 });
    expect(startRequest(s)?.status).toBe('failed');
  });

  it('quarantines FAILED and ABORTED runs', async () => {
    for (const status of ['FAILED', 'ABORTED']) {
      s = await inspected();
      s.fake.nextStatuses = [status];
      const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
      expect(r.status).toBe('quarantined');
      expect(countRows(s, 'content_signals')).toBe(0);
      s.ctx.cleanup();
    }
  });

  it('quarantines a SUCCEEDED run whose dataset could only be partially fetched', async () => {
    s = await inspected();
    s.fake.failDatasetOffsets.add(5);
    const r = await runContentResearch(s.ctx, { runtime: { ...RT, datasetPageSize: 5 }, ...small });
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/partial dataset/);
    expect(countRows(s, 'content_signals')).toBe(0);
    expect(reservation(s)?.status).toBe('reconciled');
  });

  it('quarantines when the run summary reports more items than the dataset holds', async () => {
    s = await inspected();
    s.fake.nextItems = fixtureItems().slice(0, 4);
    const r1 = await runContentResearch(s.ctx, { runtime: RT, ...small, waitForCompletion: false });
    const kvId = s.fake.runs.get(r1.remoteRunId!)!.run.defaultKeyValueStoreId as string;
    s.fake.kv.set(kvId, { ...s.fake.kv.get(kvId), 'RUN-SUMMARY': { itemsTotal: 40, requests: { finished: 10, failed: 0, retries: 1 } } });
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/run summary reports 40 items/);
  });

  it('resumes a known in-flight run instead of starting a duplicate paid run', async () => {
    s = await inspected();
    const first = await runContentResearch(s.ctx, { runtime: RT, ...small, waitForCompletion: false });
    expect(first.status).toBe('running');
    expect(first.remoteRunId).toMatch(/^SYNRUN/);
    // The run id was persisted immediately.
    expect(listApifyRuns(s.ctx)[0]!.remoteRunId).toBe(first.remoteRunId);
    const second = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(second.resumedExisting).toBe(true);
    expect(second.status).toBe('completed');
    expect(second.remoteRunId).toBe(first.remoteRunId);
    expect(s.fake.startCount).toBe(1);
    expect(countRows(s, 'budget_reservations')).toBe(1);
  });

  it('reuses an identical completed run within the reuse window (no spend)', async () => {
    s = await inspected();
    await runContentResearch(s.ctx, { runtime: RT, ...small });
    const again = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(again.status).toBe('reused');
    expect(s.fake.startCount).toBe(1);
    const forced = await runContentResearch(s.ctx, { runtime: RT, ...small, reuseCompletedWithinHours: 0 });
    expect(forced.status).toBe('completed');
    expect(s.fake.startCount).toBe(2);
    expect(forced.signals?.created).toBe(0); // same content -> deduplicated signals
  });

  it('treats a start timeout as ambiguous and reconciles it via list runs without a second POST', async () => {
    s = await inspected();
    s.fake.startBehavior = { kind: 'timeout', createRun: true };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('ambiguous');
    expect(r.nextStep).toMatch(/apify runs --resume/);
    expect(reservation(s)).toMatchObject({ status: 'unresolved', cost_status: 'unknown', estimated_usd_micros: 80_000 });
    expect(startRequest(s)?.status).toBe('ambiguous');
    expect(s.ctx.budgets.report(s.ctx.siteId).providers.find((p) => p.provider === 'apify')).toMatchObject({ reservedMicros: 80_000, unknownCount: 1 });

    s.fake.startBehavior = { kind: 'ok' };
    const again = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(again.resumedExisting).toBe(true);
    expect(again.status).toBe('completed');
    expect(s.fake.startCount).toBe(1);
    expect(s.fake.callsTo('GET', /\/actors\/[^/]+\/runs$/)).toHaveLength(1);
    expect(reservation(s)).toMatchObject({ status: 'reconciled', actual_usd_micros: 50_000 });
    const audit = s.ctx.db.all<{ event_type: string }>(`SELECT event_type FROM audit_events WHERE event_type IN ('apify.run_ambiguous', 'apify.ambiguous_adopted')`);
    expect(audit.map((a) => a.event_type)).toEqual(['apify.run_ambiguous', 'apify.ambiguous_adopted']);
  });

  it('keeps an ambiguous submission held until the grace window; an absent run is quarantined but its cost stays unresolved until the owner confirms', async () => {
    s = await inspected();
    s.fake.startBehavior = { kind: 'timeout', createRun: false };
    const first = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(first.status).toBe('ambiguous');
    const early = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(early.runs[0]).toMatchObject({ status: 'ambiguous' });
    expect(reservation(s)?.status).toBe('unresolved');
    s.ctx.clock.advanceMs(31 * 60_000);
    const late = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(late.runs[0]).toMatchObject({ status: 'quarantined' });
    expect(late.runs[0]!.nextStep).toMatch(/apify runs --confirm-not-accepted/);
    // Absence from list-runs is an inference: never recorded as a provider-reported $0.
    expect(reservation(s)).toMatchObject({ status: 'unresolved', actual_usd_micros: null, cost_status: 'unknown' });
    expect(countRows(s, 'cost_ledger')).toBe(0);
    expect(listApifyRuns(s.ctx)[0]!.quarantineReason).toMatch(/not found in provider run history/);
    expect(startRequest(s)?.status).toBe('ambiguous');
    expect(s.fake.startCount).toBe(1);

    // Owner confirmation (after checking the console): $0 recorded as a manual confirmation, with a live re-check.
    const c = await confirmNotAccepted(s.ctx, first.apifyRunId!, { runtime: RT });
    expect(c).toMatchObject({ status: 'confirmed', liveCheck: 'absent' });
    expect(reservation(s)).toMatchObject({ status: 'reconciled', actual_usd_micros: 0 });
    const ledger = s.ctx.db.get<{ source: string; amount_usd_micros: number; usage_json: string }>('SELECT source, amount_usd_micros, usage_json FROM cost_ledger WHERE site_id = ?', [s.ctx.siteId])!;
    expect(ledger).toMatchObject({ source: 'manual', amount_usd_micros: 0 });
    expect(JSON.parse(ledger.usage_json).confirmation).toMatch(/owner confirmed/);
    expect(s.ctx.db.get(`SELECT id FROM audit_events WHERE event_type = 'apify.not_accepted_confirmed'`)).toBeTruthy();
    expect((await confirmNotAccepted(s.ctx, first.apifyRunId!, { runtime: RT })).status).toBe('refused');
  });

  it('refuses the owner confirmation when an unlinked run appeared in the submission window', async () => {
    s = await inspected();
    s.fake.startBehavior = { kind: 'timeout', createRun: false };
    const first = await runContentResearch(s.ctx, { runtime: RT, ...small });
    s.ctx.clock.advanceMs(31 * 60_000);
    await resumeApifyRuns(s.ctx, { runtime: RT });
    s.fake.foreignRuns.push({ id: 'SYNLATE000000001', actId: ACTOR_ID, status: 'SUCCEEDED', startedAt: '2026-09-24T09:10:00.000Z', buildNumber: '0.0.513', meta: { origin: 'API' } });
    const c = await confirmNotAccepted(s.ctx, first.apifyRunId!, { runtime: RT });
    expect(c).toMatchObject({ status: 'refused', liveCheck: 'candidates_found' });
    expect(reservation(s)?.status).toBe('unresolved');
  });

  it('never adopts a provider run that does not match the submission fingerprint', async () => {
    s = await inspected();
    s.fake.startBehavior = { kind: 'timeout', createRun: false };
    await runContentResearch(s.ctx, { runtime: RT, ...small });
    s.fake.addRun({
      run: { id: 'SYNFOREIGN000001', actId: ACTOR_ID, status: 'RUNNING', startedAt: '2026-09-24T09:00:05.000Z', buildNumber: '0.0.513', meta: { origin: 'API' }, stats: { inputBodyLen: 17 }, options: { maxTotalChargeUsd: 0.08 } },
      statuses: ['RUNNING'],
    });
    s.ctx.clock.advanceMs(31 * 60_000);
    const r = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(r.runs[0]).toMatchObject({ status: 'ambiguous' });
    expect(r.runs[0]!.detail).toMatch(/none matched the fingerprint/);
    expect(reservation(s)?.status).toBe('unresolved');
  });

  it('never adopts a foreign run with the same body length and options but a different INPUT', async () => {
    s = await inspected();
    s.fake.startBehavior = { kind: 'timeout', createRun: false };
    const r0 = await runContentResearch(s.ctx, { runtime: RT, ...small, searchTerms: ['crm tools'] });
    const sent = s.fake.callsTo('POST', /\/runs$/)[0]!.body!;
    const foreignInput = { ...JSON.parse(sent), searchTerms: ['seo tools'] }; // same length, different research
    expect(Buffer.byteLength(JSON.stringify(foreignInput))).toBe(Buffer.byteLength(sent));
    s.fake.addRun({
      run: {
        id: 'SYNFOREIGN000002',
        actId: ACTOR_ID,
        status: 'SUCCEEDED',
        startedAt: '2026-09-24T09:00:05.000Z',
        buildNumber: '0.0.513',
        meta: { origin: 'API' },
        stats: { inputBodyLen: Buffer.byteLength(sent) },
        options: { maxTotalChargeUsd: 0.08, timeoutSecs: 300, memoryMbytes: 512 },
        defaultKeyValueStoreId: 'SYNKVFOREIGN0002',
        defaultDatasetId: 'SYNDSFOREIGN0002',
      },
    });
    s.fake.kv.set('SYNKVFOREIGN0002', { INPUT: foreignInput });
    s.fake.datasets.set('SYNDSFOREIGN0002', fixtureItems());
    const r = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(r.runs[0]).toMatchObject({ status: 'ambiguous', apifyRunId: r0.apifyRunId });
    expect(r.runs[0]!.detail).toMatch(/none matched the fingerprint and INPUT/);
    expect(countRows(s, 'content_signals')).toBe(0);
    expect(reservation(s)?.status).toBe('unresolved');
    // Without an INPUT record the candidate is unverifiable: still never adopted.
    s.fake.kv.delete('SYNKVFOREIGN0002');
    const u = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(u.runs[0]).toMatchObject({ status: 'ambiguous' });
    expect(u.runs[0]!.detail).toMatch(/could not be verified \(INPUT record not found\)/);
    expect(countRows(s, 'content_signals')).toBe(0);
  });

  it("never adopts a run already linked to another site of the workspace (shared Apify account), even with identical input", async () => {
    s = await inspected();
    const siteB = secondSite(s);
    s.fake.startBehavior = { kind: 'timeout', createRun: false };
    const a = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(a.status).toBe('ambiguous');
    s.fake.startBehavior = { kind: 'ok' };
    const b = await runContentResearch(siteB, { runtime: RT, ...small });
    expect(b.status).toBe('completed');
    s.ctx.clock.advanceMs(31 * 60_000);
    const r = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(r.runs[0]!.remoteRunId).toBeNull();
    expect(r.runs[0]).toMatchObject({ status: 'quarantined' });
    expect(countRows(s, 'content_signals')).toBe(0);
    expect(reservation(s)?.status).toBe('unresolved');
    // Site B's run and charge are untouched.
    expect(siteB.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_signals WHERE site_id = ?', ['site-b'])!.n).toBe(8);
    expect(siteB.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cost_ledger WHERE provider = 'apify' AND amount_status = 'actual'`)!.n).toBe(1);
  });

  it('does not adopt a matching run while another site has a pending ambiguous submission with the identical input', async () => {
    s = await inspected();
    const siteB = secondSite(s);
    s.fake.startBehavior = { kind: 'timeout', createRun: true };
    expect((await runContentResearch(s.ctx, { runtime: RT, ...small })).status).toBe('ambiguous');
    s.fake.startBehavior = { kind: 'timeout', createRun: false };
    expect((await runContentResearch(siteB, { runtime: RT, ...small })).status).toBe('ambiguous');
    const r = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(r.runs[0]).toMatchObject({ status: 'ambiguous' });
    expect(r.runs[0]!.detail).toMatch(/other pending ambiguous submission/);
    expect(listApifyRuns(s.ctx)[0]!.remoteRunId).toBeNull();
  });

  it('releases the reservation when Apify rejects the submission (4xx)', async () => {
    s = await inspected();
    s.fake.startBehavior = { kind: 'http', status: 400, type: 'invalid-input', message: 'Input is not valid' };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('submission_rejected');
    expect(reservation(s)?.status).toBe('released');
    expect(startRequest(s)?.status).toBe('failed');
    expect(listApifyRuns(s.ctx)[0]).toMatchObject({ processingStatus: 'quarantined' });
  });

  it('refuses when the reservation would exceed the budget (no POST, audit recorded)', async () => {
    s = await inspected({ budgets: { apify: { perRunUsd: '0.05' } } });
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('budget_exceeded');
    expect(s.fake.startCount).toBe(0);
    expect(countRows(s, 'apify_runs')).toBe(0);
    expect(s.ctx.db.get(`SELECT id FROM audit_events WHERE event_type = 'apify.budget_denied'`)).toBeTruthy();
  });

  it('refuses when the live price cannot be established (unknown is never $0)', async () => {
    s = await inspected();
    s.fake.actor = { ...s.fake.actor, pricingInfos: [] };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('budget_unknown_price');
    expect(r.plan?.estimate.upperBoundMicros).toBeNull();
    expect(s.fake.startCount).toBe(0);
  });

  it('keeps unknown usage unresolved and reconciles it later on resume', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { chargedEventCounts: { init: 1, result: 12 } }; // no usageTotalUsd; result is tiered -> not computable
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('completed');
    expect(r.cost?.costStatus).toBe('unknown');
    expect(r.warnings.join(' ')).toMatch(/unresolved/);
    expect(reservation(s)).toMatchObject({ status: 'unresolved', actual_usd_micros: null, estimated_usd_micros: 80_000 });
    const ledger = s.ctx.db.get<{ amount_usd_micros: number | null; amount_status: string }>('SELECT amount_usd_micros, amount_status FROM cost_ledger WHERE site_id = ?', [s.ctx.siteId])!;
    expect(ledger).toEqual({ amount_usd_micros: null, amount_status: 'unknown' });
    expect(s.ctx.budgets.report(s.ctx.siteId).providers.find((p) => p.provider === 'apify')).toMatchObject({ actualMicros: 0, reservedMicros: 80_000, unknownCount: 1 });

    s.fake.runs.get(r.remoteRunId!)!.finalFields = { usageTotalUsd: 0.026, chargedEventCounts: { init: 1, result: 3 } };
    const resumed = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(resumed.usageReconciled).toEqual([{ apifyRunId: r.apifyRunId, status: 'reconciled', actualMicros: 26_000 }]);
    expect(reservation(s)).toMatchObject({ status: 'reconciled', actual_usd_micros: 26_000 });
  });

  it('records an actual charge above the reservation truthfully (price change) and flags the overshoot', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { usageTotalUsd: 0.12, chargedEventCounts: { init: 1, result: 50 } };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('completed');
    expect(r.warnings.join(' ')).toMatch(/exceeded the reservation by \$0\.04/);
    expect(reservation(s)).toMatchObject({ status: 'reconciled', estimated_usd_micros: 80_000, actual_usd_micros: 120_000 });
  });

  it('serializes parallel reservations against the per-run cap', async () => {
    s = await inspected({ budgets: { apify: { perRunUsd: '0.10' } } });
    const [a, b] = await Promise.all([
      runContentResearch(s.ctx, { runtime: RT, ...small, searchTerms: ['invoice reminders'] }),
      runContentResearch(s.ctx, { runtime: RT, ...small, searchTerms: ['late payment fees'] }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['budget_exceeded', 'completed']);
    expect(s.fake.startCount).toBe(1);
  });

  it('starts only one paid run for concurrent identical requests', async () => {
    s = await inspected();
    const [a, b] = await Promise.all([runContentResearch(s.ctx, { runtime: RT, ...small }), runContentResearch(s.ctx, { runtime: RT, ...small })]);
    expect(s.fake.startCount).toBe(1);
    expect([a.status, b.status]).toContain('completed');
    expect([a.resumedExisting, b.resumedExisting]).toContain(true);
    expect(countRows(s, 'budget_reservations')).toBe(1);
  });

  it('computes usage from charged events only when every event price is flat', async () => {
    s = await inspected();
    const flat = structuredClone(s.fake.actor.pricingInfos[1]);
    flat.pricingPerEvent.actorChargeEvents.result = { eventTitle: 'Result Saved', eventPriceUsd: 0.002, isPrimaryEvent: true };
    s.fake.actor = { ...s.fake.actor, pricingInfos: [flat] };
    s.fake.nextFinalFields = { chargedEventCounts: { init: 1, result: 12 } };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.cost?.costStatus).toBe('computed');
    expect(reservation(s)).toMatchObject({ status: 'reconciled', actual_usd_micros: 20_000 + 12 * 2_000 });
  });

  it('refuses to pay when the pinned build schema drifted since verification', async () => {
    s = await inspected();
    const changed = fixtureSchema();
    changed.properties.newDeliveryTarget = { title: 'Deliver to', type: 'string', default: '' };
    s.fake.builds.set(BUILD_ID, buildObject({ schema: changed }));
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('misconfigured');
    expect(r.detail).toMatch(/Schema drift/);
    expect(s.fake.startCount).toBe(0);
  });

  it('abandons (and releases) a run whose POST was provably never sent after a crash', async () => {
    s = await inspected();
    const orig = s.ctx.requests.markSubmitted.bind(s.ctx.requests);
    s.ctx.requests.markSubmitted = () => {
      throw new Error('simulated crash before sending');
    };
    await expect(runContentResearch(s.ctx, { runtime: RT, ...small })).rejects.toThrow(/simulated crash/);
    s.ctx.requests.markSubmitted = orig;
    expect(listApifyRuns(s.ctx)[0]!.status).toBe('submitting');
    // A fresh attempt with the same input sees the in-flight row and does not duplicate it.
    const blocked = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(blocked).toMatchObject({ status: 'running', resumedExisting: true });
    s.ctx.clock.advanceMs(3 * 60_000);
    const r = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(r.runs[0]).toMatchObject({ status: 'abandoned' });
    expect(reservation(s)?.status).toBe('released');
    expect(s.fake.startCount).toBe(0);
  });

  it('resumeApifyRuns finishes a run started without waiting', async () => {
    s = await inspected();
    await runContentResearch(s.ctx, { runtime: RT, ...small, waitForCompletion: false });
    const r = await resumeApifyRuns(s.ctx, { runtime: RT, waitForCompletion: true });
    expect(r.status).toBe('ok');
    expect(r.runs[0]).toMatchObject({ status: 'completed' });
    expect(s.fake.startCount).toBe(1);
  });

  it('resume can request an abort for a run far past its timeout (opt-in)', async () => {
    s = await inspected();
    s.fake.nextStatuses = ['RUNNING'];
    await runContentResearch(s.ctx, { runtime: RT, ...small, waitForCompletion: false });
    s.ctx.clock.advanceMs(60 * 60_000);
    const r = await resumeApifyRuns(s.ctx, { runtime: { ...RT, maxPolls: 2 }, waitForCompletion: true, abortOverdue: true });
    expect(r.runs[0]!.warnings.join(' ')).toMatch(/abort was requested/);
    expect(s.fake.callsTo('POST', /\/abort$/)).toHaveLength(1);
    const next = await resumeApifyRuns(s.ctx, { runtime: RT, waitForCompletion: true });
    expect(next.runs[0]).toMatchObject({ status: 'quarantined' });
  });

  it('resume reports offline, dry run, and missing credentials honestly when a run is pending', async () => {
    s = await inspected();
    const started = await runContentResearch(s.ctx, { runtime: RT, ...small, waitForCompletion: false });
    expect(listApifyRuns(s.ctx)[0]).toMatchObject({ id: started.apifyRunId, processingStatus: 'pending' });
    s.fake.calls.length = 0;
    s.ctx.secrets = new MemorySecretStore({});
    const missing = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(missing.status).toBe('missing_credentials');
    expect(missing.nextStep).toMatch(/secrets\.env/);
    s.ctx.offline = true;
    expect(await resumeApifyRuns(s.ctx, { runtime: RT })).toMatchObject({ status: 'offline', detail: 'Offline/demo mode: pending Apify runs were not contacted.', runs: [] });
    s.ctx.dryRun = true;
    expect((await resumeApifyRuns(s.ctx, { runtime: RT })).status).toBe('dry_run');
    expect(s.fake.calls).toHaveLength(0);
    // Nothing was advanced: the run is still pending for a later resume.
    expect(listApifyRuns(s.ctx)[0]!.processingStatus).toBe('pending');
  });

  it('resume with nothing pending is ok in every mode and contacts nothing (D1-R05: no spurious OFFLINE note)', async () => {
    s = apifyContext({ noToken: true });
    const none = { status: 'ok', detail: 'No pending Apify runs.', runs: [], usageReconciled: [] };
    expect(await resumeApifyRuns(s.ctx, { runtime: RT })).toEqual(none);
    s.ctx.offline = true;
    expect(await resumeApifyRuns(s.ctx, { runtime: RT })).toEqual(none);
    s.ctx.dryRun = true;
    expect(await resumeApifyRuns(s.ctx, { runtime: RT })).toEqual(none);
    s.ctx.offline = false;
    expect(await resumeApifyRuns(s.ctx, { runtime: RT })).toEqual(none);
    expect(s.fake.calls).toHaveLength(0);
    s.ctx.cleanup();

    // A finished run whose charge is settled is not pending either (the demo's synthetic dataset, for example).
    s = await inspected();
    const done = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(done.status).toBe('completed');
    expect(reservation(s)?.status).toBe('reconciled');
    s.fake.calls.length = 0;
    s.ctx.offline = true;
    expect(await resumeApifyRuns(s.ctx, { runtime: RT })).toEqual(none);
    expect(s.fake.calls).toHaveLength(0);
  });

  it('resume still reports offline when only an unresolved charge is outstanding (it needs Apify to re-check)', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { chargedEventCounts: { init: 1, result: 12 } }; // no usageTotalUsd; tiered -> not computable
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('completed');
    expect(reservation(s)?.status).toBe('unresolved');
    expect(listApifyRuns(s.ctx).filter((x) => x.processingStatus === 'pending')).toHaveLength(0);
    s.fake.calls.length = 0;
    s.ctx.offline = true;
    expect((await resumeApifyRuns(s.ctx, { runtime: RT })).status).toBe('offline');
    s.ctx.dryRun = true;
    expect((await resumeApifyRuns(s.ctx, { runtime: RT })).status).toBe('dry_run');
    expect(s.fake.calls).toHaveLength(0);
    expect(reservation(s)?.status).toBe('unresolved');
  });
});

describe('partial results, unknown charges, and configured limits', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  it('quarantines a SUCCEEDED run that the charge cap stopped early (accept_truncation)', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { usageTotalUsd: 0.05, chargedEventCounts: { init: 1, result: 15 } };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small, maxTotalChargeUsdMicros: 50_000, capPolicy: 'accept_truncation' });
    expect(r.plan).toMatchObject({ capMicros: 50_000, truncationPossible: true, capPolicy: 'accept_truncation' });
    expect(r.plan?.warnings.join(' ')).toMatch(/quarantined as partial/);
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/^partial: charge \$0\.05 reached the \$0\.05 cap .* 15 of 30 results/);
    expect(countRows(s, 'content_signals')).toBe(0);
    expect(reservation(s)).toMatchObject({ status: 'reconciled', actual_usd_micros: 50_000 });
  });

  it('completes an accept_truncation run whose charge stayed clearly below the cap', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { usageTotalUsd: 0.044, chargedEventCounts: { init: 1, result: 12 } };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small, maxTotalChargeUsdMicros: 50_000, capPolicy: 'accept_truncation' });
    expect(r.status).toBe('completed');
  });

  it('quarantines a run whose status message says the charge limit was reached', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { usageTotalUsd: 0.07, chargedEventCounts: { init: 1, result: 25 }, statusMessage: 'Max total charge reached' };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/charge cap was reached/);
  });

  it('quarantines tiered counts that may have reached the cap (tier unknown) instead of assuming completeness', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { chargedEventCounts: { init: 1, result: 15 } }; // no usageTotalUsd: $0.0425..$0.05 against a $0.05 cap
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small, maxTotalChargeUsdMicros: 50_000, capPolicy: 'accept_truncation' });
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/partial \(unverifiable\)/);
    expect(reservation(s)?.status).toBe('unresolved');
  });

  it('fits the default bounds under the default cap (never a silently truncated run) and can refuse instead', async () => {
    s = await inspected({ dryRun: true }); // default research.apify: maxItems 50, maxCommentsPerPost 10, cap $1.00
    const r = await runContentResearch(s.ctx, { runtime: RT });
    expect(r.status).toBe('dry_run');
    expect(r.plan?.boundsLowered).toEqual({ from: { posts: 50, comments: 500 }, to: { posts: 50, comments: 400 } });
    expect(r.plan?.input).toMatchObject({ maxPostsCount: 50, maxCommentsPerPost: 8 });
    expect(r.plan?.estimate.upperBoundMicros).toBe(920_000);
    expect(r.plan).toMatchObject({ capMicros: 920_000, truncationPossible: false });
    expect(r.warnings.join(' ')).toMatch(/bounds lowered from 50 posts \+ 500 comments to 50 posts \+ 400 comments/);
    const refused = await runContentResearch(s.ctx, { runtime: RT, capPolicy: 'refuse' });
    expect(refused.status).toBe('rejected');
    expect(refused.detail).toMatch(/exceeds the charge cap/);
    const kept = await runContentResearch(s.ctx, { runtime: RT, capPolicy: 'accept_truncation' });
    expect(kept.plan).toMatchObject({ bounds: { results: 550 }, capMicros: 1_000_000, truncationPossible: true });
  });

  it('quarantines a run whose RUN-SUMMARY reports failed requests (coverage incomplete)', async () => {
    s = await inspected();
    const r1 = await runContentResearch(s.ctx, { runtime: RT, ...small, waitForCompletion: false });
    const kvId = s.fake.runs.get(r1.remoteRunId!)!.run.defaultKeyValueStoreId as string;
    s.fake.kv.set(kvId, { ...s.fake.kv.get(kvId), 'RUN-SUMMARY': { itemsTotal: 14, requests: { finished: 3, failed: 7, retries: 4 } } });
    const r = await resumeApifyRuns(s.ctx, { runtime: RT, waitForCompletion: true });
    expect(r.runs[0]).toMatchObject({ status: 'quarantined' });
    expect(r.runs[0]!.quarantineReason).toMatch(/partial: RUN-SUMMARY reports 7 failed request/);
    expect(countRows(s, 'content_signals')).toBe(0);
  });

  it('keeps empty charged-event counts unknown (never $0) and re-checks them on resume', async () => {
    s = await inspected();
    const flat = structuredClone(s.fake.actor.pricingInfos[1]);
    flat.pricingPerEvent.actorChargeEvents.result = { eventTitle: 'Result Saved', eventPriceUsd: 0.002, isPrimaryEvent: true };
    s.fake.actor = { ...s.fake.actor, pricingInfos: [flat] };
    s.fake.nextFinalFields = { chargedEventCounts: {} };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('completed');
    expect(r.cost?.costStatus).toBe('unknown');
    expect(r.warnings.join(' ')).toMatch(/charged event counts are empty/i);
    expect(reservation(s)).toMatchObject({ status: 'unresolved', actual_usd_micros: null, cost_status: 'unknown' });
    s.fake.runs.get(r.remoteRunId!)!.finalFields = { chargedEventCounts: { init: 1, result: 12 } };
    const resumed = await resumeApifyRuns(s.ctx, { runtime: RT });
    expect(resumed.usageReconciled[0]).toMatchObject({ status: 'reconciled', actualMicros: 20_000 + 12 * 2_000 });
  });

  it('treats a $0 usage report for a run that saved results as preliminary', async () => {
    s = await inspected();
    s.fake.nextFinalFields = { usageTotalUsd: 0, chargedEventCounts: { init: 1, result: 12 } };
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.cost?.costStatus).toBe('unknown');
    expect(r.warnings.join(' ')).toMatch(/\$0 for a run that ran/);
    expect(reservation(s)?.status).toBe('unresolved');
  });

  it('enforces the configured time range as a ceiling (range and date filters)', async () => {
    s = await inspected({ dryRun: true, apify: { timeRange: 'week' } });
    const wider = await runContentResearch(s.ctx, { runtime: RT, ...small, timeRange: 'all' });
    expect(wider.status).toBe('rejected');
    expect(wider.errors?.join(' ')).toMatch(/broader than the configured research\.apify\.timeRange "week"/);
    const old = await runContentResearch(s.ctx, { runtime: RT, ...small, postedAfter: '2005-01-01' });
    expect(old.status).toBe('rejected');
    expect(old.errors?.join(' ')).toMatch(/postedAfter 2005-01-01 is outside the configured time range .* 2026-09-17 or later/);
    const before = await runContentResearch(s.ctx, { runtime: RT, ...small, postedBefore: '2026-01-01' });
    expect(before.status).toBe('rejected');
    const ok = await runContentResearch(s.ctx, { runtime: RT, ...small, postedAfter: '2026-09-20' });
    expect(ok.status).toBe('dry_run');
    expect(ok.plan?.input).toMatchObject({ searchTime: 'week', postedAfter: '2026-09-20' });
    const narrower = await runContentResearch(s.ctx, { runtime: RT, ...small, timeRange: 'day' });
    expect(narrower.plan?.timeWindow).toEqual({ timeRange: 'day', earliestDate: '2026-09-23' });
    const urls = await runContentResearch(s.ctx, { runtime: RT, ...small, extraInput: { subredditUrls: ['r/a'], startUrls: [{ url: 'https://reddit.example.test/user/someone/' }] } });
    expect(urls.status).toBe('rejected');
    expect(urls.errors?.join(' ')).toMatch(/not supported/);
  });
});

describe('synthetic dataset ingestion (demo path)', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());
  it('flags rows as synthetic and never touches budgets or the network', () => {
    s = apifyContext();
    const r = ingestSyntheticDataset(s.ctx, fixtureItems(), { label: 'demo fixture', timeRange: 'month' });
    expect(r.signals.created).toBe(8);
    const rows = s.ctx.db.all<{ is_synthetic: number; limitations: string }>('SELECT is_synthetic, limitations FROM content_signals WHERE site_id = ?', [s.ctx.siteId]);
    expect(rows.every((x) => x.is_synthetic === 1 && x.limitations.startsWith('SYNTHETIC FIXTURE DATA'))).toBe(true);
    expect(listApifyRuns(s.ctx)[0]).toMatchObject({ isSynthetic: true, processingStatus: 'complete' });
    expect(countRows(s, 'budget_reservations')).toBe(0);
    expect(s.fake.calls).toHaveLength(0);
  });
});

describe('FakeApify sanity', () => {
  it('rejects runs without a token (as the live API does)', async () => {
    const fake = new FakeApify();
    const res = await fake.fetch('https://api.apify.com/v2/actors/9sHOY9RzPYGjmTHo8/runs', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('output schema drift (A5-04: never complete-and-reuse a run the normalizer cannot read)', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  /** SYNTHETIC fixture items with the dataType field renamed (as after an actor output change). */
  const renamed = () => fixtureItems().map((it: Record<string, unknown>) => {
    const { dataType, ...rest } = it;
    return { ...rest, kind: dataType };
  });

  it('detects structural drift only when most items lack a documented dataType or an id', () => {
    expect(outputSchemaDrift([])).toBeNull();
    expect(outputSchemaDrift(fixtureItems())).toBeNull(); // user_profile/community items are documented, not drift
    const d = outputSchemaDrift(renamed())!;
    expect(d.counts).toMatchObject({ fetched: 14, structural: 14, missingDataType: 14 });
    expect(outputSchemaDrift([{ dataType: 'Post', id: 'a' }, { dataType: 'Post', id: 'b' }, { dataType: 'post', id: 'c' }])!.detail).toMatch(/undocumented dataType \("Post"\)/);
    expect(outputSchemaDrift([{ dataType: 'post', id: 'a' }, { dataType: 'post' }, { dataType: 'comment', id: 'c' }])).toBeNull(); // a minority
  });

  it('quarantines a paid run whose dataType was renamed (charge still reconciled) and does not reuse it', async () => {
    s = await inspected();
    s.fake.nextItems = renamed();
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/^output schema drift: 14 of 14 dataset item\(s\) could not be read by the normalizer \(14 without dataType/);
    expect(r.detail).toMatch(/never reused/);
    expect(countRows(s, 'content_signals')).toBe(0);
    expect(reservation(s)).toMatchObject({ status: 'reconciled', actual_usd_micros: 50_000 });
    const row = s.ctx.db.get<{ processing_status: string; items_normalized: number; quarantine_reason: string }>('SELECT processing_status, items_normalized, quarantine_reason FROM apify_runs WHERE site_id = ?', [s.ctx.siteId])!;
    expect(row).toMatchObject({ processing_status: 'quarantined', items_normalized: 0 });
    expect(s.ctx.db.get(`SELECT id FROM audit_events WHERE event_type = 'apify.output_schema_drift'`)).toBeTruthy();
    // The next identical request is a fresh paid run (the quarantined run is never "reused").
    s.fake.nextItems = fixtureItems();
    const again = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(again.status).toBe('completed');
    expect(s.fake.startCount).toBe(2);
  });

  it('never reuses a completed run with zero normalized items', async () => {
    s = await inspected();
    // Only documented but unused item types (communities/profiles): complete, 0 normalized.
    s.fake.nextItems = fixtureItems().filter((it: { dataType: string }) => it.dataType === 'community' || it.dataType === 'user_profile');
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('completed');
    expect(r.items?.normalized).toBe(0);
    s.fake.nextItems = fixtureItems();
    const again = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(again.status).toBe('completed');
    expect(s.fake.startCount).toBe(2);
    // A run with normalized items IS reused.
    const third = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(third.status).toBe('reused');
    expect(s.fake.startCount).toBe(2);
  });

  it('refuses to run a pinned build whose published output schema lacks required fields', async () => {
    const fake = new FakeApify();
    fake.builds.set(BUILD_ID, buildObject({ outputFields: OUTPUT_FIELDS.filter((f) => f !== 'dataType') }));
    s = await inspected({ fake });
    const r = await runContentResearch(s.ctx, { runtime: RT, ...small });
    expect(r.status).toBe('misconfigured');
    expect(r.detail).toMatch(/Output schema drift: .*lacks required field\(s\) dataType/);
    expect(s.fake.startCount).toBe(0);
  });
});

describe('content research batch (apify research): one bounded run per community, bound to the plan shown', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  it('plans one run per community with the total cap split, then runs exactly the plan', async () => {
    s = await inspected({ seedTopics: ['invoicing software', 'invoice reminders'] });
    const opts = { runtime: RT, ...small, communities: ['smallbusiness', 'r/freelance', 'SmallBusiness'], totalCapMicros: 120_000 };
    const plan = await planContentResearchBatch(s.ctx, opts);
    expect(plan.status).toBe('dry_run');
    expect(plan.runs.map((r) => r.community)).toEqual(['smallbusiness', 'r/freelance']); // deduplicated
    expect(plan.perRunCapMicros).toBe(60_000);
    expect(plan.runs.every((r) => r.result.plan!.capMicros <= 60_000)).toBe(true);
    expect(plan.plannedCapMicros).toBeLessThanOrEqual(120_000);
    expect(plan.runs[0]!.result.plan!.input).toMatchObject({ withinCommunity: 'smallbusiness', searchTerms: ['invoicing software', 'invoice reminders'] });
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.fake.startCount).toBe(0);
    expect(countRows(s, 'budget_reservations')).toBe(0);

    const done = await runContentResearchBatch(s.ctx, opts, plan);
    expect(done.status).toBe('completed');
    expect(s.fake.startCount).toBe(2);
    const bodies = s.fake.callsTo('POST', /\/runs$/).map((c) => JSON.parse(c.body!).withinCommunity);
    expect(bodies).toEqual(['smallbusiness', 'r/freelance']);
    for (const post of s.fake.callsTo('POST', /\/runs$/)) expect(Number(new URL(post.url).searchParams.get('maxTotalChargeUsd'))).toBeLessThanOrEqual(0.06);
  });

  it('refuses community values that are not subreddit names and never starts an unplanned batch', async () => {
    s = await inspected();
    const bad = await planContentResearchBatch(s.ctx, { runtime: RT, ...small, communities: ['https://evil.example/r/x'], totalCapMicros: 50_000 });
    expect(bad.status).toBe('rejected');
    expect(bad.errors[0]).toMatch(/not a subreddit name/);
    const r = await runContentResearchBatch(s.ctx, { runtime: RT, ...small, totalCapMicros: 50_000 }, bad);
    expect(r.status).toBe('rejected');
    expect(s.fake.startCount).toBe(0);
  });

  it('stops the batch when a run is refused and never exceeds the total cap', async () => {
    s = await inspected({ mode: 'ANALYZE' });
    const opts = { runtime: RT, ...small, communities: ['smallbusiness', 'freelance'], totalCapMicros: 100_000 };
    const plan = await planContentResearchBatch(s.ctx, opts);
    const r = await runContentResearchBatch(s.ctx, opts, plan);
    expect(r.status).toBe('stopped');
    expect(r.runs[0]!.result.status).toBe('policy_denied');
    expect(r.runs[1]!.result).toMatchObject({ status: 'rejected' });
    expect(r.runs[1]!.result.detail).toMatch(/Not started/);
    expect(s.fake.startCount).toBe(0);
  });

  it('passes the injected classifier to every run (heuristics remain the fallback)', async () => {
    s = await inspected();
    const seen: number[] = [];
    const classifier = async (items: Array<{ key: string }>) => {
      seen.push(items.length);
      return null;
    };
    const opts = { runtime: RT, ...small, communities: ['smallbusiness'], totalCapMicros: 80_000, classifier };
    const r = await runContentResearchBatch(s.ctx, opts, await planContentResearchBatch(s.ctx, opts));
    expect(r.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(r.runs[0]!.result.detail).toMatch(/heuristic-en@1/);
  });
});
