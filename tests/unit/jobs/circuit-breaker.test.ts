import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../src/core/errors.js';
import { GoogleApiError, googleErrorFromUnknown } from '../../../src/integrations/google/errors.js';
import { CircuitBreakers, CircuitOpenError } from '../../../src/jobs/circuit-breaker.js';
import { countsAsProviderFailure } from '../../../src/workflows/errors.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

const providerError = () => new AppError('PROVIDER_ERROR', 'HTTP 503 from synthetic provider');

describe('circuit breakers (per site, per provider, persisted)', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
  });
  afterEach(() => ctx.cleanup());

  it('opens after N consecutive failures, half-opens for one probe after the cooldown, and closes on success', () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 3, cooldownMs: 10 * 60_000 });
    expect(b.canRequest('dataforseo')).toEqual({ allowed: true, probe: false });
    b.recordFailure('dataforseo', providerError());
    b.recordFailure('dataforseo', providerError());
    expect(b.get('dataforseo')).toMatchObject({ state: 'closed', consecutiveFailures: 2 });
    b.recordFailure('dataforseo', providerError());
    expect(b.get('dataforseo')).toMatchObject({ state: 'open', consecutiveFailures: 3, nextProbeAt: '2026-09-24T09:10:00.000Z' });
    expect(b.canRequest('dataforseo')).toMatchObject({ allowed: false, nextProbeAt: '2026-09-24T09:10:00.000Z' });

    ctx.clock.advanceMs(10 * 60_000);
    expect(b.canRequest('dataforseo')).toEqual({ allowed: true, probe: true });
    expect(b.get('dataforseo').state).toBe('half_open');
    // Only one probe at a time.
    expect(b.canRequest('dataforseo')).toMatchObject({ allowed: false });
    b.recordSuccess('dataforseo');
    expect(b.get('dataforseo')).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    expect(b.canRequest('dataforseo')).toEqual({ allowed: true, probe: false });

    const events = ctx.db.all<{ event_type: string }>("SELECT event_type FROM audit_events WHERE subject_id = 'dataforseo' AND event_type LIKE 'circuit.%' ORDER BY id");
    expect(events.map((e) => e.event_type)).toEqual(['circuit.opened', 'circuit.half_open', 'circuit.closed']);
  });

  it('a failed half-open probe re-opens the breaker for another cooldown', () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 60_000 });
    b.recordFailure('apify', providerError());
    ctx.clock.advanceMs(60_000);
    expect(b.canRequest('apify')).toMatchObject({ allowed: true, probe: true });
    b.recordFailure('apify', providerError());
    expect(b.get('apify')).toMatchObject({ state: 'open', nextProbeAt: '2026-09-24T09:02:00.000Z' });
    expect(b.canRequest('apify').allowed).toBe(false);
  });

  it('a probe that never reports back does not block forever', () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 60_000 });
    b.recordFailure('apify', providerError());
    ctx.clock.advanceMs(60_000);
    expect(b.canRequest('apify').allowed).toBe(true); // probe starts, process "crashes"
    ctx.clock.advanceMs(30_000);
    expect(b.canRequest('apify').allowed).toBe(false);
    ctx.clock.advanceMs(30_000);
    expect(b.canRequest('apify')).toMatchObject({ allowed: true, probe: true });
  });

  it('only provider-health errors count; budget/policy/credential errors do not open the breaker', () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1 });
    b.recordFailure('llm_gateway', new AppError('BUDGET_EXCEEDED', 'cap'));
    b.recordFailure('llm_gateway', new AppError('CREDENTIALS_MISSING', 'no key'));
    b.recordFailure('llm_gateway', new AppError('VALIDATION_FAILED', 'bad output'));
    expect(b.get('llm_gateway').state).toBe('closed');
    b.recordFailure('llm_gateway', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(b.get('llm_gateway').state).toBe('open');
  });

  it('execute() refuses while open and records outcomes; state persists across instances; per-provider policy', async () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 5, perProvider: { pagespeed: { failureThreshold: 1 } } });
    await expect(b.execute('pagespeed', async () => { throw providerError(); })).rejects.toThrow('HTTP 503');
    const again = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 5, perProvider: { pagespeed: { failureThreshold: 1 } } });
    await expect(again.execute('pagespeed', async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(again.execute('crux', async () => 'ok')).resolves.toBe('ok');
    const err = await again.execute('pagespeed', async () => 'ok').catch((e: AppError) => e);
    expect((err as AppError).code).toBe('INTEGRATION_UNAVAILABLE');
    expect(again.list().map((s) => [s.provider, s.state])).toEqual([['pagespeed', 'open']]);
    again.reset('pagespeed');
    expect(again.get('pagespeed').state).toBe('closed');
    expect(() => new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 0 })).toThrow(RangeError);
  });

  it('is isolated per site', () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1 });
    b.recordFailure('apify', providerError());
    ctx.db.run("INSERT INTO sites (id, name, base_url, created_at, updated_at) VALUES ('other-site', 'Other (synthetic)', 'https://other.example.test/', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z')");
    const other = new CircuitBreakers(ctx.db, 'other-site', ctx.clock, { failureThreshold: 1 });
    expect(other.get('apify').state).toBe('closed');
  });

  // B1-01: an offline run (--offline, demo mode) sends nothing, so it must never open a breaker that
  // then blocks real runs. SYNTHETIC errors shaped like the ones the Google sync stages throw offline.
  describe('offline refusals never open a breaker', () => {
    const offlineGsc = () => new GoogleApiError({ api: 'gsc', status: 0, kind: 'offline', message: 'Network access is disabled for this run (offline/demo mode); no Google request was made.' });
    const offlineGa4 = () => new GoogleApiError({ api: 'ga4', status: 0, kind: 'offline', message: 'Network access is disabled for this run (offline/demo mode); no Google request was made.' });

    it('two offline baselines (sync_gsc + sync_ga4 + inspect_urls refused each time) leave the google breaker closed', async () => {
      const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock); // default policy: opens after 3 failures
      for (let run = 0; run < 2; run++) {
        await expect(b.execute('google', async () => { throw offlineGsc(); })).rejects.toMatchObject({ code: 'OFFLINE' });
        await expect(b.execute('google', async () => { throw offlineGa4(); })).rejects.toMatchObject({ code: 'OFFLINE' });
        await expect(b.execute('google', async () => { throw googleErrorFromUnknown('url_inspection', Object.assign(new Error('Network access is disabled'), { code: 'OFFLINE' })); })).rejects.toMatchObject({ code: 'OFFLINE' });
      }
      expect(b.get('google')).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
      expect(b.peek('google')).toEqual({ allowed: true, probe: false });
      expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'circuit.opened'")!.n).toBe(0);
    });

    it('classifies offline errors as not provider-health failures, whatever code they carry', () => {
      expect(offlineGsc().code).toBe('OFFLINE');
      expect(countsAsProviderFailure(offlineGsc())).toBe(false);
      expect(countsAsProviderFailure(Object.assign(new Error('Network access is disabled in offline/demo mode'), { code: 'OFFLINE' }))).toBe(false);
      // An adapter that keeps a legacy code but records kind "offline" is still excluded.
      expect(countsAsProviderFailure(new AppError('INTEGRATION_UNAVAILABLE', 'offline', { details: { kind: 'offline' } }))).toBe(false);
      // Real transport failures still count.
      expect(countsAsProviderFailure(googleErrorFromUnknown('gsc', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))).toBe(true);
    });

    it('a breaker used by an offline run records nothing and consumes no probe, but still reports an open breaker', async () => {
      const online = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 60_000 });
      const offline = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 60_000, offline: true });
      offline.recordFailure('crawler', providerError());
      await expect(offline.execute('crawler', async () => { throw providerError(); })).rejects.toThrow('HTTP 503');
      expect(offline.get('crawler')).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
      expect(offline.list()).toEqual([]);

      online.recordFailure('crawler', providerError());
      expect(online.get('crawler').state).toBe('open');
      await expect(offline.execute('crawler', async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
      ctx.clock.advanceMs(60_000);
      // Cooldown over: the offline run may call (fixture data), but it is not the half-open probe and changes nothing.
      expect(offline.canRequest('crawler')).toEqual({ allowed: true, probe: true });
      await expect(offline.execute('crawler', async () => 'fixture')).resolves.toBe('fixture');
      expect(online.get('crawler')).toMatchObject({ state: 'open', consecutiveFailures: 1 });
      // The real (online) caller still gets the probe.
      expect(online.canRequest('crawler')).toEqual({ allowed: true, probe: true });
      expect(online.get('crawler').state).toBe('half_open');
    });
  });

  it('the open-breaker hint names `jobs breakers` (and how to reset one), not doctor', async () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 60_000 });
    b.recordFailure('google', providerError());
    const err = (await b.execute('google', async () => 'x').catch((e: unknown) => e)) as CircuitOpenError;
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.hint).toContain('npm run cli -- jobs breakers');
    expect(err.hint).toContain('jobs breakers --reset google');
    expect(err.hint).toContain('2026-09-24T09:01:00.000Z');
    expect(err.hint).not.toMatch(/doctor/);
  });

  it('reset is audited with the actor and the previous state; resetting an unknown provider changes nothing', () => {
    const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1 });
    expect(b.reset('google', 'cli')).toBe(false);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'circuit.reset'")!.n).toBe(0);
    b.recordFailure('google', providerError());
    expect(b.reset('google', 'cli')).toBe(true);
    expect(b.get('google').state).toBe('closed');
    const audit = ctx.db.get<{ actor: string; subject_id: string; details_json: string }>("SELECT actor, subject_id, details_json FROM audit_events WHERE event_type = 'circuit.reset'")!;
    expect(audit).toMatchObject({ actor: 'cli', subject_id: 'google' });
    expect(JSON.parse(audit.details_json)).toMatchObject({ previousState: 'open', consecutiveFailures: 1, lastError: 'PROVIDER_ERROR: HTTP 503 from synthetic provider' });
  });
});
