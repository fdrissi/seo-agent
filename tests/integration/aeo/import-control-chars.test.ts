/**
 * C1-10: `ai-citations import` stores text without control characters (ESC,
 * BEL, a lone carriage return, C1 controls), as content import does, so a
 * stored query or response can never drive the operator's terminal. SYNTHETIC
 * data only: the invented brand "Qwertle Tools" on reserved *.test hostnames.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importAiCitations } from '../../../src/aeo/import.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { aeoSiteConfig } from '../../fixtures/aeo/config.js';

const contexts: TestContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

const ESC = '\u001b';
const BEL = '\u0007';
const RAW_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

describe('ai-citations import: control characters (C1-10)', () => {
  it('replaces control characters in stored text fields with spaces, keeps newlines, and says so; the raw record keeps the row as supplied', () => {
    const c = createTestContext({ config: aeoSiteConfig(), now: '2026-09-24T09:00:00.000Z' });
    contexts.push(c);
    const hostileQuery = `invoice tool${ESC}]0;owned${BEL} for freelancers`;
    const hostileResponse = `Qwertle Tools${ESC}[8m hidden\u009b2J\rOVERWRITE\r\nsecond line`;
    const file = path.join(c.paths.root, 'observations.json');
    writeFileSync(
      file,
      JSON.stringify({
        _synthetic: true,
        checks: [{ engine: `Perplexity${ESC}[2K`, query: hostileQuery, date: '2026-09-10', grounded: 'yes', response: hostileResponse, cited_urls: 'https://www.qwertle.test/guide', source: `manual${BEL} check` }],
      }),
    );
    const r = importAiCitations(c, file);
    expect(r.status, JSON.stringify(r.rejected)).toBe('succeeded');
    expect(r.warnings.join(' ')).toMatch(/1 row\(s\) contained control characters/);
    const row = c.db.get<{ engine: string; query: string; source_label: string; response_ref: string; brand_mentioned: number }>('SELECT engine, query, source_label, response_ref, brand_mentioned FROM ai_citation_checks WHERE site_id = ?', [c.siteId])!;
    expect(row.engine).toBe('perplexity [2k');
    expect(row.query).toBe('invoice tool ]0;owned for freelancers'); // whitespace runs collapse in a query
    expect(row.source_label).toBe('manual  check');
    for (const v of [row.engine, row.query, row.source_label]) expect(v).not.toMatch(RAW_CONTROL);
    expect(row.brand_mentioned).toBe(1);
    const raw = c.raw.load<{ response: string; query: string; supplied: Record<string, unknown> }>(row.response_ref)!;
    expect(raw.response).toBe('Qwertle Tools [8m hidden 2J OVERWRITE\nsecond line');
    expect(raw.query).toBe(row.query);
    // Provenance: the row exactly as supplied.
    expect(raw.supplied.query).toBe(hostileQuery);
  });
});
