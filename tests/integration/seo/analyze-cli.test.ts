import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { importDataset } from '../../../src/data/import.js';
import { SITE_URL, reportsTestConfig } from '../../fixtures/reports/seed.js';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/analyze.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';
import { HOST, scenarioConfig, seedScenario } from '../../fixtures/seo/scenario.js';

let ctx: TestContext;
afterEach(() => {
  ctx?.cleanup();
  process.exitCode = 0;
});

/** Build a program with the global options of src/cli/main.ts and only the analyze module (other areas are not loaded). */
async function run(args: string[]): Promise<{ out: string; err: string }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, {});
  const program = new Command();
  program
    .name('seo-agent')
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .exitOverride()
    .configureOutput({ writeErr: (s) => (err += s), writeOut: (s) => (out += s) });
  register(program, cli);
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, '--site', ctx.siteId, ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  return { out, err };
}

function setup(): SeoSeeder {
  ctx = createTestContext({ config: scenarioConfig() });
  const seed = new SeoSeeder(ctx.db, ctx.siteId);
  seedScenario(seed);
  return seed;
}

const count = (table: string) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`, [ctx.siteId])!.n;

describe('analyze CLI', () => {
  it('analyze page --json returns metrics, join, route, technical issues, and a recommendation preview', async () => {
    setup();
    const { out } = await run(['--json', 'analyze', 'page', `${HOST}/broken?utm_source=newsletter`]);
    const r = JSON.parse(out);
    expect(r.page.url).toBe(`${HOST}/broken`);
    expect(r.metrics.gsc.clicks).toEqual({ status: 'observed', value: 56 });
    expect(r.metrics.ga4.sessions).toEqual({ status: 'observed', value: 56 });
    expect(r.join.grain).toBe('page/period');
    expect(r.decision.route).toBe('TECHNICAL_BLOCKER');
    expect(r.technical.openIssues[0].issue_type).toBe('accidental_noindex');
    expect(r.recommendationPreview.primary.actionType).toBe('technical_investigation');
    // The scenario rows are synthetic fixtures (is_synthetic = 1): recommendation figures are OBSERVED [SYNTHETIC]
    // (synthetic flag + marker, as report sections label them), never a value under DATA_UNAVAILABLE.
    expect(r.synthetic).toBe(true);
    expect(r.metrics.gsc.synthetic).toBe(true);
    const claims = [r.recommendationPreview.primary, ...r.recommendationPreview.secondary].flatMap((d: { claims: Array<{ label: string; synthetic?: boolean; text: string }> }) => d.claims);
    expect(claims.filter((c) => c.label === 'OBSERVED').every((c) => c.synthetic === true && c.text.startsWith('[SYNTHETIC] '))).toBe(true);
    expect(claims.some((c) => c.label === 'DATA_UNAVAILABLE' && c.text.startsWith('SYNTHETIC (not a real measurement)'))).toBe(false);
    expect(r.recommendationPreview.primary.title).toMatch(/^\[SYNTHETIC\] /);
    expect(r.saved).toBeNull();
    expect(r.reconcile).toMatchObject({ ran: true, dryRun: false });
    expect(count('route_decisions')).toBe(0); // preview only
  });

  it('analyze page renders labeled human output and --save records the decision', async () => {
    setup();
    const { out } = await run(['analyze', 'page', `${HOST}/guide`, '--save']);
    // Synthetic fixture rows: a banner, SYNTHETIC labels, and never "OBSERVED".
    expect(out).toMatch(/^SYNTHETIC DATA - fixture\/demo rows, not real measurements/);
    expect(out).toMatch(/SYNTHETIC Search Console page totals/);
    expect(out).toMatch(/SYNTHETIC GA4 google_organic/);
    expect(out).not.toMatch(/^\s*OBSERVED/m);
    expect(out).toMatch(/not a live ranking/);
    expect(out).toMatch(/Route: HEALTHY/);
    expect(out).toMatch(/\[no_action\] \[SYNTHETIC\] Leave https:\/\/www\.example\.test\/guide unchanged/);
    expect(out).toMatch(/Query-level business impact \(HYPOTHESIS/);
    expect(count('route_decisions')).toBe(1);
  });

  it('--dry-run writes nothing (reconciliation rolled back) and reports unknown pages honestly', async () => {
    setup();
    const before = { pages: count('pages'), aliases: count('url_aliases') };
    const { out, err } = await run(['--dry-run', 'analyze', 'page', `${HOST}/guide`]);
    expect(out + err).toMatch(/No page identity/);
    expect({ pages: count('pages'), aliases: count('url_aliases') }).toEqual(before);
    const rec = await run(['--dry-run', '--json', 'analyze', 'reconcile']);
    const report = JSON.parse(rec.out);
    expect(report.dryRun).toBe(true);
    expect(report.pagesCreated).toBeGreaterThan(0);
    expect(count('pages')).toBe(before.pages);
    const missing = await run(['--json', 'analyze', 'page', 'https://other.example.invalid/x']);
    expect(JSON.parse(missing.out)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('analyze route --save persists decisions, opportunities, and one recommendation', async () => {
    setup();
    const { out } = await run(['--json', 'analyze', 'route', '--save']);
    const r = JSON.parse(out);
    expect(r.routeCounts).toMatchObject({ HEALTHY: 2, TECHNICAL_BLOCKER: 1, UNSURE: 1, INDEXING_UNKNOWN: 1 });
    expect(r.recommendation.primary.url).toBe(`${HOST}/broken`);
    expect(r.recommendation.secondary.length).toBeLessThanOrEqual(3);
    expect(count('route_decisions')).toBe(5);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM recommendations WHERE site_id = ? AND kind = 'primary'", [ctx.siteId])!.n).toBe(1);
    expect(r.synthetic).toBe(true);
    const sources = ctx.db.all<{ source_type: string; trust_class: string }>('SELECT DISTINCT source_type, trust_class FROM sources WHERE site_id = ?', [ctx.siteId]);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((x) => x.source_type === 'fixture' && x.trust_class === 'synthetic')).toBe(true);
    // Synthetic figures are stored OBSERVED with the [SYNTHETIC] marker (their sources are trust_class 'synthetic', checked above).
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM claim_evidence WHERE site_id = ? AND claim_label = 'OBSERVED' AND claim_text LIKE '%Search Console%' AND claim_text NOT LIKE '[SYNTHETIC] %'", [ctx.siteId])!.n).toBe(0);
    const human = await run(['analyze', 'route']);
    expect(human.out).toMatch(/Branded shortlist \(kept separate\)/);
    expect(human.out).toMatch(/^SYNTHETIC DATA/);
  });

  it('analyze links and analyze compare run offline on crawl data', async () => {
    setup();
    const links = await run(['--json', 'analyze', 'links']);
    const l = JSON.parse(links.out);
    expect(l.orphans.metricNote).toMatch(/not an authority score/);
    const cmp = await run(['--json', 'analyze', 'compare', `${HOST}/guide`, '--query', 'what is a widget']);
    const c = JSON.parse(cmp.out);
    expect(c.synthesis.status).toBe('not_run');
    // Truthful: the weekly compare stage runs the synthesis (not "research workflows").
    expect(c.synthesis.reason).toMatch(/weekly pipeline's `compare` stage/);
    expect(c.synthesis.reason).not.toMatch(/runs inside research workflows/);
    expect(c.caveats.join(' ')).toMatch(/No accessible competitor pages/);
  });

  it('analyze compare needs one query (or explicit competitors): competitors are never mixed across queries', async () => {
    setup();
    const r = JSON.parse((await run(['--json', 'analyze', 'compare', `${HOST}/guide`])).out);
    expect(r.error.code).toBe('VALIDATION_FAILED');
    expect(r.error.message).toMatch(/never mixed across queries/);
  });

  it('analyze compare and analyze links label synthetic crawls SYNTHETIC, never OBSERVED', async () => {
    const seed = setup();
    const comp = seed.crawl('competitor');
    seed.crawlResult(comp, { requestedUrl: 'https://a.example.invalid/w', headings: [{ level: 2, text: 'Widget pricing' }], query: 'what is a widget' });
    seed.crawlResult(comp, { requestedUrl: 'https://b.example.invalid/w', headings: [{ level: 2, text: 'Widget pricing' }], query: 'what is a widget' });
    const json = JSON.parse((await run(['--json', 'analyze', 'compare', `${HOST}/guide`, '--query', 'what is a widget'])).out);
    expect(json.synthetic).toBe(true);
    expect(json.competitors).toHaveLength(2);
    const human = (await run(['analyze', 'compare', `${HOST}/guide`, '--query', 'what is a widget'])).out;
    expect(human).toMatch(/^SYNTHETIC DATA - fixture\/demo rows/);
    expect(human).toMatch(/What our page does better \(SYNTHETIC differences\)/);
    expect(human).toMatch(/Gaps \(SYNTHETIC differences, not ranking causes\)/);
    expect(human).not.toMatch(/OBSERVED differences/);
    const links = (await run(['analyze', 'links'])).out;
    expect(links).toMatch(/^SYNTHETIC DATA - fixture\/demo rows/);
    expect(links).toMatch(/SYNTHETIC potential orphans/);
    expect(JSON.parse((await run(['--json', 'analyze', 'links'])).out).synthetic).toBe(true);
  });

  it('analyze compare on a real (non-synthetic) crawl keeps OBSERVED labels', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const own = seed.crawl('own_site', { synthetic: false });
    seed.crawlResult(own, { requestedUrl: `${HOST}/guide`, headings: [{ level: 2, text: 'Widget tests' }] });
    const comp = seed.crawl('competitor', { synthetic: false });
    seed.crawlResult(comp, { requestedUrl: 'https://a.example.invalid/w', headings: [{ level: 2, text: 'Widget pricing' }], query: 'widget guide' });
    const human = (await run(['analyze', 'compare', `${HOST}/guide`, '--query', 'widget guide'])).out;
    expect(human).not.toMatch(/SYNTHETIC/);
    expect(human).toMatch(/What our page does better \(OBSERVED differences\)/);
  });

  it('analyze links picks default destinations from site totals of one property and search type only', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    seed.gscPage([
      { date: '2026-09-01', page: `${HOST}/site-total`, clicks: 5, impressions: 100, position: 3 },
      // Segment rows and other properties/search types must not be summed into the ranking.
      { date: '2026-09-01', page: `${HOST}/segment-only`, clicks: 50, impressions: 100_000, position: 3, segmentKey: 'country:est' },
      { date: '2026-09-01', page: `${HOST}/image-only`, clicks: 50, impressions: 50_000, position: 3, searchType: 'image' },
    ]);
    seed.gscPage([{ date: '2026-09-01', page: `${HOST}/other-property`, clicks: 50, impressions: 90_000, position: 3, property: 'https://www.example.test/' }]);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const r = JSON.parse((await run(['--json', 'analyze', 'links'])).out);
    expect(r.destinations.map((d: { url: string }) => d.url)).toEqual([`${HOST}/site-total`]);
  });

  it('validates options', async () => {
    setup();
    const { out } = await run(['--json', 'analyze', 'page', `${HOST}/guide`, '--days', '0']);
    expect(JSON.parse(out).error.code).toBe('VALIDATION_FAILED');
  });
});

// C1-09: every date of an owner import without --complete is truncated; the headline never says "GSC complete".
// SYNTHETIC CSV written by the test (reserved example.test domain, invented numbers), imported as the owner's
// live import (a live workspace refuses --synthetic, D1-R01).
describe('analyze page headline with truncated dates (C1-09)', () => {
  it('shows GSC as partial and names the owner import, not an API row limit', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const file = path.join(ctx.paths.root, 'pages.csv');
    writeFileSync(file, ['Date,Page,Clicks,Impressions,CTR,Position', `2026-09-01,${SITE_URL}/pricing,6,100,6%,5.2`, `2026-09-02,${SITE_URL}/pricing,4,90,4.44%,5.8`, `2026-09-03,${SITE_URL}/pricing,5,95,5.26%,5.5`].join('\n'));
    expect(importDataset(ctx, 'gsc-pages', file).status).toBe('succeeded');
    const { out } = await run(['analyze', 'page', `${SITE_URL}/pricing`, '--days', '3', '--end', '2026-09-03']);
    const line = out.split('\n').find((l) => l.startsWith('Measurement: '))!;
    expect(line).toMatch(/^Measurement: GSC partial \(/);
    expect(line).toMatch(/owner import without --complete/);
    expect(line).not.toMatch(/GSC complete|row limit/);
    const json = JSON.parse((await run(['--json', 'analyze', 'page', `${SITE_URL}/pricing`, '--days', '3', '--end', '2026-09-03'])).out);
    expect(json.site.gsc).toMatchObject({ status: 'complete', displayStatus: 'partial', truncatedDates: 3 });
  });
});
