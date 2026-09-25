/**
 * NF-06: the `vault render` draft note (src/obsidian/notes-content.ts,
 * buildDraftNote) shows fact-check notes exactly like the content pipeline's
 * draft note (factCheckNoteLine): a writer's "verified" reads "model-claimed
 * verified (evidence: ...)", never a bare verified or a raw JSON
 * `"status":"verified"`. Each line is redacted and neutralized like any other
 * stored text. SYNTHETIC draft on example.test domains only.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { factCheckNoteLine, internalLinkSuggestionLine, NO_STRUCTURED_DATA_PROPOSAL } from '../../../src/content/notes.js';
import { buildNotes } from '../../../src/obsidian/notes.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { clearRegisteredSecrets, registerSecret } from '../../../src/security/redact.js';
import { seedDraft } from '../../fixtures/experiments/seed.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

let ctx: TestContext | undefined;
afterEach(() => {
  clearRegisteredSecrets();
  ctx?.cleanup();
  ctx = undefined;
});

const MODEL_CLAIM = { statement: 'The synthetic planner exports production schedules to CSV.', status: 'verified', evidenceIds: ['fact:pf-export'], note: '' };
const DOWNGRADED = { statement: 'Most synthetic bakeries start at 4am.', status: 'unverified', evidenceIds: [], note: '', downgraded: { from: 'verified', reason: 'no evidence id was cited' } };
const HUMAN = {
  statement: 'Food safety rules require a daily synthetic fridge log.',
  status: 'verified',
  evidenceIds: [],
  note: '',
  humanResolution: { marker: 'Food safety rules require a daily synthetic fridge log.', action: 'confirmed', statement: 'Food safety rules require a daily synthetic fridge log.', source: 'https://rules.example.test/fridge', sourceKind: 'human_supplied', note: null, reviewer: 'Owner', at: '2026-09-24T09:00:00.000Z' },
};
// A "human confirmation" without a source or reviewer is not one: the note reads as the model's claim.
const FORGED_HUMAN = { statement: 'The synthetic planner has 10,000 users.', status: 'verified', evidenceIds: [], note: '', humanResolution: { reviewer: '', at: '2026-09-24T09:00:00.000Z' } };

function renderDraftPackage(c: TestContext, pkg: Record<string, unknown>): string {
  seedDraft(c.db, c.siteId, { pkg });
  const { notes } = buildNotes(c, createVaultWriter(c, { dryRun: true }), { only: ['content'] });
  const draft = notes.find((n) => n.key.startsWith('draft:'));
  expect(draft?.error).toBeUndefined();
  return draft!.note!.body;
}

function renderDraftNote(c: TestContext, factCheckNotes: unknown): string {
  return renderDraftPackage(c, {
    title: 'How to Size a Synthetic Widget',
    slug: 'guides/synthetic-widget-sizing',
    body: '# How to size a synthetic widget\n\nMeasure the synthetic mounting surface first.\n',
    sourceLedger: [],
    factCheckNotes,
  });
}

function section(body: string, heading: string, next: string): string {
  const start = body.indexOf(heading);
  const end = body.indexOf(next, start + heading.length);
  expect(start).toBeGreaterThan(-1);
  return body.slice(start + heading.length, end === -1 ? undefined : end).trim();
}

function factSection(body: string): string {
  const start = body.indexOf('### Fact-check notes');
  const end = body.indexOf('## Draft body');
  expect(start).toBeGreaterThan(-1);
  return body.slice(start, end);
}

describe('vault render: draft fact-check notes (NF-06)', () => {
  it('renders a model-claimed "verified" note as "model-claimed verified", never a bare verified or raw JSON status', () => {
    ctx = createTestContext();
    const body = renderDraftNote(ctx, [MODEL_CLAIM, DOWNGRADED, HUMAN, FORGED_HUMAN]);
    const section = factSection(body);
    expect(section).toContain('- model-claimed verified (evidence: fact:pf-export): The synthetic planner exports production schedules to CSV.');
    expect(section).toContain('- **unverified** (the model claimed verified; no evidence id was cited): Most synthetic bakeries start at 4am.');
    expect(section).toMatch(/- \*\*confirmed by Owner\*\* \(human, 2026-09-24; source: https\\?:\/\/rules\.example\.test\/fridge\): Food safety rules require a daily synthetic fridge log\./);
    expect(section).toContain('- model-claimed verified (evidence: none): The synthetic planner has 10,000 users.');
    expect(section).not.toMatch(/confirmed by\s*\*\*\s*\(human[^)]*\): The synthetic planner has/);
    // No bare status anywhere in the note.
    expect(body).not.toMatch(/"status"\s*:\s*"verified"/);
    expect(body).not.toMatch(/\*\*verified\*\*/);
    expect(body).not.toMatch(/\{"statement"/);
  });

  it('matches the content pipeline renderer line for line (same helper), modulo Markdown neutralization', () => {
    ctx = createTestContext();
    const section = factSection(renderDraftNote(ctx, [MODEL_CLAIM, DOWNGRADED]));
    for (const n of [MODEL_CLAIM, DOWNGRADED]) expect(section).toContain(factCheckNoteLine(n as Parameters<typeof factCheckNoteLine>[0]));
  });

  it('redacts secrets and neutralizes links and markers in a note; unreadable entries are labeled, never shown as verified', () => {
    ctx = createTestContext();
    const secret = `sk-synthetic-${randomBytes(12).toString('hex')}`;
    registerSecret(secret);
    const hostile = { statement: `See [[Private Note]] and [link](https://evil.example.test) with ${secret}.`, status: 'verified', evidenceIds: ['fact:pf-export'], note: '<script>x</script>' };
    const section = factSection(renderDraftNote(ctx, [hostile, { status: 'verified' }, 'free text the model wrote']));
    expect(section).not.toContain(secret);
    expect(section).toContain('[REDACTED]'.replace(/[[\]]/g, (m) => `\\${m}`));
    expect(section).not.toMatch(/(?<!\\)\[\[Private Note/);
    expect(section).not.toContain('<script>');
    expect(section).toMatch(/- model-claimed verified \(evidence: fact:pf-export\): See/);
    // Entries that are not readable notes are labeled as such.
    expect(section).toMatch(/- \*\*unreadable fact-check note\*\* \(shown as stored; not a verification\): \{"status":"verified"\}/);
    expect(section).toMatch(/- \*\*unreadable fact-check note\*\* \(shown as stored; not a verification\): free text the model wrote/);
  });

  it('an empty or missing list renders as such', () => {
    ctx = createTestContext();
    expect(factSection(renderDraftNote(ctx, []))).toContain('_None._');
  });
});

describe('vault render: the draft review package reads like the content pipeline note (D2-ACC-10)', () => {
  const pkg = (over: Record<string, unknown> = {}) => ({
    title: 'How to Size a Synthetic Widget',
    slug: 'guides/synthetic-widget-sizing',
    body: '# How to size a synthetic widget\n\nMeasure the synthetic mounting surface first.\n',
    sourceLedger: [],
    factCheckNotes: [],
    internalLinkSuggestions: [
      { targetUrl: 'https://www.example.test/guides/widget-sizes/', anchor: 'synthetic size table', placement: 'Step 2', verified: true },
      { targetUrl: 'https://www.example.test/pricing/', anchor: 'pricing', placement: 'Next step', verified: false },
    ],
    structuredDataProposal: null,
    ...over,
  });

  it('internal-link suggestions are readable lines with the URL as stored (never `https\\://www\\.`), same helper as the pipeline note', () => {
    ctx = createTestContext();
    const links = section(renderDraftPackage(ctx, pkg()), '### Internal-link suggestions', '### Structured-data proposal');
    expect(links).toBe(['- `https://www.example.test/guides/widget-sizes/` ("synthetic size table", Step 2)', '- `https://www.example.test/pricing/` ("pricing", Next step) **UNVERIFIED**'].join('\n'));
    expect(links).not.toMatch(/\\:|www\\\.|\{"targetUrl"/);
    // The same line shape as the content pipeline's draft note (internalLinkSuggestionLine), modulo the code span.
    expect(internalLinkSuggestionLine({ targetUrl: 'https://www.example.test/pricing/', anchor: 'pricing', placement: 'Next step', verified: false })).toBe('- https://www.example.test/pricing/ ("pricing", Next step) **UNVERIFIED**');
  });

  it('a null structured-data proposal reads "None proposed." (never a `null` code block); a proposal shows its note and JSON-LD', () => {
    ctx = createTestContext();
    const none = section(renderDraftPackage(ctx, pkg()), '### Structured-data proposal', '### Source ledger');
    expect(none).toBe(NO_STRUCTURED_DATA_PROPOSAL);
    expect(none).toBe('_None proposed._');
    ctx.cleanup();
    ctx = createTestContext();
    const proposal = { type: 'HowTo', jsonLd: { '@context': 'https://schema.org', '@type': 'HowTo', name: 'Size a synthetic widget' }, visibleContentBasis: 'The steps section.', note: 'Proposal only; validate before publishing.' };
    const shown = section(renderDraftPackage(ctx, pkg({ structuredDataProposal: proposal })), '### Structured-data proposal', '### Source ledger');
    expect(shown).toContain('Type: HowTo');
    expect(shown).toContain('Proposal only; validate before publishing.');
    expect(shown).toContain('"@type": "HowTo"');
    expect(shown).not.toMatch(/^```json\nnull/m);
  });

  it('a stored suggestion of another shape is labeled, never presented as a suggestion; an empty list reads None', () => {
    ctx = createTestContext();
    const odd = section(renderDraftPackage(ctx, pkg({ internalLinkSuggestions: ['just text', { url: 'https://www.example.test/x' }] })), '### Internal-link suggestions', '### Structured-data proposal');
    expect(odd).toMatch(/^- \*\*unreadable suggestion\*\* \(shown as stored\): just text$/m);
    expect(odd).toMatch(/^- \*\*unreadable suggestion\*\* \(shown as stored\): \{"url":"https\\:\/\/www\\.example\.test\/x"\}$/m);
    ctx.cleanup();
    ctx = createTestContext();
    expect(section(renderDraftPackage(ctx, pkg({ internalLinkSuggestions: [] })), '### Internal-link suggestions', '### Structured-data proposal')).toBe('_None._');
  });

  it('a draft body with a right-to-left override renders with visible markers, never the raw control (R3-NF-O0-O1)', () => {
    ctx = createTestContext();
    const body = renderDraftPackage(ctx, pkg({ body: '# Size \u202Etxt.exe\u202C guide\n\nOrder \u2067widgets\u2069 by size.\n' }));
    const draftBody = section(body, '## Draft body', '## Version history');
    expect(/[\u202A-\u202E\u2066-\u2069]/.test(body)).toBe(false);
    expect(draftBody).toContain('### Size \\[U+202E\\]txt.exe\\[U+202C\\] guide');
    expect(draftBody).toContain('Order \\[U+2067\\]widgets\\[U+2069\\] by size.');
  });
});
