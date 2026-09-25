# ADR 0002: Keep all real data in a private workspace outside the repository

- Status: Accepted
- Date: 2026-09-24

## Context

The application is published as open source and also used by its owner on
real websites. Site configs, credentials, vault notes, analytics, databases,
Qdrant storage, crawls, drafts, reports, logs, and backups must never reach a
public repository or a release artifact, and upgrades must never overwrite
them. The spec's preamble overrides earlier instructions that placed runtime
data inside the repository.

## Decision

One public application, one private workspace per installation:

- Workspace location: `--workspace` > `SEO_AGENT_WORKSPACE` >
  `~/seo-agent-workspace`. Every path (config, secrets, vault, database, raw
  responses, cache, Qdrant storage, reports, exports, logs, backups,
  diagnostics) is derived from the root at runtime (`src/config/paths.ts`).
- `init` creates the layout with 0700 directories and 0600 secret files,
  never overwrites or follows symlinks, refuses a location inside the
  application repository (unless explicitly allowed), refuses a workspace
  written by a newer application, and keeps demo and live workspaces apart
  (`workspace.json` `kind`).
- The workspace contains its own `.gitignore` (`*`). The repository
  `.gitignore`, the `package.json` `files` allowlist, and `.dockerignore`
  keep private files out of Git, npm packages, and container images; the
  release check verifies them.
- The demo uses its own isolated demo workspace.

## Consequences

- The owner uses the same installation path as everyone else, with a private
  configuration instead of a fork.
- Upgrades replace only application files; data changes only through
  forward-only migrations with a verified pre-migration backup.
- Moving a workspace is copying a directory; report records store
  workspace-relative paths.
- Users must back up the workspace themselves (`backup`, plus a password
  manager for `secrets/`).

## Alternatives considered

- Data folders inside the repository with `.gitignore` rules: one wrong rule
  or `git add -f` publishes private data; rejected by the spec.
- A per-user database in an OS application-data folder only: hides the vault
  from the user and splits related files across locations.

## References

- `src/config/workspace.ts`, `src/config/paths.ts`, `src/demo/workspace.ts`
- `tests/unit/config/workspace.test.ts`, `tests/e2e/new-user.test.ts`, `tests/unit/security/release-rules.test.ts`
- `docs/WORKSPACE.md`, `docs/UPGRADING.md`
