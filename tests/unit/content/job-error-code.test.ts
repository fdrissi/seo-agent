/**
 * NF-11: a content job that fails keeps its stage's error code. The CLI's list
 * of codes is built from src/core/errors.ts (ERROR_CODE_VALUES), so a code
 * such as OFFLINE (network disabled for the run) is never reported as INTERNAL.
 */
import { describe, expect, it } from 'vitest';
import { contentJobErrorCode } from '../../../src/cli/commands/content.js';
import { AppError, ERROR_CODE_VALUES, isErrorCode, type ErrorCode } from '../../../src/core/errors.js';

describe('content job failure codes', () => {
  it('passes OFFLINE through (not INTERNAL)', () => {
    expect(contentJobErrorCode('OFFLINE')).toBe('OFFLINE');
    expect(new AppError(contentJobErrorCode('OFFLINE'), 'offline run').code).toBe('OFFLINE');
  });

  it('passes every ErrorCode through unchanged', () => {
    for (const code of ERROR_CODE_VALUES) expect(contentJobErrorCode(code)).toBe(code);
    expect(new Set(ERROR_CODE_VALUES).size).toBe(ERROR_CODE_VALUES.length);
  });

  it('maps workflow-engine policy stops to POLICY_DENIED and anything else to INTERNAL', () => {
    for (const raw of ['EVIDENCE_INSUFFICIENT', 'BLOCKED', 'MODE_NOT_PERMITTED', 'INVALID_TRANSITION']) expect(contentJobErrorCode(raw)).toBe('POLICY_DENIED');
    expect(contentJobErrorCode('SOMETHING_NEW')).toBe('INTERNAL');
    expect(contentJobErrorCode('offline')).toBe('INTERNAL'); // codes are exact
  });

  it('ErrorCode is derived from the runtime tuple (isErrorCode agrees with it)', () => {
    const offline: ErrorCode = 'OFFLINE';
    expect(ERROR_CODE_VALUES).toContain(offline);
    expect(isErrorCode('OFFLINE')).toBe(true);
    expect(isErrorCode('INTERNAL')).toBe(true);
    expect(isErrorCode('NOT_A_CODE')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});
