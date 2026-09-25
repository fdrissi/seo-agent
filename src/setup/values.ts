/**
 * Helpers for the partial site-configuration objects the setup wizard builds.
 * Paths are dotted ("site.url", "budgets.llmGateway.monthlyUsd"); arrays are
 * treated as leaf values (a list answer replaces the whole list).
 */

export type Values = Record<string, unknown>;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function parts(path: string): string[] {
  return path.split('.').filter(Boolean);
}

export function getAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of parts(path)) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function setAt(obj: Values, path: string, value: unknown): void {
  const ps = parts(path);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < ps.length - 1; i++) {
    const p = ps[i]!;
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') throw new Error(`Unsafe path segment: ${p}`);
    const next = cur[p];
    if (!isPlainObject(next)) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = ps[ps.length - 1]!;
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') throw new Error(`Unsafe path segment: ${last}`);
  cur[last] = value;
}

/** True when a value counts as "provided" (not undefined/null/blank/empty list). */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Deep merge of plain objects; arrays and scalars from `overlay` replace those in `base`. Inputs are not mutated. */
export function mergeValues(base: unknown, overlay: unknown): Values {
  const out: Values = isPlainObject(base) ? structuredClone(base) : {};
  if (!isPlainObject(overlay)) return out;
  for (const [k, v] of Object.entries(overlay)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeValues(out[k], v);
    else out[k] = isPlainObject(v) || Array.isArray(v) ? structuredClone(v) : v;
  }
  return out;
}

/** Leaf entries (arrays and scalars are leaves; empty objects are leaves too). */
export function leafEntries(obj: unknown, prefix: string[] = []): Array<[string[], unknown]> {
  if (!isPlainObject(obj)) return [[prefix, obj]];
  const keys = Object.keys(obj);
  if (!keys.length) return prefix.length ? [[prefix, {}]] : [];
  const out: Array<[string[], unknown]> = [];
  for (const k of keys) {
    const v = obj[k];
    if (isPlainObject(v) && Object.keys(v).length) out.push(...leafEntries(v, [...prefix, k]));
    else out.push([[...prefix, k], v]);
  }
  return out;
}

/** Reorder top-level keys to follow `order` (unknown keys keep their relative order at the end). */
export function orderKeys(values: Values, order: readonly string[]): Values {
  const out: Values = {};
  for (const k of order) if (k in values) out[k] = values[k];
  for (const [k, v] of Object.entries(values)) if (!(k in out)) out[k] = v;
  return out;
}
