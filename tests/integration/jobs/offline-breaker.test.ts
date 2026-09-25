import { afterEach, describe, expect, it } from 'vitest';
import type { GoogleAuthProvider } from '../../../src/integrations/google/types.js';
import { CircuitBreakers } from '../../../src/jobs/circuit-breaker.js';
import { runPipeline } from '../../../src/workflows/pipelines/handlers.js';
import type { TestContext } from '../../helpers/context.js';
import { pipelineContext, testEnv } from '../pipelines/helpers.js';

/**
 * B1-01 (spec 27 circuit breakers, spec 29 --offline): running with network
 * access disabled must not open the persisted Google circuit breaker, which
 * would then make the next real (online) run skip GSC/GA4/URL Inspection.
 * SYNTHETIC: a non-fixture ("oauth") Google provider in an offline context, so
 * the sync stages are refused locally exactly as on a live workspace run with
 * --offline; the provider's client must never be requested.
 */

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const offlineOauthProvider = (): GoogleAuthProvider & { clientRequests: number } => {
  const p = {
    mode: 'oauth' as const,
    clientRequests: 0,
    async getClient(): Promise<never> {
      p.clientRequests++;
      throw new Error('synthetic: the Google client must not be requested while offline');
    },
  };
  return p;
};

describe('offline runs and the google circuit breaker', () => {
  it('two offline baselines leave the google breaker closed, so the next run is not blocked', async () => {
    ctx = pipelineContext();
    expect(ctx.offline).toBe(true);
    const provider = offlineOauthProvider();
    const env = testEnv({ googleProvider: provider });
    for (let i = 0; i < 2; i++) {
      const r = await runPipeline(ctx, 'baseline', {}, { env });
      // The Google stages were refused offline (reported, not hidden); nothing reached Google.
      const gsc = r.workflow.stages.find((s) => s.stage === 'sync_gsc');
      expect(gsc?.status, JSON.stringify(r.workflow.stages)).not.toBe('succeeded');
      expect(JSON.stringify(r.workflow)).toMatch(/OFFLINE/);
      expect(JSON.stringify(r.workflow)).not.toMatch(/circuit breaker/);
    }
    expect(provider.clientRequests).toBe(0);
    const breakers = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock);
    expect(breakers.get('google')).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    expect(breakers.peek('google')).toEqual({ allowed: true, probe: false });
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'circuit.opened'", [ctx.siteId])!.n).toBe(0);
  });
});
