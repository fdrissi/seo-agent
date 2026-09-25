/**
 * Crawler-trap prevention. A URL is refused (recorded with
 * blocked_reason='crawl_trap') when it matches a pattern that can generate an
 * unbounded URL space:
 *   - too long / too many path segments,
 *   - a path segment repeated more than `maxRepeatedSegment` times (/a/b/a/b/a/b),
 *   - session-id parameters (;jsessionid=, ?sid=, ?PHPSESSID=),
 *   - too many query parameters, or too many distinct query variants per path,
 *   - calendar-like URLs beyond a small cap per URL template,
 *   - numeric URL templates (pagination/ID explosions) beyond a cap.
 * Limits are deliberately conservative; hitting one is a coverage limit, not
 * proof that the site is broken.
 */

export interface TrapLimits {
  maxUrlLength: number;
  maxPathSegments: number;
  maxRepeatedSegment: number;
  maxQueryParams: number;
  maxQueryVariantsPerPath: number;
  maxCalendarVariantsPerTemplate: number;
  maxNumericTemplateVariants: number;
}

export const DEFAULT_TRAP_LIMITS: TrapLimits = {
  maxUrlLength: 2_048,
  maxPathSegments: 15,
  maxRepeatedSegment: 2,
  maxQueryParams: 8,
  maxQueryVariantsPerPath: 20,
  maxCalendarVariantsPerTemplate: 12,
  maxNumericTemplateVariants: 50,
};

const SESSION_PARAMS = new Set(['sid', 'sessionid', 'session_id', 'phpsessid', 'jsessionid', 'aspsessionid', 'cfid', 'cftoken', 'zenid', 'oscsid']);
const CALENDAR_PARAMS = new Set(['date', 'day', 'month', 'year', 'week', 'calendar', 'cal', 'start', 'end', 'from', 'to', 'ical', 'tribe-bar-date', 'eventdisplay']);
const DATE_IN_PATH = /(^|\/)(19|20)\d{2}([-/_](0?[1-9]|1[0-2]))([-/_](0?[1-9]|[12]\d|3[01]))?(\/|$)/;
const DATE_VALUE = /^((19|20)\d{2}([-/_]?(0?[1-9]|1[0-2]))?([-/_]?(0?[1-9]|[12]\d|3[01]))?|\d{1,2}|\d{10,13})$/;

export type TrapCheck = { trap: false } | { trap: true; reason: string };

function template(u: URL): string {
  return `${u.pathname.replace(/\d+/g, '#')}?${[...u.searchParams.keys()].sort().join('&')}`;
}

export function isCalendarLike(u: URL): boolean {
  if (DATE_IN_PATH.test(u.pathname)) return true;
  if (/(^|\/)(calendar|kalender|agenda)(\/|$)/i.test(u.pathname) && /\/\d{1,4}(\/|$)/.test(u.pathname)) return true;
  for (const [k, v] of u.searchParams) {
    if (CALENDAR_PARAMS.has(k.toLowerCase()) && DATE_VALUE.test(v)) return true;
  }
  return false;
}

export class TrapDetector {
  readonly limits: TrapLimits;
  private readonly queryVariants = new Map<string, Set<string>>();
  private readonly calendarTemplates = new Map<string, Set<string>>();
  private readonly numericTemplates = new Map<string, Set<string>>();
  readonly hits: Array<{ url: string; reason: string }> = [];

  constructor(limits: Partial<TrapLimits> = {}) {
    this.limits = { ...DEFAULT_TRAP_LIMITS, ...limits };
  }

  /** Check a URL and, if accepted, count it toward the variant limits. */
  check(input: string | URL): TrapCheck {
    const u = typeof input === 'string' ? new URL(input) : input;
    const res = this.evaluate(u);
    if (res.trap) this.hits.push({ url: u.toString(), reason: res.reason });
    return res;
  }

  private evaluate(u: URL): TrapCheck {
    const L = this.limits;
    const full = u.toString();
    if (full.length > L.maxUrlLength) return { trap: true, reason: `URL longer than ${L.maxUrlLength} characters` };
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length > L.maxPathSegments) return { trap: true, reason: `more than ${L.maxPathSegments} path segments` };
    const counts = new Map<string, number>();
    for (const s of segments) {
      const k = s.toLowerCase();
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      if (n > L.maxRepeatedSegment) return { trap: true, reason: `path segment "${s}" repeats ${n} times (possible relative-link loop)` };
    }
    if (/;(jsessionid|sid|phpsessid)=/i.test(u.pathname)) return { trap: true, reason: 'session id in path' };
    const keys = [...u.searchParams.keys()];
    if (keys.some((k) => SESSION_PARAMS.has(k.toLowerCase()))) return { trap: true, reason: 'session id query parameter' };
    if (keys.length > L.maxQueryParams) return { trap: true, reason: `more than ${L.maxQueryParams} query parameters` };

    if (u.search) {
      const set = this.queryVariants.get(u.pathname) ?? new Set<string>();
      if (!set.has(u.search) && set.size >= L.maxQueryVariantsPerPath) {
        return { trap: true, reason: `more than ${L.maxQueryVariantsPerPath} query-string variants for ${u.pathname} (query parameter explosion)` };
      }
      set.add(u.search);
      this.queryVariants.set(u.pathname, set);
    }
    const tpl = template(u);
    if (isCalendarLike(u)) {
      const set = this.calendarTemplates.get(tpl) ?? new Set<string>();
      if (!set.has(full) && set.size >= L.maxCalendarVariantsPerTemplate) {
        return { trap: true, reason: `calendar-like URL pattern ${tpl} exceeded ${L.maxCalendarVariantsPerTemplate} variants (possible calendar trap)` };
      }
      set.add(full);
      this.calendarTemplates.set(tpl, set);
    }
    if (/\d/.test(u.pathname + u.search)) {
      const set = this.numericTemplates.get(tpl) ?? new Set<string>();
      if (!set.has(full) && set.size >= L.maxNumericTemplateVariants) {
        return { trap: true, reason: `numeric URL template ${tpl} exceeded ${L.maxNumericTemplateVariants} variants` };
      }
      set.add(full);
      this.numericTemplates.set(tpl, set);
    }
    return { trap: false };
  }
}

/** Path prefix/glob match for crawl.excludedPaths and crawl.protectedPaths ("/admin", "/tmp/*", "*.pdf"). */
export function matchesPathPattern(pathname: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (!p.includes('*')) return pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`) || (p.endsWith('/') && pathname === p.slice(0, -1));
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${p.endsWith('*') ? '' : '$'}`);
  return re.test(pathname);
}

export function matchesAnyPath(pathname: string, patterns: readonly string[]): string | null {
  for (const p of patterns) if (matchesPathPattern(pathname, p)) return p;
  return null;
}
