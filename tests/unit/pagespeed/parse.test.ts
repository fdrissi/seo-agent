import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assessCwv, parseCruxResponse, queryCruxRecord, queryCruxWithFallback, rate } from '../../../src/integrations/pagespeed/crux.js';
import { buildPsiUrl, parseGoogleError, parsePsiField, parsePsiResponse } from '../../../src/integrations/pagespeed/psi.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/pagespeed');
const load = (f: string): unknown => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));

describe('PSI request', () => {
  it('always sends strategy, repeats category, and appends the key last', () => {
    const u = new URL(buildPsiUrl({ url: 'https://www.example.test/a?b=1', strategy: 'MOBILE', categories: ['PERFORMANCE', 'SEO'], apiKey: 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345' }));
    expect(u.origin + u.pathname).toBe('https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed');
    expect(u.searchParams.get('url')).toBe('https://www.example.test/a?b=1');
    expect(u.searchParams.get('strategy')).toBe('MOBILE');
    expect(u.searchParams.getAll('category')).toEqual(['PERFORMANCE', 'SEO']);
    expect([...u.searchParams.keys()].at(-1)).toBe('key');
    expect(new URL(buildPsiUrl({ url: 'https://www.example.test/', strategy: 'DESKTOP' })).searchParams.getAll('category')).toEqual(['PERFORMANCE']);
    expect(new URL(buildPsiUrl({ url: 'https://www.example.test/', strategy: 'DESKTOP' })).searchParams.has('key')).toBe(false);
  });
});

describe('PSI field-data scope', () => {
  it('page-level loadingExperience -> page scope; originLoadingExperience -> origin scope', () => {
    const f = parsePsiField(load('psi-page-level.json'));
    expect(f.best).toBe('page');
    expect(f.page.scope).toBe('page');
    expect(f.page.source).toBe('loadingExperience');
    expect(f.page.overallCategory).toBe('AVERAGE');
    expect(f.page.metrics.INTERACTION_TO_NEXT_PAINT).toMatchObject({ percentile: 240, category: 'AVERAGE', keyVerified: true });
    expect(f.page.metrics.LARGEST_CONTENTFUL_PAINT_MS!.keyVerified).toBe(false);
    expect(f.page.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE!.note).toMatch(/Use CrUX API CLS/);
    expect(f.page.metrics.FIRST_CONTENTFUL_PAINT_MS!.distributions[2]).toEqual({ min: 3000, max: null, proportion: 0.05 });
    expect(f.origin.scope).toBe('origin');
    expect(f.origin.source).toBe('originLoadingExperience');
  });

  it('origin_fallback = true -> no page-level data; the data is origin-level', () => {
    const f = parsePsiField(load('psi-origin-fallback.json'));
    expect(f.page.scope).toBe('unavailable');
    expect(f.page.reason).toMatch(/origin_fallback/);
    expect(f.origin.scope).toBe('origin');
    expect(f.origin.originFallback).toBe(true);
    expect(f.best).toBe('origin');
  });

  it('no metrics anywhere -> unavailable (never zero)', () => {
    const f = parsePsiField(load('psi-no-field.json'));
    expect(f.best).toBe('unavailable');
    expect(f.page.metrics).toEqual({});
    expect(f.origin.reason).toMatch(/No origin-level/);
    expect(parsePsiField({}).best).toBe('unavailable');
  });
});

describe('PSI lab data', () => {
  it('parses Lighthouse scores (0-100), metrics, version, form factor, and never reports INP', () => {
    const p = parsePsiResponse(load('psi-page-level.json'), 'MOBILE');
    expect(p.lab.status).toBe('ok');
    expect(p.lab.performanceScore).toBe(87);
    expect(p.lab.metrics).toMatchObject({ firstContentfulPaintMs: 1650.4, largestContentfulPaintMs: 2890.1, totalBlockingTimeMs: 310, cumulativeLayoutShift: 0.02, speedIndexMs: 3100, serverResponseTimeMs: 120, timeToInteractiveMs: null });
    expect(p.lab.inp).toBeNull();
    expect(p.lab.inpNote).toMatch(/not measured by a lab load/);
    expect(p.lab.disclaimer).toMatch(/not a business outcome/);
    expect(p.lighthouseVersion).toBe('13.0.0');
    expect(p.lab.formFactor).toBe('mobile');
    expect(p.finalUrl).toBe('https://www.example.test/pricing');
    expect(p.analysisUTCTimestamp).toBe('2026-09-24T08:00:00.000Z');
  });

  it('does not invent INP even if an INP-like audit is present in a lab result', () => {
    const p = parsePsiResponse(load('psi-no-field.json'), 'MOBILE');
    expect(p.lab.inp).toBeNull();
    expect(JSON.stringify(p.lab.metrics)).not.toContain('999');
  });

  it('keeps null category scores null and discards results with a runtimeError', () => {
    const fb = parsePsiResponse(load('psi-origin-fallback.json'), 'DESKTOP');
    expect(fb.lab.categories.seo).toBeNull();
    expect(fb.lab.runWarnings).toHaveLength(1);
    const bad = parsePsiResponse(load('psi-runtime-error.json'), 'MOBILE');
    expect(bad.lab.status).toBe('runtime_error');
    expect(bad.lab.runtimeError).toEqual({ code: 'NO_FCP', message: 'The page did not paint any content.' });
    expect(bad.lab.performanceScore).toBeNull();
    expect(bad.lab.metrics.firstContentfulPaintMs).toBeNull();
    expect(parsePsiResponse({}, 'MOBILE').lab.status).toBe('missing');
  });

  it('parses the Google error shape', () => {
    expect(parseGoogleError(load('psi-429-keyless.json'), 429)).toMatchObject({ code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'rateLimitExceeded' });
    expect(parseGoogleError(null, 502).message).toBe('HTTP 502');
  });
});

describe('CrUX API', () => {
  it('parses string CLS values, open-ended bins, ratings, collection period, and URL normalization', () => {
    const r = parseCruxResponse(load('crux-url-phone.json'), 'page');
    expect(r.level).toBe('page');
    expect(r.metrics.cumulative_layout_shift).toMatchObject({ p75: 0.05, rating: 'good' });
    expect(r.metrics.cumulative_layout_shift!.histogram[2]).toEqual({ start: 0.25, end: null, density: 0.04 });
    expect(r.metrics.largest_contentful_paint).toMatchObject({ p75: 2100, rating: 'good' });
    expect(r.metrics.experimental_time_to_first_byte!.rating).toBe('needs_improvement');
    expect(r.collectionPeriod).toEqual({ firstDate: '2026-08-25', lastDate: '2026-09-21' });
    expect(r.normalizedUrl).toBe('https://www.example.test/pricing');
    expect(r.cwvAssessment).toBe('pass');
  });

  it('applies documented thresholds and the Core Web Vitals assessment rules', () => {
    expect(rate('largest_contentful_paint', 2500)).toBe('good');
    expect(rate('largest_contentful_paint', 2501)).toBe('needs_improvement');
    expect(rate('interaction_to_next_paint', 501)).toBe('poor');
    expect(rate('cumulative_layout_shift', 0.1)).toBe('good');
    expect(rate('unknown_metric', 1)).toBeNull();
    expect(rate('largest_contentful_paint', null)).toBeNull();
    const origin = parseCruxResponse(load('crux-origin.json'), 'origin');
    expect(origin.cwvAssessment).toBe('fail'); // CLS poor; INP missing -> LCP + CLS decide
    expect(assessCwv({ largest_contentful_paint: { p75: 1000, rating: 'good', histogram: [] } })).toBe('not_assessable');
  });

  it('sends exactly one of url/origin with the key and treats 404 as insufficient data', async () => {
    const f = fakeFetch([match('POST', 'https://chromeuxreport.googleapis.com/v1/records:queryRecord', () => jsonResponse(load('crux-404.json'), 404))]);
    const r = await queryCruxRecord(f, 'test-key-123456', { url: 'https://www.example.test/a', formFactor: 'PHONE' });
    expect(r.status).toBe('not_found');
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body).toMatchObject({ url: 'https://www.example.test/a', formFactor: 'PHONE' });
    expect(body.origin).toBeUndefined();
    expect(f.calls[0]!.url).toContain('key=test-key-123456');
  });

  it('falls back url -> origin+formFactor -> origin and records which level answered', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const f = fakeFetch([
      (req) => {
        const b = JSON.parse(req.body!);
        bodies.push(b);
        if (b.url) return jsonResponse(load('crux-404.json'), 404);
        return jsonResponse(load('crux-origin.json'));
      },
    ]);
    const r = await queryCruxWithFallback(f, 'test-key-123456', 'https://www.example.test/pricing?x=1', 'PHONE');
    expect(r.scope).toBe('origin');
    expect(r.formFactor).toBe('PHONE');
    expect(r.attempts.map((a) => `${a.level}:${a.status}`)).toEqual(['page:not_found', 'origin:ok']);
    expect(bodies[1]).toMatchObject({ origin: 'https://www.example.test', formFactor: 'PHONE' });

    const all404 = fakeFetch([() => jsonResponse(load('crux-404.json'), 404)]);
    const none = await queryCruxWithFallback(all404, 'k-123456', 'https://www.example.test/x', 'DESKTOP');
    expect(none.scope).toBe('unavailable');
    expect(none.record).toBeNull();
    expect(none.attempts).toHaveLength(3);
    expect(JSON.parse(all404.calls[2]!.body!).formFactor).toBeUndefined();
    expect(none.reason).toMatch(/insufficient real-user data/);

    const forbidden = fakeFetch([() => jsonResponse({ error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } }, 403)]);
    const err = await queryCruxWithFallback(forbidden, 'k-123456', 'https://www.example.test/x', 'PHONE');
    expect(err.scope).toBe('unavailable');
    expect(err.error).toMatchObject({ httpStatus: 403 });
    expect(err.attempts).toHaveLength(1);
  });
});
