/**
 * `pages` CLI (A6-03): owner-set page types win over site.pageTypes and
 * inferred types; inference is a preview unless --apply; --dry-run never
 * writes. SYNTHETIC fixtures on example.test only.
 */
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/pages.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';

let ctx: TestContext;
afterEach(() => {
  ctx?.cleanup();
  process.exitCode = 0;
});
const HOST = 'https://www.example.test';

async function run(args: string[]): Promise<{ out: string; err: string }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, {});
  const program = new Command();
  program.name('seo-agent').option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').exitOverride();
  register(program, cli);
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, '--site', ctx.siteId, ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  return { out, err };
}

function setup(): SeoSeeder {
  ctx = createTestContext({ config: testSiteConfig({ site: { pageTypes: [{ match: '/pricing', type: 'offer' }] } }) });
  const seed = new SeoSeeder(ctx.db, ctx.siteId);
  const crawl = seed.crawl('own_site');
  seed.crawlResult(crawl, { requestedUrl: `${HOST}/pricing`, title: 'Plans and pricing' });
  seed.crawlResult(crawl, { requestedUrl: `${HOST}/blog/widgets`, title: 'Widget tips' });
  seed.crawlResult(crawl, { requestedUrl: `${HOST}/about`, title: 'About us' });
  seed.crawlResult(crawl, { requestedUrl: `${HOST}/shop/pro`, title: 'Widget Pro', structuredData: { '@type': 'Product' } });
  new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
  return seed;
}

const typeOf = (path: string) => ctx.db.get<{ page_type: string | null; page_type_source: string | null }>('SELECT page_type, page_type_source FROM pages WHERE site_id = ? AND path = ?', [ctx.siteId, path]);

describe('pages CLI', () => {
  it('pages list shows the type, its source, and whether it is commercial', async () => {
    setup();
    const r = JSON.parse((await run(['--json', 'pages', 'list'])).out);
    expect(r.commercialPageTypes).toEqual(['offer', 'product', 'category', 'tool']);
    expect(r.configRules).toBe(1);
    expect(r.pages.find((p: { url: string }) => p.url === `${HOST}/pricing`)).toMatchObject({ pageType: 'offer', source: 'config', commercial: true });
    const human = (await run(['pages', 'list', '--source', 'config'])).out;
    expect(human).toMatch(/\/pricing {2}offer \[config\] {2}\(commercial/);
    expect(human).not.toMatch(/\/about/);
    expect(JSON.parse((await run(['--json', 'pages', 'list', '--source', 'bogus'])).out).error.code).toBe('VALIDATION_FAILED');
  });

  it('pages set-type records an owner type that wins over config (audited); "auto" falls back to the config type', async () => {
    setup();
    const dry = JSON.parse((await run(['--json', '--dry-run', 'pages', 'set-type', `${HOST}/pricing`, 'tool'])).out);
    expect(dry).toMatchObject({ dryRun: true, changed: true, after: { pageType: 'tool', source: 'owner' } });
    expect(typeOf('/pricing')).toEqual({ page_type: 'offer', page_type_source: 'config' });
    const set = JSON.parse((await run(['--json', 'pages', 'set-type', `${HOST}/pricing?utm_source=x`, 'tool'])).out);
    expect(set).toMatchObject({ changed: true, commercial: true, before: { pageType: 'offer', source: 'config' }, after: { pageType: 'tool', source: 'owner' } });
    expect(set.warnings.join(' ')).toMatch(/owner type "tool" wins/);
    expect(typeOf('/pricing')).toEqual({ page_type: 'tool', page_type_source: 'owner' });
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'page_type_set'", [ctx.siteId])!.n).toBe(1);
    // A later reconciliation keeps the owner type.
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    expect(typeOf('/pricing')).toEqual({ page_type: 'tool', page_type_source: 'owner' });
    const auto = JSON.parse((await run(['--json', 'pages', 'set-type', `${HOST}/pricing`, 'auto'])).out);
    expect(auto.after).toEqual({ pageType: 'offer', source: 'config' });
    const custom = JSON.parse((await run(['--json', 'pages', 'set-type', `${HOST}/about`, 'service'])).out);
    expect(custom).toMatchObject({ commercial: false });
    expect(custom.warnings.join(' ')).toMatch(/not in router.commercialPageTypes/);
    expect(JSON.parse((await run(['--json', 'pages', 'set-type', `${HOST}/about`, 'Not A Slug!'])).out).error.code).toBe('VALIDATION_FAILED');
    expect(JSON.parse((await run(['--json', 'pages', 'set-type', 'https://other.example.invalid/x', 'offer'])).out).error.code).toBe('NOT_FOUND');
  });

  it('pages infer-types previews guesses and records them as "inferred" only with --apply, never over owner/config types', async () => {
    setup();
    const preview = JSON.parse((await run(['--json', 'pages', 'infer-types'])).out);
    expect(preview.applied).toBe(false);
    const byUrl = Object.fromEntries(preview.inferred.map((i: { url: string; pageType: string; synthetic: boolean }) => [i.url, i]));
    expect(byUrl[`${HOST}/blog/widgets`]).toMatchObject({ pageType: 'article', synthetic: true });
    expect(byUrl[`${HOST}/shop/pro`]).toMatchObject({ pageType: 'product' });
    expect(byUrl[`${HOST}/pricing`]).toBeUndefined(); // config type: not re-inferred
    expect(preview.skipped.map((s: { url: string }) => s.url)).toContain(`${HOST}/about`);
    expect(typeOf('/blog/widgets')).toEqual({ page_type: null, page_type_source: null });
    await run(['--dry-run', 'pages', 'infer-types', '--apply']);
    expect(typeOf('/blog/widgets')).toEqual({ page_type: null, page_type_source: null });
    const applied = JSON.parse((await run(['--json', 'pages', 'infer-types', '--apply'])).out);
    expect(applied.applied).toBe(true);
    expect(typeOf('/blog/widgets')).toEqual({ page_type: 'article', page_type_source: 'inferred' });
    expect(typeOf('/pricing')).toEqual({ page_type: 'offer', page_type_source: 'config' });
  });
});
