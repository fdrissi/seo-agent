import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appDirs,
  appRoot,
  forbiddenRootLabel,
  isCaseInsensitivePath,
  isSameRealPath,
  isWithinRealPath,
  manifestPathOverrides,
  migrationsDirOverride,
  resolveRealPath,
  siteVaultDir,
  validateWorkspacePathOverrides,
  workspacePaths,
} from '../../../src/config/paths.js';
import { initWorkspace, isRepoPath } from '../../../src/config/workspace.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-paths-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('resolveRealPath (one realpath helper for every "inside X" check)', () => {
  it('resolves symlinks in existing paths and in the existing ancestor of a missing path', () => {
    const real = path.join(tmp, 'real');
    mkdirSync(real);
    const link = path.join(tmp, 'link');
    symlinkSync(real, link);
    expect(resolveRealPath(link)).toBe(realpathSync(real));
    expect(resolveRealPath(path.join(link, 'not', 'yet', 'created'))).toBe(path.join(realpathSync(real), 'not', 'yet', 'created'));
    // os.tmpdir() itself may be a symlink (macOS /var -> /private/var): still resolved.
    expect(resolveRealPath(path.join(tmp, 'missing'))).toBe(path.join(realpathSync(tmp), 'missing'));
  });

  it('isRepoPath catches a workspace reached through a symlink into the application repository', () => {
    const link = path.join(tmp, 'repo-link');
    symlinkSync(path.join(appRoot(), 'src'), link);
    const through = path.join(link, `ws-inside-${process.pid}`);
    expect(isRepoPath(path.join(appRoot(), 'src', 'ws-inside'))).toBe(true);
    expect(isRepoPath(through)).toBe(true);
    expect(isRepoPath(path.join(tmp, 'elsewhere'))).toBe(false);
    // init refuses it, and nothing is created in the repository.
    expect(() => initWorkspace(through)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }));
  });
});

describe('forbiddenRootLabel', () => {
  it('names the filesystem root, the home directory, and the temp directory itself (symlinks resolved), and nothing below them', () => {
    const home = path.join(tmp, 'home');
    mkdirSync(home);
    const env = { HOME: home };
    expect(forbiddenRootLabel(path.parse(process.cwd()).root, env)).toBe('the filesystem root');
    expect(forbiddenRootLabel(home, env)).toBe('your home directory');
    expect(forbiddenRootLabel(os.homedir(), env)).toBe('your home directory');
    expect(forbiddenRootLabel(os.tmpdir(), env)).toBe('the system temporary directory itself');
    expect(forbiddenRootLabel(realpathSync(os.tmpdir()), env)).toBe('the system temporary directory itself');
    const homeLink = path.join(tmp, 'home-link');
    symlinkSync(home, homeLink);
    expect(forbiddenRootLabel(homeLink, env)).toBe('your home directory');
    expect(forbiddenRootLabel(path.join(home, 'seo-agent-workspace'), env)).toBeNull();
    expect(forbiddenRootLabel(tmp, env)).toBeNull();
  });
});

describe('workspace.json "paths" block (relocated folders)', () => {
  const writeManifest = (root: string, paths: unknown) => {
    const p = workspacePaths(root);
    writeFileSync(p.manifest, JSON.stringify({ formatVersion: 1, createdAt: '2026-09-24T09:00:00.000Z', createdByAppVersion: '0.1.0', kind: 'live', note: 'synthetic', paths }, null, 2));
  };

  it('applies valid absolute overrides in workspacePaths, so siteVaultDir/backupsDir callers follow them', () => {
    const root = path.join(tmp, 'ws');
    initWorkspace(root);
    const vault = path.join(tmp, 'obsidian', 'vaults');
    const backups = path.join(tmp, 'other-disk', 'backups');
    writeManifest(root, { vaultDir: vault, backupsDir: backups, exportsDir: path.join(tmp, 'exports-out') });
    const p = workspacePaths(root);
    expect(p.vaultRoot).toBe(vault);
    expect(siteVaultDir(p, 'acme-site')).toBe(path.join(vault, 'acme-site'));
    expect(p.backupsDir).toBe(backups);
    expect(p.exportsDir).toBe(path.join(tmp, 'exports-out'));
    // Everything else stays derived from the root.
    expect(p.qdrantDir).toBe(path.join(root, 'qdrant'));
    expect(p.reportsDir).toBe(path.join(root, 'reports'));
    expect(p.dbFile).toBe(path.join(root, 'data', 'seo-agent.sqlite'));
    expect(p.secretsDir).toBe(path.join(root, 'secrets'));
    expect(manifestPathOverrides(root)).toEqual({ vaultDir: vault, backupsDir: backups, exportsDir: path.join(tmp, 'exports-out') });
    // Re-running init creates the relocated folders (0700) and never touches the manifest.
    const r = initWorkspace(root);
    expect(r.created).toEqual(expect.arrayContaining([vault, backups]));
  });

  it('refuses relative paths, the repository (also through a symlink), home/root/tmp, secrets/, the workspace root, a parent of it, and unknown keys', () => {
    const root = path.join(tmp, 'ws');
    mkdirSync(root);
    const home = path.join(tmp, 'home');
    mkdirSync(home);
    const repoLink = path.join(tmp, 'repo-link');
    symlinkSync(appRoot(), repoLink);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ vaultDir: 'relative/vault' }, /paths\.vaultDir: must be an absolute path/],
      [{ vaultDir: '~/vault' }, /paths\.vaultDir: must be an absolute path/],
      [{ backupsDir: path.join(appRoot(), 'backups-here') }, /paths\.backupsDir: .* inside the application repository/],
      [{ backupsDir: path.join(repoLink, 'backups-here') }, /paths\.backupsDir: .* inside the application repository/],
      [{ qdrantDir: home }, /paths\.qdrantDir: refusing your home directory/],
      [{ qdrantDir: os.tmpdir() }, /paths\.qdrantDir: refusing the system temporary directory itself/],
      [{ exportsDir: path.parse(tmp).root }, /paths\.exportsDir: refusing the filesystem root/],
      [{ vaultDir: path.join(root, 'secrets', 'vault') }, /paths\.vaultDir: .* inside the workspace secrets\/ directory/],
      [{ vaultDir: root }, /paths\.vaultDir: .* the workspace root itself/],
      [{ vaultDir: tmp }, /paths\.vaultDir: .* contains the workspace/],
      [{ logsDir: path.join(tmp, 'logs') }, /paths\.logsDir: unknown key \(allowed: vaultDir, backupsDir, qdrantDir, exportsDir, reportsDir\)/],
      // reportsDir gets exactly the same checks as the other relocatable folders (NF-07).
      [{ reportsDir: 'relative/reports' }, /paths\.reportsDir: must be an absolute path/],
      [{ reportsDir: path.join(appRoot(), 'reports-here') }, /paths\.reportsDir: .* inside the application repository/],
      [{ reportsDir: path.join(repoLink, 'reports-here') }, /paths\.reportsDir: .* inside the application repository/],
      [{ reportsDir: home }, /paths\.reportsDir: refusing your home directory/],
      [{ reportsDir: path.join(root, 'secrets', 'reports') }, /paths\.reportsDir: .* inside the workspace secrets\/ directory/],
      [{ reportsDir: root }, /paths\.reportsDir: .* the workspace root itself/],
      [{ reportsDir: tmp }, /paths\.reportsDir: .* contains the workspace/],
      [{ vaultDir: 42 }, /paths\.vaultDir: must be a non-empty absolute path/],
    ];
    for (const [block, re] of cases) {
      const v = validateWorkspacePathOverrides(root, block, { HOME: home });
      expect(v.errors.join('\n'), JSON.stringify(block)).toMatch(re);
      expect(v.paths).toEqual({});
    }
    expect(validateWorkspacePathOverrides(root, ['x']).errors).toEqual(['paths: must be an object such as {"vaultDir": "/absolute/path"}']);
    expect(validateWorkspacePathOverrides(root, undefined)).toEqual({ paths: {}, errors: [] });
  });

  it('relocates reportsDir (NF-07): validated like the other folders, applied by workspacePaths, created 0700 by init', () => {
    const root = path.join(tmp, 'ws');
    initWorkspace(root);
    const reports = path.join(tmp, 'shared-drive', 'seo-reports');
    const v = validateWorkspacePathOverrides(root, { reportsDir: reports });
    expect(v).toEqual({ paths: { reportsDir: reports }, errors: [] });
    writeManifest(root, { reportsDir: reports });
    const p = workspacePaths(root);
    expect(p.reportsDir).toBe(reports);
    expect(manifestPathOverrides(root)).toEqual({ reportsDir: reports });
    // Only the reports folder moved.
    expect(p.exportsDir).toBe(path.join(root, 'exports'));
    expect(p.dbFile).toBe(path.join(root, 'data', 'seo-agent.sqlite'));
    expect(existsSync(reports)).toBe(false);
    const r = initWorkspace(root);
    expect(r.created).toContain(reports);
    expect(statSync(reports).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(statSync(reports).mode & 0o777).toBe(0o700);
  });

  it('an invalid block makes workspacePaths throw WORKSPACE_UNSAFE (never a silent fallback), and a corrupt manifest is left to readManifest', () => {
    const root = path.join(tmp, 'ws');
    initWorkspace(root);
    writeManifest(root, { vaultDir: 'relative' });
    expect(() => workspacePaths(root)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE', details: { errors: [expect.stringMatching(/paths\.vaultDir/)] } }));
    writeFileSync(path.join(root, 'workspace.json'), '{ not json');
    expect(workspacePaths(root).vaultRoot).toBe(path.join(root, 'vault'));
  });
});

/**
 * D3-02: on a case-insensitive volume (macOS APFS, Windows NTFS by default)
 * "<ws>/Vault" IS "<ws>/vault". Safety checks compare canonical paths
 * (realpathSync.native returns the stored letter case) and fold the case of
 * parts that do not exist yet. Probed independently of the implementation;
 * the case-specific tests are skipped on a case-sensitive filesystem (Linux CI).
 */
function probeCaseInsensitive(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-case-probe-'));
  try {
    writeFileSync(path.join(dir, 'probe-file'), 'x');
    return existsSync(path.join(dir, 'PROBE-FILE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = probeCaseInsensitive();
const upper = (p: string) => p.replace(/[a-z]/g, (c) => c.toUpperCase());

describe('canonical-path comparisons (D3-02)', () => {
  it('isCaseInsensitivePath agrees with an independent probe of the temporary directory', () => {
    expect(isCaseInsensitivePath(tmp)).toBe(CASE_INSENSITIVE);
    expect(isCaseInsensitivePath(path.join(tmp, 'not', 'yet', 'created'))).toBe(CASE_INSENSITIVE);
  });

  it('keeps exact comparisons on every filesystem', () => {
    const vault = path.join(tmp, 'vault');
    mkdirSync(vault);
    expect(isWithinRealPath(vault, path.join(vault, 'site', 'token.json'))).toBe(true);
    expect(isWithinRealPath(vault, path.join(tmp, 'vault-other', 'token.json'))).toBe(false);
    expect(isSameRealPath(vault, path.join(tmp, 'x', '..', 'vault'))).toBe(true);
    expect(isSameRealPath(vault, path.join(tmp, 'other'))).toBe(false);
  });

  it.skipIf(!CASE_INSENSITIVE)('resolveRealPath returns the canonical letter case of existing components', () => {
    const vault = path.join(tmp, 'vault');
    mkdirSync(vault);
    const canonical = realpathSync.native(vault);
    expect(resolveRealPath(path.join(tmp, 'Vault'))).toBe(canonical);
    expect(resolveRealPath(path.join(tmp, 'VAULT', 'site', 'token.json'))).toBe(path.join(canonical, 'site', 'token.json'));
  });

  it.skipIf(!CASE_INSENSITIVE)('a different letter case is inside the same folder, whether or not the folder exists yet', () => {
    const ws = path.join(tmp, 'ws');
    mkdirSync(ws);
    // The vault does not exist yet: the missing parts are compared case-insensitively.
    expect(isWithinRealPath(path.join(ws, 'vault'), path.join(ws, 'Vault', 'token.json'))).toBe(true);
    mkdirSync(path.join(ws, 'vault'));
    expect(isWithinRealPath(path.join(ws, 'vault'), path.join(ws, 'Vault', 'token.json'))).toBe(true);
    expect(isSameRealPath(ws, upper(ws))).toBe(true);
    expect(isWithinRealPath(appRoot(), path.join(upper(appRoot()), 'docs', 'leak.csv'))).toBe(true);
  });

  it.skipIf(!CASE_INSENSITIVE)('workspace.json "paths" refuses SECRETS/, an upper-cased repository path, and an upper-cased workspace root', () => {
    const root = path.join(tmp, 'ws');
    mkdirSync(path.join(root, 'secrets'), { recursive: true });
    const home = path.join(tmp, 'home');
    mkdirSync(home);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ vaultDir: path.join(root, 'SECRETS', 'vault') }, /paths\.vaultDir: .* inside the workspace secrets\/ directory/],
      [{ reportsDir: path.join(root, 'Secrets') }, /paths\.reportsDir: .* inside the workspace secrets\/ directory/],
      [{ backupsDir: path.join(upper(appRoot()), 'backups-here') }, /paths\.backupsDir: .* inside the application repository/],
      [{ exportsDir: upper(root) }, /paths\.exportsDir: (.* the workspace root itself|refusing)/],
      [{ qdrantDir: upper(home) }, /paths\.qdrantDir: refusing your home directory/],
    ];
    for (const [block, re] of cases) {
      const v = validateWorkspacePathOverrides(root, block, { HOME: home });
      expect(v.errors.join('\n'), JSON.stringify(block)).toMatch(re);
      expect(v.paths).toEqual({});
    }
    expect(forbiddenRootLabel(upper(home), { HOME: home })).toBe('your home directory');
    expect(existsSync(path.join(appRoot(), 'backups-here'))).toBe(false);
  });
});

describe('migrations directory override (test runner only)', () => {
  it('honors SEO_AGENT_MIGRATIONS_DIR only under NODE_ENV=test or VITEST', () => {
    const dir = path.join(tmp, 'migrations-next');
    expect(migrationsDirOverride({ SEO_AGENT_MIGRATIONS_DIR: dir, VITEST: 'true' })).toBe(dir);
    expect(migrationsDirOverride({ SEO_AGENT_MIGRATIONS_DIR: dir, NODE_ENV: 'test' })).toBe(dir);
    expect(migrationsDirOverride({ SEO_AGENT_MIGRATIONS_DIR: dir, NODE_ENV: 'production' })).toBeNull();
    expect(migrationsDirOverride({ SEO_AGENT_MIGRATIONS_DIR: dir })).toBeNull();
    expect(migrationsDirOverride({ VITEST: 'true' })).toBeNull();
    const saved = process.env.SEO_AGENT_MIGRATIONS_DIR;
    try {
      process.env.SEO_AGENT_MIGRATIONS_DIR = dir;
      expect(appDirs.migrations()).toBe(dir);
    } finally {
      if (saved === undefined) delete process.env.SEO_AGENT_MIGRATIONS_DIR;
      else process.env.SEO_AGENT_MIGRATIONS_DIR = saved;
    }
    expect(appDirs.migrations()).toBe(path.join(appRoot(), 'migrations'));
  });
});
