/**
 * Secret redaction. Every log line, raw-response file, report, audit event,
 * and diagnostic export passes through `redact`. Known secret VALUES loaded
 * from the secret store are registered at runtime and replaced exactly; common
 * credential SHAPES are also masked as a second line of defense.
 */

const registered = new Set<string>();

/** Register a secret value so it is masked everywhere. Ignores trivially short values. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const v = value.trim();
  if (v.length < 6) return;
  registered.add(v);
  // The same secret often appears URL-encoded (query strings, form bodies).
  const encoded = encodeURIComponent(v);
  if (encoded !== v) registered.add(encoded);
}

export function clearRegisteredSecrets(): void {
  registered.clear();
}

export const REDACTED = '[REDACTED]';

/** Keys whose values are masked in structured objects. */
const SECRET_KEY_RE =
  /(^|[_-])(pass(word)?|secret|token|api[_-]?key|apikey|authorization|auth|cookie|set-cookie|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|id[_-]?token|credential|credentials|session$|session[_-]?id|sessionid|session[_-]?key|session[_-]?cookie)([_-]|$)/i;

/**
 * A final key segment that DESCRIBES a secret rather than holding one, e.g.
 * `auth_mode`, `session_count`, `GOOGLE_TOKEN_FILE`, `token_expires_at`,
 * `secret_name`. Such keys are not secret keys; their values are still
 * string-redacted (registered secrets and credential shapes).
 */
const METADATA_KEY_RE =
  /(^|[_-])(count|counts|total|totals|mode|type|kind|status|state|source|sources|set|present|configured|required|enabled|disabled|file|path|dir|env|name|names|url|uri|endpoint|scope|scopes|expires|expiry|expiration|at|ms|seconds|secs|ttl|length|len|format|version|label|hint|provider|limit|limits|remaining)$/i;

/**
 * Plain status words that are never credentials. A secret-named field holding
 * one (e.g. `credentials: 'missing'`) is shown as-is so statuses stay readable.
 */
const NON_SECRET_VALUES = new Set(['missing', 'present', 'set', 'unset', 'configured', 'not_configured', 'not configured', 'none', 'unknown', 'invalid', 'expired', 'revoked', 'disabled', 'enabled', 'required', 'optional', 'ok', 'valid', 'null', 'true', 'false', '~', REDACTED.toLowerCase()]);

function alreadyMasked(value: string): boolean {
  return value.startsWith('[REDACTED');
}

/** Names that clearly hold secrets when written as UPPER_CASE assignments mid-line. */
const ENV_NAME = '[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)';

/**
 * A documentation placeholder such as `<token>`, `<your-api-key>`, or `<APIFY_TOKEN>`
 * (optionally quoted). Guidance text shows these; they are never credentials.
 */
function isPlaceholder(value: string): boolean {
  return /^["']?<[A-Za-z][A-Za-z0-9_ .:-]{0,60}>/.test(value);
}

/** An ordinary word (lowercase or Capitalized letters only), as in prose, never a credential. */
function isPlainWord(value: string): boolean {
  return /^(?:[a-z]+|[A-Z][a-z]+)$/.test(value);
}

/**
 * Whether an "authorization: ..." / "authorization=..." match sits in a
 * header-like position: at the start of a line, right after a quote, brace,
 * bracket, comma, semicolon, or query separator (`"Authorization: x"`,
 * `{authorization=x}`, `?authorization=x`), or written with header
 * capitalization and a colon (`... Authorization: Bearer x`). Prose such as
 * "Blocked by Google authorization: OAuth client file not found" is not.
 */
function headerLikeContext(keyword: string, input: string, offset: number): boolean {
  const lineStart = input.lastIndexOf('\n', offset - 1) + 1;
  const before = input.slice(lineStart, offset);
  if (/^[ \t]*(?:[<>][ \t]*)?$/.test(before)) return true; // line start (also curl -v "> " / "< " prefixes)
  if (/["'`{(\[,;?&][ \t]*$/.test(before)) return true;
  return /^(?:Proxy-)?Authorization[ \t]*:/.test(keyword);
}

/** A credential-like value: at least 8 characters, not a plain word, not a placeholder, not already masked. */
function credentialLike(value: string): boolean {
  return value.length >= 8 && !isPlainWord(value) && !isPlaceholder(value) && !alreadyMasked(value);
}

type Replacement = string | ((match: string, ...groups: any[]) => string);

/**
 * Replacement for a secret-named query parameter: mask the whole value, then put back the closing
 * delimiter(s) that belong to the surrounding text rather than to the value: a single ')' only when a
 * '(' opened earlier on the same line is still unclosed (Markdown link targets, "(key=x&sig=y)",
 * "request failed (GET https://...?key=x)"), and a single "'" only when an unmatched "'" opened earlier
 * on the line. Trailing sentence punctuation after such a closer is kept too. Anything else is masked
 * with the value, so at most one delimiter character of a secret can remain visible.
 */
function maskQueryValue(_m: string, pre: string, value: string, offset: number, input: string): string {
  // Bounded look-back (the line, at most 4 KiB) keeps redaction linear on huge single-line inputs.
  const recent = input.slice(Math.max(0, offset - 4096), offset);
  const before = recent.slice(recent.lastIndexOf('\n') + 1);
  const count = (ch: string) => before.split(ch).length - 1;
  const parenOpen = count('(') > count(')');
  const quoteOpen = count("'") % 2 === 1;
  const closer = quoteOpen ? new RegExp(`'${parenOpen ? '\\)?' : ''}[\\].,;:!?]*$`).exec(value) : null;
  const tail = closer ?? (parenOpen ? /\)[.,;:!?]*$/.exec(value) : null);
  if (!tail) return `${pre}${REDACTED}`;
  // A value made only of the closer is an empty parameter: nothing to mask.
  return tail.index === 0 ? `${pre}${value}` : `${pre}${REDACTED}${value.slice(tail.index)}`;
}

const PATTERNS: Array<[RegExp, Replacement]> = [
  // Authorization headers with any scheme ("Authorization: Token x", "Proxy-Authorization: Basic x", or a bare value).
  // Only in a header-like position and only for credential-like values (see headerLikeContext / credentialLike),
  // so status prose ("Google authorization: OAuth client ...") stays readable.
  [
    /\b((?:proxy-)?authorization[ \t]*[:=][ \t]*)(?:([A-Za-z][A-Za-z0-9_-]*)[ \t]+(?=\S))?([^\s,;"'}]+)/gi,
    (m: string, pre: string, scheme: string | undefined, value: string, offset: number, input: string) =>
      headerLikeContext(pre, input, offset) && credentialLike(value) ? `${pre}${scheme ? `${scheme} ` : ''}${REDACTED}` : m,
  ],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Basic credentials: base64 tokens contain a digit, '+', '/', or '=' (so prose such as "Basic principles" is untouched)
  [/\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/=]{8,}/g, `$1 ${REDACTED}`],
  // PEM private keys (complete blocks, then truncated/unterminated blocks)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[A-Za-z0-9+/=\s]|\\[nr])*/g, REDACTED],
  // Google OAuth tokens, authorization codes, and API keys
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, REDACTED],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, REDACTED],
  [/\b4\/0[A-Za-z0-9._-]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, REDACTED],
  // Apify tokens
  [/\bapify_api_[A-Za-z0-9]{20,}/g, REDACTED],
  // LLM Gateway keys (documented shape llmgtwy_...)
  [/\bllmgtwy_[A-Za-z0-9_-]{8,}/g, REDACTED],
  // GitHub, npm, AWS access key ids, Slack tokens, JWTs
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Generic "sk-" style keys
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // key=value in query strings / form bodies. The value is masked up to the next '&', whitespace, '"', '#',
  // '<', or '>' ('<' and '>' are never legal unescaped in a URL, so they end it: "<https://x/?token=v>",
  // "href='https://x/?key=v'>link text"), or up to a ',' that starts another URL ("?password=v,https://b/").
  // ')' and "'" are legal, unescaped query characters, so they never end a secret early. A single
  // trailing ')' (optionally followed by sentence punctuation) is put back only when it closes a '(' opened
  // before the parameter in the same token, so "(key=x&sig=y)" and Markdown link targets stay well formed;
  // a single trailing "'" is put back the same way when an unmatched "'" opened the token (a quoted
  // attribute or string).
  [/([?&](?:key|api_key|apikey|token|access_token|refresh_token|id_token|password|passwd|client_secret|secret|signature|sig)=)((?:(?!,'?[a-z][a-z0-9+.-]*:\/\/)[^&\s"#<>])+)/gi, maskQueryValue],
  // JSON text with secret-named string fields, e.g. {"refresh_token": "..."}
  [
    /("(?:[A-Za-z0-9_-]*[_-])?(?:password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api_key|apikey|apiKey|private_key|authorization)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi,
    `$1${REDACTED}$2`,
  ],
  // env lines (optionally `export`-prefixed): whole value to end of line
  // ([ \t] rather than \s so an empty "KEY=" line never swallows the next line)
  // Placeholders such as `APIFY_TOKEN=<token>` in setup guidance are kept.
  [/^([ \t]*(?:export[ \t]+)?(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS))[ \t]*=[ \t]*)(\S.*)$/gm, (m: string, pre: string, value: string) => (isPlaceholder(value) ? m : `${pre}${REDACTED}`)],
  // UPPER_CASE secret assignments in the middle of a line, e.g. "failed: APIFY_TOKEN=abc" (placeholders kept)
  [new RegExp(`\\b(${ENV_NAME}[ \\t]*=[ \\t]*)("[^"\\n]*"|'[^'\\n]*'|[^\\s&"',;]+)`, 'g'), (m: string, pre: string, value: string) => (isPlaceholder(value) ? m : `${pre}${REDACTED}`)],
  // YAML / log style "name: value" assignments for secret names outside JSON quotes
  // (e.g. "password: hunter2", "dataforseo_password: x", "api_key: sk_live_..."). JSON keys are
  // quoted and handled above; "max_tokens: 1500" does not match (the secret word must end the key).
  [
    /(^|[\s{,(\[])([A-Za-z0-9_-]*?(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key)[ \t]*:[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;"'}\]]+)/gim,
    (m: string, lead: string, key: string, value: string) => {
      const bare = value.replace(/^["']|["']$/g, '');
      if (!bare || alreadyMasked(bare) || NON_SECRET_VALUES.has(bare.toLowerCase()) || isPlaceholder(bare)) return m;
      return `${lead}${key}${REDACTED}`;
    },
  ],
  // Credentials embedded in URLs: user:password@ and token-only userinfo (https://TOKEN@host/)
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@?#]{8,}@/gi, `$1${REDACTED}@`],
];

export function redactString(input: string): string {
  let out = input;
  // Longest first so overlapping secrets are fully masked.
  for (const secret of [...registered].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) out = typeof replacement === 'string' ? out.replace(re, replacement) : out.replace(re, replacement as (substring: string, ...args: any[]) => string);
  return out;
}

/** True for keys whose values hold secrets (e.g. `api_key`, `refreshToken`), false for keys describing them (`auth_mode`, `token_count`). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) && !METADATA_KEY_RE.test(key);
}

/**
 * Deep-redact any value. Objects are copied. Under a secret-named key, string
 * and number values are masked (plain status words such as "missing" are
 * kept), booleans/null are kept, and objects/arrays are walked with every
 * non-metadata leaf masked, so structure (and flags such as `{ set: true }`)
 * stays readable while secret values never leak. Other strings are
 * string-redacted. Only true cycles render as "[Circular]": the same object
 * referenced twice (a DAG) is redacted at each position.
 */
export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  return redactValue(value, seen, false) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>, secret: boolean): unknown {
  if (typeof value === 'string') {
    if (secret && value !== '' && !NON_SECRET_VALUES.has(value.trim().toLowerCase())) return REDACTED;
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'bigint') return secret ? REDACTED : value;
  if (value === null || typeof value !== 'object') return value;
  // Dates carry no secrets; keep them so JSON output stays an ISO timestamp.
  if (value instanceof Date) return value;
  if (value instanceof URL) return secret ? REDACTED : redactString(value.href);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${(value as ArrayBufferLike | ArrayBufferView).byteLength} bytes]`;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactValue(v, seen, secret));
    if (value instanceof Error) return { name: value.name, message: secret ? REDACTED : redactString(value.message) };
    const out: Record<string, unknown> = {};
    const entries: Array<[string, unknown]> = value instanceof Map ? [...value].map(([k, v]) => [String(k), v]) : Object.entries(value as Record<string, unknown>);
    if (value instanceof Set) return [...value].map((v) => redactValue(v, seen, secret));
    for (const [k, v] of entries) setOwn(out, k, redactValue(v, seen, keyIsSecret(k, secret)));
    return out;
  } finally {
    // Track ancestors only, so shared (non-circular) references are not mislabeled.
    seen.delete(value);
  }
}

/**
 * Set an own, enumerable data property. A plain `out[k] = v` with k ===
 * "__proto__" (an own key that JSON.parse creates) would call the prototype
 * setter instead: the key would vanish from the copy and the copy would be
 * re-parented onto attacker-controlled data.
 */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  else out[key] = value;
}

/** Secret context for a child: its own name decides, and metadata names (status, source, type, ...) reset it. */
function keyIsSecret(key: string, inherited: boolean): boolean {
  if (METADATA_KEY_RE.test(key)) return false;
  return inherited || SECRET_KEY_RE.test(key);
}

/** Headers safe to persist from HTTP responses/requests. */
export function redactHeaders(headers: Headers | Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: Array<[string, string]> =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v] as [string, string]]));
  for (const [k, v] of entries) {
    setOwn(out, k.toLowerCase(), isSecretKey(k) ? REDACTED : redactString(v));
  }
  return out;
}
