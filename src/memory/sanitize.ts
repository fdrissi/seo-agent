import { redactString } from '../security/redact.js';

/**
 * Memory content policy, applied before anything is stored in memory tables
 * and again (defense in depth) right before text is sent to an embedding model.
 *
 * - Secrets: text containing a registered secret value or a credential shape
 *   is REJECTED (never stored, never embedded). The owner is told which
 *   document to clean up; the value itself is never echoed.
 * - Personal analytics identifiers (emails, also percent-encoded; IPv4 and
 *   IPv6 addresses; GA client ids, click ids, user/client id assignments)
 *   are REDACTED to placeholders.
 * - Raw metrics dumps (many numeric table/CSV rows) are REJECTED: measurements
 *   live in SQLite metric tables and are never embedded row by row.
 */

export type SecretFindingKind =
  | 'registered_or_known_credential'
  | 'aws_access_key'
  | 'github_token'
  | 'slack_token'
  | 'stripe_key'
  | 'jwt'
  | 'credential_assignment'
  | 'private_key';

const SECRET_PATTERNS: Array<[SecretFindingKind, RegExp]> = [
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['stripe_key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    'credential_assignment',
    /\b(?:api[_ -]?key|apikey|secret[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|password|passwd|passphrase)\b["']?\s*[:=]\s*["']?[^\s"'`<>]{8,}/i,
  ],
];

/** Detect secrets. Returns finding kinds only (never the secret values). */
export function detectSecrets(text: string): SecretFindingKind[] {
  const found = new Set<SecretFindingKind>();
  if (redactString(text) !== text) found.add('registered_or_known_credential');
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) found.add(kind);
  return [...found];
}

export function containsSecret(text: string): boolean {
  return detectSecrets(text).length > 0;
}

export type PiiKind = 'email' | 'ip_address' | 'analytics_client_id' | 'analytics_identifier_assignment' | 'phone' | 'handle';

type PiiReplacement = string | ((m: string, ...g: string[]) => string | null);

const IPV4 = '(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4_RE = new RegExp(`\\b${IPV4}\\b`, 'g');
const H16 = '[0-9A-Fa-f]{1,4}';
/**
 * IPv6 addresses (RFC 4291 text forms, including "::" compression and an embedded IPv4 tail). Only the
 * full eight-group form or a form with "::" matches, so clock times ("10:30:00"), ISO timestamps, MAC
 * addresses, and hex hashes (no colons) are left alone; the address may not touch other word characters,
 * colons, or dots, so "std::string"-style text and hash fragments do not match either.
 */
const IPV6_RE = new RegExp(
  `(?<![\\w:.])(?:${[
    `(?:${H16}:){6}${IPV4}`,
    `::(?:${H16}:){0,5}${IPV4}`,
    `(?:${H16}:){1,5}:(?:${H16}:){0,4}${IPV4}`,
    `(?:${H16}:){7}${H16}`,
    `(?:${H16}:){1,7}:`,
    `(?:${H16}:){1,6}:${H16}`,
    `(?:${H16}:){1,5}(?::${H16}){2}`,
    `(?:${H16}:){1,4}(?::${H16}){3}`,
    `(?:${H16}:){1,3}(?::${H16}){4}`,
    `(?:${H16}:){1,2}(?::${H16}){5}`,
    `${H16}:(?::${H16}){6}`,
    `:(?::${H16}){1,7}`,
  ].join('|')})(?![\\w:]|\\.\\d)`,
  'g',
);

const PII_RULES: Array<[PiiKind, RegExp, PiiReplacement]> = [
  ['analytics_client_id', /\bGA\d\.\d\.\d{5,}\.\d{5,}\b/g, '[ANALYTICS_ID]'],
  [
    'analytics_identifier_assignment',
    /\b(client_?id|user_?pseudo_?id|user_?id|clientId|userId|cid|uid|gclid|fbclid|msclkid|dclid|wbraid|gbraid|_ga|_gid)(\s*[:=]\s*["']?)([A-Za-z0-9._-]{6,})/gi,
    (_m: string, key: string, sep: string) => `${key}${sep}[ANALYTICS_ID]`,
  ],
  // Emails, also percent-encoded as they appear in query strings of page URLs ("?email=jane%40example.com",
  // "jane%2Bnews%40example.com", double-encoded "%2540"). The local part may hold %XX escapes.
  ['email', /\b[A-Za-z0-9._%+-]+(?:@|%(?:25)?40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  ['ip_address', IPV6_RE, '[IP]'],
  ['ip_address', IPV4_RE, '[IP]'],
];

/** Phone-number candidates: an optional + or 00 prefix, digits, and phone separators (space, dot, dash, parentheses). */
const PHONE_CANDIDATE_RE = /(?<![\w.+/-])(?:\+|\b00)?\(?\d[\d\s().-]{5,}\d(?![\w/]|\.\d)/g;

/**
 * Whether a candidate is a phone-like number and not a date, time, range,
 * decimal, grouped thousands, or a plain metric. Deliberately conservative so
 * computed numbers in evidence are never masked: a bare digit run counts only
 * with an international prefix (+ or 00) or a leading trunk 0 (10-11 digits).
 */
export function looksLikePhoneNumber(candidate: string): boolean {
  const m = candidate.trim();
  const withoutDates = m
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g, ' ')
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const digits = withoutDates.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  const international = m.startsWith('+') || m.startsWith('00');
  // IPv4 addresses and dotted version numbers are not phones (IPs are masked by their own rule).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(m)) return false;
  // Numeric or year ranges such as "1000-2000" or "2019-2026".
  const range = /^(\d+)\s*[-\u2013]\s*(\d+)$/.exec(m);
  if (range && range[1]!.length === range[2]!.length && !range[1]!.startsWith('0')) return false;
  // Thousands grouping ("1 000 000", "1.250.000") is a number, not a phone.
  if (/^[1-9]\d{0,2}(?:[ .]\d{3})+$/.test(m)) return false;
  const body = withoutDates.trim();
  const separators = body.replace(/[\d+]/g, '');
  if (!separators.trim() && !/[()]/.test(body)) {
    // Bare digit run.
    return international || (/^0\d{9,10}$/.test(digits) && body.startsWith('0'));
  }
  // A single dot between digits is a decimal number, not a phone.
  if (/^[\d.]+$/.test(body) && (body.match(/\./g) ?? []).length < 2) return false;
  // Phone grouping: at least two groups of 2+ digits (or a parenthesised area code), groups of at most 5 digits
  // unless the number is international.
  const groups = body.split(/[\s().-]+/).filter(Boolean);
  if (groups.length < 2) return international;
  if (!international && groups.some((g) => g.replace(/\D/g, '').length > 5)) return false;
  return groups.filter((g) => g.replace(/\D/g, '').length >= 2).length >= 2;
}

/**
 * JSON-LD keywords, CSS at-rules, and decorators that look like "@handles" but
 * are structure, not people (never masked).
 */
const AT_KEYWORDS = new Set([
  'context', 'type', 'id', 'graph', 'value', 'language', 'list', 'set', 'reverse', 'index', 'base', 'vocab', 'container', 'nest', 'prefix',
  'version', 'direction', 'included', 'json', 'none', 'propagate', 'protected', 'import', 'media', 'font', 'keyframes', 'supports', 'charset',
  'page', 'layer', 'namespace', 'property', 'counter', 'document', 'viewport', 'tailwind', 'apply', 'scope', 'starting', 'screen', 'theme',
  'param', 'returns', 'return', 'see', 'deprecated', 'example', 'throws', 'link', 'since', 'todo',
]);

const HANDLE_RULES: Array<[RegExp, (m: string, ...g: string[]) => string | null]> = [
  // @handle (not an email: those are masked first; not a scoped package such as @scope/name).
  [
    /(^|[^\w@.\-/])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)(?![\w@-]|\/|\.[A-Za-z0-9_])/g,
    (_m: string, lead: string, name: string) => (AT_KEYWORDS.has(name.toLowerCase()) ? null : `${lead}@[HANDLE]`),
  ],
  // Reddit-style u/handle and user/handle (also inside profile links).
  [/(^|[^A-Za-z0-9_])(u|user)\/([A-Za-z0-9_-]{2,})/g, (_m: string, lead: string, prefix: string) => `${lead}${prefix}/[HANDLE]`],
];

export interface PersonalIdentifierOptions {
  /** Also mask phone-like numbers (conservative: dates, ranges, decimals, and grouped thousands are kept). */
  phones?: boolean;
  /** Also mask "@handle" and "u/handle" user handles. */
  handles?: boolean;
}

function applyRule(out: string, re: RegExp, replacement: PiiReplacement, count: () => void): string {
  re.lastIndex = 0;
  return out.replace(re, (...args: unknown[]) => {
    const m = args[0] as string;
    if (typeof replacement === 'string') {
      count();
      return replacement;
    }
    const groups = args.slice(1).filter((a): a is string => typeof a === 'string' || a === undefined).map((a) => a ?? '') as string[];
    const r = replacement(m, ...groups);
    if (r === null) return m;
    count();
    return r;
  });
}

/**
 * Mask personal identifiers. Always: emails, IP addresses, analytics client
 * ids and identifier assignments. With `phones` / `handles`: phone-like
 * numbers and user handles too (used for everything sent to a model).
 */
export function redactPersonalIdentifiers(text: string, opts: PersonalIdentifierOptions = {}): { text: string; redactions: Partial<Record<PiiKind, number>> } {
  let out = text;
  const redactions: Partial<Record<PiiKind, number>> = {};
  const counter = (kind: PiiKind) => () => {
    redactions[kind] = (redactions[kind] ?? 0) + 1;
  };
  for (const [kind, re, replacement] of PII_RULES) {
    // Phones before IPv4 addresses, so a dotted phone number ("06.12.34.56.78") is not half-read as an IP.
    // (IPv6 runs first: its colon-separated groups never look like a phone.)
    if (re === IPV4_RE && opts.phones) out = applyRule(out, PHONE_CANDIDATE_RE, (m: string) => (looksLikePhoneNumber(m) ? '[PHONE]' : null), counter('phone'));
    out = applyRule(out, re, replacement, counter(kind));
  }
  if (opts.handles) for (const [re, replacement] of HANDLE_RULES) out = applyRule(out, re, replacement, counter('handle'));
  return { text: out, redactions };
}

const NUMERIC_CELL_RE = /^[-+]?[$€£]?\d[\d,.\s]*(?:%|[kKmM])?$/;

/**
 * Heuristic: does this text look like a raw metrics dump (many numeric
 * table/CSV rows)? Small tables inside notes are fine.
 */
export function looksLikeRawMetrics(text: string, opts: { minRows?: number; minShare?: number } = {}): boolean {
  const minRows = opts.minRows ?? 25;
  const minShare = opts.minShare ?? 0.5;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < minRows) return false;
  let dataRows = 0;
  for (const line of lines) {
    let cells: string[];
    if (line.startsWith('|')) cells = line.replace(/^\||\|$/g, '').split('|');
    else if (line.includes('\t')) cells = line.split('\t');
    else if ((line.match(/,/g) ?? []).length >= 2 && !/[.!?]\s/.test(line)) cells = line.split(',');
    else continue;
    cells = cells.map((c) => c.trim()).filter((c) => c !== '' && !/^:?-{2,}:?$/.test(c));
    if (cells.length < 3) continue;
    const numeric = cells.filter((c) => NUMERIC_CELL_RE.test(c)).length;
    if (numeric / cells.length >= 0.5) dataRows++;
  }
  return dataRows >= minRows && dataRows / lines.length >= minShare;
}

export type SanitizeResult =
  | { ok: true; text: string; piiRedactions: Partial<Record<PiiKind, number>> }
  | { ok: false; reason: 'secret_detected'; findings: SecretFindingKind[] }
  | { ok: false; reason: 'raw_metrics'; findings: string[] };

/** Apply the memory content policy to one text. */
export function sanitizeForMemory(text: string): SanitizeResult {
  const secrets = detectSecrets(text);
  if (secrets.length) return { ok: false, reason: 'secret_detected', findings: secrets };
  if (looksLikeRawMetrics(text)) return { ok: false, reason: 'raw_metrics', findings: ['numeric table/CSV rows dominate the text'] };
  const pii = redactPersonalIdentifiers(text);
  return { ok: true, text: pii.text, piiRedactions: pii.redactions };
}
