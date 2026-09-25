import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILD_STAMP_SCRIPT,
  DOCKER_MUST_EXCLUDE,
  DOCKER_MUST_INCLUDE,
  MUST_IGNORE,
  PUBLIC_SOURCE_DIRS,
  buildScriptInputs,
  dockerBuildInputProblems,
  dockerBuildStage,
  dockerfileInstructions,
  dockerIncluded,
  forbiddenReasons,
  isReservedHostname,
  parseCopyArgs,
  parseDockerignore,
} from '../../../scripts/lib/release-rules.mjs';
import { classifyLicense, copyrightLines, licenseExpression } from '../../../scripts/check-licenses.mjs';

const ROOT = path.resolve(__dirname, '../../..');

describe('forbidden release paths', () => {
  it.each([
    ['.env', 'env-file'],
    ['config/.env.production', 'env-file'],
    ['secrets/secrets.env', 'secrets-file'],
    ['seo-agent-workspace/workspace.json', 'private-workspace'],
    ['docs/workspace.json', 'workspace-manifest'],
    ['data/seo-agent.sqlite', 'database'],
    ['dist/cache.db', 'database'],
    ['data/raw/gsc/x.json', 'raw-data'],
    ['vault/my-site/Dashboard.md', 'vault'],
    ['config/sites/acme.yaml', 'site-config'],
    ['logs/seo-agent.log', 'logs'],
    ['backups/pre-migration.sqlite', 'backups'],
    ['exports/report.csv', 'exports-reports'],
    ['diagnostics/diagnostics-20260924-x.json', 'diagnostics'],
    ['qdrant/collections/a', 'qdrant-storage'],
    ['client_secret_123.json', 'credential-json'],
    ['keys/server.pem', 'private-key-file'],
    ['.npmrc', 'credential-rc'],
    ['specs/INTI.md', 'private-spec'],
  ])('%s is forbidden (%s)', (p, id) => {
    expect(forbiddenReasons(p).map((r) => r.id)).toContain(id);
  });

  it.each(['.env.example', 'config/sites/example.site.yaml', 'config/sites/README.md', 'vault/_template/Templates/x.md', 'dist/cli/main.js', 'dist/security/diagnostics.js', 'docs/ARCHITECTURE.md', 'migrations/0001_core.sql', 'data/README.md', 'exports/README.md', 'tests/fixtures/google/oauth/client-installed.json'])(
    '%s is allowed',
    (p) => {
      expect(forbiddenReasons(p)).toEqual([]);
    },
  );
});

describe('forbidden release paths: no blind spots inside allowlisted directories (regression)', () => {
  it.each([
    ['docs/seo-agent-workspace/config/sites/real.yaml', 'private-workspace'],
    ['docs/seo-agent-workspace/vault/acme/Dashboard.md', 'private-workspace'],
    ['docs/workspace/secrets/google/oauth-client.json', 'secrets-dir'],
    ['src/workspace/vault/acme/n.md', 'private-workspace'],
    ['dist/secrets/google/token-store.bin', 'secrets-dir'],
    ['docs/demo-workspace/reports/weekly.md', 'private-workspace'],
    ['tests/secrets/secrets.env', 'secrets-file'],
    ['./dist/workspace/x.json', 'private-workspace'],
  ])('%s is forbidden (%s)', (p, id) => {
    expect(forbiddenReasons(p).map((r) => r.id)).toContain(id);
  });

  it('still allows source files whose names merely mention secrets or workspaces', () => {
    for (const p of ['src/config/secrets.ts', 'src/config/workspace.ts', 'dist/config/secrets.js', 'docs/WORKSPACE.md', 'tests/unit/config/workspace.test.ts']) expect(forbiddenReasons(p), p).toEqual([]);
  });

  it('allows only test source files in a tests/<kind>/workspace/ area folder; everything else there stays forbidden', () => {
    for (const p of ['tests/integration/workspace/init-cli.test.ts', 'tests/unit/workspace/demo-live-separation.test.ts']) expect(forbiddenReasons(p), p).toEqual([]);
    for (const p of ['tests/integration/workspace/workspace.json', 'tests/integration/workspace/config/sites/real.yaml', 'tests/integration/workspace/notes.md', 'tests/fixtures/workspace/x.test.ts', 'src/workspace/x.test.ts', 'tests/integration/workspace/nested/x.test.ts']) {
      expect(forbiddenReasons(p).map((r) => r.id), p).toContain('private-workspace');
    }
  });

  it('requires .gitignore to cover private files nested in every public directory (critical)', () => {
    for (const dir of PUBLIC_SOURCE_DIRS) {
      for (const f of ['.env', 'local.sqlite', 'secrets/secrets.env']) {
        const sample = MUST_IGNORE.find((m) => m.path === `${dir}/${f}`);
        expect(sample, `${dir}/${f}`).toBeDefined();
        expect(sample?.critical).toBe(true);
      }
    }
  });
});

describe('.dockerignore evaluation (moby semantics)', () => {
  it('treats the repository .dockerignore as an allowlist that excludes private samples and keeps build inputs', () => {
    const rules = parseDockerignore(readFileSync(path.join(ROOT, '.dockerignore'), 'utf8'));
    expect(rules[0]).toMatchObject({ pattern: '*', negate: false });
    for (const p of DOCKER_MUST_EXCLUDE) expect(dockerIncluded(rules, p), p).toBe(false);
    for (const p of DOCKER_MUST_INCLUDE) expect(dockerIncluded(rules, p), p).toBe(true);
  });

  it('last match wins and parent-directory exclusion applies', () => {
    const rules = parseDockerignore('*\n!src/**\nsrc/**/*.sqlite\n');
    expect(dockerIncluded(rules, 'src/a.ts')).toBe(true);
    expect(dockerIncluded(rules, 'src/x/y.sqlite')).toBe(false);
    expect(dockerIncluded(rules, 'data/a.txt')).toBe(false);
    const dirRule = parseDockerignore('secrets\n');
    expect(dockerIncluded(dirRule, 'secrets/secrets.env')).toBe(false);
    expect(dockerIncluded(dirRule, 'src/a.ts')).toBe(true);
  });
});

describe('container build stage inputs (NF-01: `npm run build` in the Dockerfile build stage)', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const dockerignore = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const buildScript = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: { build: string } }).scripts.build;
  /** Repository files at or under `rel` (what release-check lists from the real tree). */
  const repoFiles = (rel: string): string[] => {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) return [];
    if (!statSync(abs).isDirectory()) return [rel];
    return (readdirSync(abs, { recursive: true, withFileTypes: true }) as Array<{ name: string; parentPath: string; isFile(): boolean }>)
      .filter((e) => e.isFile())
      .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
  };
  const check = (dockerfileText: string, ignoreText = dockerignore, script = buildScript) =>
    dockerBuildInputProblems({ dockerfileText, dockerignoreRules: parseDockerignore(ignoreText), buildScript: script, listFiles: repoFiles });
  /** The build stage as it was before the fix: package files, tsconfig, and src/ only. */
  const withoutStampInputs = dockerfile
    .split('\n')
    .filter((l) => !/^COPY (?:scripts\/write-build-info\.mjs|migrations) \.\/(?:scripts|migrations)/.test(l.trim()) || l.includes('--from'))
    .join('\n');

  it('finds the local files package.json "build" runs', () => {
    expect(buildScriptInputs(buildScript)).toEqual(['tsconfig.build.json', BUILD_STAMP_SCRIPT]);
    expect(buildScriptInputs('FOO=1 node --import tsx ./scripts/x.mjs --flag && tsc --project . ; node -e "1"')).toEqual(['scripts/x.mjs', 'tsconfig.json']);
    expect(buildScriptInputs(undefined)).toEqual([]);
  });

  it('the repository Dockerfile and .dockerignore give the build stage every input (script, src/, migrations/)', () => {
    const r = check(dockerfile);
    expect(r.problems).toEqual([]);
    expect(r.stage?.name).toBe('build');
    expect(r.required).toEqual(['tsconfig.build.json', 'scripts/write-build-info.mjs', 'src', 'migrations']);
    // The context really contains the script, and it imports node built-ins only (nothing else to copy).
    expect(dockerIncluded(parseDockerignore(dockerignore), 'scripts/write-build-info.mjs')).toBe(true);
    const imports = [...readFileSync(path.join(ROOT, 'scripts', 'write-build-info.mjs'), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((m) => m!.startsWith('node:'))).toBe(true);
  });

  it('fails a build stage without the stamp script or migrations/ (the pre-fix Dockerfile)', () => {
    expect(withoutStampInputs).not.toContain('COPY scripts/write-build-info.mjs');
    const r = check(withoutStampInputs);
    const text = r.problems.join('\n');
    expect(r.problems).toHaveLength(2);
    expect(text).toMatch(/^scripts\/write-build-info\.mjs \(run by package\.json "build"\) is not copied into the build stage before `RUN npm run build`/m);
    expect(text).toMatch(/^migrations\/ \(listed in dist\/build-info\.json; without it the stamp records "migrations": null.*add "COPY migrations \.\/migrations"/m);
  });

  it('fails when .dockerignore keeps the stamp script out of the build context', () => {
    const ignore = dockerignore.split('\n').filter((l) => l.trim() !== '!scripts/write-build-info.mjs').join('\n');
    const r = check(dockerfile, ignore);
    expect(r.problems).toEqual(['scripts/write-build-info.mjs is excluded from the build context by .dockerignore (e.g. scripts/write-build-info.mjs); add "!scripts/write-build-info.mjs"']);
  });

  it('a COPY after `RUN npm run build`, or in another stage, does not count; `COPY . .` and a parent stage do', () => {
    const base = 'FROM node:24 AS build\nWORKDIR /app\nCOPY package.json package-lock.json tsconfig.json tsconfig.build.json ./\nCOPY src ./src\n';
    const after = check(`${base}RUN npm run build\nCOPY scripts/write-build-info.mjs ./scripts/\nCOPY migrations ./migrations\nFROM node:24 AS runtime\nCOPY scripts/write-build-info.mjs ./\nCOPY migrations ./migrations\n`);
    expect(after.problems.map((p) => p.split(' ')[0])).toEqual(['scripts/write-build-info.mjs', 'migrations/']);
    expect(check('FROM node:24 AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\n').problems).toEqual([]);
    const inherited = 'FROM node:24 AS inputs\nWORKDIR /app\nCOPY scripts/write-build-info.mjs ./scripts/\nCOPY migrations ./migrations\nFROM inputs AS build\nCOPY package.json package-lock.json tsconfig.json tsconfig.build.json ./\nCOPY src ./src\nRUN npm run build\n';
    expect(check(inherited).problems).toEqual([]);
    // No stage runs `npm run build`: nothing to check.
    expect(check('FROM node:24\nCOPY package.json ./\n')).toEqual({ stage: null, required: [], problems: [] });
    // `npm run build` without a "build" script.
    expect(check(dockerfile, dockerignore, '').problems.join('\n')).toMatch(/package\.json has no "build" script/);
  });

  it('flags a build-stage COPY source that .dockerignore excludes ("not found" during docker build)', () => {
    const r = check(dockerfile.replace('COPY src ./src', 'COPY src ./src\nCOPY docs ./docs'));
    expect(r.problems).toEqual([expect.stringMatching(/^Dockerfile line \d+ copies docs, which \.dockerignore excludes from the build context/)]);
  });

  it('parses continuation lines, comments, flags, and the JSON form', () => {
    const ins = dockerfileInstructions('# syntax=docker/dockerfile:1\nFROM a AS b\nCOPY --chown=node:node x \\\n  # a comment\n  y ./\nRUN npm run build\n');
    expect(ins.map((i) => [i.instruction, i.line])).toEqual([['FROM', 2], ['COPY', 3], ['RUN', 6]]);
    expect(parseCopyArgs(ins[1]!.args)).toEqual({ from: null, sources: ['x', 'y'], dest: './' });
    expect(parseCopyArgs('--from=build /app/dist ./dist')).toEqual({ from: 'build', sources: ['app/dist'], dest: './dist' });
    expect(parseCopyArgs('["scripts/a b.mjs", "./scripts/"]')).toEqual({ from: null, sources: ['scripts/a b.mjs'], dest: './scripts/' });
    expect(dockerBuildStage('FROM a AS b\nCOPY --from=x scripts ./scripts\nRUN npm run build\n')?.sources).toEqual([]);
  });
});

describe('reserved hostnames', () => {
  it('accepts example/test/invalid/localhost and rejects real-looking domains', () => {
    for (const h of ['example.com', 'www.example.com', 'shop.example', 'site.test', 'a.invalid', 'localhost', '127.0.0.1']) expect(isReservedHostname(h), h).toBe(true);
    for (const h of ['acme-shop.ee', 'example.com.evil.io', 'mybusiness.com']) expect(isReservedHostname(h), h).toBe(false);
  });
});

describe('license classification', () => {
  it.each([
    ['MIT', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['(MIT OR GPL-3.0)', 'permissive'],
    ['MIT AND GPL-3.0-only', 'strong-copyleft'],
    ['MPL-2.0', 'weak-copyleft'],
    ['LGPL-2.1-or-later', 'weak-copyleft'],
    ['AGPL-3.0-only', 'strong-copyleft'],
    ['Apache-2.0 WITH LLVM-exception', 'permissive'],
    ['UNLICENSED', 'unknown'],
    ['SEE LICENSE IN LICENSE.txt', 'unknown'],
    ['WTFPL-ish', 'unknown'],
    [null, 'missing'],
  ])('%s -> %s', (expr, category) => {
    expect(classifyLicense(expr).category).toBe(category);
  });

  it('reads legacy license fields', () => {
    expect(licenseExpression({ license: { type: 'MIT' } })).toBe('MIT');
    expect(licenseExpression({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)');
    expect(licenseExpression({})).toBeNull();
  });

  it('extracts copyright lines but not license boilerplate', () => {
    const text = 'MIT License\n\nCopyright (c) 2020 Synthetic Author\n\nPermission is hereby granted...\nThe above copyright notice and this permission notice shall be included\n(c) You must retain\nCopyright [yyyy] [name of copyright owner]\n';
    expect(copyrightLines(text)).toEqual(['Copyright (c) 2020 Synthetic Author']);
  });
});
