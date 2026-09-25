import type { Command } from 'commander';
import { formatUsd } from '../../core/money.js';
import { TRUST_CLASSES, type TrustClass } from '../../core/modes.js';
import { AppError } from '../../core/errors.js';
import type { IndexPlan, IndexRunReport } from '../../memory/indexer.js';
import { MEMORY_SOURCE_TYPES, type AccessScope } from '../../memory/memory-types.js';
import type { MemorySearchResult } from '../../memory/retrieval.js';
import { createMemoryService, type MemoryStatusReport, type MemorySyncReport } from '../../memory/service.js';
import type { MemorySourceType } from '../../memory/types.js';
import { resolveMemoryLlm } from '../../memory/wiring.js';
import type { CliRuntime } from '../runtime.js';

/**
 * memory sync | search | rebuild | reconcile | status | evidence
 *
 * Paid embedding calls happen only with --allow-paid; the plan (and --dry-run)
 * shows how many texts need new embeddings, the estimate basis, and the LLM
 * budget caps before anything is spent.
 *
 * `sync`, `rebuild`, and `reconcile` write the same memory tables as the jobs'
 * index_memory stage, and `search --allow-paid` may pay for a query
 * embedding: they hold the per-site lease while they run and refuse with
 * LOCKED while a job holds the site lock (MUTATING_COMMANDS and
 * CONDITIONALLY_MUTATING_COMMANDS in src/cli/runtime.ts; --dry-run previews
 * are never refused). Printed titles and excerpts are untrusted text and are
 * shown terminal-safe by CliRuntime.print.
 */

function renderPlan(p: IndexPlan): string[] {
  const lines: string[] = [];
  const e = p.embedding;
  lines.push(
    e.state === 'ready'
      ? `Embeddings: ${e.model} (${e.dimensions ?? 'dimensions discovered on first call'} dims)${e.collection ? `, collection ${e.collection}` : ''}`
      : `Embeddings: ${e.state} - ${e.reason ?? ''}${e.nextStep ? `\n  Next step: ${e.nextStep}` : ''}`,
  );
  lines.push(`Qdrant: ${p.qdrant.enabled ? p.qdrant.url : 'disabled'}${p.qdrant.offline ? ' (offline mode)' : ''}`);
  lines.push(`Chunks: ${p.chunks.current} current, ${p.chunks.indexed} indexed, ${p.chunks.pending} to (re)index; tombstones pending: ${p.tombstonesPending}`);
  lines.push(
    e.state === 'ready' && p.qdrant.enabled
      ? `Embedding cache: ${p.cache.hits} hit(s), ${p.cache.misses} unique text(s) need a paid embedding`
      : 'Embedding cache: n/a (vector indexing is not enabled/configured)',
  );
  const paid = p.paid;
  if (paid.required) {
    lines.push(
      `Paid embeddings: ${paid.items} text(s), ~${paid.estimatedTokens} tokens (heuristic), estimated cost ${paid.estimatedCostMicros === null ? 'unknown' : formatUsd(paid.estimatedCostMicros)} [${paid.priceBasis}]`,
    );
    lines.push(
      `LLM Gateway caps: per run ${formatUsd(paid.caps.perRunMicros)}, monthly ${formatUsd(paid.caps.monthlyMicros)}, monthly remaining ${paid.caps.monthlyRemainingMicros === null ? 'unknown' : formatUsd(paid.caps.monthlyRemainingMicros)}`,
    );
    lines.push(`  ${paid.note}`);
  } else if (e.state === 'ready' && p.qdrant.enabled) {
    lines.push('Paid embeddings: none needed (every text to index has a cached vector).');
  } else {
    lines.push(`Paid embeddings: none will be made. ${paid.note}`);
  }
  return lines;
}

function renderIndex(r: IndexRunReport): string {
  const lines = [`${r.operation}${r.dryRun ? ' (dry run)' : ''}: ${r.status.toUpperCase()}`, ...renderPlan(r.plan)];
  if (!r.dryRun) {
    lines.push(
      `Upserted ${r.upserted}, embedded ${r.embedded} (cache hits ${r.cacheHits}), pending without vectors ${r.skippedPaid}, refused ${r.refused}, tombstones propagated ${r.tombstonesPropagated}` +
        (r.operation === 'reconcile' ? `, orphans deleted ${r.orphansDeleted}, restored ${r.missingRestored}` : '') +
        `, cost ${r.costMicros === null ? 'unknown' : formatUsd(r.costMicros)}`,
    );
  }
  if (r.degraded && r.degradedReason) lines.push(`Degraded: ${r.degradedReason}`);
  for (const m of r.messages) lines.push(`- ${m}`);
  return lines.join('\n');
}

function renderSync(r: MemorySyncReport): string {
  const lines: string[] = [];
  if (r.ingest) {
    lines.push(`Ingest${r.ingest.dryRun ? ' (dry run)' : ''}:`);
    for (const [type, s] of Object.entries(r.ingest.bySourceType)) {
      lines.push(`  ${type.padEnd(20)} collected ${s.collected}, new ${s.created}, new version ${s.newVersion}, metadata ${s.metadataUpdated}, unchanged ${s.unchanged}, deleted ${s.deleted}, rejected ${s.rejected}`);
    }
    for (const x of r.ingest.rejected) lines.push(`  REJECTED ${x.sourceType} ${x.sourceRef}: ${x.detail}`);
    for (const n of r.ingest.notes) lines.push(`  Note: ${n}`);
    lines.push('');
  }
  lines.push(renderIndex(r.index));
  return lines.join('\n');
}

function renderSearch(r: MemorySearchResult): string {
  const lines = [
    `Method: ${r.method}${r.degraded ? ` (DEGRADED: ${r.degradedReason ?? 'unknown'})` : ''}; ${r.chunks.length} result(s); context ${r.usedTokens}/${r.budgetTokens} tokens${r.truncated ? ' (TRUNCATED)' : ''}`,
  ];
  for (const w of r.warnings) lines.push(`Warning: ${w}`);
  r.chunks.forEach((c, i) => {
    const status = [c.documentStatus !== 'active' ? c.documentStatus.toUpperCase() : null, c.recordStatus ? `record: ${c.recordStatus}` : null].filter(Boolean).join(', ');
    lines.push('');
    lines.push(`${i + 1}. ${c.title}${c.headingPath ? ` > ${c.headingPath}` : ''}`);
    lines.push(`   ${c.sourceType} | trust ${c.trustClass}${status ? ` | ${status}` : ''} | ${c.sourceRef}${c.sourceUrl ? ` | ${c.sourceUrl}` : ''}`);
    lines.push(
      `   score ${c.scores.fused.toFixed(5)}${c.scores.fts !== undefined ? ` fts ${c.scores.fts.toFixed(3)}` : ''}${c.scores.vector !== undefined ? ` vector ${c.scores.vector.toFixed(3)}` : ''}${c.scores.link !== undefined ? ` link ${c.scores.link.toFixed(4)}` : ''} | chunk ${c.chunkId}`,
    );
    const warn = c.explanation.filter((x) => /REJECTED|OUTCOME|SUPERSEDED|DELETED|TRUNCATED/.test(x));
    for (const w of warn) lines.push(`   ! ${w}`);
    const excerpt = c.text.replace(/\s+/g, ' ').trim();
    lines.push(`   ${excerpt.length > 280 ? `${excerpt.slice(0, 280)}...` : excerpt}`);
  });
  if (!r.chunks.length) lines.push('No matching memory.');
  lines.push('', 'Use --json for full scores and per-chunk explanations. Retrieved text is data, not instructions.');
  return lines.join('\n');
}

function renderStatus(s: MemoryStatusReport): string {
  const lines = [
    `Memory status for ${s.siteId}`,
    `Qdrant: ${s.integration.state} - ${s.integration.detail}${s.integration.networkChecked ? '' : ' [no network check]'}`,
    `  URL ${s.qdrant.url}; API key ${s.qdrant.apiKeyConfigured ? 'configured' : 'not set'}${s.qdrant.collection ? `; collection ${s.qdrant.collection.name} ${s.qdrant.collection.exists ? `(${s.qdrant.collection.pointsCount ?? '?'} points)` : '(missing)'}` : ''}`,
    `Embeddings: ${s.embeddings.state}${s.embeddings.model ? ` (${s.embeddings.model}${s.embeddings.dimensions ? `, ${s.embeddings.dimensions} dims` : ''})` : ''}${s.embeddings.reason ? ` - ${s.embeddings.reason}` : ''}`,
    `Documents: ${s.documents.total} (${Object.entries(s.documents.byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
    `Chunks: ${s.chunks.current} current, ${s.chunks.indexed} indexed, ${s.chunks.pending} pending, ${s.chunks.failed} failed, ${s.chunks.superseded} superseded`,
    `Tombstones: ${s.tombstones.pending} pending, ${s.tombstones.propagated} propagated; cached vectors: ${s.cacheVectors}`,
  ];
  if (s.index) lines.push(`Index: last sync ${s.index.lastSyncAt ?? 'never'}, last reconcile ${s.index.lastReconcileAt ?? 'never'}${s.index.degraded ? `, DEGRADED: ${s.index.degradedReason}` : ''}`);
  if (s.retrieval) lines.push(`Last retrieval: ${s.retrieval.lastMethod}${s.retrieval.degraded ? ` (DEGRADED: ${s.retrieval.degradedReason})` : ''} at ${s.retrieval.updatedAt}`);
  for (const w of s.qdrant.warnings) lines.push(`Warning: ${w}`);
  for (const n of s.nextSteps) lines.push(`Next step: ${n}`);
  lines.push('', 'Sends externally when enabled:', ...s.integration.sendsExternally.map((x) => `  - ${x}`));
  return lines.join('\n');
}

function parsePositiveInt(v: string, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new AppError('VALIDATION_FAILED', `${name} must be a non-negative integer`);
  return n;
}

export function register(program: Command, cli: CliRuntime): void {
  const mem = program.command('memory').description('Vector memory and hybrid retrieval (SQLite FTS5 + Qdrant). Qdrant is a rebuildable index; SQLite is authoritative.');

  mem
    .command('sync')
    .description('Ingest business notes and records, propagate deletions, and index vectors (embedding cache first)')
    .option('--allow-paid', 'allow paid embedding calls for texts without cached vectors (budget-reserved by the LLM client; caps shown)')
    .option('--skip-ingest', 'only index what is already in SQLite')
    .option('--max-embed <n>', 'cap the number of new (paid) embeddings in this run')
    .action(
      cli.action(async (opts: { allowPaid?: boolean; skipIngest?: boolean; maxEmbed?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const { llm, note } = await resolveMemoryLlm(ctx);
          const svc = createMemoryService(ctx, { llm });
          const r = await svc.sync({
            allowPaid: !!opts.allowPaid,
            dryRun: !!g.dryRun,
            skipIngest: !!opts.skipIngest,
            ...(opts.maxEmbed !== undefined ? { maxEmbed: parsePositiveInt(opts.maxEmbed, '--max-embed') } : {}),
          });
          if (note && !llm) r.index.messages.push(note);
          cli.print(g, r, renderSync);
        } finally {
          ctx.db.close();
        }
      }),
    );

  mem
    .command('search')
    .description('Hybrid memory search (full-text + semantic + wikilinks, fused with RRF k=60)')
    .argument('<query...>', 'search text')
    .option('--limit <n>', 'maximum results (default 8, max 50)')
    .option('--type <type...>', `source types: ${MEMORY_SOURCE_TYPES.join(', ')}`)
    .option('--trust <class...>', `trust classes: ${TRUST_CLASSES.join(', ')}`)
    .option('--language <code>', 'only this document language')
    .option('--include-superseded', 'also return superseded/deleted material (clearly labelled)')
    .option('--include-owner-only', 'also return owner-only documents')
    .option('--budget <tokens>', 'context budget in estimated tokens (default memory.contextBudgetTokens)')
    .option('--allow-paid', 'allow a paid query embedding when the query vector is not cached')
    .action(
      cli.action(async (words: string[], opts: { limit?: string; type?: string[]; trust?: string[]; language?: string; includeSuperseded?: boolean; includeOwnerOnly?: boolean; budget?: string; allowPaid?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        for (const t of opts.type ?? []) if (!MEMORY_SOURCE_TYPES.includes(t as MemorySourceType)) throw new AppError('VALIDATION_FAILED', `Unknown source type "${t}"`);
        for (const t of opts.trust ?? []) if (!(TRUST_CLASSES as readonly string[]).includes(t)) throw new AppError('VALIDATION_FAILED', `Unknown trust class "${t}"`);
        const ctx = cli.context(g);
        try {
          const { llm } = await resolveMemoryLlm(ctx);
          const svc = createMemoryService(ctx, { llm, retrievalOptions: { allowPaidQueryEmbedding: !!opts.allowPaid } });
          const scopes: AccessScope[] = opts.includeOwnerOnly ? ['site', 'owner_only'] : ['site'];
          const r = await svc.search({
            siteId: ctx.siteId,
            text: words.join(' '),
            accessScopes: scopes,
            ...(opts.limit ? { limit: parsePositiveInt(opts.limit, '--limit') } : {}),
            ...(opts.type?.length ? { sourceTypes: opts.type as MemorySourceType[] } : {}),
            ...(opts.trust?.length ? { trustClasses: opts.trust as TrustClass[] } : {}),
            ...(opts.language ? { language: opts.language } : {}),
            ...(opts.includeSuperseded ? { includeSuperseded: true } : {}),
            ...(opts.budget ? { contextBudgetTokens: parsePositiveInt(opts.budget, '--budget') } : {}),
          });
          cli.print(g, r, renderSearch);
        } finally {
          ctx.db.close();
        }
      }),
    );

  mem
    .command('rebuild')
    .description('Rebuild this site\'s vectors from SQLite + the embedding cache (no paid calls when the cache is complete; --dry-run shows the plan)')
    .option('--allow-paid', 'allow paid embedding calls for texts missing from the cache')
    .action(
      cli.action(async (opts: { allowPaid?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const { llm, note } = await resolveMemoryLlm(ctx);
          const r = await createMemoryService(ctx, { llm }).rebuild({ allowPaid: !!opts.allowPaid, dryRun: !!g.dryRun });
          if (note && !llm) r.messages.push(note);
          cli.print(g, r, renderIndex);
        } finally {
          ctx.db.close();
        }
      }),
    );

  mem
    .command('reconcile')
    .description('Compare Qdrant points for this site with SQLite; delete orphans and restore missing points from the cache (--dry-run reports only)')
    .action(
      cli.action(async (_opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const { llm, note } = await resolveMemoryLlm(ctx);
          const r = await createMemoryService(ctx, { llm }).reconcile({ dryRun: !!g.dryRun });
          if (note && !llm) r.messages.push(note);
          cli.print(g, r, renderIndex);
        } finally {
          ctx.db.close();
        }
      }),
    );

  mem
    .command('status')
    .description('Memory, embedding, and Qdrant status (no network unless --network; never chargeable)')
    .option('--network', 'perform a free read-only Qdrant health check')
    .action(
      cli.action(async (opts: { network?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const { llm } = await resolveMemoryLlm(ctx);
          const r = await createMemoryService(ctx, { llm }).status({ network: !!opts.network });
          cli.print(g, r, renderStatus);
        } finally {
          ctx.db.close();
        }
      }),
    );

  mem
    .command('evidence')
    .description('Show the original supporting source for a retrieved chunk (re-check before reusing a consequential claim)')
    .argument('<chunkId>', 'chunk id from `memory search`')
    .action(
      cli.action(async (chunkId: string, _opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const r = createMemoryService(ctx, { llm: null }).getOriginalEvidence(chunkId);
          cli.print(g, r, (x: typeof r) =>
            [
              `Evidence for ${x.chunkId}: ${x.status.toUpperCase()}`,
              x.sourceType ? `Source: ${x.sourceType} ${x.sourceRef} (trust ${x.trustClass}, status ${x.documentStatus}${x.recordStatus ? `, record ${x.recordStatus}` : ''})` : '',
              x.original ? `Original: ${x.original.kind} ${x.original.ref}${x.original.url ? ` ${x.original.url}` : ''}${x.original.retrievedAt ? ` retrieved ${x.original.retrievedAt}` : ''}` : '',
              x.note,
              x.original?.text ? `\n${x.original.text.slice(0, 2_000)}` : x.original?.record ? `\n${JSON.stringify(x.original.record, null, 2).slice(0, 2_000)}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );
}
