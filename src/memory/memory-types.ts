import type { TrustClass } from '../core/modes.js';
import type { MemorySourceType, RetrievalQuery } from './types.js';

/** Extensions of the shared memory contract (src/memory/types.ts) used inside the memory slice. */

export type DocumentStatus = 'active' | 'superseded' | 'rejected' | 'deleted';
export type AccessScope = 'site' | 'owner_only';

export const MEMORY_SOURCE_TYPES: readonly MemorySourceType[] = [
  'business_note',
  'source_excerpt',
  'competitor_finding',
  'brief',
  'experiment_summary',
  'rejected_proposal',
  'approved_learning',
  'decision',
  'report_summary',
  'fixture',
];

export interface MemorySearchQuery extends RetrievalQuery {
  /**
   * Access scopes allowed for this retrieval, applied as a filter BEFORE
   * retrieval. Default ['site']: owner-only material is never returned unless
   * the caller (e.g. the owner's CLI) asks for it explicitly.
   */
  accessScopes?: AccessScope[];
}

export interface MemoryDocumentRow {
  id: string;
  site_id: string;
  source_type: MemorySourceType;
  source_ref: string;
  source_url: string | null;
  title: string;
  language: string;
  trust_class: TrustClass;
  status: DocumentStatus;
  record_status: string | null;
  access_scope: AccessScope;
  version: number;
  content_hash: string;
  source_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryChunkRow {
  id: string;
  document_id: string;
  site_id: string;
  chunk_index: number;
  heading_path: string;
  text: string;
  token_estimate: number;
  content_hash: string;
  chunker_version: string;
  language: string;
  document_version: number;
  superseded: number;
  created_at: string;
}

export interface EmbeddingVersionRow {
  id: string;
  provider: string;
  model_id: string;
  dimensions: number;
  chunker_version: string;
  collection_name: string;
  status: 'active' | 'retired';
  created_at: string;
  /**
   * Model id the provider reported for the batch that created this version
   * (migration 0221). Later batches must report the same id. Null/absent:
   * unknown (legacy row, or a response that did not name its model).
   */
  returned_model_id?: string | null;
}
