import { describe, expect, it } from 'vitest';
import { registerSecret } from '../../../src/security/redact.js';
import { containsSecret, detectSecrets, looksLikeRawMetrics, redactPersonalIdentifiers, sanitizeForMemory } from '../../../src/memory/sanitize.js';
import { documentLinkKeys, extractLinks, normalizeLinkKey, parseMarkdown, stripComments, stripGeneratedRegions } from '../../../src/memory/markdown.js';
import { GENERATED_END, GENERATED_START } from '../../../src/obsidian/types.js';
import { uuidv5, pointIdFor } from '../../../src/memory/uuid.js';

describe('memory content policy', () => {
  it('detects credential shapes and registered secret values without echoing them', () => {
    expect(detectSecrets('Our API key is sk-abcdefghijklmnopqrstuvwx for the gateway')).toContain('registered_or_known_credential');
    expect(detectSecrets('aws AKIAABCDEFGHIJKLMNOP here')).toContain('aws_access_key');
    expect(detectSecrets('password: hunter2hunter2')).toContain('credential_assignment');
    expect(detectSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk')).toContain('jwt');
    registerSecret('synthetic-registered-secret-value-123');
    expect(containsSecret('note mentions synthetic-registered-secret-value-123 by accident')).toBe(true);
    const r = sanitizeForMemory('password = correct-horse-battery');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('correct-horse-battery');
  });

  it('does not flag ordinary business prose', () => {
    expect(containsSecret('The token budget for a draft is 600 tokens. Our password policy requires rotation.')).toBe(false);
    expect(sanitizeForMemory('We sell desk organizers. Shipping is free above 80 EUR.').ok).toBe(true);
  });

  it('redacts personal analytics identifiers', () => {
    const r = redactPersonalIdentifiers('Contact jane.doe@example.test, client_id=GA1.2.123456789.1700000000, ip 192.0.2.44, gclid=abcDEF123456');
    expect(r.text).not.toContain('jane.doe@example.test');
    expect(r.text).not.toContain('123456789.1700000000');
    expect(r.text).not.toContain('192.0.2.44');
    expect(r.text).not.toContain('abcDEF123456');
    expect(r.text).toContain('[EMAIL]');
    expect(r.redactions.email).toBe(1);
    expect(r.redactions.ip_address).toBe(1);
  });

  it('rejects raw metrics dumps but allows small tables', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| /page-${i} | ${100 + i} | ${i * 3} | ${(i / 10).toFixed(2)}% | ${(5 + i / 7).toFixed(1)} |`).join('\n');
    expect(looksLikeRawMetrics(`| page | clicks | impressions | ctr | position |\n|---|---|---|---|---|\n${rows}`)).toBe(true);
    expect(sanitizeForMemory(rows)).toMatchObject({ ok: false, reason: 'raw_metrics' });
    expect(looksLikeRawMetrics('| plan | price | trays |\n|---|---|---|\n| starter | 49 | 1 |\n| bundle | 119 | 3 |')).toBe(false);
  });
});

describe('markdown helpers', () => {
  it('parses frontmatter safely and strips generated regions', () => {
    const raw = `---\ntitle: Offer\napproved: true\n---\n# Offer\n\nHuman text.\n\n${GENERATED_START}\nGenerated.\n${GENERATED_END}\n\nMore human text.`;
    const p = parseMarkdown(raw);
    expect(p.frontmatter.title).toBe('Offer');
    const s = stripGeneratedRegions(p.body);
    expect(s.removed).toBe(1);
    expect(s.text).not.toContain('Generated.');
    expect(s.text).toContain('More human text.');
    expect(parseMarkdown('---\n: : bad yaml [\n---\nbody').frontmatterError).not.toBeNull();
    // Unknown/unsafe tags are never constructed (core schema): the value stays inert data.
    expect(typeof parseMarkdown('---\nx: !!js/function "f"\n---\nb').frontmatter.x).not.toBe('function');
  });

  it('strips invisible comments but keeps fenced code verbatim', () => {
    const body = '<!-- hidden -->\n# Title\n\nVisible %%obsidian comment%% text.\n\n```html\n<!-- kept in code -->\n```\n';
    const out = stripComments(body);
    expect(out).not.toContain('hidden');
    expect(out).not.toContain('obsidian comment');
    expect(out).toContain('<!-- kept in code -->');
    expect(out.startsWith('# Title')).toBe(true);
  });

  it('extracts and normalizes wikilinks and relative markdown links', () => {
    const links = extractLinks('See [[01 Business/Pricing]], [[Pricing#Discounts|discounts]], ![[Audience]], [[#Local]], [x](../01%20Business/Offer.md) and [ext](https://example.test/a.md).');
    expect(links.get('01 business/pricing')).toBe(1);
    expect(links.get('pricing')).toBe(1);
    expect(links.get('audience')).toBe(1);
    expect(links.has('')).toBe(false);
    expect([...links.keys()].some((k) => k.includes('example.test'))).toBe(false);
    expect(normalizeLinkKey('Folder/Note.md#Heading|Alias')).toBe('folder/note');
    expect(documentLinkKeys('01 Business/Pricing.md', ['12 Decisions/D1.md'])).toEqual(['01 business/pricing', 'pricing', '12 decisions/d1', 'd1']);
  });
});

describe('deterministic point ids', () => {
  it('implements RFC 4122 v5 (python.org in the DNS namespace)', () => {
    expect(uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });
  it('derives stable, site-scoped point ids', () => {
    const a = pointIdFor('site-a', 'doc1', 'hash', 0);
    expect(a).toBe(pointIdFor('site-a', 'doc1', 'hash', 0));
    expect(a).not.toBe(pointIdFor('site-b', 'doc1', 'hash', 0));
    expect(a).not.toBe(pointIdFor('site-a', 'doc1', 'hash', 1));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('phone and handle masking for model-bound text (opt-in kinds)', () => {
  it('masks phone-like numbers conservatively: never dates, ranges, decimals, grouped thousands, or plain metrics', () => {
    const r = redactPersonalIdentifiers(
      'Call +1 555 010 0199, (555) 010-0142, 555-010-0133, 555.010.0144, 06 12 34 56 78, 06.12.34.56.78, 0612345678, +33612345678. ' +
        'Keep 1234567890 impressions, position 12.2142857, ctr 0.0345678, 1 234 567 clicks, 1.250.000, 2026-09-24, 24.09.2026, 2019-2026, 1000-2000, 10:30, 198.51.100.23.',
      { phones: true },
    );
    expect(r.redactions.phone).toBe(8);
    expect(r.text).not.toMatch(/555|06 12|0612|3361/);
    for (const keep of ['1234567890 impressions', 'position 12.2142857', 'ctr 0.0345678', '1 234 567 clicks', '1.250.000', '2026-09-24', '24.09.2026', '2019-2026', '1000-2000', '10:30']) expect(r.text).toContain(keep);
    expect(r.text).toContain('[IP]');
  });

  it('masks @handles and u/handles but not JSON-LD keywords, CSS at-rules, emails, or scoped packages', () => {
    const r = redactPersonalIdentifiers('by @jane_doe and @john.smith. See u/redditor_1, reddit.example/user/someone. {"@context":"x","@type":"Product"} @media @import @font-face npm @scope/pkg jane@example.test', { handles: true });
    expect(r.text).toContain('by @[HANDLE] and @[HANDLE].');
    expect(r.text).toContain('u/[HANDLE]');
    expect(r.text).toContain('user/[HANDLE]');
    for (const keep of ['"@context"', '"@type"', '@media', '@import', '@font-face', '@scope/pkg']) expect(r.text).toContain(keep);
    expect(r.text).toContain('[EMAIL]');
    expect(r.redactions.handle).toBe(4);
  });

  it('memory storage defaults are unchanged (phones and handles only on request)', () => {
    const r = redactPersonalIdentifiers('Call +1 555 010 0199 or @jane_doe');
    expect(r.text).toBe('Call +1 555 010 0199 or @jane_doe');
  });
});
