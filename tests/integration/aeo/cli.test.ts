/**
 * `ai-citations status | import | list` through the real command tree
 * (buildProgram discovers src/cli/commands/ai-citations.ts). SYNTHETIC data
 * only: the files below are written by the test, use the invented brand
 * "Qwertle Tools" on reserved *.test hostnames, and dates relative to the
 * real clock (the CLI uses the system clock).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { addDays, dateInZone } from '../../../src/core/time.js';
import { acquireSiteLock } from '../../../src/jobs/locks.js';
import { enqueue } from '../../../src/jobs/store.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { AEO_TIME_ZONE, aeoSiteConfig } from '../../fixtures/aeo/config.js';

interface Run {
  out: string;
  err: string;
  exitCode: number;
}

async function runCli(ctx: TestContext, args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, '--site', ctx.siteId, '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

const contexts: TestContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
  process.exitCode = undefined;
});

function newCtx(enabled: boolean): TestContext {
  const c = createTestContext({ config: aeoSiteConfig({ enabled }) });
  contexts.push(c);
  return c;
}

/** SYNTHETIC observations dated a few days before the real "today" in the site's business time zone. */
function observationsFile(c: TestContext): string {
  const today = dateInZone(new Date(), AEO_TIME_ZONE);
  const d1 = addDays(today, -3);
  const d2 = addDays(today, -2);
  const csv = [
    '# SYNTHETIC CLI test observations (invented answers)',
    'engine,query,date,grounded,response,cited_urls',
    `perplexity,invoice tool,${d1},yes,"Qwertle is simple.",none`,
    `bing copilot,invoice app,${d2},yes,"Use an app.",https://www.qwertle.test/pricing`,
    `chatgpt,invoice tool,${d2},no,"Qwertle is simple.",`,
  ].join('\n');
  const p = path.join(c.paths.root, 'observations.csv');
  writeFileSync(p, csv);
  return p;
}

const rowCount = (c: TestContext) => c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_citation_checks WHERE site_id = ?', [c.siteId])!.n;

describe('ai-citations CLI while disabled (the default)', () => {
  it('status answers honestly; import and list refuse with INTEGRATION_DISABLED (exit 3) and write nothing', async () => {
    const c = newCtx(false);
    const status = await runCli(c, ['--json', 'ai-citations', 'status']);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ feature: 'aiCitations', enabled: false, state: 'disabled', collectors: [{ id: 'manual_import', state: 'disabled' }, { id: 'api', state: 'not_implemented' }] });
    const human = await runCli(c, ['ai-citations', 'status']);
    expect(human.out).toMatch(/AI-citation monitoring: DISABLED/);
    expect(human.out).toMatch(/api: not_implemented\. No API-based AI-answer engine is implemented/);

    const imp = await runCli(c, ['--json', 'ai-citations', 'import', observationsFile(c)]);
    expect(imp.exitCode).toBe(3);
    expect(JSON.parse(imp.out)).toMatchObject({ ok: false, error: { code: 'INTEGRATION_DISABLED' } });
    expect(rowCount(c)).toBe(0);

    const list = await runCli(c, ['ai-citations', 'list']);
    expect(list.exitCode).toBe(3);
    expect(list.err).toMatch(/Error \[INTEGRATION_DISABLED\]: aiCitations is disabled/);
  });
});

describe('ai-citations CLI when enabled', () => {
  it('imports (dry run first), then lists with a summary that keeps mention, citation, click, and conversion apart', async () => {
    const c = newCtx(true);
    const file = observationsFile(c);

    const dry = await runCli(c, ['--dry-run', 'ai-citations', 'import', file]);
    expect(dry.exitCode).toBe(0);
    expect(dry.out).toMatch(/^DRY RUN \(nothing written\)/);
    expect(rowCount(c)).toBe(0);

    const imp = await runCli(c, ['--json', 'ai-citations', 'import', file, '--source', 'synthetic spot check']);
    expect(imp.exitCode).toBe(0);
    expect(JSON.parse(imp.out)).toMatchObject({ status: 'succeeded', inserted: 3, synthetic: true, method: 'manual_import', grounded: 2, ungrounded: 1 });
    expect(rowCount(c)).toBe(3);

    const again = await runCli(c, ['ai-citations', 'import', file]);
    expect(again.exitCode).toBe(0);
    expect(again.out).toMatch(/Stored: 0 new, 3 unchanged, 0 conflicting/);

    const list = await runCli(c, ['--json', 'ai-citations', 'list']);
    expect(list.exitCode).toBe(0);
    const j = JSON.parse(list.out);
    expect(j).toMatchObject({ total: 3, shown: 3, summary: { status: 'observed', checks: { total: 3, grounded: 2, ungroundedExcluded: 1 } } });
    expect(j.summary.brandMentions).toEqual({ status: 'observed', value: { mentioned: 1, notMentioned: 1, unknown: 0 } });
    expect(j.summary.ownSiteCitations).toEqual({ status: 'observed', value: { cited: 1, notCited: 1, unknown: 0 } });
    expect(j.summary.clicks.status).toBe('unavailable');
    expect(j.summary.conversions.status).toBe('unavailable');

    const human = await runCli(c, ['ai-citations', 'list', '--grounded-only']);
    expect(human.out).toMatch(/Mentioned but not cited: 1\. Cited but not mentioned: 1\./);
    expect(human.out).toMatch(/Clicks: DATA UNAVAILABLE \(a citation is not a click/);
    expect(human.out).toMatch(/Conversions: DATA UNAVAILABLE \(a click is not a conversion/);
    expect(human.out).toMatch(/1 ungrounded model responses excluded from every number/);
    expect(human.out).toMatch(/Observations \(2 of 2, grounded only\)/);
    expect(human.out).not.toMatch(/UNGROUNDED model response/);

    const all = await runCli(c, ['ai-citations', 'list', '--engine', 'chatgpt']);
    expect(all.out).toMatch(/UNGROUNDED model response \(not a search measurement\)/);

    const bad = await runCli(c, ['ai-citations', 'list', '--month', '2026-09', '--from', '2026-09-01']);
    expect(bad.exitCode).toBe(1);
    expect(bad.err).toMatch(/either --month or --from\/--to/);
  });

  it('exits 2 when a re-import conflicts with stored observations (the stored rows are kept)', async () => {
    const c = newCtx(true);
    const file = observationsFile(c);
    await runCli(c, ['ai-citations', 'import', file]);
    const changed = path.join(c.paths.root, 'changed.csv');
    writeFileSync(changed, readFileSync(file, 'utf8').replace('https://www.qwertle.test/pricing', 'none'));
    const r = await runCli(c, ['ai-citations', 'import', changed]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toMatch(/1 conflicting \(kept the stored row\)/);
    expect(rowCount(c)).toBe(3);
  });

  it('refuses to import while a job holds the site lock (a dry run still works)', async () => {
    const c = newCtx(true);
    const jobId = enqueue(c, 'weekly', { note: 'synthetic' }).id;
    expect(acquireSiteLock(c.db, { siteId: c.siteId, owner: 'runner:synthetic-host:1', jobId, leaseMs: 10 * 60_000, now: new Date() }).acquired).toBe(true);
    const file = observationsFile(c);
    const r = await runCli(c, ['ai-citations', 'import', file]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toMatch(/Error \[LOCKED\]/);
    expect(r.err).toContain(jobId);
    expect(rowCount(c)).toBe(0);
    const dry = await runCli(c, ['--dry-run', 'ai-citations', 'import', file]);
    expect(dry.exitCode).toBe(0);
  });
});
