#!/usr/bin/env node
// Secret scan for public release (plain Node ESM, no dependencies).
//
// Scans:
//   1. The working tree. Inside a Git repository the candidate list is
//      `git ls-files -co --exclude-standard` (tracked + untracked, respecting
//      .gitignore). Outside Git it walks the directory, skipping node_modules,
//      dist, .git, and coverage.
//   2. The full Git history: every line ever added in any commit reachable from
//      any ref (`git log -p --all --text`, no pathspec, so empty and merge
//      commits are included), every commit message, and every added file name.
//      Works when the repository has no commits yet. Shallow clones are
//      detected and reported as incomplete instead of clean.
//
// Findings never include the secret value or the source line: only the path,
// line/commit, rule, length, and a short one-way fingerprint.
//
// Exit codes: 0 = no findings, 1 = findings, 2 = scanner error, invalid
// allowlist, or INCOMPLETE history (shallow clone or commits that could not be
// scanned; --allow-incomplete-history turns that into a warning).
//
// Usage: node scripts/scan-secrets.mjs [--root DIR] [--json] [--no-history]
//          [--no-tree] [--allowlist FILE] [--include-unreachable]
//          [--max-bytes N] [--show-allowlisted] [--allow-incomplete-history]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { REMEDIATION, compileAllowlist, scanFileContent, scanPathName, scanText, validateAllowlist } from './lib/secret-rules.mjs';

const WALK_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.vite', '.cache']);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function git(root, args, input) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function gitInfo(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepo: false, gitAvailable: !inside.error, commitCount: 0, topLevel: null, shallow: false };
  }
  const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim() || null;
  const revs = git(root, ['rev-list', '--all', '--count']);
  const commitCount = revs.status === 0 ? Number.parseInt(revs.stdout.trim() || '0', 10) || 0 : 0;
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  return { isRepo: true, gitAvailable: true, commitCount, topLevel: top, shallow };
}

function walk(root, rel = '', out = []) {
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (WALK_SKIP_DIRS.has(e.name)) continue;
      walk(root, r, out);
    } else if (e.isFile() || e.isSymbolicLink()) out.push(r);
  }
  return out;
}

/** Candidate files for the working-tree scan (POSIX-relative to root). */
export function listTreeFiles(root, info = gitInfo(root)) {
  if (info.isRepo) {
    const r = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
    if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr.trim()}`);
    return { mode: 'git', files: r.stdout.split('\0').filter(Boolean) };
  }
  return { mode: 'walk', files: walk(root) };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function scanTree(root, allowlist, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const info = opts.info ?? gitInfo(root);
  const { mode, files } = listTreeFiles(root, info);
  const findings = [];
  const skipped = { binary: 0, large: 0, symlink: 0, unreadable: 0, ignored: 0 };
  let scanned = 0;
  for (const rel of files) {
    const p = rel.split(path.sep).join('/');
    if (allowlist.isIgnoredPath(p)) {
      skipped.ignored++;
      continue;
    }
    findings.push(...scanPathName(p, allowlist).map((f) => ({ ...f, source: 'tree' })));
    const abs = path.join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      skipped.unreadable++; // deleted from the working tree but still tracked
      continue;
    }
    if (st.isSymbolicLink()) {
      skipped.symlink++;
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > maxBytes) {
      skipped.large++;
      continue;
    }
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      skipped.unreadable++;
      continue;
    }
    if (isBinary(buf)) {
      skipped.binary++;
      continue;
    }
    scanned++;
    findings.push(...scanFileContent(p, buf.toString('utf8'), allowlist).map((f) => ({ ...f, source: 'tree' })));
  }
  return { mode, candidates: files.length, scanned, skipped, findings };
}

const COMMIT_MARK = '\u0001SEOAGENT-COMMIT\u0001';
const MSG_END = '\u0001SEOAGENT-END-MSG\u0001';

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undo Git's C-style path quoting ("a/dir\tname", octal escapes for raw bytes). Unquoted input is returned as is. */
export function unquoteGitPath(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      const cp = body.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length - 1;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break;
    if (Object.hasOwn(C_ESCAPES, n)) {
      bytes.push(C_ESCAPES[n]);
      i++;
    } else if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))[0];
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else {
      bytes.push(...Buffer.from(n, 'utf8'));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Path from a `+++ b/path` or `--- a/path` header line. Git appends a TAB when
 * the name contains a space and C-quotes unusual names. Returns null for /dev/null.
 */
export function parseDiffHeaderPath(rest, prefix) {
  let p = rest.endsWith('\t') ? rest.slice(0, -1) : rest;
  if (p === '/dev/null') return null;
  p = unquoteGitPath(p);
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Path from `diff --git a/X b/X` (renames are disabled, so both sides are the same path). */
export function parseDiffGitLine(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest[half] === ' ') {
      const b = unquoteGitPath(rest.slice(half + 1));
      return b.startsWith('b/') ? b.slice(2) : b;
    }
    return null;
  }
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && len > 0 && rest.startsWith('a/') && rest.slice(2, 2 + len) === rest.slice(5 + len) && rest.slice(2 + len, 5 + len) === ' b/') return rest.slice(2, 2 + len);
  return null;
}

/**
 * Stream `git log -p` over all refs and scan every added line, every commit
 * message, and every added file name. Returns deduplicated findings.
 *
 * Parsing is structural: per-file headers are read only between `diff --git`
 * and the first `@@`, and inside a hunk the `@@ -a,b +c,d @@` line counts
 * decide which lines belong to it, so added content that looks like a header
 * ("+++ counter") is still scanned. No pathspec is passed, so empty commits and
 * merges are emitted too; `--text` makes repository .gitattributes (for example
 * `-diff`) unable to hide content, and files containing NUL bytes are treated
 * as binary (name rules only), like the working-tree scan.
 */
export async function scanHistory(root, allowlist, opts = {}) {
  const info = opts.info ?? gitInfo(root);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!info.isRepo) return { status: info.gitAvailable ? 'not-a-git-repository' : 'git-not-available', commits: 0, expectedCommits: 0, complete: false, shallow: false, warnings: [], skipped: { binaryFiles: 0, oversizedFiles: 0 }, findings: [] };
  if (info.commitCount === 0 && !info.shallow) return { status: 'no-commits', commits: 0, expectedCommits: 0, complete: true, shallow: false, warnings: [], skipped: { binaryFiles: 0, oversizedFiles: 0 }, findings: [] };

  const args = [
    '-c',
    'core.quotepath=false',
    '-c',
    'diff.suppressBlankEmpty=false',
    'log',
    '--all',
    ...(opts.includeUnreachable ? ['--reflog'] : []),
    '-p',
    '--root',
    '--text',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-show-signature',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--unified=0',
    '--diff-merges=first-parent',
    `--format=${COMMIT_MARK}%H%n%B%n${MSG_END}`,
  ];
  const child = spawn('git', args, { cwd: root, env: { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat' } });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  const found = new Map();
  const skipped = { binaryFiles: 0, oversizedFiles: 0 };
  let commit = null;
  let commits = 0;
  let state = 'between'; // 'message' | 'header' | 'hunk' | 'between'
  let messageLines = [];
  // Current file: { path, deleted, headerPath, binary, bytes, ignored }
  let file = null;
  let hunk = null; // { lines: string[], map: number[] }
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;

  const record = (list) => {
    for (const f of list) {
      const key = `${f.rule}|${f.path}|${f.fingerprint}`;
      const existing = found.get(key);
      if (existing) {
        existing.commits.add(commit);
        existing.firstSeenCommit = commit; // log is newest-first, so the last one seen is the oldest
        existing.line = f.line;
      } else found.set(key, { ...f, source: 'history', commits: new Set([commit]), firstSeenCommit: commit });
    }
  };
  const flushHunk = () => {
    if (hunk && file && file.path && !file.ignored && !file.binary && hunk.lines.length) record(scanFileContent(file.path, hunk.lines.join('\n'), allowlist, hunk.map));
    hunk = null;
  };
  /** End of a file's header: decide the path and apply file-name rules once. */
  const finishHeader = () => {
    if (!file || file.finished) return;
    file.finished = true;
    file.path = file.deleted ? null : (file.plusPath ?? file.headerPath);
    if (!file.path) return;
    file.ignored = allowlist.isIgnoredPath(file.path);
    if (!file.ignored) record(scanPathName(file.path, allowlist));
  };
  const endFile = () => {
    flushHunk();
    finishHeader();
    if (file && file.binary) skipped.binaryFiles++;
    if (file && file.oversized) skipped.oversizedFiles++;
    file = null;
  };

  const handleStructural = (line) => {
    if (line.startsWith(COMMIT_MARK)) {
      endFile();
      commit = line.slice(COMMIT_MARK.length).trim();
      commits++;
      state = 'message';
      messageLines = [];
      return;
    }
    if (state === 'message') {
      if (line === MSG_END) {
        state = 'between';
        record(scanText(messageLines.join('\n'), `(commit message ${commit ? commit.slice(0, 12) : ''})`, allowlist));
      } else messageLines.push(line);
      return;
    }
    if (line.startsWith('diff --git ')) {
      endFile();
      file = { headerPath: parseDiffGitLine(line), plusPath: null, deleted: false, path: null, binary: false, oversized: false, bytes: 0, ignored: false, finished: false };
      state = 'header';
      return;
    }
    if (state === 'header' && file) {
      if (line.startsWith('+++ ')) {
        const p = parseDiffHeaderPath(line.slice(4), 'b/');
        if (p === null) file.deleted = true;
        else file.plusPath = p;
      } else if (line.startsWith('deleted file mode')) file.deleted = true;
      else if (line.startsWith('Binary files ')) {
        file.binary = true;
        finishHeader();
      } else if (line.startsWith('@@')) {
        finishHeader();
        startHunk(line);
      }
      return;
    }
    if (state === 'between' && file && line.startsWith('@@')) startHunk(line);
    // Anything else between hunks ("\ No newline at end of file", blank separators) is ignored.
  };
  const startHunk = (line) => {
    flushHunk();
    const m = /^@@+ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) {
      state = 'between';
      return;
    }
    oldLeft = m[1] === undefined ? 1 : Number.parseInt(m[1], 10);
    newLine = Number.parseInt(m[2], 10);
    newLeft = m[3] === undefined ? 1 : Number.parseInt(m[3], 10);
    hunk = { lines: [], map: [] };
    state = oldLeft > 0 || newLeft > 0 ? 'hunk' : 'between';
  };

  for await (const line of rl) {
    if (state === 'hunk') {
      const c = line.charAt(0);
      if (c === '+' || c === '-' || c === ' ') {
        if (c === '+') {
          newLeft--;
          if (file && !file.binary && !file.ignored) {
            const content = line.slice(1);
            if (content.includes('\u0000')) {
              file.binary = true; // like the tree scan: NUL bytes mean binary, name rules only
              hunk = { lines: [], map: [] };
            } else if (file.bytes + content.length > maxBytes) {
              file.oversized = true;
            } else {
              file.bytes += content.length + 1;
              hunk.lines.push(content);
              hunk.map.push(newLine);
            }
          }
          newLine++;
        } else if (c === '-') oldLeft--;
        else {
          oldLeft--;
          newLeft--;
          newLine++;
        }
        if (oldLeft <= 0 && newLeft <= 0) {
          flushHunk();
          state = 'between';
        }
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      // Malformed hunk (counts did not match): fall back to structural parsing.
      flushHunk();
      state = 'between';
    }
    handleStructural(line);
  }
  endFile();
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`git log failed (exit ${code}): ${stderr.trim().split('\n')[0] ?? ''}`);

  const warnings = [];
  if (info.shallow) warnings.push('SHALLOW CLONE: Git history is truncated, so commits before the shallow boundary were NOT scanned. Run `git fetch --unshallow` (or clone without --depth) and scan again.');
  if (commits < info.commitCount) warnings.push(`Only ${commits} of ${info.commitCount} commit(s) reachable from refs were scanned.`);
  const complete = !info.shallow && commits >= info.commitCount;
  const findings = [...found.values()].map((f) => ({ ...f, commits: f.commits.size }));
  return { status: 'scanned', commits, expectedCommits: info.commitCount, complete, shallow: !!info.shallow, warnings, skipped, findings };
}

/** Load and VALIDATE an allowlist file. Throws (scanner exit 2) when it is malformed or too permissive. */
export function loadAllowlist(file) {
  if (!file) return compileAllowlist({});
  if (!existsSync(file)) throw new Error(`allowlist file not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`allowlist ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problems = validateAllowlist(raw);
  if (problems.length) throw new Error(`allowlist ${file} is invalid (the scan refuses to run with it):\n  - ${problems.join('\n  - ')}`);
  return compileAllowlist(raw);
}

export function defaultAllowlistPath(root) {
  const inRoot = path.join(root, 'scripts', 'secret-scan-allowlist.json');
  if (existsSync(inRoot)) return inRoot;
  return null;
}

/** Scan tree and/or history. Returns a JSON-serializable report (never contains secret values). */
export async function scanRepository(opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const allowlistFile = opts.allowlist === undefined ? defaultAllowlistPath(root) : opts.allowlist;
  const allowlist = loadAllowlist(allowlistFile);
  const info = gitInfo(root);
  const report = {
    tool: 'seo-agent scan-secrets',
    root,
    git: { isRepository: info.isRepo, gitAvailable: info.gitAvailable, commits: info.commitCount },
    allowlistFile: allowlistFile ? path.relative(root, allowlistFile) || allowlistFile : null,
    tree: null,
    history: null,
    findings: [],
    allowlisted: [],
    warnings: [],
    status: 'clean',
    ok: true,
    remediation: REMEDIATION,
  };
  if (opts.tree !== false) {
    const t = scanTree(root, allowlist, { maxBytes: opts.maxBytes, info });
    report.tree = { mode: t.mode, candidates: t.candidates, scanned: t.scanned, skipped: t.skipped };
    for (const f of t.findings) (f.allowlisted ? report.allowlisted : report.findings).push(f);
  }
  let incomplete = false;
  if (opts.history !== false) {
    const h = await scanHistory(root, allowlist, { info, includeUnreachable: !!opts.includeUnreachable, maxBytes: opts.maxBytes });
    report.history = {
      status: h.status,
      commitsScanned: h.commits,
      commitsReachable: h.expectedCommits,
      complete: h.complete,
      shallow: h.shallow,
      skipped: h.skipped,
      includeUnreachable: !!opts.includeUnreachable,
    };
    report.warnings.push(...h.warnings);
    for (const f of h.findings) (f.allowlisted ? report.allowlisted : report.findings).push(f);
    incomplete = h.status === 'scanned' && !h.complete;
    if (h.status === 'git-not-available') {
      incomplete = true;
      report.warnings.push('git is not installed: Git history was NOT scanned.');
    }
  }
  report.historyIncomplete = incomplete;
  if (report.findings.length) report.status = 'findings';
  else if (incomplete && !opts.allowIncompleteHistory) report.status = 'incomplete';
  else report.status = 'clean';
  report.ok = report.status === 'clean';
  return report;
}

function shortCommit(c) {
  return c ? c.slice(0, 10) : '';
}

export function renderReport(report, opts = {}) {
  const lines = [];
  lines.push('seo-agent secret scan (values are never printed)');
  lines.push(`  root: ${report.root}`);
  lines.push(`  git repository: ${report.git.isRepository ? `yes (${report.git.commits} commit(s))` : report.git.gitAvailable ? 'no' : 'git not available'}`);
  if (report.tree) {
    const s = report.tree.skipped;
    lines.push(`  working tree (${report.tree.mode === 'git' ? 'git ls-files, respects .gitignore' : 'directory walk'}): ${report.tree.scanned} file(s) scanned of ${report.tree.candidates}; skipped binary ${s.binary}, large ${s.large}, symlink ${s.symlink}, unreadable ${s.unreadable}, allowlisted path ${s.ignored}`);
  }
  if (report.history) {
    const h = report.history;
    const statusText = {
      scanned: `${h.commitsScanned} of ${h.commitsReachable} reachable commit(s) scanned across all refs${h.includeUnreachable ? ' and reflog' : ''}${h.complete ? '' : ' (INCOMPLETE)'}${h.skipped && (h.skipped.binaryFiles || h.skipped.oversizedFiles) ? `; binary file diffs ${h.skipped.binaryFiles}, oversized ${h.skipped.oversizedFiles} (names checked only)` : ''}`,
      'no-commits': 'no commits yet (nothing to scan)',
      'not-a-git-repository': 'not a Git repository (history scan not applicable)',
      'git-not-available': 'git is not installed (history NOT scanned)',
    }[report.history.status];
    lines.push(`  history: ${statusText ?? report.history.status}`);
  }
  lines.push(`  allowlisted synthetic matches: ${report.allowlisted.length}${report.allowlistFile ? ` (allowlist: ${report.allowlistFile})` : ''}`);
  for (const w of report.warnings ?? []) lines.push(`  WARNING: ${w}`);
  lines.push('');
  if (report.findings.length === 0) {
    if (report.status === 'incomplete') {
      lines.push('NOT CLEAN: no credential patterns were found in what was scanned, but the Git history scan is INCOMPLETE (see warnings).');
      lines.push('Fetch the full history (git fetch --unshallow) and scan again, or pass --allow-incomplete-history to accept a partial result.');
    } else lines.push(`No credential patterns found.${report.historyIncomplete ? ' (Git history scan incomplete: accepted with --allow-incomplete-history.)' : ''}`);
  } else {
    lines.push(`FINDINGS: ${report.findings.length}`);
    for (const f of report.findings) {
      const where = f.source === 'history' ? `[history] commit ${shortCommit(f.firstSeenCommit)}${f.commits > 1 ? ` (+${f.commits - 1} more)` : ''} ${f.path}${f.line ? `:${f.line}` : ''}` : `[tree]    ${f.path}${f.line ? `:${f.line}` : ''}`;
      lines.push(`  ${where}  rule=${f.rule}  length=${f.length}  fp=${f.fingerprint}`);
    }
    lines.push('');
    lines.push('REQUIRED ACTION:');
    for (const [i, r] of report.remediation.entries()) lines.push(`  ${i + 1}. ${r}`);
  }
  if (opts.showAllowlisted && report.allowlisted.length) {
    lines.push('', 'Allowlisted (synthetic) matches:');
    for (const f of report.allowlisted) lines.push(`  ${f.source === 'history' ? `commit ${shortCommit(f.firstSeenCommit)} ` : ''}${f.path}${f.line ? `:${f.line}` : ''}  rule=${f.rule}  via=${f.allowlisted}  fp=${f.fingerprint}`);
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false, history: true, tree: true, allowlist: undefined, includeUnreachable: false, maxBytes: DEFAULT_MAX_BYTES, showAllowlisted: false, allowIncompleteHistory: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === '--root') opts.root = next();
    else if (a === '--json') opts.json = true;
    else if (a === '--no-history') opts.history = false;
    else if (a === '--no-tree') opts.tree = false;
    else if (a === '--allowlist') opts.allowlist = path.resolve(next());
    else if (a === '--no-allowlist') opts.allowlist = null;
    else if (a === '--include-unreachable') opts.includeUnreachable = true;
    else if (a === '--max-bytes') opts.maxBytes = Number.parseInt(next(), 10);
    else if (a === '--show-allowlisted') opts.showAllowlisted = true;
    else if (a === '--allow-incomplete-history') opts.allowIncompleteHistory = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `Usage: node scripts/scan-secrets.mjs [--root DIR] [--json] [--no-history] [--no-tree]
       [--allowlist FILE | --no-allowlist] [--include-unreachable] [--max-bytes N] [--show-allowlisted]
       [--allow-incomplete-history]
Scans the working tree (respecting .gitignore) and the full Git history for credential patterns.
Never prints secret values. Exit 0 = clean, 1 = findings, 2 = error or incomplete history
(shallow clone / unscanned commits; --allow-incomplete-history accepts a partial history scan).`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const report = await scanRepository(opts);
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${renderReport(report, opts)}\n`);
    process.exitCode = report.status === 'findings' ? 1 : report.status === 'incomplete' ? 2 : 0;
  } catch (err) {
    process.stderr.write(`scan-secrets error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
