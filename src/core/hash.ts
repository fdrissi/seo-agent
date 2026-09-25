import { createHash } from 'node:crypto';

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Canonical JSON: object keys sorted recursively, undefined dropped. Used for
 * parameter hashes, approval artifact hashes, and row-change detection.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

/**
 * Normalized content hash: collapses whitespace and Unicode normalization
 * differences so trivial formatting changes do not create new embeddings.
 */
export function normalizedContentHash(text: string): string {
  return sha256(text.normalize('NFC').replace(/\s+/g, ' ').trim());
}
