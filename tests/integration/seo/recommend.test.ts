import { afterEach, describe, expect, it } from 'vitest';
import type { RouteDecision } from '../../../src/router/types.js';
import { prepareSiteAnalysis, routeAllPages } from '../../../src/seo/page-analysis.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { assembleRecommendation, candidateFromAnalysis, isRejectingDecision, loadCandidates, loadPriorContext, markSynthetic, persistRecommendationSet, type CandidateOpportunity, type ComparisonForRecommendation, type PriorContext } from '../../../src/seo/recommend.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';
import { HOST, scenarioConfig, seedScenario } from '../../fixtures/seo/scenario.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const emptyPrior = (): PriorContext => ({ activeExperiments: [], concludedExperiments: [], decisions: [], rejectedRecommendations: [], learnings: [], memory: { status: 'not_configured', items: [] } });

function cand(o: Partial<CandidateOpportunity> & { pageId: string; route: CandidateOpportunity['route'] }): CandidateOpportunity {
  return {
    id: `opp_${o.pageId}`,
    url: `${HOST}/${o.pageId}`,
    query: null,
    isBranded: false,
    score: 50,
    scoringVersion: 'scoring@1.0.0',
    rawCounts: { impressions: 5000, clicks: 100, position: 7, sessions: 500, convertingSessions: 10 },
    evidenceQuality: 0.9,
    reasons: [{ code: 'QUERY_POSITION_IN_RANGE', detail: 'synthetic' }],
    isProtected: false,
    periodStart: '2026-08-24',
    periodEnd: '2026-09-20',
    ...o,
  };
}

const opts = { today: '2026-09-24', reviewDays: 28, lowTrafficReviewDays: 56 };

describe('recommendation assembly (pure selection)', () => {
  it('returns ONE primary action plus at most three secondary observations', () => {
    const cands = ['a', 'b', 'c', 'd', 'e', 'f'].map((p, i) => cand({ pageId: p, route: 'RANKING_OPPORTUNITY', score: 80 - i * 5 }));
    const set = assembleRecommendation('test-site', { candidates: cands, siteDecision: null, prior: emptyPrior(), ...opts });
    expect(set.primary.kind).toBe('primary');
    expect(set.primary.pageId).toBe('a');
    expect(set.primary.actionType).toBe('targeted_seo_audit');
    expect(set.primary.reviewDate).toBe('2026-10-22');
    expect(set.secondary).toHaveLength(3);
    expect(set.secondary.every((s) => s.kind === 'secondary' && s.proposedChange === null)).toBe(true);
    const labels = new Set(set.primary.claims.map((c) => c.label));
    expect(labels).toEqual(new Set(['OBSERVED', 'INFERRED', 'HYPOTHESIS', 'RECOMMENDATION']));
  });

  it('prefers non-branded evidence and keeps branded candidates separate', () => {
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'brand', route: 'CTR_OPPORTUNITY', isBranded: true, score: 90 }), cand({ pageId: 'generic', route: 'CTR_OPPORTUNITY', score: 60 })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(set.primary.pageId).toBe('generic');
    expect(set.primary.details.segment).toBe('non_branded');
  });

  it('excludes rejected ideas, repeated tests, and pages with active experiments', () => {
    const prior = emptyPrior();
    prior.decisions.push({ id: 'd1', subjectType: 'page', subjectId: 'a', decision: 'rejected', reason: 'owner prefers current copy', decidedAt: '2026-09-01' });
    prior.concludedExperiments.push({ id: 'x1', pageId: 'b', type: 'title_meta', status: 'negative', updatedAt: '2026-08-01' });
    prior.activeExperiments.push({ id: 'x2', pageId: 'c', type: 'content_section', status: 'observing' });
    prior.rejectedRecommendations.push({ id: 'r1', pageId: 'd', actionType: 'title_snippet_investigation', title: 'x', updatedAt: '2026-09-02' });
    const set = assembleRecommendation('test-site', {
      candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', score: 90 }), cand({ pageId: 'b', route: 'CTR_OPPORTUNITY', score: 85 }), cand({ pageId: 'c', route: 'RANKING_OPPORTUNITY', score: 80 }), cand({ pageId: 'd', route: 'CTR_OPPORTUNITY', score: 75 }), cand({ pageId: 'e', route: 'RANKING_OPPORTUNITY', score: 40 })],
      siteDecision: null,
      prior,
      ...opts,
    });
    expect(set.primary.pageId).toBe('e');
    expect(set.excluded.map((x) => x.pageId)).toEqual(['a', 'b', 'c', 'd']);
    expect(set.excluded[1]!.reason).toMatch(/not re-testing/);
  });

  it('puts measurement repair and confirmed technical blockers before optimization', () => {
    const invalid: RouteDecision = { subjectType: 'site', siteId: 'test-site', pageId: null, query: null, route: 'INVALID_OR_INCOMPLETE_DATA', reasons: [{ code: 'MISSING_CONVERSION_DEFINITION', detail: 'no primary event' }], notes: [], trace: [], decidedBy: 'rule', rulesVersion: 'r', period: null, nextStep: '', inputsSummary: {} };
    const a = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY' })], siteDecision: invalid, prior: emptyPrior(), ...opts });
    expect(a.primary.kind).toBe('repair_measurement');
    expect(a.secondary[0]!.pageId).toBe('a');
    const b = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', score: 95 }), cand({ pageId: 't', route: 'TECHNICAL_BLOCKER', score: 30, reasons: [{ code: 'CONFIRMED_TECHNICAL_ISSUE', detail: 'noindex' }] })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(b.primary.actionType).toBe('technical_investigation');
    expect(b.primary.risks).toMatch(/approval/);
  });

  it('returns explicit no-action, collect-more-evidence, and bootstrap decisions', () => {
    const none = assembleRecommendation('test-site', { candidates: [], siteDecision: null, routeCounts: { HEALTHY: 8, EXPERIMENT_ACTIVE: 1 }, prior: emptyPrior(), ...opts });
    expect(none.primary).toMatchObject({ kind: 'no_action', actionType: 'none' });
    const more = assembleRecommendation('test-site', { candidates: [], siteDecision: null, routeCounts: { LOW_DATA: 6, UNSURE: 2, HEALTHY: 1 }, prior: emptyPrior(), ...opts });
    expect(more.primary.kind).toBe('collect_more_evidence');
    const weak = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', score: 12, evidenceQuality: 0.2 })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(weak.primary.kind).toBe('collect_more_evidence');
    const low: RouteDecision = { subjectType: 'site', siteId: 'test-site', pageId: null, query: null, route: 'LOW_DATA', reasons: [{ code: 'SITE_LOW_DATA', detail: '80 impressions' }], notes: [], trace: [], decidedBy: 'rule', rulesVersion: 'r', period: null, nextStep: '', inputsSummary: {} };
    const boot = assembleRecommendation('test-site', { candidates: [], siteDecision: low, prior: emptyPrior(), ...opts });
    expect(boot.primary).toMatchObject({ kind: 'collect_more_evidence', actionType: 'bootstrap' });
    expect(boot.primary.claims.find((c) => c.label === 'RECOMMENDATION')!.text).toMatch(/offer-page brief/);
    const healthyPage = assembleRecommendation('test-site', { candidates: [], siteDecision: null, pageRoute: { route: 'HEALTHY', reasons: [], pageId: 'p', url: `${HOST}/p` }, prior: emptyPrior(), ...opts });
    expect(healthyPage.primary.title).toMatch(/unchanged/);
  });

  it('reads owner decisions by their leading verb, never by words later in the text', () => {
    expect(isRejectingDecision('approved: investigate the traffic decline next month')).toBe(false);
    expect(isRejectingDecision('Approved')).toBe(false);
    for (const d of ['rejected', 'Rejected: owner prefers current copy', 'declined', 'decline', 'no_action', 'no action for now', "won't do", 'deferred until Q1', 'not now', 'dismissed']) expect(isRejectingDecision(d)).toBe(true);
    const prior = emptyPrior();
    prior.decisions.push({ id: 'd1', subjectType: 'page', subjectId: 'a', decision: 'approved: investigate the traffic decline next month', reason: null, decidedAt: '2026-09-01' });
    prior.decisions.push({ id: 'd2', subjectType: 'page', subjectId: 'b', decision: 'deferred', reason: 'busy season', decidedAt: '2026-09-01' });
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'INDEXING_UNKNOWN', score: 60 }), cand({ pageId: 'b', route: 'RANKING_OPPORTUNITY', score: 90 })], siteDecision: null, prior, ...opts });
    expect(set.primary.pageId).toBe('a');
    expect(set.excluded.map((x) => x.pageId)).toEqual(['b']);
  });

  it('does not stack page changes on a site-wide experiment or change an experiment\'s control page', () => {
    const prior = emptyPrior();
    prior.activeExperiments.push({ id: 'x_ctl', pageId: 'p', type: 'content_section', status: 'observing', comparisonPageIds: ['c'] });
    const ctl = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'c', route: 'CTR_OPPORTUNITY', score: 90 }), cand({ pageId: 'd', route: 'CTR_OPPORTUNITY', score: 50 })], siteDecision: null, prior, ...opts });
    expect(ctl.primary.pageId).toBe('d');
    expect(ctl.excluded[0]!.reason).toMatch(/comparison \(control\) page of experiment x_ctl/);
    prior.activeExperiments.push({ id: 'x_site', pageId: null, type: 'title_meta', status: 'observing' });
    const site = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'd', route: 'CTR_OPPORTUNITY', score: 90 }), cand({ pageId: 'e', route: 'RANKING_OPPORTUNITY', score: 80 })], siteDecision: null, routeCounts: { CTR_OPPORTUNITY: 1, RANKING_OPPORTUNITY: 1 }, prior, ...opts });
    expect(site.primary).toMatchObject({ kind: 'no_action', actionType: 'monitor_experiment' });
    expect(site.primary.title).toMatch(/x_site/);
    expect(site.excluded.every((x) => /site-wide experiment x_site/.test(x.reason))).toBe(true);
    // Investigations (no page change) and technical blockers still go ahead.
    const inv = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'd', route: 'CTR_OPPORTUNITY', score: 90 }), cand({ pageId: 'f', route: 'DECLINE', score: 40 })], siteDecision: null, prior, ...opts });
    expect(inv.primary).toMatchObject({ pageId: 'f', actionType: 'decline_investigation' });
  });

  it('labels synthetic figures OBSERVED [SYNTHETIC] (flag + marker), never a value under DATA_UNAVAILABLE', () => {
    const real = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY' })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(real.synthetic).toBe(false);
    expect(real.primary.claims.some((c) => c.label === 'OBSERVED')).toBe(true);
    expect(real.primary.claims.some((c) => c.synthetic || c.text.includes('[SYNTHETIC]'))).toBe(false);
    const syn = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', synthetic: true })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(syn.synthetic).toBe(true);
    expect(syn.primary.title).toMatch(/^\[SYNTHETIC\] Targeted SEO audit/);
    // Same convention as the report sections: the figure stays OBSERVED, flagged synthetic and marked [SYNTHETIC].
    const figure = syn.primary.claims.find((c) => c.key === 'primary.impressions')!;
    expect(figure).toMatchObject({ label: 'OBSERVED', synthetic: true, support: 'supports' });
    expect(figure.text).toMatch(/^\[SYNTHETIC\] 5000 Search Console impressions/);
    expect(figure.evidence!.synthetic).toBe(true);
    const observed = syn.primary.claims.filter((c) => c.label === 'OBSERVED');
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((c) => c.synthetic === true && c.text.startsWith('[SYNTHETIC] '))).toBe(true);
    // DATA_UNAVAILABLE means "not measured": it never carries a (synthetic) value.
    expect(syn.primary.claims.filter((c) => c.label === 'DATA_UNAVAILABLE').every((c) => !c.evidence && !c.text.includes('5000'))).toBe(true);
    expect(syn.primary.claims.some((c) => c.text.startsWith('SYNTHETIC (not a real measurement)'))).toBe(false);
    expect(syn.primary.claims.find((c) => c.label === 'INFERRED')!.text).toMatch(/^Based on SYNTHETIC data/);
    // A synthetic context marks even site-level drafts.
    const ctxSyn = assembleRecommendation('test-site', { candidates: [], siteDecision: null, routeCounts: { HEALTHY: 3 }, prior: emptyPrior(), synthetic: true, ...opts });
    expect(ctxSyn.primary.claims.filter((c) => c.label === 'OBSERVED').every((c) => c.synthetic === true && c.text.startsWith('[SYNTHETIC] '))).toBe(true);
    // Idempotent: never double-marked.
    const twice = markSynthetic(markSynthetic(real.primary));
    expect(twice.title.match(/SYNTHETIC/g)).toHaveLength(1);
    expect(twice.claims.every((c) => (c.text.match(/\[SYNTHETIC\]/g) ?? []).length <= 1)).toBe(true);
  });

  it('marks missing metrics as DATA_UNAVAILABLE instead of zero', () => {
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', rawCounts: { impressions: 5000, clicks: 100, sessions: null, convertingSessions: null } })], siteDecision: null, prior: emptyPrior(), ...opts });
    const unavailable = set.primary.claims.filter((c) => c.label === 'DATA_UNAVAILABLE');
    expect(unavailable.map((c) => c.key)).toEqual(['primary.sessions', 'primary.convertingSessions']);
    expect(unavailable.every((c) => c.support === 'missing' && !c.evidence)).toBe(true);
  });
});

describe('recommendation persistence from a routed site', () => {
  it('persists one primary + secondary with claim-level evidence and supersedes earlier proposals', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    seedScenario(seed);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const deps = { db: ctx.db, siteId: ctx.siteId, config: ctx.config, clock: ctx.clock };
    const site = prepareSiteAnalysis(deps);
    const run = await routeAllPages(deps, site, { persist: true });
    const fromDb = loadCandidates(ctx.db, ctx.siteId);
    expect(fromDb.map((c) => c.route).sort()).toEqual(['INDEXING_UNKNOWN', 'TECHNICAL_BLOCKER']);
    expect(fromDb.find((c) => c.route === 'TECHNICAL_BLOCKER')!.reasons[0]!.code).toBe('CONFIRMED_TECHNICAL_ISSUE');
    const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: site.today });
    const set = assembleRecommendation(ctx.siteId, { candidates: fromDb, siteDecision: site.siteDecision, routeCounts: run.counts, prior, ...opts });
    expect(set.primary.url).toBe(`${HOST}/broken`);
    expect(set.secondary.map((s) => s.url)).toEqual([`${HOST}/new`]);

    // An earlier proposed recommendation exists.
    ctx.db.run("INSERT INTO recommendations (id, site_id, kind, action_type, title, status, created_at, updated_at) VALUES ('rec_old', ?, 'primary', 'x', 'old', 'proposed', ?, ?)", [ctx.siteId, seed.now, seed.now]);
    const saved = persistRecommendationSet(ctx.db, ctx.siteId, set, { now: ctx.clock.now() });
    expect(saved.superseded).toBe(1);
    expect(saved.secondaryIds).toHaveLength(1);
    const recs = ctx.db.all<{ id: string; kind: string; status: string }>("SELECT id, kind, status FROM recommendations WHERE site_id = ? AND id != 'rec_old'", [ctx.siteId]);
    expect(recs.map((r) => r.kind).sort()).toEqual(['primary', 'secondary']);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM recommendations WHERE id = 'rec_old'")!.status).toBe('superseded');
    const claims = ctx.db.all<{ claim_label: string; claim_text: string; evidence_id: string | null; support: string }>('SELECT claim_label, claim_text, evidence_id, support FROM claim_evidence WHERE site_id = ? AND subject_id = ?', [ctx.siteId, saved.primaryId]);
    expect(claims.length).toBe(saved.claimCount - ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM claim_evidence WHERE subject_id = ?', [saved.secondaryIds[0]!])!.n);
    // The scenario rows are SYNTHETIC fixtures: their figures are OBSERVED [SYNTHETIC] (marker in the text, synthetic source), never a value under DATA_UNAVAILABLE.
    expect(set.synthetic).toBe(true);
    const syntheticFigures = claims.filter((c) => c.claim_label === 'OBSERVED');
    expect(syntheticFigures.length).toBeGreaterThan(0);
    expect(syntheticFigures.every((c) => c.claim_text.startsWith('[SYNTHETIC] ') && c.evidence_id !== null)).toBe(true);
    expect(claims.filter((c) => c.claim_label === 'DATA_UNAVAILABLE').every((c) => c.evidence_id === null)).toBe(true);
    const ev = ctx.db.get<{ trust_class: string; source_type: string; metadata_json: string }>('SELECT s.trust_class, s.source_type, s.metadata_json FROM evidence e JOIN sources s ON s.id = e.source_id WHERE e.id = ?', [syntheticFigures[0]!.evidence_id!])!;
    expect(ev).toMatchObject({ trust_class: 'synthetic', source_type: 'fixture' });
    expect(JSON.parse(ev.metadata_json)).toMatchObject({ synthetic: true });
    const opp = ctx.db.get<{ status: string }>("SELECT status FROM opportunities WHERE site_id = ? AND route = 'TECHNICAL_BLOCKER'", [ctx.siteId])!;
    expect(opp.status).toBe('recommended');
    expect(candidateFromAnalysis(run.analyses[0]!).periodStart).toBe('2026-08-24');
  });

  it('persists real (non-synthetic) figures as OBSERVED first-party evidence', () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const p = seed.page(`${HOST}/real`);
    const set = assembleRecommendation(ctx.siteId, { candidates: [{ ...cand({ pageId: p, route: 'RANKING_OPPORTUNITY' }), id: null, url: `${HOST}/real` }], siteDecision: null, prior: emptyPrior(), ...opts });
    const saved = persistRecommendationSet(ctx.db, ctx.siteId, set, { now: ctx.clock.now() });
    const rows = ctx.db.all<{ claim_label: string; source_type: string | null; trust_class: string | null }>(
      'SELECT c.claim_label, s.source_type, s.trust_class FROM claim_evidence c LEFT JOIN evidence e ON e.id = c.evidence_id LEFT JOIN sources s ON s.id = e.source_id WHERE c.subject_id = ?',
      [saved.primaryId],
    );
    const observedRows = rows.filter((r) => r.claim_label === 'OBSERVED');
    expect(observedRows.length).toBeGreaterThan(0);
    expect(observedRows.every((r) => r.trust_class === 'first_party_measurement' && (r.source_type === 'gsc' || r.source_type === 'ga4'))).toBe(true);
  });

  it('loads candidates of specific opportunities only when ids are given', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    seedScenario(new SeoSeeder(ctx.db, ctx.siteId));
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const deps = { db: ctx.db, siteId: ctx.siteId, config: ctx.config, clock: ctx.clock };
    const run = await routeAllPages(deps, prepareSiteAnalysis(deps), { persist: true });
    const ids = run.persisted.map((x) => x.opportunityId).filter((x): x is string => !!x);
    expect(loadCandidates(ctx.db, ctx.siteId, undefined, { ids: [ids[0]!] })).toHaveLength(1);
    expect(loadCandidates(ctx.db, ctx.siteId, undefined, { ids: [] })).toEqual([]);
    expect(loadCandidates(ctx.db, ctx.siteId).every((c) => c.synthetic === true)).toBe(true);
  });

  it('loads prior experiments, decisions, and learnings (memory optional)', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const p = seed.page(`${HOST}/x`);
    seed.experiment({ pageId: p, status: 'negative', type: 'title_meta', updatedAt: '2026-08-01T00:00:00Z' });
    seed.experiment({ pageId: p, status: 'observing', type: 'content_section' });
    seed.decision({ subjectType: 'page', subjectId: p, decision: 'declined' });
    const prior = await loadPriorContext(ctx.db, ctx.siteId, {
      today: '2026-09-24',
      memory: { search: async () => ({ chunks: [], method: 'fts_only', degraded: true, degradedReason: 'qdrant down', usedTokens: 0, budgetTokens: 100, truncated: false }) },
    });
    expect(prior.concludedExperiments).toHaveLength(1);
    expect(prior.activeExperiments).toHaveLength(1);
    expect(prior.decisions).toHaveLength(1);
    expect(prior.memory).toMatchObject({ status: 'degraded', detail: 'qdrant down' });
    const failing = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24', memory: { search: async () => { throw new Error('boom'); } } });
    expect(failing.memory.status).toBe('error');
  });
});

describe('minimum-evidence rule and diagnostics (A6-12)', () => {
  /** A zero-impression page: evidence quality is at most 0.3 x sessions/minSessions + 0.2 by construction. */
  const zeroImpressions = (pageId: string, o: Partial<Omit<CandidateOpportunity, 'pageId' | 'route'>> = {}) =>
    cand({ pageId, route: 'INDEXING_UNKNOWN', score: 8, evidenceQuality: 0.2, rawCounts: { impressions: 0, clicks: 0, sessions: 0, convertingSessions: 0 }, reasons: [{ code: 'NO_IMPRESSIONS_NOT_INSPECTED', detail: 'no Search Console impressions in the period and no URL Inspection record' }], ...o });

  it('a zero-impression INDEXING_UNKNOWN candidate becomes the primary action: the free URL Inspection, not "keep measuring"', () => {
    const set = assembleRecommendation('test-site', { candidates: [zeroImpressions('orphan')], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(set.primary.kind).toBe('primary');
    expect(set.primary.actionType).toBe('inspect_indexing');
    expect(set.primary.proposedChange).toMatch(/free Search Console URL Inspection/);
    expect(set.primary.proposedChange).toMatch(/sync inspect https:\/\/www\.example\.test\/orphan/);
    expect(set.primary.proposedChange).toMatch(/Never delete or redirect automatically/);
    expect(set.primary.proposedChange).not.toMatch(/keep measuring/i);
    expect(set.primary.details.minimumEvidenceExempt).toMatch(/no-change diagnostic/);
    // The raw zero counts stay visible.
    expect(set.primary.claims.find((c) => c.key === 'primary.impressions')!.text).toMatch(/^0 Search Console impressions/);
  });

  it('a weak DECLINE is still investigated (no change is made by an investigation)', () => {
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'd', route: 'DECLINE', score: 15, evidenceQuality: 0.3 })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(set.primary).toMatchObject({ kind: 'primary', actionType: 'decline_investigation' });
  });

  it('a weak change candidate on top does not hide a diagnostic further down', () => {
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'weak', route: 'RANKING_OPPORTUNITY', score: 12, evidenceQuality: 0.2 }), zeroImpressions('orphan', { score: 5 })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(set.primary.actionType).toBe('inspect_indexing');
    expect(set.secondary.map((s) => s.pageId)).toEqual(['weak']);
    // Without a diagnostic, weak change evidence still means "collect more evidence".
    const weakOnly = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'weak', route: 'RANKING_OPPORTUNITY', score: 12, evidenceQuality: 0.2 })], siteDecision: null, prior: emptyPrior(), ...opts });
    expect(weakOnly.primary.kind).toBe('collect_more_evidence');
  });
});

describe('deep comparison attached to the primary recommendation (A6-01)', () => {
  const comparison = (o: Partial<ComparisonForRecommendation> = {}): ComparisonForRecommendation => ({
    id: 'cmp_1',
    query: 'best widgets',
    pageId: 'a',
    url: `${HOST}/a`,
    opportunityId: 'opp_a',
    competitorsCompared: 2,
    competitorsInaccessible: 1,
    ourAdvantages: ['Our page has original data or first-hand testing; only 0 of 2 compared competitor pages do.'],
    gaps: ['2 of 2 compared competitor pages show pricing/cost information; ours does not (observed difference, not a ranking cause).'],
    caveats: ['Observed differences are inputs for a human/analyst; no feature is claimed to cause any ranking.'],
    synthesis: { status: 'skipped', reason: 'synthesis skipped: no reasoning model is configured (llm reasoning tier)' },
    serp: { snapshotId: 'snap_1', collectedAt: '2026-09-23T10:00:00.000Z', locationCode: 9990001, languageCode: 'en', device: 'desktop' },
    fetchedAt: '2026-09-23T11:00:00.000Z',
    synthetic: false,
    ...o,
  });

  it('adds what our page does better, observed gaps, caveats, and the synthesis status as labeled claims and details', () => {
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', query: 'best widgets' })], siteDecision: null, prior: emptyPrior(), comparisons: [comparison()], ...opts });
    const byKey = Object.fromEntries(set.primary.claims.map((c) => [c.key, c]));
    expect(byKey['primary.compare.scope']!.text).toMatch(/compared with 2 accessible competitor page\(s\) from the localized SERP snapshot of 2026-09-23 \(location 9990001, language en, device desktop\)/);
    expect(byKey['primary.compare.advantage.1']).toMatchObject({ label: 'INFERRED', support: 'supports' });
    expect(byKey['primary.compare.advantage.1']!.text).toMatch(/^What our page does better: Our page has original data/);
    expect(byKey['primary.compare.gap.1']!.text).toMatch(/not a ranking cause/);
    expect(byKey['primary.compare.caveats']!.text).toMatch(/no feature is claimed to cause any ranking/);
    expect(byKey['primary.compare.synthesis']).toMatchObject({ label: 'DATA_UNAVAILABLE' });
    expect(byKey['primary.compare.synthesis']!.text).toMatch(/synthesis skipped: no reasoning model/);
    expect(byKey['primary.compare.advantage.1']!.evidence).toMatchObject({ sourceType: 'competitor_page', kind: 'observation', locator: { table: 'competitive_comparisons', id: 'cmp_1' } });
    expect(set.primary.details.comparison).toMatchObject({ id: 'cmp_1', query: 'best widgets', ourAdvantages: comparison().ourAdvantages });
    expect(set.primary.proposedChange).toMatch(/Deep comparison attached \(competitive_comparisons cmp_1\)/);
  });

  it('attaches nothing when the comparison concerns another page, or to non-primary decisions', () => {
    const other = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY' })], siteDecision: null, prior: emptyPrior(), comparisons: [comparison({ pageId: 'z', url: `${HOST}/z`, opportunityId: 'opp_z' })], ...opts });
    expect(other.primary.claims.some((c) => c.key.startsWith('primary.compare'))).toBe(false);
    const weak = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', score: 5, evidenceQuality: 0.1 })], siteDecision: null, prior: emptyPrior(), comparisons: [comparison()], ...opts });
    expect(weak.primary.kind).toBe('collect_more_evidence');
    expect(weak.primary.claims.some((c) => c.key.startsWith('primary.compare'))).toBe(false);
  });

  it('persists comparison claims with scraped_untrusted competitor evidence; a synthetic comparison is never presented as observed', () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const p = seed.page(`${HOST}/a`);
    const real = assembleRecommendation(ctx.siteId, { candidates: [{ ...cand({ pageId: p, route: 'RANKING_OPPORTUNITY' }), id: null, url: `${HOST}/a` }], siteDecision: null, prior: emptyPrior(), comparisons: [comparison({ pageId: p, opportunityId: null, id: null })], ...opts });
    const saved = persistRecommendationSet(ctx.db, ctx.siteId, real, { now: ctx.clock.now() });
    const rows = ctx.db.all<{ claim_key: string; claim_label: string; source_type: string | null; trust_class: string | null; kind: string | null }>(
      "SELECT c.claim_key, c.claim_label, s.source_type, s.trust_class, e.kind FROM claim_evidence c LEFT JOIN evidence e ON e.id = c.evidence_id LEFT JOIN sources s ON s.id = e.source_id WHERE c.subject_id = ? AND c.claim_key LIKE 'primary.compare.%'",
      [saved.primaryId],
    );
    const adv = rows.find((r) => r.claim_key === 'primary.compare.advantage.1')!;
    expect(adv).toMatchObject({ claim_label: 'INFERRED', source_type: 'competitor_page', trust_class: 'scraped_untrusted', kind: 'observation' });
    const synthetic = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY' })], siteDecision: null, prior: emptyPrior(), comparisons: [comparison({ synthetic: true })], ...opts });
    const advS = synthetic.primary.claims.find((c) => c.key === 'primary.compare.advantage.1')!;
    expect(advS.synthetic).toBe(true);
    expect(advS.evidence?.synthetic).toBe(true);
    expect(synthetic.primary.claims.some((c) => c.label === 'OBSERVED' && c.key.startsWith('primary.compare'))).toBe(false);
  });

  it('shows a model synthesis as a labeled HYPOTHESIS', () => {
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY' })], siteDecision: null, prior: emptyPrior(), comparisons: [comparison({ synthesis: { status: 'ok', reason: null, summary: 'Synthetic summary: informational guides dominate.', model: 'fixture-model', promptVersion: 'analysis.serp-synthesis@3' } })], ...opts });
    const c = set.primary.claims.find((x) => x.key === 'primary.compare.synthesis')!;
    expect(c).toMatchObject({ label: 'HYPOTHESIS', support: 'context' });
    expect(c.text).toMatch(/model output, not a measurement\): Synthetic summary/);
  });
});

describe('prior context (A3-02)', () => {
  it('searches owner business notes in memory along with decisions, experiments, rejected proposals, and learnings', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const asked: string[][] = [];
    const prior = await loadPriorContext(ctx.db, ctx.siteId, {
      today: '2026-09-24',
      memory: {
        search: async (q) => {
          asked.push(q.sourceTypes ?? []);
          return { chunks: [], method: 'fts_only', degraded: false, degradedReason: null, usedTokens: 0, budgetTokens: 100, truncated: false } as never;
        },
      },
    });
    expect(asked.flat()).toEqual(expect.arrayContaining(['business_note', 'decision', 'rejected_proposal', 'experiment_summary', 'approved_learning']));
    // Owner knowledge (business notes + decisions) is its own search, so history never crowds it out.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(['business_note', 'decision']);
    expect(prior.memory.searched).toEqual(expect.arrayContaining(['business_note', 'rejected_proposal']));
  });
});

describe('prior context consulted before recommending (spec 19)', () => {
  type Chunk = import('../../../src/memory/types.js').RetrievedChunk;
  type Result = import('../../../src/memory/types.js').RetrievalResult;
  const chunk = (o: Partial<Chunk> & Pick<Chunk, 'chunkId' | 'sourceType' | 'sourceRef' | 'title'>): Chunk => ({
    documentId: `doc_${o.chunkId}`,
    text: `SYNTHETIC memory text for ${o.title}`,
    headingPath: '',
    sourceUrl: null,
    trustClass: 'owner_approved',
    documentStatus: 'active',
    recordStatus: null,
    sourceDate: '2026-09-01',
    language: 'en',
    scores: { fused: 1 },
    explanation: [],
    ...o,
  });
  const result = (chunks: Chunk[], o: Partial<Result> = {}): Result => ({ chunks, method: 'fts_only', degraded: false, usedTokens: 0, budgetTokens: 1000, truncated: false, ...o });
  const POLICY = 'full-text only by policy (no LLM client is wired for query embeddings in this process: no implicit query-embedding spend)';

  it('carries the retrieval detail: policy (not degraded), degraded, or error', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const policy = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24', memory: { search: async () => result([], { detail: POLICY }) } });
    expect(policy.memory).toMatchObject({ status: 'ok', detail: POLICY, detailKind: 'policy', method: 'fts_only' });
    const degraded = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24', memory: { search: async () => result([], { degraded: true, degradedReason: 'qdrant unreachable', detail: POLICY }) } });
    expect(degraded.memory).toMatchObject({ status: 'degraded', detail: 'qdrant unreachable', detailKind: 'degraded' });
    // One of the two searches failing degrades retrieval and says so; both failing is an error.
    let n = 0;
    const half = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24', memory: { search: async () => { if (n++ === 1) throw new Error('fts locked'); return result([]); } } });
    expect(half.memory).toMatchObject({ status: 'degraded', detailKind: 'degraded' });
    expect(half.memory.detail).toMatch(/search failed: fts locked/);
    const failed = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24', memory: { search: async () => { throw new Error('boom'); } } });
    expect(failed.memory).toMatchObject({ status: 'error', detail: 'boom', detailKind: 'error', items: [] });
  });

  it('searches owner business notes (incl. subject-less owner decisions) and records what was consulted with the primary item', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    // A standing, subject-less owner decision from the vault note, older than the lookback window: still consulted (knowledge only).
    ctx.db.run(
      `INSERT INTO decisions (id, site_id, subject_type, subject_id, decision, reason, decided_by, decided_at, vault_path) VALUES ('dec_standing', ?, 'site', ?, 'We do not target competitor brand queries.', 'Standing owner decision (SYNTHETIC)', 'owner', '2025-01-10T00:00:00.000Z', '01 Business/Owner Decisions.md')`,
      [ctx.siteId, ctx.siteId],
    );
    const calls: Array<{ types: string[]; text: string }> = [];
    const prior = await loadPriorContext(ctx.db, ctx.siteId, {
      today: '2026-09-24',
      memoryQuery: 'previous recommendations experiments decisions blue widgets',
      memory: {
        search: async (q) => {
          calls.push({ types: q.sourceTypes ?? [], text: q.text });
          return (q.sourceTypes ?? []).includes('business_note')
            ? result([chunk({ chunkId: 'c_owner', sourceType: 'business_note', sourceRef: '01 Business/Owner Decisions.md', title: 'Owner Decisions' }), chunk({ chunkId: 'c_profile', sourceType: 'business_note', sourceRef: '01 Business/Business Profile.md', title: 'Business Profile' })], { detail: POLICY })
            : result([], { detail: POLICY });
        },
      },
    });
    expect(calls.map((c) => c.types)).toEqual([
      ['rejected_proposal', 'experiment_summary', 'decision', 'approved_learning'],
      ['business_note', 'decision'],
    ]);
    expect(calls.every((c) => c.text.includes('blue widgets'))).toBe(true);
    expect(prior.memory.items.map((i) => i.sourceRef)).toEqual(['01 Business/Owner Decisions.md', '01 Business/Business Profile.md']);
    expect(prior.decisions.find((d) => d.id === 'dec_standing')?.target).toMatchObject({ siteWide: true });
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', score: 80 })], siteDecision: null, prior, ...opts });
    // A site-wide decision never excludes a specific candidate.
    expect(set.primary.pageId).toBe('a');
    const consulted = set.primary.details.priorContext as { standingOwnerDecisions: Array<{ id: string; source: string | null }>; memory: { status: string; detailKind: string | null; items: Array<{ sourceType: string }> } };
    expect(consulted.standingOwnerDecisions).toEqual([expect.objectContaining({ id: 'dec_standing', source: '01 Business/Owner Decisions.md' })]);
    expect(consulted.memory).toMatchObject({ status: 'ok', detailKind: 'policy' });
    expect(consulted.memory.items.map((i) => i.sourceType)).toEqual(['business_note', 'business_note']);
    // Secondary observations do not repeat it.
    expect(set.secondary.every((x) => x.details.priorContext === undefined)).toBe(true);
  });

  it('reads recorded decisions on query and keyword subjects', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    seed.decision({ subjectType: 'query', subjectId: 'Blue  Widgets', decision: 'rejected', reason: 'not our market (SYNTHETIC)' });
    ctx.db.run(`INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES ('kw_red', ?, 'Red Widgets', 'red widgets', NULL, ?)`, [ctx.siteId, ctx.clock.now().toISOString()]);
    seed.decision({ subjectType: 'keyword', subjectId: 'kw_red', decision: 'deferred' });
    seed.decision({ subjectType: 'query', subjectId: 'green widgets', decision: 'approved: research it' });
    const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24' });
    const set = assembleRecommendation('test-site', {
      candidates: [
        cand({ pageId: 'a', route: 'RANKING_OPPORTUNITY', score: 90, query: 'blue widgets' }),
        cand({ pageId: 'b', route: 'CTR_OPPORTUNITY', score: 85, query: 'RED widgets' }),
        cand({ pageId: 'c', route: 'RANKING_OPPORTUNITY', score: 80, query: 'green widgets' }),
      ],
      siteDecision: null,
      prior,
      ...opts,
    });
    expect(set.excluded.map((x) => x.pageId)).toEqual(['a', 'b']);
    expect(set.excluded[0]!.reason).toMatch(/owner decision "rejected".*\[query Blue {2}Widgets\]/);
    expect(set.excluded[1]!.reason).toMatch(/owner decision "deferred".*\[keyword kw_red\]/);
    expect(set.primary.pageId).toBe('c');
  });

  it('a rejected proposal stays rejected under a new id: decisions on recommendation and opportunity subjects match page + action', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const p = seed.page(`${HOST}/p`);
    const q = seed.page(`${HOST}/q`);
    const now = ctx.clock.now().toISOString();
    // An earlier run's proposal, rejected through approvals after a later run had already superseded it (status stays 'superseded').
    ctx.db.run(`INSERT INTO recommendations (id, site_id, kind, action_type, title, page_id, query, status, created_at, updated_at) VALUES ('rec_old', ?, 'primary', 'title_snippet_investigation', 'SYNTHETIC old proposal', ?, 'widgets', 'superseded', ?, ?)`, [ctx.siteId, p, now, now]);
    seed.decision({ subjectType: 'recommendation', subjectId: 'rec_old', decision: 'rejected', reason: 'owner keeps the title (SYNTHETIC)' });
    ctx.db.run(`INSERT INTO opportunities (id, site_id, kind, route, page_id, status, created_at, updated_at) VALUES ('opp_old', ?, 'page', 'RANKING_OPPORTUNITY', ?, 'deferred', ?, ?)`, [ctx.siteId, q, now, now]);
    seed.decision({ subjectType: 'opportunity', subjectId: 'opp_old', decision: 'no_action' });
    const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24' });
    expect(prior.decisions.find((d) => d.subjectId === 'rec_old')?.target).toMatchObject({ pageId: p, actionType: 'title_snippet_investigation' });
    const set = assembleRecommendation('test-site', {
      candidates: [
        cand({ pageId: p, id: 'opp_new_ctr', route: 'CTR_OPPORTUNITY', score: 95 }),
        cand({ pageId: q, id: 'opp_new_rank', route: 'RANKING_OPPORTUNITY', score: 90 }),
        cand({ pageId: p, id: 'opp_new_rank_p', route: 'RANKING_OPPORTUNITY', score: 70 }),
        cand({ pageId: q, id: 'opp_new_ctr_q', route: 'CTR_OPPORTUNITY', score: 60 }),
      ],
      siteDecision: null,
      prior,
      ...opts,
    });
    expect(set.excluded.map((x) => x.opportunityId)).toEqual(['opp_new_ctr', 'opp_new_rank']);
    expect(set.excluded[0]!.reason).toMatch(/\[recommendation rec_old\]/);
    expect(set.excluded[1]!.reason).toMatch(/\[opportunity opp_old\]/);
    // Another action on the same pages is a different idea.
    expect(set.primary.opportunityId).toBe('opp_new_rank_p');
  });

  it('a rejected proposal without a page suppresses only the same query; a rejected secondary observation counts too', () => {
    const prior = emptyPrior();
    prior.rejectedRecommendations.push({ id: 'r_q', pageId: null, query: 'Red Widgets', actionType: 'content_overlap_check', title: 'x', updatedAt: '2026-09-02' });
    prior.rejectedRecommendations.push({ id: 'r_obs', pageId: 'd', actionType: 'observation:title_snippet_investigation', title: 'x', updatedAt: '2026-09-03' });
    const queryOnly = (q: string, id: string, score: number): CandidateOpportunity => ({ ...cand({ pageId: id, route: 'CONTENT_OPPORTUNITY', score, query: q }), id, pageId: null, url: null });
    const set = assembleRecommendation('test-site', { candidates: [queryOnly('red widgets', 'opp_red', 90), queryOnly('green widgets', 'opp_green', 80), cand({ pageId: 'd', route: 'CTR_OPPORTUNITY', score: 70 })], siteDecision: null, prior, ...opts });
    expect(set.excluded.map((x) => x.opportunityId)).toEqual(['opp_red', 'opp_d']);
    expect(set.excluded[0]!.reason).toMatch(/for "Red Widgets" was rejected/);
    expect(set.primary.opportunityId).toBe('opp_green');
  });

  it('negative experiments and rejected proposals that memory surfaces from outside the lookback window suppress the same change', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const p = seed.page(`${HOST}/p`);
    const q = seed.page(`${HOST}/q`);
    const expId = seed.experiment({ pageId: p, status: 'negative', type: 'title_meta', updatedAt: '2025-01-15T00:00:00.000Z' });
    ctx.db.run(`INSERT INTO recommendations (id, site_id, kind, action_type, title, page_id, status, created_at, updated_at) VALUES ('rec_rejected_old', ?, 'primary', 'targeted_seo_audit', 'SYNTHETIC old audit', ?, 'rejected', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z')`, [ctx.siteId, q]);
    // Without memory the 180-day window does not see them.
    const plain = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24' });
    expect(plain.concludedExperiments).toEqual([]);
    expect(plain.rejectedRecommendations).toEqual([]);
    const prior = await loadPriorContext(ctx.db, ctx.siteId, {
      today: '2026-09-24',
      memory: {
        search: async (qq) =>
          (qq.sourceTypes ?? []).includes('experiment_summary')
            ? result([
                chunk({ chunkId: 'c_exp', sourceType: 'experiment_summary', sourceRef: `experiment:${expId}`, title: 'Experiment title_meta', recordStatus: 'negative', trustClass: 'first_party_measurement' }),
                chunk({ chunkId: 'c_rej', sourceType: 'rejected_proposal', sourceRef: 'recommendation:rec_rejected_old', title: 'REJECTED: SYNTHETIC old audit', recordStatus: 'rejected', trustClass: 'model_generated' }),
                // A stale index entry whose record no longer exists is ignored (SQLite is the source of truth).
                chunk({ chunkId: 'c_gone', sourceType: 'rejected_proposal', sourceRef: 'recommendation:rec_missing', title: 'REJECTED: gone', recordStatus: 'rejected' }),
              ])
            : result([]),
      },
    });
    expect(prior.concludedExperiments.map((e) => e.id)).toEqual([expId]);
    expect(prior.rejectedRecommendations.map((r) => r.id)).toEqual(['rec_rejected_old']);
    const set = assembleRecommendation('test-site', { candidates: [cand({ pageId: p, route: 'CTR_OPPORTUNITY', score: 90 }), cand({ pageId: q, route: 'RANKING_OPPORTUNITY', score: 85 }), cand({ pageId: q, id: 'opp_q_ctr', route: 'CTR_OPPORTUNITY', score: 50 })], siteDecision: null, prior, ...opts });
    expect(set.excluded.map((x) => x.pageId)).toEqual([p, q]);
    expect(set.excluded[0]!.reason).toMatch(/similar experiment \(title_meta\) ended negative/);
    expect(set.excluded[1]!.reason).toMatch(/"targeted_seo_audit" recommendation for this page was rejected/);
    expect(set.primary.opportunityId).toBe('opp_q_ctr');
  });
});

describe('history of recommendations behind experiments', () => {
  it('the supersede step skips recommendations an open experiment (proposed/approved/awaiting/observing) was proposed from', () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const now = ctx.clock.now().toISOString();
    const recs: Record<string, string> = {};
    for (const status of ['proposed', 'approved', 'awaiting_implementation', 'observing', 'cancelled', 'positive', 'none']) {
      const page = seed.page(`${HOST}/p-${status}`);
      const id = `rec_${status}`;
      ctx.db.run(`INSERT INTO recommendations (id, site_id, kind, action_type, title, page_id, status, created_at, updated_at) VALUES (?, ?, 'primary', 'rewrite_title_meta', 'SYNTHETIC proposal', ?, 'proposed', ?, ?)`, [id, ctx.siteId, page, now, now]);
      if (status !== 'none') ctx.db.run('UPDATE experiments SET recommendation_id = ? WHERE id = ?', [id, seed.experiment({ pageId: page, status })]);
      recs[status] = id;
    }
    const set = assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: null, routeCounts: { HEALTHY: 3 }, prior: emptyPrior(), ...opts });
    const saved = persistRecommendationSet(ctx.db, ctx.siteId, set, { now: ctx.clock.now() });
    const status = (id: string) => ctx!.db.get<{ status: string }>('SELECT status FROM recommendations WHERE id = ?', [id])!.status;
    expect(saved.superseded).toBe(3);
    for (const s of ['proposed', 'approved', 'awaiting_implementation', 'observing']) expect(status(recs[s]!), s).toBe('proposed');
    for (const s of ['cancelled', 'positive', 'none']) expect(status(recs[s]!), s).toBe('superseded');
    // supersedePrevious: false still touches nothing.
    const again = persistRecommendationSet(ctx.db, ctx.siteId, set, { now: ctx.clock.now(), supersedePrevious: false });
    expect(again.superseded).toBe(0);
  });

  it('a rejected specified revision (typed by its change) still suppresses the idea it was specified from', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const p = seed.page(`${HOST}/p`);
    const now = ctx.clock.now().toISOString();
    const details = JSON.stringify({ change: { kind: 'title', proposedTitle: 'SYNTHETIC title' }, originalActionType: 'title_snippet_investigation', revisionOf: 'rec_audit' });
    ctx.db.run(`INSERT INTO recommendations (id, site_id, kind, action_type, title, page_id, details_json, status, created_at, updated_at) VALUES ('rec_rev', ?, 'primary', 'title_meta_change', 'SYNTHETIC revision', ?, ?, 'rejected', ?, ?)`, [ctx.siteId, p, details, now, now]);
    ctx.db.run(`INSERT INTO recommendations (id, site_id, kind, action_type, title, page_id, details_json, status, created_at, updated_at) VALUES ('rec_rev2', ?, 'primary', 'title_meta_change', 'SYNTHETIC revision 2', ?, ?, 'superseded', ?, ?)`, [ctx.siteId, p, details, now, now]);
    seed.decision({ subjectType: 'recommendation', subjectId: 'rec_rev2', decision: 'rejected', reason: 'SYNTHETIC' });
    const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-24' });
    expect(prior.rejectedRecommendations.find((r) => r.id === 'rec_rev')?.actionType).toBe('title_snippet_investigation');
    expect(prior.decisions.find((d) => d.subjectId === 'rec_rev2')?.target).toMatchObject({ pageId: p, actionType: 'title_snippet_investigation' });
    const set = assembleRecommendation(ctx.siteId, { candidates: [cand({ pageId: p, route: 'CTR_OPPORTUNITY', score: 90 })], siteDecision: null, prior, ...opts });
    expect(set.excluded.map((x) => x.pageId)).toEqual([p]);
  });
});
