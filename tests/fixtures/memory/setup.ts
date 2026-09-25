/**
 * Test setup helpers for the memory slice (SYNTHETIC data only).
 */
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppContext, type AppContext } from '../../../src/app/context.js';
import { memoryLogger } from '../../../src/core/logger.js';
import type { RetryPolicy } from '../../../src/core/retry.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import { siteVaultDir } from '../../../src/config/paths.js';
import { createMemoryService, type MemoryService, type MemoryServiceDeps } from '../../../src/memory/service.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { FakeEmbedder } from './fake-embedder.js';
import { FakeQdrant } from './fake-qdrant.js';

export const FIXTURE_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault');
export const NO_RETRY_POLICY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 };
export const DIMS = 32;

export function memoryConfig(overrides: Partial<SiteConfigInput> & { site?: Partial<SiteConfigInput['site']> } = {}) {
  return testSiteConfig({
    profile: 'full',
    models: { embedding: 'fake-embed-model', embeddingDimensions: DIMS },
    market: { languages: ['en'] },
    ...overrides,
  });
}

export interface MemoryHarness {
  ctx: TestContext;
  qdrant: FakeQdrant;
  embedder: FakeEmbedder;
  service: MemoryService;
  make(deps?: MemoryServiceDeps): MemoryService;
}

export function memoryHarness(opts: { config?: ReturnType<typeof memoryConfig>; secrets?: Record<string, string>; qdrant?: FakeQdrant; embedder?: FakeEmbedder; deps?: MemoryServiceDeps } = {}): MemoryHarness {
  const qdrant = opts.qdrant ?? new FakeQdrant();
  const embedder = opts.embedder ?? new FakeEmbedder(DIMS);
  const ctx = createTestContext({ config: opts.config ?? memoryConfig(), fetch: qdrant.fetch, ...(opts.secrets ? { secrets: opts.secrets } : {}) });
  const make = (deps: MemoryServiceDeps = {}) => createMemoryService(ctx, { llm: embedder, qdrantRetryPolicy: NO_RETRY_POLICY, ...opts.deps, ...deps });
  return { ctx, qdrant, embedder, service: make(), make };
}

/** Copy the synthetic fixture vault's business notes into the context's site vault. */
export function installFixtureVault(ctx: AppContext): string {
  const dir = siteVaultDir(ctx.paths, ctx.siteId);
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE_VAULT, dir, { recursive: true });
  return dir;
}

/** A second site's context sharing the same database (and Qdrant fake) as `a`. */
export function secondSiteContext(a: TestContext, siteId: string, fetch: FakeQdrant['fetch']): AppContext {
  const config = memoryConfig({ site: { id: siteId, businessName: `Other Co ${siteId} (synthetic)`, url: `https://${siteId}.example.test/`, allowedHostnames: [`${siteId}.example.test`] } });
  return createAppContext({
    workspaceRoot: a.paths.root,
    siteId,
    config,
    secrets: new MemorySecretStore({}),
    clock: a.clock,
    logger: memoryLogger(),
    db: a.db,
    fetch,
    offline: false,
    migrate: false,
  });
}
