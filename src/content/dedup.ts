import { isQuestion, jaccard, normalizedTextHash, tokenSet } from './text.js';
import type { Candidate, ContentSignal, DedupeOutput, SignalOrigin } from './types.js';

/**
 * DEDUPLICATE: exact duplicates share a normalized-text hash (across
 * origins); near-duplicates are merged when their content-token sets are
 * nearly identical (Jaccard >= threshold, both with >= 2 tokens, or identical
 * token sets). Merges are recorded with their similarity so they can be
 * audited. Dedup never discards a signal: all signal ids stay on the
 * candidate as supporting examples.
 */

export const DEDUP_METHOD = 'normalized-hash+token-jaccard@1';
export const DEFAULT_NEAR_DUP_THRESHOLD = 0.8;

const ORIGIN_PRIORITY: Record<SignalOrigin, number> = {
  manual: 0,
  gsc_query: 1,
  apify_reddit: 2,
  business_knowledge: 3,
  dataforseo: 4,
  competitor_gap: 5,
  fixture: 6,
};

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

function representative(signals: ContentSignal[]): ContentSignal {
  return [...signals].sort((a, b) => {
    const qa = isQuestion(a.text) ? 0 : 1;
    const qb = isQuestion(b.text) ? 0 : 1;
    if (qa !== qb) return qa - qb;
    const pa = ORIGIN_PRIORITY[a.origin] ?? 9;
    const pb = ORIGIN_PRIORITY[b.origin] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.text.length - b.text.length || a.id.localeCompare(b.id);
  })[0]!;
}

export function dedupeSignals(signals: ContentSignal[], opts: { nearDuplicateThreshold?: number } = {}): DedupeOutput {
  const threshold = opts.nearDuplicateThreshold ?? DEFAULT_NEAR_DUP_THRESHOLD;
  // 1) exact groups by normalized hash
  const byHash = new Map<string, ContentSignal[]>();
  for (const s of signals) {
    // Recompute: other writers may hash text differently; grouping must be consistent across origins.
    const h = normalizedTextHash(s.text);
    const list = byHash.get(h) ?? [];
    list.push(s);
    byHash.set(h, list);
  }
  const groups = [...byHash.values()];
  const exactMerged = signals.length - groups.length;

  // 2) near-duplicate merge on token sets
  const tokens = groups.map((g) => tokenSet(representative(g).text));
  const uf = new UnionFind(groups.length);
  const nearLinks: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const ti = tokens[i]!;
      const tj = tokens[j]!;
      if (ti.size === 0 || tj.size === 0) continue;
      const sim = jaccard(ti, tj);
      const identical = sim === 1;
      if (identical || (sim >= threshold && ti.size >= 2 && tj.size >= 2)) {
        uf.union(i, j);
        nearLinks.push({ a: i, b: j, sim });
      }
    }
  }
  const merged = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const r = uf.find(i);
    const list = merged.get(r) ?? [];
    list.push(i);
    merged.set(r, list);
  }

  const candidates: Candidate[] = [];
  let nearMerged = 0;
  for (const idxs of merged.values()) {
    const all = idxs.flatMap((i) => groups[i]!);
    const rep = representative(all);
    const repGroup = idxs.find((i) => groups[i]!.includes(rep))!;
    const nearDuplicates: Candidate['nearDuplicates'] = [];
    for (const i of idxs) {
      if (i === repGroup) continue;
      const link = nearLinks.find((l) => (l.a === i || l.b === i) && idxs.includes(l.a) && idxs.includes(l.b));
      for (const s of groups[i]!) nearDuplicates.push({ signalId: s.id, similarity: round3(link?.sim ?? jaccard(tokens[i]!, tokens[repGroup]!)), method: 'token_jaccard' });
    }
    nearMerged += idxs.length - 1;
    const itemCounts = new Map<string, number>();
    for (const s of all) if (s.contentItemId) itemCounts.set(s.contentItemId, (itemCounts.get(s.contentItemId) ?? 0) + 1);
    const existingItemId = [...itemCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    candidates.push({
      key: normalizedTextHash(rep.text).slice(0, 16),
      text: rep.text,
      signalIds: all.map((s) => s.id),
      origins: [...new Set(all.map((s) => s.origin))].sort(),
      signalTypes: [...new Set(all.map((s) => s.signalType))].sort(),
      nearDuplicates,
      isSynthetic: all.some((s) => s.isSynthetic),
      existingItemId,
    });
  }
  candidates.sort((a, b) => a.text.localeCompare(b.text));
  return { candidates, exactDuplicatesMerged: exactMerged, nearDuplicatesMerged: nearMerged, method: DEDUP_METHOD };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
