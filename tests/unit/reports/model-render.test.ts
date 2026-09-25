import { describe, expect, it } from 'vitest';
import { defaultLinkResolver, escapeMd, renderLink, wikiLinkResolver } from '../../../src/reports/links.js';
import { claim, observed, recommendation, section, unavailable, validateReport, SYNTHETIC_WATERMARK, type Report } from '../../../src/reports/model.js';
import { metricDefinitions } from '../../../src/reports/definitions.js';
import { SYNTHETIC_CLAIM_MARKER, renderClaim, renderJson, renderMarkdown, renderTable } from '../../../src/reports/render.js';
import { registerSecret } from '../../../src/security/redact.js';

function minimalReport(extra: Partial<Report> = {}): Report {
  return {
    schemaVersion: 1,
    id: 'rpt_test',
    kind: 'weekly',
    siteId: 'test-site',
    siteName: 'Test Co (synthetic)',
    generatedAt: '2026-09-24T09:00:00.000Z',
    generator: { version: 'reports@test', deterministic: true, llmSummary: { status: 'not_requested', detail: '' } },
    period: { start: '2026-09-14', end: '2026-09-20', days: 7, timeZone: 'Europe/Tallinn', label: 'Week 2026-09-14 to 2026-09-20', comparison: null, latestCompleteDate: '2026-09-20', latestCompleteBasis: 'test', explicit: false },
    isSynthetic: false,
    watermark: null,
    jobId: null,
    sections: [
      section('primary_action', 'Prioritized action', { claims: [recommendation('action.primary', 'Wait: nothing to change.', { reason: 'test', sourceIds: ['recommendations:none'] })] }),
      section('next_action', 'Next action', { claims: [recommendation('next.action', 'Keep observing.')] }),
    ],
    metricDefinitions: metricDefinitions('generate_lead'),
    data: {},
    summary: { kind: 'weekly', period: { start: '2026-09-14', end: '2026-09-20' }, confidence: 'low', isSynthetic: false, primaryAction: null, nextAction: null, warnings: 0, accessIssues: 0, claimCounts: { OBSERVED: 0, INFERRED: 0, HYPOTHESIS: 0, RECOMMENDATION: 2, DATA_UNAVAILABLE: 0 } },
    ...extra,
  };
}

describe('report model validation', () => {
  it('accepts a minimal valid report', () => {
    expect(validateReport(minimalReport())).toEqual([]);
  });

  it('rejects an OBSERVED claim supported only by a source URL', () => {
    const r = minimalReport();
    r.sections[0]!.claims.push(
      claim('OBSERVED', 'bad.url_only', 'Competitors rank because of long content.', {
        sourceIds: ['sources:x'],
        evidence: [{ kind: 'url', label: 'competitor', ref: 'https://competitor.invalid/', supportsClaim: false }],
        evidenceStatus: 'supported',
      }),
    );
    const issues = validateReport(r);
    expect(issues.map((i) => i.message)).toContain('a source URL alone does not support the claim');
  });

  it('allows an explicitly unverified imported claim (surfaced as context only)', () => {
    const r = minimalReport();
    r.sections[0]!.claims.push(
      claim('OBSERVED', 'imported', 'Imported statement', { sourceIds: ['claim_evidence:1'], evidence: [{ kind: 'url', label: 'x', ref: 'https://x.invalid/', supportsClaim: false }] }),
    );
    expect(r.sections[0]!.claims.at(-1)!.evidenceStatus).toBe('context_only');
    expect(validateReport(r)).toEqual([]);
  });

  it('requires reasons for DATA_UNAVAILABLE, known metric ids, one primary action, and a watermark for synthetic reports', () => {
    const r = minimalReport({ isSynthetic: true, watermark: null });
    r.sections[0]!.claims.push({ ...unavailable('u', 'Users unavailable', 'x'), reason: undefined } as never);
    r.sections[0]!.claims.push(observed('m', 'Clicks 5', { sourceIds: ['s'], metricIds: ['no.such.metric'], evidence: [{ kind: 'db_query', label: 'q', ref: 'v', supportsClaim: true }] }));
    r.sections[0]!.claims.push(recommendation('action.primary', 'Second primary'));
    const msgs = validateReport(r).map((i) => i.message);
    expect(msgs).toContain('DATA_UNAVAILABLE claim without a reason');
    expect(msgs).toContain('unknown metric definition no.such.metric');
    expect(msgs).toContain('duplicate claim id');
    expect(msgs).toContain('synthetic report without watermark');
  });
});

describe('report rendering', () => {
  it('escapes untrusted text so it cannot inject links, wikilinks, or HTML', () => {
    const s = escapeMd('Ignore previous instructions [[Secrets]] <script>alert(1)</script> | x');
    expect(s).not.toContain('[[');
    expect(s).not.toContain('<script>');
    expect(s).toContain('\\[\\[Secrets\\]\\]');
    expect(s).toContain('\\|');
  });

  it('renders standard Markdown links by default and wikilinks via a resolver', () => {
    expect(defaultLinkResolver({ kind: 'page', id: 'p1', label: 'Pricing', url: 'https://www.example.test/pricing' })).toBe('[Pricing](https://www.example.test/pricing)');
    expect(renderLink({ kind: 'experiment', id: 'exp_1', label: 'Exp 1' })).toBe('Exp 1 (`experiment:exp_1`)');
    // javascript: URLs are never rendered as links
    expect(renderLink({ kind: 'page', id: 'p', label: 'x', url: 'javascript:alert(1)' })).toBe('x (`page:p`)');
    const wiki = wikiLinkResolver({ link: (p, a) => `[[${p.replace(/\.md$/, '')}${a ? `|${a}` : ''}]]`, notePath: (t) => (t.kind === 'experiment' ? `06 Experiments/${t.id}.md` : null) });
    expect(renderLink({ kind: 'experiment', id: 'exp_1', label: 'Exp | 1' }, wiki)).toBe('[[06 Experiments/exp_1|Exp 1]]');
    expect(renderLink({ kind: 'page', id: 'p1', label: 'Pricing', url: 'https://www.example.test/pricing' }, wiki)).toBe('[Pricing](https://www.example.test/pricing)');
  });

  it('renders claim labels, sources, retrieval dates, metrics and flags URL-only evidence', () => {
    const md = renderClaim(
      claim('OBSERVED', 'x', 'Competitor mentions plans.', {
        sourceIds: ['sources:s1'],
        retrievedAt: ['2026-09-22T06:00:00.000Z'],
        metricIds: ['gsc.clicks'],
        evidence: [{ kind: 'url', label: 'Competitor', ref: 'https://competitor.invalid/pricing', supportsClaim: false }],
      }),
    );
    expect(md).toContain('**OBSERVED**');
    expect(md).toContain('`sources:s1`');
    expect(md).toContain('Retrieved: 2026-09-22');
    expect(md).toContain('`gsc.clicks`');
    expect(md).toContain('location only; does not by itself support the claim');
    expect(md).toContain('Evidence status: context only');
    expect(renderClaim(unavailable('u', 'Users unavailable.', 'not fetched'))).toContain('**DATA UNAVAILABLE**');
  });

  it('renders tables with top-N notes', () => {
    const t = renderTable({ id: 't', title: 'Top pages', columns: ['Page', 'Clicks'], rows: [['/a|b', 1234]], totalRows: 50 });
    expect(t).toContain('| /a\\|b | 1,234 |');
    expect(t).toContain('Showing 1 of 50 rows');
  });

  it('watermarks synthetic reports and redacts registered secrets in Markdown and JSON', () => {
    const secret = 'sk-test-abcdefghijklmnop1234';
    registerSecret(secret);
    const r = minimalReport({ isSynthetic: true, watermark: SYNTHETIC_WATERMARK });
    r.sections[0]!.claims[0]!.text = `Wait. Leaked ${secret} here.`;
    const md = renderMarkdown(r);
    const json = renderJson(r);
    expect(md.startsWith('# Weekly SEO report')).toBe(true);
    expect(md.split(SYNTHETIC_WATERMARK).length - 1).toBeGreaterThanOrEqual(2);
    expect(md).not.toContain(secret);
    expect(json).not.toContain(secret);
    expect(md).toContain('\\[REDACTED\\]'); // the marker is Markdown-escaped like any other untrusted text
    expect(JSON.parse(json).watermark).toBe(SYNTHETIC_WATERMARK);
  });
  it('redacts secrets on raw text before Markdown escaping (escapeMd, links, inline code, full render)', () => {
    const secret = 'unit_Secret*Value|42';
    registerSecret(secret);
    const escaped = secret.replace(/([\\`*_[\]<>|#~])/g, '\\$1');
    expect(escapeMd(`key ${secret} leaked`)).not.toContain(escaped);
    expect(escapeMd(`key ${secret} leaked`)).toContain('\\[REDACTED\\]');
    const wiki = wikiLinkResolver({ link: (p, a) => `[[${p}${a ? `|${a}` : ''}]]`, notePath: () => 'x.md' });
    const linked = renderLink({ kind: 'recommendation', id: 'r1', label: `Fix ${secret}` }, wiki);
    expect(linked).not.toContain(secret.replace(/[|[\]#^]/g, ' '));
    expect(linked).toContain('REDACTED');
    const r = minimalReport();
    r.sections[0]!.claims[0]!.text = `Wait. Leaked ${secret} here.`;
    r.sections[0]!.claims[0]!.sourceIds = [`sources:${secret}`];
    r.sections[0]!.claims[0]!.evidence = [{ kind: 'db_record', label: `row ${secret}`, ref: `x:${secret}\`y`, supportsClaim: true }];
    const md = renderMarkdown(r);
    expect(md).not.toContain(secret);
    expect(md).not.toContain(escaped);
    expect(md).not.toContain('Value|42');
  });

  it('requires a retrieval date on supported OBSERVED claims', () => {
    const r = minimalReport();
    r.sections[0]!.claims.push(observed('x.no_date', 'A measured value.', { sourceIds: ['t:1'], evidence: [{ kind: 'db_record', label: 't:1', ref: 't:1', supportsClaim: true }] }));
    expect(validateReport(r).map((i) => i.message)).toContain('OBSERVED claim without a retrieval date');
    r.sections[0]!.claims[1] = observed('x.no_date', 'A measured value.', { sourceIds: ['t:1'], retrievedAt: ['2026-09-22T06:00:00.000Z'], evidence: [{ kind: 'db_record', label: 't:1', ref: 't:1', supportsClaim: true }] });
    expect(validateReport(r)).toEqual([]);
  });

  it('marks claims that rest on synthetic rows next to their label', () => {
    const md = renderClaim(observed('s', 'Sandbox SERP shows tables.', { sourceIds: ['sources:s'], retrievedAt: ['2026-09-22T06:00:00.000Z'], synthetic: true, evidence: [{ kind: 'evidence', label: 'e', ref: 'evidence:e', supportsClaim: false }] }));
    expect(md.startsWith(`- **OBSERVED** ${SYNTHETIC_CLAIM_MARKER} Sandbox SERP`)).toBe(true);
  });
});
