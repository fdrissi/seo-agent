import type { z } from 'zod';
import type { Micros } from '../../core/money.js';
import type { TrustClass } from '../../core/modes.js';

/**
 * LLM contract used by analysis, research synthesis, content, and review.
 * Implemented by the LLM Gateway adapter (OpenAI-compatible) and by a
 * deterministic fixture client for demo/tests.
 *
 * Numerical calculations stay in code; the model receives computed numbers as
 * evidence and never recomputes them.
 */

export type ModelTier = 'cheap' | 'reasoning';
export type LogicalRole = 'extractor' | 'classifier' | 'analyst' | 'synthesizer' | 'writer' | 'reviewer';

/** One item in an evidence bundle. Untrusted text is wrapped as data, never instructions. */
export interface EvidenceItem {
  id: string;
  label: string;
  text: string;
  trustClass: TrustClass;
  sourceId?: string;
  url?: string;
  retrievedAt?: string;
}

export interface TruncationInfo {
  evidenceId: string;
  originalTokens: number;
  keptTokens: number;
  note: string;
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface StructuredRequest<T> {
  siteId: string;
  runId: string;
  traceId?: string;
  role: LogicalRole;
  tier: ModelTier;
  /** Prompt template id under prompts/, e.g. 'router.classify-intent'. Version resolved from the template file. */
  promptId: string;
  /** Template variables (already-computed, non-secret values). */
  variables: Record<string, unknown>;
  evidence: EvidenceItem[];
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * Names of allowlisted, typed, read-only tools (src/security/tools.ts) the
   * model may call for this request. Unknown names are a programming error.
   * Tool calls for any other name are rejected and logged.
   */
  tools?: string[];
  /**
   * Approval id authorizing ONE request whose price cannot be verified
   * (BUDGET_UNKNOWN_PRICE). It is checked through the injected approval gate
   * (GatewayClientOptions.approvals): it must be an approved `paid_request`
   * approval bound to this site, endpoint, the exact request (boundary-
   * normalized body hash), and `unknownPriceMaxChargeMicros`. It is consumed
   * once. Without a verified approval such requests are skipped. Follow-up
   * requests (repairs, tool rounds) are disabled for unknown-price calls
   * because each would need its own approval.
   */
  unknownPriceApprovalId?: string;
  /**
   * Maximum charge (USD micros) the caller proposes for an unknown-price
   * request. Required to request or use an unknown-price approval; it is the
   * amount reserved against the budgets. Without it an unknown-price request
   * is skipped.
   */
  unknownPriceMaxChargeMicros?: Micros;
}

export type LlmFailureStatus = 'disabled' | 'not_configured' | 'budget_exceeded' | 'budget_unknown_price' | 'needs_review' | 'provider_error' | 'invalid_model' | 'unsupported';

/** Optional details carried by failure results (additive; callers may ignore them). */
export interface LlmFailureDetails {
  /** Exact next step for the owner, when action is needed. */
  nextStep?: string;
  /**
   * True when the request may have been accepted and billed by the gateway
   * (timeout/network error after submission). The budget reservation stays
   * 'unresolved' and the request is never retried automatically.
   */
  ambiguous?: boolean;
  reservationId?: string;
  truncation?: TruncationInfo[];
  /** Pending/used approval for an unknown-price request (approve it through the approvals workflow). */
  approvalId?: string;
  /** Boundary-normalized hash of the exact request an unknown-price approval must be bound to. */
  approvalRequestHash?: string;
}

export type StructuredResult<T> =
  | {
      ok: true;
      value: T;
      callId: string;
      model: string;
      promptVersion: string;
      usage: LlmUsage;
      costMicros: Micros | null;
      repairAttempts: number;
      truncation: TruncationInfo[];
    }
  | ({ ok: false; status: LlmFailureStatus; reason: string; callId?: string; lastRawOutput?: string } & LlmFailureDetails);

export interface TextRequest extends Omit<StructuredRequest<string>, 'schema' | 'schemaName'> {}

export type TextResult =
  | {
      ok: true;
      text: string;
      callId: string;
      model: string;
      promptVersion: string;
      usage: LlmUsage;
      costMicros: Micros | null;
      truncation: TruncationInfo[];
      /**
       * True when the model stopped because it reached the output token limit
       * (finish_reason "length"): `text` is cut off and incomplete. Callers
       * must say so and never present the text as a complete answer. The
       * cut is also recorded as a `truncation` entry (evidenceId
       * OUTPUT_TRUNCATION_ID).
       */
      outputTruncated?: boolean;
    }
  | ({ ok: false; status: LlmFailureStatus; reason: string; callId?: string } & LlmFailureDetails);

/** `TruncationInfo.evidenceId` used for a model output cut off at the output token limit. */
export const OUTPUT_TRUNCATION_ID = 'model_output';

export interface EmbedRequest {
  siteId: string;
  runId: string;
  texts: string[];
  signal?: AbortSignal;
  /**
   * See StructuredRequest.unknownPriceApprovalId. Covers exactly one
   * embeddings request: unknown-price input that needs more than one batch is
   * refused before anything is sent.
   */
  unknownPriceApprovalId?: string;
  /** See StructuredRequest.unknownPriceMaxChargeMicros. */
  unknownPriceMaxChargeMicros?: Micros;
}

/**
 * Billing state carried by an embeddings failure (additive; older callers may
 * ignore it). A failure that happens after the gateway processed a request
 * (for example a dimension check on a 2xx response, or a later batch failing
 * after earlier batches were billed) still cost money:
 * - `billed: true` with `costMicros` a number: the known charge of the
 *   requests made by this embed() call, including the failed one.
 * - `chargeUnknown: true` (then `costMicros` is null): at least one request
 *   was or may have been billed but its charge cannot be determined; any
 *   `reservationId` stays unresolved until reconciled. Never report it as $0.
 * - Neither flag: nothing was billed by this call (for example a refusal
 *   before sending, or a gateway rejection before inference).
 */
export interface EmbedFailureBilling {
  billed?: boolean;
  chargeUnknown?: boolean;
  costMicros?: Micros | null;
}

export type EmbedResult =
  | { ok: true; vectors: Float32Array[]; model: string; dimensions: number; usage: LlmUsage; costMicros: Micros | null }
  | ({ ok: false; status: LlmFailureStatus; reason: string } & LlmFailureDetails & EmbedFailureBilling);

/**
 * Why a client can make no model call at all in this process, with the owner's
 * next step (e.g. `--offline`, features.llm off, no key). Set only by
 * placeholder clients that refuse every call; a working client omits it.
 */
export interface LlmUnavailable {
  status: LlmFailureStatus;
  reason: string;
  nextStep: string;
}

export interface LlmClient {
  /** True when a model id and credentials exist for the tier (no network call). */
  isConfigured(tier: ModelTier | 'embedding'): boolean;
  /** Whether outputs are synthetic fixtures (demo/tests). */
  readonly synthetic: boolean;
  /**
   * Optional: present when this client refuses every call (see LlmUnavailable),
   * so callers report the real cause (e.g. network disabled) instead of
   * guessing at missing configuration from `isConfigured()`.
   */
  readonly unavailable?: LlmUnavailable | null;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  text(req: TextRequest): Promise<TextResult>;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}
