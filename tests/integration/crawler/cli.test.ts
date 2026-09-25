import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register as registerCrawl } from '../../../src/cli/commands/crawl.js';
import { register as registerPerf } from '../../../src/cli/commands/perf.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { workspacePaths } from '../../../src/config/paths.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { testSiteConfig } from '../../helpers/context.js';

let root: string;
let out: string[];
let err: string[];

function writeConfig(overrides: Parameters<typeof testSiteConfig>[0] = {}) {
  const cfg = testSiteConfig(overrides);
  writeFileSync(path.join(workspacePaths(root).sitesDir, `${cfg.site.id}.yaml`), stringify(cfg));
}

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; json: any; thrown: unknown }> {
  out = [];
  err = [];
  const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, { HOME: root });
  const program = new Command()
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .exitOverride()
    .configureOutput({ writeErr: (t) => err.push(t), writeOut: (t) => out.push(t) });
  registerCrawl(program, cli);
  registerPerf(program, cli);
  let thrown: unknown = null;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, ...args]);
  } catch (e) {
    thrown = e; // CliExit after rendering an error, or a commander usage error
  }
  const stdout = out.join('\n');
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { stdout, stderr: err.join('\n'), json, thrown };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-cli-crawl-'));
  initWorkspace(root, { allowInsideRepo: true });
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('crawl / perf CLI', () => {
  it('crawl --dry-run shows the bounded plan without requests', async () => {
    writeConfig({ crawl: { maxPages: 50, excludedPaths: ['/cart'] } });
    const r = await run('crawl', '--dry-run', '--json', '--max-pages', '7');
    expect(r.json.status).toBe('dry_run');
    expect(r.json.plan).toMatchObject({ maxPages: 7, excludedPaths: ['/cart'], allowedHostnames: ['www.example.test'] });
    expect(r.json.plan.guard).toMatchObject({ dnsPinning: true, testOnlyAllowLoopback: false });
    const human = await run('crawl', '--dry-run');
    expect(human.stdout).toMatch(/DRY_RUN/);
    expect(human.stdout).toMatch(/DNS-pinned connections/);
  });

  it('crawl --offline reports an honest offline status', async () => {
    writeConfig();
    const r = await run('crawl', '--offline', '--json');
    expect(r.json.status).toBe('offline');
    expect(r.json.nextStep).toBeTruthy();
  });

  it('crawl page and competitor honour --dry-run', async () => {
    writeConfig();
    const page = await run('crawl', 'page', 'https://www.example.test/pricing', '--dry-run', '--json');
    expect(page.json).toMatchObject({ status: 'dry_run', kind: 'single_page' });
    // No stored SERP lists these URLs for the query and rival.example.com is not approved: --manual-urls vouches for them.
    const comp = await run('crawl', 'competitor', 'https://rival.example.com/a', 'https://rival.example.com/b', '--query', 'synthetic widgets', '--manual-urls', '--max-per-query', '1', '--dry-run', '--json');
    expect(comp.json.status).toBe('dry_run');
    expect(comp.json.pages.map((p: { reason: string }) => p.reason)).toEqual(['dry run: would fetch (robots.txt permitting)', 'over the 1-pages-per-query limit']);
    expect(comp.json.pages[0].scope).toBe('manual_urls');
  });

  it('crawl competitor --query refuses URLs outside a stored SERP of the query; --manual-urls needs --query (B6-10)', async () => {
    writeConfig();
    const refused = await run('crawl', 'competitor', 'https://rival.example.com/a', '--query', 'any text at all', '--dry-run', '--json');
    expect(refused.json.status).toBe('failed');
    expect(refused.json.pages[0]).toMatchObject({ status: 'blocked', blockedReason: 'not_approved' });
    expect(refused.json.pages[0].reason).toMatch(/not in a stored live SERP snapshot for the query "any text at all"/);
    const noQuery = await run('crawl', 'competitor', 'https://rival.example.com/a', '--manual-urls', '--dry-run', '--json');
    expect(noQuery.json.error.code).toBe('VALIDATION_FAILED');
    expect(noQuery.json.error.message).toMatch(/--manual-urls needs --query/);
  });

  it('crawl competitor --manual-urls never says pages were crawled when every URL was blocked (C4-11)', async () => {
    writeConfig();
    globalThis.fetch = (async () => {
      throw new Error('no request may be made in this test');
    }) as typeof fetch;
    // IP-literal private destinations: the SSRF guard refuses them statically, before any DNS lookup or connection.
    const args = ['crawl', 'competitor', 'https://10.0.0.1/a', 'https://192.168.1.1/b', '--query', 'synthetic widgets', '--manual-urls', '--max-per-query', '5', '--mode', 'RESEARCH'];
    const json = await run(...args, '--json');
    expect(json.json.status).toBe('failed');
    expect(json.json.pages.map((p: { status: string; scope: string }) => [p.status, p.scope])).toEqual([
      ['blocked', 'manual_urls'],
      ['blocked', 'manual_urls'],
    ]);
    const note = json.json.notes.find((n: string) => n.includes('--manual-urls'));
    expect(note).toMatch(/^0 of 2 manual page\(s\) fetched on the owner's word .*; 2 blocked\.$/);
    expect(json.json.notes.join(' ')).not.toMatch(/crawled on the owner's word/);
    const human = await run(...args);
    expect(human.stdout).toMatch(/Note: 0 of 2 manual page\(s\) fetched on the owner's word/);
    expect(human.stdout).not.toMatch(/page\(s\) crawled/);
  });

  it('rejects invalid options as usage errors before doing anything', async () => {
    writeConfig();
    const r = await run('crawl', '--json', '--max-pages', '0');
    expect((r.thrown as { code?: string }).code).toBe('commander.invalidArgument');
    expect(r.stdout).toBe('');
  });

  it('crawl status and crawl issues work without network', async () => {
    writeConfig();
    const s = await run('crawl', 'status', '--json');
    expect(s.json.crawler.state).toBe('configured_unverified');
    expect(s.json.playwright.state).toBe('disabled');
    expect(s.json.lastCrawl).toBeNull();
    const i = await run('crawl', 'issues');
    expect(i.stdout).toMatch(/HTTP 200 does not prove indexing/);
  });

  it('perf check is explicit: disabled by default in the core profile, dry-run shows the request without the key', async () => {
    writeConfig();
    const disabled = await run('perf', 'check', 'https://www.example.test/', '--json');
    expect(disabled.json.status).toBe('disabled');
    writeConfig({ features: { pagespeed: true } });
    const dry = await run('perf', 'check', 'https://www.example.test/', '--device', 'desktop', '--dry-run', '--json');
    expect(dry.json.status).toBe('dry_run');
    expect(dry.json.plan.psiRequest).toContain('strategy=DESKTOP');
    expect(dry.json.reason).toBe('priority_page'); // default reason; the site root is a priority page
    expect(dry.json.justification.detail).toBe('site root');
    const bad = await run('perf', 'check', 'https://www.example.test/', '--device', 'tablet', '--json');
    expect(bad.json.ok).toBe(false);
    // Non-priority pages are refused by default; manual is an explicit exception with a written justification.
    const notPriority = await run('perf', 'check', 'https://www.example.test/random', '--dry-run', '--json');
    expect(notPriority.json.ok).toBe(false);
    expect(JSON.stringify(notPriority.json)).toMatch(/priority pages/);
    const noWhy = await run('perf', 'check', 'https://www.example.test/random', '--reason', 'manual', '--dry-run', '--json');
    expect(noWhy.json.ok).toBe(false);
    expect(JSON.stringify(noWhy.json)).toMatch(/--justification/);
    const manual = await run('perf', 'check', 'https://www.example.test/random', '--reason', 'manual', '--justification', 'synthetic launch check', '--dry-run', '--json');
    expect(manual.json).toMatchObject({ status: 'dry_run', reason: 'manual', justification: { detail: 'synthetic launch check' } });
    const status = await run('perf', 'status', '--json');
    expect(status.json.map((s: { id: string }) => s.id)).toEqual(['pagespeed', 'crux']);
    const prio = await run('perf', 'priority', '--json');
    expect(prio.json.pages[0].why).toBe('site root');
  });
});
