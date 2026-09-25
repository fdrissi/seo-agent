import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { createAppContext, type AppContext } from '../../src/app/context.js';
import { fixedClock, type Clock } from '../../src/core/clock.js';
import { memoryLogger } from '../../src/core/logger.js';
import type { RuntimeMode } from '../../src/core/modes.js';
import { MemorySecretStore } from '../../src/config/secrets.js';
import { parseSiteConfig, type SiteConfig, type SiteConfigInput } from '../../src/config/site-schema.js';
import { initWorkspace } from '../../src/config/workspace.js';
import { workspacePaths } from '../../src/config/paths.js';
import type { EnvKey } from '../../src/config/env.js';
import type { FetchLike } from '../../src/integrations/types.js';

/** Minimal valid synthetic site config; override any field. */
export function testSiteConfig(overrides: Omit<Partial<SiteConfigInput>, 'site'> & { site?: Partial<SiteConfigInput['site']> } = {}): SiteConfig {
  const { site, ...rest } = overrides;
  return parseSiteConfig({
    profile: 'core',
    ...rest,
    site: {
      id: 'test-site',
      businessName: 'Test Co (synthetic)',
      url: 'https://www.example.test/',
      allowedHostnames: ['www.example.test'],
      ...(site ?? {}),
    },
  });
}

export interface TestContext extends AppContext {
  cleanup(): void;
  clock: Clock & { set(iso: string | Date): void; advanceMs(ms: number): void };
  logEntries: ReturnType<typeof memoryLogger>['entries'];
}

/**
 * Fresh temporary workspace + migrated SQLite database + synthetic site.
 * Network is offline unless a fake `fetch` is supplied.
 */
export function createTestContext(opts: {
  config?: SiteConfig;
  secrets?: Partial<Record<EnvKey, string>>;
  fetch?: FetchLike;
  now?: string;
  mode?: RuntimeMode;
  dryRun?: boolean;
  runId?: string;
} = {}): TestContext {
  const root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-test-'));
  const config = opts.config ?? testSiteConfig();
  // The workspace kind matches the profile: createAppContext refuses a demo site in a live workspace (and the reverse).
  initWorkspace(root, { allowInsideRepo: true, kind: config.profile === 'demo' ? 'demo' : 'live' });
  const paths = workspacePaths(root);
  writeFileSync(path.join(paths.sitesDir, `${config.site.id}.yaml`), stringify(config));
  const clock = fixedClock(opts.now ?? '2026-09-24T09:00:00.000Z');
  const logger = memoryLogger();
  const ctx = createAppContext({
    workspaceRoot: root,
    siteId: config.site.id,
    config,
    secrets: new MemorySecretStore(opts.secrets ?? {}),
    clock,
    logger,
    ...(opts.fetch ? { fetch: opts.fetch, offline: false } : { offline: true }),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  });
  return Object.assign(ctx, {
    clock,
    logEntries: logger.entries,
    cleanup() {
      ctx.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
}
