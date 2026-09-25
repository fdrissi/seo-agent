/**
 * Optional AI-citation monitoring (spec 17): manual import, stored
 * observations, summary, list, and the honest disabled status. SYNTHETIC
 * data only (tests/fixtures/aeo): the invented brand "Qwertle Tools" on
 * reserved *.test hostnames; files written by the tests contain invented
 * answers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AI_CITATION_IMPORT_VERSION, importAiCitations } from '../../../src/aeo/import.js';
import { AI_CITATION_API_NOT_IMPLEMENTED, aiCitationStatus } from '../../../src/aeo/status.js';
import { AI_CITATION_SEMANTICS, aiCitationSummary, listAiCitationChecks, resolveAiCitationPeriod } from '../../../src/aeo/summary.js';
import { isAppError } from '../../../src/core/errors.js';
import { ensureSite } from '../../../src/database/sites.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { AEO_TIME_ZONE, OBSERVATIONS_CSV, OBSERVATIONS_JSON, aeoSiteConfig } from '../../fixtures/aeo/config.js';

const contexts: TestContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

function newCtx(opts: { enabled?: boolean; dryRun?: boolean } = {}): TestContext {
  const c = createTestContext({ config: aeoSiteConfig({ enabled: opts.enabled ?? true }), now: '2026-09-24T09:00:00.000Z', ...(opts.dryRun ? { dryRun: true } : {}) });
  contexts.push(c);
  return c;
}

function writeFile(c: TestContext, name: string, content: string): string {
  const p = path.join(c.paths.root, name);
  writeFileSync(p, content);
  return p;
}

type Stored = {
  id: string;
  engine: string;
  query: string;
  prompt: string | null;
  location: string | null;
  method: string;
  is_grounded: number;
  response_ref: string | null;
  cited_urls_json: string | null;
  brand_mentioned: number | null;
  own_site_cited: number | null;
  is_synthetic: number;
  checked_at: string;
  source_label: string | null;
  checked_date: string | null;
  checked_date_tz: string | null;
  checked_at_precision: string | null;
  response_sha256: string | null;
  transformation_version: string | null;
  collected_at: string | null;
};

const stored = (c: TestContext) => c.db.all<Stored>('SELECT * FROM ai_citation_checks WHERE site_id = ? ORDER BY checked_at, engine', [c.siteId]);
const count = (c: TestContext) => c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_citation_checks WHERE site_id = ?', [c.siteId])!.n;

const SEPT = { start: '2026-09-01', end: '2026-09-30' };

describe('disabled by default (features.aiCitations)', () => {
  it('is off in the default configuration and reports an honest disabled status', () => {
    const c = newCtx({ enabled: false });
    expect(c.settings.features.aiCitations).toBe(false);
    const s = aiCitationStatus(c);
    expect(s).toMatchObject({ enabled: false, state: 'disabled', spending: { chargeable: false } });
    expect(s.detail).toMatch(/DATA_UNAVAILABLE, not zero/);
    expect(s.collectors).toEqual([
      expect.objectContaining({ id: 'manual_import', state: 'disabled' }),
      expect.objectContaining({ id: 'api', state: 'not_implemented', detail: AI_CITATION_API_NOT_IMPLEMENTED }),
    ]);
    expect(AI_CITATION_API_NOT_IMPLEMENTED).toMatch(/no endpoint is invented/);
  });

  it('refuses to import while disabled and writes nothing', () => {
    const c = newCtx({ enabled: false });
    let err: unknown;
    try {
      importAiCitations(c, OBSERVATIONS_CSV);
    } catch (e) {
      err = e;
    }
    expect(isAppError(err) && err.code).toBe('INTEGRATION_DISABLED');
    expect((err as Error).message).toMatch(/features\.aiCitations/);
    expect(count(c)).toBe(0);
  });

  it('the summary says "disabled" and reports no numbers (disabled is not zero)', () => {
    const c = newCtx({ enabled: false });
    const s = aiCitationSummary(c, SEPT);
    expect(s.status).toBe('disabled');
    expect(s.brandMentions.status).toBe('unavailable');
    expect(s.ownSiteCitations.status).toBe('unavailable');
    expect(s.mentionedNotCited.status).toBe('unavailable');
    expect(s.clicks.status).toBe('unavailable');
    expect(s.conversions.status).toBe('unavailable');
    expect(JSON.stringify(s)).not.toMatch(/"mentioned":0/);
  });
});

describe('ai-citations import (manual-import adapter)', () => {
  it('stores each observation with provenance; brand mention and own-site citation are computed in code', () => {
    const c = newCtx();
    const r = importAiCitations(c, OBSERVATIONS_CSV);
    expect(r).toMatchObject({ status: 'succeeded', rowsRead: 6, accepted: 6, inserted: 6, unchanged: 0, synthetic: true, method: 'manual_import', grounded: 5, ungrounded: 1 });
    expect(r.brandMentioned).toEqual({ yes: 3, no: 2, unknown: 1 });
    expect(r.ownSiteCited).toEqual({ yes: 2, no: 2, unknown: 2 });
    expect(r.warnings.join(' ')).toMatch(/Ignored columns brand_mentioned: brand mention and own-site citation are computed in code/);
    expect(r.warnings.join(' ')).toMatch(/never reported as live search measurements/);
    expect(r.dateRange).toEqual({ start: '2026-09-10', end: '2026-09-15', timeZone: 'mixed' });

    const rows = stored(c);
    expect(rows).toHaveLength(6);
    expect(rows.every((x) => x.method === 'manual_import' && x.is_synthetic === 1 && x.transformation_version?.startsWith(AI_CITATION_IMPORT_VERSION))).toBe(true);
    const by = (engine: string, query: string) => rows.find((x) => x.engine === engine && x.query === query)!;

    // Mentioned AND cited (www host); competitor URL kept as cited.
    const pplx = by('perplexity', 'best invoice tool for freelancers');
    expect(pplx).toMatchObject({ is_grounded: 1, brand_mentioned: 1, own_site_cited: 1, location: 'Estonia', source_label: 'manual check', checked_at_precision: 'day', checked_date: '2026-09-10', checked_date_tz: AEO_TIME_ZONE });
    expect(JSON.parse(pplx.cited_urls_json!)).toEqual(['https://www.qwertle.test/guide', 'https://www.example.com/review']);
    // Day precision: 12:00 in the stated zone (New York is UTC-4 in September; read from the IANA database).
    expect(pplx.checked_at).toBe('2026-09-10T16:00:00.000Z');

    // Mentioned, NOT cited (explicit "none" -> []), exact instant.
    const aio = by('google ai overviews', 'invoice tool comparison');
    expect(aio).toMatchObject({ brand_mentioned: 1, own_site_cited: 0, cited_urls_json: '[]', checked_at: '2026-09-11T08:30:00.000Z', checked_at_precision: 'instant', checked_date: '2026-09-11' });

    // Cited (non-www host is listed too), NOT mentioned; per-row time zone; the file's "brand_mentioned = yes" is ignored.
    const bing = by('bing copilot', 'how to send invoices online');
    expect(bing).toMatchObject({ brand_mentioned: 0, own_site_cited: 1, checked_date: '2026-09-12', checked_date_tz: 'Europe/Tallinn', checked_at: '2026-09-12T09:00:00.000Z', source_label: 'visibility tool export' });

    // Ungrounded model response stored as provided (is_grounded = 0); cited URLs not recorded -> NULL.
    const gpt = by('chatgpt', 'best invoice tool for freelancers');
    expect(gpt).toMatchObject({ is_grounded: 0, brand_mentioned: 1, own_site_cited: null, cited_urls_json: null, prompt: 'What is the best invoice tool for freelancers?' });

    // No response text and no cited URLs: both unknown (NULL), never 0.
    const blank = by('perplexity', 'invoice templates');
    expect(blank).toMatchObject({ brand_mentioned: null, own_site_cited: null, response_sha256: null, cited_urls_json: null });

    // "Qwertleish" is not the brand; a subdomain is not the site (not in allowedHostnames).
    const alt = by('perplexity', 'qwertle alternatives');
    expect(alt).toMatchObject({ brand_mentioned: 0, own_site_cited: 0 });

    // The response lives in the private raw store, referenced per row.
    const raw = c.raw.load<{ response: string | null; method: string; row: number; isGrounded: boolean; classification: { matchedBrandTerms: string[] | null } }>(pplx.response_ref!);
    expect(raw).toMatchObject({ method: 'manual_import', row: 4, isGrounded: true, response: 'Qwertle Tools is often recommended for freelancers because it is simple.' });
    expect(raw!.classification.matchedBrandTerms).toEqual(['qwertle tools', 'qwertle']);
    expect(pplx.response_ref!.startsWith(`raw:${c.siteId}/ai-citations/`)).toBe(true);
    expect(readFileSync(path.join(c.paths.rawDir, pplx.response_ref!.slice(4)), 'utf8')).toContain('Qwertle Tools is often recommended');
    // Every stored row has its own raw record.
    expect(new Set(rows.map((x) => x.response_ref)).size).toBe(6);

    // Audit trail.
    const audit = c.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE site_id = ? AND event_type = 'ai_citations.imported'", [c.siteId])!;
    expect(JSON.parse(audit.details_json)).toMatchObject({ inserted: 6, method: 'manual_import', synthetic: true, sha256: r.sha256 });
  });

  it('imports JSON: explicit [] vs null cited URLs, boolean or text grounded, offsets, duplicate URLs removed', () => {
    const c = newCtx();
    const r = importAiCitations(c, OBSERVATIONS_JSON);
    expect(r).toMatchObject({ status: 'succeeded', inserted: 3, synthetic: true, grounded: 2, ungrounded: 1 });
    const rows = stored(c);
    const withOffset = rows.find((x) => x.location === 'Estonia')!;
    expect(withOffset).toMatchObject({ checked_at: '2026-09-16T07:00:00.000Z', checked_at_precision: 'instant', checked_date: '2026-09-16', cited_urls_json: '[]', own_site_cited: 0, brand_mentioned: 1 });
    const latvia = rows.find((x) => x.location === 'Latvia')!;
    expect(latvia).toMatchObject({ is_grounded: 0, brand_mentioned: null, own_site_cited: null });
    const aiMode = rows.find((x) => x.engine === 'google ai mode')!;
    expect(aiMode).toMatchObject({ is_grounded: 1, brand_mentioned: 1, own_site_cited: 1, location: null });
    expect(JSON.parse(aiMode.cited_urls_json!)).toEqual(['https://www.qwertle.test/pricing']);
  });

  it('a re-import changes nothing; a different value for a stored observation is a conflict and the stored row is kept', () => {
    const c = newCtx();
    importAiCitations(c, OBSERVATIONS_CSV);
    const again = importAiCitations(c, OBSERVATIONS_CSV);
    expect(again).toMatchObject({ status: 'succeeded', inserted: 0, unchanged: 6, conflicts: [] });
    expect(count(c)).toBe(6);

    const changed = writeFile(
      c,
      'changed.csv',
      readFileSync(OBSERVATIONS_CSV, 'utf8').replace('https://www.qwertle.test/guide https://www.example.com/review', 'https://www.example.com/review'),
    );
    const r = importAiCitations(c, changed);
    expect(r.status).toBe('partial');
    expect(r.conflicts).toEqual([expect.objectContaining({ row: 4, differs: ['cited_urls'] })]);
    expect(count(c)).toBe(6);
    const kept = c.db.get<{ own_site_cited: number }>("SELECT own_site_cited FROM ai_citation_checks WHERE site_id = ? AND engine = 'perplexity' AND query = 'best invoice tool for freelancers'", [c.siteId])!;
    expect(kept.own_site_cited).toBe(1);
  });

  it('refuses the whole file on an invalid row (grounded is never guessed) unless --skip-invalid', () => {
    const c = newCtx();
    const csv = [
      '# SYNTHETIC test rows',
      'engine,query,date,grounded,response,cited_urls',
      'perplexity,q1,2026-09-10,yes,Qwertle helps.,none',
      'perplexity,q2,2026-09-10,,Qwertle helps.,none',
      'perplexity,q3,2026-09-10T10:00:00,yes,,',
      'perplexity,q4,2026-12-01,yes,,',
      'perplexity,q5,2026-09-10,maybe,,',
      'perplexity,q6,2026-09-10,yes,,ftp://files.example.com/a',
      ',q7,2026-09-10,yes,,',
      'perplexity,q1,2026-09-10,yes,Qwertle helps.,none',
    ].join('\n');
    const f = writeFile(c, 'bad.csv', csv);
    const r = importAiCitations(c, f);
    expect(r.status).toBe('failed');
    expect(count(c)).toBe(0);
    const errs = Object.fromEntries(r.rejected.map((e) => [e.row, e.errors.join('; ')]));
    // Row numbers are file lines (the comment line counts).
    expect(errs[4]).toMatch(/grounded is required/);
    expect(errs[5]).toMatch(/no time zone/);
    expect(errs[6]).toMatch(/in the future/);
    expect(errs[7]).toMatch(/grounded must be yes or no/);
    expect(errs[8]).toMatch(/http or https/);
    expect(errs[9]).toMatch(/engine is required/);
    expect(errs[10]).toMatch(/duplicate of row 3/);
    expect(Object.keys(errs)).toHaveLength(7);

    const partial = importAiCitations(c, f, { skipInvalid: true });
    expect(partial).toMatchObject({ status: 'partial', inserted: 1 });
    expect(count(c)).toBe(1);
  });

  it('refuses a file without the required columns and explains why grounded is required', () => {
    const c = newCtx();
    const f = writeFile(c, 'no-grounded.csv', 'engine,query,date\nperplexity,q,2026-09-10\n');
    let err: unknown;
    try {
      importAiCitations(c, f);
    } catch (e) {
      err = e;
    }
    expect(isAppError(err) && err.code).toBe('VALIDATION_FAILED');
    expect((err as Error).message).toMatch(/missing required column\(s\): grounded/);
    expect(isAppError(err) && err.hint).toMatch(/never guessed/);
  });

  it('labels owner files as real data (is_synthetic = 0) unless declared synthetic or --synthetic', () => {
    const c = newCtx();
    const f = writeFile(c, 'owner.csv', 'engine,query,date,grounded\nperplexity,q,2026-09-10,yes\n');
    const r = importAiCitations(c, f, { sourceLabel: 'owner spot check' });
    expect(r.synthetic).toBe(false);
    expect(stored(c)[0]).toMatchObject({ is_synthetic: 0, source_label: 'owner spot check', brand_mentioned: null, own_site_cited: null });
    const f2 = writeFile(c, 'owner2.csv', 'engine,query,date,grounded\nperplexity,q2,2026-09-10,yes\n');
    expect(importAiCitations(c, f2, { synthetic: true }).synthetic).toBe(true);
  });

  it('a dry run validates and classifies but writes nothing (no rows, no raw files, no audit)', () => {
    const c = newCtx({ dryRun: true });
    const r = importAiCitations(c, OBSERVATIONS_CSV);
    expect(r).toMatchObject({ status: 'preview', preview: true, accepted: 6, inserted: 0, checkIds: [] });
    expect(r.brandMentioned).toEqual({ yes: 3, no: 2, unknown: 1 });
    expect(count(c)).toBe(0);
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'ai_citations.imported'")!.n).toBe(0);
  });
});

describe('aiCitationSummary: mention, citation, click, and conversion stay apart', () => {
  it('counts only grounded observations and keeps unknowns explicit', () => {
    const c = newCtx();
    importAiCitations(c, OBSERVATIONS_CSV);
    const s = aiCitationSummary(c, SEPT);
    expect(s.status).toBe('observed');
    expect(s.containsSynthetic).toBe(true);
    expect(s.period).toEqual({ start: '2026-09-01', end: '2026-09-30', timeZone: AEO_TIME_ZONE });
    expect(s.checks).toEqual({ total: 6, grounded: 5, ungroundedExcluded: 1 });
    // The ungrounded ChatGPT response mentions the brand but is NOT counted.
    expect(s.brandMentions).toEqual({ status: 'incomplete', reason: '1 grounded observation(s) have no response text', partialValue: { mentioned: 2, notMentioned: 2, unknown: 1 } });
    expect(s.ownSiteCitations).toEqual({ status: 'incomplete', reason: '1 grounded observation(s) have no recorded cited URLs', partialValue: { cited: 2, notCited: 2, unknown: 1 } });
    expect(s.mentionedNotCited).toMatchObject({ status: 'incomplete', partialValue: 1 });
    expect(s.citedNotMentioned).toMatchObject({ status: 'incomplete', partialValue: 1 });
    expect(s.clicks).toEqual({ status: 'unavailable', reason: expect.stringMatching(/a citation is not a click/) });
    expect(s.conversions).toEqual({ status: 'unavailable', reason: expect.stringMatching(/a click is not a conversion/) });
    expect(s.semantics).toBe(AI_CITATION_SEMANTICS);
    expect(s.notes.join(' ')).toMatch(/1 ungrounded model response\(s\) were excluded from every number/);
    expect(s.notes.join(' ')).toMatch(/not a complete or representative measurement/);
    expect(s.byEngine.find((e) => e.engine === 'chatgpt')).toEqual({ engine: 'chatgpt', grounded: 0, ungroundedExcluded: 1, brandMentioned: 0, brandMentionUnknown: 0, ownSiteCited: 0, ownSiteCitationUnknown: 0 });
    expect(s.byEngine.find((e) => e.engine === 'perplexity')).toMatchObject({ grounded: 3, brandMentioned: 1, brandMentionUnknown: 1, ownSiteCited: 1, ownSiteCitationUnknown: 1 });
    expect(s.ownCitedUrls).toEqual([
      { url: 'https://qwertle.test/pricing?utm_source=copilot', observations: 1 },
      { url: 'https://www.qwertle.test/guide', observations: 1 },
    ]);
    expect(s.sourceLabels).toEqual(['manual check', 'visibility tool export']);
  });

  it('reports observed (not incomplete) counts when every grounded observation is fully recorded', () => {
    const c = newCtx();
    importAiCitations(c, OBSERVATIONS_JSON);
    const s = aiCitationSummary(c, '2026-09');
    expect(s.brandMentions).toEqual({ status: 'observed', value: { mentioned: 2, notMentioned: 0, unknown: 0 } });
    expect(s.ownSiteCitations).toEqual({ status: 'observed', value: { cited: 1, notCited: 1, unknown: 0 } });
    expect(s.mentionedNotCited).toEqual({ status: 'observed', value: 1 });
    expect(s.citedNotMentioned).toEqual({ status: 'observed', value: 0 });
  });

  it('filters by the observation date in the period zone, and "no observations" is no_data, never zero', () => {
    const c = newCtx();
    importAiCitations(c, OBSERVATIONS_CSV);
    const s = aiCitationSummary(c, { start: '2026-09-12', end: '2026-09-13' });
    expect(s.checks).toEqual({ total: 2, grounded: 1, ungroundedExcluded: 1 });
    const empty = aiCitationSummary(c, '2026-08');
    expect(empty.status).toBe('no_data');
    expect(empty.brandMentions).toEqual({ status: 'unavailable', reason: 'no AI-citation observations were recorded for 2026-08-01 to 2026-08-31' });
    expect(empty.notes.join(' ')).toMatch(/not the same as zero visibility/);
  });

  it('with only ungrounded responses, no visibility number is reported', () => {
    const c = newCtx();
    const f = writeFile(c, 'ungrounded.csv', '# SYNTHETIC\nengine,query,date,grounded,response,cited_urls\nchatgpt,q,2026-09-10,no,Qwertle is great.,https://www.qwertle.test/\n');
    importAiCitations(c, f);
    const s = aiCitationSummary(c, SEPT);
    expect(s.status).toBe('observed');
    expect(s.checks).toEqual({ total: 1, grounded: 0, ungroundedExcluded: 1 });
    expect(s.brandMentions).toEqual({ status: 'unavailable', reason: expect.stringMatching(/not live search measurements/) });
    expect(s.ownSiteCitations.status).toBe('unavailable');
    expect(s.ownCitedUrls).toEqual([]);
  });

  it('is scoped to the site (parameterized by site_id)', () => {
    const c = newCtx();
    importAiCitations(c, OBSERVATIONS_CSV);
    const other = aeoSiteConfig({ id: 'aeo-other-site' });
    ensureSite(c.db, other, { source: 'file', now: new Date('2026-09-20T00:00:00Z') });
    c.db.run(
      `INSERT INTO ai_citation_checks (id, site_id, engine, query, method, is_grounded, brand_mentioned, own_site_cited, is_synthetic, checked_at) VALUES ('aic_other', 'aeo-other-site', 'perplexity', 'q', 'manual_import', 1, 1, 1, 1, '2026-09-20T12:00:00.000Z')`,
    );
    expect(aiCitationSummary(c, SEPT).checks.total).toBe(6);
    expect(listAiCitationChecks(c, SEPT).checks.some((x) => x.id === 'aic_other')).toBe(false);
    expect(aiCitationStatus(c).stored.total).toBe(6);
  });

  it('validates periods', () => {
    const c = newCtx();
    expect(resolveAiCitationPeriod(c, '2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31', timeZone: AEO_TIME_ZONE });
    expect(resolveAiCitationPeriod(c, '2026-02-01..2026-02-28')).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
    expect(() => resolveAiCitationPeriod(c, 'last month')).toThrow(/YYYY-MM/);
    expect(() => resolveAiCitationPeriod(c, { start: '2026-09-30', end: '2026-09-01' })).toThrow(/after its end/);
    expect(() => resolveAiCitationPeriod(c, { start: '2026-09-01', end: '2026-09-30', timeZone: '+03:00' })).toThrow(/IANA/);
  });
});

describe('listAiCitationChecks', () => {
  it('labels each row by kind and keeps unknown flags null', () => {
    const c = newCtx();
    importAiCitations(c, OBSERVATIONS_CSV);
    const l = listAiCitationChecks(c, SEPT);
    expect(l.total).toBe(6);
    expect(l.checks.map((x) => x.date)).toEqual(['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10']);
    const gpt = l.checks.find((x) => x.engine === 'chatgpt')!;
    expect(gpt).toMatchObject({ isGrounded: false, kind: 'ungrounded_model_response', citedUrls: null, ownCitedUrls: null, ownSiteCited: null, brandMentioned: true, isSynthetic: true });
    const bing = l.checks.find((x) => x.engine === 'bing copilot')!;
    expect(bing).toMatchObject({ kind: 'grounded_answer_observation', ownCitedUrls: ['https://qwertle.test/pricing?utm_source=copilot'], brandMentioned: false, ownSiteCited: true, checkedAtPrecision: 'day' });
    expect(listAiCitationChecks(c, SEPT, { groundedOnly: true }).total).toBe(5);
    expect(listAiCitationChecks(c, SEPT, { engine: 'Perplexity' }).total).toBe(3);
    expect(listAiCitationChecks(c, SEPT, { limit: 2 })).toMatchObject({ total: 6, checks: [expect.anything(), expect.anything()] });
  });
});
