import { afterEach, describe, expect, it } from 'vitest';
import { createDataForSeoClient } from '../../../src/integrations/dataforseo/client.js';
import { researchSerps } from '../../../src/integrations/dataforseo/research.js';
import { abandonAmbiguousTask, listTasks, pollPendingTasks } from '../../../src/integrations/dataforseo/tasks.js';
import type { TaskRow } from '../../../src/integrations/dataforseo/types.js';
import type { TestContext } from '../../helpers/context.js';
import { clockSleep, dfsConfig, dfsContext, fakeDataForSeo } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const tasks = (c: TestContext) => c.db.all<TaskRow>('SELECT * FROM dataforseo_tasks WHERE site_id = ? ORDER BY created_at', [c.siteId]);
const reservations = (c: TestContext) => c.db.all<{ id: string; status: string; estimated_usd_micros: number; actual_usd_micros: number | null; cost_status: string }>('SELECT * FROM budget_reservations WHERE site_id = ?', [c.siteId]);
const ledger = (c: TestContext) => c.db.all<{ amount_usd_micros: number | null; amount_status: string; provider_request_id: string }>('SELECT * FROM cost_ledger WHERE site_id = ?', [c.siteId]);

describe('DataForSEO paid task lifecycle', () => {
  it('persists the task row (submitting) and the provider request BEFORE the POST, and the remote id before polling', async () => {
    const seen: Array<{ phase: string; rows: TaskRow[]; pr: Array<{ status: string; reservation_id: string | null }> }> = [];
    const fake = fakeDataForSeo({
      ready: false,
      onPost: () => seen.push({ phase: 'post', rows: tasks(ctx!), pr: ctx!.db.all('SELECT status, reservation_id FROM provider_requests WHERE is_paid = 1') }),
      onTasksReady: () => seen.push({ phase: 'ready', rows: tasks(ctx!), pr: [] }),
    });
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.queries[0]!.status).toBe('pending');
    const atPost = seen.find((s) => s.phase === 'post')!;
    expect(atPost.rows).toHaveLength(1);
    expect(atPost.rows[0]!.status).toBe('submitting');
    expect(atPost.rows[0]!.remote_task_id).toBeNull();
    expect(atPost.pr[0]!.status).toBe('submitted');
    expect(atPost.pr[0]!.reservation_id).toMatch(/^res_/);
    // The tag sent to the provider is the local task id.
    const body = JSON.parse(fake.postCalls()[0]!.body!);
    expect(body[0].tag).toBe(atPost.rows[0]!.id);

    const after = tasks(ctx)[0]!;
    expect(after.status).toBe('queued');
    expect(after.remote_task_id).toMatch(/^00000000-/);
    expect(after.cost_usd_micros).toBe(600);

    await pollPendingTasks(ctx);
    const atReady = seen.find((s) => s.phase === 'ready')!;
    expect(atReady.rows[0]!.remote_task_id).toBe(after.remote_task_id);
  });

  it('marks a timed-out POST ambiguous, keeps the charge reserved, and never resubmits', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'timeout' });
    ctx = dfsContext({ fetch: fake.fetch });
    const r1 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, requestTimeoutMs: 30 });
    expect(r1.queries[0]!.status).toBe('ambiguous');
    expect(r1.submissions[0]!.state).toBe('ambiguous');
    const [t] = tasks(ctx);
    expect(t!.status).toBe('ambiguous');
    expect(ctx.db.get<{ status: string }>('SELECT status FROM provider_requests WHERE id = ?', [t!.provider_request_id])!.status).toBe('ambiguous');
    const [res] = reservations(ctx);
    expect(res).toMatchObject({ status: 'unresolved', cost_status: 'unknown', estimated_usd_micros: 600 });
    expect(ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'dataforseo')!.unknownCount).toBe(1);

    // Run again: the open ambiguous task is reused, NOT resubmitted. Reconciliation finds nothing yet.
    fake.setPostBehavior('ok');
    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(fake.state.posts).toBe(1);
    expect(r2.queries[0]!.action).toBe('reuse_open_task');
    expect(r2.queries[0]!.status).toBe('ambiguous');
  });

  it('reconciles an ambiguous submission by its tag in tasks_ready and fetches the result without a second POST', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'drop_tasks' });
    ctx = dfsContext({ fetch: fake.fetch });
    // Two tasks in one POST; the provider response omits the first one -> that task is ambiguous.
    const r = await researchSerps(ctx, ['synthetic widget pricing', 'synthetic gadget review'], { allowPaid: true });
    const statuses = tasks(ctx).map((t) => t.status).sort();
    expect(statuses).toEqual(['ambiguous', 'queued']);
    expect(r.submissions[0]!.actualMicros).toBeNull(); // incomplete response: charge unknown, not 0
    expect(reservations(ctx)[0]!.status).toBe('unresolved');

    const s = await pollPendingTasks(ctx);
    expect(s.reconciled).toHaveLength(1);
    expect(s.fetched).toHaveLength(2);
    expect(tasks(ctx).every((t) => t.status === 'fetched')).toBe(true);
    expect(fake.state.posts).toBe(1);
    // The request is reconciled; the charge for the lost task stays unresolved (never assumed $0).
    expect(ctx.db.get<{ status: string }>("SELECT status FROM provider_requests WHERE is_paid = 1")!.status).toBe('reconciled');
    expect(reservations(ctx)[0]!.status).toBe('unresolved');
  });

  it('treats a network error after sending and HTTP 500 on POST as ambiguous (never retried)', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'network_error' });
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.queries[0]!.status).toBe('ambiguous');
    expect(fake.state.posts).toBe(1);
    fake.setPostBehavior('http500');
    const r2 = await researchSerps(ctx, ['synthetic gadget review'], { allowPaid: true });
    expect(r2.queries[0]!.status).toBe('ambiguous');
    expect(fake.state.posts).toBe(2);
  });

  it('handles a task-level error inside HTTP 200: task failed, provider-reported cost reconciled', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'task_error' });
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.queries[0]!.status).toBe('failed');
    expect(r.queries[0]!.error?.message).toMatch(/40501/);
    expect(tasks(ctx)[0]).toMatchObject({ status: 'failed', api_status_code: 40501 });
    expect(reservations(ctx)[0]).toMatchObject({ status: 'reconciled', actual_usd_micros: 0 });
  });

  it('handles a response-level error inside HTTP 200 (insufficient funds): rejected, not retried, no fake charge', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'response_error' });
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.submissions[0]!.state).toBe('rejected');
    expect(r.submissions[0]!.error?.message).toMatch(/40210/);
    expect(r.queries[0]!.status).toBe('failed');
    expect(fake.state.posts).toBe(1);
    expect(reservations(ctx)[0]).toMatchObject({ status: 'reconciled', actual_usd_micros: 0 });
  });

  it('releases the reservation when HTTP 401 proves the request was not accepted', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'http401' });
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.submissions[0]!.state).toBe('rejected');
    expect(r.submissions[0]!.error?.code).toBe('PERMISSION_DENIED');
    expect(reservations(ctx)[0]!.status).toBe('reconciled'); // provider-reported cost 0 in the documented 401 body
    expect(reservations(ctx)[0]!.actual_usd_micros).toBe(0);
  });

  it('does not double count response-level and task-level costs; free task_get does not change spend', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.0006 });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing', 'synthetic gadget review'], { allowPaid: true });
    // Response-level cost 0.0012 = sum of the two task costs; only the task-level sum is recorded.
    expect(ledger(ctx)).toHaveLength(1);
    expect(ledger(ctx)[0]).toMatchObject({ amount_usd_micros: 1200, amount_status: 'actual' });
    await pollPendingTasks(ctx);
    expect(tasks(ctx).every((t) => t.status === 'fetched')).toBe(true);
    expect(ledger(ctx)).toHaveLength(1);
    expect(ledger(ctx)[0]!.amount_usd_micros).toBe(1200);
    const spend = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'dataforseo')!;
    expect(spend.actualMicros).toBe(1200);
    expect(spend.committedMicros).toBe(1200);
  });

  it('parallel research runs cannot overspend a cap: reservations are atomic', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ budgets: { dataforseo: { weeklyUsd: '0.001', monthlyUsd: '10.00', perRunUsd: '0.50' } } }) });
    const results = await Promise.all([
      researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true }),
      researchSerps(ctx, ['synthetic gadget review'], { allowPaid: true }),
      researchSerps(ctx, ['synthetic third query'], { allowPaid: true }),
    ]);
    const codes = results.map((r) => r.queries[0]!.error?.code ?? r.queries[0]!.status);
    expect(codes.filter((c) => c === 'pending')).toHaveLength(1);
    expect(codes.filter((c) => c === 'BUDGET_EXCEEDED')).toHaveLength(2);
    expect(fake.state.posts).toBe(1);
    const week = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'dataforseo')!.weekly!;
    expect(week.committedMicros).toBeLessThanOrEqual(week.limitMicros);
  });

  it('records a price change truthfully (actual above estimate is flagged, not hidden)', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.0012 });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(reservations(ctx)[0]).toMatchObject({ estimated_usd_micros: 600, actual_usd_micros: 1200, status: 'reconciled' });
    const usage = JSON.parse(ctx.db.get<{ usage_json: string }>('SELECT usage_json FROM cost_ledger')!.usage_json);
    expect(usage.overshootMicros).toBe(600);
  });

  it('keeps an unreported task cost unknown (null), never $0', async () => {
    const fake = fakeDataForSeo({ taskCost: null, responseCost: 0.0006 });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(reservations(ctx)[0]).toMatchObject({ status: 'unresolved', actual_usd_micros: null, cost_status: 'unknown' });
    expect(ledger(ctx)[0]).toMatchObject({ amount_usd_micros: null, amount_status: 'unknown' });
  });

  it('a local wait timeout leaves tasks queued; the next run resumes polling without resubmitting', async () => {
    const fake = fakeDataForSeo({ ready: false, pendingUntilReady: true });
    ctx = dfsContext({ fetch: fake.fetch });
    const r1 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 90_000, pollIntervalMs: 30_000, sleep: clockSleep(ctx) });
    expect(r1.queries[0]!.status).toBe('pending');
    expect(r1.warnings.join(' ')).toMatch(/NOT resubmitted/);
    expect(tasks(ctx)[0]!.status).toBe('queued');
    expect(fake.state.tasksReadyCalls).toBeGreaterThan(1);

    // Next run (provider finished meanwhile): reuse + poll, no second POST.
    fake.setReady(true);
    ctx.clock.advanceMs(20 * 60_000);
    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(fake.state.posts).toBe(1);
    expect(r2.queries[0]).toMatchObject({ action: 'reuse_open_task', status: 'fetched', ownRank: 5 });
    expect(r2.queries[0]!.competitorUrls.length).toBe(5);
  });

  it('pollPendingTasks turns stale submitting rows (crash mid-POST) into ambiguous and never resubmits', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const now = ctx.clock.now().toISOString();
    ctx.db.run(
      `INSERT INTO dataforseo_tasks (id, site_id, endpoint, tag, parameter_hash, params_json, status, is_sandbox, created_at, updated_at)
       VALUES ('dfst_crash', ?, 'serp/google/organic/task_post', 'dfst_crash', 'h', ?, 'submitting', 0, ?, ?)`,
      [ctx.siteId, JSON.stringify({ task: { keyword: 'q' }, meta: { kind: 'serp', mode: 'live', queue: 'standard', purpose: 't', runId: 'r', query: 'q' } }), now, now],
    );
    ctx.clock.advanceMs(20 * 60_000);
    const s = await pollPendingTasks(ctx);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM dataforseo_tasks WHERE id = 'dfst_crash'")!.status).toBe('ambiguous');
    expect(s.ambiguous).toContain('dfst_crash');
    expect(fake.state.posts).toBe(0);
    expect(listTasks(ctx).map((t) => t.id)).toContain('dfst_crash');
  });

  it('abandoning an ambiguous task unblocks research but keeps its charge reserved as unresolved', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'timeout' });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, requestTimeoutMs: 30 });
    const id = tasks(ctx)[0]!.id;
    expect(() => abandonAmbiguousTask(ctx!, 'dfst_missing')).toThrow(/not found/);
    abandonAmbiguousTask(ctx, id);
    expect(tasks(ctx)[0]!.status).toBe('failed');
    expect(reservations(ctx)[0]!.status).toBe('unresolved');
    fake.setPostBehavior('ok');
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(fake.state.posts).toBe(2);
  });

  it('live queue (config queue = live, with a recorded justification) posts one task to live/advanced without a tag and stores the result immediately', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.002 });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { queue: 'live', liveQueueJustification: 'Same-day SERP answers for a synthetic launch (test)' } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing', 'synthetic gadget review'], { allowPaid: true });
    const posts = fake.postCalls();
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.url.endsWith('/serp/google/organic/live/advanced'))).toBe(true);
    for (const p of posts) {
      const body = JSON.parse(p.body!);
      expect(body).toHaveLength(1);
      expect(body[0].tag).toBeUndefined();
      expect(body[0].priority).toBeUndefined();
    }
    expect(r.queries.every((q) => q.status === 'fetched')).toBe(true);
    expect(fake.state.tasksReadyCalls).toBe(0);
    expect(ledger(ctx).reduce((s, l) => s + (l.amount_usd_micros ?? 0), 0)).toBe(4000);
  });

  it('client creation for polling works even after config mode is set back to disabled (free retrieval of paid results)', async () => {
    const fake = fakeDataForSeo({ ready: false });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    (ctx.config.research.dataforseo as { mode: string }).mode = 'disabled';
    fake.setReady(true);
    const s = await pollPendingTasks(ctx);
    expect(s.fetched).toHaveLength(1);
    expect(() => createDataForSeoClient(ctx!)).toThrow(/disabled/);
  });
});
