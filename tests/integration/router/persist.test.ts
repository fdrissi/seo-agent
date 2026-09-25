import { afterEach, describe, expect, it } from 'vitest';
import { observed } from '../../../src/core/measured.js';
import { IntentClassifierRules } from '../../../src/router/intent.js';
import { evaluateRoute } from '../../../src/router/rules.js';
import { persistQueryIntents, persistRouteDecision, routeContentSignal, routeSite } from '../../../src/router/router.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { baseInput, T } from '../../fixtures/seo/route-input.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

describe('route decision persistence', () => {
  it('stores route, reason codes, notes, trace, decided_by, rules_version, and period', () => {
    ctx = createTestContext();
    const d = evaluateRoute({ ...baseInput(), siteId: ctx.siteId, pageId: null as never, technical: { confirmed: [], suspected: [{ source: 'technical_issue', type: 'missing_meta_description', severity: 'low', confirmed: false, detail: 'x' }], inspection: null, latestCrawlStatus: 200 } }, T);
    const id = persistRouteDecision(ctx.db, { ...d, pageId: null }, { now: ctx.clock.now() });
    const row = ctx.db.get<{ route: string; subject_type: string; reason_codes_json: string; inputs_json: string; decided_by: string; rules_version: string; period_start: string; period_end: string }>('SELECT * FROM route_decisions WHERE id = ?', [id])!;
    expect(row).toMatchObject({ route: 'HEALTHY', subject_type: 'page', decided_by: 'rule', period_start: '2026-08-25', period_end: '2026-09-21' });
    expect(row.rules_version).toBe(d.rulesVersion);
    const codes = JSON.parse(row.reason_codes_json) as Array<{ code: string; kind: string }>;
    expect(codes.filter((c) => c.kind === 'reason').map((c) => c.code)).toContain('SUFFICIENT_EXPOSURE');
    expect(codes.filter((c) => c.kind === 'note').map((c) => c.code)).toContain('SUSPECTED_TECHNICAL_ISSUE');
    const inputs = JSON.parse(row.inputs_json);
    expect(inputs.trace).toHaveLength(12);
    expect(inputs.nextStep).toMatch(/unchanged/);
  });

  it('stores site-level and content-signal decisions', () => {
    ctx = createTestContext();
    const site = routeSite({ siteId: ctx.siteId, period: { start: '2026-08-25', end: '2026-09-21' }, gsc: 'complete', gscDetail: '', ga4: 'complete', ga4Detail: '', conversionDefinition: 'configured', totalImpressions: observed(100), windowDays: 28, notSetShare: observed(0) }, T)!;
    persistRouteDecision(ctx.db, site, { now: ctx.clock.now() });
    const rules = new IntentClassifierRules({ brandAliases: [] });
    const sig = routeContentSignal({ siteId: ctx.siteId, signalId: 'sig_1', text: 'how to repair a widget?', origin: 'manual', signalType: 'question', occurrences: 2, businessTerms: ['widget repair'] }, rules.classify('how to repair a widget?'), T);
    persistRouteDecision(ctx.db, sig, { now: ctx.clock.now() });
    const rows = ctx.db.all<{ subject_type: string; route: string; query: string | null }>('SELECT subject_type, route, query FROM route_decisions WHERE site_id = ? ORDER BY subject_type', [ctx.siteId]);
    expect(rows).toEqual([
      { subject_type: 'content_signal', route: 'CONTENT_OPPORTUNITY', query: 'how to repair a widget?' },
      { subject_type: 'site', route: 'LOW_DATA', query: null },
    ]);
  });

  it('records query intents without overwriting manual or SERP-derived intents', () => {
    ctx = createTestContext();
    const now = ctx.clock.now();
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, intent, intent_source, first_seen_at) VALUES ('kw_manual', ?, 'Blue Widgets', 'blue widgets', NULL, 'commercial', 'manual', ?)", [ctx.siteId, now.toISOString()]);
    const rules = new IntentClassifierRules({ brandAliases: ['Acme'] });
    const r1 = persistQueryIntents(ctx.db, ctx.siteId, [rules.classify('blue widgets'), rules.classify('acme login')], now);
    expect(r1).toEqual({ inserted: 1, updated: 0 });
    expect(ctx.db.get<{ intent: string; intent_source: string }>("SELECT intent, intent_source FROM keywords WHERE id = 'kw_manual'")).toEqual({ intent: 'commercial', intent_source: 'manual' });
    const acme = ctx.db.get<{ intent: string; is_branded: number; intent_source: string }>("SELECT intent, is_branded, intent_source FROM keywords WHERE site_id = ? AND normalized = 'acme login'", [ctx.siteId])!;
    expect(acme).toEqual({ intent: 'navigational', is_branded: 1, intent_source: 'rule' });
    const r2 = persistQueryIntents(ctx.db, ctx.siteId, [{ ...rules.classify('acme login'), intent: 'transactional', decidedBy: 'model' }], now);
    expect(r2).toEqual({ inserted: 0, updated: 1 });
    expect(ctx.db.get<{ intent_source: string }>("SELECT intent_source FROM keywords WHERE site_id = ? AND normalized = 'acme login'", [ctx.siteId])!.intent_source).toBe('model');
  });

  it('reuses an existing keyword row of any language (preferring language NULL) instead of inserting a duplicate (A3-11)', () => {
    ctx = createTestContext();
    const now = ctx.clock.now();
    // Research recorded the query with a language (DataForSEO); routing must not add a language-NULL twin.
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, intent, intent_source, first_seen_at) VALUES ('kw_en', ?, 'red widgets', 'red widgets', 'en', NULL, NULL, ?)", [ctx.siteId, now.toISOString()]);
    const rules = new IntentClassifierRules({ brandAliases: [] });
    expect(persistQueryIntents(ctx.db, ctx.siteId, [rules.classify('red widgets')], now)).toEqual({ inserted: 0, updated: 1 });
    expect(ctx.db.all<{ id: string; language: string | null; intent_source: string }>("SELECT id, language, intent_source FROM keywords WHERE site_id = ? AND normalized = 'red widgets'", [ctx.siteId])).toEqual([{ id: 'kw_en', language: 'en', intent_source: 'rule' }]);
    // With a language-NULL row as well, that row is preferred; a SERP-derived intent is never overwritten.
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, intent, intent_source, first_seen_at) VALUES ('kw_null', ?, 'green widgets', 'green widgets', NULL, 'commercial', 'serp', ?)", [ctx.siteId, now.toISOString()]);
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, intent, intent_source, first_seen_at) VALUES ('kw_de', ?, 'green widgets', 'green widgets', 'de', NULL, NULL, ?)", [ctx.siteId, '2020-01-01T00:00:00.000Z']);
    expect(persistQueryIntents(ctx.db, ctx.siteId, [rules.classify('green widgets')], now)).toEqual({ inserted: 0, updated: 0 });
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM keywords WHERE site_id = ? AND normalized = 'green widgets'", [ctx.siteId])!.n).toBe(2);
    expect(ctx.db.get<{ intent_source: string | null }>("SELECT intent_source FROM keywords WHERE id = 'kw_de'")!.intent_source).toBeNull();
  });
});
