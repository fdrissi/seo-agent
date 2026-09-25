import { hashObject } from '../core/hash.js';
import type { ApprovalActionType } from './types.js';

/**
 * Canonical artifact hashing. An approval binds the hash of the exact
 * proposed change; any edit to the change (target, action type, or content)
 * produces a different hash and therefore requires a new approval.
 *
 * Deliberately excluded from the hash: timestamps, statuses, ids of the
 * record holding the proposal (the approval binds subject type/id separately).
 */

export const ARTIFACT_HASH_VERSION = 1;

export interface ArtifactIdentity {
  actionType: ApprovalActionType;
  /** Absolute target URL (or other exact target key). */
  target: string;
  /** Exact content of the change: every field that will go live. */
  change: Record<string, unknown>;
}

export function computeArtifactHash(a: ArtifactIdentity): string {
  return hashObject({ v: ARTIFACT_HASH_VERSION, actionType: a.actionType, target: a.target, change: a.change });
}

/** Short, human-typeable prefix of an artifact hash shown for confirmation (review output only). */
export function hashPrefix(hash: string, length = 12): string {
  return hash.slice(0, length);
}

/**
 * A 6-character reference to a hash for messages OUTSIDE the review output
 * (invalidation reasons, errors). It is shorter than the 8-character minimum
 * of `--confirm`, so it can never be used to approve without reviewing.
 */
export function shortRef(hash: string): string {
  return hash.slice(0, 6);
}

/**
 * Map a free-form recommendation/experiment action or type to an approval
 * action type. Anything unrecognized becomes `update_page`, which is still a
 * production action (EXECUTE + approval), never a weaker class.
 */
export function mapToApprovalActionType(kind: string | null | undefined): ApprovalActionType {
  const k = (kind ?? '').toLowerCase();
  if (/redirect/.test(k)) return 'redirect';
  if (/merge|consolidat/.test(k)) return 'merge_pages';
  if (/delet|remove_page|unpublish/.test(k)) return 'delete_page';
  if (/canonical/.test(k)) return 'canonical_change';
  if (/robots|noindex|nofollow/.test(k)) return 'robots_change';
  if (/analytics|tracking|ga4|gtm|measurement/.test(k)) return 'analytics_change';
  if (/title|meta/.test(k)) return 'title_meta_change';
  if (/new_page|publish|create_page/.test(k)) return 'publish_content';
  return 'update_page';
}

/** Experiment type from a recommendation action type. */
export function experimentTypeFor(actionType: string | null | undefined): 'title_meta' | 'content_section' | 'internal_links' | 'technical' | 'new_page' | 'other' {
  const k = (actionType ?? '').toLowerCase();
  if (/new_page|create_page|publish/.test(k)) return 'new_page';
  if (/title|meta/.test(k)) return 'title_meta';
  if (/internal_link|internal-link|links/.test(k)) return 'internal_links';
  if (/technical|canonical|robots|redirect|schema|performance|speed/.test(k)) return 'technical';
  if (/section|content|rewrite|expand|faq/.test(k)) return 'content_section';
  return 'other';
}

/**
 * Drop null/undefined/empty-string/empty-array fields and trim strings so that
 * semantically identical changes hash identically. Nested objects are kept
 * as-is (hashObject sorts keys).
 */
export function canonicalChange(change: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(change)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) out[k] = t;
      continue;
    }
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out[k] = v;
  }
  return out;
}
