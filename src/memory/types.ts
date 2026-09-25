import type { TrustClass } from '../core/modes.js';

/**
 * Hybrid retrieval contract: SQLite FTS5 + Qdrant semantic search + metadata
 * filters + wikilink relationships, fused with a transparent rank-fusion
 * method, returning source-backed excerpts within a fixed context budget.
 * Website filters are applied BEFORE retrieval.
 */

export type MemorySourceType =
  | 'business_note'
  | 'source_excerpt'
  | 'competitor_finding'
  | 'brief'
  | 'experiment_summary'
  | 'rejected_proposal'
  | 'approved_learning'
  | 'decision'
  | 'report_summary'
  | 'fixture';

export interface RetrievalQuery {
  siteId: string;
  text: string;
  sourceTypes?: MemorySourceType[];
  trustClasses?: TrustClass[];
  language?: string;
  /** Superseded/deleted material is excluded unless explicitly requested. */
  includeSuperseded?: boolean;
  limit?: number;
  contextBudgetTokens?: number;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  text: string;
  headingPath: string;
  title: string;
  sourceType: MemorySourceType;
  sourceRef: string;
  sourceUrl: string | null;
  trustClass: TrustClass;
  documentStatus: 'active' | 'superseded' | 'rejected' | 'deleted';
  /** Domain status carried with the chunk, e.g. 'rejected' proposal or 'negative' experiment. */
  recordStatus: string | null;
  sourceDate: string | null;
  language: string;
  /** Per-list raw scores: `trigram` is the dense-script (CJK/Thai) full-text list. */
  scores: { fts?: number; vector?: number; link?: number; trigram?: number; fused: number };
  /** Why this chunk was returned (ranks per method, boosts, penalties). */
  explanation: string[];
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  method: 'hybrid' | 'fts_only';
  degraded: boolean;
  degradedReason?: string;
  /**
   * Why retrieval ran in this mode when that is a deliberate choice, not a
   * fault, e.g. "full-text only by policy" (no implicit query-embedding
   * spend). Not a degraded state.
   */
  detail?: string;
  usedTokens: number;
  budgetTokens: number;
  /** True when relevant chunks were dropped to respect the context budget. */
  truncated: boolean;
}

export interface MemoryRetriever {
  search(q: RetrievalQuery): Promise<RetrievalResult>;
}
