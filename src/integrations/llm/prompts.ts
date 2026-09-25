import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { AppError, ValidationError } from '../../core/errors.js';
import { sha256 } from '../../core/hash.js';
import { appDirs } from '../../config/paths.js';
import { safeResolve } from '../../security/paths.js';
import { redactPersonalIdentifiers } from '../../memory/sanitize.js';
import { redactString } from '../../security/redact.js';
import { sanitizeUntrustedText } from '../../security/untrusted.js';
import type { LogicalRole, ModelTier } from './types.js';

/**
 * Runtime prompt templates: `prompts/<id>.md`.
 *
 *   ---
 *   id: router.classify-intent
 *   version: 1
 *   role: classifier            # extractor|classifier|analyst|synthesizer|writer|reviewer (system.* prompts: system)
 *   tier: cheap                 # cheap|reasoning|any
 *   description: ...
 *   output_schema: IntentClassification   # schema name, or "text"
 *   ---
 *   ## System
 *   ...fixed instructions (no placeholders in task prompts)...
 *   ## User
 *   ...{{variable}} placeholders...
 *
 * Recorded prompt version: `<id>@<version>+<sha256(file)[0:8]>`.
 *
 * Security properties:
 *  - Task prompts may not contain placeholders in `## System`, so no runtime
 *    value (and therefore no remote content) can alter a system prompt. Only
 *    `system.*` base prompts take placeholders there, filled exclusively by the
 *    LLM client with code-generated values (boundary token, schema, tool names).
 *  - Unknown variables (supplied but not used) and missing variables are errors.
 *  - Values are redacted, sanitized (no data-boundary spoofing, no invisible or
 *    control characters), and substituted in a single pass (a value containing
 *    `{{x}}` is never re-expanded).
 */

export const LOGICAL_ROLES = ['extractor', 'classifier', 'analyst', 'synthesizer', 'writer', 'reviewer'] as const satisfies readonly LogicalRole[];
export const PROMPT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Variable names reserved for values injected by the LLM client. */
export const RESERVED_VARIABLES = new Set(['evidence']);
const PLACEHOLDER_RE = /(\\?)\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const MAX_VARIABLE_CHARS = 50_000;

const frontmatterSchema = z.looseObject({
  id: z.string().regex(PROMPT_ID_RE, 'lowercase letters, digits, ".", "_" and "-"'),
  version: z.union([z.string().min(1), z.number()]).transform((v) => String(v)),
  role: z.enum([...LOGICAL_ROLES, 'system']),
  tier: z.enum(['cheap', 'reasoning', 'any']),
  description: z.string().min(1),
  output_schema: z.string().min(1),
  variables: z.array(z.string()).optional(),
});

export interface PromptTemplate {
  id: string;
  version: string;
  role: LogicalRole | 'system';
  tier: ModelTier | 'any';
  description: string;
  /** Schema name the output must satisfy, or 'text'. */
  outputSchema: string;
  system: string;
  user: string;
  systemPlaceholders: string[];
  userPlaceholders: string[];
  /** Full file hash. */
  sha256: string;
  /** `<id>@<version>+<sha256[0:8]>` */
  versionString: string;
  file: string | null;
}

export function promptVersionString(id: string, version: string, content: string): string {
  return `${id}@${version}+${sha256(content).slice(0, 8)}`;
}

function placeholders(section: string): string[] {
  const names = new Set<string>();
  for (const m of section.matchAll(PLACEHOLDER_RE)) if (!m[1]) names.add(m[2]!);
  return [...names].sort();
}

/**
 * Strict YAML for frontmatter: core schema, no custom tags, unique keys, and
 * ANY parser warning (e.g. an unresolved `!!js/function` tag) is an error.
 */
function parseFrontmatterYaml(text: string, where: string): unknown {
  const doc = parseDocument(text, { schema: 'core', customTags: [], uniqueKeys: true, prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings].map((e) => e.message.split('\n')[0]);
  if (problems.length) throw new ValidationError(`${where}: invalid frontmatter YAML (${problems.join('; ')})`);
  return doc.toJS({ maxAliasCount: 100 });
}

/** Parse a template file's text. Throws ValidationError with an actionable message. */
export function parsePromptTemplate(text: string, opts: { file?: string; expectedId?: string } = {}): PromptTemplate {
  const where = opts.file ?? opts.expectedId ?? 'prompt';
  const normalized = text.replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!fm) throw new ValidationError(`${where}: missing YAML frontmatter (--- ... ---) at the top of the file`);
  const meta = frontmatterSchema.safeParse(parseFrontmatterYaml(fm[1]!, where));
  if (!meta.success) throw new ValidationError(`${where}: invalid frontmatter: ${meta.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const m = meta.data;
  if (opts.expectedId && m.id !== opts.expectedId) throw new ValidationError(`${where}: frontmatter id "${m.id}" does not match the file name "${opts.expectedId}"`);
  const isSystemPrompt = m.id.startsWith('system.');
  if (m.role === 'system' && !isSystemPrompt) throw new ValidationError(`${where}: role "system" is reserved for system.* base prompts`);

  const body = fm[2]!;
  const lines = body.split('\n');
  const idxSystem = lines.findIndex((l) => /^##\s+System\s*$/.test(l));
  const idxUser = lines.findIndex((l) => /^##\s+User\s*$/.test(l));
  if (idxSystem < 0 || idxUser < 0) throw new ValidationError(`${where}: template needs both "## System" and "## User" sections`);
  if (idxUser < idxSystem) throw new ValidationError(`${where}: "## System" must come before "## User"`);
  if (lines.filter((l) => /^##\s+(System|User)\s*$/.test(l)).length !== 2) throw new ValidationError(`${where}: "## System" and "## User" must each appear exactly once`);
  const system = lines.slice(idxSystem + 1, idxUser).join('\n').trim();
  const user = lines.slice(idxUser + 1).join('\n').trim();
  if (!system) throw new ValidationError(`${where}: "## System" section is empty`);

  const systemPlaceholders = placeholders(system);
  const userPlaceholders = placeholders(user);
  if (systemPlaceholders.length && !isSystemPrompt) {
    throw new ValidationError(`${where}: task prompts may not use placeholders in "## System" (found ${systemPlaceholders.map((p) => `{{${p}}}`).join(', ')}); move them to "## User" so runtime values can never alter a system prompt`);
  }
  if (m.variables) {
    const declared = new Set(m.variables);
    const used = new Set([...systemPlaceholders, ...userPlaceholders].filter((p) => !RESERVED_VARIABLES.has(p)));
    const undeclared = [...used].filter((u) => !declared.has(u));
    const unused = [...declared].filter((d) => !used.has(d));
    if (undeclared.length || unused.length) {
      throw new ValidationError(`${where}: frontmatter "variables" must match the placeholders (undeclared: ${undeclared.join(', ') || 'none'}; unused: ${unused.join(', ') || 'none'})`);
    }
  }
  return {
    id: m.id,
    version: m.version,
    role: m.role,
    tier: m.tier,
    description: m.description,
    outputSchema: m.output_schema,
    system,
    user,
    systemPlaceholders,
    userPlaceholders,
    sha256: sha256(normalized),
    versionString: promptVersionString(m.id, m.version, normalized),
    file: opts.file ?? null,
  };
}

/** Render one variable value as prompt text (redacted and sanitized; never re-expanded). */
export function formatVariable(name: string, value: unknown): string {
  if (value === undefined) throw new ValidationError(`Prompt variable "${name}" is undefined`);
  let text: string;
  if (value === null) text = 'null';
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = String(value);
  else if (value instanceof Date) text = value.toISOString();
  else text = JSON.stringify(value, null, 2);
  if (text.length > MAX_VARIABLE_CHARS) {
    throw new ValidationError(`Prompt variable "${name}" is ${text.length} characters; long or externally sourced text belongs in the evidence bundle, not in template variables`);
  }
  // Variables are code-computed values, but they end up in the prompt next to evidence: secrets are
  // redacted and personal identifiers masked here too (evidence has its own, configurable policy).
  const clean = redactPersonalIdentifiers(sanitizeUntrustedText(redactString(text)), { phones: true, handles: true }).text;
  return clean.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

/**
 * Substitute `{{name}}` placeholders in one pass. Every placeholder must be
 * supplied; `\{{` renders a literal `{{`.
 */
export function substitute(section: string, values: Record<string, string>, where = 'prompt'): string {
  return section.replace(PLACEHOLDER_RE, (_all, escape: string, name: string) => {
    if (escape) return `{{${name}}}`;
    const v = values[name];
    if (v === undefined) throw new ValidationError(`${where}: missing value for placeholder {{${name}}}`);
    return v;
  });
}

export interface RenderedPrompt {
  template: PromptTemplate;
  system: string;
  user: string;
  /** True when the user section contained `{{evidence}}` (the client substitutes the bundle there). */
  hasEvidencePlaceholder: boolean;
}

export const EVIDENCE_SLOT = '\u0000EVIDENCE_SLOT\u0000';

/**
 * Render a template with caller variables. Unknown variables (supplied but not
 * referenced) and missing ones are errors. Reserved names (`evidence`) cannot
 * be supplied by callers. `systemValues` is only for system.* prompts and is
 * filled by the LLM client with code-generated values.
 */
export function renderPrompt(template: PromptTemplate, variables: Record<string, unknown>, opts: { systemValues?: Record<string, string> } = {}): RenderedPrompt {
  const where = template.id;
  for (const k of Object.keys(variables)) {
    if (RESERVED_VARIABLES.has(k)) throw new ValidationError(`${where}: variable "${k}" is reserved (evidence is passed as the request's evidence bundle)`);
  }
  const allowedUser = new Set(template.userPlaceholders.filter((p) => !RESERVED_VARIABLES.has(p)));
  const unknown = Object.keys(variables).filter((k) => !allowedUser.has(k));
  if (unknown.length) throw new ValidationError(`${where}: unknown variable(s) ${unknown.join(', ')} (template placeholders: ${[...allowedUser].join(', ') || 'none'})`);
  const missing = [...allowedUser].filter((p) => !(p in variables) || variables[p] === undefined);
  if (missing.length) throw new ValidationError(`${where}: missing variable(s) ${missing.join(', ')}`);
  const userValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) userValues[k] = formatVariable(k, v);
  const hasEvidencePlaceholder = template.userPlaceholders.includes('evidence');
  if (hasEvidencePlaceholder) userValues.evidence = EVIDENCE_SLOT;

  let system = template.system;
  if (template.systemPlaceholders.length) {
    if (!template.id.startsWith('system.')) throw new ValidationError(`${where}: placeholders in System are only allowed for system.* prompts`);
    const sv = opts.systemValues ?? {};
    system = substitute(template.system, sv, `${where} (System)`);
  }
  return { template, system, user: substitute(template.user, userValues, `${where} (User)`), hasEvidencePlaceholder };
}

/** Loads and caches templates from a prompts directory (default: the application's prompts/). */
export class PromptRegistry {
  private readonly cache = new Map<string, PromptTemplate>();
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? appDirs.prompts();
  }

  path(id: string): string {
    if (!PROMPT_ID_RE.test(id)) throw new ValidationError(`Invalid prompt id "${id}"`);
    return safeResolve(this.dir, `${id}.md`);
  }

  has(id: string): boolean {
    try {
      return existsSync(this.path(id));
    } catch {
      return false;
    }
  }

  load(id: string): PromptTemplate {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const file = this.path(id);
    if (!existsSync(file)) throw new AppError('NOT_FOUND', `Prompt template "${id}" not found at ${file}`, { hint: 'Create prompts/<id>.md (see prompts/README.md).' });
    const t = parsePromptTemplate(readFileSync(file, 'utf8'), { file, expectedId: id });
    this.cache.set(id, t);
    return t;
  }

  /** Register an in-memory template (tests/demo). */
  add(text: string): PromptTemplate {
    const t = parsePromptTemplate(text);
    this.cache.set(t.id, t);
    return t;
  }

  render(id: string, variables: Record<string, unknown>, opts: { systemValues?: Record<string, string> } = {}): RenderedPrompt {
    return renderPrompt(this.load(id), variables, opts);
  }
}
