# ADR 0003: Store money as integer micro-USD; unknown cost is `null`, never 0

- Status: Accepted
- Date: 2026-09-24

## Context

Budgets are enforced by comparing reservations against ceilings, often with
sub-cent prices (for example $0.0006 per SERP page, or catalog prices per
token such as `0.15e-6`). Floating-point sums drift, and a comparison that is
off by one ulp can let a request through or deny a valid one. The spec also
requires that missing usage is never turned into $0 and that source-reported
revenue currencies stay separate from USD API costs.

## Decision

- API costs, budgets, reservations, and ledger entries are integers in
  micro-USD (1 USD = 1,000,000 micros), `Micros` in `src/core/money.ts`.
- Decimal inputs (config values, provider prices) are parsed with string
  arithmetic (`toMicros`), rounded half-up at the sixth fractional digit.
  Config amounts are kept as exact decimal strings.
- Per-unit prices below one micro are held per million units and multiplied
  with a ceiling (`costPerMillionCeil`), so upper bounds round up.
- Arithmetic helpers assert safe integers.
- Unknown cost is `null` at every boundary, with an explicit status
  (`cost_status` `unknown`, reservations `unresolved`). Reports print
  "unknown", never $0.
- Revenue keeps its source currency (`revenue_currency`) and is never mixed
  with USD costs.

## Consequences

- Budget checks are exact and reproducible; parallel reservations compare
  integers inside one transaction.
- Every adapter must convert provider numbers at its edge and decide
  explicitly what is unknown.
- Very large amounts are limited to the safe-integer range (about $9 billion),
  far above any sane budget; config validation also has a sanity ceiling.

## Alternatives considered

- Floating-point dollars: simple, but inexact comparisons.
- A decimal library: exact, but another dependency (ADR 0010) for a narrow
  need that integer micros cover.
- Cents: too coarse for per-request LLM and SERP prices.

## References

- `src/core/money.ts`, `src/budgets/budget-service.ts`
- `tests/unit/core/money.test.ts`, `tests/unit/budgets/budget-service.test.ts`, `tests/integration/budgets/parallel-reservations.test.ts`
- `docs/COSTS.md`, `docs/CONFIGURATION.md` (Budgets)
