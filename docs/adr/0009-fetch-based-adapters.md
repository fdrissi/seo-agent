# ADR 0009: Fetch-based adapters over vendor SDKs

- Status: Accepted
- Date: 2026-09-24

## Context

The application talks to the LLM Gateway, Search Console, GA4, URL
Inspection, PageSpeed Insights, CrUX, DataForSEO, Apify, and Qdrant. Tests
must be offline (the global `fetch` throws), the demo must make zero network
requests, doctor must prove it made none, and every paid request must go
through budget reservation and the provider-request log. Vendor SDKs bring
their own HTTP stacks, retries (dangerous for paid POSTs), and transitive
dependencies, and are hard to force offline.

## Decision

- Every adapter takes an injected `FetchLike`
  (`src/integrations/types.ts`) from the `AppContext`. Offline and demo
  contexts use `offlineFetch`, which refuses; tests inject fakes
  (`tests/helpers/fake-fetch.ts`).
- Adapters are written against the provider contracts recorded in
  `docs/integration-contracts.md`: LLM Gateway (OpenAI-compatible REST),
  Search Console and GA4 Data API REST, PSI and CrUX REST, DataForSEO v3,
  Apify API v2, Qdrant REST.
- Retries are explicit per adapter: idempotent GETs may back off; paid POSTs
  are never retried and are marked ambiguous on timeouts.
- Two exceptions, by design:
  - `google-auth-library` for OAuth and service accounts, because spec
    section 10 requires the official libraries. Its HTTP calls are routed
    through the injected fetch (`transporterOptions.fetchImplementation`);
    ADC on Google Cloud uses the library's own metadata-server transport.
  - `undici` for the crawler's DNS-pinned transport, so the SSRF guard can
    pin a connection to the validated IP (the built-in fetch cannot).
- MCP servers are not required for any integration.

## Consequences

- One network policy for the whole application: offline mode, network
  counters, and redaction apply everywhere.
- Fewer dependencies (ADR 0010).
- The project maintains request and response parsing itself and must track
  API changes; unverified contract details are listed per provider and
  handled defensively.

## Alternatives considered

- Official or community SDKs per provider: faster to start, but hidden
  retries, larger dependency trees, and harder offline control.
- An MCP-based integration layer: optional in the spec and would add a
  runtime dependency for no functional gain.

## References

- `src/integrations/types.ts`, `src/integrations/*/`, `src/crawler/transport.ts`, `src/security/ssrf.ts`
- `tests/setup.ts`, `tests/helpers/fake-fetch.ts`, `tests/integration/setup/doctor.test.ts` (zero requests)
- `docs/integration-contracts.md`
