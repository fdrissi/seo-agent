import { InvalidArgumentError, type Command } from 'commander';
import { competitorCrawlerDepsFor } from '../../app/services.js';
import { assertAllowed } from '../../approvals/policy.js';
import { AppError } from '../../core/errors.js';
import { assessAeoForResult, assessAeoForSite, assessAeoForUrl, type AeoAssessment, type AeoSiteAssessment } from '../../crawler/aeo.js';
import { crawlCompetitorPages, type CrawlCompetitorResult } from '../../crawler/competitor.js';
import { crawlPage, crawlSite, type CrawlSiteResult } from '../../crawler/crawl.js';
import { crawlerStatus, type CrawlerStatusReport } from '../../crawler/status.js';
import { crawlResultsForCrawl } from '../../seo/crawl-data.js';
import { normalizeUrl } from '../../seo/url.js';
import type { CliRuntime } from '../runtime.js';

function positiveInt(label: string, max: number): (v: string) => number {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new InvalidArgumentError(`${label} must be an integer between 1 and ${max}`);
    return n;
  };
}

export function renderCrawl(r: CrawlSiteResult): string {
  const lines: string[] = [];
  lines.push(`Crawl (${r.kind}) of ${r.startUrl}: ${r.status.toUpperCase()}${r.crawlId ? ` [${r.crawlId}]` : ''}`);
  if (r.isSynthetic) lines.push('SYNTHETIC: fixture data, not a live crawl.');
  if (r.status === 'dry_run') {
    const p = r.plan;
    lines.push(
      `Plan: up to ${p.maxPages} page(s), depth ${p.maxDepth}, sitemaps ${p.useSitemaps ? `on (max ${p.maxSitemapFiles} files / ${p.maxSitemapUrls} URLs)` : 'off'}`,
      `      hosts ${p.allowedHostnames.join(', ')}; delay ${p.requestDelayMs} ms; ${p.perHostConcurrency} per host; timeout ${p.timeoutMs} ms; max ${p.maxBytes} bytes; ${p.maxRedirects} redirects`,
      `      user agent "${p.userAgent}"; excluded paths: ${p.excludedPaths.length ? p.excludedPaths.join(', ') : '(none)'}`,
      `      SSRF guard: http/https only, default ports${p.guard.allowedHostPorts.length ? ` + ${p.guard.allowedHostPorts.join(', ')}` : ''}, DNS-pinned connections`,
    );
  }
  if (r.stopReason) lines.push(`Stop reason: ${r.stopReason}`);
  if (r.crawlId) {
    const c = r.counts;
    lines.push(`Requests: ${c.attempted} attempted, ${c.fetched} fetched, ${c.blocked} blocked, ${c.failed} failed, ${c.skipped} skipped (excluded/trap)`);
    if (r.unvisited) lines.push(`Not fetched because of maxPages: ${r.unvisited}`);
    for (const rb of r.robots) lines.push(`robots.txt ${rb.origin}: ${rb.state} - ${rb.note}${rb.crawlDelayMs ? ` (crawl-delay ${rb.crawlDelayMs} ms honoured)` : ''}`);
    if (r.sitemaps) lines.push(`Sitemaps: ${r.sitemaps.parsed}/${r.sitemaps.files} file(s) parsed, ${r.sitemaps.urls} URL(s)${r.sitemaps.truncated ? ' (truncated by limits)' : ''}`);
    if (r.render.requested) lines.push(`Rendering: ${r.render.status} (${r.render.rendered} page(s)) - ${r.render.detail}`);
  }
  if (r.checks) {
    lines.push('', `Technical checks: ${r.checks.opened} new, ${r.checks.updated} still open, ${r.checks.resolved} resolved (${r.checks.confirmedCount} confirmed blockers)`);
    for (const [t, n] of Object.entries(r.checks.byType).sort((a, b) => b[1] - a[1])) lines.push(`  ${t}: ${n}`);
    lines.push('  Title/description length and duplicate-title findings are editorial heuristics, not ranking rules.');
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  if (r.nextStep) lines.push(`Next step: ${r.nextStep}`);
  return lines.join('\n');
}

export function renderCompetitor(r: CrawlCompetitorResult): string {
  const lines = [`Competitor crawl: ${r.status.toUpperCase()}${r.crawlId ? ` [${r.crawlId}]` : ''} (max ${r.maxPerQuery} per query, cap ${r.maxPerQueryCap})`];
  if (r.isSynthetic) lines.push('SYNTHETIC: fixture data, not a live crawl.');
  for (const p of r.pages) {
    const tail =
      p.status === 'fetched'
        ? `${p.httpStatus} "${(p.title ?? '').slice(0, 60)}" ${p.wordCount} words${p.changes.length ? ` changes: ${p.changes.join(', ')}` : ''}${p.injectionSuspected ? ' [instruction-like text flagged; stored as untrusted data]' : ''}`
        : p.status === 'cached'
          ? `"${(p.title ?? '').slice(0, 60)}" ${p.wordCount ?? '?'} words - ${p.reason ?? 'reused snapshot'}`
          : `${p.blockedReason ? `[${p.blockedReason}] ` : p.failureReason ? `[${p.failureReason}, retry-eligible] ` : ''}${p.reason ?? ''}`;
    lines.push(`  ${p.status.padEnd(8)} ${p.url}${p.query ? ` (query: ${p.query})` : ''}${p.scope === 'manual_urls' ? ' [manual URL: not in a stored SERP of the query]' : ''} ${tail}`);
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  if (r.nextStep) lines.push(`Next step: ${r.nextStep}`);
  return lines.join('\n');
}

const MARK: Record<string, string> = { ok: 'OK    ', review: 'REVIEW', unknown: 'n/a   ' };

export function renderAeo(a: AeoAssessment): string {
  const lines = [
    `AEO assessment (${a.label}, ${a.version}) of ${a.url}${a.isSynthetic ? ' [SYNTHETIC fixture crawl]' : ''}`,
    `  snapshot: crawl result ${a.resultId} fetched ${a.fetchedAt} (HTTP ${a.statusCode ?? 'none'}); ${a.counts.ok} ok, ${a.counts.review} to review, ${a.counts.unknown} unknown`,
    `  ${MARK[a.answer.status]} answer near the top: ${a.answer.summary}`,
  ];
  for (const q of a.answer.queries) lines.push(`           - "${q.query}" (${q.impressions} impressions): ${q.answeredNearTop ? 'addressed' : 'not clearly addressed'}; terms ${q.matchedTerms.length}/${q.terms.length}`);
  lines.push(`  ${MARK[a.headings.status]} headings: ${a.headings.summary}`);
  for (const q of a.headings.questionHeadings.filter((x) => x.answered === false)) lines.push(`           - "${q.text}": ${q.detail}`);
  lines.push(`  ${MARK[a.sections.status]} self-contained sections: ${a.sections.summary}`);
  lines.push(`  ${MARK[a.evidence.status]} evidence and citations: ${a.evidence.summary}`);
  const e = a.eligibility;
  lines.push(e ? `  eligibility (observed signals): crawl ${e.crawl}; indexing ${e.indexing}; snippet ${e.snippet}; AI features ${e.aiFeatures}${e.reasons.length ? ` - ${e.reasons.join(' ')}` : ''}` : '  eligibility: unknown');
  if (e) lines.push(`  ${e.caveat}`);
  for (const c of a.caveats) lines.push(`  Note: ${c}`);
  return lines.join('\n');
}

function renderAeoSite(r: AeoSiteAssessment): string {
  if (!r.pages.length) return [`AEO assessment: no assessed pages${r.crawlId ? ` in crawl ${r.crawlId}` : ''}.`, ...r.notes.map((n) => `Note: ${n}`)].join('\n');
  const lines = [`AEO assessment (HEURISTIC) of ${r.pages.length} page(s) from crawl ${r.crawlId}${r.notAssessed ? `; ${r.notAssessed} more not assessed (--limit)` : ''}`];
  for (const p of r.pages) {
    const flags = (['answer', 'headings', 'sections', 'evidence'] as const).filter((k) => p[k].status === 'review');
    lines.push(`  ${String(p.counts.review).padStart(2)} to review  ${p.url}${flags.length ? `  (${flags.join(', ')})` : ''}${p.eligibility && p.eligibility.indexing === 'blocked_by_noindex' ? '  [noindex observed]' : ''}`);
  }
  lines.push('Run `crawl aeo <url>` for the details of one page. All checks are editorial heuristics, not ranking rules.');
  for (const n of r.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

/** AEO assessment of the page fetched by a `crawl page` run (null when nothing usable was stored). */
function aeoForCrawl(ctx: Parameters<typeof assessAeoForResult>[0], crawlId: string | null, url: string): AeoAssessment | null {
  if (!crawlId) return null;
  const rows = crawlResultsForCrawl(ctx.db, ctx.siteId, crawlId);
  const n = normalizeUrl(url)?.url ?? url;
  const ok = (r: (typeof rows)[number]) => r.status_code !== null && r.status_code >= 200 && r.status_code < 300 && !r.blocked_reason;
  const row = rows.find((r) => ok(r) && (r.final_url === n || r.requested_url === n)) ?? rows.find(ok) ?? rows[0];
  return row ? assessAeoForResult(ctx, row.id) : null;
}

function renderStatus(r: CrawlerStatusReport): string {
  const lines = [
    `crawler: ${r.crawler.state} - ${r.crawler.detail}${r.crawler.nextStep ? `\n  next: ${r.crawler.nextStep}` : ''}`,
    `playwright: ${r.playwright.state} - ${r.playwright.detail}${r.playwright.nextStep ? `\n  next: ${r.playwright.nextStep}` : ''}`,
  ];
  if (r.lastCrawl) lines.push(`last crawl: ${r.lastCrawl.id} ${r.lastCrawl.kind} ${r.lastCrawl.status} at ${r.lastCrawl.startedAt} (${r.lastCrawl.pagesFetched} fetched, ${r.lastCrawl.pagesBlocked} blocked)${r.lastCrawl.stopReason ? ` - ${r.lastCrawl.stopReason}` : ''}`);
  else lines.push('last crawl: none');
  return lines.join('\n');
}

interface IssueRow {
  url: string;
  issue_type: string;
  severity: string;
  is_heuristic: number;
  confirmed: number;
  status: string;
  last_seen_at: string;
}

export function register(program: Command, cli: CliRuntime): void {
  const crawl = program
    .command('crawl')
    .description('Bounded own-site crawl (robots.txt respected, SSRF-safe) followed by technical checks')
    .option('--max-pages <n>', 'override crawl.maxPages for this run', positiveInt('--max-pages', 10_000))
    .option('--max-depth <n>', 'override crawl.maxDepth for this run', positiveInt('--max-depth', 20))
    .option('--no-sitemaps', 'do not discover sitemaps')
    .option('--render', 'render JavaScript-dependent pages with Playwright (optional; needs features.playwright and the playwright package)')
    .option('--no-checks', 'skip technical checks after the crawl')
    .action(
      cli.action(async (opts: { maxPages?: number; maxDepth?: number; sitemaps?: boolean; render?: boolean; checks?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const r = await crawlSite(ctx, {
            ...(opts.maxPages ? { maxPages: opts.maxPages } : {}),
            ...(opts.maxDepth ? { maxDepth: opts.maxDepth } : {}),
            useSitemaps: opts.sitemaps !== false,
            render: !!opts.render,
            runChecks: opts.checks !== false,
          });
          cli.print(g, r, renderCrawl);
          if (r.status === 'failed') process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  crawl
    .command('page <url>')
    .description('Fetch and analyse one own-site URL (no link following), including the heuristic AEO assessment')
    .option('--render', 'also render with Playwright when available and the raw HTML looks JavaScript-dependent')
    .action(
      cli.action(async (url: string, opts: { render?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const r = await crawlPage(ctx, url, { render: !!opts.render });
          const aeo = r.status === 'dry_run' ? null : aeoForCrawl(ctx, r.crawlId, url);
          cli.print(g, { ...r, aeo }, (x: CrawlSiteResult & { aeo: AeoAssessment | null }) => [renderCrawl(x), ...(x.aeo ? ['', renderAeo(x.aeo)] : [])].join('\n'));
          if (r.status === 'failed') process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  crawl
    .command('aeo [url]')
    .description('Heuristic AEO assessment from stored crawl results (answer near the top for the page\'s top Search Console queries, headings, self-contained sections, evidence, crawl/index/snippet eligibility); no network')
    .option('--limit <n>', 'pages assessed from the latest own-site crawl when no URL is given', positiveInt('--limit', 5_000), 50)
    .action(
      cli.action(async (url: string | undefined, opts: { limit: number }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          if (url) {
            const a = assessAeoForUrl(ctx, url);
            if (!a) throw new AppError('NOT_FOUND', `No stored own-site crawl result for ${url}.`, { hint: `Run \`crawl page ${url}\` (or \`crawl\`) first; the assessment reads stored crawl results only.` });
            cli.print(g, a, renderAeo);
          } else {
            cli.print(g, assessAeoForSite(ctx, { limit: opts.limit }), renderAeoSite);
          }
        } finally {
          ctx.db.close();
        }
      }),
    );

  crawl
    .command('competitor <urls...>')
    .description(
      'Fetch selected competitor pages for a serious query (needs --mode RESEARCH; robots.txt respected; stored as untrusted data). ' +
        'Without --query only research.competitors / research.approvedDomains hosts are fetched; with --query only URLs listed in a stored SERP snapshot of that query (or on approved hosts) are fetched; ' +
        'fresh snapshots are reused (research.dataforseo.cacheDays.competitor)',
    )
    .option('--query <query>', 'the shortlisted query these pages rank for (URLs must be in a stored SERP snapshot of it, or on an approved host)')
    .option('--manual-urls', 'with --query: crawl URLs you checked yourself even though no stored SERP snapshot of the query lists them (recorded in the audit log as manual)')
    .option('--max-per-query <n>', 'pages per query (default crawl.competitorPagesPerQuery; capped at crawl.competitorPagesPerQueryMax)', positiveInt('--max-per-query', 10))
    .option('--refresh', 're-fetch even when a snapshot is within the volatility TTL')
    .action(
      cli.action(async (urls: string[], opts: { query?: string; manualUrls?: boolean; maxPerQuery?: number; refresh?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (opts.manualUrls && !opts.query?.trim()) {
          throw new AppError('VALIDATION_FAILED', '--manual-urls needs --query: it vouches for URLs you saw ranking for that query.', {
            hint: 'Without a query, only research.competitors / research.approvedDomains hosts are crawled; add the domain to research.approvedDomains instead.',
          });
        }
        const ctx = cli.context(g);
        try {
          // Policy external_research (src/approvals/policy.ts): competitor crawling needs --mode RESEARCH (a dry run sends nothing).
          if (!g.dryRun) assertAllowed(ctx.mode, 'external_research');
          const r = await crawlCompetitorPages(
            ctx,
            urls.map((url) => ({ url, query: opts.query?.trim() ? opts.query : null })),
            {
              ...competitorCrawlerDepsFor(ctx),
              ...(opts.maxPerQuery ? { maxPerQuery: opts.maxPerQuery } : {}),
              // The crawler records a query URL as SERP-discovered only when a stored SERP snapshot lists it.
              origin: opts.query?.trim() && !opts.manualUrls ? 'serp_discovered' : 'manual',
              ...(opts.manualUrls ? { manualUrls: true } : {}),
              ...(opts.refresh ? { refresh: true } : {}),
            },
          );
          cli.print(g, r, renderCompetitor);
          if (r.status === 'failed') process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  crawl
    .command('status')
    .description('Crawler and Playwright status (use --network for a free robots.txt reachability check)')
    .option('--network', 'fetch the site robots.txt to verify reachability')
    .action(
      cli.action(async (opts: { network?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          cli.print(g, await crawlerStatus(ctx, { network: !!opts.network }), renderStatus);
        } finally {
          ctx.db.close();
        }
      }),
    );

  crawl
    .command('issues')
    .description('List open technical issues from crawls (heuristics and suspicions are labelled)')
    .option('--all', 'include resolved and ignored issues')
    .option('--limit <n>', 'maximum rows', positiveInt('--limit', 5_000), 100)
    .action(
      cli.action(async (opts: { all?: boolean; limit: number }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const rows = ctx.db.all<IssueRow>(
            `SELECT url, issue_type, severity, is_heuristic, confirmed, status, last_seen_at FROM technical_issues
              WHERE site_id = ? ${opts.all ? '' : "AND status = 'open'"}
              ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, issue_type, url LIMIT ?`,
            [ctx.siteId, opts.limit],
          );
          cli.print(g, { siteId: ctx.siteId, issues: rows }, (r: { issues: IssueRow[] }) =>
            r.issues.length
              ? r.issues
                  .map((i) => `${i.severity.padEnd(8)} ${i.issue_type.padEnd(34)} ${i.confirmed ? 'CONFIRMED ' : ''}${i.is_heuristic ? 'HEURISTIC ' : ''}${i.status === 'open' ? '' : `[${i.status}] `}${i.url}`)
                  .join('\n')
              : 'No open technical issues recorded. (Run `crawl` first; HTTP 200 does not prove indexing.)',
          );
        } finally {
          ctx.db.close();
        }
      }),
    );
}
