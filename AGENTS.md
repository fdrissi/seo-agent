# Guidance for coding agents and contributors

Read `docs/ARCHITECTURE.md` first. It defines module boundaries, shared
contracts, and conventions. This file lists the rules that are easy to break.

## Non-negotiables

- Never invent a successful build, test, API response, ranking, conversion, or
  publishing result. A mocked integration is not a live-tested integration.
- Never hardcode owner-specific domains, event names, locations, languages,
  budgets, prices, or model IDs in application logic. They belong in site config.
- Never print, log, commit, or place secrets in the vault. Use the secret store
  (`src/config/secrets.ts`) and redaction (`src/security/redact.ts`).
- Never ask a human to paste secrets into a chat. Point them to the workspace
  secrets file or a password-manager-injected environment variable.
- Real data never enters the repository: site configs, vaults, databases,
  raw responses, reports, logs, and backups belong in the private workspace.
- Paid requests always go through budget reservation and the provider-request
  log; never blindly retry paid POSTs; unknown cost is never $0.
- Production actions (publish, redirect, merge, delete, canonical/robots/analytics
  changes) always require a valid human approval bound to the exact proposal.
  An `approved: true` property in Markdown authorizes nothing.
- Runtime LLM calls never get shell access, unrestricted SQL, secrets, or the
  ability to edit policies. Tools are allowlisted and typed.
- Do not create a public repository, push, publish packages, or change
  repository visibility without the owner's explicit approval.

## Workflow

- `npm run typecheck` and `npm test` must pass before a change is considered done.
- Tests are offline: the global `fetch` throws in tests. Inject `FetchLike` fakes.
- Add a migration file for schema changes; never edit an applied migration.
- Add CLI commands as a module in `src/cli/commands/<area>.ts` exporting
  `register(program, cli)`; the CLI discovers modules automatically.
- Label synthetic fixtures clearly and use reserved example domains.
- Keep numerical calculations in code, not in model prompts.
- Changes touching `.github/workflows`, `src/auth`, `src/approvals`,
  publishing/export, or `src/budgets` need focused human review.
