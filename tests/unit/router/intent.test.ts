import { describe, expect, it, vi } from 'vitest';
import { classifyQueries, IntentClassifierRules, type IntentClassifierHook } from '../../../src/router/intent.js';

describe('deterministic intent rules', () => {
  const rules = new IntentClassifierRules({ brandAliases: ['Acme Widgets', 'Ümlaut Co', 'WidgetHub'] });

  it('marks branded queries from configured aliases (diacritic- and case-insensitive, token-bounded)', () => {
    expect(rules.classify('acme widgets pricing').branded).toBe(true);
    expect(rules.classify('umlaut co login').branded).toBe(true);
    expect(rules.classify('widget hub review').branded).toBe(true); // compact alias match
    expect(rules.classify('acme widgetsology').branded).toBe(false);
    expect(rules.classify('acme widgets').intent).toBe('navigational');
  });

  it('classifies informational, commercial, transactional, and mixed intent', () => {
    expect(rules.classify('how do widgets work').intent).toBe('informational');
    expect(rules.classify('widget maintenance tips').intent).toBe('informational');
    expect(rules.classify('best widgets 2026').intent).toBe('commercial');
    expect(rules.classify('widget a vs widget b').intent).toBe('commercial');
    expect(rules.classify('buy blue widget').intent).toBe('transactional');
    expect(rules.classify('widget pricing').intent).toBe('transactional');
    expect(rules.classify('how much does a widget cost').intent).toBe('mixed');
    expect(rules.classify('are widgets safe?').intent).toBe('informational');
  });

  it('does not force a class onto bare topic queries', () => {
    const r = rules.classify('blue widgets');
    expect(r.intent).toBe('unsure');
    expect(r.ambiguous).toBe(true);
  });

  it('handles other languages and restricts lexicons to configured languages', () => {
    const all = new IntentClassifierRules({ brandAliases: [] });
    expect(all.classify('kuidas valida vidinat').intent).toBe('informational'); // et
    expect(all.classify('vidin hind').intent).toBe('transactional'); // et
    expect(all.classify('widget kaufen').intent).toBe('transactional'); // de
    const deOnly = new IntentClassifierRules({ brandAliases: [], languages: ['de-DE'] });
    expect(deOnly.classify('kuidas valida vidinat').intent).toBe('unsure');
    const noLexicon = new IntentClassifierRules({ brandAliases: [], languages: ['xx'] });
    expect(noLexicon.unmatchedLanguages).toEqual(['xx']);
    expect(noLexicon.classify('how to widget').intent).toBe('unsure');
    expect(noLexicon.classify('widget?').intent).toBe('informational');
  });

  it('non-English question words only count as the first token', () => {
    const all = new IntentClassifierRules({ brandAliases: [] });
    expect(all.classify('widget wo').intent).toBe('unsure');
    expect(all.classify('wo kaufen widget').intent).toBe('mixed');
  });
});

describe('brand-alias tokens are stripped before lexicon matching', () => {
  // SYNTHETIC aliases chosen because they contain lexicon words ("best", "buy", "guide", "example").
  const rules = new IntentClassifierRules({ brandAliases: ['Best Buy', 'Guide Hub', 'Example Widgets'], languages: ['en'] });

  it('a branded query whose remaining words are navigational (or nothing) is navigational', () => {
    for (const q of ['best buy login', 'best buy contact', 'guide hub login', 'example widgets', 'example widgets contact', 'best buy opening hours', 'best buy customer service number', 'example widgets contact us']) {
      const r = rules.classify(q);
      expect(r.intent, q).toBe('navigational');
      expect(r.branded, q).toBe(true);
    }
    expect(rules.classify('example widgets').signals).toContain('brand:example widgets');
    expect(rules.classify('best buy login').signals).toContain('brand_navigational');
    // Brand words never supply intent signals.
    expect(rules.classify('best buy login').signals.some((x) => /commercial:en:best|transactional:en:buy/.test(x))).toBe(false);
    expect(rules.classify('example widgets contact').signals.some((x) => /informational:en:example/.test(x))).toBe(false);
  });

  it('words outside the brand still classify normally', () => {
    expect(rules.classify('guide hub tutorial').intent).toBe('informational');
    expect(rules.classify('best buy tv price').intent).toBe('transactional');
    expect(rules.classify('example widgets vs acme widgets').intent).toBe('commercial');
    expect(rules.classify('how to reset guide hub password').intent).toBe('informational');
    // Unbranded queries are unaffected.
    expect(rules.classify('best laptop to buy').intent).toBe('transactional');
    expect(rules.classify('example sentences').intent).toBe('informational');
  });

  it('exposes the brand analysis for other classifiers', () => {
    expect(rules.brandAnalysis('Guide Hub login')).toMatchObject({ branded: true, matchedAlias: 'guide hub', remainingTokens: ['login'], navigationalOnly: true, brandOnly: false });
    expect(rules.brandAnalysis('example widgets')).toMatchObject({ branded: true, remainingTokens: [], brandOnly: true });
    expect(rules.brandAnalysis('bake schedule')).toMatchObject({ branded: false, remainingTokens: ['bake', 'schedule'] });
  });
});

describe('classifyQueries with the optional model hook', () => {
  it('sends only ambiguous queries to the hook and records decidedBy=model', async () => {
    const hook = vi.fn<IntentClassifierHook>(async (items) => ({ ok: true, results: new Map(items.map((i) => [i.query, { intent: 'commercial' as const, rationale: 'synthetic' }])) }));
    const out = await classifyQueries(['best widgets', 'blue widgets', 'how much does a widget cost'], { brandAliases: [], hook });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![0].map((i) => i.query)).toEqual(['blue widgets', 'how much does a widget cost']);
    const byQ = new Map(out.results.map((r) => [r.query, r]));
    expect(byQ.get('best widgets')!.decidedBy).toBe('rule');
    expect(byQ.get('blue widgets')!.decidedBy).toBe('model');
    expect(byQ.get('blue widgets')!.intent).toBe('commercial');
    expect(out.hook).toMatchObject({ called: true, sent: 2, resolved: 2, status: 'ok' });
  });

  it('keeps rule results when the hook is unavailable', async () => {
    const hook: IntentClassifierHook = async () => ({ ok: false, status: 'not_configured', reason: 'no cheap model' });
    const out = await classifyQueries(['blue widgets'], { brandAliases: [], hook });
    expect(out.results[0]!.intent).toBe('unsure');
    expect(out.results[0]!.decidedBy).toBe('rule');
    expect(out.hook.status).toBe('not_configured');
  });

  it('does not call the hook when nothing is ambiguous', async () => {
    const hook = vi.fn<IntentClassifierHook>();
    const out = await classifyQueries(['buy widget'], { brandAliases: [], hook });
    expect(hook).not.toHaveBeenCalled();
    expect(out.hook.status).toBe('not_needed');
  });
});
