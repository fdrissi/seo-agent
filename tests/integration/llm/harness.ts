/**
 * Shared harness for LLM Gateway integration tests: a SYNTHETIC fake gateway
 * (fake fetch) shaped like the verified contract in
 * docs/integration-contracts.md §1, plus a DB-backed test context.
 * No real network, no real credentials, no real model ids.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fakeFetch, jsonResponse, match, type RecordedRequest } from '../../helpers/fake-fetch.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import type { EnvKey } from '../../../src/config/env.js';
import { createLlmClient, type GatewayClientOptions, type GatewayLlmClient } from '../../../src/integrations/llm/gateway.js';
import { PromptRegistry } from '../../../src/integrations/llm/prompts.js';
import type { FetchLike } from '../../../src/integrations/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../fixtures/llm');
export const TEST_PROMPTS = path.join(FIXTURES, 'prompts');
export const BASE = 'https://api.llmgateway.io/v1';
/** Synthetic placeholder key (never a real credential). */
export const TEST_KEY = 'llmgtwy_SYNTHETIC0000test0000key';
export const TEST_BOUNDARY = 'bTESTBOUNDARY0000000000000';

export function catalogJson(): { data: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(path.join(FIXTURES, 'models.synthetic.json'), 'utf8')) as { data: Array<Record<string, unknown>> };
}

export type Handler = (body: any, req: RecordedRequest) => Response | Promise<Response>;

export interface ChatOpts {
  usage?: Record<string, unknown> | null;
  model?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  metadata?: Record<string, unknown>;
}

export function chatCompletion(content: string | null, opts: ChatOpts = {}): Response {
  const usage = opts.usage === undefined ? { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.000228 } : opts.usage;
  return jsonResponse({
    id: 'chatcmpl-synthetic',
    object: 'chat.completion',
    created: 1790000000,
    model: opts.model ?? 'synthetic-cheap-structured',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(opts.toolCalls ? { tool_calls: opts.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}),
        },
        finish_reason: opts.finishReason ?? (opts.toolCalls ? 'tool_calls' : 'stop'),
      },
    ],
    ...(usage === null ? {} : { usage }),
    metadata: { request_id: 'req-synthetic-1', requested_model: opts.model ?? 'synthetic-cheap-structured', requested_provider: null, used_model: opts.model ?? 'synthetic-cheap-structured', used_provider: 'prov-a', underlying_used_model: 'x', ...(opts.metadata ?? {}) },
  });
}

export function gatewayError(status: number, message: string, type = 'invalid_request_error', code: string | null = null, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { message, type, param: null, code } }, status, headers);
}

export interface FakeGateway {
  fetch: FetchLike & { calls: RecordedRequest[] };
  chatBodies: any[];
  embedBodies: any[];
  chat: Handler[];
  embeddings: Handler[];
  modelsRequests: RecordedRequest[];
}

export function fakeGateway(opts: { chat?: Handler[]; embeddings?: Handler[]; models?: unknown; key?: unknown } = {}): FakeGateway {
  const state = { chatBodies: [] as any[], embedBodies: [] as any[], chat: [...(opts.chat ?? [])], embeddings: [...(opts.embeddings ?? [])], modelsRequests: [] as RecordedRequest[] };
  const f = fakeFetch([
    match('GET', `${BASE}/models`, (req) => {
      state.modelsRequests.push(req);
      return jsonResponse(opts.models ?? catalogJson());
    }),
    match('GET', `${BASE}/key`, () => jsonResponse(opts.key ?? { data: { label: 'synthetic-test-key', usage: '0.10', limit: '5.00', devPlan: 'none' } })),
    match('POST', `${BASE}/chat/completions`, async (req) => {
      const body = JSON.parse(req.body ?? '{}');
      state.chatBodies.push(body);
      const h = state.chat.shift();
      if (!h) throw new Error('fake gateway: unexpected chat request');
      return h(body, req);
    }),
    match('POST', `${BASE}/embeddings`, async (req) => {
      const body = JSON.parse(req.body ?? '{}');
      state.embedBodies.push(body);
      const h = state.embeddings.shift();
      if (!h) throw new Error('fake gateway: unexpected embeddings request');
      return h(body, req);
    }),
  ]);
  return Object.assign(state, { fetch: f });
}

export const Classification = z.object({
  intent: z.enum(['informational', 'commercial', 'transactional', 'navigational']),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()),
});
export type Classification = z.infer<typeof Classification>;

export const VALID_CLASSIFICATION = JSON.stringify({ intent: 'commercial', confidence: 0.8, evidence_ids: ['ev-1'] });

export function llmTestContext(opts: {
  fetch?: FetchLike;
  models?: { cheap?: string | null; reasoning?: string | null; embedding?: string | null; embeddingDimensions?: number | null };
  llm?: Partial<SiteConfigInput['llm']>;
  budgets?: SiteConfigInput['budgets'];
  secrets?: Partial<Record<EnvKey, string>>;
  profile?: 'demo' | 'core' | 'full';
  features?: SiteConfigInput['features'];
  runId?: string;
  dryRun?: boolean;
} = {}): TestContext {
  const config = testSiteConfig({
    profile: opts.profile ?? 'full',
    models: { cheap: 'synthetic-cheap-structured', reasoning: 'synthetic-reasoner', embedding: 'synthetic-embed-small', ...(opts.models ?? {}) },
    llm: { ...(opts.llm ?? {}) },
    ...(opts.budgets ? { budgets: opts.budgets } : {}),
    ...(opts.features ? { features: opts.features } : {}),
  });
  return createTestContext({
    config,
    secrets: { LLM_GATEWAY_API_KEY: TEST_KEY, ...(opts.secrets ?? {}) },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
  });
}

export function testClient(ctx: TestContext, gw: FakeGateway, extra: GatewayClientOptions = {}): GatewayLlmClient {
  return createLlmClient(ctx, { fetch: gw.fetch, prompts: new PromptRegistry(TEST_PROMPTS), boundaryToken: () => TEST_BOUNDARY, ...extra });
}

export function classifyRequest(ctx: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    siteId: ctx.siteId,
    runId: ctx.runId,
    role: 'classifier' as const,
    tier: 'cheap' as const,
    promptId: 'test.classify',
    variables: { query: 'synthetic widget pricing', language: 'en' },
    evidence: [{ id: 'ev-1', label: 'GSC query metrics (synthetic)', text: 'Query "synthetic widget pricing": 120 impressions, 3 clicks, position 8.2 (computed by code).', trustClass: 'first_party_measurement' as const }],
    schema: Classification,
    schemaName: 'Classification',
    ...overrides,
  };
}

export function rows<T = Record<string, unknown>>(ctx: TestContext, sql: string, params: unknown[] = []): T[] {
  return ctx.db.all<T>(sql, params);
}
