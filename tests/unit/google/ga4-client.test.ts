import { afterEach, describe, expect, it } from 'vitest';
import { runReportAll, type Ga4RunReportResponse } from '../../../src/integrations/google/ga4-client.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FAST_RETRY, SYNTHETIC_GA4, ScriptedClient } from '../../integration/google/_helpers.js';

/**
 * runReportAll paging (B3-08). SYNTHETIC GA4 responses: landing pages on
 * example.test only; `rowCount` is present, missing, or dropped per page.
 */
let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function report(total: number, opts: { rowCount: 'always' | 'never' | 'first_only' }) {
  ctx = createTestContext();
  const client = new ScriptedClient((req) => {
    const offset = Number(req.body.offset ?? 0);
    const limit = Number(req.body.limit);
    const n = Math.max(0, Math.min(limit, total - offset));
    const body: Ga4RunReportResponse = {
      dimensionHeaders: [{ name: 'landingPagePlusQueryString' }],
      metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
      ...(n ? { rows: Array.from({ length: n }, (_, i) => ({ dimensionValues: [{ value: `/p${offset + i}` }], metricValues: [{ value: '1' }] })) } : {}),
      ...(opts.rowCount === 'always' || (opts.rowCount === 'first_only' && offset === 0) ? { rowCount: total } : {}),
    };
    return { body };
  });
  const c = { ctx, client, synthetic: true, retry: FAST_RETRY };
  return { client, run: (limit: number, maxPages = 50) => runReportAll(c, SYNTHETIC_GA4, { dateRanges: [{ startDate: '2026-09-01', endDate: '2026-09-01' }], dimensions: [{ name: 'landingPagePlusQueryString' }], metrics: [{ name: 'sessions' }] }, { limit, maxPages }) };
}

describe('runReportAll without rowCount (never read as 0)', () => {
  it('keeps paging past the first page until a short page when rowCount is missing', async () => {
    const { client, run } = report(5, { rowCount: 'never' });
    const r = await run(2);
    expect(r.rows).toHaveLength(5);
    expect(client.calls.map((c) => c.body.offset)).toEqual(['0', '2', '4']);
    expect(r.rowCount).toBeNull();
    expect(r.rowCountMissing).toBe(true);
    expect(r.stoppedAtMaxPages).toBe(false);
    expect(r.warnings!.join(' ')).toMatch(/without a rowCount/);
  });

  it('stops on an empty page when the last full page ends exactly at the end', async () => {
    const { client, run } = report(4, { rowCount: 'never' });
    const r = await run(2);
    expect(r.rows).toHaveLength(4);
    expect(client.calls.map((c) => c.body.offset)).toEqual(['0', '2', '4']);
    expect(r.stoppedAtMaxPages).toBe(false);
  });

  it('marks the report incomplete when the page guard is reached before a short page', async () => {
    const { run } = report(10, { rowCount: 'never' });
    const r = await run(2, 3);
    expect(r.rows).toHaveLength(6);
    expect(r.stoppedAtMaxPages).toBe(true);
    expect(r.rowCount).toBeNull();
    expect(r.warnings!.join(' ')).toMatch(/may be incomplete/);
  });

  it('an empty report without rowCount has no rows and an unknown (null) rowCount, not 0', async () => {
    const { run } = report(0, { rowCount: 'never' });
    const r = await run(2);
    expect(r.rows).toEqual([]);
    expect(r.rowCount).toBeNull();
    expect(r.rowCountMissing).toBe(false);
    expect(r.stoppedAtMaxPages).toBe(false);
  });

  it('keeps the reported total when a later page omits it, and still uses rowCount when present', async () => {
    const first = report(5, { rowCount: 'first_only' });
    const a = await first.run(2);
    expect(a.rows).toHaveLength(5);
    expect(a.rowCount).toBe(5);
    expect(a.rowCountMissing).toBe(false);
    ctx!.cleanup();
    const always = report(5, { rowCount: 'always' });
    const b = await always.run(2);
    expect(b.rows).toHaveLength(5);
    expect(always.client.calls.map((c) => c.body.offset)).toEqual(['0', '2', '4']); // stops at offset >= rowCount, no extra empty page
    expect(b.rowCount).toBe(5);
    expect(b.warnings).toEqual([]);
  });
});
