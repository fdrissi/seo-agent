/**
 * D1-R09: `data export --out <file>` never writes private data into the
 * application repository (outside the workspace), the vault, or the workspace
 * secrets/ folder, including through a symlinked directory or a different
 * letter case on a case-insensitive filesystem. The default target, an
 * explicit path elsewhere in the workspace or outside it, and `--out -` stay
 * allowed. SYNTHETIC rows on example.test domains only; every refused path is
 * checked to be absent afterwards.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { exportTarget, register } from '../../../src/cli/commands/data.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { appRoot } from '../../../src/config/paths.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SITE_URL, eachDate, reportsTestConfig, seedGscPages } from '../../fixtures/reports/seed.js';

const contexts: TestContext[] = [];
const cleanups: string[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
  process.exitCode = undefined;
});

function seededCtx(): TestContext {
  const c = createTestContext({ config: reportsTestConfig() });
  contexts.push(c);
  seedGscPages(c.db, c.siteId, { dates: eachDate('2026-09-01', '2026-09-02'), pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }] });
  return c;
}

function outsideDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-export-out-'));
  cleanups.push(d);
  return d;
}

function probeCaseInsensitive(): boolean {
  const d = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-case-probe-'));
  try {
    writeFileSync(path.join(d, 'probe-file'), 'x');
    return existsSync(path.join(d, 'PROBE-FILE'));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = probeCaseInsensitive();

async function run(root: string, args: string[]): Promise<{ out: string; err: string; failed: boolean }> {
  const out: string[] = [];
  const err: string[] = [];
  const cli = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (s) => err.push(s), writeOut: (s) => out.push(s) });
  register(program, cli);
  let failed = false;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch {
    failed = true;
  }
  failed = failed || Number(process.exitCode ?? 0) !== 0;
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), failed };
}

/** Runs `data export gsc-pages --out <file>` and expects UNSAFE_PATH with nothing written at `file`. */
async function expectRefused(ctx: TestContext, file: string, message: RegExp, extra: string[] = []): Promise<void> {
  cleanups.push(file); // removed after the test even if the refusal were broken
  const r = await run(ctx.paths.root, [...extra, 'data', 'export', 'gsc-pages', '--out', file]);
  expect(r.failed, `${file}: ${r.out}`).toBe(true);
  expect(r.err, file).toMatch(/UNSAFE_PATH/);
  expect(r.err, file).toMatch(message);
  expect(existsSync(file), file).toBe(false);
}

describe('data export --out stays out of the repository, the vault, and secrets/ (D1-R09)', () => {
  it('refuses a file inside the application repository (dry run and real run), also through a symlinked folder', async () => {
    const ctx = seededCtx();
    const leak = path.join(appRoot(), 'docs', `leak-${process.pid}.csv`);
    await expectRefused(ctx, leak, /inside the application repository/, ['--dry-run']);
    await expectRefused(ctx, leak, /inside the application repository/);
    const away = outsideDir();
    symlinkSync(appRoot(), path.join(away, 'repo-link'), 'dir');
    await expectRefused(ctx, path.join(away, 'repo-link', 'docs', `leak-${process.pid}.csv`), /inside the application repository/);
    expect(existsSync(leak)).toBe(false);
  });

  it('refuses the vault and the workspace secrets/ folder, also through a symlinked folder', async () => {
    const ctx = seededCtx();
    mkdirSync(path.join(ctx.paths.vaultRoot, ctx.siteId), { recursive: true });
    await expectRefused(ctx, path.join(ctx.paths.vaultRoot, ctx.siteId, 'export.csv'), /inside the Obsidian vault/);
    await expectRefused(ctx, path.join(ctx.paths.secretsDir, 'export.csv'), /inside the workspace secrets\/ folder/);
    const away = outsideDir();
    symlinkSync(ctx.paths.vaultRoot, path.join(away, 'notes'), 'dir');
    await expectRefused(ctx, path.join(away, 'notes', 'export.csv'), /inside the Obsidian vault/);
  });

  it.skipIf(!CASE_INSENSITIVE)('refuses the same locations spelled with a different letter case (case-insensitive filesystem)', async () => {
    const ctx = seededCtx();
    mkdirSync(ctx.paths.vaultRoot, { recursive: true });
    await expectRefused(ctx, path.join(ctx.paths.root, 'Vault', 'export.csv'), /inside the Obsidian vault/);
    await expectRefused(ctx, path.join(ctx.paths.root, 'SECRETS', 'export.csv'), /secrets\/ folder/);
    const repoUpper = appRoot().replace(/[a-z]/g, (c) => c.toUpperCase());
    await expectRefused(ctx, path.join(repoUpper, 'docs', `leak-${process.pid}.csv`), /inside the application repository/, ['--dry-run']);
  });

  it('keeps the default target, other workspace or outside paths, and standard output', async () => {
    const ctx = seededCtx();
    const def = await run(ctx.paths.root, ['--json', 'data', 'export', 'gsc-pages']);
    expect(def.failed, def.err).toBe(false);
    expect(JSON.parse(def.out).file).toBe(path.join(ctx.paths.exportsDir, 'data', 'test-site-gsc-pages-start-latest.csv'));
    const inWorkspace = path.join(ctx.paths.root, 'plain.csv');
    expect((await run(ctx.paths.root, ['data', 'export', 'gsc-pages', '--out', inWorkspace])).failed).toBe(false);
    expect(readFileSync(inWorkspace, 'utf8')).toMatch(/pricing/);
    const outside = path.join(outsideDir(), 'nested', 'export.csv');
    expect((await run(ctx.paths.root, ['data', 'export', 'gsc-pages', '--out', outside])).failed).toBe(false);
    expect(existsSync(outside)).toBe(true);
    const stdout = await run(ctx.paths.root, ['data', 'export', 'gsc-pages', '--out', '-']);
    expect(stdout.failed, stdout.err).toBe(false);
    expect(stdout.out).toMatch(/pricing/);
  });

  it('exportTarget allows a workspace that lives inside the repository (test workspaces) and refuses its vault and secrets/ there', () => {
    // Only lstat is used: nothing is created in the repository.
    const root = path.join(appRoot(), `.never-created-ws-${process.pid}`);
    const guard = { root, vaultRoot: path.join(root, 'vault'), secretsDir: path.join(root, 'secrets') };
    const exportsDir = path.join(root, 'exports');
    expect(exportTarget(exportsDir, 'x.csv', path.join(root, 'out.csv'), guard)).toBe(path.join(root, 'out.csv'));
    expect(() => exportTarget(exportsDir, 'x.csv', path.join(root, 'vault', 'x.csv'), guard)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => exportTarget(exportsDir, 'x.csv', path.join(root, 'secrets', 'x.csv'), guard)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => exportTarget(exportsDir, 'x.csv', path.join(appRoot(), 'src', 'x.csv'), guard)).toThrow(/inside the application repository/);
    // Without workspace locations there is no exemption: the repository is refused.
    expect(() => exportTarget(exportsDir, 'x.csv', path.join(root, 'out.csv'))).toThrow(/inside the application repository/);
    expect(existsSync(root)).toBe(false);
  });
});
