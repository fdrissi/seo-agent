import { isIsoDate, isValidTimeZone } from '../core/time.js';

/**
 * Answer parsers for the setup wizard. Each returns either a value or a
 * specific, actionable error (the wizard re-prompts on errors). Parsers never
 * invent values: blank optional answers mean "unknown".
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type Parser<T> = (raw: string) => Parsed<T>;

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const bad = <T = never>(error: string): Parsed<T> => ({ ok: false, error });

export function requiredText(maxLength = 500): Parser<string> {
  return (raw) => {
    const v = raw.trim();
    if (!v) return bad('A value is required.');
    if (v.length > maxLength) return bad(`Use at most ${maxLength} characters.`);
    return ok(v);
  };
}

/** Blank means unknown (null). */
export function optionalText(maxLength = 2000): Parser<string | null> {
  return (raw) => {
    const v = raw.trim();
    if (!v) return ok(null);
    if (v.length > maxLength) return bad(`Use at most ${maxLength} characters.`);
    return ok(v);
  };
}

export function httpUrl(raw: string): Parsed<string> {
  const v = raw.trim();
  if (!v) return bad('A URL is required.');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad('Use an absolute URL including the scheme, e.g. https://www.example.com/');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('Only http(s) URLs are supported.');
  if (u.username || u.password) return bad('URLs must not contain credentials.');
  return ok(v);
}

export const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

export function hostname(raw: string): Parsed<string> {
  const v = raw.trim().toLowerCase();
  if (!v) return bad('A hostname is required.');
  if (/[/:@?#\s]/.test(v)) return bad(`"${raw.trim()}" is not a bare hostname; use e.g. www.example.com (no scheme, path, or port).`);
  if (!HOSTNAME_RE.test(v)) return bad(`"${raw.trim()}" is not a valid hostname.`);
  return ok(v);
}

/** Comma-separated list; each item parsed; duplicates removed (order kept). Blank = empty list. */
export function commaList<T extends string>(item: Parser<T>, opts: { min?: number; max?: number } = {}): Parser<T[]> {
  return (raw) => {
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out: T[] = [];
    for (const it of items) {
      const r = item(it);
      if (!r.ok) return bad(r.error);
      if (!out.includes(r.value)) out.push(r.value);
    }
    if (opts.min !== undefined && out.length < opts.min) return bad(opts.min === 1 ? 'Enter at least one value.' : `Enter at least ${opts.min} values.`);
    if (opts.max !== undefined && out.length > opts.max) return bad(`Enter at most ${opts.max} values.`);
    return ok(out);
  };
}

export function countryCode(raw: string): Parsed<string> {
  const v = raw.trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(v)) return bad(`"${raw.trim()}" is not an ISO 3166-1 country code (e.g. EE, DE, US).`);
  return ok(v);
}

export function languageCode(raw: string): Parsed<string> {
  const v = raw.trim();
  if (!/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v)) return bad(`"${v}" is not a BCP 47 language tag (e.g. en, et, de-AT).`);
  const [lang, ...rest] = v.split('-');
  return ok([lang!.toLowerCase(), ...rest].join('-'));
}

export function currencyCode(raw: string): Parsed<string | null> {
  const v = raw.trim().toUpperCase();
  if (!v) return ok(null);
  if (!/^[A-Z]{3}$/.test(v)) return bad(`"${raw.trim()}" is not an ISO 4217 currency code (e.g. EUR, USD).`);
  return ok(v);
}

export function timeZone(opts: { optional: boolean }): Parser<string | null> {
  return (raw) => {
    const v = raw.trim();
    if (!v) return opts.optional ? ok(null) : bad('A time zone is required.');
    if (/^[+-]?\d/.test(v) || /^(UTC|GMT)[+-]/i.test(v)) return bad('Use an IANA time zone name such as "Europe/Tallinn", not a UTC offset.');
    if (!isValidTimeZone(v)) return bad(`"${v}" is not a valid IANA time zone (e.g. Europe/Tallinn, America/New_York).`);
    return ok(v);
  };
}

export function integer(opts: { min: number; max: number }): Parser<number> {
  return (raw) => {
    const v = raw.trim();
    if (!/^\d+$/.test(v)) return bad(`Enter a whole number between ${opts.min} and ${opts.max}.`);
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) return bad(`Enter a whole number between ${opts.min} and ${opts.max}.`);
    return ok(n);
  };
}

export function optionalInteger(opts: { min: number; max: number }): Parser<number | null> {
  const p = integer(opts);
  return (raw) => (raw.trim() ? p(raw) : ok(null));
}

/** Non-negative decimal amount with at most 6 fractional digits (kept as a string). */
export function decimal(opts: { optional?: boolean } = {}): Parser<string | null> {
  return (raw) => {
    const v = raw.trim().replace(/^\$/, '');
    if (!v) return opts.optional ? ok(null) : bad('Enter an amount such as 5.00.');
    if (!/^\d+(\.\d{1,6})?$/.test(v)) return bad('Use a non-negative decimal amount with at most 6 fractional digits, e.g. 5.00');
    return ok(v);
  };
}

export function yesNo(defaultValue: boolean): Parser<boolean> {
  return (raw) => {
    const v = raw.trim().toLowerCase();
    if (!v) return ok(defaultValue);
    if (['y', 'yes'].includes(v)) return ok(true);
    if (['n', 'no'].includes(v)) return ok(false);
    return bad('Answer y or n.');
  };
}

/** Pick one option by number or by its exact value. */
export function choice<T extends string>(options: readonly T[], defaultValue?: T): Parser<T> {
  return (raw) => {
    const v = raw.trim();
    if (!v && defaultValue !== undefined) return ok(defaultValue);
    if (/^\d+$/.test(v)) {
      const idx = Number(v) - 1;
      if (idx >= 0 && idx < options.length) return ok(options[idx]!);
    }
    const match = options.find((o) => o.toLowerCase() === v.toLowerCase());
    if (match) return ok(match);
    return bad(`Choose one of: ${options.map((o, i) => `${i + 1}) ${o}`).join(', ')}.`);
  };
}

export function isoDate(opts: { optional: boolean }): Parser<string | null> {
  return (raw) => {
    const v = raw.trim();
    if (!v) return opts.optional ? ok(null) : bad('A date is required (YYYY-MM-DD).');
    if (!isIsoDate(v)) return bad('Use the format YYYY-MM-DD.');
    return ok(v);
  };
}

/** Site path pattern such as /pricing or /blog/* (must start with "/"). */
export function sitePath(raw: string): Parsed<string> {
  const v = raw.trim();
  if (!v.startsWith('/')) return bad(`"${v}" must start with "/" (a path on your own site, e.g. /pricing).`);
  if (/\s/.test(v)) return bad(`"${v}" must not contain spaces.`);
  return ok(v);
}

/** GA4 event name rules: starts with a letter; letters, digits, underscores; at most 40 characters. Case is kept. */
export function ga4EventName(raw: string): Parsed<string> {
  const v = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(v)) return bad(`"${v}" is not a valid GA4 event name (letters, digits, underscores; starts with a letter; max 40 characters). Names are case-sensitive: copy them exactly from GA4.`);
  return ok(v);
}

export function ga4PropertyId(raw: string): Parsed<string | null> {
  const v = raw.trim().replace(/^properties\//, '');
  if (!v) return ok(null);
  if (/^G-/i.test(v)) return bad(`"${v}" is a measurement ID (data stream), not the property ID. Use the numeric Property ID from GA4 Admin > Property details.`);
  if (!/^\d{4,20}$/.test(v)) return bad('The GA4 property ID is numeric, e.g. 123456789 (GA4 Admin > Property details).');
  return ok(v);
}

export function gscPropertyFormat(raw: string): Parsed<string | null> {
  const v = raw.trim();
  if (!v) return ok(null);
  if (/^sc-domain:[a-z0-9.-]+$/i.test(v)) return ok(v);
  if (/^https?:\/\/.+\/$/i.test(v)) return ok(v);
  if (/^https?:\/\/[^/]+$/i.test(v)) return bad(`URL-prefix properties end with "/" exactly as shown in Search Console (for example "${v}/"). Copy the property exactly; it is never guessed.`);
  return bad('Use the exact property: "sc-domain:example.com" (domain property) or a URL prefix ending in "/" such as "https://www.example.com/".');
}

export function subreddit(raw: string): Parsed<string> {
  const v = raw.trim().replace(/^\/?r\//i, '');
  if (!/^[A-Za-z0-9_]{2,21}$/.test(v)) return bad(`"${raw.trim()}" is not a subreddit name (letters, digits, underscores).`);
  return ok(v);
}

export function modelId(raw: string): Parsed<string | null> {
  const v = raw.trim();
  if (!v) return ok(null);
  if (/\s/.test(v) || v.length > 200) return bad('Model ids contain no spaces; copy the id exactly from `models list`.');
  return ok(v);
}

export function cronExpression(raw: string): Parsed<string> {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (!/^\S+( \S+){4,5}$/.test(v)) return bad('Use a cron expression with 5 fields, e.g. "0 7 * * 1".');
  return ok(v);
}
