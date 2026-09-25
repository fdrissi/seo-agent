import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/vault.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { siteVaultDir } from '../../../src/config/paths.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { seedSyntheticVaultData } from '../../fixtures/obsidian/seed.js';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'fixtures', 'obsidian', 'business');

let ctx: TestContext;
let out: string[];
let err: string[];

async function run(...args: string[]): Promise<{ json: any; text: string; exitCode: number }> {
  out = [];
  err = [];
  process.exitCode = 0;
  const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, {});
  // Same global options as src/cli/main.ts; only this slice's module is registered.
  const program = new Command()
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .exitOverride()
    .configureOutput({ writeErr: (s) => err.push(s), writeOut: (s) => out.push(s) });
  register(program, cli);
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, '--site', ctx.siteId, ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const text = out.join('\n');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { json, text, exitCode };
}

beforeEach(() => {
  ctx = createTestContext();
  process.env.SEO_AGENT_LOG_LEVEL = 'error';
});
afterEach(() => {
  delete process.env.SEO_AGENT_LOG_LEVEL;
  ctx.cleanup();
});

describe('vault CLI', () => {
  it('vault init creates the vault and never overwrites on a second run', async () => {
    const first = await run('vault', 'init', '--json');
    expect(first.exitCode).toBe(0);
    expect(first.json.created).toContain('01 Business/Business Profile.md');
    const second = await run('vault', 'init');
    expect(second.text).toMatch(/Created 0 file\(s\)/);
    expect(second.text).toMatch(/left \d+ existing file\(s\) untouched/);
  });

  it('vault render, then vault check (valid links), with --dry-run writing nothing', async () => {
    seedSyntheticVaultData(ctx.db, ctx.siteId);
    const dry = await run('vault', 'render', '--dry-run', '--json');
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.counts.created).toBeGreaterThan(10);
    expect(existsSync(path.join(siteVaultDir(ctx.paths, ctx.siteId), '00 Dashboard', 'Dashboard.md'))).toBe(false);

    await run('vault', 'init');
    const r = await run('vault', 'render');
    expect(r.exitCode).toBe(0);
    expect(r.text).toMatch(/Vault render .*created/);
    const again = await run('vault', 'render', '--json');
    expect(again.json.counts.created + again.json.counts.updated).toBe(0);

    const check = await run('vault', 'check', '--json');
    expect(check.json.ok).toBe(true);
    expect(check.exitCode).toBe(0);

    // The dashboard shows the vault's own status and says plainly what was not checked.
    const dash = readFileSync(path.join(siteVaultDir(ctx.paths, ctx.siteId), '00 Dashboard', 'Dashboard.md'), 'utf8');
    expect(dash).toMatch(/\| obsidian \| ready \| Local Markdown vault/);
    expect(dash).toContain('Other integrations were not checked during this render');
  });

  it('vault render --only rejects unknown kinds with a clear error', async () => {
    const r = await run('vault', 'render', '--only', 'pages,bogus');
    expect(r.exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/Unknown note kind\(s\): bogus/);
  });

  it('import-business previews, --apply records, apply-business requires the exact diff hash', async () => {
    await run('vault', 'init');
    const profile = path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business', 'Business Profile.md');
    writeFileSync(profile, readFileSync(path.join(FIXTURES, 'profile.valid.md'), 'utf8'));

    const preview = await run('vault', 'import-business');
    expect(preview.text).toMatch(/preview only; nothing recorded/);
    expect(preview.text).toMatch(/~ business\.offer: \(unset\) -> "Synthetic scheduling software/);
    expect(preview.text).toMatch(/The site config is NOT changed by this command/);

    const rec = await run('vault', 'import-business', '--apply', '--json');
    expect(rec.json.recorded).toBe(3);

    const show = await run('vault', 'apply-business', '--json');
    expect(show.json.status).toBe('confirmation_required');
    const hash = show.json.diffHash as string;

    // --by: without it the operating-system user is recorded, and a service account (CI `runner`, Docker `node`) is refused.
    const wrong = await run('vault', 'apply-business', '--confirm', 'deadbeef', '--by', 'tester');
    expect(wrong.exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/APPROVAL_INVALID/);

    const ok = await run('vault', 'apply-business', '--confirm', hash, '--by', 'tester', '--json');
    expect(ok.json.status).toBe('applied');
    expect(readFileSync(path.join(ctx.paths.sitesDir, `${ctx.siteId}.yaml`), 'utf8')).toContain('Synthetic scheduling software for small test clinics.');

    const hist = await run('vault', 'business-history');
    expect(hist.text).toMatch(/01 Business\/Business Profile\.md v1 \(current\) imported · .* trust owner_approved/);
    expect(hist.text).toMatch(/\n  revisions: 1\n  applied as config v\d+ by owner:tester at /);
    // The CLI writes the system log under the real clock's date in the vault time zone; don't hardcode it.
    const logDir = path.join(siteVaultDir(ctx.paths, ctx.siteId), '14 System Logs');
    const logs = readdirSync(logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => readFileSync(path.join(logDir, f), 'utf8'));
    expect(logs.some((l) => /applied to the site config/.test(l))).toBe(true);
  });

  it('import-business exits non-zero when notes are rejected', async () => {
    await run('vault', 'init');
    writeFileSync(path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business', 'Business Profile.md'), readFileSync(path.join(FIXTURES, 'profile.invalid.md'), 'utf8'));
    const r = await run('vault', 'import-business');
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/ERROR: /);
  });

  it('vault resolve requires exactly one mode', async () => {
    const r = await run('vault', 'resolve', '02 Website/Pages/Home.md');
    expect(r.exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/exactly one of --use-generated or --detach/);
    const r2 = await run('vault', 'resolve', '02 Website/Pages/Home.md', '--detach');
    expect(r2.exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/No generated note is tracked/);
  });

  it('vault check on a missing vault fails honestly', async () => {
    const r = await run('vault', 'check');
    expect(r.exitCode).toBe(1);
    expect(r.text).toMatch(/vault init/);
  });
});
