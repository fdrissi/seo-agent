import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext } from '../../../src/app/context.js';
import { researchShortlist } from '../../../src/integrations/dataforseo/research.js';
import { researchKeywordVolumes } from '../../../src/integrations/dataforseo/volume.js';
import { competitorUrlsForQuery } from '../../../src/integrations/dataforseo/queries.js';
import { createSyntheticDataForSeoFetch } from '../../../src/integrations/dataforseo/synthetic.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { memoryLogger } from '../../../src/core/logger.js';
import { fixedClock } from '../../../src/core/clock.js';
import type { TestContext } from '../../helpers/context.js';
import { clockSleep, dfsConfig, dfsContext, insertGscQuery } from './helpers.js';

let ctx: TestContext | undefined;
let scratch: string | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('fixture mode (offline demo transport)', () => {
  it('runs the default process offline with synthetic, labeled data and no credentials', async () => {
    ctx = dfsContext({ credentials: false }); // offline context: global fetch is never used
    insertGscQuery(ctx, 'synthetic widget pricing', { isSynthetic: false });
    const fetch = createSyntheticDataForSeoFetch({ ownUrl: 'https://www.example.test/pricing', ownRank: 3 });
    const r = await researchShortlist(ctx, ['synthetic widget pricing'], { mode: 'fixture', fetch, waitMs: 30_000, sleep: clockSleep(ctx) });
    expect(r.mode).toBe('fixture');
    expect(r.status).toBe('completed');
    expect(r.queries[0]).toMatchObject({ ownRank: 3, isSandbox: true, usableForRecommendations: false });
    expect(r.competitorUrls[0]!.url).toMatch(/^https:\/\/competitor-1\.example\//);
    expect(ctx.db.get<{ is_synthetic: number }>("SELECT is_synthetic FROM provider_requests WHERE method = 'POST'")!.is_synthetic).toBe(1);
    const v = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { mode: 'fixture', fetch, waitMs: 30_000, sleep: clockSleep(ctx) });
    expect(v.keywords[0]!.status).toBe('fetched');
    expect(v.keywords[0]!.isSandbox).toBe(true);
  });

  it('refuses sandbox/live in an offline context (fixture transport only)', async () => {
    ctx = dfsContext({});
    const r = await researchShortlist(ctx, [{ query: 'q', origin: 'owner' }], { allowOwnerQueries: true, mode: 'sandbox' });
    expect(r.status).toBe('skipped');
    expect(r.blockers.map((b) => b.code)).toContain('INTEGRATION_UNAVAILABLE');
  });

  it('in a synthetic demo workspace, fixture data is usable by the demo (every row there is synthetic)', async () => {
    ctx = dfsContext({ credentials: false });
    // A demo-profile site never runs in a LIVE workspace (manifest check); this library-level context
    // uses a manifest-less scratch root for its files and shares only the test database.
    scratch = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-demo-scratch-'));
    const demo = createAppContext({
      workspaceRoot: scratch,
      siteId: 'demo-site',
      config: dfsConfig({ profile: 'demo', site: { id: 'demo-site' } }),
      secrets: new MemorySecretStore({}),
      clock: fixedClock('2026-09-24T09:00:00.000Z'),
      logger: memoryLogger(),
      db: ctx.db,
      migrate: false,
    });
    expect(demo.synthetic).toBe(true);
    const fetch = createSyntheticDataForSeoFetch();
    const r = await researchShortlist(demo, [{ query: 'synthetic widget pricing', origin: 'owner' }], { allowOwnerQueries: true, mode: 'fixture', fetch, waitMs: 30_000, sleep: async () => {} });
    expect(r.queries[0]!.usableForRecommendations).toBe(true);
    expect(competitorUrlsForQuery(demo, 'synthetic widget pricing').length).toBe(5);
  });
});
