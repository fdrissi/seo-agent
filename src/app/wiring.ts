import type { AppContext } from './context.js';
import { collectStatuses, createServices, createSsrfSafePageFetcher, defaultFixtureSiteDir, fixtureCrawlerDeps } from './services.js';
import { registerSitePageFetcherFactory, type SitePageFetcherContext } from '../approvals/page-fetch.js';
import { registerContentDepsFactory } from '../content/deps.js';
import { registerContentJobHandlers } from '../content/jobs.js';
import { registerMemoryLlmFactory } from '../memory/wiring.js';
import { registerIntegrationStatusProvider } from '../obsidian/status.js';
import { registerPipelineJobHandlers } from '../workflows/pipelines/handlers.js';

/**
 * Central integration wiring, installed once before any CLI command runs
 * (src/cli/main.ts). It connects the slices' registration hooks to the
 * concrete services of src/app/services.ts, so every command (memory,
 * content, vault, report, approvals, jobs, schedule, ...) gets real
 * dependencies instead of "not wired" fallbacks:
 *
 * - memory: the LLM client for embeddings (LLM Gateway with the approval
 *   gate; the synthetic fixture client in the demo profile; a disabled client
 *   that answers not_configured otherwise). Paid memory calls still require
 *   the memory commands' explicit --allow-paid flag and budgets.
 * - content: LLM client, full-text memory (never implicit embeddings),
 *   approval gate, and vault writer.
 * - vault render / dashboard: offline integration statuses of every slice.
 * - approvals: the crawler's SSRF-safe fetcher (DNS revalidation, pinned
 *   connections, per-hop checks) for target rechecks and live verification.
 * - jobs: baseline / weekly / monthly / content.queue handlers (and the
 *   content slice's own job types) in the default registry, so `jobs resume`
 *   and `schedule run` can continue them.
 *
 * Idempotent; `uninstallWiring()` clears the registrations (tests).
 */

let installed = false;

export function isWiringInstalled(): boolean {
  return installed;
}

function asAppContext(ctx: SitePageFetcherContext): AppContext | null {
  const c = ctx as Partial<AppContext>;
  return c && typeof c.siteId === 'string' && c.paths && c.settings && c.db ? (c as AppContext) : null;
}

export function installWiring(): void {
  if (installed) return;
  installed = true;

  registerMemoryLlmFactory((ctx) => createServices(ctx).llm);

  registerContentDepsFactory((ctx) => {
    const svc = createServices(ctx);
    return { llm: svc.llm, memory: svc.memory, approvals: svc.approvals, vault: svc.vault };
  });

  registerIntegrationStatusProvider((ctx, opts) => collectStatuses(ctx, createServices(ctx), { network: opts.network }));

  registerSitePageFetcherFactory((ctx) => {
    const app = asAppContext(ctx);
    if (!app) throw new Error('The SSRF-safe page fetcher needs a full application context.');
    return createSsrfSafePageFetcher(app, app.synthetic ? fixtureCrawlerDeps(app, defaultFixtureSiteDir()) : {});
  });

  registerPipelineJobHandlers();
  registerContentJobHandlers();
}

/** Clear the registrations made by installWiring (job handlers stay registered: the job registry has no removal hook). */
export function uninstallWiring(): void {
  registerMemoryLlmFactory(null);
  registerContentDepsFactory(null);
  registerIntegrationStatusProvider(null);
  registerSitePageFetcherFactory(null);
  installed = false;
}
