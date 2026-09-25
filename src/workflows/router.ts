import { toErrorInfo, type ErrorInfo } from './errors.js';
import { runBoundedParallel } from './parallel.js';

/**
 * ROUTER pattern (spec section 4): deterministic rules route the obvious
 * cases; a low-cost model hook is consulted ONLY for genuinely ambiguous
 * items. The concrete SEO routing rules live in src/router; this is the
 * generic mechanism.
 *
 * Rules are evaluated in order. The first matching *decisive* rule wins.
 * Non-decisive rules are hints: they narrow the candidate routes that the
 * ambiguous classifier may choose from. When nothing decisive matches:
 *   - with an `ambiguousClassifier`, it is called with the candidates and its
 *     answer is accepted only if it names an allowed route;
 *   - otherwise (or when the classifier fails / answers outside the allowed
 *     set) the item gets the explicit `unsureRoute`. Nothing is guessed.
 */

export interface RouteRule<T, R extends string> {
  id: string;
  description?: string;
  when: (item: T) => boolean;
  route: R;
  /** Stable machine-readable reason, e.g. 'TECHNICAL_BLOCKER_NOINDEX'. */
  reasonCode: string;
  /** Default true. Non-decisive rules only contribute candidate routes. */
  decisive?: boolean;
}

export interface ClassifierAnswer<R extends string> {
  route: R;
  confidence?: number;
  rationale?: string;
}

export type AmbiguousClassifier<T, R extends string> = (item: T, candidates: R[]) => Promise<ClassifierAnswer<R>>;

export interface RouteOptions<T, R extends string> {
  /** Route used when rules are inconclusive and no valid classifier answer exists. */
  unsureRoute: R;
  /** Cheap-model hook, called only for ambiguous items. */
  ambiguousClassifier?: AmbiguousClassifier<T, R>;
  /** Every route the classifier may return; defaults to the rule routes plus unsureRoute. */
  allowedRoutes?: readonly R[];
  /** Minimum classifier confidence to accept (when the classifier reports one). */
  minConfidence?: number;
}

export interface RouteDecision<R extends string> {
  route: R;
  source: 'rule' | 'classifier' | 'unsure';
  ruleId?: string;
  reasonCodes: string[];
  /** Candidate routes suggested by non-decisive rules (empty when none matched). */
  candidates: R[];
  classifier?: { called: boolean; answer?: ClassifierAnswer<R>; rejected?: string; error?: ErrorInfo };
}

export async function routeWith<T, R extends string>(rules: readonly RouteRule<T, R>[], item: T, opts: RouteOptions<T, R>): Promise<RouteDecision<R>> {
  const matched: RouteRule<T, R>[] = [];
  for (const rule of rules) {
    let hit = false;
    try {
      hit = rule.when(item);
    } catch {
      hit = false; // a crashing rule never routes; the item falls through to ambiguity handling
    }
    if (!hit) continue;
    if (rule.decisive !== false) {
      return { route: rule.route, source: 'rule', ruleId: rule.id, reasonCodes: [rule.reasonCode], candidates: [] };
    }
    matched.push(rule);
  }
  const candidates = [...new Set(matched.map((r) => r.route))];
  const reasonCodes = matched.map((r) => r.reasonCode);
  if (!opts.ambiguousClassifier) {
    return { route: opts.unsureRoute, source: 'unsure', reasonCodes: [...reasonCodes, 'NO_DECISIVE_RULE'], candidates };
  }
  const allowed = new Set<R>(opts.allowedRoutes ?? [...rules.map((r) => r.route), opts.unsureRoute]);
  const permitted = candidates.length ? new Set<R>([...candidates, opts.unsureRoute]) : allowed;
  try {
    const answer = await opts.ambiguousClassifier(item, candidates.length ? candidates : [...allowed]);
    let rejected: string | undefined;
    if (!answer || typeof answer.route !== 'string' || !allowed.has(answer.route)) rejected = `classifier returned a route outside the allowed set (${String(answer?.route)})`;
    else if (!permitted.has(answer.route)) rejected = `classifier route ${answer.route} contradicts rule candidates (${candidates.join(', ')})`;
    else if (opts.minConfidence !== undefined && answer.confidence !== undefined && answer.confidence < opts.minConfidence) {
      rejected = `classifier confidence ${answer.confidence} below minimum ${opts.minConfidence}`;
    }
    if (rejected) {
      return { route: opts.unsureRoute, source: 'unsure', reasonCodes: [...reasonCodes, 'CLASSIFIER_REJECTED'], candidates, classifier: { called: true, answer, rejected } };
    }
    return { route: answer.route, source: 'classifier', reasonCodes: [...reasonCodes, 'AMBIGUOUS_CLASSIFIED'], candidates, classifier: { called: true, answer } };
  } catch (err) {
    return { route: opts.unsureRoute, source: 'unsure', reasonCodes: [...reasonCodes, 'CLASSIFIER_FAILED'], candidates, classifier: { called: true, error: toErrorInfo(err) } };
  }
}

/**
 * Route many items: rules run synchronously for all items; only ambiguous
 * items reach the classifier, with bounded concurrency (default 3).
 */
export async function routeAll<T, R extends string>(
  rules: readonly RouteRule<T, R>[],
  items: readonly T[],
  opts: RouteOptions<T, R> & { workers?: number; signal?: AbortSignal },
): Promise<Array<RouteDecision<R>>> {
  const r = await runBoundedParallel(items, opts.workers ?? 3, (item) => routeWith(rules, item, opts), opts.signal ? { signal: opts.signal } : {});
  return r.results.map((res) =>
    res.ok ? res.value : { route: opts.unsureRoute, source: 'unsure' as const, reasonCodes: ['ROUTING_FAILED'], candidates: [], classifier: { called: false, error: toErrorInfo(res.error) } },
  );
}
