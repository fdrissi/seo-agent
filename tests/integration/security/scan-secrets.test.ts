import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasSequentialRun } from '../../../scripts/lib/secret-rules.mjs';
import { parseDiffGitLine, parseDiffHeaderPath, unquoteGitPath, type ScanReport } from '../../../scripts/scan-secrets.mjs';
import { opensshEd25519PrivateKey } from '../../unit/security/openssh-key.js';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts', 'scan-secrets.mjs');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const hasGit = spawnSync('git', ['--version']).status === 0;

// Fake secrets are generated per run and never committed to this repository.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function rand(n: number): string {
  for (;;) {
    const s = Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join('');
    if (!hasSequentialRun(s, 4) && !/fake|test|example|dummy|sample|mock|synthetic|xxxx/i.test(s)) return s;
  }
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function scan(root: string, ...extra: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--no-allowlist', ...extra], { encoding: 'utf8', env: GIT_ENV });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(!hasGit)('scripts/scan-secrets.mjs on a temporary Git repository', () => {
  let dir: string;
  const planted = {
    googleKey: `AIza${rand(35)}`,
    apifyInHistoryOnly: `apify_api_${rand(36)}`,
    llmKeyInHistoryOnly: `llmgtwy_${rand(32)}`,
    dotenvPassword: rand(20),
    ignoredToken: `ya29.${rand(60)}`,
    pem: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-scan-'));
    git(dir, 'init', '-q');
    writeFileSync(path.join(dir, '.gitignore'), 'ignored-secrets.txt\nnode_modules/\n');
    writeFileSync(path.join(dir, 'README.md'), '# synthetic repo\n');
    // Secret that exists only in history: committed, then removed.
    writeFileSync(path.join(dir, 'old-notes.txt'), `apify token was ${planted.apifyInHistoryOnly}\n`);
    writeFileSync(path.join(dir, 'old-key.pem.txt'), planted.pem);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `initial import (gateway key ${planted.llmKeyInHistoryOnly})`);
    git(dir, 'rm', '-q', 'old-notes.txt', 'old-key.pem.txt');
    git(dir, 'commit', '-q', '-m', 'remove notes');
    // Current tree secrets (uncommitted but not ignored: would be committed next).
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'config.ts'), `export const config = { mapsKey: "${planted.googleKey}" };\n`);
    writeFileSync(path.join(dir, '.env.local'), `DATAFORSEO_PASSWORD=${planted.dotenvPassword}\n`);
    // Ignored and node_modules files must not be scanned in the tree.
    writeFileSync(path.join(dir, 'ignored-secrets.txt'), planted.ignoredToken);
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), `const k = "${planted.ignoredToken}";`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds tree and history-only secrets, exits non-zero, and never prints the values', () => {
    const r = scan(dir, '--json');
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout) as ScanReport;
    expect(report.git.commits).toBe(2);
    expect(report.history?.status).toBe('scanned');

    const tree = report.findings.filter((f) => f.source === 'tree');
    expect(tree.map((f) => `${f.path}:${f.rule}`).sort()).toEqual(['.env.local:dotenv-with-values', '.env.local:secret-assignment', 'src/config.ts:google-api-key']);
    expect(tree.find((f) => f.rule === 'google-api-key')?.line).toBe(1);

    const hist = report.findings.filter((f) => f.source === 'history');
    expect(hist.find((f) => f.rule === 'apify-token')?.path).toBe('old-notes.txt');
    expect(hist.find((f) => f.rule === 'private-key')?.path).toBe('old-key.pem.txt');
    expect(hist.find((f) => f.rule === 'llm-gateway-key')?.path).toMatch(/^\(commit message [0-9a-f]{12}\)$/);
    expect(hist.every((f) => /^[0-9a-f]{40}$/.test(String(f.firstSeenCommit)))).toBe(true);

    // Ignored files and node_modules are not part of the working-tree scan.
    expect(report.findings.some((f) => f.path.includes('ignored-secrets') || f.path.includes('node_modules'))).toBe(false);

    for (const v of Object.values(planted)) {
      const probe = v.includes('BEGIN') ? v.split('\n')[1]!.slice(0, 40) : v;
      expect(r.all, 'secret value printed').not.toContain(probe);
      expect(r.all).not.toContain(probe.slice(-16));
    }
    expect(report.remediation.join(' ')).toMatch(/ROTATE/);
    expect(report.remediation.join(' ')).toMatch(/NOT remediation/);
  });

  it('human output lists findings with fingerprints and requires rotation, without values', () => {
    const r = scan(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FINDINGS: ');
    expect(r.stdout).toMatch(/\[history\] commit [0-9a-f]{10} old-notes\.txt:1 {2}rule=apify-token/);
    expect(r.stdout).toMatch(/fp=[0-9a-f]{16}/);
    expect(r.stdout).toContain('ROTATE every exposed credential');
    expect(r.stdout).toContain('is NOT remediation');
    for (const v of [planted.googleKey, planted.apifyInHistoryOnly, planted.llmKeyInHistoryOnly, planted.dotenvPassword]) expect(r.all).not.toContain(v);
  });

  it('--no-history skips history findings', () => {
    const report = JSON.parse(scan(dir, '--json', '--no-history').stdout) as ScanReport;
    expect(report.history).toBeNull();
    expect(report.findings.every((f) => f.source === 'tree')).toBe(true);
  });

  it('allowlists synthetic markers and fingerprints from an allowlist file', () => {
    const first = JSON.parse(scan(dir, '--json').stdout) as ScanReport;
    const allowFile = path.join(dir, 'allow.json');
    writeFileSync(allowFile, JSON.stringify({ version: 1, fingerprints: first.findings.map((f) => ({ fingerprint: f.fingerprint, reason: 'synthetic test fixture' })) }));
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--json', '--allowlist', allowFile], { encoding: 'utf8', env: GIT_ENV });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as ScanReport;
    expect(report.findings).toEqual([]);
    expect(report.allowlisted.length).toBe(first.findings.length);
  });

  it('works in a repository with no commits yet', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-scan-empty-'));
    try {
      git(empty, 'init', '-q');
      writeFileSync(path.join(empty, 'a.txt'), 'nothing secret here\n');
      const clean = scan(empty, '--json');
      expect(clean.status).toBe(0);
      const report = JSON.parse(clean.stdout) as ScanReport;
      expect(report.history?.status).toBe('no-commits');
      expect(report.tree?.mode).toBe('git');
      writeFileSync(path.join(empty, 'b.txt'), `token ${planted.googleKey}\n`);
      expect(scan(empty).status).toBe(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('scripts/scan-secrets.mjs outside Git', () => {
  it('walks the directory (skipping node_modules/dist) and reports history as not applicable', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-scan-nogit-'));
    try {
      const key = `apify_api_${rand(36)}`;
      writeFileSync(path.join(dir, 'a.txt'), `x ${key}\n`);
      mkdirSync(path.join(dir, 'dist'));
      writeFileSync(path.join(dir, 'dist', 'b.js'), `x ${key}\n`);
      const r = scan(dir, '--json');
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout) as ScanReport;
      expect(report.tree?.mode).toBe('walk');
      expect(report.findings.map((f) => f.path)).toEqual(['a.txt']);
      expect(['not-a-git-repository', 'git-not-available']).toContain(report.history?.status);
      expect(r.all).not.toContain(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on bad arguments', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe.skipIf(!hasGit)('scripts/scan-secrets.mjs history parser and completeness (regressions)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-scan-hist-'));
    git(dir, 'init', '-q');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const historyFindings = (root: string, ...extra: string[]) => {
    const r = scan(root, '--json', ...extra);
    const report = JSON.parse(r.stdout) as ScanReport;
    return { r, report, hist: report.findings.filter((f) => f.source === 'history') };
  };

  it('scans added lines that start with "++ " and later lines of the same hunk', () => {
    const token = `apify_api_${rand(36)}`;
    writeFileSync(path.join(dir, 'notes.txt'), `line one\n++ counter\n+++ also content\nconst t = "${token}";\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add notes');
    git(dir, 'rm', '-q', 'notes.txt');
    git(dir, 'commit', '-q', '-m', 'remove notes');
    const { r, hist } = historyFindings(dir);
    expect(r.status).toBe(1);
    expect(hist.find((f) => f.rule === 'apify-token')).toMatchObject({ path: 'notes.txt', line: 4 });
    expect(r.all).not.toContain(token);
  });

  it('keeps file-name and .env rules working for paths with spaces and quoted paths', () => {
    mkdirSync(path.join(dir, 'deploy dir'));
    writeFileSync(path.join(dir, 'deploy dir', '.env'), `DB_PASSWORD=${rand(18)}\n`);
    writeFileSync(path.join(dir, 'deploy dir', 'id_ed25519'), 'placeholder\n');
    mkdirSync(path.join(dir, 'we"ird dir'));
    writeFileSync(path.join(dir, 'we"ird dir', 'secrets.env'), 'X=\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add deploy files');
    git(dir, 'rm', '-q', '-r', 'deploy dir', 'we"ird dir');
    git(dir, 'commit', '-q', '-m', 'remove deploy files');
    const { hist } = historyFindings(dir);
    const got = hist.map((f) => `${f.path}:${f.rule}`).sort();
    expect(got).toContain('deploy dir/.env:dotenv-with-values');
    expect(got).toContain('deploy dir/id_ed25519:private-key-file');
    expect(got).toContain('we"ird dir/secrets.env:credential-file');
    expect(got.some((g) => g.includes('\t'))).toBe(false);
  });

  it('scans the messages of empty commits and merge commits', () => {
    const inEmpty = `apify_api_${rand(36)}`;
    const inMerge = `llmgtwy_${rand(32)}`;
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'a');
    git(dir, 'commit', '-q', '--allow-empty', '-m', `empty commit ${inEmpty}`);
    git(dir, 'checkout', '-q', '-b', 'side');
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'b');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', `merge side ${inMerge}`, 'side');
    const { report, hist } = historyFindings(dir);
    expect(report.history?.commitsScanned).toBe(report.history?.commitsReachable);
    expect(report.history?.commitsScanned).toBe(4);
    expect(report.history?.complete).toBe(true);
    expect(hist.map((f) => f.rule).sort()).toEqual(['apify-token', 'llm-gateway-key']);
    expect(hist.every((f) => /^\(commit message [0-9a-f]{12}\)$/.test(f.path))).toBe(true);
  });

  it('reports a shallow clone as INCOMPLETE (exit 2), never as clean', () => {
    const token = `apify_api_${rand(36)}`;
    writeFileSync(path.join(dir, 'old.txt'), `${token}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'old');
    git(dir, 'rm', '-q', 'old.txt');
    writeFileSync(path.join(dir, 'new.txt'), 'clean\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'new');
    const clone = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-scan-shallow-'));
    try {
      git(clone, 'clone', '-q', '--depth', '1', `file://${dir}`, 'repo');
      const root = path.join(clone, 'repo');
      const r = scan(root, '--json');
      expect(r.status).toBe(2);
      const report = JSON.parse(r.stdout) as ScanReport;
      expect(report.status).toBe('incomplete');
      expect(report.ok).toBe(false);
      expect(report.history?.shallow).toBe(true);
      expect(report.warnings.join('\n')).toMatch(/SHALLOW CLONE/);
      const human = scan(root);
      expect(human.stdout).toContain('NOT CLEAN');
      expect(human.stdout).not.toContain('No credential patterns found.');
      const accepted = scan(root, '--allow-incomplete-history');
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain('incomplete');
      // The full repository still finds the history-only token.
      expect(scan(dir).status).toBe(1);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('is not blinded by .gitattributes (-diff/binary) and treats NUL-containing files as binary (names only)', () => {
    const token = `apify_api_${rand(36)}`;
    writeFileSync(path.join(dir, '.gitattributes'), '*.lock -diff\n*.txt binary\n');
    writeFileSync(path.join(dir, 'deps.lock'), `resolved https://registry.invalid/x token ${token}\n`);
    writeFileSync(path.join(dir, 'notes.txt'), `note ${`ya29.${rand(60)}`}\n`);
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from(`llmgtwy_${rand(32)}\n`), Buffer.from([0, 1, 2, 0])]));
    writeFileSync(path.join(dir, 'app.sqlite'), Buffer.from([0x53, 0, 0, 0]));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'files');
    git(dir, 'rm', '-q', 'deps.lock', 'notes.txt', 'blob.bin', 'app.sqlite');
    git(dir, 'commit', '-q', '-m', 'remove');
    const { report, hist } = historyFindings(dir);
    const got = hist.map((f) => `${f.path}:${f.rule}`).sort();
    expect(got).toContain('deps.lock:apify-token');
    expect(got).toContain('notes.txt:google-oauth-access-token');
    expect(got).toContain('app.sqlite:database-file');
    expect(got.some((g) => g.startsWith('blob.bin:'))).toBe(false);
    expect(report.history?.skipped.binaryFiles).toBeGreaterThanOrEqual(1);
  });

  it('finds an OpenSSH private key that existed only in history', () => {
    writeFileSync(path.join(dir, 'deploy_key'), opensshEd25519PrivateKey());
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'add key');
    git(dir, 'rm', '-q', 'deploy_key');
    git(dir, 'commit', '-q', '-m', 'remove key');
    // With the REPOSITORY allowlist (the default), not only --no-allowlist.
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--json', '--allowlist', path.join(ROOT, 'scripts', 'secret-scan-allowlist.json')], { encoding: 'utf8', env: GIT_ENV });
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout) as ScanReport;
    expect(report.findings.find((f) => f.rule === 'private-key')).toMatchObject({ source: 'history', path: 'deploy_key' });
  });

  it('refuses to run (exit 2) with an invalid or catch-all allowlist', () => {
    writeFileSync(path.join(dir, 'a.txt'), 'nothing\n');
    for (const bad of [{ version: 1, ignorePaths: ['**'] }, { version: 1, markers: ['e'] }, { version: 1, fingerprints: [{ fingerprint: '0123456789abcdef' }] }]) {
      const file = path.join(dir, 'allow.json');
      writeFileSync(file, JSON.stringify(bad));
      const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--allowlist', file], { encoding: 'utf8', env: GIT_ENV });
      expect(r.status, JSON.stringify(bad)).toBe(2);
      expect(r.stderr).toMatch(/allowlist .* is invalid/);
    }
  });
});

describe('git diff header path parsing', () => {
  it('strips the TAB git appends to names with spaces and unquotes C-style names', () => {
    expect(parseDiffHeaderPath('b/deploy dir/.env\t', 'b/')).toBe('deploy dir/.env');
    expect(parseDiffHeaderPath('/dev/null', 'b/')).toBeNull();
    expect(parseDiffHeaderPath('"b/we\\"ird\\tname.env"', 'b/')).toBe('we"ird\tname.env');
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe('café.txt');
    expect(unquoteGitPath('plain.txt')).toBe('plain.txt');
  });

  it('reads the path from diff --git lines, including names with spaces', () => {
    expect(parseDiffGitLine('diff --git a/deploy dir/.env b/deploy dir/.env')).toBe('deploy dir/.env');
    expect(parseDiffGitLine('diff --git "a/we\\"ird" "b/we\\"ird"')).toBe('we"ird');
    expect(parseDiffGitLine('diff --git a/x b/y')).toBeNull();
  });
});
