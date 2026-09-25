import { pageFingerprint } from './html.js';
import type { PageFetcher } from './page-fetch.js';

/**
 * Pre-execution target recheck. When an approval is requested, the current
 * state of the target is fingerprinted (if it can be fetched) and stored in
 * the approval payload. Immediately before execution the target is
 * fingerprinted again; any difference means the proposal was reviewed against
 * a page that no longer exists in that form, so execution is refused and the
 * approval invalidated.
 */

export type FingerprintResult = { ok: true; fingerprint: string; checkedAt: string; detail: string } | { ok: false; reason: string; detail: string; checkedAt: string };

export interface TargetChecker {
  fingerprint(target: string): Promise<FingerprintResult>;
}

export interface TargetRecheck {
  status: 'unchanged' | 'changed' | 'unverifiable';
  detail: string;
  expectedFingerprint: string | null;
  currentFingerprint: string | null;
  checkedAt: string;
}

/** Fingerprint = SEO-relevant page state; 404/410 = the stable marker `absent:<status>`. */
export function pageTargetChecker(fetcher: PageFetcher, now: () => Date = () => new Date()): TargetChecker {
  return {
    async fingerprint(target: string): Promise<FingerprintResult> {
      const r = await fetcher(target);
      const checkedAt = now().toISOString();
      if (r.ok) return { ok: true, fingerprint: pageFingerprint(r.page.html), checkedAt, detail: `HTTP ${r.page.status} ${r.page.finalUrl}` };
      if (r.reason === 'http_error' && (r.status === 404 || r.status === 410)) return { ok: true, fingerprint: `absent:${r.status}`, checkedAt, detail: `HTTP ${r.status}: target does not exist yet` };
      return { ok: false, reason: r.reason, detail: r.detail, checkedAt };
    },
  };
}

/** A checker for targets that cannot be fetched (e.g. provider/budget targets). */
export const unverifiableTargetChecker: TargetChecker = {
  async fingerprint() {
    return { ok: false, reason: 'not_applicable', detail: 'Target is not a fetchable page.', checkedAt: new Date().toISOString() };
  },
};

export async function recheckTarget(checker: TargetChecker, target: string, expectedFingerprint: string | null | undefined): Promise<TargetRecheck> {
  const current = await checker.fingerprint(target);
  const expected = expectedFingerprint ?? null;
  if (!current.ok) {
    return {
      status: 'unverifiable',
      detail: `Could not fetch the target immediately before execution (${current.reason}: ${current.detail}).`,
      expectedFingerprint: expected,
      currentFingerprint: null,
      checkedAt: current.checkedAt,
    };
  }
  if (!expected) {
    return {
      status: 'unverifiable',
      detail: 'No target fingerprint was captured when the approval was requested (it was requested offline or the page could not be fetched), so a change cannot be detected.',
      expectedFingerprint: null,
      currentFingerprint: current.fingerprint,
      checkedAt: current.checkedAt,
    };
  }
  if (current.fingerprint !== expected) {
    return {
      status: 'changed',
      detail: `The target changed since the approval was requested (${expected.slice(0, 12)} -> ${current.fingerprint.slice(0, 12)}).`,
      expectedFingerprint: expected,
      currentFingerprint: current.fingerprint,
      checkedAt: current.checkedAt,
    };
  }
  return { status: 'unchanged', detail: 'Target unchanged since the approval was requested.', expectedFingerprint: expected, currentFingerprint: current.fingerprint, checkedAt: current.checkedAt };
}
