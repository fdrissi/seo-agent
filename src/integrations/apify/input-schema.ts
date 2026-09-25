import { z } from 'zod';
import { ValidationError } from '../../core/errors.js';
import { hashObject, stableStringify } from '../../core/hash.js';

/**
 * Apify actor INPUT schema handling (pure functions, no I/O).
 *
 * The schema is whatever the actor build publishes (`build.inputSchema`, a
 * JSON string per AP5) or its OpenAPI conversion (`components.schemas.inputSchema`,
 * AP6). It is never invented, and an example input is never accepted as a
 * schema (an example cannot establish the complete field set).
 */

export const inputPropertySchema = z.looseObject({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  editor: z.string().optional(),
  default: z.unknown().optional(),
  prefill: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  enumTitles: z.array(z.unknown()).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
  pattern: z.string().optional(),
  isSecret: z.boolean().optional(),
  nullable: z.boolean().optional(),
  items: z.looseObject({ type: z.union([z.string(), z.array(z.string())]).optional() }).optional(),
  resourceType: z.string().optional(),
});
export type InputProperty = z.infer<typeof inputPropertySchema>;

export const actorInputSchemaSchema = z.looseObject({
  title: z.string().optional(),
  type: z.literal('object'),
  schemaVersion: z.number().optional(),
  description: z.string().optional(),
  properties: z.record(z.string(), inputPropertySchema),
  required: z.array(z.string()).optional(),
});
export type ActorInputSchema = z.infer<typeof actorInputSchemaSchema>;

/** Parse an input schema given as a JSON string or object. Throws ValidationError. */
export function parseInputSchema(raw: unknown, source = 'input schema'): ActorInputSchema {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new ValidationError(`${source}: not valid JSON (${(err as Error).message})`);
    }
  }
  const r = actorInputSchemaSchema.safeParse(value);
  if (!r.success) {
    throw new ValidationError(`${source}: not an Apify input schema (expected {type:"object", properties:{...}})`, {
      errors: r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }
  if (Object.keys(r.data.properties).length === 0) throw new ValidationError(`${source}: input schema declares no properties`);
  return r.data;
}

/** Canonical hash used for drift detection (key order independent). */
export function inputSchemaHash(schema: ActorInputSchema): string {
  return hashObject(schema);
}

export interface SchemaDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** Top-level (non-property) keys that changed, e.g. "required". */
  changedMeta: string[];
}

export function diffInputSchemas(prev: ActorInputSchema, next: ActorInputSchema): SchemaDiff {
  const a = prev.properties;
  const b = next.properties;
  const added = Object.keys(b).filter((k) => !(k in a)).sort();
  const removed = Object.keys(a).filter((k) => !(k in b)).sort();
  const changed = Object.keys(b)
    .filter((k) => k in a && stableStringify(a[k]) !== stableStringify(b[k]))
    .sort();
  const metaKeys = new Set([...Object.keys(prev), ...Object.keys(next)].filter((k) => k !== 'properties'));
  const changedMeta = [...metaKeys]
    .filter((k) => stableStringify((prev as Record<string, unknown>)[k]) !== stableStringify((next as Record<string, unknown>)[k]))
    .sort();
  return { added, removed, changed, changedMeta };
}

export function propertyTypes(p: InputProperty): string[] {
  if (!p.type) return [];
  return Array.isArray(p.type) ? p.type : [p.type];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/**
 * Validate an actor input against the stored schema. Every key must exist in
 * `properties` (fields outside the schema are rejected), values must match the
 * declared type/enum/range/pattern, secret fields must never be set, and
 * `required` fields must be present.
 */
export function validateInputAgainstSchema(input: Record<string, unknown>, schema: ActorInputSchema): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties[key];
    if (!prop) {
      errors.push(`"${key}" is not a field of the verified input schema`);
      continue;
    }
    if (value === undefined) continue;
    const types = propertyTypes(prop);
    if (types.length === 0) {
      // No declared type: only accept a value of the same JS type as the declared default.
      if (prop.default === undefined || typeof prop.default !== typeof value || Array.isArray(prop.default) !== Array.isArray(value)) {
        errors.push(`"${key}" has no declared type in the schema; refusing to set it`);
      }
    } else if (!(value === null && prop.nullable === true) && !types.some((t) => matchesType(value, t))) {
      errors.push(`"${key}" must be of type ${types.join('|')}`);
      continue;
    }
    if (prop.isSecret === true && value !== '' && value !== null) errors.push(`"${key}" is a secret field and must never be set by this application`);
    if (prop.enum && !prop.enum.some((e) => e === value)) errors.push(`"${key}" must be one of ${JSON.stringify(prop.enum)}`);
    if (typeof value === 'number') {
      if (prop.minimum !== undefined && value < prop.minimum) errors.push(`"${key}" must be >= ${prop.minimum}`);
      if (prop.maximum !== undefined && value > prop.maximum) errors.push(`"${key}" must be <= ${prop.maximum}`);
    }
    if (Array.isArray(value)) {
      if (prop.minItems !== undefined && value.length < prop.minItems) errors.push(`"${key}" needs at least ${prop.minItems} item(s)`);
      if (prop.maxItems !== undefined && value.length > prop.maxItems) errors.push(`"${key}" allows at most ${prop.maxItems} item(s)`);
      const itemTypes = prop.items ? propertyTypes(prop.items as InputProperty) : prop.editor === 'stringList' ? ['string'] : [];
      if (itemTypes.length && !value.every((v) => itemTypes.some((t) => matchesType(v, t)))) errors.push(`"${key}" items must be of type ${itemTypes.join('|')}`);
    }
    if (typeof value === 'string' && prop.pattern && value !== '') {
      let re: RegExp | null = null;
      try {
        re = new RegExp(prop.pattern);
      } catch {
        errors.push(`"${key}" has an invalid pattern in the schema; refusing to set it`);
      }
      if (re && !re.test(value)) errors.push(`"${key}" does not match the schema pattern`);
    }
  }
  for (const req of schema.required ?? []) {
    if (!(req in input)) errors.push(`required field "${req}" is missing`);
  }
  return errors;
}

export type SchemaDocumentKind = 'input_schema' | 'build' | 'openapi';

export interface DetectedSchemaDocument {
  kind: SchemaDocumentKind;
  schema: ActorInputSchema;
  buildNumber: string | null;
  buildId: string | null;
  actorId: string | null;
}

/**
 * Detect the input schema inside an exported document:
 *  - a raw input schema `{type:"object", properties:{...}}`
 *  - a build object or `{data: build}` envelope with `inputSchema` (string or object)
 *  - an OpenAPI document with `components.schemas.inputSchema`
 * Anything else (notably an example input such as `{"searchTerms":[...]}`)
 * is rejected: an example is never treated as the complete schema.
 */
export function detectSchemaDocument(doc: unknown, source = 'file'): DetectedSchemaDocument {
  if (!isPlainObject(doc)) throw new ValidationError(`${source}: expected a JSON object`);
  const d = isPlainObject(doc.data) && ('inputSchema' in doc.data || 'buildNumber' in doc.data) ? doc.data : doc;
  if ('inputSchema' in d) {
    if (d.inputSchema === null || d.inputSchema === undefined) {
      throw new ValidationError(`${source}: the build document has no inputSchema (null). The schema is unavailable from this export.`);
    }
    return {
      kind: 'build',
      schema: parseInputSchema(d.inputSchema, `${source} (build.inputSchema)`),
      buildNumber: typeof d.buildNumber === 'string' ? d.buildNumber : null,
      buildId: typeof d.id === 'string' ? d.id : null,
      actorId: typeof d.actId === 'string' ? d.actId : null,
    };
  }
  if (typeof d.openapi === 'string') {
    const comps = isPlainObject(d.components) ? d.components : null;
    const schemas = comps && isPlainObject(comps.schemas) ? comps.schemas : null;
    if (!schemas || !('inputSchema' in schemas)) throw new ValidationError(`${source}: OpenAPI document has no components.schemas.inputSchema`);
    return { kind: 'openapi', schema: parseInputSchema(schemas.inputSchema, `${source} (openapi inputSchema)`), buildNumber: null, buildId: null, actorId: null };
  }
  if (d.type === 'object' && isPlainObject(d.properties)) {
    return { kind: 'input_schema', schema: parseInputSchema(d, source), buildNumber: null, buildId: null, actorId: null };
  }
  throw new ValidationError(
    `${source}: no input schema found. This looks like an example input or an unrelated file; an example cannot establish the complete schema.`,
    { errors: ['Export the input schema itself (Apify console: Actor > Input schema / build JSON, or the build openapi.json).'] },
  );
}
