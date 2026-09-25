import { z } from 'zod';
import { AppError, errorMessage } from '../core/errors.js';
import type { TrustClass } from '../core/modes.js';
import type { Db } from '../database/db.js';
import { redactString } from './redact.js';
import { estimateTokens } from './untrusted.js';

/**
 * Allowlisted, typed runtime tools for LLM calls.
 *
 * The runtime model never gets shell access, raw SQL, secrets, network
 * fetches, or the ability to change policies, configuration, budgets,
 * permissions, or approvals. Tools are:
 *   - registered in code (never from model output or remote content),
 *   - read-only (`readOnly: true` is required and checked at registration),
 *   - site-scoped (the site id comes from the calling code's context, never
 *     from model-supplied arguments; argument schemas may not contain site ids),
 *   - typed (zod argument schemas; invalid arguments are rejected),
 *   - allowlisted per request (a registered tool the request did not allow is
 *     rejected exactly like an unknown tool).
 * Every rejected call is reported through `onRejected` so the caller can log
 * and audit it.
 */

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Name segments that indicate a dangerous capability. A tool name is split on
 * '_' and rejected when any segment is in this set, so a tool cannot be
 * registered as e.g. `run_shell`, `exec_sql`, `get_secret`, `update_budget`,
 * `approve_action`, `set_config`, or `fetch_url`.
 */
export const DENIED_NAME_SEGMENTS: ReadonlySet<string> = new Set([
  // process / code execution
  'shell', 'bash', 'sh', 'zsh', 'exec', 'execute', 'spawn', 'command', 'cmd', 'eval', 'script', 'run',
  // raw database access
  'sql', 'sqlite', 'database', 'db', 'pragma',
  // secrets
  'secret', 'secrets', 'credential', 'credentials', 'password', 'passwords', 'token', 'tokens', 'apikey', 'env', 'environment',
  // policy / configuration / budget / approval / permission mutation
  'policy', 'policies', 'config', 'configuration', 'settings', 'budget', 'budgets', 'approval', 'approvals', 'approve', 'reject',
  'permission', 'permissions', 'grant', 'revoke', 'role', 'roles', 'mode',
  // generic mutation
  'write', 'delete', 'remove', 'update', 'insert', 'drop', 'create', 'set', 'put', 'patch', 'post', 'mutate', 'modify', 'edit',
  'publish', 'deploy', 'send', 'email',
  // network / filesystem (SSRF and exfiltration)
  'fetch', 'http', 'https', 'download', 'upload', 'browse', 'crawl', 'request', 'curl', 'file', 'files', 'filesystem', 'path',
]);

/** Argument keys that may never appear in a tool's argument schema. */
export const DENIED_ARG_KEYS: ReadonlySet<string> = new Set(['site_id', 'siteid', 'site', 'sql', 'query_sql', 'command', 'shell', 'script', 'path', 'file', 'url_to_fetch', 'secret', 'api_key', 'token', 'password']);

/**
 * Read-only, site-scoped query helper handed to tool handlers. Only a single
 * SELECT/WITH statement is accepted and the site id must be one of the bound
 * parameters. This is defense in depth: handler SQL is application code, never
 * model output.
 */
export interface ReadOnlyQuery {
  get<T = Record<string, unknown>>(sql: string, params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params: unknown[]): T[];
}

const WRITE_KEYWORDS_RE = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

export function assertReadOnlySql(sql: string): void {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim();
  if (!/^(select|with)\b/i.test(stripped)) throw new AppError('POLICY_DENIED', 'Tool queries must be a single SELECT statement');
  if (/;\s*\S/.test(stripped)) throw new AppError('POLICY_DENIED', 'Tool queries may not contain multiple statements');
  if (WRITE_KEYWORDS_RE.test(stripped)) throw new AppError('POLICY_DENIED', 'Tool queries may not modify data or database settings');
}

export function createReadOnlyQuery(db: Db, siteId: string): ReadOnlyQuery {
  const check = (sql: string, params: unknown[]) => {
    assertReadOnlySql(sql);
    if (!params.includes(siteId)) throw new AppError('POLICY_DENIED', 'Tool queries must be scoped to the current site (bind the site id as a parameter)');
  };
  return {
    get<T>(sql: string, params: unknown[]): T | undefined {
      check(sql, params);
      return db.get<T>(sql, params);
    },
    all<T>(sql: string, params: unknown[]): T[] {
      check(sql, params);
      return db.all<T>(sql, params);
    },
  };
}

/** Public, non-secret business profile a tool may expose. */
export interface ToolSiteProfile {
  id: string;
  businessName: string;
  url: string;
  offer: string | null;
  targetCustomer: string | null;
  differentiators: string[];
  productFacts: Array<{ id: string; statement: string; source: string | null; verifiedAt: string | null }>;
  approvedClaims: string[];
  prohibitedClaims: string[];
  languages: string[];
  countries: string[];
}

export interface ToolContext {
  /** Fixed by the calling code; never taken from model arguments. */
  readonly siteId: string;
  readonly runId: string;
  readonly traceId: string;
  readonly query: ReadOnlyQuery;
  readonly site: Readonly<ToolSiteProfile>;
  now(): Date;
}

export interface ToolDefinition<A = unknown> {
  name: string;
  description: string;
  /** Argument schema (must be a zod object). */
  args: z.ZodType<A>;
  /** Must be literally true: runtime tools never mutate state. */
  readOnly: true;
  /** Must be literally true: results come only from the calling site's data. */
  siteScoped: true;
  /** Trust class of the result (tool results are rendered as untrusted data blocks). */
  resultTrust: TrustClass;
  /** Maximum serialized result length before truncation (default 8000 chars). */
  maxResultChars?: number;
  handler(args: A, ctx: ToolContext): unknown | Promise<unknown>;
}

export interface OpenAiToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCallInput {
  id: string;
  name: string;
  /** JSON string as returned by the model. */
  arguments: string;
}

export type ToolExecutionStatus = 'ok' | 'rejected' | 'invalid_args' | 'error';

export interface ToolExecution {
  callId: string;
  name: string;
  status: ToolExecutionStatus;
  /** JSON-serializable content returned to the model (already size-limited). */
  content: string;
  reason?: string;
  truncated: boolean;
  /** Size of the serialized result before the per-tool `maxResultChars` cut (set when `truncated`). */
  originalChars?: number;
  /** Estimated tokens (estimateTokens) of the result before the `maxResultChars` cut (set when `truncated`). */
  originalTokens?: number;
  resultTrust: TrustClass;
}

export interface ToolRejection {
  callId: string;
  name: string;
  reason: string;
  argumentsPreview: string;
}

const MAX_ARGUMENT_CHARS = 10_000;
const DEFAULT_MAX_RESULT_CHARS = 8_000;

export function toolNameProblems(name: string): string[] {
  const problems: string[] = [];
  if (!TOOL_NAME_RE.test(name)) problems.push(`name "${name}" must match ${TOOL_NAME_RE}`);
  for (const seg of name.toLowerCase().split('_')) {
    if (DENIED_NAME_SEGMENTS.has(seg)) problems.push(`name segment "${seg}" indicates a disallowed capability (shell, SQL, secrets, network, or policy/config/budget/approval mutation)`);
  }
  return problems;
}

function argKeys(schema: z.ZodType): string[] | null {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== 'object') return null;
  return Object.keys(shape);
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any>>();

  /** Register a tool. Throws POLICY_DENIED for anything outside the runtime tool policy. */
  register<A>(def: ToolDefinition<A>): this {
    const problems = toolNameProblems(def.name);
    if ((def as { readOnly: unknown }).readOnly !== true) problems.push('tools must be read-only (readOnly: true)');
    if ((def as { siteScoped: unknown }).siteScoped !== true) problems.push('tools must be site-scoped (siteScoped: true)');
    const keys = argKeys(def.args);
    if (!keys) problems.push('argument schema must be a zod object');
    else {
      for (const k of keys) if (DENIED_ARG_KEYS.has(k.toLowerCase())) problems.push(`argument "${k}" is not allowed (site ids, SQL, commands, paths, URLs to fetch, and secrets are never model-supplied)`);
    }
    if (typeof def.handler !== 'function') problems.push('handler must be a function');
    if (this.tools.has(def.name)) problems.push(`tool "${def.name}" is already registered`);
    if (problems.length) throw new AppError('POLICY_DENIED', `Refusing to register runtime tool "${def.name}": ${problems.join('; ')}`, { details: { problems } });
    this.tools.set(def.name, def);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  get(name: string): ToolDefinition<unknown> | undefined {
    return this.tools.get(name);
  }

  /** Validate a request's tool allowlist (unknown names are a programming error). */
  resolveAllowlist(names: readonly string[] | undefined): string[] {
    if (!names?.length) return [];
    const unknown = names.filter((n) => !this.tools.has(n));
    if (unknown.length) throw new AppError('POLICY_DENIED', `Request allowlists unregistered tool(s): ${unknown.join(', ')}`);
    return [...new Set(names)].sort();
  }

  /** OpenAI-format function tool specs for the allowlisted names (JSON Schema from zod). */
  specs(names: readonly string[]): OpenAiToolSpec[] {
    return this.resolveAllowlist(names).map((name) => {
      const def = this.tools.get(name)!;
      let parameters: Record<string, unknown>;
      try {
        parameters = z.toJSONSchema(def.args, { io: 'input' }) as Record<string, unknown>;
      } catch (err) {
        throw new AppError('INTERNAL', `Tool "${name}" argument schema cannot be represented as JSON Schema: ${errorMessage(err)}`);
      }
      delete parameters.$schema;
      return { type: 'function', function: { name, description: def.description, parameters } };
    });
  }

  /**
   * Execute one model-requested tool call. Never throws for model-caused
   * problems: unknown/not-allowlisted tools are 'rejected', bad arguments are
   * 'invalid_args', handler failures are 'error'.
   */
  async execute(call: ToolCallInput, opts: { allowed: ReadonlySet<string>; ctx: ToolContext; onRejected?: (r: ToolRejection) => void }): Promise<ToolExecution> {
    const name = String(call.name ?? '');
    const preview = redactString(String(call.arguments ?? '').slice(0, 200));
    const reject = (reason: string): ToolExecution => {
      opts.onRejected?.({ callId: call.id, name, reason, argumentsPreview: preview });
      return {
        callId: call.id,
        name,
        status: 'rejected',
        content: JSON.stringify({ error: 'tool_rejected', message: `Tool "${name.slice(0, 64)}" is not available for this request. Only these tools may be used: ${[...opts.allowed].join(', ') || '(none)'}.` }),
        reason,
        truncated: false,
        resultTrust: 'model_generated',
      };
    };
    const def = this.tools.get(name);
    if (!def) return reject(`unknown tool "${name.slice(0, 64)}"`);
    if (!opts.allowed.has(name)) return reject(`tool "${name}" is registered but not allowlisted for this request`);

    const raw = String(call.arguments ?? '');
    if (raw.length > MAX_ARGUMENT_CHARS) {
      return { callId: call.id, name, status: 'invalid_args', content: JSON.stringify({ error: 'invalid_arguments', message: 'Arguments too large.' }), reason: 'arguments too large', truncated: false, resultTrust: def.resultTrust };
    }
    let parsedJson: unknown;
    try {
      parsedJson = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      return { callId: call.id, name, status: 'invalid_args', content: JSON.stringify({ error: 'invalid_arguments', message: 'Arguments are not valid JSON.' }), reason: 'arguments are not valid JSON', truncated: false, resultTrust: def.resultTrust };
    }
    const parsed = def.args.safeParse(parsedJson);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      return { callId: call.id, name, status: 'invalid_args', content: JSON.stringify({ error: 'invalid_arguments', issues }), reason: issues.join('; '), truncated: false, resultTrust: def.resultTrust };
    }
    try {
      const result = await def.handler(parsed.data, opts.ctx);
      let content = JSON.stringify(result ?? null);
      const max = def.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
      let truncated = false;
      const originalChars = content.length;
      const originalTokens = content.length > max ? estimateTokens(content) : 0;
      if (content.length > max) {
        content = `${content.slice(0, max)}…[TRUNCATED tool result: ${content.length - max} characters omitted]`;
        truncated = true;
      }
      return { callId: call.id, name, status: 'ok', content: redactString(content), truncated, ...(truncated ? { originalChars, originalTokens } : {}), resultTrust: def.resultTrust };
    } catch (err) {
      const message = redactString(errorMessage(err)).slice(0, 300);
      return { callId: call.id, name, status: 'error', content: JSON.stringify({ error: 'tool_failed', message }), reason: message, truncated: false, resultTrust: def.resultTrust };
    }
  }
}

// ---------------------------------------------------------------------------
// Built-in read-only tools
// ---------------------------------------------------------------------------

/** Public business profile from the validated site config (no secrets, no budgets, no credentials). */
export const siteProfileTool: ToolDefinition<Record<string, never>> = {
  name: 'get_site_profile',
  description: 'Return the public business profile for the current website: offer, target customer, differentiators, verified product facts, approved and prohibited claims, languages, and countries.',
  args: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  readOnly: true,
  siteScoped: true,
  resultTrust: 'owner_approved',
  handler: (_args, ctx) => ctx.site,
};

const evidenceArgs = z.object({ evidence_id: z.string().min(1).max(120).describe('Evidence id as shown in the evidence bundle or a prior tool result') }).strict();

/** One evidence record (with its source's type and trust class) belonging to the current site. */
export const getEvidenceTool: ToolDefinition<z.infer<typeof evidenceArgs>> = {
  name: 'get_evidence',
  description: 'Look up one stored evidence record for the current website by id: summary, excerpt, date range, source type, source URL, and trust class.',
  args: evidenceArgs,
  readOnly: true,
  siteScoped: true,
  resultTrust: 'scraped_untrusted',
  maxResultChars: 6_000,
  handler: (args, ctx) => {
    const row = ctx.query.get<Record<string, unknown>>(
      `SELECT e.id, e.kind, e.summary, e.excerpt, e.date_range_start, e.date_range_end, e.collected_at, s.source_type, s.trust_class, s.url
         FROM evidence e JOIN sources s ON s.id = e.source_id
        WHERE e.site_id = ? AND s.site_id = ? AND e.id = ?`,
      [ctx.siteId, ctx.siteId, args.evidence_id],
    );
    return row ?? { found: false, evidence_id: args.evidence_id };
  },
};

/** Registry with the built-in read-only tools. Other modules may register more read-only tools. */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(siteProfileTool).register(getEvidenceTool);
}
