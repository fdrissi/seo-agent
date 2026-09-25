import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { register } from '../../../src/cli/commands/report.js';
import { reportsTestConfig, seedWeeklyScenario } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  process.exitCode = undefined;
});

async function run(root: string, args: string[]): Promise<{ out: string; err: string; failed: boolean }> {
  const out: string[] = [];
  const err: string[] = [];
  const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program
    .exitOverride()
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .configureOutput({ writeErr: (s) => err.push(s), writeOut: (s) => out.push(s) });
  register(program, cli);
  let failed = false;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch {
    failed = true;
  }
  return { out: out.join('\n'), err: err.join('\n'), failed };
}

describe('report CLI', () => {
  it('builds from the DB, lists, and shows reports; every build creates a new report', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const root = ctx.paths.root;
    const built = await run(root, ['--json', 'report', 'build', 'weekly', '--from-db', '--from', '2026-09-14', '--to', '2026-09-20']);
    expect(built.failed).toBe(false);
    const r1 = JSON.parse(built.out);
    expect(r1).toMatchObject({ ok: true, kind: 'weekly', period: { start: '2026-09-14', end: '2026-09-20' }, dryRun: false });
    expect(existsSync(r1.markdownPath)).toBe(true);
    expect(r1.contractIssues).toEqual([]);
    const again = JSON.parse((await run(root, ['--json', 'report', 'build', 'weekly', '--from-db', '--from', '2026-09-14', '--to', '2026-09-20'])).out);
    expect(again.id).not.toBe(r1.id);

    const list = JSON.parse((await run(root, ['--json', 'report', 'list'])).out);
    expect(list.reports.map((r: { id: string }) => r.id).sort()).toEqual([r1.id, again.id].sort());

    const shown = await run(root, ['report', 'show', 'weekly', '--latest']);
    expect(shown.failed).toBe(false);
    expect(shown.out).toContain('# Weekly SEO report');
    expect(shown.out).toContain('Clicks: 70 ');
    const byId = JSON.parse((await run(root, ['--json', 'report', 'show', 'weekly', '--id', r1.id])).out);
    expect(byId.id).toBe(r1.id);

    const human = await run(root, ['report', 'list']);
    expect(human.out).toContain(r1.id);
  });

  it('requires --from-db, validates kinds, and writes nothing in dry-run', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const root = ctx.paths.root;
    const noFlag = await run(root, ['report', 'build', 'weekly']);
    expect(noFlag.failed).toBe(true);
    expect(noFlag.err).toContain('pass --from-db');
    const bad = await run(root, ['report', 'build', 'daily', '--from-db']);
    expect(bad.err).toContain('Unknown report kind "daily"');
    const dry = await run(root, ['--dry-run', 'report', 'build', 'monthly', '--from-db']);
    expect(dry.failed).toBe(false);
    expect(dry.out).toContain('DRY RUN (nothing written)');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports')?.n).toBe(0);
    expect(existsSync(path.join(ctx.paths.reportsDir, ctx.siteId))).toBe(false);
    const missing = await run(root, ['report', 'show', 'baseline']);
    expect(missing.failed).toBe(true);
    expect(missing.err).toContain('No baseline report exists yet');
  });

  it('loads integration statuses from a file and prints the dashboard', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const root = ctx.paths.root;
    const file = path.join(root, 'statuses.json');
    writeFileSync(file, JSON.stringify({ statuses: [{ id: 'google_ga4', state: 'permission_denied', detail: 'no access to property (synthetic)', nextStep: 'Grant the account Viewer access in GA4.' }] }));
    const built = JSON.parse((await run(root, ['--json', 'report', 'build', 'weekly', '--from-db', '--statuses', file])).out);
    expect(built.nextAction).toContain('Fix Google access first');
    const dash = await run(root, ['report', 'dashboard', '--statuses', file]);
    expect(dash.out).toContain('## Integration status');
    expect(dash.out).toContain('| google_ga4 | permission_denied | no access to property (synthetic) |');
    writeFileSync(file, '{"statuses": [{"id": "x", "state": "bogus"}]}');
    const invalid = await run(root, ['report', 'build', 'weekly', '--from-db', '--statuses', file]);
    expect(invalid.failed).toBe(true);
    expect(invalid.err).toContain('Statuses file must contain an array');
  });
});
