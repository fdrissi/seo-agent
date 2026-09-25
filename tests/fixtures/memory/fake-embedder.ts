/**
 * SYNTHETIC TEST DOUBLE. Deterministic LlmClient whose embed() hashes words
 * into a fixed-size vector (a bag-of-words sketch). A tiny synonym table maps
 * a few words onto the same bucket so tests can show semantic matches that
 * full-text search misses. It never touches the network and reports unknown
 * cost as null (tests can set a synthetic reported cost).
 */
import { createHash } from 'node:crypto';
import type { EmbedFailureBilling, EmbedRequest, EmbedResult, LlmClient, LlmFailureDetails, LlmFailureStatus, ModelTier, StructuredResult, TextResult } from '../../../src/integrations/llm/types.js';

const SYNONYMS: Record<string, string> = {
  cost: 'price',
  costs: 'price',
  pricing: 'price',
  prices: 'price',
  fee: 'price',
  fees: 'price',
  expensive: 'price',
  cheap: 'price',
};

export function fakeVector(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  const words = text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const raw of words) {
    const w = SYNONYMS[raw] ?? raw;
    const h = createHash('sha256').update(w).digest();
    const idx = h.readUInt32BE(0) % dims;
    v[idx]! += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] = v[i]! / norm;
  return v;
}

export class FakeEmbedder implements LlmClient {
  readonly synthetic = true;
  readonly calls: string[][] = [];
  configured = true;
  /** Dimensions actually returned (set differently from config to test mismatch refusal). */
  returnDims: number;
  failWith: ({ status: LlmFailureStatus; reason: string } & LlmFailureDetails & EmbedFailureBilling) | null = null;
  /** When set, the response claims `returnDims` but one vector has a different length. */
  ragged = false;
  /** When set, the first vector contains NaN (an invalid response). */
  nonFinite = false;
  /** Model id reported in responses (a gateway could fall back to another model). */
  returnModel = 'fake-embed-model';
  /** Cost reported per successful call (synthetic; null = unknown). */
  returnCostMicros: number | null = null;

  constructor(dims: number) {
    this.returnDims = dims;
  }

  get textsEmbedded(): string[] {
    return this.calls.flat();
  }

  isConfigured(tier: ModelTier | 'embedding'): boolean {
    return tier === 'embedding' && this.configured;
  }

  async structured<T>(): Promise<StructuredResult<T>> {
    return { ok: false, status: 'unsupported', reason: 'fake embedder only' };
  }

  async text(): Promise<TextResult> {
    return { ok: false, status: 'unsupported', reason: 'fake embedder only' };
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    this.calls.push([...req.texts]);
    if (this.failWith) return { ok: false, ...this.failWith };
    const vectors = req.texts.map((t) => fakeVector(t, this.returnDims));
    if (this.ragged && vectors.length) vectors[0] = fakeVector(req.texts[0]!, this.returnDims + 1);
    if (this.nonFinite && vectors.length) vectors[0]![0] = Number.NaN;
    return {
      ok: true,
      vectors,
      model: this.returnModel,
      dimensions: this.returnDims,
      usage: { inputTokens: req.texts.join(' ').length, outputTokens: null, reasoningTokens: null },
      costMicros: this.returnCostMicros,
    };
  }
}
