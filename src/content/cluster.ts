import type { AppContext } from '../app/context.js';
import type { LlmClient } from '../integrations/llm/types.js';
import { assignSignals, getClusterMetadata, getItem, insertCluster, insertItem, updateClusterMetadata, updateItem } from './store.js';
import { cosine, isQuestion, jaccard, lexicalSimilarity, normalizeText, truncate } from './text.js';
import type { Candidate, Classification, ClusterOutput, ClusterResult, Intent } from './types.js';

/**
 * CLUSTER: group candidates by intent plus lexical similarity, optional
 * semantic similarity (embeddings, only when explicitly enabled and budgeted
 * through the LLM client), and SERP overlap when non-sandbox snapshots exist.
 *
 * Average-linkage agglomerative clustering avoids chaining. Clusters never
 * merge incompatible intents, and two existing content items are never merged
 * automatically. Thresholds are heuristics: a similarity score is not proof
 * of cannibalization or that one page satisfies every member.
 */

export const CLUSTER_METHOD_VERSION = 'content-cluster@1';

export interface ClusterOptions {
  /** Link threshold on the combined similarity (default 0.45). */
  threshold?: number;
  /** SERP URL-overlap Jaccard that links two queries on its own (default 0.4). */
  serpThreshold?: number;
  /** Try embeddings (costs money; requires features.embeddings and an embedding model). Default false. */
  semantic?: boolean;
  /** Cosine value treated as "unrelated" floor when rescaling embedding similarity (model-dependent; default 0.6). */
  semanticFloor?: number;
  /** Skip persistence (preview). */
  preview?: boolean;
}

interface Node {
  cand: Candidate;
  intent: Intent;
}

function intentsCompatible(a: Intent, b: Intent): boolean {
  if (a === 'navigational' || b === 'navigational') return a === b;
  if (a === b) return true;
  return a === 'unsure' || b === 'unsure' || a === 'mixed' || b === 'mixed';
}

export function serpUrlSets(ctx: AppContext, texts: string[]): Map<string, Set<string>> {
  const wanted = new Set(texts.map(normalizeText));
  const snaps = ctx.db.all<{ id: string; query: string }>(`SELECT id, query FROM serp_snapshots WHERE site_id = ? AND is_sandbox = 0 ORDER BY collected_at DESC`, [ctx.siteId]);
  const out = new Map<string, Set<string>>();
  for (const s of snaps) {
    const key = normalizeText(s.query);
    if (!wanted.has(key) || out.has(key)) continue;
    const urls = ctx.db.all<{ url: string | null }>(
      `SELECT url FROM serp_results WHERE site_id = ? AND snapshot_id = ? AND result_type = 'organic' AND url IS NOT NULL AND (rank_group IS NULL OR rank_group <= 10)`,
      [ctx.siteId, s.id],
    );
    if (urls.length) out.set(key, new Set(urls.map((u) => u.url!)));
  }
  return out;
}

export interface PairSimilarity {
  combined: number;
  lexical: number;
  semantic: number | null;
  serp: number | null;
}

export function pairSimilarity(
  a: string,
  b: string,
  extras: { embA?: Float32Array; embB?: Float32Array; serpA?: Set<string>; serpB?: Set<string>; semanticFloor?: number; serpThreshold?: number; threshold?: number } = {},
): PairSimilarity {
  const lexical = lexicalSimilarity(a, b);
  let semantic: number | null = null;
  if (extras.embA && extras.embB) {
    const floor = extras.semanticFloor ?? 0.6;
    semantic = Math.max(0, Math.min(1, (cosine(extras.embA, extras.embB) - floor) / (1 - floor)));
  }
  let serp: number | null = null;
  if (extras.serpA && extras.serpB) serp = jaccard(extras.serpA, extras.serpB);
  const parts: Array<[number, number]> = [[lexical, 0.5]];
  if (semantic !== null) parts.push([semantic, 0.3]);
  if (serp !== null) parts.push([serp, 0.2]);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  let combined = parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;
  // Strong SERP overlap alone indicates one page can serve both queries.
  const threshold = extras.threshold ?? 0.45;
  if (serp !== null && serp >= (extras.serpThreshold ?? 0.4)) combined = Math.max(combined, threshold + 0.05);
  // Semantic-only evidence without lexical support is capped below the threshold unless strong.
  return { combined: Math.min(1, combined), lexical, semantic, serp };
}

/** Pure clustering over nodes; returns groups of node indexes plus link explanations. */
export function agglomerate(
  nodes: Array<{ text: string; intent: Intent; existingItemId: string | null }>,
  sim: (i: number, j: number) => PairSimilarity,
  threshold: number,
): { groups: number[][]; links: Array<{ i: number; j: number; s: PairSimilarity }> } {
  const n = nodes.length;
  const pair: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const detail = new Map<string, PairSimilarity>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = intentsCompatible(nodes[i]!.intent, nodes[j]!.intent) ? sim(i, j) : { combined: 0, lexical: 0, semantic: null, serp: null };
      pair[i]![j] = s.combined;
      pair[j]![i] = s.combined;
      if (s.combined >= threshold) detail.set(`${i}:${j}`, s);
    }
  }
  // clusters as arrays of node indexes; cluster-level similarity via average linkage
  let clusters: Array<{ members: number[]; intent: Intent; existing: string | null }> = nodes.map((nd, i) => ({ members: [i], intent: nd.intent, existing: nd.existingItemId }));
  const avg = (a: number[], b: number[]): number => {
    let s = 0;
    for (const x of a) for (const y of b) s += pair[x]![y]!;
    return s / (a.length * b.length);
  };
  const maxIter = n;
  for (let iter = 0; iter < maxIter; iter++) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ci = clusters[i]!;
        const cj = clusters[j]!;
        if (ci.existing && cj.existing && ci.existing !== cj.existing) continue;
        if (!intentsCompatible(ci.intent, cj.intent)) continue;
        const s = avg(ci.members, cj.members);
        if (s > best) {
          best = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (best < threshold || bi < 0) break;
    const a = clusters[bi]!;
    const b = clusters[bj]!;
    const mergedIntent: Intent = a.intent === 'unsure' || a.intent === 'mixed' ? b.intent : a.intent;
    const merged = { members: [...a.members, ...b.members], intent: mergedIntent, existing: a.existing ?? b.existing };
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push(merged);
  }
  const links: Array<{ i: number; j: number; s: PairSimilarity }> = [];
  for (const c of clusters) {
    for (const i of c.members) for (const j of c.members) if (i < j && detail.has(`${i}:${j}`)) links.push({ i, j, s: detail.get(`${i}:${j}`)! });
  }
  return { groups: clusters.map((c) => c.members.sort((x, y) => x - y)), links };
}

function clusterIntent(intents: Intent[]): Intent {
  const counts = new Map<Intent, number>();
  for (const i of intents) if (i !== 'unsure' && i !== 'mixed') counts.set(i, (counts.get(i) ?? 0) + 1);
  if (!counts.size) return intents.includes('mixed') ? 'mixed' : 'unsure';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0]![1] === sorted[1]![1]) return 'mixed';
  return sorted[0]![0];
}

export async function clusterCandidates(ctx: AppContext, llm: LlmClient | null, candidates: Candidate[], classifications: Classification[], opts: ClusterOptions = {}): Promise<ClusterOutput> {
  const threshold = opts.threshold ?? 0.45;
  const serpThreshold = opts.serpThreshold ?? 0.4;
  const byKey = new Map(classifications.map((c) => [c.key, c]));
  const nodes: Node[] = candidates.map((c) => ({ cand: c, intent: byKey.get(c.key)?.intent ?? 'unsure' }));

  // Optional semantic similarity.
  let embeddings: Float32Array[] | null = null;
  let semanticStatus = 'not requested';
  if (opts.semantic) {
    if (!llm) semanticStatus = 'unavailable: LLM client not wired';
    else if (!ctx.settings.features.embeddings) semanticStatus = 'disabled: features.embeddings is false';
    else if (!llm.isConfigured('embedding')) semanticStatus = 'not_configured: set EMBEDDING_MODEL';
    else if (ctx.dryRun || opts.preview) semanticStatus = 'skipped: dry run';
    else if (nodes.length > 0) {
      const res = await llm.embed({ siteId: ctx.siteId, runId: ctx.runId, texts: nodes.map((n) => n.cand.text) });
      if (res.ok && res.vectors.length === nodes.length) {
        embeddings = res.vectors;
        semanticStatus = `used (${res.model}, ${res.dimensions} dims)`;
      } else semanticStatus = res.ok ? 'failed: vector count mismatch' : `${res.status}: ${res.reason}`;
    }
  }

  const serp = serpUrlSets(ctx, nodes.map((n) => n.cand.text));
  const serpOverlapStatus = serp.size ? `used for ${serp.size} quer${serp.size === 1 ? 'y' : 'ies'} with non-sandbox SERP snapshots` : 'no non-sandbox SERP snapshots for these queries';

  const simCache = (i: number, j: number) =>
    pairSimilarity(nodes[i]!.cand.text, nodes[j]!.cand.text, {
      ...(embeddings ? { embA: embeddings[i]!, embB: embeddings[j]! } : {}),
      ...(serp.get(normalizeText(nodes[i]!.cand.text)) && serp.get(normalizeText(nodes[j]!.cand.text))
        ? { serpA: serp.get(normalizeText(nodes[i]!.cand.text))!, serpB: serp.get(normalizeText(nodes[j]!.cand.text))! }
        : {}),
      semanticFloor: opts.semanticFloor ?? 0.6,
      serpThreshold,
      threshold,
    });

  const { groups, links } = agglomerate(
    nodes.map((n) => ({ text: n.cand.text, intent: n.intent, existingItemId: n.cand.existingItemId })),
    simCache,
    threshold,
  );

  const methods = ['lexical', ...(embeddings ? ['embedding'] : []), ...(serp.size ? ['serp_overlap'] : [])];
  const uncertainty = `Clusters use heuristic thresholds (combined similarity >= ${threshold}; SERP URL overlap >= ${serpThreshold} when snapshots exist). A similarity score is not proof that pages would compete (cannibalization) or that one page can satisfy every member; review the member list before briefing.`;

  const now = ctx.clock.now().toISOString();
  const results: ClusterResult[] = [];
  let newItems = 0;
  let attached = 0;
  const persist = () => {
    for (const g of groups) {
      const members = g.map((i) => nodes[i]!);
      const intent = clusterIntent(members.map((m) => m.intent));
      const signalIds = [...new Set(members.flatMap((m) => m.cand.signalIds))];
      const rep = [...members].sort((a, b) => {
        const qa = isQuestion(a.cand.text) ? 0 : 1;
        const qb = isQuestion(b.cand.text) ? 0 : 1;
        return qa - qb || b.cand.signalIds.length - a.cand.signalIds.length || a.cand.text.length - b.cand.text.length;
      })[0]!;
      const label = truncate(rep.cand.text, 120);
      const explanation: string[] = [];
      for (const l of links.filter((x) => g.includes(x.i) && g.includes(x.j)).slice(0, 12)) {
        const parts = [`lexical ${l.s.lexical.toFixed(2)}`];
        if (l.s.semantic !== null) parts.push(`semantic ${l.s.semantic.toFixed(2)}`);
        if (l.s.serp !== null) parts.push(`SERP overlap ${l.s.serp.toFixed(2)}`);
        explanation.push(`"${truncate(nodes[l.i]!.cand.text, 60)}" ~ "${truncate(nodes[l.j]!.cand.text, 60)}": ${parts.join(', ')}`);
      }
      if (g.length === 1) explanation.push('Single-member cluster: no other candidate met the similarity threshold with a compatible intent.');
      const existingItemId = members.map((m) => m.cand.existingItemId).find((x) => !!x) ?? null;
      const metadata = {
        members: members.map((m) => ({ key: m.cand.key, text: m.cand.text, intent: m.intent, signalIds: m.cand.signalIds, origins: m.cand.origins })),
        methods,
        threshold,
        serpThreshold,
        explanation,
        uncertainty,
        version: CLUSTER_METHOD_VERSION,
      };
      let itemId: string;
      let clusterId: string;
      if (existingItemId) {
        const item = getItem(ctx.db, ctx.siteId, existingItemId);
        if (item?.clusterId) {
          clusterId = item.clusterId;
          const prev = getClusterMetadata(ctx.db, ctx.siteId, clusterId) ?? {};
          updateClusterMetadata(ctx.db, ctx.siteId, clusterId, { ...prev, ...metadata });
        } else {
          clusterId = insertCluster(ctx.db, ctx.siteId, { label, intent, method: methods.join('+'), methodVersion: CLUSTER_METHOD_VERSION, metadata, now });
          updateItem(ctx.db, ctx.siteId, existingItemId, { clusterId }, now);
        }
        itemId = existingItemId;
        if (item && (item.intent === null || item.intent === 'unsure')) updateItem(ctx.db, ctx.siteId, itemId, { intent }, now);
        attached++;
      } else {
        clusterId = insertCluster(ctx.db, ctx.siteId, { label, intent, method: methods.join('+'), methodVersion: CLUSTER_METHOD_VERSION, metadata, now });
        itemId = insertItem(ctx.db, {
          siteId: ctx.siteId,
          title: label,
          primaryQuestion: members.some((m) => isQuestion(m.cand.text)) ? rep.cand.text : null,
          stage: 'clustered',
          intent,
          clusterId,
          isSynthetic: members.some((m) => m.cand.isSynthetic),
          now,
        });
        newItems++;
      }
      assignSignals(ctx.db, ctx.siteId, signalIds, itemId);
      results.push({
        clusterId,
        itemId,
        label,
        intent,
        memberKeys: members.map((m) => m.cand.key),
        memberTexts: members.map((m) => m.cand.text),
        signalIds,
        methods,
        explanation,
        uncertainty,
        attachedToExisting: !!existingItemId,
      });
    }
  };
  if (opts.preview) {
    for (const g of groups) {
      const members = g.map((i) => nodes[i]!);
      results.push({
        clusterId: 'preview',
        itemId: 'preview',
        label: truncate(members[0]!.cand.text, 120),
        intent: clusterIntent(members.map((m) => m.intent)),
        memberKeys: members.map((m) => m.cand.key),
        memberTexts: members.map((m) => m.cand.text),
        signalIds: members.flatMap((m) => m.cand.signalIds),
        methods,
        explanation: [],
        uncertainty,
        attachedToExisting: members.some((m) => !!m.cand.existingItemId),
      });
    }
  } else ctx.db.transaction(persist);

  return {
    clusters: results,
    itemIds: [...new Set(results.map((r) => r.itemId))],
    newItems,
    attachedToExisting: attached,
    method: `${methods.join('+')} (${CLUSTER_METHOD_VERSION}, average linkage)`,
    threshold,
    semanticStatus,
    serpOverlapStatus,
  };
}
