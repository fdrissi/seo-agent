/**
 * `init` location guards (audit A1-07) and the workspace.json `paths` block
 * (audit A1-05), through the real CLI. SYNTHETIC and offline.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { siteVaultDir, workspacePaths } from '../../../src/config/paths.js';
import { readManifest } from '../../../src/config/workspace.js';
import { runCli, tempDir, type TempDir } from '../../e2e/helpers.js';

let tmp: TempDir | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

describe('init refuses unsafe locations', () => {
  it('refuses the home directory (also as "~"), and a non-empty directory without workspace.json unless --allow-existing-dir', async () => {
    tmp = tempDir('init-guards');
    const home = path.join(tmp.root, 'home');
    mkdirSync(home);
    writeFileSync(path.join(home, '.profile'), '# synthetic unrelated dotfile\n');
    const env = { HOME: home };

    for (const ws of [home, '~']) {
      const r = await runCli(['--workspace', ws, 'init'], env);
      expect(r.code, ws).toBe(1);
      expect(r.err).toContain('Error [WORKSPACE_UNSAFE]: Refusing to use your home directory');
    }
    expect(readdirSync(home)).toEqual(['.profile']);

    const busy = path.join(tmp.root, 'projects');
    mkdirSync(busy);
    writeFileSync(path.join(busy, 'notes.txt'), 'unrelated synthetic notes\n');
    const refused = await runCli(['--workspace', busy, 'init'], env);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('is not empty and has no workspace.json');
    expect(refused.err).toContain('--allow-existing-dir');
    expect(readdirSync(busy)).toEqual(['notes.txt']);
    // The dry run applies the same guard.
    expect((await runCli(['--workspace', busy, 'init', '--dry-run'], env)).code).toBe(1);
    // setup's implicit workspace creation uses the same guard.
    const src = path.join(tmp.root, 'site.yaml');
    writeFileSync(src, 'site: {id: acme-site, businessName: Acme (synthetic), url: "https://www.example.com/", allowedHostnames: [www.example.com]}\n');
    const setup = await runCli(['--workspace', busy, 'setup', '--from', src], env);
    expect(setup.code).toBe(1);
    expect(setup.err).toContain('is not empty and has no workspace.json');
    expect(readdirSync(busy)).toEqual(['notes.txt']);

    const allowed = await runCli(['--workspace', busy, 'init', '--allow-existing-dir', '--json'], env);
    expect(allowed.code, allowed.err).toBe(0);
    expect(readFileSync(path.join(busy, 'notes.txt'), 'utf8')).toBe('unrelated synthetic notes\n');
    expect(readManifest(workspacePaths(busy))?.kind).toBe('live');
    // Re-running on an existing workspace needs no flag.
    expect((await runCli(['--workspace', busy, 'init', '--json'], env)).code).toBe(0);
    // An empty or new directory needs no flag.
    expect((await runCli(['--workspace', path.join(tmp.root, 'fresh'), 'init', '--json'], env)).code).toBe(0);
  });
});

describe('workspace.json "paths" block', () => {
  it('relocates the vault and backups (validated), and `workspace status` shows it; an invalid block is refused by every command', async () => {
    tmp = tempDir('ws-paths');
    const env = { HOME: path.join(tmp.root, 'home') };
    const root = path.join(tmp.root, 'ws');
    expect((await runCli(['--workspace', root, 'init', '--json'], env)).code).toBe(0);
    const paths = workspacePaths(root);
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
    const vaultDir = path.join(tmp.root, 'obsidian');
    const backupsDir = path.join(tmp.root, 'external-disk', 'seo-agent-backups');
    writeFileSync(paths.manifest, JSON.stringify({ ...manifest, paths: { vaultDir, backupsDir } }, null, 2));

    expect(siteVaultDir(workspacePaths(root), 'acme-site')).toBe(path.join(vaultDir, 'acme-site'));
    const status = await runCli(['--workspace', root, 'workspace', 'status'], env);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain(`Relocated (workspace.json paths.vaultDir): ${vaultDir}`);
    expect(status.out).toContain(`Relocated (workspace.json paths.backupsDir): ${backupsDir}`);
    // `init` creates the relocated folders; backups land there.
    expect((await runCli(['--workspace', root, 'init', '--json'], env)).code).toBe(0);
    expect(existsSync(vaultDir) && existsSync(backupsDir)).toBe(true);
    const backup = await runCli(['--workspace', root, 'backup', '--no-vault', '--json'], env);
    expect(backup.code, backup.err).toBe(0);
    expect(readdirSync(backupsDir).some((f) => f.startsWith('backup-'))).toBe(true);

    writeFileSync(paths.manifest, JSON.stringify({ ...manifest, paths: { vaultDir: 'relative/vault' } }, null, 2));
    for (const args of [['workspace', 'status'], ['db', 'status'], ['init']]) {
      const r = await runCli(['--workspace', root, ...args], env);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toContain('Error [WORKSPACE_UNSAFE]');
      expect(r.err).toContain('paths.vaultDir: must be an absolute path');
    }
  });
});
