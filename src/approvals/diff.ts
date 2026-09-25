/**
 * Line-based unified diff (LCS) for "diff vs current" in export packages.
 * Common prefix/suffix are trimmed first; if the remaining problem is too
 * large for an exact LCS table, the changed block is shown as a whole
 * replacement (still correct, just less granular), and that is stated.
 */

export interface DiffResult {
  unified: string;
  added: number;
  removed: number;
  unchanged: number;
  exact: boolean;
}

const MAX_CELLS = 4_000_000;

type Op = { kind: ' ' | '+' | '-'; line: string };

function lcsOps(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! });
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) ops.push({ kind: '-', line: a[i++]! });
    else ops.push({ kind: '+', line: b[j++]! });
  }
  while (i < n) ops.push({ kind: '-', line: a[i++]! });
  while (j < m) ops.push({ kind: '+', line: b[j++]! });
  return ops;
}

export function unifiedDiff(current: string, proposed: string, opts: { fromLabel?: string; toLabel?: string; context?: number } = {}): DiffResult {
  const a = current.replace(/\r\n?/g, '\n').split('\n');
  const b = proposed.replace(/\r\n?/g, '\n').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  let exact = true;
  let midOps = lcsOps(midA, midB);
  if (!midOps) {
    exact = false;
    midOps = [...midA.map((line) => ({ kind: '-' as const, line })), ...midB.map((line) => ({ kind: '+' as const, line }))];
  }
  const ops: Op[] = [...a.slice(0, pre).map((line) => ({ kind: ' ' as const, line })), ...midOps, ...a.slice(a.length - suf).map((line) => ({ kind: ' ' as const, line }))];

  const ctx = opts.context ?? 3;
  const lines: string[] = [`--- ${opts.fromLabel ?? 'current'}`, `+++ ${opts.toLabel ?? 'proposed'}`];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const o of ops) {
    if (o.kind === '+') added++;
    else if (o.kind === '-') removed++;
    else unchanged++;
  }
  // Group into hunks with context.
  const changedIdx = ops.map((o, idx) => (o.kind === ' ' ? -1 : idx)).filter((x) => x >= 0);
  if (!changedIdx.length) return { unified: `${lines.join('\n')}\n(no differences)\n`, added, removed, unchanged, exact };
  let start = Math.max(0, changedIdx[0]! - ctx);
  let end = Math.min(ops.length - 1, changedIdx[0]! + ctx);
  const hunks: Array<[number, number]> = [];
  for (const idx of changedIdx.slice(1)) {
    if (idx - ctx <= end + 1) end = Math.min(ops.length - 1, idx + ctx);
    else {
      hunks.push([start, end]);
      start = Math.max(0, idx - ctx);
      end = Math.min(ops.length - 1, idx + ctx);
    }
  }
  hunks.push([start, end]);
  for (const [s, e] of hunks) {
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < s; k++) {
      if (ops[k]!.kind !== '+') aLine++;
      if (ops[k]!.kind !== '-') bLine++;
    }
    const slice = ops.slice(s, e + 1);
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    lines.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (const o of slice) lines.push(`${o.kind}${o.line}`);
  }
  if (!exact) lines.push('# note: input too large for a line-level diff; the changed block is shown as a full replacement');
  return { unified: `${lines.join('\n')}\n`, added, removed, unchanged, exact };
}
