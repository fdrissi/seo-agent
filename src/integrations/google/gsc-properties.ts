import type { AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { GoogleApiError } from './errors.js';
import { canReadData, listSites, normalizePermissionLevel, similarProperties, validateGscPropertyFormat, type GscCallContext, type GscPermission } from './gsc-client.js';
import type { GoogleApiClient, GoogleAuthProvider } from './types.js';

/**
 * Search Console property discovery via sites.list. Property IDs are never
 * constructed by guessing: the configured property must match an accessible
 * entry exactly, otherwise the owner gets the list (and near matches) to pick
 * from.
 */

export interface DiscoveredProperty {
  siteUrl: string;
  permissionLevel: GscPermission;
  rawPermissionLevel: string;
  canReadData: boolean;
  kind: 'domain' | 'url_prefix' | 'invalid';
}

export interface PropertyDiscovery {
  properties: DiscoveredProperty[];
  configured: {
    property: string | null;
    formatOk: boolean;
    formatProblems: string[];
    accessible: boolean;
    permissionLevel: GscPermission | null;
    suggestions: string[];
  };
  rawRef: string | null;
  synthetic: boolean;
}

export function assertNetworkAllowed(ctx: AppContext, provider: GoogleAuthProvider, api: 'gsc' | 'ga4' | 'url_inspection' | 'auth'): void {
  if (ctx.offline && provider.mode !== 'fixture') {
    throw new GoogleApiError({ api, status: 0, kind: 'offline', message: 'Network access is disabled for this run (offline/demo mode); no Google request was made.' });
  }
}

export async function discoverGscProperties(ctx: AppContext, provider: GoogleAuthProvider, opts: { client?: GoogleApiClient; persist?: boolean; baseUrl?: string } = {}): Promise<PropertyDiscovery> {
  assertNetworkAllowed(ctx, provider, 'gsc');
  const synthetic = provider.mode === 'fixture';
  const client = opts.client ?? (await provider.getClient());
  const c: GscCallContext = { ctx, client, synthetic, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) };
  const { sites, rawRef } = await listSites(c);
  const properties: DiscoveredProperty[] = sites
    .filter((s) => typeof s?.siteUrl === 'string')
    .map((s) => {
      const level = normalizePermissionLevel(s.permissionLevel);
      return { siteUrl: s.siteUrl, permissionLevel: level, rawPermissionLevel: String(s.permissionLevel ?? ''), canReadData: canReadData(level), kind: validateGscPropertyFormat(s.siteUrl).kind };
    })
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));

  if (opts.persist !== false) {
    const now = ctx.clock.now().toISOString();
    ctx.db.transaction(() => {
      const keep = new Set(properties.map((p) => p.siteUrl));
      for (const row of ctx.db.all<{ property: string }>('SELECT property FROM gsc_properties WHERE site_id = ?', [ctx.siteId])) {
        if (!keep.has(row.property)) ctx.db.run('DELETE FROM gsc_properties WHERE site_id = ? AND property = ?', [ctx.siteId, row.property]);
      }
      for (const p of properties) {
        ctx.db.run(
          `INSERT INTO gsc_properties (site_id, property, permission_level, discovered_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (site_id, property) DO UPDATE SET permission_level = excluded.permission_level, discovered_at = excluded.discovered_at`,
          [ctx.siteId, p.siteUrl, p.rawPermissionLevel || p.permissionLevel, now],
        );
      }
    });
  }

  const configuredProperty = ctx.config.google.searchConsoleProperty;
  const fmt = configuredProperty ? validateGscPropertyFormat(configuredProperty) : null;
  const match = configuredProperty ? properties.find((p) => p.siteUrl === configuredProperty) : undefined;
  const readable = properties.filter((p) => p.canReadData).map((p) => p.siteUrl);
  return {
    properties,
    configured: {
      property: configuredProperty,
      formatOk: fmt?.ok ?? false,
      formatProblems: fmt ? [...fmt.problems, ...fmt.notes] : [],
      accessible: !!match && match.canReadData,
      permissionLevel: match?.permissionLevel ?? null,
      suggestions: configuredProperty && !match?.canReadData ? similarProperties(configuredProperty, readable) : [],
    },
    rawRef,
    synthetic,
  };
}

/** Throw an actionable error unless the configured property is accessible with data-read permission. */
export function assertConfiguredPropertyAccessible(d: PropertyDiscovery): string {
  const p = d.configured.property;
  if (!p) {
    throw new AppError('CONFIG_MISSING', 'No Search Console property is configured (google.searchConsoleProperty).', {
      hint: `Run \`npm run cli -- auth status\` to list accessible properties, then copy one exactly into the site config.${d.properties.length ? ` Accessible: ${d.properties.filter((x) => x.canReadData).map((x) => x.siteUrl).join(', ')}` : ''}`,
    });
  }
  const match = d.properties.find((x) => x.siteUrl === p);
  if (!match || !match.canReadData) {
    const readable = d.properties.filter((x) => x.canReadData).map((x) => x.siteUrl);
    throw new AppError('PERMISSION_DENIED', match ? `Search Console property ${p} is listed with permission ${match.permissionLevel}, which cannot read data.` : `Search Console property ${p} is not accessible to the authorized identity.`, {
      details: { configured: p, accessible: readable, suggestions: d.configured.suggestions },
      hint: d.configured.suggestions.length
        ? `Did you mean one of: ${d.configured.suggestions.join(', ')}? Property strings must match exactly (scheme, www, trailing slash, sc-domain:).`
        : 'Grant this identity Restricted or Full user access in Search Console (Settings > Users and permissions), or configure one of the accessible properties shown by `auth status`.',
    });
  }
  return p;
}
