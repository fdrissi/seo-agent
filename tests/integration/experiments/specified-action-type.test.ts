/**
 * A specified revision is typed by its structured change, never by the label
 * of the recommendation it was specified from (B6-05): a title recorded for a
 * `repair_measurement` recommendation is approved and exported as a title/meta
 * change, not as an analytics change. Every label/change mismatch is shown to
 * the reviewer. SYNTHETIC data only (example.test domains).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { actionScopeWarnings, getRecommendation, recommendationActionType, changeFromRecommendation } from '../../../src/approvals/change.js';
import { requestApprovalForSubject } from '../../../src/approvals/requests.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { resolveProposal } from '../../../src/approvals/subjects.js';
import { proposeFromRecommendation } from '../../../src/experiments/propose.js';
import { getExperimentChange } from '../../../src/experiments/repository.js';
import { specifyRecommendationChange } from '../../../src/experiments/specify-change.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { REVISION, stableChecker } from '../../fixtures/experiments/scenario.js';
import { experimentsSiteConfig, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';

const NOW = '2026-09-20T09:00:00.000Z';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function setup() {
  ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW });
  const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
  // The weekly primary for a broken-measurement page: its label is repair_measurement (-> analytics_change).
  const repair = seedRecommendation(ctx.db, ctx.siteId, {
    pageId: page.id,
    kind: 'repair_measurement',
    actionType: 'repair_measurement',
    proposedChange: 'Check that the GA4 tag fires on this page, then propose ONE specific change.',
    details: { route: 'MEASUREMENT_BROKEN' },
  });
  return { ctx, gate, page, repair };
}

describe('specify-change types the revision from its structured change', () => {
  it('a title on a repair_measurement recommendation is approved as title_meta_change, not analytics_change', async () => {
    const s = setup();
    const r = specifyRecommendationChange(s.ctx, { recommendationId: s.repair, by: 'Alice', title: 'Synthetic Widget Guide 2026' });
    expect(r.actionType).toBe('title_meta_change');
    const rev = getRecommendation(s.ctx.db, s.ctx.siteId, r.recommendation.id)!;
    // The row is typed by the change; the original label is kept only in the details.
    expect(rev.action_type).toBe('title_meta_change');
    expect(JSON.parse(rev.details_json!)).toMatchObject({ originalActionType: 'repair_measurement', change: { kind: 'title', proposedTitle: 'Synthetic Widget Guide 2026' } });
    // The owner is told the label disagreed with the change.
    expect(r.warnings.join(' ')).toMatch(/label "repair_measurement" \(analytics_change\) does not match its structured title\/meta change; it is reviewed, approved, and exported as title_meta_change, not analytics_change/);
    const audit = s.ctx.db.get<{ details_json: string }>(`SELECT details_json FROM audit_events WHERE event_type = 'recommendation.change_specified'`)!;
    expect(JSON.parse(audit.details_json)).toMatchObject({ originalActionType: 'repair_measurement', actionType: 'title_meta_change' });

    // The experiment's change and its pending approval carry the title/meta action type.
    const p = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rev.id, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(p.experiment.type).toBe('title_meta');
    expect(p.approval.actionType).toBe('title_meta_change');
    expect(getExperimentChange(s.ctx.db, s.ctx.siteId, p.experiment.id)!.actionType).toBe('title_meta_change');
    expect(p.experiment.changeHash).toBe(r.changeHash);
    expect(s.ctx.db.all<{ action_type: string }>('SELECT action_type FROM approvals').map((a) => a.action_type)).toEqual(['title_meta_change']);
    expect(resolveProposal(s.ctx, 'experiment', p.experiment.id).actionType).toBe('title_meta_change');

    // A direct approval request for the revision says title_meta_change too.
    const req = await requestApprovalForSubject(s.ctx, s.gate, { subjectType: 'recommendation', subjectId: rev.id, requestedBy: 'owner:Alice', sourceRevision: REVISION });
    expect(req.approval.actionType).toBe('title_meta_change');
    // The export resolves the same proposal: a production-bound title_meta_change (the old label is only a reviewer note).
    const exported = resolveProposal(s.ctx, 'recommendation', rev.id);
    expect(exported).toMatchObject({ actionType: 'title_meta_change', productionBound: true });
    expect(exported.warnings.join(' ')).toMatch(/exported as title_meta_change, not analytics_change/);
  });

  it('re-specifying keeps the FIRST original label; a section is an update_page and a redirect a redirect', () => {
    const s = setup();
    const first = specifyRecommendationChange(s.ctx, { recommendationId: s.repair, by: 'Alice', title: 'Synthetic title' });
    const second = specifyRecommendationChange(s.ctx, { recommendationId: first.recommendation.id, by: 'Alice', sectionMarkdown: '## Synthetic section\n\nSynthetic text.' });
    expect(second.actionType).toBe('update_page');
    const rev = getRecommendation(s.ctx.db, s.ctx.siteId, second.recommendation.id)!;
    expect(rev.action_type).toBe('update_page');
    expect(JSON.parse(rev.details_json!).originalActionType).toBe('repair_measurement');
    const third = specifyRecommendationChange(s.ctx, { recommendationId: second.recommendation.id, by: 'Alice', redirectTo: 'https://www.example.test/widgets-new' });
    expect(third.actionType).toBe('redirect');
    expect(getRecommendation(s.ctx.db, s.ctx.siteId, third.recommendation.id)!.action_type).toBe('redirect');
    // A section recorded for a title-labeled recommendation is flagged as well.
    const titled = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, actionType: 'rewrite_title_meta' });
    const section = specifyRecommendationChange(s.ctx, { recommendationId: titled, by: 'Alice', sectionMarkdown: '## Synthetic FAQ\n\nSynthetic answer.' });
    expect(section.actionType).toBe('update_page');
    expect(section.warnings.join(' ')).toMatch(/label "rewrite_title_meta" \(title_meta_change\) does not match its structured content section change; it is reviewed, approved, and exported as update_page/);
  });

  it('an existing revision that still carries its old label is typed by its structured change and flagged for the reviewer', () => {
    const s = setup();
    // As recorded before this fix: the revision kept the source label.
    const legacy = seedRecommendation(s.ctx.db, s.ctx.siteId, {
      pageId: s.page.id,
      kind: 'repair_measurement',
      actionType: 'repair_measurement',
      proposedChange: `On ${s.page.url}, change the title to "Synthetic legacy title".`,
      details: { change: { kind: 'title', proposedTitle: 'Synthetic legacy title' }, revisionOf: s.repair, originalActionType: 'repair_measurement' },
    });
    const rec = getRecommendation(s.ctx.db, s.ctx.siteId, legacy)!;
    expect(recommendationActionType(rec, changeFromRecommendation(rec))).toBe('title_meta_change');
    // Without details (older callers) the label still maps as before.
    expect(recommendationActionType({ action_type: 'repair_measurement' }, changeFromRecommendation(rec))).toBe('analytics_change');
    const proposal = resolveProposal(s.ctx, 'recommendation', legacy);
    expect(proposal.actionType).toBe('title_meta_change');
    expect(proposal.warnings.join(' ')).toMatch(/label "repair_measurement" \(analytics_change\) does not match its structured title\/meta change/);
    // An investigation label is the designed flow: no mismatch warning.
    const audit = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, actionType: 'targeted_seo_audit', proposedChange: 'Audit then propose ONE change.', details: {} });
    const specified = specifyRecommendationChange(s.ctx, { recommendationId: audit, by: 'Alice', title: 'Synthetic audited title' });
    expect(specified.warnings.join(' ')).not.toMatch(/does not match its structured/);
  });

  it('actionScopeWarnings flags title/meta and content fields outside their action type', () => {
    expect(actionScopeWarnings('analytics_change', { title: 'T', metaDescription: 'M' }).join(' ')).toMatch(/sets the page title and meta description although its action type is analytics_change; review it as a title\/meta change/);
    expect(actionScopeWarnings('title_meta_change', { title: 'T', bodyMarkdown: 'B' }).join(' ')).toMatch(/also edits page content although its action type is title_meta_change; review it as a page update/);
    expect(actionScopeWarnings('title_meta_change', { title: 'T', metaDescription: 'M' })).toEqual([]);
    expect(actionScopeWarnings('update_page', { title: 'T', bodyMarkdown: 'B', internalLinks: [{ href: '/x' }] })).toEqual([]);
    expect(actionScopeWarnings('publish_content', { title: 'T', metaDescription: 'M', bodyMarkdown: 'B', slug: 's' })).toEqual([]);
    // Label check: only with a structured change, and never for investigation or empty labels.
    expect(actionScopeWarnings('title_meta_change', { title: 'T' }, { labels: ['repair_measurement'] })).toEqual([]);
    expect(actionScopeWarnings('title_meta_change', { title: 'T' }, { labels: ['targeted_seo_audit', '', null, 'none'], structured: { kind: 'title', proposedTitle: 'T' } })).toEqual([]);
    expect(actionScopeWarnings('title_meta_change', { title: 'T' }, { labels: ['repair_measurement', 'repair_measurement'], structured: { kind: 'title', proposedTitle: 'T' } })).toHaveLength(1);
  });
});
