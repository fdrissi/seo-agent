import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppContext, type AppContext } from '../../../src/app/context.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import type { EnvKey } from '../../../src/config/env.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import type { RetryPolicy } from '../../../src/core/retry.js';
import { memoryLogger } from '../../../src/core/logger.js';
import { googleErrorFromResponse } from '../../../src/integrations/google/errors.js';
import { apiNameForUrl, buildUrl } from '../../../src/integrations/google/http-client.js';
import type { GoogleApiClient, GoogleAuthProvider, GoogleRequest, GoogleResponse } from '../../../src/integrations/google/types.js';
import type { FetchLike } from '../../../src/integrations/types.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';

export const GOOGLE_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/google');

/** Zero-delay retries for tests. */
export const FAST_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 };

export const SYNTHETIC_PROPERTY = 'sc-domain:example.test';
export const SYNTHETIC_GA4 = '123456789';

export function googleConfig(overrides: Partial<SiteConfigInput> = {}) {
  return testSiteConfig({
    google: { searchConsoleProperty: SYNTHETIC_PROPERTY, ga4PropertyId: SYNTHETIC_GA4, ...(overrides.google ?? {}) },
    conversions: {
      primaryEvents: [{ name: 'generate_lead', meaning: 'Demo request form submitted (synthetic)', kind: 'lead' }],
      secondaryEvents: [{ name: 'sign_up', meaning: 'Account created (synthetic)', kind: 'signup' }],
      ...(overrides.conversions ?? {}),
    },
    features: { urlInspection: true, ...(overrides.features ?? {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => !['google', 'conversions', 'features'].includes(k))),
  });
}

/** Test context whose fetch is a fake (so the context is "online") unless offline is requested. */
export function googleTestContext(opts: { config?: ReturnType<typeof googleConfig>; now?: string; fetch?: FetchLike; secrets?: Partial<Record<EnvKey, string>>; offline?: boolean; dryRun?: boolean } = {}): TestContext {
  const noNetwork: FetchLike = async (input) => {
    throw new Error(`unexpected network call in test: ${String(input)}`);
  };
  return createTestContext({
    config: opts.config ?? googleConfig(),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.offline ? {} : { fetch: opts.fetch ?? noNetwork }),
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
  });
}

/** A second context on the same workspace/database (CLI commands close their context). */
export function reopen(ctx: TestContext, extra: { fetch?: FetchLike; dryRun?: boolean; offline?: boolean } = {}): AppContext {
  return createAppContext({
    workspaceRoot: ctx.paths.root,
    siteId: ctx.siteId,
    config: ctx.config,
    secrets: ctx.secrets,
    clock: ctx.clock,
    logger: memoryLogger(),
    fetch: extra.fetch ?? ctx.fetch,
    offline: extra.offline ?? ctx.offline,
    ...(extra.dryRun !== undefined ? { dryRun: extra.dryRun } : {}),
  });
}

export interface ScriptedReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Scripted GoogleApiClient returning recorded-shape responses; errors map exactly like the real client. */
export class ScriptedClient implements GoogleApiClient {
  readonly calls: Array<{ method: string; url: string; body: any }> = [];
  constructor(private readonly handler: (req: { method: string; url: string; path: string; body: any }, n: number) => ScriptedReply | Promise<ScriptedReply>) {}

  async request<T>(req: GoogleRequest): Promise<GoogleResponse<T>> {
    const url = buildUrl(req);
    const method = req.method ?? (req.data === undefined ? 'GET' : 'POST');
    const body = req.data === undefined ? null : JSON.parse(JSON.stringify(req.data));
    this.calls.push({ method, url, body });
    const r = await this.handler({ method, url, path: new URL(url).pathname, body }, this.calls.length);
    const status = r.status ?? 200;
    if (status >= 400) throw googleErrorFromResponse(apiNameForUrl(url), status, r.body, r.headers ?? {});
    return { status, data: r.body as T, headers: r.headers ?? {} };
  }
}

export function providerFor(client: GoogleApiClient, mode: GoogleAuthProvider['mode'] = 'oauth'): GoogleAuthProvider {
  return { mode, getClient: async () => client };
}

export function sitesList(entries: Array<[string, string]>): ScriptedReply {
  return { body: { siteEntry: entries.map(([siteUrl, permissionLevel]) => ({ siteUrl, permissionLevel })) } };
}

export function count(ctx: AppContext, sql: string, params: unknown[] = []): number {
  return (ctx.db.get<{ n: number }>(sql, params)?.n ?? 0) as number;
}

export { createTestContext, testSiteConfig, MemorySecretStore };
