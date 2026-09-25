/**
 * Claim labels on user-reported evidence (B2-08, spec 15 / 28): Reddit posters
 * collected via Apify are unverified community users, never "customers"; only
 * manual customer-question imports are worded as customers. SYNTHETIC data
 * only (example.test domains, fabricated signals).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildDeterministicBrief } from '../../../src/content/brief.js';
import type { ContentItem, ContentSignal, EvidenceSource, SignalOrigin } from '../../../src/content/types.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const AT = '2026-09-20T09:00:00.000Z';

function item(): ContentItem {
  return {
    id: 'ci_synthetic',
    siteId: 'test-site',
    title: 'How do I schedule synthetic widget maintenance?',
    primaryQuestion: 'How do I schedule synthetic widget maintenance?',
    stage: 'existing_checked',
    decision: 'create_page',
    decisionReason: 'SYNTHETIC',
    intent: 'informational',
    clusterId: null,
    targetPageId: null,
    whyExists: null,
    whoBenefits: null,
    businessRelation: null,
    originalValue: null,
    readerNextStep: null,
    demand: null,
    overlap: null,
    priorityScore: null,
    isSynthetic: true,
    createdAt: AT,
    updatedAt: AT,
  };
}

function signal(id: string, origin: SignalOrigin, text: string): ContentSignal {
  return {
    id,
    siteId: 'test-site',
    origin,
    signalType: 'question',
    text,
    normalizedHash: id,
    url: origin === 'apify_reddit' ? `https://www.reddit.example.test/r/widgets/${id}` : null,
    postedAt: null,
    collectedAt: AT,
    collectionWindow: null,
    engagement: origin === 'apify_reddit' ? { upVotes: 3, commentsCount: 2 } : null,
    limitations: 'SYNTHETIC fixture signal',
    sourceId: null,
    apifyRunId: null,
    contentItemId: 'ci_synthetic',
    isSynthetic: true,
  };
}

function evidenceFor(s: ContentSignal): EvidenceSource {
  return {
    id: s.id,
    kind: 'signal',
    origin: s.origin,
    label: s.origin,
    excerpt: s.text,
    url: s.url,
    collectedAt: s.collectedAt,
    trustClass: s.origin === 'apify_reddit' ? 'scraped_untrusted' : 'owner_provided',
    window: null,
    limitations: s.limitations,
    isSynthetic: true,
    isSandbox: false,
  };
}

function brief(signals: ContentSignal[]) {
  ctx = ctx ?? createTestContext();
  return buildDeterministicBrief(ctx, item(), signals, signals.map(evidenceFor), [], {});
}

describe('brief findings never call community posters customers', () => {
  it('apify_reddit questions are worded as community users (Reddit, via Apify), not customers', () => {
    const reddit = [signal('sig_r1', 'apify_reddit', 'How often should synthetic widgets be serviced?'), signal('sig_r2', 'apify_reddit', 'What does synthetic widget maintenance cost?')];
    const b = brief(reddit);
    const community = b.researchFindings.find((f) => /community discussions/.test(f.finding));
    expect(community).toBeDefined();
    expect(community!.finding).toMatch(/^Users in community discussions \(Reddit, via Apify\) raise this question/);
    expect(community!.finding).toMatch(/not known customers/);
    expect(community!.evidenceIds.sort()).toEqual(['sig_r1', 'sig_r2']);
    // Nothing in the findings or the outline purposes calls these posters customers.
    expect(b.researchFindings.some((f) => /customer/i.test(f.finding) && !/not known customers/.test(f.finding))).toBe(false);
    expect(b.outline.some((o) => /customers ask/.test(o.purpose))).toBe(false);
    expect(b.outline.some((o) => /community users ask \(Reddit, via Apify\)/.test(o.purpose))).toBe(true);
  });

  it('manual customer-question imports keep the customer wording, separately from community posts', () => {
    const b = brief([signal('sig_m1', 'manual', 'Can I pause synthetic widget maintenance?'), signal('sig_r1', 'apify_reddit', 'Is synthetic widget maintenance worth it?')]);
    const customers = b.researchFindings.find((f) => /^Customers raise this question/.test(f.finding));
    expect(customers).toMatchObject({ label: 'OBSERVED', evidenceIds: ['sig_m1'] });
    expect(customers!.finding).toMatch(/Manual customer question/);
    const community = b.researchFindings.find((f) => /^Users in community discussions/.test(f.finding));
    expect(community).toMatchObject({ label: 'OBSERVED', evidenceIds: ['sig_r1'] });
    expect(b.outline.find((o) => o.answers.includes('Can I pause synthetic widget maintenance?'))!.purpose).toBe('Answer a related question customers ask.');
    expect(b.outline.find((o) => o.answers.includes('Is synthetic widget maintenance worth it?'))!.purpose).toBe('Answer a related question community users ask (Reddit, via Apify).');
  });
});
