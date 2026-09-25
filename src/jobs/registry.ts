import { AppError } from '../core/errors.js';
import type { JobHandler } from './types.js';

export const JOB_TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Registry of job handlers keyed by job type. The integration phase registers
 * the baseline/weekly/monthly (and other) handlers in src/jobs/handlers.ts;
 * this module has no knowledge of specific pipelines.
 */
export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler<any>>();

  register<P extends Record<string, unknown>>(handler: JobHandler<P>): this {
    if (!JOB_TYPE_RE.test(handler.type)) throw new AppError('VALIDATION_FAILED', `Invalid job type "${handler.type}"`);
    if (this.handlers.has(handler.type)) throw new AppError('CONFLICT', `A handler for job type "${handler.type}" is already registered`);
    if (handler.maxAttempts !== undefined && (!Number.isInteger(handler.maxAttempts) || handler.maxAttempts < 1)) {
      throw new AppError('VALIDATION_FAILED', `maxAttempts for "${handler.type}" must be a positive integer`);
    }
    this.handlers.set(handler.type, handler);
    return this;
  }

  get(type: string): JobHandler<any> | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()].sort();
  }

  describe(): Array<{ type: string; description: string; lockName: string }> {
    return this.types().map((t) => {
      const h = this.handlers.get(t)!;
      return { type: t, description: h.description, lockName: h.lockName ?? 'site' };
    });
  }
}
