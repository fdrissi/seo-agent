import { afterEach, describe, expect, it } from 'vitest';
import { CHECKS_VERSION, runTechnicalChecks } from '../../../src/crawler/checks.js';
import { createCrawl, insertResult } from '../../../src/crawler/store.js';
import type { SafeFetchResult } from '../../../src/crawler/types.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/**
 * technical_issues provenance (migration 0201): every finding records the
 * checks version that derived it. SYNTHETIC responses for example.test URLs only.
 */
let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const URL_500 = 'https://www.example.test/synthetic-broken';

function serverError(url: string): SafeFetchResult {
  const body = new TextEncoder().encode('synthetic upstream failure');
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 500,
    firstStatus: 500,
    redirectChain: [],
    contentType: 'text/plain',
    headers: { 'content-type': 'text/plain' },
    body,
    text: 'synthetic upstream failure',
    bytes: body.length,
    blockedReason: null,
    errorCode: null,
    error: null,
    retryAfterMs: null,
    durationMs: 5,
    pinned: false,
    fixture: true,
    attempts: 1,
    note: null,
  };
}

function crawlWithServerError(c: TestContext): string {
  const crawlId = createCrawl(c, { kind: 'single_page', config: {}, isSynthetic: true });
  insertResult(c, {
    crawlId,
    requestedUrl: URL_500,
    fetch: serverError(URL_500),
    pageId: null,
    renderMode: 'fixture',
    robotsAllowed: true,
    extraction: null,
    textRef: null,
    blockedReason: null,
    error: null,
    depth: 0,
    discoveredVia: ['seed'],
    inSitemap: null,
  });
  return crawlId;
}

const issueRow = (c: TestContext) =>
  c.db.get<{ transformation_version: string | null; status: string; crawl_id: string }>(
    `SELECT transformation_version, status, crawl_id FROM technical_issues WHERE site_id = ? AND url = ? AND issue_type = 'server_error'`,
    [c.siteId, URL_500],
  );

describe('technical_issues transformation_version', () => {
  it('is a stable, named checks version', () => {
    expect(CHECKS_VERSION).toMatch(/^technical-checks@\d+$/);
  });

  it('records CHECKS_VERSION on a newly opened finding', () => {
    ctx = createTestContext();
    const crawlId = crawlWithServerError(ctx);
    const summary = runTechnicalChecks(ctx, crawlId);
    expect(summary.byType.server_error).toBe(1);
    expect(summary.opened).toBe(1);
    expect(issueRow(ctx)).toEqual({ transformation_version: CHECKS_VERSION, status: 'open', crawl_id: crawlId });
  });

  it('stamps the current version when a finding recorded without one (NULL = unknown) is observed again', () => {
    ctx = createTestContext();
    const t = '2026-09-01T00:00:00.000Z';
    ctx.db.run(
      `INSERT INTO technical_issues (id, site_id, url, issue_type, severity, is_heuristic, confirmed, detail_json, status, first_seen_at, last_seen_at, transformation_version)
       VALUES ('tissue_legacy_synthetic', ?, ?, 'server_error', 'medium', 0, 0, '{}', 'ignored', ?, ?, NULL)`,
      [ctx.siteId, URL_500, t, t],
    );
    const crawlId = crawlWithServerError(ctx);
    const summary = runTechnicalChecks(ctx, crawlId);
    expect(summary.updated).toBe(1);
    expect(summary.opened).toBe(0);
    // The owner's "ignored" decision survives; the provenance is refreshed with the finding.
    expect(issueRow(ctx)).toEqual({ transformation_version: CHECKS_VERSION, status: 'ignored', crawl_id: crawlId });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM technical_issues WHERE site_id = ?', [ctx.siteId])!.n).toBe(1);
  });
});
