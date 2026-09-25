import { comparableText, extractPageFacts, normalizeText, pageFingerprint } from './html.js';
import type { ContentChange } from './change.js';
import type { PageFetchResult } from './page-fetch.js';
import type { ApprovalActionType } from './types.js';

/**
 * Verify what actually went live. The live page is fetched (read-only) and
 * compared with the machine-checkable parts of the approved artifact. The
 * outcome is recorded as-is: a mismatch or partial match is stored, never
 * hidden, and an unreachable page is "unverified", never "verified".
 *
 * Body content is compared in full, never sampled: EVERY approved paragraph
 * must appear in the live main text (coverage is reported, e.g. "partial:
 * 5/12 paragraphs found"), and live main text that is not in the approved
 * artifact is flagged as unapproved content (for a section change, text that
 * was already on the page before the change is allowed). "match" means every
 * check passed and no unapproved content was found.
 */

export interface LiveExpectations {
  title?: string;
  metaDescription?: string;
  canonical?: string;
  robots?: string;
  redirectTo?: string;
  /** Page must be gone (delete). */
  absent?: boolean;
  /** @deprecated Sampled fragments (no longer produced); treated as the complete paragraph list when given alone. */
  bodyFragments?: string[];
  /** EVERY approved body paragraph, normalized (comparableText); all must appear in the live main text. */
  bodyParagraphs?: string[];
  /** 'full': the approved body is the page's whole main content; 'section': it is one section of an existing page. */
  bodyScope?: 'full' | 'section';
  /** Section changes: the page's main text BEFORE the change (content that may legitimately remain). */
  baselineText?: string | null;
}

export interface BodyCoverage {
  scope: 'full' | 'section';
  paragraphs: { total: number; found: number; missing: string[] };
  /** Live main text absent from the approved artifact (and, for a section change, from the before-snapshot). */
  unapproved: { status: 'none' | 'found' | 'not_checked'; blocks: string[]; note: string | null };
  /** e.g. "complete: 12/12 paragraphs found, no unapproved content" or "partial: 5/12 paragraphs found". */
  summary: string;
}

export interface VerificationCheck {
  name: string;
  expected: string;
  observed: string | null;
  pass: boolean;
}

export type VerificationStatus = 'match' | 'partial' | 'mismatch' | 'unverified';

export interface VerificationResult {
  status: VerificationStatus;
  reason: string | null;
  checks: VerificationCheck[];
  artifactHash: string;
  livePageFingerprint: string | null;
  fetchedAt: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  /** Body comparison coverage (present when the approved change has body content and the page was fetched). */
  coverage?: BodyCoverage;
}

const MAX_FRAGMENTS = 5;
const MIN_FRAGMENT_CHARS = 40;

export function bodyFragments(markdown: string): string[] {
  const paras = markdown
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => comparableText(p))
    .filter((p) => p.length >= MIN_FRAGMENT_CHARS);
  if (paras.length <= MAX_FRAGMENTS) return paras.map((p) => p.slice(0, 200));
  const out: string[] = [];
  for (let i = 0; i < MAX_FRAGMENTS; i++) out.push(paras[Math.floor((i * (paras.length - 1)) / (MAX_FRAGMENTS - 1))]!.slice(0, 200));
  return [...new Set(out)];
}

/** Every paragraph (blank-line separated block) of approved Markdown, normalized for containment checks. */
export function bodyParagraphs(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => comparableText(p))
    .filter((p) => /[\p{L}\p{N}]/u.test(p));
}

export function expectationsFromChange(
  actionType: ApprovalActionType,
  change: ContentChange,
  opts: { bodyScope?: 'full' | 'section'; baselineText?: string | null } = {},
): LiveExpectations {
  const e: LiveExpectations = {};
  if (change.title) e.title = change.title;
  if (change.metaDescription) e.metaDescription = change.metaDescription;
  if (change.canonical) e.canonical = change.canonical;
  if (change.robots) e.robots = change.robots;
  if (change.redirectTo) e.redirectTo = change.redirectTo;
  if (actionType === 'delete_page') e.absent = true;
  if (change.bodyMarkdown) {
    const paras = bodyParagraphs(change.bodyMarkdown);
    if (paras.length) {
      e.bodyParagraphs = paras;
      e.bodyScope = opts.bodyScope ?? 'full';
      if (e.bodyScope === 'section') e.baselineText = opts.baselineText ?? null;
    }
  }
  return e;
}

/** Minimum letters/digits for a leftover live text piece to count as unapproved content (ignores separators and stray words). */
const MIN_UNAPPROVED_CHARS = 15;
const MAX_LISTED = 20;

/** Live text pieces left after removing every known (approved) text. */
function residualPieces(live: string, known: string[]): string[] {
  let pieces = [live];
  for (const k of [...new Set(known.filter((x) => x.length > 0))].sort((a, b) => b.length - a.length)) pieces = pieces.flatMap((p) => p.split(k));
  return pieces.map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_UNAPPROVED_CHARS);
}

function excerpt(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/** Compare the whole approved body with the live main text (coverage + unapproved content). */
export function bodyCoverage(expect: Pick<LiveExpectations, 'bodyParagraphs' | 'bodyFragments' | 'bodyScope' | 'baselineText' | 'title'>, liveMainText: string): BodyCoverage | null {
  const paras = expect.bodyParagraphs ?? expect.bodyFragments ?? [];
  if (!paras.length) return null;
  const scope = expect.bodyScope ?? 'full';
  const live = comparableText(liveMainText);
  const missing = paras.filter((p) => !live.includes(p));
  const found = paras.length - missing.length;
  const known = [...paras, ...(expect.title ? [comparableText(expect.title)] : [])];
  let unapproved: BodyCoverage['unapproved'];
  if (scope === 'full') {
    const blocks = residualPieces(live, known);
    unapproved = { status: blocks.length ? 'found' : 'none', blocks: blocks.slice(0, MAX_LISTED).map((b) => excerpt(b, 160)), note: null };
  } else if (expect.baselineText) {
    const before = comparableText(expect.baselineText);
    const blocks = residualPieces(live, known).filter((b) => !before.includes(b));
    unapproved = { status: blocks.length ? 'found' : 'none', blocks: blocks.slice(0, MAX_LISTED).map((b) => excerpt(b, 160)), note: 'content that was on the page before the change is allowed around the approved section' };
  } else {
    unapproved = { status: 'not_checked', blocks: [], note: 'the approved change is one section of the page and no before-snapshot text is available, so live content outside the section cannot be told apart from unapproved content' };
  }
  const complete = found === paras.length && unapproved.status === 'none';
  const parts = [`${found}/${paras.length} paragraphs found`];
  if (unapproved.status === 'found') parts.push(`${unapproved.blocks.length} unapproved block(s) in the live main text`);
  else if (unapproved.status === 'not_checked') parts.push('unapproved content not checked (no before-snapshot text)');
  else parts.push('no unapproved content');
  return {
    scope,
    paragraphs: { total: paras.length, found, missing: missing.slice(0, MAX_LISTED).map((m) => excerpt(m)) },
    unapproved,
    summary: `${complete ? 'complete' : 'partial'}: ${parts.join(', ')}`,
  };
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

export function verifyLive(expect: LiveExpectations, fetched: PageFetchResult, artifactHash: string): VerificationResult {
  const base = { artifactHash, livePageFingerprint: null, fetchedAt: null, finalUrl: null, httpStatus: null } as const;
  const checks: VerificationCheck[] = [];
  if (expect.absent) {
    const gone = !fetched.ok && fetched.reason === 'http_error' && (fetched.status === 404 || fetched.status === 410);
    if (!fetched.ok && !gone) return { ...base, status: 'unverified', reason: `live page could not be checked (${fetched.reason}: ${fetched.detail})`, checks, httpStatus: fetched.status ?? null };
    checks.push({ name: 'page removed (404/410)', expected: '404 or 410', observed: fetched.ok ? `HTTP ${fetched.page.status}` : `HTTP ${fetched.status}`, pass: gone });
    return { ...base, status: gone ? 'match' : 'mismatch', reason: null, checks, httpStatus: fetched.ok ? fetched.page.status : (fetched.status ?? null) };
  }
  if (!fetched.ok) {
    return { ...base, status: 'unverified', reason: `live page could not be checked (${fetched.reason}: ${fetched.detail})`, checks, httpStatus: fetched.status ?? null };
  }
  const page = fetched.page;
  const facts = extractPageFacts(page.html);
  const eq = (a: string | null | undefined, b: string) => normalizeText(a ?? '') === normalizeText(b);
  if (expect.redirectTo) checks.push({ name: 'redirect target', expected: expect.redirectTo, observed: page.redirectChain.length ? page.finalUrl : null, pass: page.redirectChain.length > 0 && sameUrl(page.finalUrl, expect.redirectTo) });
  if (expect.title) checks.push({ name: 'title', expected: expect.title, observed: facts.title, pass: eq(facts.title, expect.title) });
  if (expect.metaDescription) checks.push({ name: 'meta description', expected: expect.metaDescription, observed: facts.metaDescription, pass: eq(facts.metaDescription, expect.metaDescription) });
  if (expect.canonical) checks.push({ name: 'canonical', expected: expect.canonical, observed: facts.canonical, pass: !!facts.canonical && sameUrl(new URL(facts.canonical, page.finalUrl).href, expect.canonical) });
  if (expect.robots) checks.push({ name: 'meta robots', expected: expect.robots, observed: facts.metaRobots, pass: eq((facts.metaRobots ?? '').toLowerCase(), expect.robots.toLowerCase()) });
  const coverage = bodyCoverage(expect, facts.mainText) ?? undefined;
  if (coverage) {
    const { paragraphs, unapproved } = coverage;
    checks.push({
      name: 'body paragraphs',
      expected: `all ${paragraphs.total} approved paragraph(s)`,
      observed: `${paragraphs.found}/${paragraphs.total} found${paragraphs.missing.length ? `; missing: ${paragraphs.missing.map((m) => `"${m}"`).join(', ')}` : ''}`,
      pass: paragraphs.found === paragraphs.total,
    });
    if (unapproved.status !== 'not_checked') {
      checks.push({
        name: 'unapproved main content',
        expected: 'no live main text beyond the approved artifact',
        observed: unapproved.blocks.length ? `${unapproved.blocks.length} block(s): ${unapproved.blocks.map((b) => `"${b}"`).join(', ')}` : 'none',
        pass: unapproved.status === 'none',
      });
    }
  }
  const fp = pageFingerprint(page.html);
  const common = { artifactHash, livePageFingerprint: fp, fetchedAt: page.fetchedAt, finalUrl: page.finalUrl, httpStatus: page.status, ...(coverage ? { coverage } : {}) };
  if (!checks.length) {
    return { ...common, status: 'unverified', reason: 'the approved change has no machine-checkable fields (free-text change); verify manually. The live page fingerprint is recorded.', checks };
  }
  const passed = checks.filter((c) => c.pass).length;
  // An unchecked part (content outside a section without a before-snapshot) is never reported as a match.
  const uncheckedPart = coverage?.unapproved.status === 'not_checked';
  // Some approved paragraphs live counts as partial, even when the body check as a whole failed.
  const someBodyLive = (coverage?.paragraphs.found ?? 0) > 0;
  const status: VerificationStatus = passed === checks.length ? (uncheckedPart ? 'partial' : 'match') : passed === 0 && !someBodyLive ? 'mismatch' : 'partial';
  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  const reason =
    status === 'match'
      ? null
      : [
          coverage && coverage.summary.startsWith('partial') ? coverage.summary : null,
          failed.length ? `${failed.length} of ${checks.length} check(s) did not match what was approved (${failed.join(', ')})` : null,
          uncheckedPart ? coverage!.unapproved.note : null,
        ]
          .filter(Boolean)
          .join('; ');
  return { ...common, status, reason, checks };
}
