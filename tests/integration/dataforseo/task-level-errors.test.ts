/**
 * Task-level errors inside HTTP 200 on the FREE GET endpoints (lookups,
 * tasks_ready, task_get, user_data). DF13: errors arrive in `status_code` at
 * the response level AND per task. All data is SYNTHETIC.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDataForSeoClient } from '../../../src/integrations/dataforseo/client.js';
import { researchSerps } from '../../../src/integrations/dataforseo/research.js';
import { dataforseoStatus } from '../../../src/integrations/dataforseo/status.js';
import { pollPendingTasks } from '../../../src/integrations/dataforseo/tasks.js';
import type { TaskRow } from '../../../src/integrations/dataforseo/types.js';
import { fakeFetch, jsonResponse, match, type RecordedRequest } from '../../helpers/fake-fetch.js';
import type { TestContext } from '../../helpers/context.js';
import { clockSleep, dfsContext, fakeDataForSeo, taskLevelEnvelope } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const tasks = (c: TestContext) => c.db.all<TaskRow>('SELECT * FROM dataforseo_tasks WHERE site_id = ? ORDER BY created_at', [c.siteId]);
const lookupCacheRows = (c: TestContext) => c.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM research_cache WHERE site_id = ? AND endpoint LIKE 'serp/google/locations%'`, [c.siteId])!.n;

describe('free GETs: task-level errors inside HTTP 200', () => {
  it('raises a non-retryable task-level error (40104) instead of returning an empty result, without retrying', async () => {
    const f = fakeFetch([match('GET', /languages$/, () => jsonResponse(taskLevelEnvelope(40104, 'Account verification required. (synthetic)')))]);
    ctx = dfsContext({ fetch: f });
    const err = await createDataForSeoClient(ctx, { sleep: clockSleep(ctx) })
      .getFree('serp/google/languages')
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'PERMISSION_DENIED', level: 'task', dfsStatusCode: 40104 });
    expect(f.calls).toHaveLength(1);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM provider_requests')!.status).toBe('failed');
  });

  it('retries a transient task-level error (50000) like a response-level one, then succeeds', async () => {
    let n = 0;
    const ok = taskLevelEnvelope(20000, 'Ok.', [{ language_name: 'English', language_code: 'en' }]);
    const f = fakeFetch([match('GET', /languages$/, () => jsonResponse(++n === 1 ? taskLevelEnvelope(50000, 'Internal Error. (synthetic)') : ok))]);
    ctx = dfsContext({ fetch: f });
    const r = await createDataForSeoClient(ctx, { sleep: clockSleep(ctx) }).getFree<{ language_code: string }>('serp/google/languages');
    expect(r.envelope.tasks[0]!.result![0]!.language_code).toBe('en');
    expect(f.calls).toHaveLength(2);
  });

  it('treats a 20000 response without any task as a failure, not as empty data', async () => {
    const f = fakeFetch([match('GET', /languages$/, () => jsonResponse({ status_code: 20000, status_message: 'Ok.', cost: 0, tasks: [] }))]);
    ctx = dfsContext({ fetch: f });
    const err = await createDataForSeoClient(ctx).getFree('serp/google/languages').catch((e) => e);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toMatch(/no task/);
  });

  it('a task-level error on the location lookup is NOT cached as an empty list: research is skipped honestly and recovers on the next run', async () => {
    let broken = true;
    const fake = fakeDataForSeo({
      before: [(req: RecordedRequest) => (broken && req.method === 'GET' && /\/serp\/google\/locations(\/[a-z]{2})?$/.test(req.url) ? jsonResponse(taskLevelEnvelope(50000, 'Internal Error. (synthetic)')) : undefined)],
    });
    ctx = dfsContext({ fetch: fake.fetch });
    const opts = { allowPaid: true, sleep: clockSleep(ctx) };
    const r1 = await researchSerps(ctx, ['synthetic widget pricing'], opts);
    // Not a misleading CONFIG_INVALID ("code not in the list"): the lookup failed, so the code is unverified.
    expect(r1.settings!.verification).toBe('unverified');
    expect(r1.warnings.join(' ')).toMatch(/lookup failed .*50000/);
    expect(r1.queries[0]!.error?.code).toBe('DATA_UNAVAILABLE');
    expect(r1.blockers.map((b) => b.code)).not.toContain('CONFIG_INVALID');
    expect(fake.state.posts).toBe(0);
    expect(lookupCacheRows(ctx)).toBe(0);

    // Provider recovers: the next run looks the codes up again (nothing stale was cached) and submits.
    broken = false;
    ctx.clock.advanceMs(20 * 86_400_000);
    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], opts);
    expect(r2.settings!.verification).toBe('verified');
    expect(r2.queries[0]!.action).toBe('submit');
    expect(fake.state.posts).toBe(1);
    expect(lookupCacheRows(ctx)).toBe(1);
  });

  it('never trusts an empty lookup list (not cached, reported as unavailable)', async () => {
    const empty = taskLevelEnvelope(20000, 'Ok.', []);
    const fake = fakeDataForSeo({ before: [(req) => (req.method === 'GET' && /\/serp\/google\/locations$/.test(req.url) ? jsonResponse(empty) : undefined)] });
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, sleep: clockSleep(ctx) });
    expect(r.settings!.verification).toBe('unverified');
    expect(r.warnings.join(' ')).toMatch(/empty list/);
    expect(lookupCacheRows(ctx)).toBe(0);
    expect(fake.state.posts).toBe(0);
  });

  it('status: a task-level account error in user_data is never reported as ready', async () => {
    const cases: Array<[number, string, string]> = [
      [40104, 'Account verification required. (synthetic)', 'permission_denied'],
      [40210, 'Insufficient funds. (synthetic)', 'degraded'],
      [50000, 'Internal Error. (synthetic)', 'unreachable'],
    ];
    for (const [code, message, state] of cases) {
      const f = fakeFetch([match('GET', /user_data$/, () => jsonResponse(taskLevelEnvelope(code, message)))]);
      ctx = dfsContext({ fetch: f });
      const s = await dataforseoStatus(ctx, { network: true, sleep: clockSleep(ctx) });
      expect(s.state, String(code)).toBe(state);
      expect(s.detail).toMatch(new RegExp(String(code)));
      expect(s.networkChecked).toBe(true);
      expect(s.nextStep).toBeTruthy();
      ctx.cleanup();
      ctx = undefined;
    }
  });

  it('a task-level error from tasks_ready is reported and polling falls back to direct task_get (free)', async () => {
    const fake = fakeDataForSeo({
      before: [(req) => (req.method === 'GET' && req.url.endsWith('/serp/google/organic/tasks_ready') ? jsonResponse(taskLevelEnvelope(40202, 'Rate limit. (synthetic)')) : undefined)],
    });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, sleep: clockSleep(ctx) });
    const s = await pollPendingTasks(ctx, { sleep: clockSleep(ctx) });
    expect(s.errors.join(' ')).toMatch(/tasks_ready .*40202/);
    expect(s.fetched).toHaveLength(1);
    expect(fake.state.posts).toBe(1);
  });
});

describe('task_get: transient task-level errors never cause a second paid POST', () => {
  const taskGetRoute = (state: { failCode: number | null }) => (req: RecordedRequest) => {
    const m = /\/serp\/google\/organic\/task_get\/advanced\/([A-Za-z0-9-]+)$/.exec(req.url);
    if (req.method !== 'GET' || !m || state.failCode === null) return undefined;
    return jsonResponse(taskLevelEnvelope(state.failCode, `synthetic task-level ${state.failCode}`, null, m[1]!));
  };

  it('50000 on task_get keeps the paid task open; the next run reuses it instead of paying again', async () => {
    const state = { failCode: null as number | null };
    const fake = fakeDataForSeo({ before: [taskGetRoute(state)] });
    ctx = dfsContext({ fetch: fake.fetch });
    const opts = { allowPaid: true, sleep: clockSleep(ctx) };
    await researchSerps(ctx, ['synthetic widget pricing'], opts);
    const [t] = tasks(ctx);
    expect(t!.status).toBe('queued');

    state.failCode = 50000;
    const s = await pollPendingTasks(ctx, { sleep: clockSleep(ctx) });
    expect(s.failed).toEqual([]);
    expect(s.pending).toEqual([t!.id]);
    expect(s.errors.join(' ')).toMatch(/task-level 50000 .*never resubmitted/);
    expect(tasks(ctx)[0]!.status).toBe('ready');

    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], opts);
    expect(r2.queries[0]!.action).toBe('reuse_open_task');
    expect(r2.queries[0]!.status).toBe('pending');
    expect(fake.state.posts).toBe(1);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM budget_reservations')!.n).toBe(1);

    // Provider recovers: the already-paid result is fetched for free.
    state.failCode = null;
    const s2 = await pollPendingTasks(ctx, { sleep: clockSleep(ctx) });
    expect(s2.fetched).toEqual([t!.id]);
    const r3 = await researchSerps(ctx, ['synthetic widget pricing'], opts);
    expect(r3.queries[0]!.status).toBe('cached');
    expect(fake.state.posts).toBe(1);
  });

  it('rate-limit and account-level task codes are transient too (kept open, retried later)', async () => {
    for (const code of [40202, 40209, 40200, 50303]) {
      const state = { failCode: null as number | null };
      const fake = fakeDataForSeo({ before: [taskGetRoute(state)] });
      ctx = dfsContext({ fetch: fake.fetch });
      await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, sleep: clockSleep(ctx) });
      state.failCode = code;
      const s = await pollPendingTasks(ctx, { sleep: clockSleep(ctx) });
      expect(s.failed, String(code)).toEqual([]);
      expect(tasks(ctx)[0]!.status, String(code)).not.toBe('failed');
      ctx.cleanup();
      ctx = undefined;
    }
  });

  it('a definitive task failure (40103 "resubmit") is marked failed, so the owner can research again', async () => {
    const state = { failCode: null as number | null };
    const fake = fakeDataForSeo({ before: [taskGetRoute(state)] });
    ctx = dfsContext({ fetch: fake.fetch });
    const opts = { allowPaid: true, sleep: clockSleep(ctx) };
    await researchSerps(ctx, ['synthetic widget pricing'], opts);
    state.failCode = 40103;
    const s = await pollPendingTasks(ctx, { sleep: clockSleep(ctx) });
    expect(s.failed).toHaveLength(1);
    expect(tasks(ctx)[0]).toMatchObject({ status: 'failed', api_status_code: 40103 });
    state.failCode = null;
    const r = await researchSerps(ctx, ['synthetic widget pricing'], opts);
    expect(r.queries[0]!.action).toBe('submit');
    expect(fake.state.posts).toBe(2);
  });

  it('a transient error that persists past the 30-day retrieval window finally marks the task failed', async () => {
    const state = { failCode: null as number | null };
    const fake = fakeDataForSeo({ before: [taskGetRoute(state)] });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, sleep: clockSleep(ctx) });
    state.failCode = 50000;
    ctx.clock.advanceMs(31 * 86_400_000);
    const s = await pollPendingTasks(ctx, { sleep: clockSleep(ctx) });
    expect(s.failed).toHaveLength(1);
    expect(tasks(ctx)[0]!.api_status_message).toMatch(/30-day retrieval window/);
  });
});
