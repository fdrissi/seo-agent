import { describe, expect, it } from 'vitest';
import { RRF_K, buildFtsQuery, reciprocalRankFusion, type RankedList } from '../../../src/memory/retrieval.js';

const list = (name: RankedList['name'], ids: string[], weight = 1): RankedList => ({ name, weight, ids, raw: new Map(ids.map((id, i) => [id, i])) });

describe('Reciprocal Rank Fusion', () => {
  it('uses k = 60 and sums w/(k + rank) across lists', () => {
    expect(RRF_K).toBe(60);
    const fused = reciprocalRankFusion([list('fts', ['a', 'b', 'c']), list('vector', ['b', 'd'])]);
    expect(fused.get('a')!.fused).toBeCloseTo(1 / 61, 12);
    expect(fused.get('b')!.fused).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused.get('c')!.fused).toBeCloseTo(1 / 63, 12);
    expect(fused.get('d')!.fused).toBeCloseTo(1 / 62, 12);
    expect(fused.get('b')!.ranks).toEqual({ fts: 2, vector: 1 });
    // Found by both methods beats found by one method at rank 1.
    const order = [...fused.entries()].sort((x, y) => y[1].fused - x[1].fused).map(([id]) => id);
    expect(order).toEqual(['b', 'a', 'd', 'c']);
  });

  it('applies per-list weights and ignores duplicate ids within one list', () => {
    const fused = reciprocalRankFusion([list('fts', ['a']), list('link', ['a', 'a', 'z'], 0.5)], 10);
    expect(fused.get('a')!.fused).toBeCloseTo(1 / 11 + 0.5 / 11, 12);
    expect(fused.get('a')!.ranks.link).toBe(1);
    expect(fused.get('z')!.fused).toBeCloseTo(0.5 / 13, 12);
  });

  it('returns an empty map for empty lists', () => {
    expect(reciprocalRankFusion([list('fts', []), list('vector', [])]).size).toBe(0);
  });
});

describe('FTS5 query escaping', () => {
  it('quotes every term and ORs them, neutralizing FTS syntax', () => {
    expect(buildFtsQuery('price list')).toBe('"price"* OR "list"*');
    const q = buildFtsQuery('text: NEAR(a b) AND "drop" OR col:*  -x ^y')!;
    expect(q).not.toMatch(/(^|\s)(AND|NEAR)(\s|$)/);
    expect(q.split(' OR ').every((t) => /^"[^"]+"\*?$/.test(t))).toBe(true);
    expect(buildFtsQuery('!!! ??')).toBeNull();
    expect(buildFtsQuery('送料 無料')).toBe('"送料" OR "無料"');
  });
});
