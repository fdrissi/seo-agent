// Secret-detection rules shared by scripts/scan-secrets.mjs and scripts/release-check.mjs.
// Plain Node ESM, no dependencies. Findings NEVER carry the matched value: only
// the rule id, location, length, and a short one-way fingerprint.
//
// Synthetic fixtures: a match whose value contains an allowlist marker (for
// example FAKE or SYNTHETIC) or whose fingerprint is listed in the allowlist
// file is reported as "allowlisted", not as a finding. See
// scripts/secret-scan-allowlist.json and docs/SECURITY_MODEL.md.

import { createHash } from 'node:crypto';

export const FINGERPRINT_PREFIX = 'seo-agent-secret-scan:v1:';

/** One-way, truncated fingerprint for correlating findings. Never reversible for high-entropy secrets. */
export function fingerprint(value) {
  return createHash('sha256').update(FINGERPRINT_PREFIX + value).digest('hex').slice(0, 16);
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = value.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Values that are obviously placeholders, references, or code rather than credentials. */
const PLACEHOLDER_RE =
  /^(?:<[^>]*>|\$\{[^}]*\}|\$\([^)]*\)|\{\{[^}]*\}\}|%[A-Z_]+%|\*+|x+|\.+|-+|_+|0+|null|none|undefined|true|false|string|number|boolean|required|optional|redacted|\[redacted\]|changeme|change-me|password|secret|token|apikey|api-key|api_key)$/i;

/** Looks like a code identifier chain (`opts.token`, `process.env.API_KEY`, `getToken(`) rather than a literal. */
const CODE_REFERENCE_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|\?\.)[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(|\[|!)?$/;

/** Placeholders, templates, and references to other variables (never credentials). */
export function isPlaceholderValue(value) {
  const v = value.trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (/^(?:\$\{|\$\(|\{\{|<|%[A-Z_])/.test(v)) return true; // template/variable references
  if (/^(?:process\.env|import\.meta\.env|env|secrets|config|ctx|this|opts|options|args|input|req|res|params)(?:\.|\[|\(|$)/.test(v)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(v) && v.includes('_')) return true; // another env var name, e.g. LLM_GATEWAY_API_KEY
  return false;
}

/** Looks like a code identifier chain (`tokens.access_token`, `!!t.refresh_token`, `apiKey`), without digits. */
export function isCodeReference(value) {
  const code = value.trim().replace(/^[!~+-]+/, '');
  return CODE_REFERENCE_RE.test(code) && !/\d/.test(code);
}

/** Placeholder or code reference (used where values are usually unquoted code). */
export function looksLikePlaceholder(value) {
  return isPlaceholderValue(value) || isCodeReference(value);
}

function decodesToCredentialPair(b64) {
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    return /^[\x20-\x7e]{1,200}:[\x20-\x7e]{3,200}$/.test(decoded);
  } catch {
    return false;
  }
}

/** True when the quoted string that `m` starts continues past the captured word with whitespace and more text. */
function isMultiWordQuoted(m) {
  const input = m.input ?? '';
  const quote = m[3];
  const end = (m.index ?? 0) + m[0].length;
  const close = input.indexOf(quote, end);
  const nl = input.indexOf('\n', end);
  if (close === -1 || (nl !== -1 && nl < close)) return false;
  const rest = input.slice(end, close);
  return /^[ \t]+\S/.test(rest);
}

const SECRET_NAME = String.raw`(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|token|passw(?:or)?d|passwd|pwd|private[_-]?key|access[_-]?key|credentials?)`;

/**
 * Content rules. `regex` must be global. `group` selects the secret value
 * (default: whole match). `validate(value, match)` may reject a candidate.
 * `markerExempt: false` means allowlist markers in the value do not exempt it
 * (none currently; kept for future strict rules).
 */
export const CONTENT_RULES = [
  {
    id: 'private-key',
    description: 'PEM/OpenSSH/PGP private key block',
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\\[nr]|[\s"'+])*[\s\S]{0,120}?[A-Za-z0-9+/]{40,}/g,
  },
  { id: 'google-api-key', description: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: 'google-oauth-client-secret', description: 'Google OAuth client secret', regex: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  { id: 'google-oauth-refresh-token', description: 'Google OAuth refresh token', regex: /(?<![A-Za-z0-9])1\/\/0[0-9A-Za-z_-]{30,}/g },
  { id: 'google-oauth-access-token', description: 'Google OAuth access token', regex: /\bya29\.[0-9A-Za-z_-]{30,}/g },
  {
    id: 'google-service-account-key',
    description: 'Google service-account JSON key (private_key_id)',
    regex: /"private_key_id"\s*:\s*"([a-f0-9]{40})"/g,
    group: 1,
  },
  {
    id: 'oauth-client-secret-json',
    description: 'OAuth client JSON with a client_secret value',
    regex: /"client_secret"\s*:\s*"([^"\s]{8,})"/g,
    group: 1,
    validate: (v) => !isPlaceholderValue(v),
  },
  { id: 'apify-token', description: 'Apify API token', regex: /\bapify_api_[A-Za-z0-9]{20,}/g },
  { id: 'llm-gateway-key', description: 'LLM Gateway API key', regex: /\bllmgtwy_[A-Za-z0-9_-]{16,}/g },
  {
    id: 'openai-style-key',
    description: 'sk- style LLM provider key (OpenAI/Anthropic/OpenRouter shapes)',
    regex: /(?<![A-Za-z0-9_-])sk-(?:proj-|ant-(?:api\d+-)?|or-v1-)?[A-Za-z0-9_-]{20,}/g,
  },
  { id: 'github-token', description: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { id: 'aws-access-key-id', description: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack-token', description: 'Slack token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-live-key', description: 'Stripe live key', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { id: 'npm-token', description: 'npm access token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    id: 'npmrc-auth-token',
    description: '.npmrc _authToken value',
    regex: /_authToken\s*=\s*([^\s$"'][^\s"']{8,})/g,
    group: 1,
    validate: (v) => !isPlaceholderValue(v),
  },
  { id: 'jwt', description: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: 'authorization-bearer',
    description: 'Bearer token literal',
    regex: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g,
    group: 1,
    validate: (v) => !isPlaceholderValue(v) && shannonEntropy(v) >= 3,
  },
  {
    id: 'authorization-basic',
    description: 'HTTP Basic credentials literal (DataForSEO and others)',
    regex: /\bBasic\s+([A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g,
    group: 1,
    validate: (v) => decodesToCredentialPair(v),
  },
  {
    id: 'url-credentials',
    description: 'Credentials embedded in a URL',
    regex: /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:/?#@'"`<>(){}]{1,128}):([^\s/?#@'"`<>(){}]{3,128})@[A-Za-z0-9.-]+/gi,
    group: 2,
    // URL passwords are literals, never code references, so only explicit placeholders are exempt.
    validate: (v) => !isPlaceholderValue(v) && !/^(?:pass(?:word)?|secret|pwd|\$.*|\*+|x+)$/i.test(v),
  },
  {
    id: 'secret-assignment',
    description: 'High-entropy value assigned to a secret-named key',
    // The key must END with the secret word (TOKEN_ESTIMATOR_VERSION and
    // keptTokens are not credentials). Operators and quotes may not span lines.
    regex: new RegExp(
      String.raw`(?<![A-Za-z0-9])([A-Za-z0-9_.-]*?${SECRET_NAME}(?:[_-]?value|\d+)?)["']?[ \t]*(=>|=|:)[ \t]*(["'\x60]?)([^\s"'\x60,;)}\]]{8,})`,
      'gi',
    ),
    group: 4,
    validate: (v, m) => {
      if (isPlaceholderValue(v)) return false;
      const quoted = !!m[3];
      // A quoted value that continues with a space and more words is prose
      // ('DataForSEO API password.'), not a credential: generated credentials never contain spaces.
      if (quoted && isMultiWordQuoted(m)) return false;
      // "KEY: Word ..." is prose or YAML; unquoted plain words count only in KEY=value assignments.
      if (!quoted && m[2] !== '=' && /^[A-Za-z]+$/.test(v)) return false;
      const envStyleKey = /^[A-Z0-9_]+$/.test(m[1] ?? '');
      // Unquoted identifier chains are code (`apiKey: opts.apiKey`, `token = token`), except plain words in env files.
      if (!quoted && isCodeReference(v) && (v.includes('.') || !envStyleKey)) return false;
      // Credentials use a limited character set; code expressions contain ( [ < { | etc.
      if (!/^[A-Za-z0-9+/=_\-.~:@!#$%^&*]+$/.test(v)) return false;
      const key = m[1] ?? '';
      const envStyle = /^[A-Z0-9_]+$/.test(key);
      if (/^https?:\/\//i.test(v)) return false; // URLs are handled by url-credentials
      if (/^[0-9]+$/.test(v)) return false;
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return false; // dates
      const minLen = envStyle ? 8 : 16;
      const minEntropy = envStyle ? 2.8 : 3.3;
      if (v.length < minLen) return false;
      if (shannonEntropy(v) < minEntropy) return false;
      // Require some character-class mix typical of generated credentials.
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
      return classes >= 2;
    },
  },
];

/** File-name rules for credential containers and private data files. */
export const FILENAME_RULES = [
  { id: 'private-key-file', description: 'Private key container file', test: (p) => /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:p12|pfx|jks|keystore))$/i.test(p) },
  { id: 'credential-file', description: 'Credential file (.netrc, .pgpass, .htpasswd, secrets.env)', test: (p) => /(?:^|\/)(?:\.netrc|\.pgpass|\.htpasswd|secrets\.env)$/i.test(p) },
  { id: 'database-file', description: 'Database file (may contain private data)', test: (p) => /\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$/i.test(p) },
];

/** .env files other than documented examples. */
export function isDotenvPath(p) {
  const base = p.split('/').pop() ?? '';
  if (!/^\.env(?:\..+)?$/i.test(base)) return false;
  return !/^\.env\.(?:example|sample|template|dist|defaults)$/i.test(base);
}

/** A committed .env file with at least one non-empty assignment. Returns the first offending line number or 0. */
export function dotenvValueLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const value = m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    if (value !== '') return { line: i + 1, value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Allowlist

export const DEFAULT_MARKERS = [
  'fake',
  'synthetic',
  'example',
  'dummy',
  'notreal',
  'not-real',
  'not_real',
  'notareal',
  'not-a-real',
  'not_a_real',
  'placeholder',
  'redacted',
  'changeme',
  'xxxxxxxx',
  'your-',
  'your_',
];

/**
 * Marker matching. Long markers (6+ characters, e.g. "synthetic", "example",
 * "placeholder") exempt a value wherever they appear (case-insensitive): the
 * chance of one occurring in a random credential is negligible. Short markers
 * ("fake", "dummy", "test") must appear in lower, UPPER, or Capitalized case
 * AND either touch a non-alphanumeric character / the start or end of the value
 * (e.g. "ya29.FAKE-token") or occur at least twice ("FAKEFAKE..."). This keeps
 * random base64 in real credentials from being exempted by accident.
 */
export function containsMarker(value, markers) {
  const lower = value.toLowerCase();
  for (const m of markers) {
    if (!m) continue;
    const ml = m.toLowerCase();
    if (ml.length >= 6) {
      if (lower.includes(ml)) return true;
      continue;
    }
    const variants = new Set([ml, ml.toUpperCase(), ml.charAt(0).toUpperCase() + ml.slice(1)]);
    for (const variant of variants) {
      let from = 0;
      let idx;
      let occurrences = 0;
      while ((idx = value.indexOf(variant, from)) !== -1) {
        occurrences++;
        const before = idx === 0 ? '' : value.charAt(idx - 1);
        const after = value.charAt(idx + variant.length);
        const boundaryBefore = before === '' || !/[A-Za-z0-9]/.test(before);
        const boundaryAfter = after === '' || !/[A-Za-z0-9]/.test(after);
        if (boundaryBefore || boundaryAfter || occurrences >= 2) return true;
        from = idx + 1;
      }
    }
  }
  return false;
}

/** 8+ identical characters in a row ("00000000") only occur in fabricated values. */
export function hasRepeatedRun(value, min = 8) {
  let run = 1;
  for (let i = 1; i < value.length; i++) {
    if (value.charCodeAt(i) === value.charCodeAt(i - 1)) {
      run++;
      if (run >= min) return true;
    } else run = 1;
  }
  return false;
}

/**
 * Obviously fabricated values contain long ascending runs such as "abcdefgh",
 * "ABCDEFGH", or "12345678". The chance of an 8-character ascending run in a
 * random credential is about 1e-11, so such values are treated as synthetic,
 * but ONLY for machine-generated token rules (see RANDOM_TOKEN_RULES) and only
 * for runs of SEQUENCE_MIN_RUN or more characters. Human-chosen secrets such as
 * "Summer12345678!" contain such runs all the time.
 */
export function hasSequentialRun(value, min = 8) {
  let run = 1;
  for (let i = 1; i < value.length; i++) {
    const prev = value.charCodeAt(i - 1);
    const cur = value.charCodeAt(i);
    const sameClass = (a, b) => (a >= 48 && a <= 57 && b >= 48 && b <= 57) || (a >= 65 && a <= 90 && b >= 65 && b <= 90) || (a >= 97 && a <= 122 && b >= 97 && b <= 122);
    if (cur === prev + 1 && sameClass(prev, cur)) {
      run++;
      if (run >= min) return true;
    } else run = 1;
  }
  return false;
}

/** Minimal glob (** , *, ?) to RegExp for POSIX-relative paths. */
export function globToRegExp(glob) {
  let re = '';
  const g = glob.replace(/^\.\//, '').replace(/^\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Rules whose values are machine-generated random tokens. Only these may be
 * exempted by the ascending/identical-run heuristic. Human-chosen secrets (URL
 * passwords, secret-named assignments, .env values, Basic credentials) and
 * private keys (whose base64 bodies legitimately contain long "AAAA" runs and
 * whose PEM text may be indented) NEVER get that exemption: synthetic fixtures
 * for those rules must carry an explicit marker or an allowlisted fingerprint.
 */
export const RANDOM_TOKEN_RULES = new Set([
  'google-api-key',
  'google-oauth-client-secret',
  'google-oauth-refresh-token',
  'google-oauth-access-token',
  'google-service-account-key',
  'oauth-client-secret-json',
  'apify-token',
  'llm-gateway-key',
  'openai-style-key',
  'github-token',
  'aws-access-key-id',
  'slack-token',
  'stripe-live-key',
  'npm-token',
  'npmrc-auth-token',
  'jwt',
  'authorization-bearer',
]);

/** Minimum ascending/identical run length that marks a random-token value as fabricated. */
export const SEQUENCE_MIN_RUN = 10;

/**
 * Text of a private-key block OUTSIDE its base64 body: the BEGIN line (label),
 * PEM headers, and comment lines. Markers are only honored here, never inside
 * the body (random base64 must not be able to exempt a real key).
 */
export function privateKeyMarkerScope(block) {
  return block
    .split(/\r?\n|\\r\\n|\\n|\\r/)
    .map((l) => l.replace(/^[\s"'`+,]+|[\s"'`+,]+$/g, ''))
    .filter((l) => l && !/^[A-Za-z0-9+/=]+$/.test(l))
    .join('\n');
}

const ALLOWLIST_KEYS = new Set(['_about', 'version', 'markers', 'pathMarkers', 'fingerprints', 'ignorePaths']);
const MIN_MARKER_LENGTH = 4;

function literalSegments(glob) {
  const segs = String(glob).replace(/^\.\//, '').replace(/^\//, '').split('/');
  const out = [];
  for (const seg of segs) {
    if (/[*?[\]]/.test(seg)) break;
    out.push(seg);
  }
  return { segs, literal: out };
}

/**
 * Validate an allowlist file's content. Returns a list of problems (empty =
 * valid). The scanner refuses to run with an invalid allowlist (exit 2), so a
 * change cannot silently switch the scan off with reason-less entries,
 * one-letter markers, or catch-all ignore globs.
 */
export function validateAllowlist(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['allowlist must be a JSON object'];
  if (raw.version !== 1) problems.push('"version" must be 1');
  for (const k of Object.keys(raw)) if (!ALLOWLIST_KEYS.has(k)) problems.push(`unknown top-level key "${k}"`);
  const hasReason = (e) => e && typeof e.reason === 'string' && e.reason.trim().length >= 10;
  const checkMarkers = (list, where) => {
    if (!Array.isArray(list)) {
      problems.push(`${where}: markers must be an array of strings`);
      return;
    }
    for (const m of list) {
      if (typeof m !== 'string' || m.trim().length < MIN_MARKER_LENGTH) problems.push(`${where}: marker ${JSON.stringify(m)} is shorter than ${MIN_MARKER_LENGTH} characters (short markers exempt almost everything)`);
    }
  };
  const arr = (k) => {
    if (raw[k] === undefined) return [];
    if (!Array.isArray(raw[k])) {
      problems.push(`"${k}" must be an array`);
      return [];
    }
    return raw[k];
  };
  checkMarkers(arr('markers'), 'markers');
  arr('pathMarkers').forEach((e, i) => {
    const where = `pathMarkers[${i}]`;
    if (!e || typeof e !== 'object' || typeof e.glob !== 'string' || !e.glob.trim()) {
      problems.push(`${where}: needs a "glob" string`);
      return;
    }
    if (!hasReason(e)) problems.push(`${where}: needs a "reason" (at least 10 characters)`);
    if (!literalSegments(e.glob).literal.length) problems.push(`${where}: glob "${e.glob}" must start with a literal directory (no wildcard in the first segment)`);
    checkMarkers(e.markers, where);
    if (Array.isArray(e.markers) && e.markers.length === 0) problems.push(`${where}: needs at least one marker`);
  });
  arr('fingerprints').forEach((e, i) => {
    const where = `fingerprints[${i}]`;
    if (!e || typeof e !== 'object' || typeof e.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(e.fingerprint)) {
      problems.push(`${where}: needs a 16-hex-character "fingerprint"`);
      return;
    }
    if (!hasReason(e)) problems.push(`${where}: needs a "reason" (at least 10 characters)`);
    if (e.rule !== undefined && !CONTENT_RULES.some((r) => r.id === e.rule) && !FILENAME_RULES.some((r) => r.id === e.rule) && e.rule !== 'dotenv-with-values') problems.push(`${where}: unknown rule "${e.rule}"`);
  });
  arr('ignorePaths').forEach((e, i) => {
    const where = `ignorePaths[${i}]`;
    if (!e || typeof e !== 'object' || typeof e.glob !== 'string' || !e.glob.trim()) {
      problems.push(`${where}: must be an object with "glob" and "reason" (bare strings are not accepted)`);
      return;
    }
    if (!hasReason(e)) problems.push(`${where}: needs a "reason" (at least 10 characters)`);
    const { segs, literal } = literalSegments(e.glob);
    if (!literal.length) problems.push(`${where}: glob "${e.glob}" must start with a literal directory (catch-all globs such as "**" or "*.json" are rejected)`);
    else if (e.glob.includes('**') && literal.length < 2) problems.push(`${where}: glob "${e.glob}" ignores a whole top-level directory; name a specific subdirectory or file`);
    else if (segs.length === 1 && /[*?]/.test(e.glob)) problems.push(`${where}: glob "${e.glob}" is too broad`);
  });
  return problems;
}

/**
 * Allowlist file shape (scripts/secret-scan-allowlist.json):
 * {
 *   "version": 1,
 *   "markers": ["fake", ...],                     // extra case-insensitive markers (added to defaults)
 *   "pathMarkers": [{ "glob": "tests/**", "markers": ["test"], "reason": "..." }],
 *   "fingerprints": [{ "fingerprint": "abcd...", "rule": "jwt", "path": "tests/x.ts", "reason": "..." }],
 *   "ignorePaths": [{ "glob": "...", "reason": "..." }]
 * }
 * Every entry needs a reason (enforced by validateAllowlist when the file is
 * loaded). Real credentials must never be allowlisted: rotate them.
 */
export function compileAllowlist(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const markers = [...new Set([...DEFAULT_MARKERS, ...(Array.isArray(cfg.markers) ? cfg.markers : [])].map((m) => String(m).toLowerCase()).filter(Boolean))];
  const pathMarkers = (Array.isArray(cfg.pathMarkers) ? cfg.pathMarkers : []).map((e) => ({
    re: globToRegExp(String(e.glob)),
    markers: (Array.isArray(e.markers) ? e.markers : []).map((m) => String(m).toLowerCase()),
  }));
  const fingerprints = new Map(
    (Array.isArray(cfg.fingerprints) ? cfg.fingerprints : []).map((e) => [String(e.fingerprint), { rule: e.rule ? String(e.rule) : null, path: e.path ? String(e.path) : null }]),
  );
  const ignore = (Array.isArray(cfg.ignorePaths) ? cfg.ignorePaths : []).map((e) => globToRegExp(String(typeof e === 'string' ? e : e.glob)));
  return {
    markers,
    isIgnoredPath: (p) => ignore.some((re) => re.test(p)),
    allows(finding, value) {
      const fp = fingerprints.get(finding.fingerprint);
      if (fp && (!fp.rule || fp.rule === finding.rule) && (!fp.path || globToRegExp(fp.path).test(finding.path))) return 'fingerprint';
      if (value) {
        if (containsMarker(value, markers)) return 'marker';
        // Fabricated-run heuristic: machine-generated token rules only, never human-chosen secrets or private keys.
        if (RANDOM_TOKEN_RULES.has(finding.rule) && (hasSequentialRun(value, SEQUENCE_MIN_RUN) || hasRepeatedRun(value, SEQUENCE_MIN_RUN))) return 'sequence';
        for (const pm of pathMarkers) if (pm.re.test(finding.path) && containsMarker(value, pm.markers)) return 'path-marker';
      }
      return null;
    },
  };
}

/**
 * Scan text. Returns findings without values:
 * { rule, description, path, line, length, fingerprint, allowlisted?: reason }
 */
export function scanText(text, path, allowlist, lineOffset = 0, lineMap = null) {
  const out = [];
  if (!text) return out;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lineMap ? (lineMap[lo] ?? lo + 1) : lo + 1 + lineOffset;
  };
  const seen = new Set();
  for (const rule of CONTENT_RULES) {
    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.regex.lastIndex++;
        continue;
      }
      const value = rule.group ? m[rule.group] : m[0];
      if (!value) continue;
      if (rule.validate && !rule.validate(value, m)) continue;
      const line = lineOf(m.index);
      const fp = fingerprint(value);
      const key = `${rule.id}:${line}:${fp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const finding = { rule: rule.id, description: rule.description, path, line, length: value.length, fingerprint: fp };
      let markerScope = value;
      if (rule.id === 'private-key') {
        // Markers count only in the BEGIN label, PEM headers, and comment lines,
        // never in the base64 body (OpenSSH bodies contain long "AAAA" runs).
        // Without an END line (truncated key), only the BEGIN label counts.
        const end = text.indexOf('-----END', m.index + 10);
        const block = end === -1 || end - m.index > 16000 ? m[0].split(/\r?\n|\\n/)[0] : text.slice(m.index, end);
        markerScope = privateKeyMarkerScope(block);
      }
      const allowed = allowlist ? allowlist.allows(finding, markerScope) : null;
      if (allowed) finding.allowlisted = allowed;
      out.push(finding);
    }
  }
  // Suppress generic duplicates when a specific rule matched the same line.
  const specificLines = new Set(out.filter((f) => f.rule !== 'secret-assignment' && f.rule !== 'authorization-bearer').map((f) => f.line));
  return out.filter((f) => !((f.rule === 'secret-assignment' || f.rule === 'authorization-bearer') && specificLines.has(f.line)));
}

/** Name-based findings for a path (credential containers, databases, .env with values handled by caller). */
export function scanPathName(path, allowlist) {
  const out = [];
  for (const rule of FILENAME_RULES) {
    if (!rule.test(path)) continue;
    const finding = { rule: rule.id, description: rule.description, path, line: 0, length: 0, fingerprint: fingerprint(`path:${path}`) };
    const allowed = allowlist ? allowlist.allows(finding, null) : null;
    if (allowed) finding.allowlisted = allowed;
    out.push(finding);
  }
  return out;
}

/** Scan a whole file's text including .env semantics. */
export function scanFileContent(path, text, allowlist, lineMap = null) {
  const findings = scanText(text, path, allowlist, 0, lineMap);
  if (isDotenvPath(path)) {
    const hit = dotenvValueLine(text);
    if (hit) {
      const finding = {
        rule: 'dotenv-with-values',
        description: '.env file with non-empty values (never commit .env files)',
        path,
        line: lineMap ? (lineMap[hit.line - 1] ?? hit.line) : hit.line,
        length: hit.value.length,
        fingerprint: fingerprint(`dotenv:${path}:${hit.value}`),
      };
      const allowed = allowlist ? allowlist.allows(finding, hit.value) : null;
      if (allowed) finding.allowlisted = allowed;
      findings.push(finding);
    }
  }
  return findings;
}

export const REMEDIATION = [
  'ROTATE every exposed credential now: revoke it at the provider and issue a new one. Assume it is compromised.',
  'Deleting the file, amending the commit, or rewriting Git history is NOT remediation on its own: the value may already be cloned, cached, forked, logged, or indexed.',
  'After rotating, move the new value to <workspace>/secrets/secrets.env (mode 0600) or a password-manager-injected environment variable, never into the repository or the vault.',
  'Before the first public push you may additionally rewrite history (for example with git filter-repo), but only after rotation.',
  'If a finding is a synthetic test fixture, put a marker such as FAKE or SYNTHETIC inside the value, generate it at test runtime, or add its fingerprint with a reason to scripts/secret-scan-allowlist.json.',
];
