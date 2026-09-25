// Release-artifact rules shared by scripts/release-check.mjs (plain Node ESM, no dependencies).
// Paths are POSIX-style and relative to the repository root.

/** Paths that must never appear in an npm package, container build context, or Git commit. */
export const FORBIDDEN_RELEASE_PATHS = [
  { id: 'env-file', reason: 'environment file (may contain secrets)', test: (p) => /(?:^|\/)\.env(?:\.[^/]*)?$/i.test(p) && !/(?:^|\/)\.env\.(?:example|sample|template)$/i.test(p) },
  // No directory exemptions: a secrets/ or workspace/ directory nested inside an
  // allowlisted package/container directory (src/, dist/, docs/, tests/) is exactly
  // the blind spot these rules exist for. No legitimate source directory uses these names.
  { id: 'secrets-dir', reason: 'workspace secrets directory', test: (p) => /(?:^|\/)secrets\//.test(p) },
  { id: 'secrets-file', reason: 'workspace secrets file', test: (p) => /(?:^|\/)secrets\.env$/i.test(p) },
  // One narrow exception: TypeScript test SOURCE files directly in a test-area folder named after the
  // `workspace` module (tests/unit/workspace/x.test.ts, tests/integration/workspace/x.test.ts). Anything
  // else under such a folder (data, JSON, nested directories) is still refused.
  { id: 'private-workspace', reason: 'private workspace directory', test: (p) => /(?:^|\/)(?:seo-agent-workspace|demo-workspace|workspace)\//.test(p) && !/^tests\/(?:unit|integration|e2e)\/workspace\/[A-Za-z0-9._-]+\.test\.ts$/.test(p) },
  { id: 'workspace-manifest', reason: 'workspace manifest (marks a private workspace)', test: (p) => /(?:^|\/)workspace\.json$/.test(p) },
  { id: 'database', reason: 'database file (private data)', test: (p) => /\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$/i.test(p) },
  { id: 'raw-data', reason: 'runtime data directory (raw responses, cache)', test: (p) => /^(?:data\/(?!README\.md$)|raw\/|cache\/)/.test(p) || /(?:^|\/)data\/(?:raw|cache)\//.test(p) },
  { id: 'vault', reason: 'private Obsidian vault content', test: (p) => (/^vault\//.test(p) && !/^vault\/(?:_template\/|README\.md$)/.test(p)) || /(?:^|\/)\.obsidian\//.test(p) },
  { id: 'site-config', reason: 'real site configuration (only example.site.yaml is public)', test: (p) => /^config\/sites\//.test(p) && !/^config\/sites\/(?:example\.site\.yaml|README\.md)$/.test(p) },
  { id: 'logs', reason: 'log file or directory', test: (p) => /(?:^|\/)logs\//.test(p) || /\.log$/i.test(p) },
  { id: 'backups', reason: 'backup file or directory', test: (p) => /(?:^|\/)backups?\//.test(p) || /\.(?:bak|backup)$/i.test(p) },
  { id: 'exports-reports', reason: 'generated exports/reports (private data)', test: (p) => /^(?:exports\/(?!README\.md$)|reports\/)/.test(p) },
  { id: 'diagnostics', reason: 'diagnostic bundle (inspect and share manually, never ship)', test: (p) => /(?:^|\/)diagnostics\//.test(p) || /(?:^|\/)diagnostics-\d{4}-[^/]*\.(?:json|md)$/.test(p) },
  { id: 'qdrant-storage', reason: 'Qdrant storage', test: (p) => /(?:^|\/)(?:qdrant|qdrant_storage)\//.test(p) },
  { id: 'credential-json', reason: 'credential JSON file', test: (p) => /(?:^|\/)[^/]*(?:client_secret|service-account|service_account|credentials|token)[^/]*\.json$/i.test(p) && !/^tests\/fixtures\//.test(p) },
  { id: 'private-key-file', reason: 'private key file', test: (p) => /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(p) || /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/.test(p) },
  { id: 'credential-rc', reason: 'credential rc file', test: (p) => /(?:^|\/)(?:\.npmrc|\.netrc|\.pgpass|\.htpasswd)$/.test(p) },
  { id: 'private-spec', reason: 'private build specification', test: (p) => /^specs\//.test(p) },
  { id: 'vcs', reason: 'version-control metadata', test: (p) => /(?:^|\/)\.git\//.test(p) },
  { id: 'test-artifacts', reason: 'browser/test artifacts', test: (p) => /^(?:coverage|playwright-report|test-results)\//.test(p) },
];

/** Normalize a path for rule matching (POSIX separators, no leading ./ or /). */
function normalizeReleasePath(p) {
  return String(p).split('\\').join('/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function forbiddenReasons(p) {
  p = normalizeReleasePath(p);
  return FORBIDDEN_RELEASE_PATHS.filter((r) => r.test(p)).map((r) => ({ id: r.id, reason: r.reason }));
}

/** Directories that are public (allowlisted in package.json / .dockerignore / .gitignore negations). */
export const PUBLIC_SOURCE_DIRS = ['src', 'tests', 'docs', 'migrations', 'prompts', 'scripts', 'vault/_template', 'config/sites'];

function nestedIgnoreSamples() {
  const out = [];
  for (const dir of PUBLIC_SOURCE_DIRS) {
    for (const f of ['.env', '.env.local', 'local.sqlite', 'secrets/secrets.env', 'client_secret_1234.apps.googleusercontent.com.json', 'my-project-service-account.json']) {
      out.push({ path: `${dir}/${f}`, critical: true });
    }
  }
  // Deeper nesting inside test fixtures (a negation such as `!tests/fixtures/**/*.json` must not re-include real credentials under a real-looking name).
  out.push({ path: 'src/config/.env', critical: true }, { path: 'tests/fixtures/x/.env', critical: true }, { path: 'tests/fixtures/x/seo-agent.sqlite', critical: true });
  return out;
}

/** Sample private paths that .gitignore must ignore (critical) or should ignore (defense in depth). */
export const MUST_IGNORE = [
  { path: '.env', critical: true },
  { path: '.env.local', critical: true },
  { path: 'secrets/secrets.env', critical: true },
  { path: 'seo-agent-workspace/workspace.json', critical: true },
  { path: 'workspace/config/sites/my-site.yaml', critical: true },
  { path: 'demo-workspace/data/seo-agent.sqlite', critical: true },
  { path: 'data/seo-agent.sqlite', critical: true },
  { path: 'data/raw/gsc/response.json', critical: true },
  { path: 'vault/my-site/00 Dashboard/Dashboard.md', critical: true },
  { path: 'config/sites/my-site.yaml', critical: true },
  { path: 'exports/report.csv', critical: true },
  { path: 'logs/seo-agent.log', critical: true },
  { path: 'backups/pre-migration-2026-01-01.sqlite', critical: true },
  { path: 'client_secret_1234.apps.googleusercontent.com.json', critical: true },
  { path: 'my-project-service-account.json', critical: true },
  { path: 'google-token.json', critical: true },
  { path: 'node_modules/x/index.js', critical: true },
  { path: 'anything.sqlite', critical: true },
  // Nested samples: negation patterns such as `!src/**` placed after the deny
  // rules re-include private files inside allowlisted directories. Each of these
  // must still be ignored.
  ...nestedIgnoreSamples(),
  { path: 'qdrant_storage/collection/segment', critical: false },
  { path: 'qdrant/collections/x', critical: false },
  { path: 'reports/weekly.md', critical: false },
  { path: 'diagnostics/diagnostics-2026-01-01.json', critical: false },
  { path: 'dist/cli/main.js', critical: false },
  { path: 'specs/INTI.md', critical: false },
];

/** Public paths that must NOT be ignored (or releases would silently lose them). */
export const MUST_NOT_IGNORE = [
  '.env.example',
  'config/sites/example.site.yaml',
  'config/sites/README.md',
  'vault/_template/Templates/x.md',
  'tests/fixtures/security/injection-page.html',
  'tests/fixtures/auth/token.json',
  'src/auth/token-store.ts',
  'docs/ARCHITECTURE.md',
  'migrations/0001_core.sql',
  'scripts/scan-secrets.mjs',
];

// ---------------------------------------------------------------------------
// .dockerignore evaluation (moby/patternmatcher semantics, simplified):
// patterns are relative to the context root, `*` does not cross `/`, `**`
// matches any number of directories, `!` re-includes, the LAST matching pattern
// wins, and a path is excluded when it or any parent directory is excluded.

function dockerGlobToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '\\' && i + 1 < pattern.length) re += `\\${pattern[++i]}`;
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, '^')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function parseDockerignore(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    let pat = negate ? line.slice(1).trim() : line;
    pat = pat.replace(/^\/+/, '').replace(/\/+$/, '').replace(/^\.\//, '');
    if (!pat) continue;
    rules.push({ pattern: pat, negate, re: dockerGlobToRegExp(pat) });
  }
  return rules;
}

/** True when `p` would be sent to the Docker build context. */
export function dockerIncluded(rules, p) {
  const parts = p.split('/');
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  let excluded = false;
  for (const rule of rules) {
    // A pattern matches when it matches the path or any parent directory.
    const matched = candidates.some((c) => rule.re.test(c));
    if (matched) excluded = !rule.negate;
  }
  return !excluded;
}

/** Samples that the .dockerignore allowlist must keep out of the image build context. */
export const DOCKER_MUST_EXCLUDE = [
  '.env',
  '.env.local',
  'secrets/secrets.env',
  'seo-agent-workspace/secrets/secrets.env',
  'data/seo-agent.sqlite',
  'vault/my-site/Dashboard.md',
  'config/sites/my-site.yaml',
  'backups/pre-migration.sqlite',
  'logs/seo-agent.log',
  'exports/report.csv',
  'node_modules/x/index.js',
  '.git/config',
  'specs/INTI.md',
  'client_secret_x.json',
  // Tests are not shipped; only the SYNTHETIC fixtures under tests/fixtures are (the demo reads them at runtime).
  'tests/unit/security/redact.test.ts',
  'tests/fixtures/x/.env',
  'tests/fixtures/x/seo-agent.sqlite',
  'tests/fixtures/x/secrets/secrets.env',
];

/** Files the container build needs (Dockerfile COPY sources). */
export const DOCKER_MUST_INCLUDE = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'src/cli/main.ts',
  'migrations/0001_core.sql',
  // `npm run build` runs it in the build stage (dist/build-info.json).
  'scripts/write-build-info.mjs',
  'tests/fixtures/demo/site.yaml',
];

/**
 * SYNTHETIC fixture directories the application reads at RUNTIME (appDirs.fixtures():
 * `demo` and the Demo profile). The container build context and the Dockerfile runtime
 * stage must both include them, or `docker run ... demo` fails.
 */
export const DOCKER_RUNTIME_FIXTURES = ['tests/fixtures/demo', 'tests/fixtures/google', 'tests/fixtures/pipelines/site'];

/**
 * Parse a Dockerfile's final (runtime) stage and return the source paths of its
 * COPY/ADD instructions, normalized (no leading ./ or /app/, no trailing /).
 */
export function runtimeStageCopySources(dockerfileText) {
  const lines = dockerfileText.split(/\r?\n/).map((l) => l.trim());
  let start = 0;
  lines.forEach((l, i) => {
    if (/^FROM\s/i.test(l)) start = i;
  });
  const out = [];
  for (const l of lines.slice(start)) {
    if (!/^(?:COPY|ADD)\s/i.test(l)) continue;
    const tokens = l.split(/\s+/).slice(1).filter((t) => !t.startsWith('--'));
    if (tokens.length < 2) continue;
    for (const src of tokens.slice(0, -1)) out.push(src.replace(/^\.\//, '').replace(/^\/app\//, '').replace(/\/+$/, ''));
  }
  return out;
}

/** True when a COPY source (a directory) covers `dir` (it is the directory itself or an ancestor). */
export function copySourceCovers(src, dir) {
  return src === dir || dir.startsWith(`${src}/`);
}

// ---------------------------------------------------------------------------
// Dockerfile build stage (`RUN npm run build`) and the inputs the build needs.

/**
 * Dockerfile instructions in order: comments and blank lines dropped, line
 * continuations (`\` at the end of a line) joined. `line` is the 1-based line
 * of the instruction's first line. Heredocs are not interpreted.
 */
export function dockerfileInstructions(text) {
  const out = [];
  let buf = null;
  let start = 0;
  const lines = String(text).split(/\r?\n/);
  const flush = () => {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(buf.trim());
    if (m) out.push({ instruction: m[1].toUpperCase(), args: m[2].trim(), line: start });
    buf = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (buf === null) {
      if (!t || t.startsWith('#')) continue;
      buf = '';
      start = i + 1;
    } else if (t.startsWith('#')) continue; // a comment inside a continued instruction is dropped
    if (t.endsWith('\\')) {
      buf += `${t.slice(0, -1)} `;
      continue;
    }
    buf += t;
    flush();
  }
  if (buf !== null && buf.trim()) flush();
  return out;
}

function normalizeCopySource(src) {
  return src.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '') || '.';
}

/**
 * Parse COPY/ADD arguments (flags such as --from=/--chown=, then sources and a
 * destination; the JSON array form is supported). Null when malformed.
 */
export function parseCopyArgs(args) {
  let rest = String(args).trim();
  let from = null;
  for (;;) {
    const m = /^--([A-Za-z-]+)(?:=(\S*))?\s+/.exec(rest);
    if (!m) break;
    if (m[1].toLowerCase() === 'from') from = m[2] ?? '';
    rest = rest.slice(m[0].length);
  }
  let parts = null;
  if (rest.startsWith('[')) {
    try {
      const j = JSON.parse(rest);
      if (Array.isArray(j) && j.every((p) => typeof p === 'string')) parts = j;
    } catch {
      parts = null;
    }
  }
  parts ??= rest.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { from, sources: parts.slice(0, -1).map(normalizeCopySource), dest: parts[parts.length - 1] };
}

/** Dockerfile stages in order: { index, name (the `AS` name or null), image, instructions } (ARGs before the first FROM are skipped). */
export function dockerfileStages(text) {
  const stages = [];
  for (const ins of dockerfileInstructions(text)) {
    if (ins.instruction === 'FROM') {
      const m = /^(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(ins.args);
      stages.push({ index: stages.length, name: m && m[2] ? m[2] : null, image: m ? m[1] : '', instructions: [] });
    } else if (stages.length) stages[stages.length - 1].instructions.push(ins);
  }
  return stages;
}

const NPM_RUN_BUILD_RE = /\bnpm\s+(?:run|run-script)\s+build(?![\w:.-])/;

/**
 * The container build stage: the first stage with a `RUN npm run build`.
 * `copies` are the COPY/ADD instructions from the BUILD CONTEXT (no --from)
 * that run before it: those of the stage itself before that RUN, and every
 * instruction of the stages it is built FROM (`FROM deps AS build`). A COPY
 * after the RUN, or in another stage, cannot help the build. Null when no
 * stage runs `npm run build`.
 */
export function dockerBuildStage(text) {
  const stages = dockerfileStages(text);
  const byName = new Map(stages.filter((s) => s.name).map((s) => [s.name.toLowerCase(), s]));
  const contextCopies = (instructions) =>
    instructions.flatMap((ins) => {
      if (ins.instruction !== 'COPY' && ins.instruction !== 'ADD') return [];
      const c = parseCopyArgs(ins.args);
      return c && c.from === null ? [{ ...c, line: ins.line }] : [];
    });
  for (const stage of stages) {
    const at = stage.instructions.findIndex((i) => i.instruction === 'RUN' && NPM_RUN_BUILD_RE.test(i.args));
    if (at === -1) continue;
    const inherited = [];
    const seen = new Set([stage]);
    for (let parent = byName.get(stage.image.toLowerCase()); parent && !seen.has(parent) && parent.index < stage.index; parent = byName.get(parent.image.toLowerCase())) {
      seen.add(parent);
      inherited.unshift(...contextCopies(parent.instructions));
    }
    const copies = [...inherited, ...contextCopies(stage.instructions.slice(0, at))];
    return { index: stage.index, name: stage.name, runLine: stage.instructions[at].line, copies, sources: copies.flatMap((c) => c.sources) };
  }
  return null;
}

const NODE_FLAGS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '-C', '--conditions']);

function normalizeScriptPath(p) {
  return String(p).replace(/^["']|["']$/g, '').replace(/^\.\//, '');
}

/**
 * Local files a package.json script runs: the script file of every
 * `node <file>` command and the project file of `tsc -p|--project <file>`
 * (commands split on `&&`, `||`, `;`, and `|`).
 */
export function buildScriptInputs(script) {
  const out = [];
  for (const cmd of String(script ?? '').split(/&&|\|\||;|\|/)) {
    const tokens = cmd.trim().split(/\s+/).filter(Boolean);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift(); // FOO=1 node x.mjs
    const [bin, ...args] = tokens;
    if (bin === 'node') {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-e' || a === '--eval' || a === '-p' || a === '--print') break; // inline code, no file
        if (NODE_FLAGS_WITH_VALUE.has(a)) {
          i++;
          continue;
        }
        if (a.startsWith('-')) continue;
        out.push(normalizeScriptPath(a));
        break;
      }
    } else if (bin === 'tsc') {
      const i = args.findIndex((a) => a === '-p' || a === '--project');
      if (i !== -1 && args[i + 1]) {
        const project = normalizeScriptPath(args[i + 1]);
        out.push(project === '.' || project === '' ? 'tsconfig.json' : project);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * The build-stamp script (`npm run build` runs it after tsc) and what it
 * reads: it hashes src/ and lists migrations/. Without migrations/ the stamp
 * records `"migrations": null` and every build/migration freshness check is
 * skipped for that build.
 */
export const BUILD_STAMP_SCRIPT = 'scripts/write-build-info.mjs';
export const BUILD_STAMP_INPUTS = ['src', 'migrations'];

/** True when a context COPY source covers `p`: the same path, an ancestor directory, the whole context (`.`), or a matching wildcard. */
export function copySourceCoversPath(src, p) {
  if (src === '.') return true;
  if (copySourceCovers(src, p)) return true;
  if (/[*?[]/.test(src)) {
    const re = dockerGlobToRegExp(src);
    const parts = p.split('/');
    return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')));
  }
  return false;
}

/**
 * What the container build stage lacks for `npm run build`. Every local file
 * the package.json "build" script runs (`node <file>`, `tsc -p <file>`) and,
 * when it runs the build-stamp script, src/ and migrations/ must be COPY'd from
 * the build context into the build stage before `RUN npm run build` AND be in
 * the build context (.dockerignore). Every non-wildcard context COPY source of
 * the build stage must be in the context too (otherwise `docker build` fails
 * with "not found").
 *
 * `listFiles(p)` returns the repository files at or under `p` (empty when `p`
 * does not exist). Returns { stage, required, problems } (stage null when no
 * stage runs `npm run build`; problems empty when the stage is complete).
 */
export function dockerBuildInputProblems({ dockerfileText, dockerignoreRules, buildScript, listFiles }) {
  const stage = dockerBuildStage(dockerfileText);
  if (!stage) return { stage: null, required: [], problems: [] };
  const problems = [];
  if (typeof buildScript !== 'string' || !buildScript.trim()) {
    problems.push(`Dockerfile line ${stage.runLine} runs \`npm run build\`, but package.json has no "build" script`);
    return { stage, required: [], problems };
  }
  const files = buildScriptInputs(buildScript);
  const required = files.map((f) => ({ path: f, dir: false, why: 'run by package.json "build"' }));
  if (files.includes(BUILD_STAMP_SCRIPT)) {
    required.push(
      { path: 'src', dir: true, why: 'compiled by tsc and hashed into dist/build-info.json' },
      { path: 'migrations', dir: true, why: 'listed in dist/build-info.json; without it the stamp records "migrations": null and the container skips every migration freshness check' },
    );
  }
  for (const r of required) {
    const label = r.dir ? `${r.path}/` : r.path;
    const present = listFiles(r.path);
    if (!present.length) {
      problems.push(`${label} (${r.why}) does not exist in the repository`);
      continue;
    }
    if (!stage.sources.some((s) => copySourceCoversPath(s, r.path))) {
      problems.push(`${label} (${r.why}) is not copied into the build stage before \`RUN npm run build\` (Dockerfile line ${stage.runLine}); add "COPY ${r.path} ./${r.path}" before that line`);
    }
    const excluded = present.filter((p) => !dockerIncluded(dockerignoreRules, p));
    if (excluded.length) problems.push(`${label} is excluded from the build context by .dockerignore (e.g. ${excluded[0]}); add "!${r.dir ? `${r.path}/**` : r.path}"`);
  }
  const requiredPaths = new Set(required.map((r) => r.path));
  for (const c of stage.copies) {
    for (const src of c.sources) {
      if (src === '.' || /[*?[]/.test(src) || requiredPaths.has(src)) continue;
      const present = listFiles(src);
      if (!present.length) problems.push(`Dockerfile line ${c.line} copies ${src}, which does not exist in the repository`);
      else if (!present.some((p) => dockerIncluded(dockerignoreRules, p))) problems.push(`Dockerfile line ${c.line} copies ${src}, which .dockerignore excludes from the build context ("not found" during docker build)`);
    }
  }
  return { stage, required: required.map((r) => r.path), problems };
}

/**
 * Synthetic-label check for one fixture file (paths relative to the repository root).
 * A file is labeled when its content carries `_synthetic` anywhere or a SYNTHETIC
 * header comment (the word "synthetic" in its first 30 lines), or when a README in
 * its directory or an ancestor up to `tests/fixtures` mentions "synthetic".
 * `readmeLabel(dir)` returns true when that directory has such a README.
 */
export function fixtureIsLabeled(relPath, content, readmeLabel, fixturesRoot = 'tests/fixtures') {
  if (typeof content === 'string') {
    if (/_synthetic/.test(content)) return true;
    if (/synthetic/i.test(content.split('\n').slice(0, 30).join('\n'))) return true;
  }
  let dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  for (;;) {
    if (readmeLabel(dir)) return true;
    if (dir === fixturesRoot || !dir.startsWith(`${fixturesRoot}/`)) return false;
    dir = dir.slice(0, dir.lastIndexOf('/'));
  }
}

/** Reserved/synthetic hostnames acceptable in public examples. */
export function isReservedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    /(?:^|\.)example\.(?:com|org|net)$/.test(h) ||
    /(?:^|\.)(?:example|test|invalid|localhost)$/.test(h) ||
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1'
  );
}

/** Hostnames of well-known public services that may appear in example config/docs. */
export const PUBLIC_SERVICE_HOSTS = [/(?:^|\.)googleapis\.com$/, /(?:^|\.)google\.com$/, /(?:^|\.)llmgateway\.io$/, /(?:^|\.)dataforseo\.com$/, /(?:^|\.)apify\.com$/, /(?:^|\.)qdrant\.tech$/, /(?:^|\.)reddit\.com$/];
