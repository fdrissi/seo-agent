import type { AppContext } from '../../app/context.js';
import { formatUsd } from '../../core/money.js';
import type { FetchLike, IntegrationStatus, StatusCheckOptions } from '../types.js';
import { checkGatewayBaseUrl } from './http.js';
import { checkConfiguredModels, discoverModels, getKeyInfo, type ConfiguredModelCheck, type KeyInfo } from './models.js';

/**
 * Honest LLM Gateway status for doctor/setup. The optional network check is
 * FREE: it lists models (`GET /v1/models`) and reads the key budget
 * (`GET /v1/key`). It never makes a chargeable completion; the only chargeable
 * check is `models test --confirm-spend --max-usd <cap>`.
 */

export const LLM_SENDS_EXTERNALLY = [
  'Prompt text rendered from prompts/*.md templates with site-config values (business name, offer, languages, and similar non-secret fields) to the LLM Gateway and the upstream model provider it routes to.',
  'Evidence excerpts included in each request: first-party metrics computed by code (Search Console/GA4 aggregates), crawled page text, competitor/SERP excerpts, research snippets, and retrieved vault notes. Secrets are redacted, and personal identifiers (emails, phone-like numbers, user handles, IP addresses, analytics ids) are masked in evidence, tool results, and embedding inputs unless the site config sets llm.allowPersonalData with llm.personalDataReason.',
  'Texts to embed (memory chunks from business notes, source excerpts, briefs) when embeddings are enabled.',
  'Model-listing and key-usage requests (no content) for capability and budget checks.',
];

export interface LlmStatusDetail extends IntegrationStatus {
  models?: ConfiguredModelCheck[];
  key?: KeyInfo;
  catalog?: { retrievedAt: string; source: 'network' | 'cache'; stale: boolean; authenticated: boolean; modelCount: number };
}

export async function llmStatus(ctx: AppContext, opts: StatusCheckOptions & { fetch?: FetchLike } = { network: false }): Promise<LlmStatusDetail> {
  const checkedAt = ctx.clock.now().toISOString();
  const base = { id: 'llm_gateway' as const, sendsExternally: LLM_SENDS_EXTERNALLY, checkedAt, chargeable: false };
  const s = ctx.settings;
  if (!s.features.llm && !s.features.embeddings) {
    return { ...base, state: 'disabled', detail: `LLM analysis and embeddings are disabled for site ${ctx.siteId} (profile ${ctx.config.profile}).`, nextStep: 'Set features.llm / features.embeddings to true in the site config to enable them.', networkChecked: false };
  }
  if (ctx.synthetic) {
    return { ...base, state: 'fixture', detail: 'Demo profile: the deterministic SYNTHETIC fixture client is used; no model is called and outputs are not real model answers.', networkChecked: false };
  }
  // The Bearer key is never sent over plain http to a network host: such a base URL is refused everywhere.
  const baseUrl = checkGatewayBaseUrl(s.llmBaseUrl);
  if (!baseUrl.ok) {
    return { ...base, state: 'misconfigured', detail: `${baseUrl.reason} AI analysis stays off; deterministic reports still work.`, nextStep: baseUrl.nextStep, networkChecked: false };
  }
  const missing: string[] = [];
  if (!ctx.secrets.has('LLM_GATEWAY_API_KEY')) missing.push('LLM_GATEWAY_API_KEY');
  if (missing.length) {
    return {
      ...base,
      state: 'missing_credentials',
      detail: `Missing ${missing.join(', ')}. AI analysis stays off; deterministic reports still work.`,
      nextStep: 'Create a dedicated LLM Gateway project key with a recurring spend limit (docs/ACCESS_SETUP.md) and put LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env or your password-manager environment.',
      networkChecked: false,
    };
  }
  const unset: string[] = [];
  if (s.features.llm && !s.models.cheap) unset.push('CHEAP_MODEL');
  if (s.features.llm && !s.models.reasoning) unset.push('REASONING_MODEL');
  if (s.features.embeddings && !s.models.embedding) unset.push('EMBEDDING_MODEL');
  if (unset.length) {
    return {
      ...base,
      state: 'misconfigured',
      detail: `Model id(s) not configured: ${unset.join(', ')}.`,
      nextStep: 'Run `npm run cli -- models list` and set the missing model ids (environment/secrets.env or models.* in the site config). Model ids are never guessed.',
      networkChecked: false,
    };
  }
  if (!opts.network || ctx.offline) {
    return {
      ...base,
      state: 'configured_unverified',
      detail: `API key and model ids are configured (base URL ${s.llmBaseUrl}); availability, capabilities, and prices were not checked${ctx.offline ? ' (offline)' : ''}.`,
      nextStep: 'Run `npm run cli -- models check` (free) to verify the configured models.',
      networkChecked: false,
    };
  }
  const d = await discoverModels(ctx, { force: true, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  if (!d.ok) {
    const state = d.state === 'unauthorized' || d.state === 'misconfigured' ? 'misconfigured' : d.state === 'permission_denied' ? 'permission_denied' : 'unreachable';
    return { ...base, state, detail: d.reason, nextStep: d.nextStep, networkChecked: true };
  }
  const checks = checkConfiguredModels(ctx, d.catalog).filter((c) => (c.tier === 'embedding' ? s.features.embeddings : s.features.llm));
  const key = await getKeyInfo(ctx, opts.fetch ? { fetch: opts.fetch } : {});
  const catalog = { retrievedAt: d.catalog.retrievedAt, source: d.catalog.source, stale: d.catalog.stale, authenticated: d.catalog.authenticated, modelCount: d.catalog.models.length };
  const bad = checks.filter((c) => c.status === 'invalid_model' || c.status === 'wrong_kind' || c.status === 'not_configured');
  const unknownPrice = checks.filter((c) => c.status === 'unknown_price');
  const keyText = key.ok
    ? ` Key usage ${formatUsd(key.key.usageMicros)} of limit ${key.key.limitMicros === null ? 'none set' : formatUsd(key.key.limitMicros)}.`
    : ` Key budget not read (${key.reason}).`;
  if (d.warning || d.catalog.source !== 'network') {
    // The live listing failed: nothing was verified against the gateway during this check.
    const cachedSummary = checks.map((c) => `${c.tier}=${c.modelId ?? 'unset'}: ${c.status}`).join(', ');
    return {
      ...base,
      state: 'unreachable',
      detail: `The LLM Gateway model listing failed during this check (${d.warning ?? 'no live response'}). Nothing was verified live; the configured models were compared only with the cached catalog from ${catalog.retrievedAt}${catalog.stale ? ' (STALE)' : ''}: ${cachedSummary}.${keyText}`,
      nextStep: `Check network access and LLM_GATEWAY_BASE_URL (${s.llmBaseUrl}), then rerun \`npm run cli -- models check\`.`,
      networkChecked: true,
      models: checks,
      ...(key.ok ? { key: key.key } : {}),
      catalog,
    };
  }
  if (bad.length) {
    return {
      ...base,
      state: 'misconfigured',
      detail: bad.map((b) => `${b.tier}: ${b.detail}`).join(' | '),
      nextStep: bad[0]!.nextStep ?? 'Fix the configured model ids.',
      networkChecked: true,
      models: checks,
      ...(key.ok ? { key: key.key } : {}),
      catalog,
    };
  }
  if (unknownPrice.length) {
    return {
      ...base,
      state: 'degraded',
      detail: `Models found, but no verifiable price for: ${unknownPrice.map((u) => `${u.tier}=${u.modelId}`).join(', ')}; those calls will be skipped as BUDGET_UNKNOWN_PRICE.${keyText}`,
      nextStep: unknownPrice[0]!.nextStep ?? 'Configure llm.pricingOverrides with verified prices.',
      networkChecked: true,
      models: checks,
      ...(key.ok ? { key: key.key } : {}),
      catalog,
    };
  }
  const noLimit = key.ok && key.key.limitMicros === null;
  return {
    ...base,
    state: 'ready',
    detail: `Configured models verified in the gateway catalog (${catalog.modelCount} models, retrieved ${catalog.retrievedAt}).${keyText}${noLimit ? ' Consider setting a recurring key spend limit in the LLM Gateway dashboard as a provider-side cap.' : ''}`,
    networkChecked: true,
    models: checks,
    ...(key.ok ? { key: key.key } : {}),
    catalog,
  };
}
