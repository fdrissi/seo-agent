/**
 * Offline demo routing (SYNTHETIC fixtures only; the global fetch throws).
 *
 * The fixture GA4 property reports key-event rates that never exceed 1, so
 * their 0-1 vs 0-100 scale is not established (and the fixture rates are not
 * integer-consistent, so the sync cannot prove it either). That must never
 * route every page with sessions to INVALID_OR_INCOMPLETE_DATA: conversions
 * are "not assessed" (RATE_SCALE_UNVERIFIED note) and the search-based routes
 * run. The demo's weekly primary recommendation is pinned so a change in
 * routing shows up here (and in docs/DEMO.md).
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspacePaths } from '../../src/config/paths.js';
import { runDemo, type DemoResult } from '../../src/demo/index.js';
import { DEMO_START, openReadOnly, tempDir, type TempDir } from './helpers.js';

let tmp: TempDir | undefined;
let result: DemoResult;
let dir: string;

beforeAll(async () => {
  tmp = tempDir('demo-routing');
  dir = path.join(tmp.root, 'demo');
  result = await runDemo({ dir, startAt: DEMO_START });
}, 600_000);

afterAll(() => {
  tmp?.cleanup();
  tmp = undefined;
});

function step(id: string) {
  const s = result.steps.find((x) => x.id === id);
  if (!s) throw new Error(`demo step ${id} missing: ${result.steps.map((x) => x.id).join(', ')}`);
  return s;
}

interface Decision {
  page_id: string;
  route: string;
  reason_codes_json: string;
  period_start: string;
  period_end: string;
}

describe('offline demo routing with an unverified GA4 rate scale', () => {
  it('completes, and the weekly primary recommendation is a targeted SEO audit (pinned)', () => {
    expect(result.ok).toBe(true);
    const rec = step('recommendation').data as { kind: string | null; actionType: string | null };
    expect(rec).toMatchObject({ kind: 'primary', actionType: 'targeted_seo_audit' });
  });

  it('routes fixture pages with sessions on their search signals, never all to INVALID_OR_INCOMPLETE_DATA', () => {
    const resumeJob = (step('resume').data as { jobId: string }).jobId;
    const db = openReadOnly(workspacePaths(dir).dbFile);
    try {
      const decisions = db.prepare("SELECT page_id, route, reason_codes_json, period_start, period_end FROM route_decisions WHERE site_id = ? AND job_id = ? AND subject_type = 'page'").all(result.site.id, resumeJob) as unknown as Decision[];
      expect(decisions.length).toBeGreaterThan(0);
      const period = { start: decisions[0]!.period_start, end: decisions[0]!.period_end };
      const withSessions = new Set(
        (
          db
            .prepare(
              "SELECT page_id FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic' AND segment_key = '' AND page_id IS NOT NULL AND date BETWEEN ? AND ? GROUP BY page_id HAVING SUM(sessions) > 0",
            )
            .all(result.site.id, period.start, period.end) as Array<{ page_id: string }>
        ).map((r) => r.page_id),
      );
      const routed = decisions.filter((d) => withSessions.has(d.page_id));
      expect(routed.length).toBeGreaterThan(1);
      // Not all INVALID; in fact none, and never because of the unverified scale.
      expect(routed.filter((d) => d.route !== 'INVALID_OR_INCOMPLETE_DATA').length).toBe(routed.length);
      const reasons = routed.map((d) => JSON.parse(d.reason_codes_json) as Array<{ code: string; kind: string; detail: string }>);
      expect(reasons.flat().filter((r) => r.code === 'PRIMARY_RATE_UNAVAILABLE')).toEqual([]);
      // The unverified scale is a note naming the confirm option, never a routing reason.
      const scaleNotes = reasons.flat().filter((r) => r.code === 'RATE_SCALE_UNVERIFIED');
      expect(scaleNotes.length).toBeGreaterThan(0);
      expect(scaleNotes.every((n) => n.kind === 'note')).toBe(true);
      expect(scaleNotes[0]!.detail).toContain('--confirm-rate-scale fraction|percent');
      // Every scale note names the command as the CLI accepts it: --as "<your name>" is required (R3-NF-G7).
      for (const n of scaleNotes) expect(n.detail).toContain('--confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"');
      // Search-based routes are produced for the fixture pages.
      expect(routed.some((d) => ['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY'].includes(d.route))).toBe(true);
      // Stored fixture rates stay 'undetermined' (nothing proved or confirmed the scale); nothing was guessed.
      expect(Number((db.prepare("SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND primary_session_rate IS NOT NULL AND primary_session_rate_scale <> 'undetermined'").get(result.site.id) as { n: number }).n)).toBe(0);
      expect(Number((db.prepare('SELECT COUNT(*) AS n FROM ga4_rate_scale_confirmations WHERE site_id = ?').get(result.site.id) as { n: number }).n)).toBe(0);
    } finally {
      db.close();
    }
  });
});
