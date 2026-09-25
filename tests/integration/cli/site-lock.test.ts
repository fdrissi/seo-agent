import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CONDITIONALLY_MUTATING_COMMANDS, CliExit, CliRuntime, MUTATING_COMMANDS, commandPathOf, needsSiteLease } from '../../../src/cli/runtime.js';
import { CONTENT_LOCK_NAME, runLowDataBootstrap } from '../../../src/content/bootstrap.js';
import { acquireSiteLock, getSiteLock, releaseSiteLock } from '../../../src/jobs/locks.js';
import { enqueue } from '../../../src/jobs/store.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/**
 * Spec 27 (non-overlapping per-site runs), A7-06: manual commands that change
 * data or spend money refuse with LOCKED while a JOB holds the site lock. The
 * check is central (buildProgram's preAction hook tags the command; the runtime
 * checks after context creation), so no command module carries lock code.
 */

interface Run {
  out: string;
  err: string;
  exitCode: number;
}

async function runCli(root: string, args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--site', 'test-site', '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('manual commands and the per-site job lock', () => {
  let ctx: TestContext;
  let jobId: string;
  beforeEach(() => {
    process.env.SEO_AGENT_LOG_LEVEL = 'error';
    ctx = createTestContext();
    jobId = enqueue(ctx, 'weekly', { note: 'synthetic' }).id;
    // A live lease held by a running job (the CLI uses the real clock).
    const r = acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: 'runner:synthetic-host:1', jobId, leaseMs: 10 * 60_000, now: new Date() });
    expect(r.acquired).toBe(true);
  });
  afterEach(() => {
    delete process.env.SEO_AGENT_LOG_LEVEL;
    process.exitCode = undefined;
    ctx.cleanup();
  });

  it('refuses `sync gsc` with LOCKED, naming the job and the next step', async () => {
    const r = await runCli(ctx.paths.root, ['sync', 'gsc']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toMatch(/Error \[LOCKED\]: Site test-site is locked by job /);
    expect(r.err).toContain(jobId);
    expect(r.err).toMatch(/"sync gsc" changes data or spends money/);
    expect(r.err).toMatch(/Next step: .*jobs list/);
    // The lock is untouched.
    expect(getSiteLock(ctx.db, ctx.siteId)?.jobId).toBe(jobId);
  });

  it('refuses in --json mode with a machine-readable LOCKED error (export)', async () => {
    const r = await runCli(ctx.paths.root, ['--json', 'export', 'recommendation', 'rec_synthetic_missing']);
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.out) as { ok: boolean; error: { code: string; details: { jobId: string; command: string } } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('LOCKED');
    expect(body.error.details).toMatchObject({ jobId, command: 'export' });
  });

  it('does not refuse --dry-run previews or read-only commands', async () => {
    const dry = await runCli(ctx.paths.root, ['--dry-run', 'sync', 'gsc']);
    expect(`${dry.out}\n${dry.err}`).not.toMatch(/LOCKED/);
    const list = await runCli(ctx.paths.root, ['jobs', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.out).toContain(`Lock "site" held by runner:synthetic-host:1 for ${jobId}`);
  });

  it('does not refuse once the lease expired (crashed or sleeping holder)', async () => {
    ctx.db.run('UPDATE site_locks SET expires_at = ? WHERE site_id = ?', [new Date(Date.now() - 60_000).toISOString(), ctx.siteId]);
    const r = await runCli(ctx.paths.root, ['sync', 'gsc']);
    expect(`${r.out}\n${r.err}`).not.toMatch(/LOCKED/);
  });

  it('lists the data-changing and chargeable commands and tags the running command path', async () => {
    for (const c of ['sync gsc', 'sync ga4', 'sync inspect', 'crawl', 'crawl page', 'crawl competitor', 'research keyword', 'perf check', 'content brief', 'content draft', 'content review', 'content batch', 'experiments review', 'export', 'apify test']) {
      expect(MUTATING_COMMANDS.has(c), c).toBe(true);
    }
    for (const c of ['jobs list', 'jobs resume', 'costs', 'doctor', 'baseline', 'weekly', 'schedule run']) expect(MUTATING_COMMANDS.has(c), c).toBe(false);
    const runtime = new CliRuntime({ out: () => undefined, err: () => undefined }, {});
    const program = await buildProgram(runtime);
    const sync = program.commands.find((c) => c.name() === 'sync')!;
    expect(commandPathOf(sync.commands.find((c) => c.name() === 'gsc')!)).toBe('sync gsc');
    expect(commandPathOf(program)).toBe('');
  });
});

/**
 * B6-03: every paid or data-changing manual command takes the site lease, so
 * each one refuses with LOCKED (and does nothing) while a job holds the site
 * lock. The commands below were missing from MUTATING_COMMANDS before.
 */
describe('paid and data-changing commands added to the site lease (B6-03)', () => {
  let ctx: TestContext;
  let jobId: string;
  beforeEach(() => {
    process.env.SEO_AGENT_LOG_LEVEL = 'error';
    ctx = createTestContext();
    jobId = enqueue(ctx, 'weekly', { note: 'synthetic' }).id;
    const r = acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: 'runner:synthetic-host:1', jobId, leaseMs: 10 * 60_000, now: new Date() });
    expect(r.acquired).toBe(true);
  });
  afterEach(() => {
    delete process.env.SEO_AGENT_LOG_LEVEL;
    process.exitCode = undefined;
    ctx.cleanup();
  });

  const count = (sql: string) => ctx.db.get<{ n: number }>(sql, [ctx.siteId])!.n;

  it.each([
    ['memory sync', ['memory', 'sync', '--allow-paid']],
    ['memory rebuild', ['memory', 'rebuild', '--allow-paid']],
    ['memory reconcile', ['memory', 'reconcile']],
    ['content bootstrap', ['content', 'bootstrap', '--force', '--use-model']],
    ['models test', ['models', 'test', '--confirm-spend', '--max-usd', '0.01']],
    ['costs reconcile', ['costs', 'reconcile', 'res_synthetic_missing', '--actual-usd', '0.01', '--evidence', 'synthetic billing history', '--by', 'Jane Doe']],
    ['apify import-schema', ['apify', 'import-schema', 'SCHEMA_FILE']],
    ['memory search', ['memory', 'search', 'synthetic', 'widgets', '--allow-paid']],
  ])('refuses `%s` with LOCKED while a job holds the site lock, and does nothing', async (command, args) => {
    const schema = path.join(ctx.paths.root, 'schema.json');
    writeFileSync(schema, JSON.stringify({ title: 'synthetic schema', type: 'object', properties: {} }));
    const itemsBefore = count('SELECT COUNT(*) AS n FROM content_items WHERE site_id = ?');
    const auditBefore = count('SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ?');
    const r = await runCli(ctx.paths.root, args.map((a) => (a === 'SCHEMA_FILE' ? schema : a)));
    expect(r.exitCode, r.err).toBe(1);
    expect(r.err).toMatch(/Error \[LOCKED\]: Site test-site is locked by job /);
    expect(r.err).toContain(`"${command}" changes data or spends money`);
    expect(getSiteLock(ctx.db, ctx.siteId)?.jobId).toBe(jobId);
    expect(count('SELECT COUNT(*) AS n FROM content_items WHERE site_id = ?')).toBe(itemsBefore);
    expect(count('SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ?')).toBe(auditBefore);
  });

  it('`memory search` without --allow-paid is free and is not refused', async () => {
    const r = await runCli(ctx.paths.root, ['memory', 'search', 'synthetic', 'widgets']);
    expect(`${r.out}\n${r.err}`).not.toMatch(/LOCKED/);
    expect(r.exitCode, r.err).toBe(0);
    expect(needsSiteLease('memory search', { allowPaid: true })).toBe(true);
    expect(needsSiteLease('memory search', {})).toBe(false);
    expect(needsSiteLease('memory sync', {})).toBe(true);
    expect(needsSiteLease(null, { allowPaid: true })).toBe(false);
  });

  it('--dry-run previews of the added commands still work while the lock is held', async () => {
    for (const args of [['memory', 'sync'], ['content', 'bootstrap']]) {
      const r = await runCli(ctx.paths.root, ['--dry-run', ...args]);
      expect(`${r.out}\n${r.err}`, args.join(' ')).not.toMatch(/LOCKED/);
    }
  });
});

/**
 * NF-08: the commands that were KNOWN GAPs now take the site lease: always
 * when every run writes (derived data, reports, vault notes, stored schemas),
 * and only with the writing options when the plain command only previews or
 * lists (CONDITIONALLY_MUTATING_COMMANDS).
 */
describe('commands that write derived data or reconcile paid state take the lease (NF-08)', () => {
  let ctx: TestContext;
  let jobId: string;
  beforeEach(() => {
    process.env.SEO_AGENT_LOG_LEVEL = 'error';
    ctx = createTestContext();
    jobId = enqueue(ctx, 'weekly', { note: 'synthetic' }).id;
    const r = acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: 'runner:synthetic-host:1', jobId, leaseMs: 10 * 60_000, now: new Date() });
    expect(r.acquired).toBe(true);
  });
  afterEach(() => {
    delete process.env.SEO_AGENT_LOG_LEVEL;
    process.exitCode = undefined;
    ctx.cleanup();
  });

  const count = (sql: string) => ctx.db.get<{ n: number }>(sql, [ctx.siteId])!.n;
  const snapshot = () => ({
    audit: count('SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ?'),
    pages: count('SELECT COUNT(*) AS n FROM pages WHERE site_id = ?'),
    reports: count('SELECT COUNT(*) AS n FROM reports WHERE site_id = ?'),
    signals: count('SELECT COUNT(*) AS n FROM content_signals WHERE site_id = ?'),
  });

  it.each([
    ['analyze page', ['analyze', 'page', 'https://www.example.test/pricing/']],
    ['analyze route', ['analyze', 'route', '--save']],
    ['analyze reconcile', ['analyze', 'reconcile']],
    ['report build', ['report', 'build', 'weekly', '--from-db']],
    ['vault render', ['vault', 'render']],
    ['content import', ['content', 'import', 'QUESTIONS_FILE']],
    ['content measure', ['content', 'measure']],
    ['apify inspect', ['apify', 'inspect']],
    ['pages infer-types', ['pages', 'infer-types', '--apply']],
    ['vault import-business', ['vault', 'import-business', '--apply']],
    ['research tasks', ['research', 'tasks', '--poll']],
    ['research tasks', ['research', 'tasks', '--abandon', 'task_synthetic_missing']],
    ['apify runs', ['apify', 'runs', '--resume']],
    ['apify runs', ['apify', 'runs', '--confirm-not-accepted', 'run_synthetic_missing']],
  ])('refuses `%s` (%j) with LOCKED while a job holds the site lock, and does nothing', async (command, args) => {
    const questions = path.join(ctx.paths.root, 'questions.csv');
    writeFileSync(questions, 'question\nHow do synthetic widgets work?\n');
    const before = snapshot();
    const r = await runCli(ctx.paths.root, args.map((a) => (a === 'QUESTIONS_FILE' ? questions : a)));
    expect(r.exitCode, r.err).toBe(1);
    expect(r.err).toMatch(/Error \[LOCKED\]: Site test-site is locked by job /);
    expect(r.err).toContain(`"${command}" changes data or spends money`);
    expect(getSiteLock(ctx.db, ctx.siteId)?.jobId).toBe(jobId);
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['pages infer-types', ['pages', 'infer-types']],
    ['vault import-business', ['vault', 'import-business']],
    ['research tasks', ['research', 'tasks']],
    ['apify runs', ['apify', 'runs']],
  ])('`%s` without its writing options only previews or lists and is not refused', async (_command, args) => {
    const r = await runCli(ctx.paths.root, args);
    expect(`${r.out}\n${r.err}`).not.toMatch(/LOCKED/);
    expect(getSiteLock(ctx.db, ctx.siteId)?.jobId).toBe(jobId);
  });

  it('decides the conditional lease from the command options', () => {
    expect(needsSiteLease('pages infer-types', { apply: true })).toBe(true);
    expect(needsSiteLease('pages infer-types', { limit: '10' })).toBe(false);
    expect(needsSiteLease('vault import-business', { apply: true })).toBe(true);
    expect(needsSiteLease('vault import-business', {})).toBe(false);
    expect(needsSiteLease('research tasks', { poll: true })).toBe(true);
    expect(needsSiteLease('research tasks', { abandon: 'task_x' })).toBe(true);
    expect(needsSiteLease('research tasks', { all: true })).toBe(false);
    expect(needsSiteLease('apify runs', { resume: true })).toBe(true);
    expect(needsSiteLease('apify runs', { confirmNotAccepted: 'run_x' })).toBe(true);
    expect(needsSiteLease('apify runs', { limit: '50', wait: true })).toBe(false);
    for (const c of ['analyze page', 'analyze route', 'analyze reconcile', 'report build', 'vault render', 'content import', 'content measure', 'apify inspect']) {
      expect(needsSiteLease(c, {}), c).toBe(true);
    }
  });

  it('--dry-run previews of the newly leased commands still work while the lock is held', async () => {
    for (const args of [['vault', 'render'], ['analyze', 'reconcile'], ['pages', 'infer-types', '--apply']]) {
      const r = await runCli(ctx.paths.root, ['--dry-run', ...args]);
      expect(`${r.out}\n${r.err}`, args.join(' ')).not.toMatch(/LOCKED/);
    }
  });
});

/**
 * Every registered command that runs an action is classified, so a new paid or
 * data-changing command cannot be added without deciding whether it takes the
 * site lease: it must be listed in MUTATING_COMMANDS or
 * CONDITIONALLY_MUTATING_COMMANDS (src/cli/runtime.ts), or here with the
 * reason it takes no lease.
 */
const READ_ONLY = 'reads and prints only (free network reads at most)';
const JOB_RUNNER = 'runs through the job runner, which takes the site (or content) lock itself';
const WORKSPACE = 'workspace, credential, or config level (no per-site measurement data), or an isolated demo workspace';
const OWN_GUARD = 'checks the site lock itself';
const HUMAN_RECORD = 'records a named human decision, annotation, or review (audited)';

const NOT_LEASED: Record<string, string> = {
  'ai-citations status': READ_ONLY,
  'ai-citations import': OWN_GUARD,
  'ai-citations list': READ_ONLY,
  'analyze links': READ_ONLY,
  'analyze compare': READ_ONLY,
  'apify status': READ_ONLY,
  'approvals list': READ_ONLY,
  'approvals show': READ_ONLY,
  'approvals request': HUMAN_RECORD,
  'approvals approve': HUMAN_RECORD,
  'approvals reject': HUMAN_RECORD,
  'approvals request-budget-exception': HUMAN_RECORD,
  'auth google': WORKSPACE,
  'auth status': WORKSPACE,
  'auth revoke': WORKSPACE,
  'auth diagnose': WORKSPACE,
  backup: WORKSPACE,
  restore: OWN_GUARD,
  'config validate': READ_ONLY,
  'config show': READ_ONLY,
  'config migrate': WORKSPACE,
  'config docs': READ_ONLY,
  'config schema': READ_ONLY,
  'content discover': JOB_RUNNER,
  'content list': READ_ONLY,
  'content show': READ_ONLY,
  'content mark-reviewed': HUMAN_RECORD,
  'content revise-manual': HUMAN_RECORD,
  'content publish-check': READ_ONLY,
  'content produce': JOB_RUNNER,
  'content queue': JOB_RUNNER,
  costs: READ_ONLY,
  'crawl aeo': READ_ONLY,
  'crawl status': READ_ONLY,
  'crawl issues': READ_ONLY,
  'data export': READ_ONLY,
  'db status': READ_ONLY,
  'db migrate': WORKSPACE,
  demo: WORKSPACE,
  'diagnostics export': WORKSPACE,
  'diagnostics show': READ_ONLY,
  'diagnostics list': READ_ONLY,
  doctor: WORKSPACE,
  'experiments list': READ_ONLY,
  'experiments show': READ_ONLY,
  'experiments propose': HUMAN_RECORD,
  'experiments specify-change': HUMAN_RECORD,
  'experiments mark-implemented': HUMAN_RECORD,
  'experiments annotate': HUMAN_RECORD,
  'experiments cancel': HUMAN_RECORD,
  'experiments learnings': READ_ONLY,
  'experiments propose-learning': HUMAN_RECORD,
  'jobs list': READ_ONLY,
  'jobs show': READ_ONLY,
  'jobs resume': JOB_RUNNER,
  'jobs cancel': HUMAN_RECORD,
  // Read-only listing; --release is an audited human decision about the lease itself (C4-07).
  'jobs locks': HUMAN_RECORD,
  'jobs breakers': HUMAN_RECORD,
  'memory status': READ_ONLY,
  'memory evidence': READ_ONLY,
  'models list': READ_ONLY,
  'models check': READ_ONLY,
  'pages list': READ_ONLY,
  'perf priority': READ_ONLY,
  'perf status': READ_ONLY,
  baseline: JOB_RUNNER,
  weekly: JOB_RUNNER,
  monthly: JOB_RUNNER,
  'report list': READ_ONLY,
  'report show': READ_ONLY,
  'report dashboard': READ_ONLY,
  'research locations': READ_ONLY,
  'research status': READ_ONLY,
  'schedule show': READ_ONLY,
  'schedule instructions': READ_ONLY,
  'schedule enable': HUMAN_RECORD,
  'schedule disable': HUMAN_RECORD,
  'schedule run': JOB_RUNNER,
  setup: WORKSPACE,
  'vault init': WORKSPACE,
  'vault check': READ_ONLY,
  'vault apply-business': HUMAN_RECORD,
  'vault business-history': READ_ONLY,
  'vault resolve': HUMAN_RECORD,
  init: WORKSPACE,
  'workspace status': READ_ONLY,
};

describe('site-lease classification of every registered command (B6-03)', () => {
  it('classifies every command that runs an action: leased, conditionally leased, or reviewed as needing no lease', async () => {
    const program = await buildProgram(new CliRuntime({ out: () => undefined, err: () => undefined }, {}));
    const runnable: string[] = [];
    const walk = (c: Command) => {
      for (const sub of c.commands) {
        if (typeof (sub as unknown as { _actionHandler?: unknown })._actionHandler === 'function') runnable.push(commandPathOf(sub));
        walk(sub);
      }
    };
    walk(program);
    const unclassified = runnable.filter((c) => !MUTATING_COMMANDS.has(c) && !CONDITIONALLY_MUTATING_COMMANDS.has(c) && !Object.hasOwn(NOT_LEASED, c));
    expect(unclassified, 'new command(s): add to MUTATING_COMMANDS / CONDITIONALLY_MUTATING_COMMANDS in src/cli/runtime.ts, or to NOT_LEASED here with the reason').toEqual([]);
    const both = Object.keys(NOT_LEASED).filter((c) => MUTATING_COMMANDS.has(c) || CONDITIONALLY_MUTATING_COMMANDS.has(c));
    expect(both).toEqual([]);
    const stale = Object.keys(NOT_LEASED).filter((c) => !runnable.includes(c));
    expect(stale, 'NOT_LEASED names commands that are no longer registered').toEqual([]);
  });
});

/** content bootstrap also honours the separate "content" lock the content jobs hold (B6-03). */
describe('content bootstrap and the content lock', () => {
  let ctx: TestContext;
  afterEach(() => {
    process.exitCode = undefined;
    ctx.cleanup();
  });
  const deps = { llm: null, memory: null, approvals: null, vault: null };

  it('refuses with LOCKED while a content job holds the content lock and creates nothing', async () => {
    ctx = createTestContext();
    const jobId = enqueue(ctx, 'content_production', { note: 'synthetic' }).id;
    expect(acquireSiteLock(ctx.db, { siteId: ctx.siteId, lockName: CONTENT_LOCK_NAME, owner: 'runner:synthetic-host:2', jobId, leaseMs: 10 * 60_000, now: ctx.clock.now() }).acquired).toBe(true);
    await expect(runLowDataBootstrap(ctx, deps, { useModel: false })).rejects.toMatchObject({ code: 'LOCKED', details: { lockName: 'content', jobId } });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_items WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    expect(getSiteLock(ctx.db, ctx.siteId, CONTENT_LOCK_NAME)?.jobId).toBe(jobId);
    // Once the content job released it, the bootstrap runs and gives the lock back.
    expect(releaseSiteLock(ctx.db, { siteId: ctx.siteId, lockName: CONTENT_LOCK_NAME, owner: 'runner:synthetic-host:2', jobId })).toBe(true);
    const r = await runLowDataBootstrap(ctx, deps, { useModel: false });
    expect(r.offerPage?.itemId).toBeTruthy();
    expect(getSiteLock(ctx.db, ctx.siteId, CONTENT_LOCK_NAME)).toBeUndefined();
  });

  it('a dry run neither takes nor checks the content lock', async () => {
    ctx = createTestContext({ dryRun: true });
    const jobId = enqueue(ctx, 'content_production', { note: 'synthetic' }).id;
    acquireSiteLock(ctx.db, { siteId: ctx.siteId, lockName: CONTENT_LOCK_NAME, owner: 'runner:synthetic-host:2', jobId, leaseMs: 10 * 60_000, now: ctx.clock.now() });
    const r = await runLowDataBootstrap(ctx, deps, { useModel: false });
    expect(r.skipped).toMatch(/dry run/);
  });
});
