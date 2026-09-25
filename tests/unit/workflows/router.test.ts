import { describe, expect, it, vi } from 'vitest';
import { routeAll, routeWith, type RouteRule } from '../../../src/workflows/router.js';

type Route = 'TECHNICAL_BLOCKER' | 'CTR_OPPORTUNITY' | 'CONTENT_OPPORTUNITY' | 'HEALTHY' | 'UNSURE';
interface Item {
  id: string;
  noindex?: boolean;
  ctr?: number;
  informational?: boolean;
}

const rules: RouteRule<Item, Route>[] = [
  { id: 'noindex', when: (i) => i.noindex === true, route: 'TECHNICAL_BLOCKER', reasonCode: 'NOINDEX' },
  { id: 'low-ctr', when: (i) => (i.ctr ?? 1) < 0.01, route: 'CTR_OPPORTUNITY', reasonCode: 'LOW_CTR' },
  { id: 'maybe-content', when: (i) => i.informational === true, route: 'CONTENT_OPPORTUNITY', reasonCode: 'INFORMATIONAL_HINT', decisive: false },
  { id: 'maybe-healthy', when: (i) => i.informational === true, route: 'HEALTHY', reasonCode: 'STABLE_HINT', decisive: false },
];

describe('routeWith (deterministic rules first, cheap model only for ambiguous)', () => {
  it('a decisive rule routes without calling the classifier', async () => {
    const classifier = vi.fn();
    const d = await routeWith(rules, { id: 'p1', noindex: true, ctr: 0.001 }, { unsureRoute: 'UNSURE', ambiguousClassifier: classifier });
    expect(d).toMatchObject({ route: 'TECHNICAL_BLOCKER', source: 'rule', ruleId: 'noindex', reasonCodes: ['NOINDEX'] });
    expect(classifier).not.toHaveBeenCalled();
  });

  it('ambiguous items go to the classifier with the hinted candidates', async () => {
    const classifier = vi.fn(async (_item: Item, candidates: Route[]) => ({ route: candidates[0]!, confidence: 0.9, rationale: 'synthetic' }));
    const d = await routeWith(rules, { id: 'p2', informational: true }, { unsureRoute: 'UNSURE', ambiguousClassifier: classifier });
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(classifier.mock.calls[0]![1]).toEqual(['CONTENT_OPPORTUNITY', 'HEALTHY']);
    expect(d).toMatchObject({ route: 'CONTENT_OPPORTUNITY', source: 'classifier', reasonCodes: ['INFORMATIONAL_HINT', 'STABLE_HINT', 'AMBIGUOUS_CLASSIFIED'] });
  });

  it('never guesses: no classifier, a failing classifier, or an out-of-set answer yields the UNSURE route', async () => {
    expect((await routeWith(rules, { id: 'p3' }, { unsureRoute: 'UNSURE' })).route).toBe('UNSURE');
    const failing = await routeWith(rules, { id: 'p3' }, {
      unsureRoute: 'UNSURE',
      ambiguousClassifier: async () => {
        throw new Error('model unavailable');
      },
    });
    expect(failing).toMatchObject({ route: 'UNSURE', source: 'unsure', classifier: { called: true, error: { message: 'model unavailable' } } });
    const rogue = await routeWith(rules, { id: 'p3' }, { unsureRoute: 'UNSURE', ambiguousClassifier: async () => ({ route: 'PUBLISH_NOW' as Route }) });
    expect(rogue.route).toBe('UNSURE');
    expect(rogue.reasonCodes).toContain('CLASSIFIER_REJECTED');
    const contradicts = await routeWith(rules, { id: 'p4', informational: true }, { unsureRoute: 'UNSURE', ambiguousClassifier: async () => ({ route: 'TECHNICAL_BLOCKER' as Route }) });
    expect(contradicts.route).toBe('UNSURE');
    const lowConfidence = await routeWith(rules, { id: 'p5', informational: true }, { unsureRoute: 'UNSURE', minConfidence: 0.7, ambiguousClassifier: async () => ({ route: 'HEALTHY' as Route, confidence: 0.4 }) });
    expect(lowConfidence.route).toBe('UNSURE');
  });

  it('a rule that throws never routes', async () => {
    const crashing: RouteRule<Item, Route>[] = [{ id: 'crash', when: () => { throw new Error('bad rule'); }, route: 'HEALTHY', reasonCode: 'X' }];
    expect((await routeWith(crashing, { id: 'p' }, { unsureRoute: 'UNSURE' })).route).toBe('UNSURE');
  });

  it('routeAll only sends ambiguous items to the classifier (bounded concurrency)', async () => {
    let active = 0;
    let max = 0;
    const classifier = vi.fn(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
      return { route: 'HEALTHY' as Route };
    });
    const items: Item[] = [{ id: 'a', noindex: true }, ...Array.from({ length: 8 }, (_, i) => ({ id: `amb${i}`, informational: true })), { id: 'b', ctr: 0.001 }];
    const out = await routeAll(rules, items, { unsureRoute: 'UNSURE', ambiguousClassifier: classifier, workers: 2 });
    expect(classifier).toHaveBeenCalledTimes(8);
    expect(max).toBeLessThanOrEqual(2);
    expect(out[0]!.route).toBe('TECHNICAL_BLOCKER');
    expect(out[9]!.route).toBe('CTR_OPPORTUNITY');
  });
});
