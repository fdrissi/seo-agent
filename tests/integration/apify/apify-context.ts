import type { RuntimeMode } from '../../../src/core/modes.js';
import type { EnvKey } from '../../../src/config/env.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import { inspectActor } from '../../../src/integrations/apify/schema.js';
import type { ApifyRuntimeOptions } from '../../../src/integrations/apify/runs.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { FakeApify, TEST_TOKEN } from '../../fixtures/apify/fake-apify.js';

/** Instant runtime for tests: no real sleeping, no server-side waits. */
export const RT: ApifyRuntimeOptions = { sleep: async () => {}, pollWaitSecs: 0, stableUsageDelayMs: 0 };

export interface ApifyTestSetup {
  ctx: TestContext;
  fake: FakeApify;
}

/** Synthetic site with the apify feature on, a pinned build, a token, and the fake Apify API. */
export function apifyContext(
  o: {
    fake?: FakeApify;
    build?: string | null;
    secrets?: Partial<Record<EnvKey, string>>;
    noToken?: boolean;
    mode?: RuntimeMode;
    dryRun?: boolean;
    features?: SiteConfigInput['features'];
    apify?: Record<string, unknown>;
    budgets?: SiteConfigInput['budgets'];
    seedTopics?: string[];
    profile?: 'demo' | 'core' | 'full';
  } = {},
): ApifyTestSetup {
  const fake = o.fake ?? new FakeApify();
  const config = testSiteConfig({
    ...(o.profile ? { profile: o.profile } : {}),
    features: o.features ?? { apify: true },
    research: {
      seedTopics: o.seedTopics ?? ['invoicing software'],
      apify: { build: o.build === undefined ? '0.0.513' : o.build, ...(o.apify ?? {}) },
    } as SiteConfigInput['research'],
    ...(o.budgets ? { budgets: o.budgets } : {}),
  });
  const ctx = createTestContext({
    config,
    secrets: { ...(o.noToken ? {} : { APIFY_TOKEN: TEST_TOKEN }), ...(o.secrets ?? {}) },
    fetch: fake.fetch,
    mode: o.mode ?? 'RESEARCH',
    ...(o.dryRun !== undefined ? { dryRun: o.dryRun } : {}),
  });
  return { ctx, fake };
}

/** Inspect (free reads) so the pinned build's schema is stored and verified, then clear recorded calls. */
export async function inspected(o: Parameters<typeof apifyContext>[0] = {}): Promise<ApifyTestSetup> {
  const s = apifyContext(o);
  await inspectActor(s.ctx, { clientOptions: { sleep: async () => {} } });
  s.fake.calls.length = 0;
  return s;
}
