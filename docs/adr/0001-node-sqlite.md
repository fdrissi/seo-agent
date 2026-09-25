# ADR 0001: Use Node's built-in `node:sqlite` instead of native SQLite bindings

- Status: Accepted
- Date: 2026-09-24

## Context

The spec requires SQLite for structured data, migrations, transactions, and
full-text search, on a current supported Node.js LTS with a committed
lockfile. The common choice, a native binding such as `better-sqlite3`,
ships prebuilt binaries or compiles with `node-gyp` at install time. That
means install-time scripts, a C/C++ toolchain on some platforms, and one more
binary artifact to trust.

Node 24 (Active LTS on 2026-09-24) ships `node:sqlite`: no flag is needed
since v22.13, it is "Stability: 1.2 - Release candidate" since v24.15.0, it
exposes `DatabaseSync`, and `backup()` exists since v22.16 / v23.8. The v24
build compiles SQLite with FTS5 enabled (integration-contracts QN39-QN44).

## Decision

Use `node:sqlite` through a small synchronous wrapper, `Db` in
`src/database/db.ts` (`run` / `get` / `all` / `transaction`, parameterized
SQL only). Require Node 24 or newer (`package.json` engines, `.nvmrc`).
Hide exactly one warning, Node's SQLite ExperimentalWarning, in the CLI entry
point (`installSqliteWarningFilter` in `src/cli/main.ts`); every other
warning passes through.

## Consequences

- No native module, no install-time build, and installs work with
  `npm ci --ignore-scripts` (see ADR 0010).
- FTS5 is available for memory retrieval and its fallback (ADR 0005).
- The API is synchronous. `Db.transaction` rejects async callbacks; code after
  an `await` inside a transaction would run outside it, so paid calls and
  network I/O never happen inside a transaction.
- The module is a release candidate, not "stable": API changes in a future
  Node line are possible. The wrapper keeps the surface small so a switch
  touches one file.
- Node 22 and older are not supported by this project even though they have
  `node:sqlite`, because the tested behavior and FTS5 build were verified on
  the 24 line.

## Alternatives considered

- `better-sqlite3`: mature and fast, but a native build and install scripts.
- `sql.js` (WebAssembly): no native build, but the database lives in memory
  and must be exported; no WAL; poor fit for a durable job runner.
- A server database (PostgreSQL): contradicts local-first, single-user
  operation and adds infrastructure.

## References

- `src/database/db.ts`, `src/database/migrate.ts`, `src/database/backup.ts`
- `tests/unit/database/db.test.ts`, `tests/integration/database/migrations.test.ts`, `tests/unit/cli/program.test.ts` (warning filter)
- `docs/integration-contracts.md` section 8 (Node.js and node:sqlite)
