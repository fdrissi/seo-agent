import { existsSync } from 'node:fs';
import path from 'node:path';
import { createAppContext, type AppContext } from '../app/context.js';
import { googleCredentialPaths } from '../auth/paths.js';
import { createGoogleAuthProvider } from '../auth/providers.js';
import type { Clock } from '../core/clock.js';
import { errorMessage, isAppError } from '../core/errors.js';
import { createLogger, silentLogger } from '../core/logger.js';
import type { WorkspacePaths } from '../config/paths.js';
import type { SecretStore } from '../config/secrets.js';
import type { SiteConfig } from '../config/site-schema.js';
import { openDatabase } from '../database/db.js';
import { discoverGscProperties } from '../integrations/google/gsc-properties.js';
import { discoverModels } from '../integrations/llm/models.js';
import type { FetchLike } from '../integrations/types.js';
import type { SetupServices } from './session.js';

/**
 * Network-backed helpers for the wizard, built from the real slices:
 * Search Console property discovery (google slice, sites.list) and the LLM
 * Gateway model list (llm slice, GET /v1/models). Both are free, read-only
 * requests, made only after the owner agrees in the wizard.
 *
 * They run against a throwaway in-memory database, so a half-finished setup
 * never registers the site in the workspace database or caches anything
 * there.
 */

export interface ProbeOptions {
  offline: boolean;
  fetch?: FetchLike;
  clock?: Clock;
}

async function withProbeContext<T>(paths: WorkspacePaths, config: SiteConfig, secrets: SecretStore, opts: ProbeOptions, fn: (ctx: AppContext) => Promise<T>): Promise<T> {
  const db = openDatabase(':memory:');
  try {
    const ctx = createAppContext({
      workspaceRoot: paths.root,
      siteId: config.site.id,
      config,
      secrets,
      db,
      logger: silentLogger,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      offline: opts.offline,
      prepareDatabase: 'migrate',
    });
    // The throwaway database's migration messages are not logged; the helper's own logs go to the workspace log file.
    ctx.logger = createLogger({ file: path.join(paths.logsDir, 'seo-agent.log'), console: false, base: { site: config.site.id, component: 'setup' } });
    return await fn(ctx);
  } finally {
    db.close();
  }
}

export function googleCredentialsPresent(paths: WorkspacePaths, secrets: SecretStore): { present: boolean; detail: string } {
  try {
    const gp = googleCredentialPaths(paths, secrets);
    const mode = (secrets.get('GOOGLE_AUTH_MODE') ?? 'oauth').trim().toLowerCase();
    if (mode === 'service_account') {
      if (!gp.serviceAccountFile) return { present: false, detail: 'GOOGLE_APPLICATION_CREDENTIALS is not set' };
      return existsSync(gp.serviceAccountFile) ? { present: true, detail: 'service-account credentials found' } : { present: false, detail: `service-account file not found: ${gp.serviceAccountFile}` };
    }
    if (!existsSync(gp.clientFile)) return { present: false, detail: `no OAuth client file at ${gp.clientFile}` };
    if (!existsSync(gp.tokenFile)) return { present: false, detail: 'Google access has not been authorized yet (no token)' };
    return { present: true, detail: 'OAuth client and token found' };
  } catch (err) {
    return { present: false, detail: errorMessage(err) };
  }
}

export function createSetupServices(paths: WorkspacePaths, secrets: SecretStore, opts: ProbeOptions): SetupServices {
  return {
    googleCredentialsPresent: () => googleCredentialsPresent(paths, secrets),
    discoverGscProperties: async (config) => {
      try {
        return await withProbeContext(paths, config, secrets, opts, async (ctx) => {
          const provider = createGoogleAuthProvider(ctx);
          const d = await discoverGscProperties(ctx, provider, { persist: false });
          return { ok: true as const, properties: d.properties.map((p) => ({ siteUrl: p.siteUrl, permissionLevel: p.permissionLevel, canReadData: p.canReadData })) };
        });
      } catch (err) {
        return { ok: false as const, reason: errorMessage(err), ...(isAppError(err) && err.hint ? { nextStep: err.hint } : {}) };
      }
    },
    listModels: async (config) => {
      try {
        return await withProbeContext(paths, config, secrets, opts, async (ctx) => {
          const d = await discoverModels(ctx, { force: true });
          if (!d.ok) return { ok: false as const, reason: d.reason, nextStep: d.nextStep };
          return {
            ok: true as const,
            models: d.catalog.models.map((m) => ({ id: m.id, kind: m.isEmbedding ? ('embedding' as const) : ('chat' as const), priced: m.prices.inputPerMillion !== null })),
            retrievedAt: d.catalog.retrievedAt,
            authenticated: d.catalog.authenticated,
          };
        });
      } catch (err) {
        return { ok: false as const, reason: errorMessage(err) };
      }
    },
  };
}
