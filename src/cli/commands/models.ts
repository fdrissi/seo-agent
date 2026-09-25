import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { formatUsd, toMicros } from '../../core/money.js';
import { createLlmClient } from '../../integrations/llm/gateway.js';
import { checkConfiguredModels, discoverModels, getKeyInfo, type ConfiguredModelCheck, type DiscoveryResult, type KeyInfo, type ModelCapabilities } from '../../integrations/llm/models.js';
import type { ModelTier } from '../../integrations/llm/types.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `models list`  - verified models + capabilities from the gateway catalog (free GET /v1/models).
 * `models check` - configured CHEAP/REASONING/EMBEDDING models exist, capabilities, prices, key budget (free).
 * `models test`  - explicit CHARGEABLE minimal call; requires --confirm-spend AND --max-usd <cap>.
 *                  It holds the per-site lease while it runs and refuses with LOCKED while a job
 *                  holds the site lock (MUTATING_COMMANDS in src/cli/runtime.ts).
 */

function discoveryError(r: Extract<DiscoveryResult, { ok: false }>): AppError {
  const code = r.state === 'unauthorized' ? 'CREDENTIALS_MISSING' : r.state === 'permission_denied' ? 'PERMISSION_DENIED' : r.state === 'offline' ? 'INTEGRATION_DISABLED' : r.state === 'misconfigured' ? 'CONFIG_INVALID' : 'INTEGRATION_UNAVAILABLE';
  return new AppError(code, r.reason, { hint: r.nextStep, details: { state: r.state, ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}) } });
}

function perMillionUsd(m: number | null): string | null {
  return m === null ? null : formatUsd(m);
}

export interface ModelSummary {
  id: string;
  kind: 'chat' | 'embedding';
  contextLength: number | null;
  maxOutput: number | null;
  structuredOutputs: boolean | null;
  jsonOutput: boolean | null;
  tools: boolean | null;
  reasoning: boolean | null;
  reasoningEfforts: string[] | null;
  temperature: boolean | null;
  inputPerMillion: string | null;
  outputPerMillion: string | null;
  pricePrompt: string | null;
  priceCompletion: string | null;
  providers: string[];
  deprecatedAt: string | null;
  deactivatedAt: string | null;
  stability: string | null;
}

export function summarizeModel(m: ModelCapabilities): ModelSummary {
  return {
    id: m.id,
    kind: m.isEmbedding ? 'embedding' : 'chat',
    contextLength: m.contextLength,
    maxOutput: m.maxOutput,
    structuredOutputs: m.structuredOutputs,
    jsonOutput: m.jsonOutput,
    tools: m.tools,
    reasoning: m.reasoning,
    reasoningEfforts: m.reasoningEfforts,
    temperature: m.supportedParameters ? m.supportedParameters.includes('temperature') : null,
    inputPerMillion: perMillionUsd(m.prices.inputPerMillion),
    outputPerMillion: perMillionUsd(m.prices.outputPerMillion),
    pricePrompt: m.pricing.prompt,
    priceCompletion: m.pricing.completion,
    providers: m.providers.map((p) => p.providerId),
    deprecatedAt: m.deprecatedAt,
    deactivatedAt: m.deactivatedAt,
    stability: m.stability,
  };
}

const flag = (v: boolean | null) => (v === null ? '?' : v ? 'y' : '-');

function renderList(r: { catalog: { retrievedAt: string; source: string; stale: boolean; authenticated: boolean; baseUrl: string; total: number }; models: ModelSummary[]; warning?: string }): string {
  const lines = [
    `LLM Gateway models (${r.models.length} shown of ${r.catalog.total}; ${r.catalog.authenticated ? 'filtered for this key' : 'public catalog'}; ${r.catalog.source}, retrieved ${r.catalog.retrievedAt}${r.catalog.stale ? ', STALE' : ''})`,
    `Base URL: ${r.catalog.baseUrl}`,
    ...(r.warning ? [`Warning: ${r.warning}`] : []),
    '',
    'id                                        kind  ctx      maxout  struct json tools reason temp  in$/1M     out$/1M    deactivates',
  ];
  for (const m of r.models) {
    lines.push(
      [
        m.id.padEnd(41),
        (m.kind === 'embedding' ? 'emb' : 'chat').padEnd(5),
        String(m.contextLength ?? '?').padEnd(8),
        String(m.maxOutput ?? '?').padEnd(7),
        flag(m.structuredOutputs).padEnd(6),
        flag(m.jsonOutput).padEnd(4),
        flag(m.tools).padEnd(5),
        flag(m.reasoning).padEnd(6),
        flag(m.temperature).padEnd(5),
        (m.inputPerMillion ?? 'unknown').padEnd(10),
        (m.outputPerMillion ?? 'unknown').padEnd(10),
        m.deactivatedAt ?? '',
      ].join(' '),
    );
  }
  lines.push('', 'Flags: y = supported on every provider mapping, - = not supported, ? = not reported. Prices are the conservative maximum across provider mappings (USD per 1M tokens).');
  lines.push('Catalog prices and capabilities change; recheck before paid use. Model ids are never substituted automatically.');
  return lines.join('\n');
}

function renderCheck(r: { ok: boolean; catalog: { retrievedAt: string; source: string; stale: boolean } | null; checks: ConfiguredModelCheck[]; key: KeyInfo | null; keyNote: string | null; warning?: string }): string {
  const lines = [`Configured model check: ${r.ok ? 'OK' : 'PROBLEMS FOUND'}`];
  if (r.catalog) lines.push(`Catalog: ${r.catalog.source}, retrieved ${r.catalog.retrievedAt}${r.catalog.stale ? ' (STALE)' : ''}`);
  if (r.warning) lines.push(`Warning: ${r.warning}`);
  lines.push('');
  for (const c of r.checks) {
    lines.push(`${c.tier.padEnd(10)} ${String(c.modelId ?? '(unset)').padEnd(40)} ${c.status.toUpperCase()}  [${c.source}]`);
    lines.push(`           ${c.detail}`);
    if (c.capabilities) {
      const k = c.capabilities;
      lines.push(
        `           ctx ${k.contextLength ?? '?'}, max output ${k.maxOutput ?? '?'}, structured ${flag(k.structuredOutputs)}, json ${flag(k.jsonOutput)}, tools ${flag(k.tools)}, reasoning ${flag(k.reasoning)}, temperature ${flag(k.supportsTemperature)}, price in/out per 1M: ${k.inputPricePerMillionUsd ?? 'unknown'}/${k.outputPricePerMillionUsd ?? 'unknown'} USD (${k.priceSource})`,
      );
    }
    for (const w of c.warnings) lines.push(`           warning: ${w}`);
    if (c.similar?.length) lines.push(`           listed ids with similar names (not substituted): ${c.similar.join(', ')}`);
    if (c.nextStep) lines.push(`           next step: ${c.nextStep}`);
  }
  lines.push('');
  if (r.key) lines.push(`Key: usage ${formatUsd(r.key.usageMicros)}, limit ${r.key.limitMicros === null ? 'none set (consider a recurring key spend limit)' : formatUsd(r.key.limitMicros)}${r.key.remainingMicros !== null ? `, remaining ${formatUsd(r.key.remainingMicros)}` : ''}`);
  else if (r.keyNote) lines.push(`Key budget not read: ${r.keyNote}`);
  lines.push('This check is free: it lists models and reads key usage; no completion was requested.');
  return lines.join('\n');
}

export function register(program: Command, cli: CliRuntime): void {
  const models = program.command('models').description('LLM Gateway models: list verified capabilities, check configured models, run an explicit paid test');

  models
    .command('list')
    .description('List models from the LLM Gateway catalog (free GET /v1/models) with capabilities and verified prices')
    .option('--refresh', 'ignore the cached catalog and query the gateway')
    .option('--embedding', 'show only embedding models')
    .option('--chat', 'show only chat models')
    .option('--filter <text>', 'show only ids containing this text')
    .action(
      cli.action(async (opts: { refresh?: boolean; embedding?: boolean; chat?: boolean; filter?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          if (g.dryRun && !ctx.offline) {
            cli.print(g, { dryRun: true, wouldRequest: `GET ${ctx.settings.llmBaseUrl.replace(/\/+$/, '')}/models (free, read-only)` }, (r) => `Dry run: would request ${r.wouldRequest}.`);
            return;
          }
          const r = await discoverModels(ctx, { force: !!opts.refresh });
          if (!r.ok) throw discoveryError(r);
          const filtered = r.catalog.models
            .filter((m) => (opts.embedding ? m.isEmbedding : opts.chat ? !m.isEmbedding : true))
            .filter((m) => (opts.filter ? m.id.toLowerCase().includes(opts.filter.toLowerCase()) : true))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(summarizeModel);
          cli.print(
            g,
            {
              catalog: { baseUrl: r.catalog.baseUrl, retrievedAt: r.catalog.retrievedAt, source: r.catalog.source, stale: r.catalog.stale, authenticated: r.catalog.authenticated, total: r.catalog.models.length, skippedEntries: r.catalog.skipped },
              models: filtered,
              ...(r.warning ? { warning: r.warning } : {}),
            },
            renderList,
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  models
    .command('check')
    .description('Verify configured CHEAP_MODEL / REASONING_MODEL / EMBEDDING_MODEL against the catalog: existence, capabilities, prices, key budget (free)')
    .option('--refresh', 'ignore the cached catalog and query the gateway')
    .action(
      cli.action(async (opts: { refresh?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const r = await discoverModels(ctx, { force: !!opts.refresh });
          if (!r.ok) throw discoveryError(r);
          const checks = checkConfiguredModels(ctx, r.catalog).filter((c) => (c.tier === 'embedding' ? ctx.settings.features.embeddings : ctx.settings.features.llm));
          let key: KeyInfo | null = null;
          let keyNote: string | null = null;
          if (ctx.offline) keyNote = 'offline';
          else if (!ctx.secrets.has('LLM_GATEWAY_API_KEY')) keyNote = 'LLM_GATEWAY_API_KEY is not set';
          else {
            const k = await getKeyInfo(ctx);
            if (k.ok) key = k.key;
            else keyNote = k.reason;
          }
          const ok = checks.every((c) => c.status === 'ok');
          cli.print(g, { ok, catalog: { retrievedAt: r.catalog.retrievedAt, source: r.catalog.source, stale: r.catalog.stale, authenticated: r.catalog.authenticated }, checks, key, keyNote, ...(r.warning ? { warning: r.warning } : {}) }, renderCheck);
          if (!ok) process.exitCode = 2;
        } finally {
          ctx.db.close();
        }
      }),
    );

  models
    .command('test')
    .description('CHARGEABLE: send one minimal request to the configured model; requires --confirm-spend and --max-usd <cap>')
    .option('--tier <tier>', 'cheap | reasoning | embedding', 'cheap')
    .option('--confirm-spend', 'acknowledge that this sends a paid request')
    .option('--max-usd <cap>', 'hard cap for this request\'s cost upper bound, e.g. 0.01')
    .option('--max-output-tokens <n>', 'max output tokens for the test completion', '16')
    .action(
      cli.action(async (opts: { tier: string; confirmSpend?: boolean; maxUsd?: string; maxOutputTokens: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const tier = opts.tier as ModelTier | 'embedding';
        if (!['cheap', 'reasoning', 'embedding'].includes(tier)) throw new AppError('VALIDATION_FAILED', `Unknown tier "${opts.tier}"; use cheap, reasoning, or embedding.`);
        if (!opts.maxUsd || !/^\d+(\.\d{1,6})?$/.test(opts.maxUsd)) {
          throw new AppError('POLICY_DENIED', '`models test` sends a chargeable request and needs an explicit cap: --max-usd <amount> (for example 0.01).', { hint: 'Run `models check` first (free) to see verified prices.' });
        }
        const capMicros = toMicros(opts.maxUsd);
        if (capMicros <= 0) throw new AppError('POLICY_DENIED', '--max-usd must be greater than 0.');
        if (!opts.confirmSpend && !g.dryRun) {
          throw new AppError('POLICY_DENIED', `\`models test\` sends a chargeable request (cap ${formatUsd(capMicros)}). Re-run with --confirm-spend to proceed, or --dry-run to preview.`);
        }
        const maxOutputTokens = Number(opts.maxOutputTokens);
        if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 256) throw new AppError('VALIDATION_FAILED', '--max-output-tokens must be an integer between 1 and 256');
        const ctx = cli.context(g, { runId: newId('run_modeltest') });
        try {
          const client = createLlmClient(ctx, { maxCostPerRequestMicros: capMicros });
          const common = { cap: formatUsd(capMicros), capMicros, tier, model: tier === 'cheap' ? ctx.settings.models.cheap : tier === 'reasoning' ? ctx.settings.models.reasoning : ctx.settings.models.embedding, dryRun: ctx.dryRun };
          if (tier === 'embedding') {
            const r = await client.embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['seo-agent connectivity test'] });
            const result = r.ok
              ? { ok: true, ...common, modelReturned: r.model, dimensions: r.dimensions, inputTokens: r.usage.inputTokens, cost: r.costMicros === null ? 'unknown' : formatUsd(r.costMicros), costMicros: r.costMicros }
              : {
                  ok: false,
                  ...common,
                  status: r.status,
                  reason: r.reason,
                  nextStep: r.nextStep ?? null,
                  ambiguous: r.ambiguous ?? false,
                  // A failure after the gateway processed the request still cost money: never shown as $0.
                  ...(r.billed || r.chargeUnknown || r.ambiguous
                    ? { cost: r.chargeUnknown || r.ambiguous || r.costMicros === null || r.costMicros === undefined ? 'unknown' : formatUsd(r.costMicros), costMicros: r.chargeUnknown || r.ambiguous ? null : (r.costMicros ?? null) }
                    : {}),
                };
            cli.print(g, result, renderTest);
            if (!r.ok && !(ctx.dryRun && r.status === 'disabled')) process.exitCode = r.status === 'budget_exceeded' || r.status === 'not_configured' ? 3 : 1;
            return;
          }
          const r = await client.text({ siteId: ctx.siteId, runId: ctx.runId, role: 'extractor', tier, promptId: 'system.connection-test', variables: {}, evidence: [], maxOutputTokens });
          const result = r.ok
            ? { ok: true, ...common, modelReturned: r.model, output: r.text.slice(0, 200), usage: r.usage, cost: r.costMicros === null ? 'unknown' : formatUsd(r.costMicros), costMicros: r.costMicros, callId: r.callId, promptVersion: r.promptVersion }
            : { ok: false, ...common, status: r.status, reason: r.reason, nextStep: r.nextStep ?? null, ambiguous: r.ambiguous ?? false, callId: r.callId ?? null };
          cli.print(g, result, renderTest);
          if (!r.ok && !(ctx.dryRun && r.status === 'disabled')) process.exitCode = r.status === 'budget_exceeded' || r.status === 'not_configured' ? 3 : 1;
        } finally {
          ctx.db.close();
        }
      }),
    );
}

/** How an unknown charge is settled: the audited reconcile command, from the gateway usage log. */
const UNKNOWN_COST_NEXT_STEP = 'Settle it from the LLM Gateway usage log: `npm run cli -- costs --unresolved` lists the reservation with its `npm run cli -- costs reconcile <reservation-id> ...` command.';

function renderTest(r: Record<string, unknown>): string {
  if (r.ok) {
    return [
      `Model test OK (${r.tier}: ${r.model} -> ${r.modelReturned}); cap ${r.cap}.`,
      r.output !== undefined ? `Output: ${String(r.output)}` : `Dimensions: ${String(r.dimensions)}`,
      `Cost: ${String(r.cost)}${r.cost === 'unknown' ? ` (not reported by the gateway and not computable; kept reserved until reconciled, never counted as $0). ${UNKNOWN_COST_NEXT_STEP}` : ''}`,
    ].join('\n');
  }
  return [
    `Model test did not complete: [${String(r.status)}] ${String(r.reason)}`,
    ...(r.nextStep ? [`Next step: ${String(r.nextStep)}`] : []),
    ...(r.cost !== undefined ? [`Cost: ${String(r.cost)}${r.cost === 'unknown' ? ` (the request may have been billed; kept reserved until reconciled, never counted as $0).${r.nextStep ? '' : ` ${UNKNOWN_COST_NEXT_STEP}`}` : ''}`] : []),
    `Cap: ${String(r.cap)}`,
  ].join('\n');
}
