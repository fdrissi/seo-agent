import { AppError, isAppError, type ErrorCode } from '../core/errors.js';
import { redact, redactString } from '../security/redact.js';

/** JSON-safe, redacted error record stored in checkpoints, job runs, and job rows. */
export interface ErrorInfo {
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

const MAX_MESSAGE = 2_000;

/** Serialize any thrown value into a redacted ErrorInfo (never includes stacks or secrets). */
export function toErrorInfo(err: unknown, fallbackCode = 'INTERNAL'): ErrorInfo {
  if (isAppError(err)) {
    const out: ErrorInfo = { code: err.code, message: truncate(redactString(err.message)) };
    if (err.hint) out.hint = redactString(err.hint);
    if (err.details) out.details = redact(err.details);
    return out;
  }
  if (err instanceof Error) {
    const code = typeof (err as { code?: unknown }).code === 'string' ? String((err as { code?: unknown }).code) : fallbackCode;
    return { code, message: truncate(redactString(err.message || err.name)) };
  }
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: unknown; message: unknown };
    return { code: String(e.code), message: truncate(redactString(String(e.message))) };
  }
  return { code: fallbackCode, message: truncate(redactString(String(err))) };
}

function truncate(s: string): string {
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}...` : s;
}

export function errorCodeOf(err: unknown): string {
  if (isAppError(err)) return err.code;
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') return (err as { code: string }).code;
  return 'INTERNAL';
}

/**
 * Error codes that retrying cannot fix (bad input/config, policy, budget,
 * human decisions, ambiguous paid submissions). Everything else (timeouts,
 * provider/network errors, rate limits, unknown errors) is considered
 * transient and may be retried for idempotent, non-paid work.
 */
const NON_RETRYABLE: ReadonlySet<string> = new Set<ErrorCode | string>([
  'CONFIG_INVALID',
  'CONFIG_MISSING',
  'WORKSPACE_MISSING',
  'WORKSPACE_EXISTS',
  'WORKSPACE_UNSAFE',
  'CREDENTIALS_MISSING',
  'INTEGRATION_DISABLED',
  'PERMISSION_DENIED',
  'BUDGET_EXCEEDED',
  'BUDGET_UNKNOWN_PRICE',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'AMBIGUOUS_SUBMISSION',
  'UNSAFE_URL',
  'UNSAFE_PATH',
  'MIGRATION_FAILED',
  'DATA_UNAVAILABLE',
  'OFFLINE',
  // engine-specific codes
  'EVIDENCE_INSUFFICIENT',
  'INVALID_TRANSITION',
  'BUILD_INPUT_FAILED',
  'MODE_NOT_PERMITTED',
]);

export function isRetryableError(err: unknown): boolean {
  return !NON_RETRYABLE.has(errorCodeOf(err));
}

export function isRetryableCode(code: string): boolean {
  return !NON_RETRYABLE.has(code);
}

/**
 * Whether an error says something about the provider's health (and should
 * count towards opening its circuit breaker). Local policy/budget/config
 * errors do not.
 */
const PROVIDER_HEALTH_CODES: ReadonlySet<string> = new Set(['TIMEOUT', 'PROVIDER_ERROR', 'RATE_LIMITED', 'INTEGRATION_UNAVAILABLE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

export function countsAsProviderFailure(err: unknown): boolean {
  const code = errorCodeOf(err);
  // Offline refusals (--offline, demo mode) and cancellations say nothing about the provider:
  // nothing was sent. An error that keeps a legacy code but records kind "offline" is excluded too.
  if (code === 'OFFLINE' || code === 'CANCELLED') return false;
  if (isAppError(err) && (err.details as { kind?: unknown } | undefined)?.kind === 'offline') return false;
  if (isAppError(err)) return PROVIDER_HEALTH_CODES.has(err.code);
  // Unknown non-AppError failures (network errors, TypeError from fetch) count.
  return true;
}

export function cancelledError(message = 'Cancelled by request'): AppError {
  return new AppError('CANCELLED', message, { hint: 'Enqueue the job again if you still want it to run.' });
}

export function isCancellation(err: unknown): boolean {
  return errorCodeOf(err) === 'CANCELLED';
}
