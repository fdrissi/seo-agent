/**
 * Typed application errors. Every error carries a stable machine-readable code
 * so CLI output, reports, and doctor checks can present honest, actionable
 * statuses instead of generic failures.
 */

/**
 * Every ErrorCode, in one runtime tuple. The ErrorCode type is derived from it,
 * so code that needs the list at runtime (for example to keep a stage's error
 * code when a job fails) cannot drift from the type.
 */
export const ERROR_CODE_VALUES = [
  'CONFIG_INVALID',
  'CONFIG_MISSING',
  'WORKSPACE_MISSING',
  'WORKSPACE_EXISTS',
  'WORKSPACE_UNSAFE',
  'CREDENTIALS_MISSING',
  'INTEGRATION_DISABLED',
  'INTEGRATION_UNAVAILABLE',
  /**
   * Network access is disabled for this run (--offline or demo mode): nothing
   * was sent. Says nothing about the provider's health, so it never counts
   * towards a circuit breaker, and retrying within the run cannot help.
   */
  'OFFLINE',
  'PERMISSION_DENIED',
  'BUDGET_EXCEEDED',
  'BUDGET_UNKNOWN_PRICE',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'LOCKED',
  'TIMEOUT',
  'CANCELLED',
  'AMBIGUOUS_SUBMISSION',
  'PROVIDER_ERROR',
  'RATE_LIMITED',
  'UNSAFE_URL',
  'UNSAFE_PATH',
  'MIGRATION_FAILED',
  'MIGRATION_PENDING',
  'DATA_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODE_VALUES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODE_VALUES);

/** Whether a string is one of the ErrorCode values. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  /** A short, user-facing next step (never contains secrets). */
  readonly hint: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; hint?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.details = opts.details;
    this.hint = opts.hint;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export class ConfigError extends AppError {
  constructor(message: string, opts: { details?: Record<string, unknown>; hint?: string } = {}) {
    super('CONFIG_INVALID', message, opts);
    this.name = 'ConfigError';
  }
}

export class CredentialsMissingError extends AppError {
  constructor(integration: string, missing: string[], hint?: string) {
    super('CREDENTIALS_MISSING', `${integration}: missing credentials (${missing.join(', ')})`, {
      details: { integration, missing },
      hint: hint ?? 'See docs/ACCESS_SETUP.md. Put secrets in the workspace secrets file, never in chat or the vault.',
    });
    this.name = 'CredentialsMissingError';
  }
}

export class IntegrationDisabledError extends AppError {
  constructor(integration: string, reason: string) {
    super('INTEGRATION_DISABLED', `${integration} is disabled: ${reason}`, { details: { integration, reason } });
    this.name = 'IntegrationDisabledError';
  }
}

export class BudgetExceededError extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('BUDGET_EXCEEDED', message, {
      details,
      hint: 'No automatic budget increases are performed. Adjust budgets in the site config only if you intend to spend more.',
    });
    this.name = 'BudgetExceededError';
  }
}

export class PolicyDeniedError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('POLICY_DENIED', message, { details });
    this.name = 'PolicyDeniedError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, { details });
    this.name = 'ValidationError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Convert any thrown value into a safe message (callers must still redact). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
