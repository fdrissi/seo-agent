import { generatedContentHash, pickProps } from './frontmatter.js';

/**
 * Does the generated part of a note on disk match what seo-agent recorded?
 *
 * `vault_notes` keeps the hash of the generated content seo-agent last wrote
 * (`last_generated_hash`, with the owned keys in `generated_keys_json`). A
 * write records the hash it is about to commit in `pending_generated_hash`
 * BEFORE the file is replaced and clears it after the database update, so a
 * crash (or a database error) between the file rename and the database update
 * is recognized on the next run instead of being mistaken for a human edit.
 *
 * Shared by the writer (conflict detection) and `vault check` (reporting).
 */

/** Core generated keys, used when a row predates `generated_keys_json`. */
export const DEFAULT_GENERATED_KEYS: readonly string[] = ['id', 'type', 'site', 'generated_at', 'source_ids', 'title'];

export interface TrackedHashes {
  last_generated_hash: string | null;
  generated_keys_json: string | null;
  pending_generated_hash?: string | null;
  pending_generated_keys_json?: string | null;
}

export interface BaselineMatch {
  /** Which recorded state the disk matches. */
  via: 'recorded' | 'recorded_legacy' | 'pending';
  /** The generated keys owned by that state. */
  keys: string[];
}

export function parseKeyList(json: string | null | undefined, fallback: readonly string[]): string[] {
  if (json) {
    try {
      const keys = JSON.parse(json) as unknown;
      if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) return keys as string[];
    } catch {
      /* fall through */
    }
  }
  return [...fallback];
}

/**
 * Compare the generated properties and region on disk with the recorded
 * state. Returns null when neither the recorded nor the pending state matches
 * (a human edited generated content, or the database does not describe this
 * file).
 */
export function matchRecordedBaseline(row: TrackedHashes, frontmatter: Record<string, unknown>, region: string, fallbackKeys: readonly string[] = DEFAULT_GENERATED_KEYS): BaselineMatch | null {
  const keys = parseKeyList(row.generated_keys_json, fallbackKeys);
  if (row.last_generated_hash) {
    const props = pickProps(frontmatter, keys);
    if (generatedContentHash(props, region) === row.last_generated_hash) return { via: 'recorded', keys };
    // Hash format of earlier versions (shared list keys such as tags were included).
    if (generatedContentHash(props, region, { includeMergeable: true }) === row.last_generated_hash) return { via: 'recorded_legacy', keys };
  }
  if (row.pending_generated_hash) {
    const pendingKeys = parseKeyList(row.pending_generated_keys_json, keys);
    if (generatedContentHash(pickProps(frontmatter, pendingKeys), region) === row.pending_generated_hash) return { via: 'pending', keys: pendingKeys };
  }
  return null;
}
