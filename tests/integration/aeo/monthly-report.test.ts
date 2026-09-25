/**
 * The monthly report's AI-visibility section is built from aiCitationSummary
 * (B6-04): a grounded row without recorded cited URLs (own_site_cited NULL)
 * is "citation unknown", never "not cited", and the claim is marked
 * INCOMPLETE; "mentioned but not cited" comes only from rows that record both
 * the response text and the cited URLs. SYNTHETIC rows on reserved example
 * domains only; offline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildMonthlyReport } from '../../../src/reports/build.js';
import { allClaims, type Claim, type Report } from '../../../src/reports/model.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { insertRow, reportsTestConfig, sid } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function find(report: Report, id: string): Claim {
  const c = allClaims(report).find((x) => x.id === id);
  if (!c) throw new Error(`claim ${id} not found; have: ${allClaims(report).map((x) => x.id).join(', ')}`);
  return c;
}

/** One SYNTHETIC AI answer observation in August 2026 (the monthly period at the default test clock). */
function check(t: TestContext, row: { day: string; grounded?: 0 | 1; brand: 0 | 1 | null; own: 0 | 1 | null; cited?: string[] | null; engine?: string }): void {
  insertRow(t.db, 'ai_citation_checks', {
    id: sid('ai'),
    site_id: t.siteId,
    engine: row.engine ?? 'synthetic-engine',
    query: 'test co review (synthetic)',
    method: 'manual_import',
    is_grounded: row.grounded ?? 1,
    cited_urls_json: row.cited === undefined || row.cited === null ? null : JSON.stringify(row.cited),
    brand_mentioned: row.brand,
    own_site_cited: row.own,
    is_synthetic: 0,
    checked_at: `2026-08-${row.day}T10:00:00.000Z`,
  });
}

describe('monthly AI-visibility section (aiCitationSummary)', () => {
  it('shows "citation unknown in N" for grounded rows without cited URLs, marks the claim INCOMPLETE, and never counts them as not cited', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ features: { aiCitations: true } }) });
    check(ctx, { day: '10', brand: 1, own: 1, cited: ['https://www.example.test/guide'] });
    check(ctx, { day: '11', brand: 1, own: 0, cited: ['https://other.example.invalid/'] });
    // Grounded, brand mentioned, but the cited URLs were not recorded: own_site_cited is NULL (unknown).
    check(ctx, { day: '12', brand: 1, own: null, cited: null });
    // Neither the response text nor the cited URLs were recorded.
    check(ctx, { day: '13', brand: null, own: null, cited: null, engine: 'other-engine' });
    // An ungrounded model response is excluded from every number.
    check(ctx, { day: '14', grounded: 0, brand: 1, own: 1, cited: ['https://www.example.test/'] });
    const b = await buildMonthlyReport(ctx, { statuses: null });
    expect(b.report.period).toMatchObject({ start: '2026-08-01', end: '2026-08-31' });
    expect(b.issues).toEqual([]);

    const c = find(b.report, 'ai.citations');
    expect(c.label).toBe('OBSERVED');
    expect(c.text).toContain('4 grounded AI-search check(s)');
    expect(c.text).toContain('brand mentioned in 3, own site cited in 1, not cited in 1');
    expect(c.text).toContain('mention unknown in 1');
    expect(c.text).toContain('citation unknown in 2');
    expect(c.text).toContain('INCOMPLETE: 2 grounded check(s) have no recorded cited URLs, so whether they cited the site is unknown (not "not cited")');
    expect(c.text).toContain('lower bounds');
    expect(c.reason).toMatch(/^incomplete: /);
    // The unknown rows never become "not cited".
    expect(c.text).not.toMatch(/not cited in (2|3)/);
    expect(c.sourceIds).toHaveLength(4);

    // Mentioned but not cited: only over the 2 rows with both response text and cited URLs.
    const mnc = find(b.report, 'ai.mentioned_not_cited');
    expect(mnc.label).toBe('OBSERVED');
    expect(mnc.text).toContain('Mentioned but not cited: 1 of the 2 grounded check(s) that record both the response text and the cited URLs; cited but not mentioned: 0.');
    expect(mnc.text).toContain('2 grounded check(s) without response text or cited URLs are left out (unknown, never counted as "not cited")');

    expect(find(b.report, 'ai.ungrounded').text).toContain('1 ungrounded model response');
    expect(find(b.report, 'ai.clicks').label).toBe('DATA_UNAVAILABLE');

    const section = b.report.sections.find((s) => s.key === 'ai_visibility')!;
    const table = section.tables.find((t) => t.id === 'ai_visibility.engines')!;
    expect(table.columns).toEqual(['Engine', 'Grounded checks', 'Brand mentioned', 'Mention unknown', 'Own site cited', 'Citation unknown', 'Ungrounded (excluded)']);
    expect(table.rows).toEqual([
      ['other-engine', 1, 0, 1, 0, 1, 0],
      ['synthetic-engine', 3, 3, 0, 1, 1, 1],
    ]);
    expect(section.notes).toContain('A brand mention is not a citation, a citation is not a click, and a click is not a conversion.');
    expect(section.notes.join(' ')).toContain('2 grounded observation(s) have no recorded cited URLs, so their own-site citation is unknown (not "no").');
    expect(b.markdown).toContain('citation unknown in 2');
  });

  it('with no recorded cited URLs at all, citations are unknown and "mentioned but not cited" is DATA_UNAVAILABLE (never zero)', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ features: { aiCitations: true } }) });
    check(ctx, { day: '05', brand: 1, own: null, cited: null });
    check(ctx, { day: '06', brand: 0, own: null, cited: null });
    const b = await buildMonthlyReport(ctx, { statuses: null });
    expect(b.issues).toEqual([]);
    const c = find(b.report, 'ai.citations');
    expect(c.text).toContain('own site cited in 0, not cited in 0, citation unknown in 2');
    expect(c.text).toContain('INCOMPLETE');
    const mnc = find(b.report, 'ai.mentioned_not_cited');
    expect(mnc.label).toBe('DATA_UNAVAILABLE');
    expect(mnc.reason).toMatch(/no grounded check records both the response text and the cited URLs/);
  });

  it('complete rows stay a plain OBSERVED claim; with monitoring disabled the section is DATA_UNAVAILABLE even when rows exist', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ features: { aiCitations: true } }) });
    check(ctx, { day: '10', brand: 1, own: 0, cited: [] });
    check(ctx, { day: '11', brand: 0, own: 1, cited: ['https://www.example.test/'] });
    const on = await buildMonthlyReport(ctx, { statuses: null });
    const c = find(on.report, 'ai.citations');
    expect(c.label).toBe('OBSERVED');
    expect(c.text).toBe('2 grounded AI-search check(s) across synthetic-engine: brand mentioned in 1, own site cited in 1, not cited in 1.');
    expect(c.reason).toBeUndefined();
    expect(find(on.report, 'ai.mentioned_not_cited').text).toContain('Mentioned but not cited: 1 of the 2 grounded check(s)');
    ctx.cleanup();

    ctx = createTestContext({ config: reportsTestConfig() });
    check(ctx, { day: '10', brand: 1, own: 1, cited: ['https://www.example.test/'] });
    const off = await buildMonthlyReport(ctx, { statuses: null });
    const v = find(off.report, 'ai.visibility');
    expect(v.label).toBe('DATA_UNAVAILABLE');
    expect(v.reason).toContain('disabled');
    expect(allClaims(off.report).some((x) => x.id === 'ai.citations')).toBe(false);
  });
});
