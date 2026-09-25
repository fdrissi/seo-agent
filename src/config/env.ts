import { existsSync, readFileSync, statSync } from 'node:fs';

/**
 * Environment variables recognised by the application (see .env.example).
 * Public per-site IDs, paths, budgets, caps, and feature flags belong in the
 * validated site configuration, not in environment variables.
 */
export const ENV_KEYS = [
  'LLM_GATEWAY_API_KEY',
  'LLM_GATEWAY_BASE_URL',
  'CHEAP_MODEL',
  'REASONING_MODEL',
  'EMBEDDING_MODEL',
  'GOOGLE_AUTH_MODE',
  'GOOGLE_OAUTH_CLIENT_FILE',
  'GOOGLE_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'APIFY_TOKEN',
  'APIFY_CONTENT_ACTOR_ID',
  'APIFY_CONTENT_ACTOR_BUILD',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'PAGESPEED_API_KEY',
  'SEO_AGENT_WORKSPACE',
  'SEO_AGENT_LOG_LEVEL',
  'GSC_BASE_URL',
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

/**
 * Variables whose value must be one of a fixed allowlist. `GSC_BASE_URL`
 * selects between the two documented hosts that serve the Search Console
 * webmasters/v3 paths; any other value is refused (never a proxy or a
 * look-alike host).
 */
export const ENV_ALLOWED_VALUES: Partial<Record<EnvKey, readonly string[]>> = {
  GSC_BASE_URL: ['https://searchconsole.googleapis.com', 'https://www.googleapis.com'],
};

/** Keys whose values are secrets (registered for redaction, never printed). */
export const SECRET_ENV_KEYS: ReadonlySet<EnvKey> = new Set<EnvKey>([
  'LLM_GATEWAY_API_KEY',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'APIFY_TOKEN',
  'QDRANT_API_KEY',
  'PAGESPEED_API_KEY',
]);

export const ENV_DEFAULTS: Partial<Record<EnvKey, string>> = {
  LLM_GATEWAY_BASE_URL: 'https://api.llmgateway.io/v1',
  GOOGLE_AUTH_MODE: 'oauth',
  APIFY_CONTENT_ACTOR_ID: '9sHOY9RzPYGjmTHo8',
  QDRANT_URL: 'http://127.0.0.1:6333',
};

/**
 * Minimal dotenv parser: KEY=VALUE lines, optional quotes, '#' comments.
 * No variable expansion and no command substitution (never executes content).
 *
 * - Double-quoted values support the escapes \n \r \t \" and \\ in a single pass
 *   (so a serialized "C:\\new" parses back to C:\new); other backslashes are literal.
 * - Single-quoted values are literal.
 * - A quoted value may be followed by a comment: KEY="a # b"  # note
 * - Unquoted values end at " #" (inline comment) and are trimmed.
 * - Multi-line values are not supported; store PEM keys in files under secrets/.
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2]!;
    const dq = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(rest);
    const sq = dq ? null : /^'([^']*)'\s*(?:#.*)?$/.exec(rest);
    let value: string;
    if (dq) value = unescapeDoubleQuoted(dq[1]!);
    else if (sq) value = sq[1]!;
    else {
      value = rest;
      const hash = value.search(/[ \t]#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(.)/g, (whole, ch: string) => ESCAPES[ch] ?? whole);
}

export function serializeDotenv(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([k, v]) =>
        /[\s#"'\\]/.test(v)
          ? `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
          : `${k}=${v}`,
      )
      .join('\n') + '\n'
  );
}

/**
 * Set one KEY in dotenv text, keeping every other line (comments, blank lines,
 * lines the parser skips, other keys) verbatim. Every active assignment of KEY
 * is rewritten in place (the parser is last-wins, so all must change); when
 * there is none, the assignment is appended. Commented-out lines are never
 * touched. The line ending style (LF or CRLF) is preserved.
 */
export function upsertDotenv(content: string, key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid dotenv key name');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const assignment = serializeDotenv({ [key]: value }).replace(/\n$/, '');
  const lines = content === '' ? [] : content.split(/\r?\n/);
  // A trailing newline produces a final empty element; keep it as the terminator.
  const terminated = lines.length > 0 && lines[lines.length - 1] === '';
  if (terminated) lines.pop();
  const re = new RegExp(`^(\\s*)(export\\s+)?${key}\\s*=`);
  let replaced = false;
  const out = lines.map((line) => {
    const m = re.exec(line);
    if (!m) return line;
    replaced = true;
    return `${m[1] ?? ''}${m[2] ?? ''}${assignment}`;
  });
  if (!replaced) out.push(assignment);
  return out.join(eol) + eol;
}

export interface FilePermissionWarning {
  file: string;
  mode: string;
  message: string;
}

/** Warn when a secrets file is readable by group/others (POSIX only). */
export function checkSecretFilePermissions(file: string): FilePermissionWarning | null {
  if (process.platform === 'win32' || !existsSync(file)) return null;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    return { file, mode: mode.toString(8), message: `Secret file ${file} is accessible by other users (mode ${mode.toString(8)}); run: chmod 600 "${file}"` };
  }
  return null;
}

export function readDotenvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return parseDotenv(readFileSync(file, 'utf8'));
}
