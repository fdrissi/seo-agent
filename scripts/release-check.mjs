#!/usr/bin/env node
// Public-release readiness check (plain Node ESM, no dependencies). READ-ONLY:
// it never publishes, pushes, tags, uploads, or changes repository settings.
//
// Verifies that private workspaces, credentials, vaults, databases, raw data,
// logs, backups, and .env files cannot enter release artifacts:
//   - package.json "files" allowlist + `npm pack --dry-run --json --ignore-scripts`
//   - the packed build output is stamped (dist/build-info.json) and matches
//     package.json, src/, and migrations/ (verifyBuildInfo in write-build-info.mjs)
//   - .dockerignore allowlist (evaluated against the real directory contents)
//   - the Dockerfile build stage copies every input `npm run build` needs
//   - .gitignore protections (`git check-ignore --no-index`) and files Git would commit
//   - config/sites contains only the synthetic example
//   - every published fixture under tests/fixtures is labeled synthetic
//   - the container image carries the synthetic runtime fixtures (demo, Demo profile)
//   - secret scan of the working tree AND full Git history
//   - dependency licenses and THIRD_PARTY_NOTICES.md freshness
//   - community files, CI workflow hardening, changelog entry
// Prints a checklist, including the manual owner steps that are never automated.
//
// Usage: node scripts/release-check.mjs [--root DIR] [--json] [--strict]
//          [--pack-list FILE | --skip-npm-pack] [--no-history] [--skip-licenses]
// Exit codes: 0 = no blocking problems (and no warnings with --strict), 1 = problems, 2 = error.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLicenses } from './check-licenses.mjs';
import { gitInfo, loadAllowlist, scanRepository } from './scan-secrets.mjs';
import { scanFileContent } from './lib/secret-rules.mjs';
import { verifyBuildInfo } from './write-build-info.mjs';
import {
  DOCKER_MUST_EXCLUDE,
  DOCKER_MUST_INCLUDE,
  DOCKER_RUNTIME_FIXTURES,
  MUST_IGNORE,
  MUST_NOT_IGNORE,
  PUBLIC_SERVICE_HOSTS,
  copySourceCovers,
  dockerBuildInputProblems,
  dockerIncluded,
  fixtureIsLabeled,
  forbiddenReasons,
  isReservedHostname,
  parseDockerignore,
  runtimeStageCopySources,
} from './lib/release-rules.mjs';

const REQUIRED_FILES = [
  'CONTRIBUTING.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'LICENSE-NOTICE.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/RELEASING.md',
  'docs/SECURITY_MODEL.md',
  'docs/DATA_FLOWS.md',
  'docs/UPGRADING.md',
  'docs/PRIVACY.md',
  'docs/COSTS.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
];

/** Paths that should also be excluded from the container context even inside allowlisted directories. */
const DOCKER_DEFENSE_IN_DEPTH = ['src/.env', 'src/local.sqlite', 'src/secrets/secrets.env', 'migrations/.env', 'prompts/.env'];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

class Checklist {
  constructor() {
    this.items = [];
  }
  add(status, id, title, details = []) {
    this.items.push({ status, id, title, details: details.slice(0, 50), moreDetails: Math.max(0, details.length - 50) });
  }
  pass(id, title, details) {
    this.add('pass', id, title, details);
  }
  fail(id, title, details) {
    this.add('fail', id, title, details);
  }
  warn(id, title, details) {
    this.add('warn', id, title, details);
  }
  info(id, title, details) {
    this.add('info', id, title, details);
  }
}

function walkAll(root, skipDirs = new Set(['.git', 'node_modules'])) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const r = stack.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, r), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = r ? `${r}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) stack.push(p);
      } else out.push(p);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------

function checkPackageJson(root, list, state) {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) {
    list.fail('package-json', 'package.json is missing');
    return;
  }
  const pkg = readJson(file);
  state.pkg = pkg;
  if (pkg.private === true) list.pass('npm-private', 'package.json has "private": true, so `npm publish` is refused (remove only with explicit owner approval)');
  else list.warn('npm-private', 'package.json is not private: `npm publish` would work. Publishing requires explicit owner approval (docs/RELEASING.md)');

  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    list.fail('npm-files', 'package.json has no "files" allowlist: npm would pack everything not in .npmignore');
  } else {
    const bad = pkg.files.flatMap((f) => forbiddenReasons(String(f).replace(/^\.\//, '')).map((r) => `${f}: ${r.reason}`));
    if (bad.length) list.fail('npm-files', 'package.json "files" allowlist names private paths', bad);
    else list.pass('npm-files', `package.json "files" allowlist defined (${pkg.files.length} entries, none private)`);
  }

  const licenseFile = readdirSync(root).find((f) => /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(f));
  if (pkg.license === 'UNLICENSED' && !licenseFile) {
    list.warn('license', 'Project license NOT SELECTED (package.json "UNLICENSED" = all rights reserved; no LICENSE file). Owner decision required before public release: see LICENSE-NOTICE.md');
  } else if (licenseFile && (!pkg.license || pkg.license === 'UNLICENSED')) {
    list.fail('license', `${licenseFile} exists but package.json license is "${pkg.license ?? '(none)'}": make them consistent (LICENSE-NOTICE.md)`);
  } else if (!licenseFile && pkg.license && pkg.license !== 'UNLICENSED') {
    list.fail('license', `package.json declares "${pkg.license}" but there is no LICENSE file with the full text`);
  } else list.pass('license', `Project license: ${pkg.license} (${licenseFile})`);
}

function runNpmPack(root) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_loglevel: 'error' },
    shell: process.platform === 'win32',
  });
  if (r.error || r.status !== 0) return { error: (r.error ? r.error.message : (r.stderr || '').trim().split('\n').pop()) || `npm exited ${r.status}` };
  const start = r.stdout.indexOf('[');
  const parsed = JSON.parse(r.stdout.slice(start));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return { files: (entry.files ?? []).map((f) => f.path), size: entry.size ?? null, unpackedSize: entry.unpackedSize ?? null };
}

function checkNpmPack(root, list, state, opts) {
  let pack;
  if (opts.packList) {
    const raw = readJson(opts.packList);
    const entry = Array.isArray(raw) ? raw[0] : raw;
    pack = { files: Array.isArray(entry) ? entry : (entry.files ?? []).map((f) => (typeof f === 'string' ? f : f.path)), source: opts.packList };
  } else if (opts.skipNpmPack) {
    list.warn('npm-pack', 'npm pack --dry-run skipped (--skip-npm-pack): the package file list was NOT verified');
    return;
  } else {
    pack = runNpmPack(root);
    if (pack.error) {
      list.warn('npm-pack', `Could not run \`npm pack --dry-run --json --ignore-scripts\`: ${pack.error}. The package file list was NOT verified`);
      return;
    }
  }
  state.packFiles = pack.files;
  const forbidden = [];
  for (const f of pack.files) for (const r of forbiddenReasons(f)) forbidden.push(`${f}: ${r.reason}`);
  if (forbidden.length) list.fail('npm-pack', `npm pack would include ${forbidden.length} private/forbidden path(s)`, forbidden);
  else list.pass('npm-pack', `npm pack --dry-run: ${pack.files.length} file(s), none private${pack.size ? ` (${pack.size} bytes packed)` : ''}`);

  // Secret-scan the exact packed contents (covers build output that .gitignore hides from the tree scan).
  const allowlistFile = path.join(root, 'scripts', 'secret-scan-allowlist.json');
  let allowlist;
  try {
    allowlist = loadAllowlist(existsSync(allowlistFile) ? allowlistFile : null);
  } catch (err) {
    list.fail('npm-pack-secrets', `Secret-scan allowlist is invalid, so packed contents were NOT scanned: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const hits = [];
  for (const f of pack.files) {
    const abs = path.join(root, f);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) continue;
      for (const h of scanFileContent(f, buf.toString('utf8'), allowlist)) if (!h.allowlisted) hits.push(`${f}:${h.line} rule=${h.rule} fp=${h.fingerprint}`);
    } catch {
      /* file listed by npm but unreadable: ignore */
    }
  }
  if (hits.length) list.fail('npm-pack-secrets', `Packed files contain ${hits.length} credential pattern(s) (values not shown). ROTATE them; deletion is not remediation`, hits);
  else list.pass('npm-pack-secrets', 'Packed file contents contain no credential patterns');

  checkPackedBuild(root, list, state, pack.files);
}

/**
 * The packed build output must be the one `npm run build` made from these
 * sources: dist/build-info.json packed, and its stamp matching package.json,
 * src/, and migrations/ (verifyBuildInfo: the checkBuildFreshness comparison,
 * without trusting the compiled code). An unstamped installed CLI refuses every
 * migration; a stale one runs old code against new migrations.
 */
function checkPackedBuild(root, list, state, packFiles) {
  const pkg = state.pkg ?? {};
  const bin = pkg.bin ? Object.values(typeof pkg.bin === 'string' ? { x: pkg.bin } : pkg.bin) : [];
  const shipsBuild = bin.length > 0 || (Array.isArray(pkg.files) && pkg.files.some((f) => /^(?:\.\/)?dist(?:\/|$)/.test(String(f))));
  const hasDist = packFiles.some((f) => f.startsWith('dist/'));
  const fix = 'run `npm run build` (compiles src/ and stamps dist/build-info.json), then re-run this check';
  if (!hasDist) {
    if (shipsBuild) list.fail('npm-pack-build', `Package contains no dist/ build output although package.json ships it (bin/"files"): the CLI would be missing. Fix: ${fix}`);
    else list.warn('npm-pack-build', 'Package contains no dist/ build output: run `npm run build` before `npm pack` (the CLI bin would be missing)');
    return;
  }
  const problems = [];
  const missing = bin.filter((b) => !packFiles.includes(String(b).replace(/^\.\//, '')));
  if (missing.length) problems.push(`package.json bin target(s) not in the package: ${missing.join(', ')}`);
  if (!packFiles.includes('dist/build-info.json')) problems.push('dist/build-info.json (the build stamp) is not in the package: an installed CLI without it refuses to apply any migration');
  const stamp = verifyBuildInfo(root);
  if (stamp.state !== 'fresh') problems.push(`dist/ build is ${stamp.state.replace('_', ' ')}: ${stamp.reasons.join('; ')}`);
  else if (stamp.info.migrations === null) problems.push('dist/build-info.json has no migration list ("migrations": null; migrations/ was missing at build time), so an installed CLI skips every migration check');
  if (problems.length) list.fail('npm-pack-build', `Package build output is missing, unstamped, or stale. Fix: ${fix}`, problems);
  else list.pass('npm-pack-build', `Package includes the bin entry point and a fresh, stamped build (dist/build-info.json: v${stamp.info.version}, ${stamp.info.migrations.length} migration(s), matches package.json, src/, and migrations/)`);
}

function checkDocker(root, list, state = {}) {
  const ignoreFile = path.join(root, '.dockerignore');
  const dockerfile = path.join(root, 'Dockerfile');
  if (!existsSync(ignoreFile)) {
    if (existsSync(dockerfile)) list.fail('dockerignore', 'Dockerfile exists but .dockerignore is missing: the whole directory (workspaces, .env, databases) would enter the build context');
    else list.info('dockerignore', 'No Dockerfile and no .dockerignore (container build not offered)');
    return;
  }
  const rules = parseDockerignore(readFileSync(ignoreFile, 'utf8'));
  if (!rules.length || rules[0].negate || rules[0].pattern !== '*') list.fail('dockerignore', '.dockerignore must start with "*" (deny everything) followed by "!" allowlist entries');
  else list.pass('dockerignore', `.dockerignore is an allowlist (deny-all first, ${rules.filter((r) => r.negate).length} re-included patterns)`);

  const leaked = DOCKER_MUST_EXCLUDE.filter((p) => dockerIncluded(rules, p));
  if (leaked.length) list.fail('dockerignore-samples', '.dockerignore lets private sample paths into the build context', leaked);
  else list.pass('dockerignore-samples', `.dockerignore excludes all ${DOCKER_MUST_EXCLUDE.length} private sample paths (workspace, secrets, .env, databases, vault, logs, backups)`);

  const needed = DOCKER_MUST_INCLUDE.filter((p) => !dockerIncluded(rules, p));
  if (needed.length) list.warn('dockerignore-build', 'Files the container build needs are excluded from the context', needed);

  const nested = DOCKER_DEFENSE_IN_DEPTH.filter((p) => dockerIncluded(rules, p));
  if (nested.length) {
    list.warn(
      'dockerignore-nested',
      'Defense in depth: a stray .env/database/secrets file placed INSIDE an allowlisted directory would enter the build context. Add trailing deny patterns (last match wins), e.g. **/.env, **/.env.*, **/*.sqlite*, **/*.db, **/secrets/, **/*.pem, **/*.key',
      nested,
    );
  }

  // Evaluate the actual directory contents (the Docker context ignores .gitignore).
  const all = walkAll(root);
  const included = all.filter((p) => dockerIncluded(rules, p));
  const bad = included.flatMap((p) => forbiddenReasons(p).map((r) => `${p}: ${r.reason}`));
  if (bad.length) list.fail('docker-context', `Docker build context would include ${bad.length} private/forbidden file(s)`, bad);
  else list.pass('docker-context', `Docker build context: ${included.length} file(s) of ${all.length} (excluding .git and node_modules), none private`);

  if (existsSync(dockerfile)) {
    const text = readFileSync(dockerfile, 'utf8');
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    // The image redistributes runtime node_modules, so it must carry the third-party notices
    // (several dependencies ship no LICENSE file of their own).
    const noticesInContext = dockerIncluded(rules, 'THIRD_PARTY_NOTICES.md');
    const noticesCopied = lines.some((l) => /^(?:COPY|ADD)\s/i.test(l) && /THIRD_PARTY_NOTICES/.test(l));
    if (noticesInContext && noticesCopied) list.pass('docker-notices', 'Container image includes THIRD_PARTY_NOTICES.md');
    else {
      list.warn(
        'docker-notices',
        'Container image would NOT include THIRD_PARTY_NOTICES.md although it redistributes node_modules. Do not distribute an image until this is fixed',
        [
          ...(noticesInContext ? [] : ['.dockerignore does not re-include THIRD_PARTY_NOTICES.md: add "!THIRD_PARTY_NOTICES.md" (and "!LICENSE*" once a license is chosen)']),
          ...(noticesCopied ? [] : ['Dockerfile runtime stage does not COPY THIRD_PARTY_NOTICES.md']),
        ],
      );
    }
    const issues = [];
    const users = lines.filter((l) => /^USER\s+/i.test(l));
    const lastUser = users.length ? users[users.length - 1].split(/\s+/)[1] : null;
    if (!lastUser || /^(?:root|0)(?::|$)/.test(lastUser)) issues.push('final stage does not switch to a non-root USER');
    for (const l of lines) {
      if (/^(?:ENV|ARG)\s+[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*\S+/i.test(l)) issues.push(`secret-like build variable with a value: ${l.split('=')[0]}=...`);
      if (/^(?:COPY|ADD)\s+.*(?:secrets|\.env(?!\.example)|seo-agent-workspace|\.sqlite|vault\/(?!_template))/i.test(l)) issues.push(`copies a private path: ${l}`);
    }
    if (issues.length) list.fail('dockerfile', 'Dockerfile hardening problems', issues);
    else list.pass('dockerfile', 'Dockerfile runs as a non-root user and copies no private paths or secrets');
    checkDockerFixtures(root, list, rules, text, all);
    checkDockerBuildInputs(list, rules, text, all, state.pkg);
  }
}

/**
 * The build stage (`RUN npm run build`) must have every input the build
 * needs: package.json "build" runs `node scripts/write-build-info.mjs` after
 * tsc, and the stamp lists migrations/. A missing script fails `docker build`;
 * a missing migrations/ yields a stamp with "migrations": null, so the image
 * would skip every build/migration freshness check.
 */
function checkDockerBuildInputs(list, rules, dockerfileText, allFiles, pkg) {
  const buildScript = pkg && pkg.scripts && typeof pkg.scripts.build === 'string' ? pkg.scripts.build : null;
  const listFiles = (p) => allFiles.filter((f) => f === p || f.startsWith(`${p}/`));
  const r = dockerBuildInputProblems({ dockerfileText, dockerignoreRules: rules, buildScript, listFiles });
  if (!r.stage) list.info('docker-build-inputs', 'Dockerfile does not run `npm run build` (no build stage to check)');
  else if (r.problems.length) list.fail('docker-build-inputs', 'Container build stage lacks inputs `npm run build` needs: `docker build` would fail, or the image would carry an incomplete build stamp', r.problems);
  else list.pass('docker-build-inputs', `Container build stage copies every input \`npm run build\` needs before running it (${r.required.map((p) => (/\.[a-z]+$/i.test(p) ? p : `${p}/`)).join(', ')})`);
}

/**
 * `demo` and the Demo profile read SYNTHETIC fixtures at runtime from
 * <app>/tests/fixtures (demo/, google/, pipelines/site/). The image can run
 * them only when the build context includes them AND the runtime stage copies them.
 */
function checkDockerFixtures(root, list, rules, dockerfileText, allFiles) {
  const problems = [];
  for (const dir of DOCKER_RUNTIME_FIXTURES) {
    const present = allFiles.filter((p) => p.startsWith(`${dir}/`));
    const samples = present.length ? present : [`${dir}/README.md`];
    const excluded = samples.filter((p) => !dockerIncluded(rules, p));
    if (excluded.length) problems.push(`${dir}: ${excluded.length} file(s) excluded from the build context by .dockerignore (e.g. ${excluded[0]}); add "!tests/fixtures/**"`);
  }
  const sources = runtimeStageCopySources(dockerfileText);
  const notCopied = DOCKER_RUNTIME_FIXTURES.filter((dir) => !sources.some((src) => copySourceCovers(src, dir)));
  if (notCopied.length) problems.push(`Dockerfile runtime stage does not copy ${notCopied.join(', ')}; add "COPY tests/fixtures ./tests/fixtures" to the final stage`);
  if (problems.length) list.fail('docker-fixtures', 'Container image would not include the SYNTHETIC demo fixtures: `docker run ... demo` and the Demo profile would fail', problems);
  else list.pass('docker-fixtures', `Container build context and runtime stage include the SYNTHETIC runtime fixtures (${DOCKER_RUNTIME_FIXTURES.join(', ')})`);
}

/**
 * Every file under tests/fixtures ships in the npm package (package.json "files")
 * and the container image, so each must be clearly labeled synthetic: a
 * `_synthetic` marker, a SYNTHETIC header comment, or a README mentioning
 * "synthetic" in its directory or an ancestor up to tests/fixtures.
 */
function checkFixtureLabels(root, list) {
  const fixturesRoot = 'tests/fixtures';
  if (!existsSync(path.join(root, fixturesRoot))) {
    list.info('fixtures-synthetic', 'No tests/fixtures directory (no published fixtures to label)');
    return;
  }
  const files = walkAll(path.join(root, fixturesRoot)).map((p) => `${fixturesRoot}/${p}`);
  const readmeCache = new Map();
  const readmeLabel = (dir) => {
    if (!readmeCache.has(dir)) {
      let labeled = false;
      try {
        for (const f of readdirSync(path.join(root, dir))) {
          if (/^readme(?:\.md|\.txt)?$/i.test(f) && /synthetic/i.test(readFileSync(path.join(root, dir, f), 'utf8'))) labeled = true;
        }
      } catch {
        labeled = false;
      }
      readmeCache.set(dir, labeled);
    }
    return readmeCache.get(dir);
  };
  const unlabeled = [];
  for (const f of files) {
    let content = null;
    try {
      const buf = readFileSync(path.join(root, f));
      content = buf.subarray(0, 8000).includes(0) ? null : buf.subarray(0, 1024 * 1024).toString('utf8');
    } catch {
      content = null;
    }
    if (!fixtureIsLabeled(f, content, readmeLabel, fixturesRoot)) unlabeled.push(f);
  }
  if (unlabeled.length) {
    list.fail(
      'fixtures-synthetic',
      `${unlabeled.length} published fixture file(s) are not labeled synthetic. Add "_synthetic": true, a SYNTHETIC header comment, or a README (mentioning "synthetic") in the directory`,
      unlabeled,
    );
  } else list.pass('fixtures-synthetic', `All ${files.length} fixture file(s) under tests/fixtures are labeled synthetic (marker, header comment, or README)`);
}

function gitCheckIgnore(root, paths) {
  const v = gitCheckIgnoreVerbose(root, paths);
  return v ? v.ignored : null;
}

/**
 * `git check-ignore --no-index -v -n`: which sample paths are ignored, and for
 * the ones that are not, which negation pattern (for example `!src/**`)
 * re-included them.
 */
function gitCheckIgnoreVerbose(root, paths) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'check-ignore', '--no-index', '--stdin', '-v', '-n'], { cwd: root, input: paths.join('\n') + '\n', encoding: 'utf8' });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  const ignored = new Set();
  const negatedBy = new Map();
  for (const line of r.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const meta = line.slice(0, tab);
    const p = line.slice(tab + 1);
    if (meta === '::') continue;
    const m = /^(.*):(\d+):(.*)$/.exec(meta);
    if (!m) continue;
    if (m[3].startsWith('!')) negatedBy.set(p, `${m[1]}:${m[2]} \`${m[3]}\``);
    else ignored.add(p);
  }
  return { ignored, negatedBy };
}

function checkGit(root, list, info) {
  if (!existsSync(path.join(root, '.gitignore'))) {
    list.fail('gitignore', '.gitignore is missing');
    return;
  }
  if (!info.isRepo) {
    list.warn('gitignore', 'Not a Git repository: .gitignore protections could not be verified with `git check-ignore` (run inside the repository)');
    return;
  }
  const samples = [...MUST_IGNORE.map((m) => m.path), ...MUST_NOT_IGNORE];
  const verbose = gitCheckIgnoreVerbose(root, samples);
  if (!verbose) {
    list.warn('gitignore', '`git check-ignore` failed; .gitignore protections not verified');
    return;
  }
  const { ignored, negatedBy } = verbose;
  const describe = (p) => (negatedBy.has(p) ? `${p} (re-included by ${negatedBy.get(p)}: move deny rules after the negation or narrow it)` : p);
  const criticalMissing = MUST_IGNORE.filter((m) => m.critical && !ignored.has(m.path)).map((m) => describe(m.path));
  const softMissing = MUST_IGNORE.filter((m) => !m.critical && !ignored.has(m.path)).map((m) => m.path);
  const overIgnored = MUST_NOT_IGNORE.filter((p) => ignored.has(p));
  if (criticalMissing.length) list.fail('gitignore', '.gitignore does not ignore private paths (including ones nested inside public directories)', criticalMissing);
  else list.pass('gitignore', `.gitignore ignores all ${MUST_IGNORE.filter((m) => m.critical).length} critical private sample paths, including ones nested inside public directories`);
  if (softMissing.length) list.warn('gitignore-defense', '.gitignore does not ignore these workspace-style paths (defense in depth; the workspace normally lives outside the repository)', softMissing);
  if (overIgnored.length) list.fail('gitignore-public', '.gitignore hides public files that releases need', overIgnored);

  // Files Git would commit right now (tracked + untracked-not-ignored).
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status === 0) {
    const files = r.stdout.split('\0').filter(Boolean);
    const bad = files.flatMap((p) => forbiddenReasons(p).map((x) => `${p}: ${x.reason}`));
    if (bad.length) list.fail('git-candidates', `Git would commit ${bad.length} private/forbidden file(s) (tracked or not ignored)`, bad);
    else list.pass('git-candidates', `Files Git would commit: ${files.length}, none private`);
  }
}

function checkSiteConfigs(root, list, info) {
  const dir = path.join(root, 'config', 'sites');
  if (!existsSync(dir)) {
    list.warn('site-configs', 'config/sites/ missing (expected only example.site.yaml and README.md)');
    return;
  }
  const extra = readdirSync(dir).filter((f) => !['example.site.yaml', 'README.md'].includes(f));
  if (extra.length) {
    const ignored = info.isRepo ? gitCheckIgnore(root, extra.map((f) => `config/sites/${f}`)) : null;
    const committed = extra.filter((f) => !(ignored && ignored.has(`config/sites/${f}`)));
    if (committed.length) list.fail('site-configs', 'config/sites/ contains non-example files that Git would commit. Real site configuration belongs in the private workspace', committed.map((f) => `config/sites/${f}`));
    const local = extra.filter((f) => ignored && ignored.has(`config/sites/${f}`));
    if (local.length) list.warn('site-configs-local', 'config/sites/ contains ignored non-example files. Move real configuration to <workspace>/config/sites/', local.map((f) => `config/sites/${f}`));
  } else list.pass('site-configs', 'config/sites/ contains only example.site.yaml and README.md');

  const example = path.join(dir, 'example.site.yaml');
  if (!existsSync(example)) {
    list.warn('example-config', 'config/sites/example.site.yaml is missing');
    return;
  }
  const text = readFileSync(example, 'utf8');
  const issues = [];
  const hosts = new Set();
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s"'#:]+)/gi)) hosts.add(m[1]);
  for (const m of text.matchAll(/sc-domain:([a-z0-9.-]+)/gi)) hosts.add(m[1]);
  const allowed = /^allowedHostnames:\s*\[([^\]]*)\]/m.exec(text.replace(/^\s+/gm, ''));
  if (allowed) for (const h of allowed[1].split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean)) hosts.add(h);
  for (const h of hosts) {
    if (!isReservedHostname(h) && !PUBLIC_SERVICE_HOSTS.some((re) => re.test(h))) issues.push(`non-reserved hostname "${h}" (use example.com, *.test, or *.invalid)`);
  }
  const ga4 = /^\s*ga4PropertyId:\s*["']?(\d+)/m.exec(text);
  if (ga4) issues.push('ga4PropertyId has a numeric value; the example must use null');
  if (!/synthetic/i.test(text)) issues.push('example is not labeled as synthetic');
  if (issues.length) list.fail('example-config', 'config/sites/example.site.yaml looks real', issues);
  else list.pass('example-config', 'example.site.yaml is labeled synthetic and uses reserved hostnames only');
}

async function checkSecrets(root, list, opts) {
  let report;
  try {
    report = await scanRepository({ root, history: opts.history !== false });
  } catch (err) {
    list.fail('secret-scan', `Secret scan could not run: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const where = [`tree: ${report.tree ? `${report.tree.scanned} file(s)` : 'skipped'}`, `history: ${report.history ? report.history.status === 'scanned' ? `${report.history.commitsScanned} of ${report.history.commitsReachable} commit(s)` : report.history.status : 'skipped'}`].join(', ');
  if (report.findings.length) {
    list.fail(
      'secret-scan',
      `Secret scan found ${report.findings.length} credential pattern(s) (${where}). ROTATE every exposed credential; deleting it or rewriting history is not remediation`,
      report.findings.map((f) => `${f.source === 'history' ? `history ${String(f.firstSeenCommit).slice(0, 10)} ` : ''}${f.path}${f.line ? `:${f.line}` : ''} rule=${f.rule} fp=${f.fingerprint}`),
    );
  } else if (opts.history === false) list.warn('secret-scan', `Secret scan clean for the working tree, but Git history was NOT scanned (--no-history). ${where}`);
  else if (report.historyIncomplete) {
    list.fail('secret-scan', `Secret scan INCOMPLETE: the Git history could not be fully scanned (${where}). A partial scan is not a clean result`, report.warnings);
  } else list.pass('secret-scan', `Secret scan clean (${where}; ${report.allowlisted.length} synthetic fixture match(es) allowlisted)`);
}

function checkLicenseStep(root, list, opts) {
  if (opts.skipLicenses) {
    list.warn('licenses', 'License check skipped (--skip-licenses)');
    return;
  }
  const r = checkLicenses({ root });
  const errs = r.problems.filter((p) => p.severity === 'error').map((p) => `${p.package}: ${p.reason}`);
  const warns = r.problems.filter((p) => p.severity === 'warning').map((p) => `${p.package}: ${p.reason}`);
  if (errs.length) list.fail('licenses', 'Dependency license problems', errs);
  else list.pass('licenses', `Dependency licenses: ${r.packages.length} installed package(s), no unknown/missing/strong-copyleft runtime licenses`);
  if (warns.length) list.warn('licenses-review', 'Dependency license warnings', warns);
}

function checkCommunity(root, list) {
  const missing = REQUIRED_FILES.filter((f) => !existsSync(path.join(root, f)));
  if (missing.length) list.fail('community-files', 'Required release/community files are missing', missing);
  else list.pass('community-files', `All ${REQUIRED_FILES.length} release/community files present`);
  if (!existsSync(path.join(root, 'README.md'))) list.warn('readme', 'README.md is missing (listed in package.json "files")');
  const placeholders = [];
  const sec = path.join(root, 'SECURITY.md');
  if (existsSync(sec) && /<SECURITY_CONTACT>|OWNER_SECURITY_CONTACT/.test(readFileSync(sec, 'utf8'))) placeholders.push('SECURITY.md: security contact placeholder not filled in');
  const co = path.join(root, '.github', 'CODEOWNERS');
  if (existsSync(co) && /(^|\s)@OWNER(\s|$)/m.test(readFileSync(co, 'utf8'))) placeholders.push('.github/CODEOWNERS: @OWNER placeholder not replaced');
  const cfg = path.join(root, '.github', 'ISSUE_TEMPLATE', 'config.yml');
  if (existsSync(cfg) && /OWNER\/REPO/.test(readFileSync(cfg, 'utf8'))) placeholders.push('.github/ISSUE_TEMPLATE/config.yml: OWNER/REPO placeholder in contact links');
  if (placeholders.length) list.warn('owner-placeholders', 'Owner placeholders must be filled in before the repository is public', placeholders);
}

function checkWorkflows(root, list) {
  const dir = path.join(root, '.github', 'workflows');
  if (!existsSync(dir)) {
    list.warn('ci', 'No .github/workflows directory');
    return;
  }
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const fails = [];
  const warns = [];
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    const code = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    if (/\bpull_request_target\b/.test(code)) fails.push(`${f}: uses pull_request_target (runs untrusted PR code with a write token/secrets)`);
    if (!/^permissions:/m.test(code)) fails.push(`${f}: no top-level least-privilege "permissions:" block`);
    if (/permissions:\s*write-all|:\s*write\b/.test(code)) fails.push(`${f}: grants write permissions`);
    if (/\$\{\{\s*secrets\./.test(code)) fails.push(`${f}: references repository secrets (public CI must use fixtures only)`);
    if (/self-hosted/.test(code)) fails.push(`${f}: uses a self-hosted runner (untrusted contributor code must never run on the owner's machines)`);
    const uses = [...code.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]).filter((u) => !u.startsWith('./'));
    const unpinned = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u));
    if (unpinned.length) warns.push(`${f}: ${unpinned.length} action(s) pinned by tag, not full commit SHA: ${[...new Set(unpinned)].join(', ')} (see docs/RELEASING.md)`);
  }
  if (fails.length) list.fail('ci', 'CI workflow hardening problems', fails);
  else list.pass('ci', `CI workflows (${files.length}): least-privilege permissions, no pull_request_target, no secrets, no self-hosted runners`);
  if (warns.length) list.warn('ci-pinning', 'GitHub Actions are not pinned by full commit SHA', warns);
}

function checkChangelogAndVersions(root, list, state) {
  const cl = path.join(root, 'CHANGELOG.md');
  if (state.pkg && existsSync(cl)) {
    const text = readFileSync(cl, 'utf8');
    const v = state.pkg.version;
    if (new RegExp(`^## \\[${v.replace(/\./g, '\\.')}\\]`, 'm').test(text)) list.pass('changelog', `CHANGELOG.md has an entry for ${v}`);
    else list.warn('changelog', `CHANGELOG.md has no "## [${v}]" entry`);
  }
  const nvmrc = path.join(root, '.nvmrc');
  if (state.pkg && existsSync(nvmrc)) {
    const major = Number.parseInt(readFileSync(nvmrc, 'utf8').trim().replace(/^v/, ''), 10);
    const engines = state.pkg.engines && state.pkg.engines.node;
    const min = engines ? Number.parseInt(String(engines).replace(/[^0-9.]/g, ''), 10) : null;
    if (min !== null && major < min) list.warn('node-version', `.nvmrc (${major}) is older than engines.node (${engines})`);
    else list.pass('node-version', `.nvmrc ${major} satisfies engines.node ${engines ?? '(unset)'}`);
  }
}

export const MANUAL_STEPS = [
  'Owner selected an open-source license and applied it exactly as described in LICENSE-NOTICE.md (never selected automatically).',
  'Owner filled in the SECURITY.md contact and replaced @OWNER in .github/CODEOWNERS and OWNER/REPO in .github/ISSUE_TEMPLATE/config.yml.',
  'Every credential ever reported by the secret scan (tree or history) was ROTATED at its provider.',
  'Reviewed the exact `npm pack --dry-run` file list after `npm run build`.',
  'Built the optional container image and listed its files: docker build -t seo-agent:check . && docker run --rm --entrypoint sh seo-agent:check -c "find /app -type f | sort". The list includes THIRD_PARTY_NOTICES.md and the synthetic tests/fixtures (demo, google, pipelines) and no private paths; `docker run --rm seo-agent:check demo` completes.',
  'GitHub Actions pinned to verified full commit SHAs (docs/RELEASING.md).',
  'CHANGELOG.md entry finalized and version bumped (semver).',
  'Owner gave explicit approval before creating the public repository, pushing, tagging, publishing a package or image, or changing repository visibility.',
];

export async function runReleaseCheck(opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const list = new Checklist();
  const state = {};
  const info = gitInfo(root);
  if (!info.isRepo) list.warn('git', 'Not a Git repository: history scan and .gitignore verification are limited');
  checkPackageJson(root, list, state);
  checkNpmPack(root, list, state, opts);
  checkDocker(root, list, state);
  checkGit(root, list, info);
  checkSiteConfigs(root, list, info);
  checkFixtureLabels(root, list);
  await checkSecrets(root, list, opts);
  checkLicenseStep(root, list, opts);
  checkCommunity(root, list);
  checkWorkflows(root, list);
  checkChangelogAndVersions(root, list, state);
  const failures = list.items.filter((i) => i.status === 'fail').length;
  const warnings = list.items.filter((i) => i.status === 'warn').length;
  return {
    tool: 'seo-agent release-check',
    root,
    readOnly: true,
    published: false,
    items: list.items,
    manualSteps: MANUAL_STEPS,
    failures,
    warnings,
    strict: !!opts.strict,
    ok: failures === 0 && (!opts.strict || warnings === 0),
  };
}

export function renderReleaseReport(r) {
  const tag = { pass: '[PASS]', fail: '[FAIL]', warn: '[WARN]', info: '[INFO]' };
  const lines = ['seo-agent release check (read-only: nothing is built, published, pushed, or uploaded)', `  root: ${r.root}`, ''];
  for (const i of r.items) {
    lines.push(`${tag[i.status]} ${i.title}`);
    for (const d of i.details) lines.push(`         - ${d}`);
    if (i.moreDetails) lines.push(`         - ... and ${i.moreDetails} more (use --json)`);
  }
  lines.push('', 'Manual owner steps before any public release (never automated):');
  // The license step is the only manual step the check can confirm: it is ticked when the 'license' item passed.
  const licenseDone = r.items.some((i) => i.id === 'license' && i.status === 'pass');
  for (const s of r.manualSteps) lines.push(licenseDone && s === MANUAL_STEPS[0] ? `  [x] ${s} (done: ${r.items.find((i) => i.id === 'license').title})` : `  [ ] ${s}`);
  lines.push('', `Result: ${r.ok ? 'OK' : 'NOT READY'} (${r.failures} blocking, ${r.warnings} warning(s)${r.strict ? ', strict mode: warnings block' : ''})`);
  lines.push('Nothing was published, pushed, tagged, or uploaded by this check.');
  return lines.join('\n');
}

function parseArgs(argv) {
  const o = { root: process.cwd(), json: false, strict: false, packList: null, skipNpmPack: false, history: true, skipLicenses: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--pack-list') o.packList = path.resolve(argv[++i]);
    else if (a === '--skip-npm-pack') o.skipNpmPack = true;
    else if (a === '--no-history') o.history = false;
    else if (a === '--skip-licenses') o.skipLicenses = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (o.help) {
    process.stdout.write('Usage: node scripts/release-check.mjs [--root DIR] [--json] [--strict] [--pack-list FILE | --skip-npm-pack] [--no-history] [--skip-licenses]\n');
    return;
  }
  try {
    const r = await runReleaseCheck(o);
    process.stdout.write(`${o.json ? JSON.stringify(r, null, 2) : renderReleaseReport(r)}\n`);
    process.exitCode = r.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`release-check error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
