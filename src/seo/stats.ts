/**
 * Small, documented statistics helpers. These are screening aids for
 * routing and prioritization, not significance tests of experiments.
 */

/**
 * Wilson score interval for a proportion (default 95%, z = 1.96).
 * Works with fractional successes (e.g. converting sessions derived from a
 * reported session rate). Returns null when n <= 0.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (!(n > 0) || !Number.isFinite(successes)) return null;
  const x = Math.min(Math.max(successes, 0), n);
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

/**
 * Bayesian (Beta prior) smoothing of a rate toward a prior mean:
 *   (successes + priorStrength * priorRate) / (n + priorStrength)
 * With priorStrength = 2 and priorRate = 0.5 this is Laplace's rule of succession.
 */
export function smoothedRate(successes: number, n: number, priorRate: number, priorStrength: number): number {
  const k = Math.max(0, priorStrength);
  if (n + k <= 0) return priorRate;
  return (Math.max(0, successes) + k * priorRate) / (n + k);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** log(1 + x) / log(1 + ref), clamped to 0..1. Diminishing returns for volume-like inputs. */
export function logScale(x: number, ref: number): number {
  if (!(x > 0) || !(ref > 0)) return 0;
  return clamp01(Math.log1p(x) / Math.log1p(ref));
}
