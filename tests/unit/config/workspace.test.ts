import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDirs, appRoot, workspacePaths } from '../../../src/config/paths.js';
import { WORKSPACE_FORMAT_VERSION, assertProfileMatchesWorkspace, ensureVaultFromTemplate, initWorkspace, isRepoPath, readManifest } from '../../../src/config/workspace.js';

let tmp: string;
let root: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-ws-'));
  root = path.join(tmp, 'workspace');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

/** Snapshot of every file (content + mode) under a directory. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(dir, p)] = `${mode(p).toString(8)}:${readFileSync(p, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

describe('initWorkspace', () => {
  it('creates the private layout with 0700 directories and 0600 secret files', () => {
    const r = initWorkspace(root, { now: new Date('2026-09-24T09:00:00Z') });
    const p = workspacePaths(root);
    for (const d of [p.root, p.configDir, p.sitesDir, p.vaultRoot, p.dataDir, p.rawDir, p.cacheDir, p.qdrantDir, p.exportsDir, p.reportsDir, p.logsDir, p.backupsDir, p.diagnosticsDir, p.secretsDir, p.googleDir]) {
      expect(existsSync(d)).toBe(true);
      expect(mode(d)).toBe(0o700);
    }
    for (const f of [p.manifest, p.secretsEnvFile, path.join(p.secretsDir, 'README.md')]) expect(mode(f)).toBe(0o600);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('*');
    expect(readFileSync(p.secretsEnvFile, 'utf8')).toMatch(/^# Private secrets/);
    expect(readManifest(p)).toMatchObject({ formatVersion: WORKSPACE_FORMAT_VERSION, kind: 'live', createdAt: '2026-09-24T09:00:00.000Z' });
    expect(r.created).toContain(p.manifest);
    expect(r.existing).toEqual([]);
  });

  it('is idempotent: a second run creates nothing and changes nothing', () => {
    initWorkspace(root);
    const before = snapshot(root);
    const r = initWorkspace(root);
    expect(r.created).toEqual([]);
    expect(r.existing.length).toBeGreaterThan(10);
    expect(snapshot(root)).toEqual(before);
  });

  it('NEVER overwrites existing files, whatever their content', () => {
    const p = workspacePaths(root);
    mkdirSync(p.secretsDir, { recursive: true, mode: 0o700 });
    mkdirSync(p.sitesDir, { recursive: true });
    const custom: Record<string, string> = {
      [p.manifest]: JSON.stringify({ formatVersion: 1, createdAt: '2020-01-01T00:00:00.000Z', createdByAppVersion: '0.0.1', kind: 'live', note: 'OWNER EDITED', extra: true }),
      [path.join(root, 'README.md')]: 'my own readme\n',
      [path.join(root, '.gitignore')]: 'custom-ignore\n',
      [p.secretsEnvFile]: 'APIFY_TOKEN=synthetic-owner-token-0001\n',
      [path.join(p.secretsDir, 'README.md')]: 'owner notes\n',
      [path.join(p.sitesDir, 'owner-site.yaml')]: 'site: {id: owner-site}\n',
    };
    for (const [f, c] of Object.entries(custom)) writeFileSync(f, c, { mode: 0o600 });
    const r = initWorkspace(root);
    for (const [f, c] of Object.entries(custom)) {
      expect(readFileSync(f, 'utf8')).toBe(c);
      if (f !== path.join(p.sitesDir, 'owner-site.yaml')) expect(r.existing).toContain(f);
    }
    expect(r.created).not.toContain(p.manifest);
  });

  it('does not follow a dangling symlink planted at a file location', () => {
    const p = workspacePaths(root);
    mkdirSync(p.secretsDir, { recursive: true, mode: 0o700 });
    const target = path.join(tmp, 'outside', 'planted.env');
    symlinkSync(target, p.secretsEnvFile);
    const r = initWorkspace(root);
    expect(existsSync(target)).toBe(false);
    expect(r.existing).toContain(p.secretsEnvFile);
  });

  it('tightens only the secrets directories and warns about an exposed secrets file without editing it', () => {
    initWorkspace(root);
    const p = workspacePaths(root);
    chmodSync(p.secretsDir, 0o755);
    chmodSync(p.secretsEnvFile, 0o644);
    chmodSync(p.reportsDir, 0o755);
    const r = initWorkspace(root);
    expect(mode(p.secretsDir)).toBe(0o700);
    expect(mode(p.reportsDir)).toBe(0o755); // non-secret dirs are left as the owner set them
    expect(mode(p.secretsEnvFile)).toBe(0o644); // never modified; the owner is told what to run
    expect(r.warnings.join('\n')).toContain('Tightened permissions');
    expect(r.warnings.join('\n')).toContain('chmod 600');
  });

  it('dry run reports the plan and writes nothing', () => {
    const r = initWorkspace(root, { dryRun: true });
    expect(r.created).toContain(workspacePaths(root).manifest);
    expect(existsSync(root)).toBe(false);
  });

  it('refuses a workspace inside the application repository unless explicitly allowed', () => {
    const inside = path.join(appRoot(), `tmp-ws-refusal-${process.pid}`);
    expect(isRepoPath(inside)).toBe(true);
    expect(isRepoPath(root)).toBe(false);
    expect(() => initWorkspace(inside)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }));
    expect(existsSync(inside)).toBe(false);
    // Allowed (demo/tests only) - verified with a dry run so the repository is never written.
    expect(initWorkspace(inside, { allowInsideRepo: true, dryRun: true }).created.length).toBeGreaterThan(0);
    expect(existsSync(inside)).toBe(false);
  });

  it('refuses a workspace written by a newer application (never downgrades)', () => {
    const p = workspacePaths(root);
    mkdirSync(root, { recursive: true });
    const manifest = JSON.stringify({ formatVersion: WORKSPACE_FORMAT_VERSION + 1, createdAt: 'x', createdByAppVersion: '9.9.9', kind: 'live', note: '' });
    writeFileSync(p.manifest, manifest);
    expect(() => initWorkspace(root)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }));
    expect(readFileSync(p.manifest, 'utf8')).toBe(manifest);
    expect(existsSync(p.secretsDir)).toBe(false);
  });

  it('refuses to mix demo and live workspaces', () => {
    initWorkspace(root, { kind: 'demo' });
    expect(readManifest(workspacePaths(root))?.kind).toBe('demo');
    expect(() => initWorkspace(root, { kind: 'live' })).toThrow(expect.objectContaining({ code: 'WORKSPACE_EXISTS' }));
    expect(() => initWorkspace(root, { kind: 'demo' })).not.toThrow();
  });

  it('always refuses the filesystem root, the home directory, and the temp directory itself (even with allowInsideRepo)', () => {
    const home = path.join(tmp, 'home');
    mkdirSync(home);
    writeFileSync(path.join(home, '.bashrc'), '# unrelated synthetic dotfile\n');
    for (const [dir, label] of [
      [home, 'your home directory'],
      [os.tmpdir(), 'the system temporary directory itself'],
      [path.parse(tmp).root, 'the filesystem root'],
    ] as const) {
      expect(() => initWorkspace(dir, { env: { HOME: home }, allowInsideRepo: true, dryRun: true })).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE', message: expect.stringContaining(label) }));
    }
    expect(readdirSync(home)).toEqual(['.bashrc']);
    // A dedicated folder below them is fine.
    expect(() => initWorkspace(path.join(home, 'seo-agent-workspace'), { env: { HOME: home } })).not.toThrow();
  });

  it('refuses a non-empty directory without workspace.json when allowExistingDir is false (the init CLI default); the library default stays permissive', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'unrelated.txt'), 'someone else\'s file\n');
    expect(() => initWorkspace(root, { allowExistingDir: false })).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE', hint: expect.stringContaining('--allow-existing-dir') }));
    expect(readdirSync(root)).toEqual(['unrelated.txt']);
    // An empty directory, or an existing workspace, is always fine.
    const empty = path.join(tmp, 'empty');
    mkdirSync(empty);
    expect(() => initWorkspace(empty, { allowExistingDir: false })).not.toThrow();
    expect(() => initWorkspace(empty, { allowExistingDir: false })).not.toThrow();
    // Explicitly allowed (or a programmatic caller): the layout is added next to the file, which is untouched.
    initWorkspace(root);
    expect(readFileSync(path.join(root, 'unrelated.txt'), 'utf8')).toBe("someone else's file\n");
    expect(readManifest(workspacePaths(root))?.kind).toBe('live');
  });

  it('refuses a workspace in an older format until `config migrate` upgrades it', () => {
    const p = workspacePaths(root);
    mkdirSync(root, { recursive: true });
    const manifest = JSON.stringify({ formatVersion: WORKSPACE_FORMAT_VERSION - 1, createdAt: 'x', createdByAppVersion: '0.0.1', kind: 'live', note: '' });
    writeFileSync(p.manifest, manifest);
    expect(() => initWorkspace(root)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE', hint: expect.stringContaining('config migrate') }));
    expect(readFileSync(p.manifest, 'utf8')).toBe(manifest);
  });

  it('assertProfileMatchesWorkspace keeps demo and live apart in both directions', () => {
    const where = { root: '/synthetic/ws', siteId: 'site-a' };
    expect(() => assertProfileMatchesWorkspace('live', 'demo', where)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE', hint: expect.stringContaining('npm run demo') }));
    for (const profile of ['core', 'full']) {
      expect(() => assertProfileMatchesWorkspace('demo', profile, where)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE', hint: expect.stringContaining('init') }));
      expect(() => assertProfileMatchesWorkspace('live', profile, where)).not.toThrow();
    }
    expect(() => assertProfileMatchesWorkspace('demo', 'demo', where)).not.toThrow();
  });

  it('reports a corrupt manifest honestly and leaves it untouched', () => {
    const p = workspacePaths(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(p.manifest, '{ not json');
    expect(() => initWorkspace(root)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }));
    expect(readFileSync(p.manifest, 'utf8')).toBe('{ not json');
    writeFileSync(p.manifest, '{"kind":"live"}');
    expect(() => readManifest(p)).toThrow(/formatVersion/);
  });
});

describe('ensureVaultFromTemplate', () => {
  it('copies only missing files and never overwrites human edits', () => {
    const tpl = path.join(tmp, 'template');
    const target = path.join(tmp, 'vault', 'example-site');
    mkdirSync(path.join(tpl, 'sub'), { recursive: true });
    writeFileSync(path.join(tpl, 'a.md'), 'template a');
    writeFileSync(path.join(tpl, 'sub', 'b.md'), 'template b');
    writeFileSync(path.join(tpl, '.gitkeep'), '');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'a.md'), 'HUMAN EDIT');
    const r1 = ensureVaultFromTemplate(tpl, target);
    expect(readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('HUMAN EDIT');
    expect(readFileSync(path.join(target, 'sub', 'b.md'), 'utf8')).toBe('template b');
    expect(existsSync(path.join(target, '.gitkeep'))).toBe(false);
    expect(r1.existing).toEqual([path.join(target, 'a.md')]);
    expect(r1.created).toContain(path.join(target, 'sub', 'b.md'));
    writeFileSync(path.join(target, 'sub', 'b.md'), 'EDITED LATER');
    const r2 = ensureVaultFromTemplate(tpl, target);
    expect(r2.created).toEqual([]);
    expect(readFileSync(path.join(target, 'sub', 'b.md'), 'utf8')).toBe('EDITED LATER');
  });

  it('copies the shipped vault template and tolerates a missing template directory', () => {
    const target = path.join(tmp, 'vault', 'shipped');
    const r = ensureVaultFromTemplate(appDirs.vaultTemplate(), target);
    expect(r.created.length).toBeGreaterThan(0);
    expect(ensureVaultFromTemplate(path.join(tmp, 'no-template'), path.join(tmp, 'x'))).toEqual({ created: [], existing: [], skipped: [] });
  });

  it('never writes through a symlinked folder that points outside the vault', () => {
    const target = path.join(tmp, 'vault', 'linked');
    const outside = path.join(tmp, 'outside');
    mkdirSync(target, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(target, '01 Business'));
    const r = ensureVaultFromTemplate(appDirs.vaultTemplate(), target);
    expect(readdirSync(outside)).toEqual([]);
    expect(r.skipped).toContain(path.join(target, '01 Business'));
    expect(r.created.some((p) => p.startsWith(path.join(target, '01 Business')))).toBe(false);
    expect(r.created.length).toBeGreaterThan(0); // the rest of the template is still copied
  });

  it('follows a symlinked folder that stays inside the vault, and skips a file where a folder is expected', () => {
    const tpl = path.join(tmp, 'template');
    mkdirSync(path.join(tpl, 'notes'), { recursive: true });
    mkdirSync(path.join(tpl, 'blocked'), { recursive: true });
    writeFileSync(path.join(tpl, 'notes', 'n.md'), 'template n');
    writeFileSync(path.join(tpl, 'blocked', 'x.md'), 'template x');
    const target = path.join(tmp, 'vault', 'inner');
    mkdirSync(path.join(target, 'real-notes'), { recursive: true });
    symlinkSync(path.join(target, 'real-notes'), path.join(target, 'notes'));
    writeFileSync(path.join(target, 'blocked'), 'a human file named like a folder');
    const r = ensureVaultFromTemplate(tpl, target);
    expect(readFileSync(path.join(target, 'real-notes', 'n.md'), 'utf8')).toBe('template n');
    expect(r.skipped).toEqual([path.join(target, 'blocked')]);
    expect(readFileSync(path.join(target, 'blocked'), 'utf8')).toBe('a human file named like a folder');
  });
});
