## Summary

<!-- What does this change do and why? Link the issue if there is one. -->

## Checklist

- [ ] No secrets, tokens, credentials, OAuth/service-account files, or `.env` files are included (`npm run security:scan` is clean).
- [ ] No real data: fixtures are synthetic, clearly labeled, and use `example.com`, `*.test`, or `*.invalid`. No real site config, vault notes, analytics, raw responses, or scraped third-party datasets.
- [ ] No owner-specific domains, event names, locations, languages, budgets, prices, or model IDs are hardcoded in application logic.
- [ ] Tests added or updated; `npm run typecheck` and `npm test` pass offline (no network, no credentials).
- [ ] Missing credentials, disabled features, and failures produce honest statuses (no fabricated success; unknown cost is `null`, never 0).
- [ ] Documentation updated (module docs, `docs/DATA_FLOWS.md` if data sent externally changes, `docs/COSTS.md` if paid usage changes, `CHANGELOG.md`).
- [ ] Schema changes are a new forward-only migration (applied migrations are never edited).

## Sensitive areas (require focused code-owner review)

Tick every area this PR touches and explain the impact below.

- [ ] `.github/workflows` / CI configuration
- [ ] Authentication (`src/auth`) or secret handling (`src/config/secrets.ts`, `src/security`)
- [ ] Approvals, publishing, export, or mark-implemented (`src/approvals`, publisher/export code)
- [ ] Budget enforcement or paid provider calls (`src/budgets`, provider adapters)
- [ ] Release tooling, packaging, container build (`scripts/`, `package.json`, `Dockerfile`, `.dockerignore`, `.gitignore`)
- [ ] Dependencies added or upgraded (explain why; license checked with `npm run licenses:check`)

### Impact on sensitive areas

<!-- Required if any box above is ticked: what could go wrong, and how is it prevented/tested? -->
