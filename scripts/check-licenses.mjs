#!/usr/bin/env node
// Dependency license check and THIRD_PARTY_NOTICES.md generator (plain Node ESM, no dependencies).
//
// Walks node_modules (direct and transitive, including nested node_modules),
// reads each package.json license field plus LICENSE/LICENCE/COPYING/NOTICE
// files, classifies licenses, and flags unknown, missing, and copyleft
// licenses. package-lock.json decides whether a package is a runtime or
// development-only dependency.
//
// It never contacts the network and never changes the project's own license
// (the notices header states the project's own license, read from package.json + LICENSE).
//
// Usage:
//   node scripts/check-licenses.mjs                 # check; warn if THIRD_PARTY_NOTICES.md is stale
//   node scripts/check-licenses.mjs --write         # (re)generate THIRD_PARTY_NOTICES.md for runtime deps
//   node scripts/check-licenses.mjs --check         # fail if THIRD_PARTY_NOTICES.md is missing or stale
//   options: --root DIR  --json  --strict (warnings fail too)  --out FILE
// Exit codes: 0 = ok, 1 = problems found, 2 = error.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'Unlicense', 'CC0-1.0',
  'BlueOak-1.0.0', 'Zlib', 'BSL-1.0', 'Python-2.0', 'PSF-2.0', 'CC-BY-3.0', 'CC-BY-4.0', 'X11', 'Artistic-2.0',
]);
export const WEAK_COPYLEFT = new Set([
  'MPL-1.1', 'MPL-2.0', 'LGPL-2.0', 'LGPL-2.0-only', 'LGPL-2.0-or-later', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
  'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1', 'CPL-1.0',
]);
export const STRONG_COPYLEFT_RE = /^(?:A?GPL-[0-9.]+(?:-only|-or-later)?|SSPL-1\.0|EUPL-1\.[12]|OSL-3\.0|CC-BY-SA-[0-9.]+|CC-BY-NC(?:-[A-Z]+)*-[0-9.]+|RPL-1\.5|Sleepycat)$/;

const RANK = { permissive: 0, 'weak-copyleft': 1, 'strong-copyleft': 2, unknown: 3, missing: 4 };

function classifyId(id) {
  const clean = id.replace(/\+$/, '');
  if (PERMISSIVE.has(clean)) return 'permissive';
  if (WEAK_COPYLEFT.has(clean)) return 'weak-copyleft';
  if (STRONG_COPYLEFT_RE.test(clean)) return 'strong-copyleft';
  return 'unknown';
}

function tokenize(expr) {
  return expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
}

/** Classify an SPDX expression: OR takes the most permissive option, AND the most restrictive. */
export function classifyLicense(expr) {
  if (expr === null || expr === undefined || String(expr).trim() === '') return { category: 'missing', expression: null };
  const text = String(expr).trim();
  if (/^UNLICENSED$/i.test(text)) return { category: 'unknown', expression: text, note: 'UNLICENSED (proprietary / all rights reserved)' };
  if (/^SEE LICEN[CS]E IN /i.test(text)) return { category: 'unknown', expression: text, note: 'custom license file; review manually' };
  const tokens = tokenize(text);
  let i = 0;
  const parsePrimary = () => {
    const t = tokens[i++];
    if (t === '(') {
      const r = parseOr();
      if (tokens[i] === ')') i++;
      return r;
    }
    let cat = classifyId(t ?? '');
    if (tokens[i] === 'WITH') i += 2; // exceptions (e.g. LLVM-exception) do not make a license more restrictive
    return cat;
  };
  const parseAnd = () => {
    let left = parsePrimary();
    while (tokens[i] === 'AND') {
      i++;
      const right = parsePrimary();
      left = RANK[right] > RANK[left] ? right : left;
    }
    return left;
  };
  const parseOr = () => {
    let left = parseAnd();
    while (tokens[i] === 'OR') {
      i++;
      const right = parseAnd();
      left = RANK[right] < RANK[left] ? right : left;
    }
    return left;
  };
  try {
    const category = parseOr();
    return { category: i < tokens.length ? 'unknown' : category, expression: text };
  } catch {
    return { category: 'unknown', expression: text };
  }
}

/** Normalize package.json license/licenses fields (including legacy object/array forms) to an expression. */
export function licenseExpression(pkg) {
  const l = pkg.license;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((x) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean);
    if (types.length) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
  }
  return null;
}

const LICENSE_FILE_RE = /^(?:licen[cs]e|copying|unlicense)(?:[-_.].*)?$/i;
const NOTICE_FILE_RE = /^notice(?:[-_.].*)?$/i;

function readText(file, max = 512 * 1024) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function repoUrl(pkg) {
  const r = pkg.repository;
  let url = typeof r === 'string' ? r : r && typeof r.url === 'string' ? r.url : null;
  if (!url && typeof pkg.homepage === 'string') url = pkg.homepage;
  if (!url) return null;
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  return url;
}

/** Copyright lines from license/notice texts (MIT/ISC/BSD require preserving them). */
export function copyrightLines(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    const isCopyright =
      (/^(?:Copyright|COPYRIGHT)\s+(?:\(c\)|\(C\)|©|\d{4}|[A-Z])/.test(t) || /^(?:\(c\)|©)\s*\d{4}/i.test(t)) &&
      !/^copyright\s+(?:notice|license|holders?|owner|and\s+license)\b/i.test(t) &&
      !/\[(?:yyyy|name of copyright owner)\]|\{yyyy\}|<year>/i.test(t);
    if (isCopyright && t.length < 300) out.push(t);
  }
  return [...new Set(out)];
}

function listPackageDirs(nodeModules, relBase, out) {
  let entries;
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(path.join(nodeModules, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (!s.isDirectory() && !s.isSymbolicLink()) continue;
        const rel = `${relBase}/${e.name}/${s.name}`;
        out.push(rel);
        listPackageDirs(path.join(nodeModules, e.name, s.name, 'node_modules'), `${rel}/node_modules`, out);
      }
    } else {
      const rel = `${relBase}/${e.name}`;
      out.push(rel);
      listPackageDirs(path.join(nodeModules, e.name, 'node_modules'), `${rel}/node_modules`, out);
    }
  }
  return out;
}

/** Collect installed packages with scope (runtime/dev) from package-lock.json. */
export function collectPackages(root) {
  const lockFile = path.join(root, 'package-lock.json');
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : null;
  const lockPackages = lock && lock.packages ? lock.packages : {};
  const rootPkg = existsSync(path.join(root, 'package.json')) ? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) : {};
  const direct = new Set([...Object.keys(rootPkg.dependencies ?? {}), ...Object.keys(rootPkg.optionalDependencies ?? {})]);
  const directDev = new Set(Object.keys(rootPkg.devDependencies ?? {}));

  const nodeModules = path.join(root, 'node_modules');
  const installed = existsSync(nodeModules) ? listPackageDirs(nodeModules, 'node_modules', []) : [];
  const packages = [];
  const seenPaths = new Set();
  for (const rel of installed) {
    const dir = path.join(root, rel);
    const pkgText = readText(path.join(dir, 'package.json'));
    if (!pkgText) continue;
    let pkg;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    seenPaths.add(rel);
    const entry = lockPackages[rel];
    let scope;
    if (!entry) scope = 'extraneous';
    else if (entry.dev || entry.devOptional) scope = 'dev';
    else scope = entry.optional ? 'runtime-optional' : 'runtime';
    let files = [];
    try {
      files = readdirSync(dir).sort();
    } catch {
      /* ignore */
    }
    const licenseFiles = files.filter((f) => LICENSE_FILE_RE.test(f)).map((f) => ({ name: f, text: readText(path.join(dir, f)) })).filter((f) => f.text !== null);
    const noticeFiles = files.filter((f) => NOTICE_FILE_RE.test(f)).map((f) => ({ name: f, text: readText(path.join(dir, f)) })).filter((f) => f.text !== null);
    const expression = licenseExpression(pkg) ?? (entry && typeof entry.license === 'string' ? entry.license : null);
    const cls = classifyLicense(expression);
    packages.push({
      name: pkg.name,
      version: pkg.version ?? null,
      path: rel,
      scope,
      direct: rel === `node_modules/${pkg.name}` && (direct.has(pkg.name) || directDev.has(pkg.name)),
      license: expression,
      category: expression === null && licenseFiles.length ? 'unknown' : cls.category,
      note: expression === null && licenseFiles.length ? 'no license field; license file present, identify manually' : (cls.note ?? null),
      repository: repoUrl(pkg),
      licenseFiles,
      noticeFiles,
      copyright: [...new Set([...licenseFiles.flatMap((f) => copyrightLines(f.text)), ...noticeFiles.flatMap((f) => copyrightLines(f.text))])],
    });
  }
  const notInstalled = Object.entries(lockPackages)
    .filter(([k]) => k.startsWith('node_modules/') && !seenPaths.has(k))
    .map(([k, v]) => ({ path: k, version: v.version ?? null, license: v.license ?? null, scope: v.dev || v.devOptional ? 'dev' : v.optional ? 'runtime-optional' : 'runtime', optional: !!(v.optional || v.devOptional) }));
  return { root, hasLockfile: !!lock, hasNodeModules: existsSync(nodeModules), packages, notInstalled };
}

/** Evaluate packages into problems with severities. */
export function evaluatePackages(collected) {
  const problems = [];
  if (!collected.hasLockfile) problems.push({ severity: 'error', package: '(project)', reason: 'package-lock.json missing: cannot tell runtime from development dependencies' });
  if (!collected.hasNodeModules) problems.push({ severity: 'error', package: '(project)', reason: 'node_modules missing: run `npm ci --ignore-scripts` first' });
  for (const p of collected.packages) {
    const id = `${p.name}@${p.version}`;
    const runtime = p.scope === 'runtime' || p.scope === 'runtime-optional';
    if (p.scope === 'extraneous') problems.push({ severity: 'warning', package: id, reason: `installed but not in package-lock.json (${p.path}); run npm ci` });
    if (p.category === 'missing') problems.push({ severity: runtime ? 'error' : 'warning', package: id, reason: 'no license declared and no license file found' });
    else if (p.category === 'unknown') problems.push({ severity: runtime ? 'error' : 'warning', package: id, reason: `unrecognized license "${p.license ?? '(none)'}"${p.note ? ` (${p.note})` : ''}; review manually` });
    else if (p.category === 'strong-copyleft') problems.push({ severity: runtime ? 'error' : 'warning', package: id, reason: `strong copyleft license ${p.license}; owner/legal review required before distribution` });
    else if (p.category === 'weak-copyleft') problems.push({ severity: runtime ? 'warning' : 'info', package: id, reason: `weak copyleft license ${p.license}${runtime ? '; file-level obligations apply if modified or distributed' : ' (development-only; not distributed)'}` });
    if (runtime && p.licenseFiles.length === 0 && p.category !== 'missing') {
      problems.push({ severity: 'info', package: id, reason: 'package ships no LICENSE file; the standard SPDX text is referenced in THIRD_PARTY_NOTICES.md' });
    }
  }
  const counts = {};
  for (const p of collected.packages) counts[`${p.scope}:${p.category}`] = (counts[`${p.scope}:${p.category}`] ?? 0) + 1;
  return { problems, counts };
}

function runtimeUnique(packages) {
  const map = new Map();
  for (const p of packages) {
    if (p.scope !== 'runtime' && p.scope !== 'runtime-optional') continue;
    const key = `${p.name}@${p.version}`;
    if (!map.has(key)) map.set(key, p);
  }
  return [...map.values()].sort((a, b) => (a.name === b.name ? String(a.version).localeCompare(String(b.version)) : a.name.localeCompare(b.name)));
}

function fence(text) {
  let f = '~~~~';
  while (text.includes(f)) f += '~';
  return `${f}text\n${text.trimEnd()}\n${f}`;
}

const NOT_COVERED = `**Not covered by any license in this repository.** Whatever license the owner
eventually selects for seo-agent covers only this project's own source code and
documentation. It does not cover, and grants no rights to, third-party services,
APIs, datasets, models, or assets that seo-agent can connect to, including the
Google Search Console, Analytics Data, PageSpeed Insights, and CrUX APIs; LLM
Gateway and the model providers behind it; DataForSEO; Apify and Actor
\`9sHOY9RzPYGjmTHo8\` (and the Reddit content it returns); the Qdrant container
image; Obsidian (a separate proprietary application, not bundled); and the
optional Playwright browsers (not bundled). Each is governed by its own terms of
service, license, and pricing, which every installer must review and accept
independently. Data you collect through those services remains subject to their
terms and to applicable law.`;

/** Deterministic THIRD_PARTY_NOTICES.md content for runtime dependencies. */
export function renderNotices(collected, projectLicense = null) {
  const pkgs = runtimeUnique(collected.packages);
  const setHash = createHash('sha256').update(pkgs.map((p) => `${p.name}@${p.version}:${p.license}`).join('\n')).digest('hex').slice(0, 16);
  const lines = [];
  lines.push('# Third-party notices', '');
  lines.push(`<!-- Generated by scripts/check-licenses.mjs. Do not edit by hand. Regenerate with: npm run licenses:check -- --write -->`);
  lines.push(`<!-- Runtime dependency set fingerprint: ${setHash} -->`, '');
  if (projectLicense?.selected) {
    lines.push(`seo-agent itself is licensed under the ${projectLicense.packageJson} license (see LICENSE). That license covers`);
    lines.push('only this project\'s own code, prompts, documentation, and templates; the packages below keep their own licenses.', '');
  } else {
    lines.push('seo-agent\'s own license has **not yet been selected** by the owner (package.json declares');
    lines.push('`"UNLICENSED"`, meaning all rights reserved until the owner decides). See LICENSE-NOTICE.md.', '');
  }
  lines.push('This file preserves the license notices of the npm packages that seo-agent installs as');
  lines.push('**runtime dependencies** (direct and transitive), as resolved by package-lock.json. It keeps');
  lines.push('copyright lines (required by MIT, ISC, and BSD licenses), NOTICE files (required by');
  lines.push('Apache-2.0 section 4(d)), and the full text of each distinct license file.', '');
  lines.push('Development-only tools (for example TypeScript, Vitest, tsx, and their dependencies) are');
  lines.push('not part of the runtime installation or the container image and are not listed here; run');
  lines.push('`npm run licenses:check -- --json` to see every installed package.', '');
  lines.push(NOT_COVERED, '');
  lines.push(`## Summary (${pkgs.length} runtime packages)`, '');
  lines.push('| Package | Version | License | Direct | Source |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const p of pkgs) lines.push(`| ${p.name} | ${p.version} | ${p.license ?? 'UNKNOWN'} | ${p.direct ? 'yes' : 'no'} | ${p.repository ?? 'n/a'} |`);
  lines.push('');

  // Distinct license texts.
  const texts = new Map();
  for (const p of pkgs) {
    for (const f of p.licenseFiles) {
      const norm = f.text.trim();
      const h = createHash('sha256').update(norm).digest('hex').slice(0, 12);
      if (!texts.has(h)) texts.set(h, { text: norm, users: [] });
      texts.get(h).users.push(`${p.name}@${p.version}`);
    }
  }
  const textIds = new Map([...texts.keys()].map((h, i) => [h, `L${String(i + 1).padStart(2, '0')}`]));

  lines.push('## Package notices', '');
  for (const p of pkgs) {
    lines.push(`### ${p.name}@${p.version}`, '');
    lines.push(`- License: ${p.license ?? 'UNKNOWN'}`);
    if (p.repository) lines.push(`- Source: ${p.repository}`);
    if (p.licenseFiles.length) {
      const refs = p.licenseFiles.map((f) => {
        const h = createHash('sha256').update(f.text.trim()).digest('hex').slice(0, 12);
        return `${f.name} (text ${textIds.get(h)})`;
      });
      lines.push(`- License file(s): ${refs.join(', ')}`);
    } else {
      lines.push(`- License file: none shipped in the package. Standard text: https://spdx.org/licenses/${encodeURIComponent((p.license ?? '').replace(/[()]/g, '').split(/\s+/)[0] ?? '')}.html`);
    }
    if (p.copyright.length) {
      lines.push('- Copyright:');
      for (const c of p.copyright) lines.push(`  - ${c.replace(/\|/g, '\\|')}`);
    }
    for (const n of p.noticeFiles) {
      lines.push('', `NOTICE (${n.name}, verbatim):`, '', fence(n.text));
    }
    lines.push('');
  }

  lines.push('## License texts', '');
  for (const [h, entry] of texts) {
    lines.push(`### ${textIds.get(h)}`, '', `Used by: ${entry.users.join(', ')}`, '', fence(entry.text), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function checkLicenses(opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const collected = collectPackages(root);
  const evaluation = evaluatePackages(collected);
  const noticesFile = opts.out ? path.resolve(opts.out) : path.join(root, 'THIRD_PARTY_NOTICES.md');
  const expected = collected.hasNodeModules ? renderNotices(collected, readProjectLicense(root)) : null;
  const current = existsSync(noticesFile) ? readFileSync(noticesFile, 'utf8').replace(/\r\n/g, '\n') : null;
  const notices = { file: noticesFile, exists: current !== null, upToDate: expected !== null && current === expected, written: false };
  if (opts.write && expected !== null) {
    writeFileSync(noticesFile, expected);
    notices.written = true;
    notices.exists = true;
    notices.upToDate = true;
  }
  const problems = [...evaluation.problems];
  if (!notices.upToDate && expected !== null) {
    problems.push({
      severity: opts.check ? 'error' : 'warning',
      package: '(notices)',
      reason: notices.exists ? `${path.basename(noticesFile)} is stale; run: npm run licenses:check -- --write` : `${path.basename(noticesFile)} is missing; run: npm run licenses:check -- --write`,
    });
  }
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  const ok = errors === 0 && (!opts.strict || warnings === 0);
  const pkgSummary = collected.packages.map(({ licenseFiles, noticeFiles, copyright, ...rest }) => ({ ...rest, licenseFiles: licenseFiles.map((f) => f.name), noticeFiles: noticeFiles.map((f) => f.name) }));
  return {
    tool: 'seo-agent check-licenses',
    root,
    projectLicense: readProjectLicense(root),
    packages: pkgSummary,
    notInstalledLockEntries: collected.notInstalled.length,
    counts: evaluation.counts,
    problems,
    notices: { ...notices, file: path.relative(root, noticesFile) || noticesFile },
    errors,
    warnings,
    ok,
  };
}

function readProjectLicense(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const hasLicenseFile = readdirSync(root).some((f) => /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(f));
    return { packageJson: pkg.license ?? null, licenseFile: hasLicenseFile, selected: !!pkg.license && pkg.license !== 'UNLICENSED' && hasLicenseFile };
  } catch {
    return { packageJson: null, licenseFile: false, selected: false };
  }
}

export function renderLicenseReport(r) {
  const lines = ['seo-agent dependency license check (offline; reads node_modules and package-lock.json)'];
  const runtime = r.packages.filter((p) => p.scope === 'runtime' || p.scope === 'runtime-optional').length;
  const dev = r.packages.filter((p) => p.scope === 'dev').length;
  lines.push(`  installed packages: ${r.packages.length} (runtime ${runtime}, dev-only ${dev}, extraneous ${r.packages.filter((p) => p.scope === 'extraneous').length}); lockfile entries not installed on this platform: ${r.notInstalledLockEntries}`);
  const cats = {};
  for (const p of r.packages) cats[p.category] = (cats[p.category] ?? 0) + 1;
  lines.push(`  categories: ${Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  lines.push(`  project license: ${r.projectLicense.selected ? r.projectLicense.packageJson : `NOT SELECTED (package.json "${r.projectLicense.packageJson ?? 'none'}", LICENSE file ${r.projectLicense.licenseFile ? 'present' : 'absent'}); owner decision pending, see LICENSE-NOTICE.md`}`);
  lines.push(`  ${r.notices.file}: ${r.notices.written ? 'written' : r.notices.upToDate ? 'up to date' : r.notices.exists ? 'STALE' : 'MISSING'}`);
  const shown = r.problems.filter((p) => p.severity !== 'info');
  if (shown.length) {
    lines.push('', 'Problems:');
    for (const p of shown) lines.push(`  [${p.severity.toUpperCase()}] ${p.package}: ${p.reason}`);
  }
  const infos = r.problems.filter((p) => p.severity === 'info').length;
  if (infos) lines.push(`  (${infos} informational note(s); see --json)`);
  lines.push('', `The project license${r.projectLicense.selected ? ` (${r.projectLicense.packageJson})` : ' (once selected)'} does not cover third-party services, APIs, datasets, models, or assets.`);
  lines.push(`Result: ${r.ok ? 'OK' : 'PROBLEMS FOUND'} (${r.errors} error(s), ${r.warnings} warning(s))`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const o = { root: process.cwd(), json: false, write: false, check: false, strict: false, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--write') o.write = true;
    else if (a === '--check') o.check = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--out') o.out = argv[++i];
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
    process.stdout.write('Usage: node scripts/check-licenses.mjs [--root DIR] [--json] [--write] [--check] [--strict] [--out FILE]\n');
    return;
  }
  try {
    const r = checkLicenses(o);
    process.stdout.write(`${o.json ? JSON.stringify(r, null, 2) : renderLicenseReport(r)}\n`);
    process.exitCode = r.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`check-licenses error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
