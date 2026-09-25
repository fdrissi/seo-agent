import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseItem, ReleaseReport } from '../../../scripts/release-check.mjs';
import { dockerBuildStage, dockerIncluded, parseDockerignore } from '../../../scripts/lib/release-rules.mjs';
import { listMigrationFiles, verifyBuildInfo, writeBuildInfo } from '../../../scripts/write-build-info.mjs';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts', 'release-check.mjs');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const hasGit = spawnSync('git', ['--version']).status === 0;
const HARDENED_GITIGNORE = path.join(ROOT, 'tests', 'fixtures', 'security', 'release', 'gitignore.hardened');
const GIT_IDENTITY = { GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const hasNpm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { shell: process.platform === 'win32' }).status === 0;

function write(dir: string, rel: string, content: string) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}

/** A minimal synthetic project that mirrors this repository's release configuration. */
function makeProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-release-'));
  write(
    dir,
    'package.json',
    JSON.stringify({ name: 'synthetic-release-fixture', version: '0.1.0', private: true, license: 'UNLICENSED', engines: { node: '>=24.0.0' }, files: ['docs/', 'config/sites/example.site.yaml', '.env.example'] }, null, 2),
  );
  for (const f of ['.dockerignore', 'config/sites/example.site.yaml', '.env.example']) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  // A known-good .gitignore (the repository's own file is checked separately and may have holes).
  copyFileSync(HARDENED_GITIGNORE, path.join(dir, '.gitignore'));
  write(dir, 'docs/guide.md', '# Synthetic guide\n');
  write(dir, 'src/cli/main.ts', 'export {};\n');
  write(dir, 'migrations/0001_core.sql', '-- synthetic\n');
  write(dir, 'tsconfig.json', '{}\n');
  write(dir, 'tsconfig.build.json', '{}\n');
  write(dir, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  if (hasGit) spawnSync('git', ['init', '-q'], { cwd: dir, env: ENV });
  return dir;
}

function runCheck(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--json', '--skip-licenses', ...args], { encoding: 'utf8', env: ENV });
  const report = JSON.parse(r.stdout) as ReleaseReport;
  const item = (id: string) => report.items.find((i) => i.id === id) as ReleaseItem | undefined;
  return { status: r.status, report, item, stdout: r.stdout, stderr: r.stderr };
}

describe('scripts/release-check.mjs', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeProject();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!hasNpm)('flags a planted database/workspace file that npm pack would include, using the real npm pack --dry-run', () => {
    write(dir, 'docs/seo-agent.sqlite', 'synthetic database placeholder');
    write(dir, 'docs/workspace.json', JSON.stringify({ formatVersion: 1, kind: 'live', note: 'synthetic' }));
    const { status, report, item } = runCheck(dir);
    expect(status).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.published).toBe(false);
    const pack = item('npm-pack');
    expect(pack?.status).toBe('fail');
    expect(pack?.details.join('\n')).toContain('docs/seo-agent.sqlite: database file');
    expect(pack?.details.join('\n')).toContain('docs/workspace.json: workspace manifest');
    // Read-only: no tarball was produced.
    expect(readdirSync(dir).some((f) => f.endsWith('.tgz'))).toBe(false);
  });

  it('flags a planted workspace file inside an allowlisted Docker directory and private files Git would commit', () => {
    write(dir, 'src/workspace.json', '{"formatVersion":1,"kind":"live"}');
    write(dir, 'src/secrets/secrets.env', 'APIFY_TOKEN=\n');
    const { report, item } = runCheck(dir, '--skip-npm-pack');
    expect(report.ok).toBe(false);
    const docker = item('docker-context');
    expect(docker?.status).toBe('fail');
    expect(docker?.details.join('\n')).toContain('src/workspace.json');
    if (hasGit) {
      const gitItem = item('git-candidates');
      expect(gitItem?.status).toBe('fail');
      expect(gitItem?.details.join('\n')).toContain('src/workspace.json');
    }
  });

  it('accepts an injected pack list and reports private entries', () => {
    const list = path.join(dir, 'pack-list.json');
    writeFileSync(list, JSON.stringify([{ files: [{ path: 'dist/cli/main.js' }, { path: 'seo-agent-workspace/secrets/secrets.env' }, { path: 'vault/my-site/Dashboard.md' }] }]));
    const { item } = runCheck(dir, '--pack-list', list);
    const pack = item('npm-pack');
    expect(pack?.status).toBe('fail');
    expect(pack?.details.some((d) => d.startsWith('seo-agent-workspace/secrets/secrets.env'))).toBe(true);
    expect(pack?.details.some((d) => d.startsWith('vault/my-site/Dashboard.md'))).toBe(true);
  });

  it('keeps real site configs out: ignored ones warn, non-ignored ones fail', () => {
    write(dir, 'config/sites/private-site.yaml', 'site:\n  id: private-site\n');
    const { item } = runCheck(dir, '--skip-npm-pack');
    if (hasGit) expect(item('site-configs-local')?.status).toBe('warn');
    else expect(item('site-configs')?.status).toBe('fail');
  });

  it.skipIf(!hasGit)('fails the secret scan on a planted credential without printing it', () => {
    const key = `apify_api_${randomBytes(27).toString('base64url').replace(/[-_]/g, 'k').slice(0, 36)}`;
    write(dir, 'docs/notes.md', `temporary token ${key}\n`);
    const r = runCheck(dir, '--skip-npm-pack');
    expect(r.item('secret-scan')?.status).toBe('fail');
    expect(r.item('secret-scan')?.title).toContain('ROTATE');
    expect(`${r.stdout}${r.stderr}`).not.toContain(key);
  });

  it.skipIf(!hasNpm)('passes the artifact checks for a clean project and prints the manual owner checklist (human output)', () => {
    const { item, report } = runCheck(dir);
    expect(item('npm-pack')?.status).toBe('pass');
    expect(item('npm-pack-secrets')?.status).toBe('pass');
    expect(item('dockerignore')?.status).toBe('pass');
    expect(item('dockerignore-samples')?.status).toBe('pass');
    expect(item('docker-context')?.status).toBe('pass');
    expect(item('example-config')?.status).toBe('pass');
    expect(item('license')?.status).toBe('warn'); // owner has not selected a license
    expect(report.manualSteps.join('\n')).toMatch(/explicit approval before creating the public repository/);
    if (hasGit) {
      expect(item('gitignore')?.status).toBe('pass');
      expect(item('git-candidates')?.status).toBe('pass');
      expect(item('secret-scan')?.status).toBe('pass');
    }
    const human = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--skip-licenses'], { encoding: 'utf8', env: ENV });
    expect(human.stdout).toContain('[PASS]');
    expect(human.stdout).toContain('Manual owner steps before any public release');
    expect(human.stdout).toContain('Nothing was published, pushed, tagged, or uploaded by this check.');
  });

  it('flags an example config that looks real', () => {
    write(dir, 'config/sites/example.site.yaml', 'site:\n  id: example-site\n  url: https://www.synthetic-shop.local/\n  allowedHostnames: [www.synthetic-shop.local]\ngoogle:\n  ga4PropertyId: "123456789"\n');
    const { item } = runCheck(dir, '--skip-npm-pack');
    const ex = item('example-config');
    expect(ex?.status).toBe('fail');
    expect(ex?.details.join('\n')).toContain('non-reserved hostname');
    expect(ex?.details.join('\n')).toContain('ga4PropertyId');
  });

  it('checks CI workflow hardening', () => {
    write(dir, '.github/workflows/bad.yml', 'on: pull_request_target\njobs:\n  x:\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@v5\n      - run: echo ${{ secrets.PROD_TOKEN }}\n');
    const { item } = runCheck(dir, '--skip-npm-pack');
    const ci = item('ci');
    expect(ci?.status).toBe('fail');
    const text = ci?.details.join('\n') ?? '';
    expect(text).toContain('pull_request_target');
    expect(text).toContain('permissions');
    expect(text).toContain('secrets');
    expect(text).toContain('self-hosted');
    expect(item('ci-pinning')?.status).toBe('warn');
  });
});

describe('scripts/release-check.mjs regressions', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeProject();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!hasGit)('fails when a negation such as `!src/**` after the deny rules re-includes nested private files, naming the pattern', () => {
    writeFileSync(path.join(dir, '.gitignore'), `${readFileSync(HARDENED_GITIGNORE, 'utf8')}\n!src/**\n`);
    const { item } = runCheck(dir, '--skip-npm-pack');
    const gi = item('gitignore');
    expect(gi?.status).toBe('fail');
    const details = gi?.details.join('\n') ?? '';
    expect(details).toContain('src/.env');
    expect(details).toContain('src/local.sqlite');
    expect(details).toContain('src/secrets/secrets.env');
    expect(details).toContain('`!src/**`');
    expect(details).not.toContain('tests/.env');
  });

  it.skipIf(!hasGit)('passes the .gitignore check with the hardened fixture', () => {
    const { item } = runCheck(dir, '--skip-npm-pack');
    expect(item('gitignore')?.status, item('gitignore')?.details.join('; ')).toBe('pass');
    expect(item('gitignore-public')).toBeUndefined();
  });

  it.skipIf(!hasGit)('fails the secret scan item for a shallow clone instead of reporting it clean', () => {
    const env = { ...ENV, ...GIT_IDENTITY };
    const g = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'one');
    write(dir, 'docs/two.md', '# two\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'two');
    const cloneRoot = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-release-shallow-'));
    try {
      g(cloneRoot, 'clone', '-q', '--depth', '1', `file://${dir}`, 'repo');
      const { item, report } = runCheck(path.join(cloneRoot, 'repo'), '--skip-npm-pack');
      const sec = item('secret-scan');
      expect(sec?.status).toBe('fail');
      expect(sec?.title).toContain('INCOMPLETE');
      expect(sec?.details.join('\n')).toMatch(/SHALLOW CLONE/);
      expect(report.ok).toBe(false);
    } finally {
      rmSync(cloneRoot, { recursive: true, force: true });
    }
  });

  it('warns when the container image would not carry THIRD_PARTY_NOTICES.md', () => {
    // Start from an allowlist that does not re-include the notices file.
    write(dir, '.dockerignore', readFileSync(path.join(dir, '.dockerignore'), 'utf8').split('\n').filter((l) => l.trim() !== '!THIRD_PARTY_NOTICES.md').join('\n'));
    write(dir, 'Dockerfile', 'FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY package.json ./\nUSER node\n');
    const missing = runCheck(dir, '--skip-npm-pack').item('docker-notices');
    expect(missing?.status).toBe('warn');
    expect(missing?.details.join('\n')).toContain('!THIRD_PARTY_NOTICES.md');
    write(dir, '.dockerignore', `${readFileSync(path.join(dir, '.dockerignore'), 'utf8')}\n!THIRD_PARTY_NOTICES.md\n`);
    write(dir, 'Dockerfile', 'FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY package.json THIRD_PARTY_NOTICES.m[d] ./\nUSER node\n');
    expect(runCheck(dir, '--skip-npm-pack').item('docker-notices')?.status).toBe('pass');
  });

  it('fails the container fixture check until the build context AND the runtime stage include the synthetic demo fixtures', () => {
    for (const f of ['tests/fixtures/demo/site.yaml', 'tests/fixtures/google/gsc/sites.json', 'tests/fixtures/pipelines/site/index.html']) write(dir, f, '# SYNTHETIC fixture\n');
    write(dir, 'tests/fixtures/README.md', '# SYNTHETIC fixtures\n');
    const base = 'FROM node:24-bookworm-slim AS build\nWORKDIR /app\nCOPY tests/fixtures ./tests/fixtures\nFROM node:24-bookworm-slim AS runtime\nWORKDIR /app\nCOPY package.json THIRD_PARTY_NOTICES.m[d] ./\n';
    // Copied only into the BUILD stage: the runtime image still lacks them.
    write(dir, 'Dockerfile', `${base}USER node\n`);
    let item = runCheck(dir, '--skip-npm-pack').item('docker-fixtures');
    expect(item?.status).toBe('fail');
    expect(item?.details.join('\n')).toMatch(/runtime stage does not copy tests\/fixtures\/demo, tests\/fixtures\/google, tests\/fixtures\/pipelines\/site/);
    // Runtime stage copies them, but .dockerignore keeps them out of the build context.
    write(dir, 'Dockerfile', `${base}COPY tests/fixtures ./tests/fixtures\nUSER node\n`);
    const allowlist = readFileSync(path.join(dir, '.dockerignore'), 'utf8');
    write(dir, '.dockerignore', allowlist.split('\n').filter((l) => l.trim() !== '!tests/fixtures/**').join('\n'));
    item = runCheck(dir, '--skip-npm-pack').item('docker-fixtures');
    expect(item?.status).toBe('fail');
    expect(item?.details.join('\n')).toContain('tests/fixtures/demo: 1 file(s) excluded from the build context');
    // Both in place: pass.
    write(dir, '.dockerignore', allowlist);
    item = runCheck(dir, '--skip-npm-pack').item('docker-fixtures');
    expect(item?.status, item?.details.join('; ')).toBe('pass');
  });

  it('fails the fixture label check for an unlabeled published fixture and accepts markers, header comments, and README labels', () => {
    write(dir, 'tests/fixtures/json/data.json', JSON.stringify({ _synthetic: true, rows: [] }));
    write(dir, 'tests/fixtures/html/page.html', '<!-- SYNTHETIC FIXTURE: fictional page -->\n<p>x</p>\n');
    write(dir, 'tests/fixtures/notes/README.md', '# Synthetic notes\nEvery file here is SYNTHETIC.\n');
    write(dir, 'tests/fixtures/notes/deep/profile.md', '---\nid: p\n---\n# Profile\n');
    write(dir, 'tests/fixtures/unlabeled/questions.md', '---\nid: q\n---\n# Questions\n');
    const bad = runCheck(dir, '--skip-npm-pack').item('fixtures-synthetic');
    expect(bad?.status).toBe('fail');
    expect(bad?.details).toEqual(['tests/fixtures/unlabeled/questions.md']);
    write(dir, 'tests/fixtures/unlabeled/README.md', 'SYNTHETIC test data, not real.\n');
    expect(runCheck(dir, '--skip-npm-pack').item('fixtures-synthetic')?.status).toBe('pass');
  });

  it('fails (does not crash) when the secret-scan allowlist is invalid', () => {
    write(dir, 'scripts/secret-scan-allowlist.json', JSON.stringify({ version: 1, ignorePaths: ['**'] }));
    const { status, item } = runCheck(dir, '--skip-npm-pack');
    expect(status).toBe(1);
    expect(item('secret-scan')?.status).toBe('fail');
    expect(item('secret-scan')?.title).toMatch(/could not run/);
  });
});

describe('scripts/release-check.mjs: packed build output must be stamped and fresh (C1-03)', () => {
  let dir: string;
  let packList: string;
  beforeEach(() => {
    // A temporary application root: the repository's own dist/ is never read.
    dir = makeProject();
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    write(dir, 'package.json', JSON.stringify({ ...pkg, bin: { 'synthetic-cli': 'dist/cli/main.js' }, files: ['dist/', 'migrations/', 'docs/'] }, null, 2));
    write(dir, 'src/core/util.ts', 'export const util = 1;\n');
    write(dir, 'dist/cli/main.js', 'export {};\n');
    write(dir, 'dist/core/util.js', 'export const util = 1;\n');
    packList = path.join(dir, 'pack-list.json');
    writeFileSync(packList, JSON.stringify([{ files: [{ path: 'dist/cli/main.js' }, { path: 'dist/core/util.js' }, { path: 'dist/build-info.json' }, { path: 'migrations/0001_core.sql' }, { path: 'package.json' }] }]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails an unstamped dist/ (plain tsc or left over) and names `npm run build` as the fix', () => {
    const item = runCheck(dir, '--pack-list', packList).item('npm-pack-build');
    expect(item?.status).toBe('fail');
    expect(item?.title).toContain('run `npm run build`');
    expect(item?.details.join('\n')).toMatch(/dist\/ build is unstamped: .*build-info\.json is missing/);
  });

  it('passes a dist/ stamped from these sources, and fails again once src/, migrations/, or the version move on', () => {
    writeBuildInfo(dir, { git: false });
    const ok = runCheck(dir, '--pack-list', packList).item('npm-pack-build');
    expect(ok?.status, ok?.details.join('; ')).toBe('pass');
    expect(ok?.title).toMatch(/fresh, stamped build \(dist\/build-info\.json: v0\.1\.0, 1 migration\(s\)/);

    write(dir, 'migrations/0002_more.sql', '-- synthetic\n');
    write(dir, 'src/core/util.ts', 'export const util = 2;\n');
    const stale = runCheck(dir, '--pack-list', packList).item('npm-pack-build');
    expect(stale?.status).toBe('fail');
    const text = stale?.details.join('\n') ?? '';
    expect(text).toMatch(/dist\/ build is stale: .*src\/ changed since the build/);
    expect(text).toContain('migrations/ has 1 migration(s) the build does not know: 0002_more.sql');
    expect(verifyBuildInfo(dir).state).toBe('stale');
  });

  it('fails when the stamp is not packed, has no migration list, or the package has no build output at all', () => {
    writeBuildInfo(dir, { git: false });
    const noStamp = path.join(dir, 'pack-no-stamp.json');
    writeFileSync(noStamp, JSON.stringify([{ files: [{ path: 'dist/cli/main.js' }] }]));
    expect(runCheck(dir, '--pack-list', noStamp).item('npm-pack-build')?.details.join('\n')).toContain('dist/build-info.json (the build stamp) is not in the package');

    const stampFile = path.join(dir, 'dist', 'build-info.json');
    writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(readFileSync(stampFile, 'utf8')), migrations: null }));
    const nullList = runCheck(dir, '--pack-list', packList).item('npm-pack-build');
    expect(nullList?.status).toBe('fail');
    expect(nullList?.details.join('\n')).toContain('"migrations": null');

    const noDist = path.join(dir, 'pack-no-dist.json');
    writeFileSync(noDist, JSON.stringify([{ files: [{ path: 'package.json' }] }]));
    const missing = runCheck(dir, '--pack-list', noDist).item('npm-pack-build');
    expect(missing?.status).toBe('fail');
    expect(missing?.title).toMatch(/no dist\/ build output although package\.json ships it/);
  });
});

describe('scripts/release-check.mjs: container build stage inputs (NF-01)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeProject();
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    write(dir, 'package.json', JSON.stringify({ ...pkg, scripts: { build: 'tsc -p tsconfig.build.json && node scripts/write-build-info.mjs' } }, null, 2));
    write(dir, 'scripts/write-build-info.mjs', '// synthetic stand-in\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails the pre-fix build stage (no stamp script, no migrations/) and passes the repository layout', () => {
    const stage = 'FROM node:24-bookworm-slim AS build\nWORKDIR /app\nCOPY package.json package-lock.json ./\nCOPY tsconfig.json tsconfig.build.json ./\nCOPY src ./src\n';
    const runtime = 'FROM node:24-bookworm-slim AS runtime\nWORKDIR /app\nCOPY --from=build /app/dist ./dist\nCOPY migrations ./migrations\nUSER node\n';
    write(dir, 'Dockerfile', `${stage}RUN npm run build\n${runtime}`);
    const before = runCheck(dir, '--skip-npm-pack').item('docker-build-inputs');
    expect(before?.status).toBe('fail');
    const text = before?.details.join('\n') ?? '';
    expect(text).toMatch(/scripts\/write-build-info\.mjs \(run by package\.json "build"\) is not copied into the build stage/);
    expect(text).toMatch(/migrations\/ .*is not copied into the build stage/);

    write(dir, 'Dockerfile', `${stage}COPY scripts/write-build-info.mjs ./scripts/write-build-info.mjs\nCOPY migrations ./migrations\nRUN npm run build\n${runtime}`);
    const after = runCheck(dir, '--skip-npm-pack').item('docker-build-inputs');
    expect(after?.status, after?.details.join('; ')).toBe('pass');

    // The repository .dockerignore re-includes only the stamp script from scripts/.
    write(dir, '.dockerignore', readFileSync(path.join(dir, '.dockerignore'), 'utf8').split('\n').filter((l) => l.trim() !== '!scripts/write-build-info.mjs').join('\n'));
    const ignored = runCheck(dir, '--skip-npm-pack').item('docker-build-inputs');
    expect(ignored?.status).toBe('fail');
    expect(ignored?.details.join('\n')).toContain('add "!scripts/write-build-info.mjs"');
  });
});

describe('the Dockerfile build stage can stamp the build (NF-01, simulated without Docker)', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  /** Copy what the build stage's context COPY instructions would put in /app (only files .dockerignore lets into the context). */
  function simulateBuildStage(dockerfileText: string): string {
    const app = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-docker-build-'));
    temps.push(app);
    const rules = parseDockerignore(readFileSync(path.join(ROOT, '.dockerignore'), 'utf8'));
    const stage = dockerBuildStage(dockerfileText);
    expect(stage).not.toBeNull();
    const put = (rel: string, destAbs: string) => {
      if (!dockerIncluded(rules, rel)) return;
      mkdirSync(path.dirname(destAbs), { recursive: true });
      copyFileSync(path.join(ROOT, rel), destAbs);
    };
    for (const c of stage!.copies) {
      const dest = path.join(app, c.dest.replace(/^\/app\/?/, '').replace(/^\.\//, ''));
      const intoDir = c.dest.endsWith('/') || c.sources.length > 1;
      for (const src of c.sources) {
        const abs = path.join(ROOT, src);
        if (!existsSync(abs)) continue;
        if (statSync(abs).isDirectory()) {
          for (const e of readdirSync(abs, { recursive: true, withFileTypes: true }) as Array<{ name: string; parentPath: string; isFile(): boolean }>) {
            if (!e.isFile()) continue;
            const inner = path.relative(abs, path.join(e.parentPath, e.name));
            put(`${src}/${inner.split(path.sep).join('/')}`, path.join(dest, inner));
          }
        } else put(src, intoDir ? path.join(dest, path.basename(src)) : dest);
      }
    }
    return app;
  }

  it('the stamp written in the build stage lists the migrations (never null) and matches the copied sources', () => {
    const app = simulateBuildStage(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'));
    expect(existsSync(path.join(app, 'scripts', 'write-build-info.mjs'))).toBe(true);
    // Stand-in for tsc (only the entry point); --skip-output-check because the other compiled files are not simulated.
    mkdirSync(path.join(app, 'dist', 'cli'), { recursive: true });
    writeFileSync(path.join(app, 'dist', 'cli', 'main.js'), 'export {};\n');
    const out = execFileSync(process.execPath, [path.join(app, 'scripts', 'write-build-info.mjs'), '--skip-output-check'], { cwd: app, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(out).not.toMatch(/WARNING: migrations\/ was not found/);
    const stamp = JSON.parse(readFileSync(path.join(app, 'dist', 'build-info.json'), 'utf8')) as { migrations: string[] | null; srcFiles: number };
    expect(stamp.migrations).not.toBeNull();
    expect(stamp.migrations).toEqual(listMigrationFiles(path.join(ROOT, 'migrations')));
    expect(stamp.srcFiles).toBeGreaterThan(0);
    expect(verifyBuildInfo(app).state).toBe('fresh');
  });

  it('the pre-fix build stage had neither the stamp script nor migrations/', () => {
    const fixLines = ['COPY scripts/write-build-info.mjs ./scripts/write-build-info.mjs', 'COPY migrations ./migrations'];
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    for (const l of fixLines) expect(dockerfile).toContain(l);
    const preFix = dockerfile
      .split('\n')
      .filter((l) => !fixLines.includes(l.trim()))
      .join('\n');
    const app = simulateBuildStage(preFix);
    expect(existsSync(path.join(app, 'scripts', 'write-build-info.mjs'))).toBe(false);
    expect(existsSync(path.join(app, 'migrations'))).toBe(false);
    expect(existsSync(path.join(app, 'src', 'cli', 'main.ts'))).toBe(true);
  });
});

describe('release check on this repository (--no-history --skip-npm-pack)', () => {
  it('has no blocking artifact/leak problems in the release configuration itself', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', ROOT, '--json', '--skip-npm-pack', '--no-history'], { encoding: 'utf8', env: ENV });
    const report = JSON.parse(r.stdout) as ReleaseReport;
    for (const id of ['npm-files', 'dockerignore', 'dockerignore-samples', 'docker-context', 'example-config', 'dockerfile', 'docker-fixtures', 'docker-build-inputs', 'fixtures-synthetic']) {
      const i = report.items.find((x) => x.id === id);
      if (i) expect(i.status, `${id}: ${i.title} ${i.details.join('; ')}`).not.toBe('fail');
    }
    // The container runs the demo (docs/RELEASING.md step 6) and every published fixture is labeled synthetic.
    expect(report.items.find((x) => x.id === 'docker-fixtures')?.status).toBe('pass');
    expect(report.items.find((x) => x.id === 'fixtures-synthetic')?.status).toBe('pass');
    // The build stage has every input `npm run build` needs (NF-01).
    expect(report.items.find((x) => x.id === 'docker-build-inputs')?.status).toBe('pass');
    // --skip-npm-pack: the build-output item never depends on this checkout's own dist/.
    expect(report.items.find((x) => x.id === 'npm-pack-build')).toBeUndefined();
  });
});
