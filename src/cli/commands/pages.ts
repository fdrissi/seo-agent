import type { Command } from 'commander';
import type { AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { recordAudit } from '../../database/audit.js';
import { commercialPageTypesFromConfig } from '../../router/rules.js';
import { guessPageType } from '../../seo/competitive.js';
import { latestCrawlResultForUrl, loadCrawlText } from '../../seo/crawl-data.js';
import { matchesPageTypePattern, PAGE_TYPE_RE, pageTypeRules, UrlReconciler, type PageRow } from '../../seo/reconcile.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `pages` commands: page identities and their page types (local only, no network).
 *   pages list                 pages with page type, its source, and flags
 *   pages set-type <url> <t>   owner-set page type (page_type_source 'owner'; always wins). `auto` removes it.
 *   pages infer-types          guess missing types from the latest own-site crawl (preview; --apply records 'inferred')
 *
 * Page types drive the router's page-type business evidence
 * (router.commercialPageTypes), commercial relevance in scoring, offer-page
 * detection, and same-type control pages. Precedence: owner > config
 * (site.pageTypes, applied by URL reconciliation) > inferred.
 * --dry-run never writes.
 */

/** Types the deterministic guesser and the documentation use; custom slugs are allowed too. */
export const KNOWN_PAGE_TYPES = ['offer', 'product', 'category', 'tool', 'article', 'comparison', 'list', 'faq', 'other'] as const;

type PageTypeSource = 'owner' | 'config' | 'inferred';

interface PageTypeRow {
  id: string;
  url: string;
  page_type: string | null;
  page_type_source: PageTypeSource | null;
  is_protected: number;
  is_excluded: number;
  lifecycle: string;
}

function configTypeFor(ctx: AppContext, path: string): string | null {
  const rules = pageTypeRules((ctx.config.site as { pageTypes?: unknown }).pageTypes);
  return rules.find((r) => matchesPageTypePattern(path, r.pattern))?.type ?? null;
}

export interface SetTypeResult {
  dryRun: boolean;
  pageId: string;
  url: string;
  before: { pageType: string | null; source: string | null };
  after: { pageType: string | null; source: string | null };
  commercial: boolean;
  changed: boolean;
  warnings: string[];
}

/** Record an owner-set page type (or remove it with type `auto`, falling back to the configured type). */
export function setPageType(ctx: AppContext, url: string, type: string, opts: { dryRun: boolean; actor?: string }): SetTypeResult {
  const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
  const res = rec.resolve(url);
  if (res.status !== 'resolved') {
    throw new AppError('NOT_FOUND', `No page identity for ${url} (${res.reason}: ${res.detail})`, { hint: 'Sync Search Console/GA4 or crawl the site, then run `analyze reconcile`; check site.allowedHostnames.' });
  }
  const page: PageRow | undefined = rec.pageById(res.pageId);
  if (!page) throw new AppError('NOT_FOUND', `Page ${res.pageId} not found.`);
  const t = type.trim().toLowerCase();
  const warnings: string[] = [];
  let after: { pageType: string | null; source: string | null };
  if (t === 'auto') {
    const cfg = configTypeFor(ctx, page.path);
    after = cfg ? { pageType: cfg, source: 'config' } : { pageType: null, source: null };
    if (!cfg) warnings.push('No site.pageTypes rule matches this page: the type is now unset (run `pages infer-types` for a guess).');
  } else {
    if (!PAGE_TYPE_RE.test(t)) throw new AppError('VALIDATION_FAILED', `Invalid page type "${type}": use a short lowercase slug such as ${KNOWN_PAGE_TYPES.slice(0, 5).join(', ')} (or "auto" to remove the owner type).`);
    after = { pageType: t, source: 'owner' };
    if (!(KNOWN_PAGE_TYPES as readonly string[]).includes(t)) warnings.push(`"${t}" is a custom page type (known types: ${KNOWN_PAGE_TYPES.join(', ')}).`);
    const cfg = configTypeFor(ctx, page.path);
    if (cfg && cfg !== t) warnings.push(`site.pageTypes maps this path to "${cfg}"; the owner type "${t}" wins over it.`);
  }
  const before = { pageType: page.page_type, source: page.page_type_source ?? null };
  const changed = before.pageType !== after.pageType || before.source !== after.source;
  const commercialTypes = commercialPageTypesFromConfig(ctx.config);
  if (after.pageType && !commercialTypes.includes(after.pageType)) warnings.push(`"${after.pageType}" is not in router.commercialPageTypes (${commercialTypes.join(', ')}), so it is not page-type business evidence.`);
  if (changed && !opts.dryRun) {
    ctx.db.transaction(() => {
      ctx.db.run('UPDATE pages SET page_type = ?, page_type_source = ? WHERE id = ? AND site_id = ?', [after.pageType, after.source, page.id, ctx.siteId]);
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: opts.actor ?? 'owner (cli)', eventType: 'page_type_set', subjectType: 'page', subjectId: page.id, details: { url: page.url, before, after }, at: ctx.clock.now() });
    });
  }
  return { dryRun: opts.dryRun, pageId: page.id, url: page.url, before, after, commercial: !!after.pageType && commercialTypes.includes(after.pageType), changed, warnings };
}

export interface InferTypesResult {
  dryRun: boolean;
  applied: boolean;
  inferred: Array<{ pageId: string; url: string; pageType: string; signals: string[]; synthetic: boolean }>;
  skipped: Array<{ url: string; reason: string }>;
  note: string;
}

/**
 * Guess page types for pages without one (or with an earlier inferred one)
 * from their latest own-site crawl. Owner and config types are never touched.
 */
export function inferPageTypes(ctx: AppContext, opts: { apply: boolean; dryRun: boolean; limit?: number }): InferTypesResult {
  const pages = ctx.db.all<{ id: string; url: string; path: string }>(
    "SELECT id, url, path FROM pages WHERE site_id = ? AND lifecycle != 'redirected' AND (page_type IS NULL OR page_type_source = 'inferred') ORDER BY url LIMIT ?",
    [ctx.siteId, Math.max(1, opts.limit ?? 500)],
  );
  const inferred: InferTypesResult['inferred'] = [];
  const skipped: InferTypesResult['skipped'] = [];
  const write = opts.apply && !opts.dryRun;
  for (const p of pages) {
    const row = latestCrawlResultForUrl(ctx.db, ctx.siteId, p.url, ['own_site', 'single_page']);
    if (!row || row.status_code === null || row.status_code < 200 || row.status_code >= 300 || row.blocked_reason) {
      skipped.push({ url: p.url, reason: row ? `latest own-site crawl is not a 2xx page (${row.blocked_reason ?? `HTTP ${row.status_code ?? 'n/a'}`})` : 'not crawled yet' });
      continue;
    }
    const g = guessPageType(row, loadCrawlText(ctx.raw, row.text_ref));
    if (g.guess === 'other') {
      skipped.push({ url: p.url, reason: 'no page-type signal (structured data, URL, or wording)' });
      continue;
    }
    const synthetic = (ctx.db.get<{ s: number }>('SELECT c.is_synthetic AS s FROM crawls c WHERE c.id = ?', [row.crawl_id])?.s ?? 0) === 1 || ctx.synthetic;
    inferred.push({ pageId: p.id, url: p.url, pageType: g.guess, signals: g.signals, synthetic });
    if (write) {
      ctx.db.run("UPDATE pages SET page_type = ?, page_type_source = 'inferred' WHERE id = ? AND site_id = ? AND (page_type IS NULL OR page_type_source = 'inferred')", [g.guess, p.id, ctx.siteId]);
    }
  }
  if (write && inferred.length) recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'owner (cli)', eventType: 'page_types_inferred', details: { count: inferred.length }, at: ctx.clock.now() });
  const note = write
    ? `Recorded ${inferred.length} inferred page type(s) (page_type_source 'inferred'). Owner types (\`pages set-type\`) and site.pageTypes always take precedence.`
    : `Preview only: ${inferred.length} page type(s) could be inferred (heuristic guesses from structured data, URL, and wording). Re-run with --apply to record them as 'inferred'${opts.dryRun ? ' (not in a dry run)' : ''}.`;
  return { dryRun: opts.dryRun, applied: write, inferred, skipped, note };
}

export function register(program: Command, cli: CliRuntime): void {
  const pages = program.command('pages').description('Page identities and page types (owner > site.pageTypes config > inferred); local only, no network');

  pages
    .command('list')
    .description('List pages with their page type, its source (owner/config/inferred), and protected/excluded flags')
    .option('--type <type>', 'only pages of this page type (use "none" for pages without a type)')
    .option('--source <source>', 'only types from this source: owner, config, inferred, or none')
    .option('--limit <n>', 'maximum pages (default 200)')
    .action(
      cli.action(async (opts: { type?: string; source?: string; limit?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const limit = opts.limit ? Number(opts.limit) : 200;
        if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new AppError('VALIDATION_FAILED', `--limit must be an integer between 1 and 10000 (got ${opts.limit})`);
        if (opts.source && !['owner', 'config', 'inferred', 'none'].includes(opts.source)) throw new AppError('VALIDATION_FAILED', `--source must be owner, config, inferred, or none (got ${opts.source})`);
        const ctx = cli.context(g);
        try {
          const where = ['site_id = ?'];
          const params: unknown[] = [ctx.siteId];
          if (opts.type === 'none') where.push('page_type IS NULL');
          else if (opts.type) {
            where.push('page_type = ?');
            params.push(opts.type.toLowerCase());
          }
          if (opts.source === 'none') where.push('page_type_source IS NULL');
          else if (opts.source) {
            where.push('page_type_source = ?');
            params.push(opts.source);
          }
          const rows = ctx.db.all<PageTypeRow>(`SELECT id, url, page_type, page_type_source, is_protected, is_excluded, lifecycle FROM pages WHERE ${where.join(' AND ')} ORDER BY url LIMIT ?`, [...params, limit]);
          const commercialTypes = commercialPageTypesFromConfig(ctx.config);
          const counts = ctx.db.all<{ page_type: string | null; page_type_source: string | null; n: number }>('SELECT page_type, page_type_source, COUNT(*) AS n FROM pages WHERE site_id = ? GROUP BY page_type, page_type_source ORDER BY n DESC', [ctx.siteId]);
          const result = {
            commercialPageTypes: commercialTypes,
            configRules: pageTypeRules((ctx.config.site as { pageTypes?: unknown }).pageTypes).length,
            counts: counts.map((c) => ({ pageType: c.page_type, source: c.page_type_source, pages: c.n })),
            pages: rows.map((r) => ({ id: r.id, url: r.url, pageType: r.page_type, source: r.page_type_source, commercial: !!r.page_type && commercialTypes.includes(r.page_type), protected: r.is_protected === 1, excluded: r.is_excluded === 1, lifecycle: r.lifecycle })),
          };
          cli.print(g, result, (r: typeof result) => {
            const lines = [
              `Pages: ${r.pages.length} shown. Commercial page types (router.commercialPageTypes): ${r.commercialPageTypes.join(', ') || '(none)'}. site.pageTypes rules: ${r.configRules}.`,
              `By type/source: ${r.counts.map((c) => `${c.pageType ?? 'untyped'}${c.source ? ` (${c.source})` : c.pageType ? ' (unknown source)' : ''} ${c.pages}`).join(', ') || 'none'}`,
              '',
            ];
            for (const p of r.pages) {
              const flags = [p.commercial ? 'commercial' : null, p.protected ? 'protected' : null, p.excluded ? 'excluded' : null, p.lifecycle !== 'active' ? p.lifecycle : null].filter(Boolean).join(', ');
              lines.push(`  ${p.url}  ${p.pageType ?? '(no type)'}${p.source ? ` [${p.source}]` : p.pageType ? ' [unknown source]' : ''}${flags ? `  (${flags})` : ''}`);
            }
            if (!r.pages.length) lines.push('  (no pages match)');
            lines.push('', 'Set a type with `pages set-type <url> <type>` (owner types always win); map paths in site.pageTypes; guess missing types with `pages infer-types`.');
            return lines.join('\n');
          });
        } finally {
          ctx.db.close();
        }
      }),
    );

  pages
    .command('set-type <url> <type>')
    .description('Set the page type of one page as the owner (page_type_source "owner"; wins over site.pageTypes and inferred types). Type "auto" removes the owner type.')
    .action(
      cli.action(async (url: string, type: string, _opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const r = setPageType(ctx, url, type, { dryRun: !!g.dryRun });
          cli.print(g, r, (x: SetTypeResult) =>
            [
              `${x.url}: ${x.before.pageType ?? '(no type)'}${x.before.source ? ` [${x.before.source}]` : ''} -> ${x.after.pageType ?? '(no type)'}${x.after.source ? ` [${x.after.source}]` : ''}${x.changed ? '' : ' (unchanged)'}${x.dryRun ? ' [dry run: nothing written]' : ''}`,
              `Commercial page type (router.commercialPageTypes): ${x.commercial ? 'yes' : 'no'}`,
              ...x.warnings.map((w) => `Note: ${w}`),
            ].join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  pages
    .command('infer-types')
    .description('Guess page types for untyped pages from their latest own-site crawl (structured data, URL, wording); preview unless --apply (recorded as "inferred"; never overrides owner or config types)')
    .option('--apply', 'record the guesses as page_type_source "inferred" (ignored with --dry-run)')
    .option('--limit <n>', 'maximum pages examined (default 500)')
    .action(
      cli.action(async (opts: { apply?: boolean; limit?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const limit = opts.limit ? Number(opts.limit) : 500;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new AppError('VALIDATION_FAILED', `--limit must be a positive integer (got ${opts.limit})`);
        const ctx = cli.context(g);
        try {
          const r = inferPageTypes(ctx, { apply: !!opts.apply, dryRun: !!g.dryRun, limit });
          cli.print(g, r, (x: InferTypesResult) => {
            const lines = [x.note, ''];
            for (const i of x.inferred) lines.push(`  ${i.url}  ${i.pageType}${i.synthetic ? ' [SYNTHETIC crawl]' : ''}  (${i.signals.join('; ')})`);
            if (!x.inferred.length) lines.push('  (nothing inferred)');
            if (x.skipped.length) lines.push('', `Not inferred: ${x.skipped.length} page(s), e.g. ${x.skipped.slice(0, 3).map((s) => `${s.url} (${s.reason})`).join('; ')}`);
            return lines.join('\n');
          });
        } finally {
          ctx.db.close();
        }
      }),
    );
}
