import { describe, expect, it } from 'vitest';
import { assessAeoPage, splitSections, type AeoPageInput } from '../../../src/crawler/aeo.js';

/** SYNTHETIC page snapshots (visible text one block per line, as the crawler stores it). */
const GOOD_TEXT = [
  'Widget pricing guide',
  'A standard synthetic widget costs between 40 and 60 dollars in 2026, and widget pricing depends mostly on the frame material and the order size.',
  'How much does a custom widget cost?',
  'A custom widget costs about twice the price of a standard widget because each frame is cut to order.',
  'Sources',
  'Synthetic Widget Survey 2026 (research.example.com).',
].join('\n');

const good = (over: Partial<AeoPageInput> = {}): AeoPageInput => ({
  title: 'Widget pricing guide (synthetic)',
  headings: [
    { level: 1, text: 'Widget pricing guide' },
    { level: 2, text: 'How much does a custom widget cost?' },
    { level: 2, text: 'Sources' },
  ],
  emptyHeadings: 0,
  text: GOOD_TEXT,
  externalLinks: [{ href: 'https://research.example.com/widget-survey-2026', anchor: 'Read the survey' }],
  externalLinkCount: 1,
  dateModified: null,
  language: 'en',
  topQueries: [
    { query: 'widget pricing', clicks: 4, impressions: 400 },
    { query: 'how much does a widget cost', clicks: 1, impressions: 120 },
  ],
  ...over,
});

describe('splitSections', () => {
  it('splits visible text at heading lines in document order', () => {
    const s = splitSections(GOOD_TEXT, good().headings);
    expect(s.map((x) => x.heading?.text ?? null)).toEqual([null, 'Widget pricing guide', 'How much does a custom widget cost?', 'Sources']);
    expect(s[2]!.body).toMatch(/^A custom widget costs/);
  });
});

describe('assessAeoPage (deterministic heuristics)', () => {
  it('a page that answers its top queries up front, with descriptive headings and sources, is ok on every check', () => {
    const a = assessAeoPage(good());
    expect(a.label).toBe('HEURISTIC');
    expect(a.answer.status).toBe('ok');
    expect(a.answer.queries.map((q) => q.answeredNearTop)).toEqual([true, true]);
    expect(a.headings).toMatchObject({ status: 'ok', generic: [], empty: 0 });
    expect(a.headings.questionHeadings).toEqual([{ text: 'How much does a custom widget cost?', answered: true, detail: 'followed by a direct statement' }]);
    expect(a.sections).toMatchObject({ status: 'ok', backReferences: [] });
    expect(a.evidence).toMatchObject({ status: 'ok', citationLinks: 1, referencesSection: true });
    expect(a.caveats[0]).toMatch(/not Google ranking rules/);
  });

  it('flags a top query that is not addressed near the top', () => {
    const a = assessAeoPage(good({ topQueries: [{ query: 'widget warranty length', clicks: 0, impressions: 90 }] }));
    expect(a.answer.status).toBe('review');
    expect(a.answer.queries[0]).toMatchObject({ answeredNearTop: false, matchedTerms: ['widget'] });
    expect(a.answer.summary).toMatch(/not clearly addressed/);
  });

  it('reports DATA_UNAVAILABLE (unknown) without Search Console queries instead of guessing', () => {
    const a = assessAeoPage(good({ topQueries: null }));
    expect(a.answer.status).toBe('unknown');
    expect(a.answer.summary).toMatch(/DATA_UNAVAILABLE/);
  });

  it('flags generic and empty headings, unanswered question headings, back-references, and unsupported figures', () => {
    const text = [
      'Welcome',
      'Thanks for stopping by our synthetic website today.',
      'Introduction',
      'There is a lot to say about this topic.',
      'How long does widget delivery take?',
      'Good question?',
      'More',
      'As mentioned above, our prices are the best. 87% of customers agree and we sold 12,000 units.',
      'Conclusion',
      'See the previous section for details, as discussed earlier.',
    ].join('\n');
    const a = assessAeoPage({
      title: 'Widgets (synthetic)',
      headings: [
        { level: 1, text: 'Welcome' },
        { level: 2, text: 'Introduction' },
        { level: 2, text: 'How long does widget delivery take?' },
        { level: 2, text: 'More' },
        { level: 2, text: 'Conclusion' },
      ],
      emptyHeadings: 1,
      text,
      externalLinks: [{ href: 'https://twitter.com/example', anchor: 'Follow us' }],
      externalLinkCount: 1,
      dateModified: null,
      language: 'en',
      topQueries: [{ query: 'widget delivery time', clicks: 0, impressions: 50 }],
    });
    expect(a.headings.status).toBe('review');
    expect(a.headings.generic).toEqual(['Introduction', 'More', 'Conclusion']);
    expect(a.headings.empty).toBe(1);
    expect(a.headings.questionHeadings[0]).toMatchObject({ answered: false });
    expect(a.sections.status).toBe('review');
    expect(a.sections.backReferences.map((b) => b.phrase.toLowerCase())).toEqual(['as mentioned above', 'see the previous section', 'as discussed earlier']);
    expect(a.evidence).toMatchObject({ status: 'review', citationLinks: 0, numericClaims: 2 });
    expect(a.evidence.summary).toMatch(/2 figure\(s\).*no outbound source/);
    expect(a.answer.status).toBe('review');
  });

  it('marks English phrase patterns as under-reporting on other languages and never throws without text', () => {
    const a = assessAeoPage(good({ language: 'de', text: null }));
    expect(a.caveats.join(' ')).toMatch(/language is "de"/);
    expect([a.answer.status, a.sections.status, a.evidence.status]).toEqual(['unknown', 'unknown', 'unknown']);
  });
});
