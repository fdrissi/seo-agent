import { z } from 'zod';
import type { OpenAiToolSpec } from '../../security/tools.js';
import type { ModelCapabilities } from './models.js';
import type { ModelTier } from './types.js';

/**
 * Capability-driven request parameters. Models do not all accept the same
 * temperature, reasoning, JSON, or tool settings (docs/integration-contracts.md
 * §1): a parameter is sent only when the model's catalog entry says it is
 * supported, and every omission is recorded with its reason.
 */

export type ResponseFormatMode = 'json_schema' | 'json_object' | 'prompt' | 'text';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface JsonSchemaInfo {
  /** JSON Schema (draft 2020-12 minus `$schema`) derived from the zod schema. */
  schema: Record<string, unknown>;
  /** True when the schema satisfies strict structured-output rules (all properties required, no extra properties). */
  strictCompatible: boolean;
}

/** Response-format schema name: letters, digits, underscores, hyphens (max 64). */
export function sanitizeSchemaName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || 'output';
}

/** Convert a zod schema to JSON Schema for response_format / prompt instructions. Null when not representable. */
export function zodToJsonSchema(schema: z.ZodType): JsonSchemaInfo | null {
  for (const io of ['output', 'input'] as const) {
    try {
      const js = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
      delete js.$schema;
      return { schema: js, strictCompatible: isStrictCompatible(js) };
    } catch {
      /* try the next representation */
    }
  }
  return null;
}

/**
 * Strict structured outputs require every object to list all properties as
 * required and forbid additional properties. Anything else is sent with
 * strict=false (still natively enforced where supported, and always
 * validated client-side).
 */
export function isStrictCompatible(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(isStrictCompatible);
  if (!node || typeof node !== 'object') return true;
  const n = node as Record<string, unknown>;
  const type = n.type;
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object')) || (n.properties && typeof n.properties === 'object');
  if (isObject) {
    const props = (n.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(n.required) ? (n.required as string[]) : [];
    if (n.additionalProperties !== false) return false;
    if (Object.keys(props).some((k) => !required.includes(k))) return false;
  }
  for (const [k, v] of Object.entries(n)) {
    if (k === 'properties' && v && typeof v === 'object') {
      if (!Object.values(v as Record<string, unknown>).every(isStrictCompatible)) return false;
    } else if (typeof v === 'object' && v !== null && !isStrictCompatible(v)) return false;
  }
  return true;
}

export function supportsParam(caps: ModelCapabilities, param: string): boolean | null {
  if (!caps.supportedParameters) return null;
  return caps.supportedParameters.includes(param);
}

/** Choose the strongest structured-output mechanism the model verifiably supports. */
export function decideResponseFormat(caps: ModelCapabilities, wantJson: boolean, schema: JsonSchemaInfo | null): ResponseFormatMode {
  if (!wantJson) return 'text';
  if (caps.structuredOutputs === true && schema) return 'json_schema';
  if (caps.jsonOutput === true) return 'json_object';
  return 'prompt';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  /** Passed back unchanged for reasoning models in multi-turn tool use (verified contract). */
  reasoning_details?: unknown;
}

export interface ChatBodyInput {
  model: string;
  caps: ModelCapabilities;
  tier: ModelTier;
  messages: ChatMessage[];
  maxOutputTokens: number;
  format: ResponseFormatMode;
  schemaName?: string;
  schema?: JsonSchemaInfo | null;
  tools?: OpenAiToolSpec[];
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /**
   * Hidden-reasoning token ceiling sent as `reasoning.max_tokens` (verified
   * request field; documented to override effort on Anthropic and Google
   * thinking models). Sent only when every provider mapping supports
   * reasoning; the caller decides which providers it applies to.
   */
  reasoningMaxTokens?: number;
  responseHealing?: boolean;
  user?: string;
}

export interface BuiltChatBody {
  body: Record<string, unknown>;
  maxTokens: number;
  format: ResponseFormatMode;
  toolsSent: string[];
  /** Parameters deliberately not sent, with reasons (recorded in llm_calls.params_json). */
  omitted: Array<{ param: string; reason: string }>;
  /** Parameters actually sent (excluding messages). */
  sent: Record<string, unknown>;
}

/** Effective max_tokens: the request ceiling clamped to the model/provider max_output. */
export function clampMaxTokens(requested: number, caps: ModelCapabilities): number {
  const ceiling = caps.maxOutput ?? Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(Math.floor(requested), ceiling));
}

export function buildChatBody(input: ChatBodyInput): BuiltChatBody {
  const { caps } = input;
  const omitted: BuiltChatBody['omitted'] = [];
  const maxTokens = clampMaxTokens(input.maxOutputTokens, caps);
  if (maxTokens < input.maxOutputTokens) omitted.push({ param: 'max_tokens', reason: `clamped from ${input.maxOutputTokens} to model max_output ${maxTokens}` });
  // max_tokens is the documented ceiling field; it is always sent (every request needs a token ceiling).
  const sent: Record<string, unknown> = { model: input.model, max_tokens: maxTokens };

  if (input.temperature !== undefined) {
    const s = supportsParam(caps, 'temperature');
    if (s === true) sent.temperature = input.temperature;
    else omitted.push({ param: 'temperature', reason: s === false ? 'model does not list temperature in supported_parameters' : 'supported_parameters unknown; not sent' });
  }

  let effort: ReasoningEffort | undefined;
  if (input.reasoningEffort !== undefined) {
    if (caps.reasoning !== true) omitted.push({ param: 'reasoning_effort', reason: 'model (or one of its provider mappings) does not support reasoning' });
    else if (!caps.reasoningEfforts?.includes(input.reasoningEffort)) omitted.push({ param: 'reasoning_effort', reason: `effort "${input.reasoningEffort}" not in accepted values (${caps.reasoningEfforts?.join(', ') ?? 'unknown'})` });
    else effort = input.reasoningEffort;
  }
  let reasoningMax: number | undefined;
  if (input.reasoningMaxTokens !== undefined) {
    if (caps.reasoning !== true) omitted.push({ param: 'reasoning.max_tokens', reason: 'model (or one of its provider mappings) does not support reasoning' });
    else if (!Number.isSafeInteger(input.reasoningMaxTokens) || input.reasoningMaxTokens < 1) omitted.push({ param: 'reasoning.max_tokens', reason: 'not a positive integer' });
    else reasoningMax = input.reasoningMaxTokens;
  }
  // `reasoning_effort` and the `reasoning` object must never both be sent (verified contract).
  if (reasoningMax !== undefined) sent.reasoning = { ...(effort ? { effort } : {}), max_tokens: reasoningMax };
  else if (effort) sent.reasoning_effort = effort;

  let format = input.format;
  if (format === 'json_schema') {
    if (caps.structuredOutputs !== true || !input.schema) {
      format = caps.jsonOutput === true ? 'json_object' : 'prompt';
      omitted.push({ param: 'response_format.json_schema', reason: 'model does not support native structured outputs' });
    } else {
      sent.response_format = {
        type: 'json_schema',
        json_schema: { name: sanitizeSchemaName(input.schemaName ?? 'output'), schema: input.schema.schema, strict: input.schema.strictCompatible },
      };
    }
  }
  if (format === 'json_object') {
    if (caps.jsonOutput !== true) {
      format = 'prompt';
      omitted.push({ param: 'response_format.json_object', reason: 'model does not support JSON mode' });
    } else sent.response_format = { type: 'json_object' };
  }
  if (input.responseHealing && (format === 'json_schema' || format === 'json_object')) sent.plugins = [{ id: 'response-healing' }];

  const toolsSent: string[] = [];
  if (input.tools?.length) {
    if (caps.tools === true) {
      sent.tools = input.tools;
      toolsSent.push(...input.tools.map((t) => t.function.name));
    } else omitted.push({ param: 'tools', reason: caps.tools === false ? 'a provider mapping of this model does not support tools' : 'tool support unknown; not sent' });
  }
  if (input.user) sent.user = input.user;

  return { body: { ...sent, messages: input.messages }, maxTokens, format, toolsSent, omitted, sent };
}
