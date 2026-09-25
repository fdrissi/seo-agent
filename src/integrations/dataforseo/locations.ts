import type { AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { hashObject } from '../../core/hash.js';
import { errorMessage } from '../../core/errors.js';
import { getCached, putCached, researchCacheKey } from './cache.js';
import type { DataForSeoClient, DataForSeoMode } from './client.js';

/**
 * Location / language / device resolution. Codes are never guessed:
 * configured `market.searchLocations[].locationCode` values are verified
 * against the free lookup endpoints (DF11, DF12, DF21, DF22), a configured
 * location NAME is resolved only by an exact, unique match, and the result is
 * cached (research_cache, 30 days) so lookups are not repeated every run.
 */

export type LookupKind = 'serp' | 'keywords';
export type SupportedDevice = 'desktop' | 'mobile';

export interface LocationEntry {
  location_code: number;
  location_name: string;
  location_code_parent: number | null;
  country_iso_code: string | null;
  location_type: string | null;
}

export interface LanguageEntry {
  language_name: string;
  language_code: string;
}

export const LOOKUP_CACHE_DAYS = 30;

const LOOKUP_ENDPOINTS: Record<LookupKind, { locations: string; locationsCountry: string; languages: string }> = {
  serp: { locations: 'serp/google/locations', locationsCountry: 'serp/google/locations/{country}', languages: 'serp/google/languages' },
  keywords: { locations: 'keywords_data/google_ads/locations', locationsCountry: 'keywords_data/google_ads/locations/{country}', languages: 'keywords_data/google_ads/languages' },
};

function toLocation(v: unknown): LocationEntry | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.location_code !== 'number' || typeof r.location_name !== 'string') return null;
  return {
    location_code: r.location_code,
    location_name: r.location_name,
    location_code_parent: typeof r.location_code_parent === 'number' ? r.location_code_parent : null,
    country_iso_code: typeof r.country_iso_code === 'string' ? r.country_iso_code : null,
    location_type: typeof r.location_type === 'string' ? r.location_type : null,
  };
}

function toLanguage(v: unknown): LanguageEntry | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.language_code !== 'string' || typeof r.language_name !== 'string') return null;
  return { language_code: r.language_code, language_name: r.language_name };
}

async function lookup<T>(
  ctx: AppContext,
  client: DataForSeoClient | null,
  mode: DataForSeoMode,
  endpoint: string,
  pathParams: Record<string, string>,
  map: (v: unknown) => T | null,
  allowNetwork: boolean,
): Promise<{ items: T[]; source: 'cache' | 'network' } | null> {
  const keyInput = { siteId: ctx.siteId, endpoint, locationCode: null, languageCode: null, device: null, parameterHash: hashObject(pathParams), mode };
  const cached = getCached(ctx, researchCacheKey(keyInput));
  if (cached) {
    const payload = ctx.raw.load<unknown[]>(cached.payloadRef);
    const items = Array.isArray(payload) ? payload.map(map).filter((x): x is T => x !== null) : [];
    // An empty cached list is never trusted (it would block research for the whole TTL).
    if (items.length) return { items, source: 'cache' };
  }
  if (!allowNetwork || !client) return null;
  // getFree requires every task to be 20000: a task-level error inside HTTP 200
  // is raised here and never cached as an empty list.
  const { envelope } = await client.getFree<unknown>(endpoint, pathParams);
  const result = envelope.tasks[0]?.result ?? [];
  const items = result.map(map).filter((x): x is T => x !== null);
  if (!items.length) {
    throw new AppError('DATA_UNAVAILABLE', `DataForSEO lookup ${endpoint} returned an empty list; it is not cached and nothing is inferred from it.`, {
      details: { endpoint, pathParams },
      hint: 'Retry later, or check the country code (research locations <name> --country <iso2>).',
    });
  }
  const ref = ctx.raw.save({ siteId: ctx.siteId, provider: 'dataforseo', kind: `lookup-${endpoint.replace(/[^a-z0-9]+/gi, '-')}`, payload: items, at: ctx.clock.now() });
  putCached(ctx, { ...keyInput, payloadRef: ref, ttlDays: LOOKUP_CACHE_DAYS, isSandbox: client.isSandbox });
  return { items, source: 'network' };
}

export async function listLocations(
  ctx: AppContext,
  client: DataForSeoClient | null,
  opts: { kind: LookupKind; country?: string | null; mode: DataForSeoMode; allowNetwork: boolean },
): Promise<{ items: LocationEntry[]; source: 'cache' | 'network' } | null> {
  const e = LOOKUP_ENDPOINTS[opts.kind];
  const country = opts.country ? opts.country.toLowerCase() : null;
  return country
    ? lookup(ctx, client, opts.mode, e.locationsCountry, { country }, toLocation, opts.allowNetwork)
    : lookup(ctx, client, opts.mode, e.locations, {}, toLocation, opts.allowNetwork);
}

export async function listLanguages(
  ctx: AppContext,
  client: DataForSeoClient | null,
  opts: { kind: LookupKind; mode: DataForSeoMode; allowNetwork: boolean },
): Promise<{ items: LanguageEntry[]; source: 'cache' | 'network' } | null> {
  return lookup(ctx, client, opts.mode, LOOKUP_ENDPOINTS[opts.kind].languages, {}, toLanguage, opts.allowNetwork);
}

export interface ResolvedSearchSettings {
  kind: LookupKind;
  locationCode: number;
  locationName: string | null;
  languageCode: string;
  languageName: string | null;
  device: SupportedDevice;
  /** verified: confirmed by the lookup endpoints; unverified: lookups unavailable; synthetic: fixture mode. */
  verification: 'verified' | 'unverified' | 'synthetic';
  warnings: string[];
}

/** The single country used to narrow the (large) location list, when unambiguous. */
function lookupCountry(ctx: AppContext): string | null {
  const alpha2 = ctx.config.market.countries.filter((c) => /^[a-z]{2}$/i.test(c));
  return alpha2.length === 1 ? alpha2[0]!.toLowerCase() : null;
}

export function pickDevice(ctx: AppContext, requested?: string | null): { device: SupportedDevice; warnings: string[] } {
  const warnings: string[] = [];
  if (requested) {
    if (requested !== 'desktop' && requested !== 'mobile') throw new AppError('VALIDATION_FAILED', `Unsupported device "${requested}": DataForSEO Google SERPs support desktop or mobile (DF4)`);
    return { device: requested, warnings };
  }
  const devices = ctx.config.market.devices;
  if (devices.includes('tablet')) warnings.push('market.devices includes "tablet", which DataForSEO Google SERP research does not support; it is skipped.');
  const d = devices.find((x): x is SupportedDevice => x === 'desktop' || x === 'mobile');
  if (!d) throw new AppError('CONFIG_INVALID', 'No supported research device configured (market.devices needs desktop or mobile).');
  return { device: d, warnings };
}

export async function resolveSearchSettings(
  ctx: AppContext,
  client: DataForSeoClient | null,
  opts: { kind: LookupKind; mode: DataForSeoMode; allowNetwork: boolean; locationCode?: number | null; device?: string | null },
): Promise<ResolvedSearchSettings> {
  const entries = ctx.config.market.searchLocations;
  if (entries.length === 0) {
    throw new AppError('CONFIG_MISSING', 'No research location configured (market.searchLocations is empty).', {
      hint: 'Add market.searchLocations with a languageCode and a locationCode; find codes with `npm run cli -- research locations <name> --country <iso2>`.',
    });
  }
  const entry = opts.locationCode != null ? entries.find((e) => e.locationCode === opts.locationCode) : entries[0];
  if (!entry) throw new AppError('CONFIG_INVALID', `Location code ${opts.locationCode} is not one of the configured market.searchLocations.`);
  const { device, warnings } = pickDevice(ctx, opts.device ?? null);
  const languageCode = entry.languageCode;

  if (opts.mode === 'fixture') {
    if (entry.locationCode === null) throw new AppError('CONFIG_INVALID', 'Fixture mode needs an explicit market.searchLocations[].locationCode (codes are never guessed).');
    return { kind: opts.kind, locationCode: entry.locationCode, locationName: entry.name, languageCode, languageName: null, device, verification: 'synthetic', warnings: [...warnings, 'Fixture mode: synthetic data, location/language not verified.'] };
  }

  const sandbox = opts.mode === 'sandbox';
  let locations: Awaited<ReturnType<typeof listLocations>> = null;
  let languages: Awaited<ReturnType<typeof listLanguages>> = null;
  let lookupError: string | null = null;
  try {
    locations = await listLocations(ctx, client, { kind: opts.kind, country: lookupCountry(ctx), mode: opts.mode, allowNetwork: opts.allowNetwork });
    languages = await listLanguages(ctx, client, { kind: opts.kind, mode: opts.mode, allowNetwork: opts.allowNetwork });
  } catch (err) {
    lookupError = errorMessage(err);
  }

  if (!locations || !languages) {
    if (entry.locationCode === null) {
      throw new AppError('DATA_UNAVAILABLE', `Cannot resolve location "${entry.name ?? '(unnamed)'}" without the free DataForSEO lookup${lookupError ? ` (${lookupError})` : ''}; codes are never guessed.`, {
        hint: 'Set market.searchLocations[].locationCode, or run again with network access so the lookup can verify it.',
      });
    }
    return {
      kind: opts.kind,
      locationCode: entry.locationCode,
      locationName: entry.name,
      languageCode,
      languageName: null,
      device,
      verification: 'unverified',
      warnings: [...warnings, `Location ${entry.locationCode} / language ${languageCode} not verified: lookup ${lookupError ? `failed (${lookupError})` : 'not available offline or in a dry run'}.`],
    };
  }

  let loc: LocationEntry | undefined;
  if (entry.locationCode !== null) {
    loc = locations.items.find((l) => l.location_code === entry.locationCode);
    if (!loc) {
      if (!sandbox) {
        throw new AppError('CONFIG_INVALID', `Configured location code ${entry.locationCode} is not in the DataForSEO ${opts.kind} locations list.`, {
          hint: 'Find a supported code with `npm run cli -- research locations <name> --country <iso2>` and update market.searchLocations.',
        });
      }
      warnings.push(`Sandbox lookup data is synthetic; location ${entry.locationCode} not found in it (not verified).`);
    }
  } else {
    const name = (entry.name ?? '').trim().toLowerCase();
    const matches = name ? locations.items.filter((l) => l.location_name.toLowerCase() === name) : [];
    if (matches.length !== 1) {
      const candidates = name ? locations.items.filter((l) => l.location_name.toLowerCase().includes(name)).slice(0, 5) : [];
      throw new AppError('CONFIG_INVALID', `Location "${entry.name ?? ''}" ${matches.length === 0 ? 'has no exact match' : 'is ambiguous'} in the DataForSEO ${opts.kind} locations list; codes are never guessed.`, {
        details: { candidates: candidates.map((c) => ({ code: c.location_code, name: c.location_name, type: c.location_type })) },
        hint: 'Set market.searchLocations[].locationCode explicitly (see `npm run cli -- research locations <name> --country <iso2>`).',
      });
    }
    loc = matches[0];
  }
  const lang = languages.items.find((l) => l.language_code.toLowerCase() === languageCode.toLowerCase());
  if (!lang) {
    if (!sandbox) throw new AppError('CONFIG_INVALID', `Language code "${languageCode}" is not in the DataForSEO ${opts.kind} languages list.`);
    warnings.push(`Sandbox lookup data is synthetic; language ${languageCode} not found in it (not verified).`);
  }
  const verified = !!loc && !!lang;
  return {
    kind: opts.kind,
    locationCode: loc?.location_code ?? entry.locationCode!,
    locationName: loc?.location_name ?? entry.name,
    languageCode: lang?.language_code ?? languageCode,
    languageName: lang?.language_name ?? null,
    device,
    verification: verified ? 'verified' : 'unverified',
    warnings,
  };
}
