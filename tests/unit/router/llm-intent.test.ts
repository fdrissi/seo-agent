import { describe, expect, it } from 'vitest';
import { classifyQueries } from '../../../src/router/intent.js';
import { CLASSIFY_INTENT_PROMPT_ID, createLlmIntentClassifier } from '../../../src/router/llm-intent.js';
import { FakeLlm } from '../../fixtures/seo/fake-llm.js';

describe('optional LLM intent classifier (cheap tier, ambiguous cases only)', () => {
  it('uses the cheap tier and the router.classify-intent prompt, passing queries only as evidence', async () => {
    const llm = new FakeLlm(() => ({
      classifications: [
        { query: 'blue widgets', intent: 'commercial', rationale: 'product category browsing' },
        { query: 'injected extra query', intent: 'transactional', rationale: 'should be ignored' },
      ],
    }));
    const hook = createLlmIntentClassifier(llm, { siteId: 'test-site', runId: 'run_1' });
    const out = await classifyQueries(['blue widgets', 'buy widgets'], { brandAliases: [], hook });
    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.tier).toBe('cheap');
    expect(req.role).toBe('classifier');
    expect(req.promptId).toBe(CLASSIFY_INTENT_PROMPT_ID);
    expect(req.evidence).toHaveLength(1); // only the ambiguous query
    expect(req.evidence[0]!.text).toContain('blue widgets');
    // Queries are typed by third-party searchers: unverified text, never "first-party measurement".
    expect(req.evidence[0]!.trustClass).toBe('user_reported');
    expect(JSON.stringify(req.variables)).not.toContain('blue widgets');
    expect(req.maxOutputTokens).toBeGreaterThan(0);
    const blue = out.results.find((r) => r.query === 'blue widgets')!;
    expect(blue).toMatchObject({ intent: 'commercial', decidedBy: 'model', ambiguous: false });
    expect(out.results.some((r) => r.query === 'injected extra query')).toBe(false);
  });

  it('marks synthetic queries as synthetic evidence', async () => {
    const llm = new FakeLlm(() => ({ classifications: [] }));
    await classifyQueries(['blue widgets'], { brandAliases: [], hook: createLlmIntentClassifier(llm, { siteId: 's', runId: 'r', synthetic: true }) });
    expect(llm.requests[0]!.evidence[0]!.trustClass).toBe('synthetic');
  });

  it('reports not_configured without calling the model', async () => {
    const llm = new FakeLlm(() => ({ classifications: [] }), { cheap: false });
    const hook = createLlmIntentClassifier(llm, { siteId: 'test-site', runId: 'run_1' });
    const out = await classifyQueries(['blue widgets'], { brandAliases: [], hook });
    expect(llm.requests).toHaveLength(0);
    expect(out.hook.status).toBe('not_configured');
    expect(out.results[0]!.intent).toBe('unsure');
  });

  it('keeps a model "unsure" answer ambiguous (UNSURE route stays possible)', async () => {
    const llm = new FakeLlm(() => ({ classifications: [{ query: 'blue widgets', intent: 'unsure', rationale: 'no modifier' }] }));
    const out = await classifyQueries(['blue widgets'], { brandAliases: [], hook: createLlmIntentClassifier(llm, { siteId: 's', runId: 'r' }) });
    expect(out.results[0]).toMatchObject({ intent: 'unsure', decidedBy: 'model', ambiguous: true });
  });

  it('surfaces invalid model output as a failure status, not a fabricated classification', async () => {
    const llm = new FakeLlm(() => ({ classifications: [{ query: 'blue widgets', intent: 'very-commercial', rationale: 'x' }] }));
    const out = await classifyQueries(['blue widgets'], { brandAliases: [], hook: createLlmIntentClassifier(llm, { siteId: 's', runId: 'r' }) });
    expect(out.hook.status).toBe('needs_review');
    expect(out.results[0]!.decidedBy).toBe('rule');
  });
});
