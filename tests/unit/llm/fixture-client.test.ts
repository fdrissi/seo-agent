import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FIXTURE_EMBEDDING_MODEL, createFixtureLlmClient, hashEmbedding } from '../../../src/integrations/llm/fixture-client.js';
import { PromptRegistry } from '../../../src/integrations/llm/prompts.js';
import { listLlmCalls } from '../../../src/integrations/llm/records.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const prompts = new PromptRegistry(path.resolve(here, '../../fixtures/llm/prompts'));
const Classification = z.object({ intent: z.enum(['informational', 'commercial']), confidence: z.number(), evidence_ids: z.array(z.string()) });

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const base = (siteId = 'test-site') => ({
  siteId,
  runId: 'run_fixture',
  role: 'classifier' as const,
  tier: 'cheap' as const,
  promptId: 'test.classify',
  variables: { query: 'synthetic widget', language: 'en' },
  evidence: [{ id: 'ev-1', label: 'x', text: 'synthetic evidence', trustClass: 'synthetic' as const }],
  schema: Classification,
  schemaName: 'Classification',
});

describe('fixture LLM client (SYNTHETIC, zero network)', () => {
  it('returns schema-valid outputs from handlers keyed by prompt id, deterministically', async () => {
    const client = createFixtureLlmClient({ 'test.classify': (req) => ({ intent: 'commercial', confidence: 0.5, evidence_ids: req.evidence.map((e) => e.id) }) }, { prompts });
    expect(client.synthetic).toBe(true);
    const a = await client.structured(base());
    const b = await client.structured(base());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).toEqual(b.value);
    expect(a.value.evidence_ids).toEqual(['ev-1']);
    expect(a.model).toBe('synthetic-fixture-model');
    expect(a.promptVersion).toMatch(/^test\.classify@3\+/);
    expect(a.costMicros).toBe(0);
    expect(a.usage.inputTokens).toBeNull();
  });

  it('returns needs_review for prompts without a handler and for schema-invalid fixture output (never invents)', async () => {
    const client = createFixtureLlmClient({ 'test.classify': () => ({ intent: 'nope' }) });
    const invalid = await client.structured(base());
    expect(invalid.ok === false && invalid.status).toBe('needs_review');
    const missing = await client.structured({ ...base(), promptId: 'unregistered.prompt' });
    expect(missing.ok === false && missing.status).toBe('needs_review');
    expect(missing.ok === false && missing.reason).toContain('SYNTHETIC');
    const text = await client.text({ ...base(), promptId: 'unregistered.prompt' });
    expect(text.ok === false && text.status).toBe('needs_review');
  });

  it('checks template variables when templates are available', async () => {
    const client = createFixtureLlmClient({ 'test.classify': () => ({}) }, { prompts });
    await expect(client.structured({ ...base(), variables: { query: 'x' } })).rejects.toThrow(/missing variable/);
  });

  it('produces deterministic, normalized, fixed-dimension pseudo-embeddings labelled synthetic', async () => {
    const client = createFixtureLlmClient({}, { embeddingDimensions: 16 });
    const r = await client.embed({ siteId: 'test-site', runId: 'r', texts: ['alpha', 'alpha', 'beta'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe(FIXTURE_EMBEDDING_MODEL);
    expect(r.dimensions).toBe(16);
    expect(Array.from(r.vectors[0]!)).toEqual(Array.from(r.vectors[1]!));
    expect(Array.from(r.vectors[0]!)).not.toEqual(Array.from(r.vectors[2]!));
    const norm = Math.sqrt(Array.from(r.vectors[2]!).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(hashEmbedding('alpha', 100)).toHaveLength(100);
  });

  it('records llm_calls rows flagged is_synthetic when given a context, and makes no network requests', async () => {
    ctx = createTestContext();
    const client = createFixtureLlmClient({ 'test.classify': () => ({ intent: 'informational', confidence: 1, evidence_ids: [] }) }, { ctx, prompts });
    const r = await client.structured(base(ctx.siteId));
    expect(r.ok).toBe(true);
    await client.embed({ siteId: ctx.siteId, runId: 'r', texts: ['a'] });
    const calls = listLlmCalls(ctx.db, ctx.siteId);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.is_synthetic === 1)).toBe(true);
    expect(calls.find((c) => c.tier === 'cheap')!.validation_status).toBe('valid');
    expect(ctx.db.all('SELECT * FROM provider_requests')).toHaveLength(0);
    expect(ctx.db.all('SELECT * FROM budget_reservations')).toHaveLength(0);
    await expect(client.structured(base('other-site'))).rejects.toThrow(/site/);
  });
});
