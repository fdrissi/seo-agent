import type { AppContext } from '../../app/context.js';
import type { IntegrationState, IntegrationStatus, StatusCheckOptions } from '../types.js';
import { ApifyApiError, ApifyTransportError, createApifyClient, type ApifyClient } from './client.js';
import { inputSchemaHash, parseInputSchema } from './input-schema.js';
import { REDDIT_SCRAPER_ACTOR_ID } from './reddit-adapter.js';
import { latestPricingSnapshot, listStoredSchemas, resolveRunnableSchema } from './schema.js';

/** What this integration sends to external services when enabled (spec: document external data flows). */
export const APIFY_SENDS_EXTERNALLY: readonly string[] = [
  'APIFY_TOKEN, in the Authorization header, to api.apify.com (never in URLs or logs).',
  'The actor input to Apify: search terms, an optional community name, sort/time-range/date filters, and result/comment limits.',
  'Apify runs the actor, which queries Reddit on your behalf with that input; Apify stores the run dataset under your account (plan retention applies).',
  'Never sent: Google, LLM Gateway, CMS, DataForSEO, or database credentials; analytics data; site content; vault notes.',
];

/**
 * Honest integration status. Without `network`, no request is made. With
 * `network`, only free reads are used (token check via list-runs, actor get,
 * pinned build get); never a chargeable call.
 */
export async function apifyStatus(ctx: AppContext, opts: StatusCheckOptions & { client?: ApifyClient }): Promise<IntegrationStatus> {
  const make = (state: IntegrationState, detail: string, nextStep?: string, networkChecked = false): IntegrationStatus => ({
    id: 'apify',
    state,
    detail,
    ...(nextStep ? { nextStep } : {}),
    sendsExternally: [...APIFY_SENDS_EXTERNALLY],
    checkedAt: ctx.clock.now().toISOString(),
    networkChecked,
    chargeable: false,
  });

  if (ctx.synthetic) return make('fixture', 'Demo mode: Reddit research uses clearly labeled synthetic fixtures; no Apify requests are made.');
  if (!ctx.settings.features.apify) return make('disabled', 'The apify feature is disabled for this site (profile/features).', 'Enable features.apify in the site config (the Full profile enables it).');
  if (ctx.settings.apify.actorId !== REDDIT_SCRAPER_ACTOR_ID) {
    return make('misconfigured', `Configured actor ${ctx.settings.apify.actorId} is not the authoritative Reddit Scraper actor ${REDDIT_SCRAPER_ACTOR_ID}.`, `Restore the actor id to ${REDDIT_SCRAPER_ACTOR_ID}; substitution needs owner approval.`);
  }
  if (!ctx.secrets.has('APIFY_TOKEN')) {
    return make('missing_credentials', 'APIFY_TOKEN is not configured.', `Add APIFY_TOKEN=<token> to ${ctx.paths.secretsEnvFile} (mode 0600) or inject it as an environment variable; then run \`apify inspect\`.`);
  }
  const runnable = resolveRunnableSchema(ctx);
  if (!runnable.ok) {
    const imported = listStoredSchemas(ctx.db, ctx.settings.apify.actorId).find((s) => s.source === 'import' && !s.verified);
    return make(runnable.state, `${runnable.detail}${imported ? ' An imported schema is stored but unverified (integration unresolved).' : ''}`, runnable.nextStep);
  }
  const pricing = latestPricingSnapshot(ctx.db, runnable.actorId);
  const pricingNote = pricing ? `pricing retrieved ${pricing.retrievedAt}` : 'no verified pricing stored (paid runs refused until `apify inspect`)';
  const summary = `Pinned build ${runnable.build} verified (schema ${runnable.row.schemaHash.slice(0, 12)}, source ${runnable.row.source}); ${pricingNote}.`;
  if (!opts.network || ctx.offline) return make('configured_unverified', `${summary} No network check performed.`);

  const client = opts.client ?? createApifyClient(ctx);
  const notes: string[] = [];
  try {
    await client.listRuns(runnable.actorId, { limit: 1 });
    const actor = await client.getActor(runnable.actorId);
    if (actor.isDeprecated) return make('degraded', `${summary} The actor is marked deprecated.`, 'Review the actor listing before further runs.', true);
    const latest = actor.taggedBuilds?.latest?.buildNumber ?? null;
    if (latest && latest !== runnable.build) notes.push(`A newer build (${latest}) exists; run \`apify inspect\` to check schema drift before changing the pin.`);
    if (runnable.row.buildId) {
      const b = await client.getBuild(runnable.row.buildId);
      if (b.status && b.status !== 'SUCCEEDED') return make('misconfigured', `Pinned build ${runnable.build} has status ${b.status}.`, 'Pin a SUCCEEDED build (see `apify inspect`).', true);
      if (b.inputSchema) {
        const live = inputSchemaHash(parseInputSchema(b.inputSchema, 'pinned build'));
        if (live !== runnable.row.schemaHash) return make('misconfigured', `Schema drift on pinned build ${runnable.build}; runs are refused.`, 'Run `apify inspect` and review the drift.', true);
      }
    }
  } catch (err) {
    if (err instanceof ApifyApiError) {
      if (err.httpStatus === 401) return make('misconfigured', 'APIFY_TOKEN was rejected by Apify.', err.hint, true);
      if (err.httpStatus === 403) return make('permission_denied', err.message, err.hint, true);
      if (err.httpStatus === 404) return make('misconfigured', `Actor or pinned build not found: ${err.message}`, 'Run `apify inspect`.', true);
      return make('unreachable', err.message, 'Try again later.', true);
    }
    if (err instanceof ApifyTransportError) return make('unreachable', err.message, 'Check network access to api.apify.com.', true);
    return make('degraded', `Status check failed: ${(err as Error).message}`, undefined, true);
  }
  return make('ready', [summary, 'Token accepted; actor and pinned build reachable.', ...notes].join(' '), notes.length ? notes[0] : undefined, true);
}
