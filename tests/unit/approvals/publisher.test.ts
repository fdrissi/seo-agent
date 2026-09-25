import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { createPublisher, ManualExportPublisher, proposalArtifactHash, type PublishProposal } from '../../../src/approvals/publisher.js';
import { markdownToHtml } from '../../../src/approvals/markdown.js';
import { unifiedDiff } from '../../../src/approvals/diff.js';
import { computeArtifactHash, canonicalChange, mapToApprovalActionType } from '../../../src/approvals/artifact.js';
import type { ApprovalRecord } from '../../../src/approvals/types.js';

function proposal(overrides: Partial<PublishProposal> = {}): PublishProposal {
  return {
    siteId: 'test-site',
    subjectType: 'recommendation',
    subjectId: 'rec_1',
    actionType: 'update_page',
    productionBound: true,
    targetUrl: 'https://www.example.test/widgets',
    pageId: 'p1',
    title: 'Synthetic change',
    summary: 'Synthetic summary',
    change: { instructions: 'Add a section', bodyMarkdown: '## New section\n\nSynthetic paragraph with a [link](https://docs.example.test/x).' },
    current: { snapshotRef: null, capturedAt: null, title: null, metaDescription: null, canonical: null, robots: null, text: null, note: 'none' },
    rollbackPlan: 'Revert.',
    context: {},
    isSynthetic: true,
    warnings: [],
    ...overrides,
  };
}

function approvalFor(hash: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'apr_1',
    siteId: 'test-site',
    actionType: 'update_page',
    target: 'https://www.example.test/widgets',
    subjectType: 'recommendation',
    subjectId: 'rec_1',
    artifactHash: hash,
    sourceRevision: null,
    summary: 's',
    status: 'executed',
    requestedBy: 'owner:a',
    requestedAt: '2026-09-01T00:00:00.000Z',
    approver: 'Alice',
    decidedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-08T00:00:00.000Z',
    executedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('artifact hashing', () => {
  it('is stable across formatting noise and changes with any content change', () => {
    const a = computeArtifactHash({ actionType: 'update_page', target: 'https://x.test/', change: canonicalChange({ title: ' T ', body: undefined, links: [] }) });
    const b = computeArtifactHash({ actionType: 'update_page', target: 'https://x.test/', change: canonicalChange({ title: 'T' }) });
    expect(a).toBe(b);
    expect(computeArtifactHash({ actionType: 'update_page', target: 'https://x.test/', change: { title: 'T2' } })).not.toBe(b);
    expect(computeArtifactHash({ actionType: 'redirect', target: 'https://x.test/', change: { title: 'T' } })).not.toBe(b);
    expect(computeArtifactHash({ actionType: 'update_page', target: 'https://x.test/y', change: { title: 'T' } })).not.toBe(b);
  });

  it('maps free-form actions to production approval types, defaulting to update_page (never weaker)', () => {
    expect(mapToApprovalActionType('rewrite_title_meta')).toBe('title_meta_change');
    expect(mapToApprovalActionType('301 redirect')).toBe('redirect');
    expect(mapToApprovalActionType('noindex thin page')).toBe('robots_change');
    expect(mapToApprovalActionType('delete_page')).toBe('delete_page');
    expect(mapToApprovalActionType('fix GA4 tracking')).toBe('analytics_change');
    expect(mapToApprovalActionType('something new')).toBe('update_page');
  });
});

describe('ManualExportPublisher', () => {
  let ctx: TestContext | undefined;
  afterEach(() => ctx?.cleanup());

  it('never overwrites an existing package and refuses an unapproved production artifact', () => {
    ctx = createTestContext();
    const pub = new ManualExportPublisher({ exportsDir: ctx.paths.exportsDir, siteId: 'test-site', timeZone: 'Europe/Tallinn', clock: ctx.clock });
    const art = pub.prepare(proposal());
    expect(() => pub.publishSync({ artifact: art, approval: null, recheck: null, allowUnverifiedTarget: false, actor: 'owner:a' })).toThrow(/needs an approval/);
    expect(() => pub.publishSync({ artifact: art, approval: approvalFor('0'.repeat(64)), recheck: null, allowUnverifiedTarget: false, actor: 'owner:a' })).toThrow(/not bound to this exact artifact/);
    expect(() => pub.publishSync({ artifact: art, approval: approvalFor(art.artifactHash, { status: 'pending' }), recheck: null, allowUnverifiedTarget: false, actor: 'owner:a' })).toThrow(/pending/);
    const r1 = pub.publishSync({ artifact: art, approval: approvalFor(art.artifactHash), recheck: null, allowUnverifiedTarget: false, actor: 'owner:a' });
    const r2 = pub.publishSync({ artifact: art, approval: approvalFor(art.artifactHash), recheck: null, allowUnverifiedTarget: false, actor: 'owner:a' });
    expect(r1.exportDir).not.toBe(r2.exportDir);
    expect(path.basename(r2.exportDir)).toMatch(/-2$/);
    expect(r1.liveChange).toBe(false);
    // No temp directories left behind.
    expect(readdirSync(path.dirname(r1.exportDir)).filter((d) => d.startsWith('.tmp'))).toEqual([]);
    expect(() => pub.publishSync({ artifact: art, approval: approvalFor(art.artifactHash), recheck: null, allowUnverifiedTarget: false, actor: 'owner:a' }, r1.exportDir)).toThrow(/already exists/);
  });

  it('detects tampering between prepare and publish', () => {
    ctx = createTestContext();
    const pub = new ManualExportPublisher({ exportsDir: ctx.paths.exportsDir, siteId: 'test-site', timeZone: 'UTC', clock: ctx.clock });
    const art = pub.prepare(proposal());
    art.proposal.change.bodyMarkdown = 'tampered';
    expect(() => pub.publishSync({ artifact: art, approval: approvalFor(art.artifactHash), recheck: null, allowUnverifiedTarget: false, actor: 'owner:a' })).toThrow(/does not match its hash/);
    expect(proposalArtifactHash(art.proposal)).not.toBe(art.artifactHash);
  });

  it('keeps export directories inside the workspace export folder', () => {
    ctx = createTestContext();
    const pub = new ManualExportPublisher({ exportsDir: ctx.paths.exportsDir, siteId: 'test-site', timeZone: 'UTC', clock: ctx.clock });
    const art = pub.prepare(proposal({ title: '../../../etc/passwd' }));
    const dir = pub.plannedDir(art);
    expect(dir.startsWith(path.join(ctx.paths.exportsDir, 'test-site'))).toBe(true);
    mkdirSync(path.join(ctx.paths.exportsDir, 'elsewhere'), { recursive: true });
    expect(() => pub.publishSync({ artifact: art, approval: approvalFor(art.artifactHash), recheck: null, allowUnverifiedTarget: false, actor: 'x' }, path.join(ctx!.paths.exportsDir, 'elsewhere', 'x'))).toThrow(/UNSAFE_PATH|directly inside/);
    expect(existsSync(path.join(ctx.paths.exportsDir, 'elsewhere', 'x'))).toBe(false);
  });

  it('flags credential-like content without altering it', () => {
    ctx = createTestContext();
    const pub = new ManualExportPublisher({ exportsDir: ctx.paths.exportsDir, siteId: 'test-site', timeZone: 'UTC', clock: ctx.clock });
    const body = 'Use key sk-abcdefghijklmnopqrstuvwxyz123456 here.';
    const art = pub.prepare(proposal({ change: { bodyMarkdown: body } }));
    expect(art.proposal.warnings.join(' ')).toMatch(/credential-like/);
    expect(art.files.find((f) => f.path === 'content.md')?.content).toContain(body);
    const prose = pub.prepare(proposal({ change: { bodyMarkdown: 'Basic principles of synthetic widgets. The password field is optional.' } }));
    expect(prose.proposal.warnings).toEqual([]);
  });

  it('CMS/Git publishers are documented placeholders that refuse honestly', () => {
    ctx = createTestContext();
    const opts = { exportsDir: ctx.paths.exportsDir, siteId: 'test-site', timeZone: 'UTC', clock: ctx.clock };
    expect(createPublisher('manual_export', opts).kind).toBe('manual_export');
    for (const k of ['wordpress', 'webflow', 'cms_adapter', 'git_patch']) {
      try {
        createPublisher(k, opts);
        expect.unreachable();
      } catch (e) {
        expect((e as { code: string }).code).toBe('INTEGRATION_UNAVAILABLE');
      }
    }
  });
});

describe('markdown and diff helpers', () => {
  it('converts common Markdown and escapes HTML and unsafe links', () => {
    const html = markdownToHtml('# Title\n\nSome **bold** and *em* text with <script>alert(1)</script>.\n\n- a\n- b\n\n1. one\n\n[x](javascript:alert(1)) [ok](/path)\n\n```js\nconst a = "<b>";\n```');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="/path">ok</a>');
    expect(html).toContain('<pre><code class="language-js">const a = &quot;&lt;b&gt;&quot;;</code></pre>');
  });

  it('produces a unified diff with hunks and counts', () => {
    const d = unifiedDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.unified).toContain('-b');
    expect(d.unified).toContain('+B');
    expect(d.unified).toContain('+e');
    expect(d.unified).toMatch(/@@ -1,4 \+1,5 @@/);
    expect(unifiedDiff('same', 'same').unified).toContain('(no differences)');
  });
});
