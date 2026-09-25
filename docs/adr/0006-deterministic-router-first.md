# ADR 0006: Deterministic router first; models only for genuine ambiguity

- Status: Accepted
- Date: 2026-09-24

## Context

Most routing decisions (incomplete data, confirmed technical blockers, an
active experiment, a healthy page, a low-data site) follow from measured
facts. Sending them to a language model would cost money, vary between runs,
and be hard to audit. The spec asks for tested, configurable rules with
reason codes, prerequisites routed before optimization, a cheap model only
for genuinely ambiguous cases, and an `unsure` route instead of forced
classification.

## Decision

- `src/router/rules.ts` evaluates the spec section 18 order
  (`DEFAULT_RULE_ORDER`): INVALID_OR_INCOMPLETE_DATA, TECHNICAL_BLOCKER,
  EXPERIMENT_ACTIVE, HEALTHY, RANKING_OPPORTUNITY, CTR_OPPORTUNITY,
  CONVERSION_OPPORTUNITY, DECLINE, CONTENT_OPPORTUNITY,
  INDEXING_UNKNOWN, LOW_DATA, IRRELEVANT, with UNSURE as the explicit
  fallback. Only confirmed technical issues block; suspicions become notes.
- Thresholds come from the site config; each decision stores its reason
  codes, inputs, and a `rules_version` hash of the thresholds and order, so
  decisions are reproducible and explainable.
- Intent is classified by deterministic multilingual rules. Only queries the
  rules cannot decide may go to the cheap model, as untrusted evidence, when
  a model is configured; an "unsure" answer stays ambiguous.
- The generic engine router (`src/workflows/router.ts`) follows the same
  rule: rules first, an optional classifier for ambiguous items only, and the
  unsure route when nothing is decisive. It never guesses.

## Consequences

- Routing runs offline, costs nothing, and is fully tested.
- Rules and thresholds are editorial defaults, not fitted to data; small
  sites often lack CTR/conversion benchmarks, so those routes fire rarely
  there (by design, with a note).
- Owners review UNSURE items instead of receiving a confident wrong answer.
- Segment-level routing is not implemented yet (see FEATURE_STATUS).

## Alternatives considered

- LLM classification of every page: expensive, non-deterministic, and hard
  to test or audit.
- A learned model: no labeled data, and it would hide its reasons.

## References

- `src/router/rules.ts`, `src/router/intent.ts`, `src/router/llm-intent.ts`, `src/workflows/router.ts`
- `tests/unit/router/rules.test.ts`, `tests/unit/router/intent.test.ts`, `tests/unit/router/llm-intent.test.ts`, `tests/unit/workflows/router.test.ts`
- `docs/modules/seo-router.md`
