/**
 * Runtime modes (policy enforced in code, see src/approvals/policy.ts):
 * - ANALYZE (default): authorized, budgeted reads; local reports only.
 * - RESEARCH: ANALYZE plus budgeted external research requests.
 * - DRAFT: RESEARCH plus local review artifacts, only after the configured approval.
 * - EXECUTE: DRAFT plus production actions, each requiring a valid human approval
 *   bound to the exact proposal.
 */
export const RUNTIME_MODES = ['ANALYZE', 'RESEARCH', 'DRAFT', 'EXECUTE'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const DEFAULT_MODE: RuntimeMode = 'ANALYZE';

export function parseMode(value: string | undefined | null): RuntimeMode {
  const v = (value ?? DEFAULT_MODE).toUpperCase();
  if ((RUNTIME_MODES as readonly string[]).includes(v)) return v as RuntimeMode;
  throw new RangeError(`Unknown mode "${value}". Use one of ${RUNTIME_MODES.join(', ')}.`);
}

export function modeAtLeast(mode: RuntimeMode, required: RuntimeMode): boolean {
  return RUNTIME_MODES.indexOf(mode) >= RUNTIME_MODES.indexOf(required);
}

/** Trust classes for sources, evidence, and memory. Untrusted content can never self-promote. */
export const TRUST_CLASSES = ['owner_approved', 'first_party_measurement', 'third_party_data', 'user_reported', 'scraped_untrusted', 'model_generated', 'synthetic'] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];

/** Claim labels required on every report statement. */
export const CLAIM_LABELS = ['OBSERVED', 'INFERRED', 'HYPOTHESIS', 'RECOMMENDATION', 'DATA_UNAVAILABLE'] as const;
export type ClaimLabel = (typeof CLAIM_LABELS)[number];
