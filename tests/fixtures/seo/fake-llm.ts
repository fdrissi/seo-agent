/**
 * SYNTHETIC in-memory LlmClient for seo/router tests. Records every request;
 * returns canned values validated against the request schema. Never touches
 * the network.
 */
import type { EmbedResult, LlmClient, ModelTier, StructuredRequest, StructuredResult, TextResult } from '../../../src/integrations/llm/types.js';

export class FakeLlm implements LlmClient {
  readonly synthetic = true;
  readonly requests: Array<StructuredRequest<unknown>> = [];
  constructor(
    private readonly respond: (req: StructuredRequest<unknown>) => unknown,
    private readonly configured: Partial<Record<ModelTier | 'embedding', boolean>> = { cheap: true, reasoning: true },
  ) {}

  isConfigured(tier: ModelTier | 'embedding'): boolean {
    return !!this.configured[tier];
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    const raw = this.respond(req as StructuredRequest<unknown>);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) return { ok: false, status: 'needs_review', reason: 'fixture output failed schema validation' };
    return { ok: true, value: parsed.data, callId: 'call_fixture', model: 'fixture-model', promptVersion: `${req.promptId}@fixture`, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null }, costMicros: null, repairAttempts: 0, truncation: [] };
  }

  async text(): Promise<TextResult> {
    return { ok: false, status: 'unsupported', reason: 'fixture' };
  }

  async embed(): Promise<EmbedResult> {
    return { ok: false, status: 'unsupported', reason: 'fixture' };
  }
}
