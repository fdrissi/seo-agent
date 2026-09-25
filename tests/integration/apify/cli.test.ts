import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { register } from '../../../src/cli/commands/apify.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { workspacePaths } from '../../../src/config/paths.js';
import { testSiteConfig } from '../../helpers/context.js';
import { FakeApify, FIXTURE_DIR, TEST_TOKEN, fixtureSchema } from '../../fixtures/apify/fake-apify.js';

/**
 * CLI tests register only the apify command module on a fresh program (other
 * command modules are not loaded). The workspace is a temporary synthetic one;
 * the global fetch is replaced by the fake Apify API.
 */
describe('apify CLI', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let fake: FakeApify;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-apify-cli-'));
    initWorkspace(root, { allowInsideRepo: true });
    const paths = workspacePaths(root);
    const config = testSiteConfig({ features: { apify: true }, research: { seedTopics: ['invoicing software'], subreddits: ['smallbusiness', 'r/freelance'], apify: { build: '0.0.513' } } as never });
    writeFileSync(path.join(paths.sitesDir, `${config.site.id}.yaml`), stringify(config));
    writeFileSync(paths.secretsEnvFile, `APIFY_TOKEN=${TEST_TOKEN}\n`, { mode: 0o600 });
    fake = new FakeApify();
    globalThis.fetch = fake.fetch as typeof fetch;
    out = [];
    err = [];
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<void> {
    const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, { HOME: root } as NodeJS.ProcessEnv);
    const program = new Command();
    program.exitOverride();
    program.option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline');
    register(program, cli);
    try {
      await program.parseAsync(['node', 'seo-agent', '-w', root, ...args]);
    } catch (e) {
      if (!(e instanceof CliExit)) throw e;
    }
  }

  it('inspect performs free reads and stores the schema; test without --confirm-spend never spends', async () => {
    await run('--json', 'apify', 'inspect');
    const inspect = JSON.parse(out.join('\n'));
    expect(inspect.latestBuild.verified).toBe(true);
    expect(inspect.pinnedBuild.resolved.pinned).toBe(true);
    expect(JSON.stringify(inspect)).not.toContain(TEST_TOKEN);
    out = [];
    await run('apify', 'test', '--max-usd', '0.05');
    const text = out.join('\n');
    expect(text).toMatch(/Status: confirmation_required/);
    expect(text).toMatch(/capped at \$0\.03/); // min(estimate $0.03, --max-usd $0.05)
    expect(process.exitCode).toBe(2);
    expect(fake.startCount).toBe(0);
  });

  it('test --confirm-spend requires an explicit cap and shows it before running', async () => {
    await run('apify', 'inspect');
    out = [];
    await run('--json', 'apify', 'test', '--confirm-spend');
    expect(JSON.parse(out.join('\n')).error.message).toMatch(/requires --max-usd/);
    expect(fake.startCount).toBe(0);
    out = [];
    process.exitCode = undefined;
    fake.nextStatuses = ['SUCCEEDED'];
    // The real runtime waits ~10 s before re-reading a finished run for stable usage; drive that with fake timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let done = false;
      const p = run('--json', '--mode', 'RESEARCH', 'apify', 'test', '--confirm-spend', '--max-usd', '0.05', '--term', 'invoice reminders').finally(() => (done = true));
      while (!done) await vi.advanceTimersByTimeAsync(1_000);
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(err.join('\n')).toMatch(/provider-side cap maxTotalChargeUsd=\$0\.03/);
    const result = JSON.parse(out.join('\n'));
    expect(result.status).toBe('completed');
    expect(fake.startCount).toBe(1);
    const post = fake.callsTo('POST', /\/runs$/)[0]!;
    expect(new URL(post.url).searchParams.get('maxTotalChargeUsd')).toBe('0.03');
    expect(JSON.parse(post.body!)).toMatchObject({ searchTerms: ['invoice reminders'], maxPostsCount: 5, crawlCommentsPerPost: false });
    out = [];
    await run('--json', 'apify', 'runs');
    const runs = JSON.parse(out.join('\n'));
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0].processingStatus).toBe('complete');
  });

  it('test binds the paid run to the cap and input shown: a live price change sends nothing', async () => {
    await run('apify', 'inspect');
    // Live pricing changes after the stored snapshot: result now costs $0.004 at every tier.
    const current = fake.actor.pricingInfos[1];
    current.pricingPerEvent.actorChargeEvents.result = { eventTitle: 'Result Saved', eventPriceUsd: 0.004, isPrimaryEvent: true };
    out = [];
    err = [];
    await run('--json', '--mode', 'RESEARCH', 'apify', 'test', '--confirm-spend', '--max-usd', '0.05', '--term', 'invoice reminders');
    expect(err.join('\n')).toMatch(/provider-side cap maxTotalChargeUsd=\$0\.03/); // shown from stored pricing
    const result = JSON.parse(out.join('\n'));
    expect(result.status).toBe('confirmation_required');
    expect(result.detail).toMatch(/Live pricing changed the plan after it was shown/);
    expect(result.plan.capMicros).toBeLessThanOrEqual(30_000); // never above the cap that was shown
    expect(fake.startCount).toBe(0);
    expect(process.exitCode).toBe(2);
  });

  it('runs --confirm-not-accepted refuses an unknown or ineligible run (exit 1)', async () => {
    await run('--json', 'apify', 'runs', '--confirm-not-accepted', 'arun_does_not_exist');
    const r = JSON.parse(out.join('\n'));
    expect(r.confirmation.status).toBe('not_found');
    expect(process.exitCode).toBe(1);
  });

  it('import-schema stores an unverified schema (exit 1) and rejects an example input', async () => {
    const f = path.join(root, 'schema.json');
    writeFileSync(f, JSON.stringify(fixtureSchema()));
    await run('apify', 'import-schema', f, '--build', '0.0.513');
    expect(out.join('\n')).toMatch(/Status: unresolved/);
    expect(process.exitCode).toBe(1);
    out = [];
    await run('--json', 'apify', 'import-schema', path.join(FIXTURE_DIR, 'example-input.json'));
    expect(JSON.parse(out.join('\n')).error.message).toMatch(/example input/);
  });

  it('status without network makes no request; runs lists nothing initially', async () => {
    await run('--json', 'apify', 'status');
    expect(JSON.parse(out.join('\n')).state).toBe('misconfigured');
    expect(fake.calls).toHaveLength(0);
    out = [];
    await run('apify', 'runs');
    expect(out.join('\n')).toMatch(/No Apify runs recorded/);
  });

  it('test --confirm-spend is refused in ANALYZE mode (policy external_research): the confirmation is not a bypass', async () => {
    await run('apify', 'inspect');
    out = [];
    await run('--json', 'apify', 'test', '--confirm-spend', '--max-usd', '0.05');
    const r = JSON.parse(out.join('\n'));
    expect(r.error.code).toBe('POLICY_DENIED');
    expect(r.error.message).toMatch(/requires --mode RESEARCH/);
    expect(process.exitCode).toBe(1);
    expect(fake.startCount).toBe(0);
  });

  it('research previews one run per configured subreddit with the configured limits and a plan hash; nothing is sent', async () => {
    await run('apify', 'inspect');
    out = [];
    await run('--json', 'apify', 'research', '--max-usd', '0.10');
    const r = JSON.parse(out.join('\n'));
    expect(r.status).toBe('dry_run');
    expect(r.confirmed).toBe(false);
    expect(r.runs.map((x: { community: string }) => x.community)).toEqual(['smallbusiness', 'r/freelance']);
    expect(r.perRunCapMicros).toBe(50_000);
    const input = r.runs[0].result.plan.input;
    expect(input).toMatchObject({ searchTerms: ['invoicing software'], withinCommunity: 'smallbusiness', searchTime: 'month' });
    expect(input.maxPostsCount).toBeGreaterThan(5); // configured research.apify limits, not the 5-post test run
    expect(r.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.detail).toMatch(/--mode RESEARCH --confirm-spend/);
    expect(r.classification).toMatchObject({ requested: 'heuristic' });
    expect(r.classification.note).toMatch(/heuristic classifier only/);
    expect(process.exitCode).toBe(2);
    expect(fake.startCount).toBe(0);
    // Human output shows the plan and says which classifier is used.
    out = [];
    await run('apify', 'research', '--max-usd', '0.10', '--all-reddit', '--term', 'late invoices');
    const text = out.join('\n');
    expect(text).toMatch(/Community: \(all of Reddit: no community restriction\)/);
    expect(text).toMatch(/Classification: heuristic classifier only/);
    expect(text).toMatch(/Plan hash: [0-9a-f]{64}/);
  });

  it('research runs exactly the plan shown (bound by --plan), per community, in RESEARCH mode', async () => {
    await run('apify', 'inspect');
    out = [];
    await run('--json', 'apify', 'research', '--max-usd', '0.10', '--community', 'smallbusiness');
    const shown = JSON.parse(out.join('\n'));
    // A wrong plan hash sends nothing.
    out = [];
    await run('--json', '--mode', 'RESEARCH', 'apify', 'research', '--community', 'smallbusiness', '--confirm-spend', '--max-usd', '0.10', '--plan', 'f'.repeat(64));
    expect(JSON.parse(out.join('\n')).detail).toMatch(/The plan changed since it was shown/);
    expect(process.exitCode).toBe(2);
    expect(fake.startCount).toBe(0);
    out = [];
    process.exitCode = undefined;
    fake.nextStatuses = ['SUCCEEDED'];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let done = false;
      const p = run('--json', '--mode', 'RESEARCH', 'apify', 'research', '--community', 'smallbusiness', '--confirm-spend', '--max-usd', '0.10', '--plan', shown.planHash).finally(() => (done = true));
      while (!done) await vi.advanceTimersByTimeAsync(1_000);
      await p;
    } finally {
      vi.useRealTimers();
    }
    const r = JSON.parse(out.join('\n'));
    expect(r.status).toBe('completed');
    expect(r.confirmed).toBe(true);
    expect(fake.startCount).toBe(1);
    const post = fake.callsTo('POST', /\/runs$/)[0]!;
    expect(JSON.parse(post.body!)).toMatchObject({ withinCommunity: 'smallbusiness', searchTerms: ['invoicing software'] });
    expect(Number(new URL(post.url).searchParams.get('maxTotalChargeUsd'))).toBeLessThanOrEqual(0.1);
    expect(r.runs[0].result.detail).toMatch(/heuristic-en@1/);
    expect(err.join('\n')).toMatch(/Paid Apify content research: 1 run\(s\)/);
  });

  it('research refuses paid runs in ANALYZE mode and --classify-with-llm without an explicit LLM cap or a configured model', async () => {
    await run('apify', 'inspect');
    out = [];
    await run('--json', 'apify', 'research', '--confirm-spend', '--max-usd', '0.10');
    expect(JSON.parse(out.join('\n')).error.code).toBe('POLICY_DENIED');
    out = [];
    await run('--json', '--mode', 'RESEARCH', 'apify', 'research', '--confirm-spend', '--max-usd', '0.10', '--classify-with-llm');
    expect(JSON.parse(out.join('\n')).error.message).toMatch(/requires --llm-max-usd/);
    out = [];
    await run('--json', '--mode', 'RESEARCH', 'apify', 'research', '--confirm-spend', '--max-usd', '0.10', '--classify-with-llm', '--llm-max-usd', '0.01');
    const e = JSON.parse(out.join('\n')).error;
    expect(e.code).toBe('CONFIG_MISSING');
    expect(e.message).toMatch(/nothing was sent to Apify/);
    expect(fake.startCount).toBe(0);
    // Preview with the flag explains the LLM allowance.
    out = [];
    await run('--json', 'apify', 'research', '--max-usd', '0.10', '--classify-with-llm', '--llm-max-usd', '0.01');
    expect(JSON.parse(out.join('\n')).classification).toMatchObject({ requested: 'llm', llmCapMicros: 10_000 });
  });

  it('inspect reports the README hash of each build', async () => {
    await run('apify', 'inspect');
    expect(out.join('\n')).toMatch(/README: sha256 [0-9a-f]{12} .*load-bearing passages found: maxPostsCount, runSummary, dedupeKey/);
  });
});
