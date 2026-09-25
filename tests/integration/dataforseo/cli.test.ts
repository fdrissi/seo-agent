import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext } from '../../../src/app/context.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { memoryLogger } from '../../../src/core/logger.js';
import { parseMode } from '../../../src/core/modes.js';
import { CliExit, CliRuntime, type GlobalOptions } from '../../../src/cli/runtime.js';
import { registerResearch, researchKeywordExitCode } from '../../../src/cli/commands/research.js';
import { overallResearchStatus } from '../../../src/integrations/dataforseo/research.js';
import type { TestContext } from '../../helpers/context.js';
import { SYNTHETIC_LOGIN, SYNTHETIC_PASSWORD, clockSleep, dfsConfig, dfsContext, fakeDataForSeo } from './helpers.js';

let base: TestContext | undefined;
afterEach(() => {
  base?.cleanup();
  base = undefined;
  process.exitCode = undefined;
});

function harness(opts: { fake?: ReturnType<typeof fakeDataForSeo>; credentials?: boolean; config?: ReturnType<typeof dfsConfig> } = {}) {
  const fake = opts.fake ?? fakeDataForSeo();
  base = dfsContext({ fetch: fake.fetch, ...(opts.config ? { config: opts.config } : {}) });
  const out: string[] = [];
  const err: string[] = [];
  const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, {});
  const b = base;
  const context = (g: GlobalOptions) =>
    createAppContext({
      workspaceRoot: b.paths.root,
      siteId: b.siteId,
      config: b.config,
      secrets: new MemorySecretStore(opts.credentials === false ? {} : { DATAFORSEO_LOGIN: SYNTHETIC_LOGIN, DATAFORSEO_PASSWORD: SYNTHETIC_PASSWORD }),
      clock: b.clock,
      logger: memoryLogger(),
      fetch: fake.fetch,
      offline: false,
      mode: parseMode(g.mode),
      dryRun: !!g.dryRun,
      migrate: false,
    });
  const run = async (...args: string[]) => {
    out.length = 0;
    err.length = 0;
    process.exitCode = undefined;
    const program = new Command()
      .exitOverride()
      .option('-w, --workspace <dir>')
      .option('-s, --site <id>')
      .option('--dry-run')
      .option('--json')
      .option('--mode <mode>')
      .option('--offline');
    registerResearch(program, cli, { fetch: fake.fetch, sleep: clockSleep(b), context });
    try {
      await program.parseAsync(['node', 'seo-agent', ...args]);
    } catch (e) {
      if (!(e instanceof CliExit)) throw e;
    }
    return { out: out.join('\n'), err: err.join('\n'), exitCode: process.exitCode };
  };
  return { run, fake };
}

describe('research CLI', () => {
  it('keyword --dry-run --json shows the cost plan and caps without any request', async () => {
    const { run, fake } = harness();
    const r = await run('research', 'keyword', 'synthetic widget pricing', 'synthetic gadget review', '--dry-run', '--json');
    const json = JSON.parse(r.out);
    expect(json.serp.status).toBe('planned');
    expect(json.serp.plan).toMatchObject({ submissions: 2, totalEstimateMicros: 1200, queue: 'standard' });
    expect(json.serp.plan.caps.perRun.limitMicros).toBe(500_000);
    expect(fake.fetch.calls).toHaveLength(0);
  });

  it('a live run without --allow-spend shows the plan and cap, sends nothing paid, and exits 3', async () => {
    const { run, fake } = harness();
    const r = await run('research', 'keyword', 'synthetic widget pricing');
    expect(r.exitCode).toBe(3);
    expect(r.out).toMatch(/Caps \(dataforseo\): per run \$0\.50/);
    expect(r.out).toMatch(/--allow-spend/);
    expect(r.out).toMatch(/\$0\.0006 upper bound/);
    expect(fake.state.posts).toBe(0);
  });

  it('--allow-spend submits once; `research tasks` lists it; `--poll` fetches it; a repeat is a cache hit', async () => {
    const { run, fake } = harness({ fake: fakeDataForSeo({ ready: false }) });
    const r1 = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend');
    expect(r1.exitCode).toBeUndefined();
    expect(r1.out).toMatch(/pending \(task dfst_/);
    expect(fake.state.posts).toBe(1);
    const t = await run('research', 'tasks', '--json');
    const listed = JSON.parse(t.out).tasks;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: 'queued', kind: 'serp', label: 'synthetic widget pricing', costMicros: 600 });
    fake.setReady(true);
    const p = await run('research', 'tasks', '--poll');
    expect(p.out).toMatch(/fetched 1/);
    const again = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend', '--json');
    expect(JSON.parse(again.out).serp.queries[0]).toMatchObject({ status: 'cached', ownRank: 5 });
    expect(fake.state.posts).toBe(1);
  });

  it('--sandbox is free, needs no --allow-spend, and labels results as synthetic', async () => {
    const { run, fake } = harness();
    const r = await run('research', 'keyword', 'synthetic widget pricing', '--sandbox', '--wait', '60');
    expect(r.exitCode).toBeUndefined();
    expect(r.out).toMatch(/SANDBOX \(synthetic data, never used in real recommendations\)/);
    expect(r.out).toMatch(/SYNTHETIC - not for recommendations/);
    expect(fake.postCalls()[0]!.url).toMatch(/^https:\/\/sandbox\.dataforseo\.com\//);
  });

  it('--volume adds a search-volume task and labels volumes as estimates', async () => {
    const { run, fake } = harness({ config: dfsConfig({ dataforseo: { queue: 'live', liveQueueJustification: 'Same-day SERP answers for a synthetic launch (test)' } }) });
    const r = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend', '--volume');
    expect(r.out).toMatch(/queue live \(live queue justification: "Same\-day SERP answers for a synthetic launch \(test\)"\)/);
    expect(r.out).toMatch(/Search-volume estimates: completed \[estimate, not exact demand\]/);
    expect(r.out).toMatch(/volume 1300/);
    expect(fake.postCalls().map((c) => c.url.split('/v3/')[1])).toEqual(['serp/google/organic/live/advanced', 'keywords_data/google_ads/search_volume/live']);
  });

  it('missing credentials fail honestly with exit code 3', async () => {
    const { run } = harness({ credentials: false });
    const r = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend');
    expect(r.exitCode).toBe(3);
    expect(r.err).toMatch(/CREDENTIALS_MISSING/);
    expect(r.err).toMatch(/secrets\.env/);
  });

  it('tasks --abandon only works on ambiguous tasks', async () => {
    const { run, fake } = harness({ fake: fakeDataForSeo({ postBehavior: 'network_error' }) });
    await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend');
    const t = JSON.parse((await run('research', 'tasks', '--json')).out).tasks;
    expect(t[0].status).toBe('ambiguous');
    const out = await run('research', 'tasks', '--abandon', t[0].id, '--all', '--json');
    expect(JSON.parse(out.out).tasks[0].status).toBe('failed');
    const bad = await run('research', 'tasks', '--abandon', t[0].id);
    expect(bad.err).toMatch(/CONFLICT/);
    expect(fake.state.posts).toBe(1);
  });

  it('never raises the runtime mode implicitly: --allow-spend in the default ANALYZE mode sends nothing and names --mode RESEARCH', async () => {
    const { run, fake } = harness();
    const r = await run('research', 'keyword', 'synthetic widget pricing', '--allow-spend');
    expect(r.exitCode).toBe(3);
    expect(r.out).toMatch(/POLICY_DENIED: Runtime mode ANALYZE does not allow paid research requests/);
    expect(r.out).toMatch(/re-run with --mode RESEARCH to submit/);
    expect(fake.state.posts).toBe(0);
    // Without either flag, both are named at once.
    const none = await run('research', 'keyword', 'synthetic widget pricing');
    expect(none.out).toMatch(/needs --mode RESEARCH and --allow-spend/);
    // A dry run in ANALYZE mode still shows the plan and says what a real run needs.
    const dry = await run('research', 'keyword', 'synthetic widget pricing', '--dry-run');
    expect(dry.out).toMatch(/Cost plan: .*1 new paid submission/);
    expect(dry.out).toMatch(/re-run without --dry-run and with --mode RESEARCH --allow-spend/);
    // The free sandbox needs neither flag.
    const sandbox = await run('research', 'keyword', 'synthetic widget pricing', '--sandbox');
    expect(sandbox.exitCode).toBeUndefined();
    expect(fake.state.posts).toBe(1);
    expect(fake.postCalls()[0]!.url).toMatch(/^https:\/\/sandbox\.dataforseo\.com\//);
  });

  it('rejects non-integer numeric options instead of passing NaN on', async () => {
    const { run, fake } = harness();
    for (const args of [
      ['research', 'keyword', 'synthetic widget pricing', '--competitors', 'abc'],
      ['research', 'keyword', 'synthetic widget pricing', '--competitors', '2.5'],
      ['research', 'keyword', 'synthetic widget pricing', '--location', 'nine'],
      ['research', 'keyword', 'synthetic widget pricing', '--wait', 'soon'],
      ['research', 'locations', 'twin', '--country', 'xa', '--limit', 'abc'],
      ['research', 'locations', 'twin', '--country', 'xa', '--limit', '0'],
    ]) {
      const r = await run(...args);
      expect(r.exitCode, args.join(' ')).toBe(1);
      expect(r.err, args.join(' ')).toMatch(/Error \[VALIDATION_FAILED\]: --(competitors|location|wait|limit) must be a whole number/);
    }
    expect(fake.fetch.calls).toHaveLength(0);
  });

  it('`research locations` accepts the name positionally or with --search (the form shown in hints)', async () => {
    const { run } = harness();
    const a = await run('research', 'locations', 'twin', '--country', 'xa', '--json');
    const b = await run('research', 'locations', '--search', 'twin', '--country', 'xa', '--json');
    expect(JSON.parse(a.out).locations.map((l: { location_code: number }) => l.location_code)).toEqual([9990003, 9990004]);
    expect(JSON.parse(b.out).locations).toEqual(JSON.parse(a.out).locations);
    expect(JSON.parse(b.out).source).toBe('cache'); // the free lookup is cached, not repeated
    const limited = await run('research', 'locations', 'twin', '--country', 'xa', '--limit', '1', '--json');
    expect(JSON.parse(limited.out).locations).toHaveLength(1);
  });

  it('status and locations', async () => {
    const { run } = harness();
    const s = JSON.parse((await run('research', 'status', '--json')).out);
    expect(s).toMatchObject({ id: 'dataforseo', state: 'configured_unverified', chargeable: false });
    const l = await run('research', 'locations', 'twin', '--country', 'xa');
    expect(l.out).toMatch(/9990003 {2}Twin Town/);
    expect(l.out).toMatch(/9990004 {2}Twin Town/);
  });
});

describe('research keyword: honest overall status and exit code (C3-02)', () => {
  const LIVE_QUEUE = { dataforseo: { queue: 'live', liveQueueJustification: 'Same-day SERP answers for a synthetic launch (test)' } };

  it('every query failed at the provider: status "failed", exit 1, and a next step (never "partial" with exit 0)', async () => {
    const { run, fake } = harness({ fake: fakeDataForSeo({ postBehavior: 'task_error' }) });
    const r = await run('research', 'keyword', 'synthetic widget pricing', 'synthetic gadget review', '--mode', 'RESEARCH', '--allow-spend', '--json');
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.out);
    expect(json.serp.status).toBe('failed');
    expect(json.serp.queries.map((q: { status: string }) => q.status)).toEqual(['failed', 'failed']);
    expect(json.serp.queries[0].error).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/^task failed \(40501/), hint: expect.stringContaining('npm run cli -- research status --network') });
    expect(fake.state.posts).toBe(1);

    const human = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend');
    expect(human.exitCode).toBe(1);
    expect(human.out).toMatch(/^DataForSEO SERP research: failed; mode live$/m);
    expect(human.out).toContain('Research failed: no query was fetched, served from the cache, or queued.');
    expect(human.out).toContain('Next step [PROVIDER_ERROR]: Check credentials and connectivity with `npm run cli -- research status --network` (free, never charged)');
    expect(human.out.match(/Next step \[PROVIDER_ERROR\]/g)).toHaveLength(1);
  });

  it('a request that was never sent (network failure) fails with its own code and a connectivity next step', async () => {
    const offlinePost = (req: { method: string }) => {
      if (req.method === 'POST') throw Object.assign(new Error('getaddrinfo ENOTFOUND api.dataforseo.com (synthetic)'), { code: 'ENOTFOUND' });
      return undefined;
    };
    const { run, fake } = harness({ fake: fakeDataForSeo({ before: [offlinePost] }) });
    const r = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend', '--json');
    expect(r.exitCode).toBe(1);
    const json = JSON.parse(r.out);
    expect(json.serp).toMatchObject({ status: 'failed', submissions: [expect.objectContaining({ state: 'not_sent' })] });
    expect(json.serp.queries[0]).toMatchObject({ status: 'failed', error: { code: 'INTEGRATION_UNAVAILABLE', message: expect.stringContaining('request not sent'), hint: expect.stringContaining('research status --network') } });
    expect(fake.state.posts).toBe(0);
    const human = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend');
    expect(human.exitCode).toBe(1);
    expect(human.out).toContain('Next step [INTEGRATION_UNAVAILABLE]: Check credentials and connectivity with `npm run cli -- research status --network`');
  });

  it('a partial result (one query from the cache, one failed) exits 2', async () => {
    const fake = fakeDataForSeo();
    const { run } = harness({ fake, config: dfsConfig(LIVE_QUEUE) });
    const first = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend', '--json');
    expect(first.exitCode).toBeUndefined();
    expect(JSON.parse(first.out).serp.status).toBe('completed');
    fake.setPostBehavior('task_error');
    const r = await run('research', 'keyword', 'synthetic widget pricing', 'synthetic gadget review', '--mode', 'RESEARCH', '--allow-spend', '--json');
    expect(r.exitCode).toBe(2);
    const json = JSON.parse(r.out);
    expect(json.serp.status).toBe('partial');
    expect(json.serp.queries.map((q: { status: string }) => q.status)).toEqual(['cached', 'failed']);
    const human = await run('research', 'keyword', 'synthetic widget pricing', 'synthetic gadget review', '--mode', 'RESEARCH', '--allow-spend');
    expect(human.exitCode).toBe(2);
    expect(human.out).toContain('Partial result: some queries were not researched');
  });

  it('every query skipped because the location could not be verified (DATA_UNAVAILABLE) exits 2 with its next step; nothing is sent', async () => {
    const lookupDown = (req: { method: string; url: string }) => (req.method === 'GET' && /\/(locations|languages)(\/[a-z]{2})?$/.test(req.url) ? new Response('Internal Server Error (synthetic)', { status: 500 }) : undefined);
    const { run, fake } = harness({ fake: fakeDataForSeo({ before: [lookupDown] }) });
    const r = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend', '--json');
    expect(r.exitCode).toBe(2);
    const json = JSON.parse(r.out);
    expect(json.serp.status).toBe('skipped');
    expect(json.serp.settings.verification).toBe('unverified');
    expect(json.serp.queries[0]).toMatchObject({ status: 'skipped', error: { code: 'DATA_UNAVAILABLE' } });
    expect(fake.state.posts).toBe(0);
    const human = await run('research', 'keyword', 'synthetic widget pricing', '--mode', 'RESEARCH', '--allow-spend');
    expect(human.exitCode).toBe(2);
    expect(human.out).toContain('Next step [DATA_UNAVAILABLE]: Retry with network access, or check market.searchLocations.');
  });

  it('status and exit-code rules (pure)', () => {
    expect(overallResearchStatus([])).toBe('skipped');
    expect(overallResearchStatus(['fetched', 'cached'])).toBe('completed');
    expect(overallResearchStatus(['fetched', 'pending', 'ambiguous'])).toBe('pending');
    expect(overallResearchStatus(['skipped', 'skipped'])).toBe('skipped');
    expect(overallResearchStatus(['failed'])).toBe('failed');
    expect(overallResearchStatus(['failed', 'skipped'])).toBe('failed');
    expect(overallResearchStatus(['failed', 'pending'])).toBe('partial');
    expect(overallResearchStatus(['failed', 'ambiguous'])).toBe('partial');
    expect(overallResearchStatus(['fetched', 'failed'])).toBe('partial');
    expect(overallResearchStatus(['fetched', 'skipped'])).toBe('partial');

    const q = (status: string, code?: string) => ({ status, ...(code ? { error: { code, message: 'synthetic' } } : {}) }) as never;
    expect(researchKeywordExitCode({ status: 'completed', queries: [q('fetched')] })).toBe(0);
    expect(researchKeywordExitCode({ status: 'pending', queries: [q('pending')] })).toBe(0);
    expect(researchKeywordExitCode({ status: 'planned', queries: [q('planned')] })).toBe(0);
    expect(researchKeywordExitCode({ status: 'failed', queries: [q('failed', 'PROVIDER_ERROR'), q('skipped', 'BUDGET_EXCEEDED')] })).toBe(1);
    expect(researchKeywordExitCode({ status: 'skipped', queries: [q('skipped', 'POLICY_DENIED')] })).toBe(3);
    expect(researchKeywordExitCode({ status: 'partial', queries: [q('fetched'), q('skipped', 'BUDGET_EXCEEDED')] })).toBe(3);
    expect(researchKeywordExitCode({ status: 'skipped', queries: [q('skipped', 'DATA_UNAVAILABLE')] })).toBe(2);
    expect(researchKeywordExitCode({ status: 'skipped', queries: [] })).toBe(2);
    expect(researchKeywordExitCode({ status: 'partial', queries: [q('fetched'), q('failed', 'PROVIDER_ERROR')] })).toBe(2);
    expect(researchKeywordExitCode({ status: 'pending', queries: [q('ambiguous')] })).toBe(2);
    // The SERP part completed but the volume request failed: a partial result.
    expect(researchKeywordExitCode({ status: 'completed', queries: [q('fetched')] }, { status: 'failed', keywords: [q('failed', 'PROVIDER_ERROR')] })).toBe(2);
    expect(researchKeywordExitCode({ status: 'completed', queries: [q('fetched')] }, { status: 'skipped', keywords: [q('skipped', 'POLICY_DENIED')] })).toBe(3);
  });
});
