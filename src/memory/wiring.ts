import type { AppContext } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import type { LlmClient } from '../integrations/llm/types.js';

/**
 * LLM client wiring for memory entry points that are not handed a client
 * (the CLI). The memory slice depends only on the LlmClient contract; the
 * concrete LLM Gateway client is wired at integration time by either:
 *   1. registerMemoryLlmFactory(factory) during application start-up, or
 *   2. a module under src/integrations/llm exporting one of the conventional
 *      factory names below (probed with a dynamic import).
 * When neither exists, memory runs honestly without embeddings (full-text
 * only, reported as degraded) instead of pretending semantic search works.
 */

export type LlmFactory = (ctx: AppContext) => LlmClient | null | Promise<LlmClient | null>;

let registered: LlmFactory | null = null;

export function registerMemoryLlmFactory(factory: LlmFactory | null): void {
  registered = factory;
}

const CANDIDATE_MODULES = ['../integrations/llm/client.js', '../integrations/llm/index.js', '../integrations/llm/gateway.js'];
const CANDIDATE_EXPORTS = ['createLlmClient', 'createGatewayLlmClient', 'createLlmGatewayClient'];

export async function resolveMemoryLlm(ctx: AppContext): Promise<{ llm: LlmClient | null; source: string; note?: string }> {
  if (registered) {
    try {
      return { llm: await registered(ctx), source: 'registered-factory' };
    } catch (err) {
      return { llm: null, source: 'registered-factory', note: `LLM factory failed: ${errorMessage(err)}` };
    }
  }
  for (const spec of CANDIDATE_MODULES) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(spec)) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const name of CANDIDATE_EXPORTS) {
      const f = mod[name];
      if (typeof f !== 'function') continue;
      try {
        const llm = (await (f as (c: AppContext) => unknown)(ctx)) as LlmClient | null;
        if (llm && typeof llm.embed === 'function' && typeof llm.isConfigured === 'function') return { llm, source: `${spec}#${name}` };
      } catch (err) {
        return { llm: null, source: `${spec}#${name}`, note: `LLM client factory failed: ${errorMessage(err)}` };
      }
    }
  }
  return { llm: null, source: 'none', note: 'No LLM client factory is wired in this build; semantic memory is unavailable (full-text search only).' };
}
