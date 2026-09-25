import { describe, expect, it } from 'vitest';
import { createSitePageFetcher, type PageFetchResult } from '../../../src/approvals/page-fetch.js';
import { bodyFragments, bodyParagraphs, expectationsFromChange, verifyLive } from '../../../src/approvals/verify.js';
import { extractPageFacts, pageFingerprint } from '../../../src/approvals/html.js';
import { pageTargetChecker, recheckTarget } from '../../../src/approvals/target-check.js';
import { offlineFetch } from '../../../src/integrations/types.js';
import { fakeFetch, match } from '../../helpers/fake-fetch.js';
import { htmlPage } from '../../fixtures/experiments/seed.js';

const opts = { allowedHostnames: ['www.example.test'], userAgent: 'test', timeoutMs: 5000, maxBytes: 100_000, maxRedirects: 3, now: () => new Date('2026-09-24T00:00:00Z') };
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

describe('site page fetcher (read-only, own hosts only)', () => {
  it('fetches allowed hosts and follows same-site redirects', async () => {
    const f = fakeFetch([
      match('GET', 'https://www.example.test/old', () => new Response(null, { status: 301, headers: { location: '/new' } })),
      match('GET', 'https://www.example.test/new', () => html('<title>New</title>')),
    ]);
    const r = await createSitePageFetcher({ ...opts, fetch: f, offline: false })('https://www.example.test/old');
    expect(r.ok && r.page.finalUrl).toBe('https://www.example.test/new');
    expect(r.ok && r.page.redirectChain).toEqual(['https://www.example.test/old']);
    expect(f.calls.every((c) => !('authorization' in c.headers) && !('cookie' in c.headers))).toBe(true);
  });

  it('refuses other hosts, redirects off-site, unsafe schemes, credentials in URLs, and reports offline honestly', async () => {
    const f = fakeFetch([match('GET', 'https://www.example.test/away', () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }))]);
    const fetcher = createSitePageFetcher({ ...opts, fetch: f, offline: false });
    expect(await fetcher('https://evil.example.invalid/')).toMatchObject({ ok: false, reason: 'blocked_host' });
    expect(await fetcher('https://www.example.test/away')).toMatchObject({ ok: false, reason: 'blocked_host' });
    expect(await fetcher('file:///etc/passwd')).toMatchObject({ ok: false, reason: 'unsafe_url' });
    expect(await fetcher('https://user:pw@www.example.test/')).toMatchObject({ ok: false, reason: 'unsafe_url' });
    expect(f.calls.map((c) => c.url)).toEqual(['https://www.example.test/away']);
    expect(await createSitePageFetcher({ ...opts, fetch: offlineFetch, offline: true })('https://www.example.test/')).toMatchObject({ ok: false, reason: 'offline' });
    expect(await createSitePageFetcher({ ...opts, fetch: offlineFetch, offline: false })('https://www.example.test/')).toMatchObject({ ok: false, reason: 'offline' });
  });

  it('enforces size and content-type limits and reports HTTP errors', async () => {
    const f = fakeFetch([
      match('GET', 'https://www.example.test/big', () => html('x'.repeat(200_000))),
      match('GET', 'https://www.example.test/pdf', () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })),
      match('GET', 'https://www.example.test/gone', () => html('', 404)),
    ]);
    const fetcher = createSitePageFetcher({ ...opts, fetch: f, offline: false });
    expect(await fetcher('https://www.example.test/big')).toMatchObject({ ok: false, reason: 'too_large' });
    expect(await fetcher('https://www.example.test/pdf')).toMatchObject({ ok: false, reason: 'unsupported_content' });
    expect(await fetcher('https://www.example.test/gone')).toMatchObject({ ok: false, reason: 'http_error', status: 404 });
  });
});

describe('target recheck and live verification', () => {
  it('fingerprints SEO-relevant page state; scripts do not matter, content does', () => {
    const a = htmlPage({ title: 'T', description: 'D' });
    expect(pageFingerprint(a)).toBe(pageFingerprint(a.replace('</body>', '<script>var x = Date.now()</script></body>')));
    expect(pageFingerprint(a)).not.toBe(pageFingerprint(htmlPage({ title: 'T2', description: 'D' })));
    expect(extractPageFacts('<html><head><title>X</title><meta name="Description" content=" d "></head><body><p>a</p><p>b</p></body></html>')).toMatchObject({ title: 'X', metaDescription: 'd', mainText: 'a b' });
  });

  it('detects a changed target, an unchanged target, a still-absent target, and an unverifiable one', async () => {
    const f = fakeFetch([
      match('GET', 'https://www.example.test/p', () => html(htmlPage({ title: 'Now', description: 'D' }))),
      match('GET', 'https://www.example.test/missing', () => html('', 404)),
    ]);
    const checker = pageTargetChecker(createSitePageFetcher({ ...opts, fetch: f, offline: false }));
    const current = pageFingerprint(htmlPage({ title: 'Now', description: 'D' }));
    expect((await recheckTarget(checker, 'https://www.example.test/p', current)).status).toBe('unchanged');
    expect((await recheckTarget(checker, 'https://www.example.test/p', 'stale')).status).toBe('changed');
    expect((await recheckTarget(checker, 'https://www.example.test/missing', 'absent:404')).status).toBe('unchanged');
    expect((await recheckTarget(checker, 'https://www.example.test/p', null)).status).toBe('unverifiable');
    const offline = pageTargetChecker(createSitePageFetcher({ ...opts, fetch: offlineFetch, offline: true }));
    expect((await recheckTarget(offline, 'https://www.example.test/p', current)).status).toBe('unverifiable');
  });

  it('verifies title/meta/body/redirect/removal expectations and never calls an unchecked change verified', () => {
    const page = (h: string, extra: Partial<{ finalUrl: string; redirectChain: string[] }> = {}) =>
      ({ ok: true, page: { requestedUrl: 'u', finalUrl: extra.finalUrl ?? 'https://www.example.test/p', status: 200, contentType: 'text/html', html: h, fetchedAt: 'now', redirectChain: extra.redirectChain ?? [] } }) as const;
    const body = 'Intro paragraph that is long enough to be used as a verification fragment in tests.\n\nSecond paragraph that is also long enough to be checked against the live page text.';
    const exp = expectationsFromChange('update_page', { title: 'New T', metaDescription: 'New D', bodyMarkdown: body });
    expect(exp.bodyParagraphs).toHaveLength(2);
    expect(exp.bodyScope).toBe('full');
    const good = htmlPage({ title: 'New T', description: 'New D', body: `<p>Intro paragraph that is long enough to be used as a verification fragment in tests.</p><p>Second paragraph that is also long enough to be checked against the live page text.</p>` });
    expect(verifyLive(exp, page(good), 'h').status).toBe('match');
    expect(verifyLive(exp, page(htmlPage({ title: 'Old', description: 'Old' })), 'h').status).toBe('mismatch');
    expect(verifyLive(exp, { ok: false, reason: 'offline', detail: 'x' }, 'h').status).toBe('unverified');
    expect(verifyLive(expectationsFromChange('update_page', { instructions: 'free text only' }), page(good), 'h')).toMatchObject({ status: 'unverified' });
    const redirect = expectationsFromChange('redirect', { redirectTo: 'https://www.example.test/new' });
    expect(verifyLive(redirect, page(good, { finalUrl: 'https://www.example.test/new', redirectChain: ['https://www.example.test/p'] }), 'h').status).toBe('match');
    expect(verifyLive(redirect, page(good), 'h').status).toBe('mismatch');
    const del = expectationsFromChange('delete_page', {});
    expect(verifyLive(del, { ok: false, reason: 'http_error', detail: '404', status: 404 }, 'h').status).toBe('match');
    expect(verifyLive(del, page(good), 'h').status).toBe('mismatch');
    expect(bodyFragments('short')).toEqual([]);
    expect(bodyParagraphs('short')).toEqual(['short']);
  });
});

describe('live verification compares the whole approved body (never a sample)', () => {
  const page = (h: string): PageFetchResult => ({ ok: true, page: { requestedUrl: 'u', finalUrl: 'https://www.example.test/p', status: 200, contentType: 'text/html', html: h, fetchedAt: 'now', redirectChain: [] } });
  const paras = Array.from({ length: 12 }, (_, i) => `Synthetic paragraph number ${i + 1} explains one more detail of the widget guide for the verification test.`);
  const body = `# Synthetic widget guide\n\n${paras.join('\n\n')}`;
  const change = { title: 'Synthetic widget guide', bodyMarkdown: body };
  const live = (ps: string[], extra = '') => htmlPage({ title: 'Synthetic widget guide', description: 'D', body: `${ps.map((p) => `<p>${p}</p>`).join('')}${extra}` });

  it('reports "match" only when every approved paragraph is live and nothing else is', () => {
    const r = verifyLive(expectationsFromChange('update_page', change), page(live(paras)), 'h');
    expect(r.status).toBe('match');
    expect(r.coverage).toMatchObject({ scope: 'full', paragraphs: { total: 13, found: 13, missing: [] }, unapproved: { status: 'none' }, summary: 'complete: 13/13 paragraphs found, no unapproved content' });
  });

  it('missing paragraphs: partial with coverage, even when every former 5-sample fragment is present', () => {
    // The old sampler checked paragraphs 1, 4, 7, 10, 12 (evenly spaced); keep exactly those live.
    const kept = [0, 3, 6, 9, 11].map((i) => paras[i]!);
    const r = verifyLive(expectationsFromChange('update_page', change), page(live(kept)), 'h');
    expect(r.status).toBe('partial');
    expect(r.coverage?.paragraphs).toMatchObject({ total: 13, found: 6 });
    expect(r.coverage?.paragraphs.missing).toHaveLength(7);
    expect(r.reason).toMatch(/^partial: 6\/13 paragraphs found/);
    expect(r.checks.find((c) => c.name === 'body paragraphs')).toMatchObject({ pass: false, observed: expect.stringMatching(/^6\/13 found; missing: /) });
  });

  it('injected content (e.g. spam links from a tampered package) is flagged as unapproved, never a match', () => {
    const r = verifyLive(expectationsFromChange('update_page', change), page(live(paras, '<p>Buy cheap synthetic pills at <a href="https://spam.example.invalid/">spam.example.invalid</a> today</p>')), 'h');
    expect(r.status).toBe('partial');
    expect(r.coverage?.paragraphs.found).toBe(13);
    expect(r.coverage?.unapproved).toMatchObject({ status: 'found', blocks: [expect.stringMatching(/buy cheap synthetic pills at spam\.example\.invalid today/)] });
    expect(r.checks.find((c) => c.name === 'unapproved main content')).toMatchObject({ pass: false });
    expect(r.reason).toMatch(/1 unapproved block\(s\) in the live main text/);
    // A spam link spliced INTO an approved paragraph: that paragraph is missing and the altered text is flagged.
    const tampered = [...paras];
    tampered[5] = tampered[5]!.replace('one more detail', 'one more detail <a href="https://spam.example.invalid/">cheap pills here</a>');
    const r2 = verifyLive(expectationsFromChange('update_page', change), page(live(tampered)), 'h');
    expect(r2.status).toBe('partial');
    expect(r2.coverage?.paragraphs.found).toBe(12);
    expect(r2.coverage?.unapproved.status).toBe('found');
  });

  it('template chrome outside <main> is ignored; stray short fragments are not flagged', () => {
    const html = live(paras, '<p>Share</p>').replace('<nav>Synthetic nav</nav>', '<nav>Home Blog About Contact Pricing Careers Newsroom</nav><footer>Copyright synthetic widgets incorporated all rights reserved</footer>');
    expect(verifyLive(expectationsFromChange('update_page', change), page(html), 'h').status).toBe('match');
  });

  it('a section change allows the rest of the page only when it was there before; without a before-snapshot it is never "match"', () => {
    const section = 'Synthetic new section paragraph explaining the updated widget warranty terms in detail.';
    const before = 'Synthetic widget guide Existing intro paragraph about widgets that was on the page before the change. Existing closing paragraph that stays.';
    const html = htmlPage({ title: 'Synthetic widget guide', description: 'D', body: `<p>Existing intro paragraph about widgets that was on the page before the change.</p><p>${section}</p><p>Existing closing paragraph that stays.</p>` });
    const withBaseline = verifyLive(expectationsFromChange('update_page', { bodyMarkdown: section }, { bodyScope: 'section', baselineText: before }), page(html), 'h');
    expect(withBaseline.status).toBe('match');
    expect(withBaseline.coverage).toMatchObject({ scope: 'section', unapproved: { status: 'none' } });
    const injected = html.replace('</main>', '<p>Visit the synthetic casino example invalid for bonuses</p></main>');
    const r = verifyLive(expectationsFromChange('update_page', { bodyMarkdown: section }, { bodyScope: 'section', baselineText: before }), page(injected), 'h');
    expect(r.status).toBe('partial');
    expect(r.coverage?.unapproved.blocks.join(' ')).toMatch(/synthetic casino/);
    const noBaseline = verifyLive(expectationsFromChange('update_page', { bodyMarkdown: section }, { bodyScope: 'section' }), page(html), 'h');
    expect(noBaseline.status).toBe('partial');
    expect(noBaseline.coverage?.unapproved.status).toBe('not_checked');
    expect(noBaseline.reason).toMatch(/no before-snapshot text/);
  });
});
