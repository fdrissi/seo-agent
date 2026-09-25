# DataForSEO fixtures (SYNTHETIC)

Every file here is synthetic test data shaped like DataForSEO API v3 responses
as documented in `docs/integration-contracts.md` section 6 (retrieved
2026-09-24). None of it is a real API response, real SERP, real search volume,
or a real account. Domains use reserved names (`*.example`, `*.test`).
Location codes (999000x) are synthetic and deliberately not real provider codes.

Placeholders (`__TASK_ID__`, `__KEYWORD__`, `__TAG__`) are filled in by the
fake DataForSEO transport in `tests/integration/dataforseo/fake-dataforseo.ts`.
