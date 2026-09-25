/**
 * SYNTHETIC unit tests: a failed writer call maps to an honest error code.
 * Only real provider failures are PROVIDER_ERROR (they count toward the
 * provider's circuit breaker); a validation failure after the controlled
 * repairs goes to human review.
 */
import { describe, expect, it } from 'vitest';
import { DraftNeedsReviewError, writerFailure } from '../../../src/content/draft.js';
import { countsAsProviderFailure } from '../../../src/workflows/errors.js';

describe('writer failure mapping (A3-09)', () => {
  it('maps each gateway status to its own code', () => {
    const cases: Array<[Parameters<typeof writerFailure>[0]['status'], string]> = [
      ['budget_exceeded', 'BUDGET_EXCEEDED'],
      ['budget_unknown_price', 'BUDGET_UNKNOWN_PRICE'],
      ['invalid_model', 'CONFIG_INVALID'],
      ['unsupported', 'CONFIG_INVALID'],
      ['not_configured', 'CREDENTIALS_MISSING'],
      ['disabled', 'INTEGRATION_DISABLED'],
      ['provider_error', 'PROVIDER_ERROR'],
    ];
    for (const [status, code] of cases) {
      const err = writerFailure({ ok: false, status, reason: 'synthetic' });
      expect(err.code, status).toBe(code);
      expect(countsAsProviderFailure(err), status).toBe(status === 'provider_error');
    }
    expect(writerFailure({ ok: false, status: 'provider_error', reason: 'timeout after submit', ambiguous: true }).code).toBe('AMBIGUOUS_SUBMISSION');
  });

  it('needs_review becomes a review hand-off with the call id and a bounded, redacted raw output', () => {
    const raw = `{"body":"x"} sk-live-SYNTHETICSECRET0123456789abcdef ${'y'.repeat(30_000)}`;
    const err = writerFailure({ ok: false, status: 'needs_review', reason: 'schema failed after 2 repairs', callId: 'call_9', lastRawOutput: raw });
    expect(err).toBeInstanceOf(DraftNeedsReviewError);
    expect(err.code).not.toBe('PROVIDER_ERROR');
    const review = (err as DraftNeedsReviewError).review;
    expect(review).toMatchObject({ status: 'needs_review', callId: 'call_9', rawOutputTruncated: true });
    expect(review.lastRawOutput!.length).toBeLessThanOrEqual(20_000);
    expect(review.lastRawOutput).not.toContain('SYNTHETICSECRET');
    expect(countsAsProviderFailure(err)).toBe(false);
  });
});
