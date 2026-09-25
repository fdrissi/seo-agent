import { describe, expect, it } from 'vitest';
import { batchTruncatedDates, requestChannelView, requestSegmentScope, segmentShapeOf } from '../../../src/seo/coverage.js';
import { coverageStatus, isBlockingIssue } from '../../../src/seo/page-analysis.js';
import { coverageFrom } from '../../../src/seo/coverage.js';

// Issue rows exactly as src/crawler/checks.ts writes them (synthetic).
const issue = (issue_type: string, severity: string, confirmed: boolean, is_heuristic = false) => ({ issue_type, severity, confirmed: confirmed ? 1 : 0, is_heuristic: is_heuristic ? 1 : 0 });

describe('isBlockingIssue (crawler vocabulary)', () => {
  it('treats confirmed access/indexability failures as blockers', () => {
    for (const [type, severity] of [
      ['broken_internal_link', 'high'],
      ['sitemap_url_not_ok', 'medium'],
      ['redirect_loop', 'high'],
      ['redirect_chain_too_long', 'high'],
      ['access_blocked', 'high'],
      ['robots_blocked_in_sitemap', 'high'],
      ['robots_blocked_protected', 'critical'],
      ['accidental_noindex', 'medium'],
      ['canonical_target_not_ok', 'high'],
    ] as const) {
      expect(isBlockingIssue(issue(type, severity, true))).toBe(true);
    }
  });

  it('never treats suspicions, heuristics, or intentional-looking low/info observations as blockers', () => {
    expect(isBlockingIssue(issue('broken_internal_link', 'medium', false))).toBe(false); // 5xx on a link: may be transient
    expect(isBlockingIssue(issue('server_error', 'medium', false))).toBe(false);
    expect(isBlockingIssue(issue('access_blocked', 'info', true))).toBe(false); // member area not in sitemap
    expect(isBlockingIssue(issue('title_length', 'info', false, true))).toBe(false);
    expect(isBlockingIssue(issue('duplicate_title', 'low', false, true))).toBe(false);
    expect(isBlockingIssue(issue('suspected_duplicate_content', 'medium', false))).toBe(false);
    expect(isBlockingIssue(issue('missing_title', 'medium', true))).toBe(false); // confirmed, but not an access failure
    expect(isBlockingIssue(issue('anything', 'critical', true))).toBe(true);
  });
});

describe('batch scoping helpers', () => {
  it('reads the channel view and segment set a request produces', () => {
    expect(requestChannelView(JSON.stringify({ view: 'google_organic' }))).toBe('google_organic');
    expect(requestChannelView(JSON.stringify({ type: 'web' }))).toBeNull();
    expect(requestSegmentScope(JSON.stringify({ dimensions: ['date', 'page'] }))).toEqual({ shape: '', fixed: null });
    expect(requestSegmentScope(JSON.stringify({ dimensions: ['date', 'page', 'query', 'device', 'country'] }))).toEqual({ shape: 'country,device', fixed: null });
    expect(requestSegmentScope(JSON.stringify({ dimensions: ['date', 'page'], dimensionFilterGroups: [{ filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: 'VIDEO' }] }] }))).toEqual({ shape: 'searchAppearance', fixed: 'searchAppearance=VIDEO' });
    expect(requestSegmentScope(JSON.stringify({ type: 'web' }))).toBeNull(); // legacy/fixture: accepted for any segment
    expect(segmentShapeOf('device=MOBILE;country=usa')).toBe('country,device');
    expect(segmentShapeOf('')).toBe('');
  });

  it('attributes truncation per date when recorded, conservatively otherwise', () => {
    expect(batchTruncatedDates({ truncated: 0, status: 'succeeded', coverage_json: null })).toBe('none');
    expect(batchTruncatedDates({ truncated: 1, status: 'partial', coverage_json: null })).toBe('all');
    expect(batchTruncatedDates({ truncated: 1, status: 'partial', coverage_json: JSON.stringify({ truncatedDates: ['2026-09-03'] }) })).toEqual(new Set(['2026-09-03']));
    expect(batchTruncatedDates({ truncated: 1, status: 'partial', coverage_json: JSON.stringify({ truncatedDates: [], retirement: { skippedChunks: [{ start: '2026-09-01', end: '2026-09-02', reasons: ['pagination stopped at the page guard'] }, { start: '2026-09-05', end: '2026-09-05', reasons: ['1 malformed row(s) could not be keyed'] }] } }) })).toEqual(new Set(['2026-09-01', '2026-09-02']));
    // Truncated but nothing recorded: every date of the batch.
    expect(batchTruncatedDates({ truncated: 1, status: 'partial', coverage_json: JSON.stringify({ truncatedDates: [] }) })).toBe('all');
  });

  it('reports truncation as a site-level warning, not an incomplete status', () => {
    const truncatedOnly = coverageStatus(coverageFrom('2026-09-01', '2026-09-03', { '2026-09-02': { state: 'final', truncated: true } }, 'final'), 'Search Console');
    expect(truncatedOnly.status).toBe('complete');
    expect(truncatedOnly.warning).toMatch(/1 date\(s\) hit a documented row limit/);
    const missing = coverageStatus(coverageFrom('2026-09-01', '2026-09-03', { '2026-09-03': 'missing' }, 'final'), 'Search Console');
    expect(missing.status).toBe('incomplete');
  });
});
