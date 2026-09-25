import type { Command } from 'commander';
import { createAppContext, type AppContext } from '../app/context.js';
import { AppError, isAppError } from '../core/errors.js';
import { parseMode, type RuntimeMode } from '../core/modes.js';
import { resolveSiteId } from '../config/load.js';
import { resolveWorkspaceDir, workspacePaths, type WorkspacePaths } from '../config/paths.js';
import { WORKSPACE_FORMAT_VERSION, readManifest } from '../config/workspace.js';
import { MANUAL_LEASE_MS, MANUAL_LOCAL_STALE_AFTER_MS, ManualSiteLease, describeLeaseHolder, type LeaseHolderLiveness, type ManualSiteLeaseOptions } from '../jobs/manual-lease.js';
import { forTerminal } from '../core/terminal.js';
import { redact, redactString } from '../security/redact.js';

/** Global options available on every command. */
export interface GlobalOptions {
  workspace?: string;
  site?: string;
  dryRun?: boolean;
  json?: boolean;
  mode?: string;
  offline?: boolean;
}

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const defaultIO: CliIO = {
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
};

/**
 * The runtime's IO: standard error is human text only (notices, warnings,
 * errors, help), so every line written there is terminal-safe (control, bidi,
 * and invisible characters become visible `[U+XXXX]` markers; see
 * src/core/terminal.ts). Standard output is left as given: JSON stays exact,
 * and `CliRuntime.print` makes human output terminal-safe itself.
 */
function terminalSafeIO(io: CliIO): CliIO {
  return { out: (t) => io.out(t), err: (t) => io.err(forTerminal(t)) };
}

/**
 * Manual commands that write data or spend money (spec 27: non-overlapping
 * per-site runs). Such a command (not a --dry-run) takes the per-site `site`
 * lease itself, through the jobs lock API (src/jobs/manual-lease.ts), for as
 * long as it runs: the lease is acquired atomically when its context is built,
 * renewed by heartbeats, and released when the command's database connection
 * closes (or, at the latest, when its action ends). So:
 * - while a job (or another manual command) holds the lease, the command
 *   refuses with LOCKED instead of running alongside it;
 * - while the command runs, a scheduled or foreground job of the same site
 *   finds the lease held and does not start: the runner reports `locked`; a
 *   job the scheduler queued stays queued for its next tick, and a foreground
 *   job (`baseline`, `weekly`, ... through enqueueAndRun) is closed as
 *   `cancelled` with code LOCKED, so nothing is left queued.
 * --dry-run previews never take or check the lease. Handled centrally in
 * `CliRuntime.context()` for the command path tagged by buildProgram's
 * preAction hook, so no command module needs its own lock code.
 * Content jobs keep their separate "content" lock (documented exception).
 * Every registered command is classified in tests/integration/cli/site-lock.test.ts:
 * a new command fails that test until it is listed here, in
 * CONDITIONALLY_MUTATING_COMMANDS, or in the test's reviewed list of commands
 * that take no lease, so a paying or data-changing command cannot be missed.
 */
export const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'sync gsc',
  'sync ga4',
  'sync inspect',
  'crawl',
  'crawl site',
  'crawl page',
  'crawl competitor',
  'research keyword',
  'perf check',
  'content brief',
  'content draft',
  'content review',
  'content batch',
  'experiments review',
  'export',
  'apify test',
  'apify research',
  'data import',
  'pages set-type',
  // Paid embeddings and writes to the memory tables the jobs' index_memory stage also writes.
  'memory sync',
  'memory rebuild',
  'memory reconcile',
  // Creates content items and briefs (optional model spend); also takes the separate "content" lock.
  'content bootstrap',
  // One explicit paid LLM Gateway request.
  'models test',
  // Audited settlement of a charge in the cost ledger.
  'costs reconcile',
  // Stores the actor input schema the Apify stages validate against.
  'apify import-schema',
  // Also stores the fetched actor input schema (with its hash) and may pin a build (NF-08).
  'apify inspect',
  // URL reconciliation: writes page identities and alias evidence (the weekly reconcile stage writes the same tables).
  'analyze reconcile',
  // Both run the URL reconciliation first (same writes as `analyze reconcile`); --save also persists routes and opportunities.
  'analyze page',
  'analyze route',
  // Writes a new report (database row, Markdown and JSON files).
  'report build',
  // Regenerates vault notes, which the pipelines' report stage also writes.
  'vault render',
  // Creates content signals from a file of customer questions.
  'content import',
  // Moves published content items to measuring (stage changes).
  'content measure',
]);

/**
 * Commands that change data or spend money only with certain options: they
 * take the per-site lease (and refuse with LOCKED while a job holds it) only
 * when `when` is true for the command's own options. Keyed by command path;
 * `flags` names the options for messages and docs.
 */
export const CONDITIONALLY_MUTATING_COMMANDS: ReadonlyMap<string, { flags: string; when: (opts: Readonly<Record<string, unknown>>) => boolean }> = new Map([
  // A query embedding that is not cached is a paid request.
  ['memory search', { flags: '--allow-paid', when: (o: Readonly<Record<string, unknown>>) => o.allowPaid === true }],
  // Records the guessed page types (page_type_source 'inferred'); without --apply it only previews.
  ['pages infer-types', { flags: '--apply', when: (o: Readonly<Record<string, unknown>>) => o.apply === true }],
  // Records business-note versions in the database; without --apply it only validates and shows the diff.
  ['vault import-business', { flags: '--apply', when: (o: Readonly<Record<string, unknown>>) => o.apply === true }],
  // --poll stores finished DataForSEO results; --abandon gives up on an ambiguous (possibly charged) task.
  ['research tasks', { flags: '--poll or --abandon', when: (o: Readonly<Record<string, unknown>>) => o.poll === true || (typeof o.abandon === 'string' && o.abandon !== '') }],
  // --resume finishes pending runs and re-checks unresolved charges; --confirm-not-accepted settles a quarantined charge at $0.
  ['apify runs', { flags: '--resume or --confirm-not-accepted', when: (o: Readonly<Record<string, unknown>>) => o.resume === true || (typeof o.confirmNotAccepted === 'string' && o.confirmNotAccepted !== '') }],
]);

/**
 * Whether a manual command (not a --dry-run) must hold the per-site lease:
 * it is in MUTATING_COMMANDS, or in CONDITIONALLY_MUTATING_COMMANDS with a
 * spending or data-changing option set.
 */
export function needsSiteLease(commandPath: string | null, opts: Readonly<Record<string, unknown>> = {}): boolean {
  if (!commandPath) return false;
  if (MUTATING_COMMANDS.has(commandPath)) return true;
  return CONDITIONALLY_MUTATING_COMMANDS.get(commandPath)?.when(opts) ?? false;
}

/**
 * Next step for a command refused because a MANUAL command holds the lease,
 * following what this host can tell about that command's process.
 */
export function manualHolderHint(holder: string, lockName: string, liveness: LeaseHolderLiveness, expiredButAlive: boolean): string {
  const release = `\`npm run cli -- jobs locks --release ${lockName} --as "<your name>"\``;
  const tail = ' --dry-run previews still work meanwhile.';
  if (liveness.state === 'dead') {
    return `The process of ${holder} is gone (${liveness.detail}). Its lease is taken over once it expires (at most ${Math.round(MANUAL_LEASE_MS / 1000)} s after its last heartbeat), or release it now with ${release}, then retry.${tail}`;
  }
  if (liveness.state === 'alive') {
    const pid = liveness.pid !== null ? ` (process ${liveness.pid})` : '';
    return expiredButAlive
      ? `Its lease expired, but ${holder}${pid} is still running on this machine. It renews its lease on its next heartbeat. If it is still unrenewed ${Math.round(MANUAL_LOCAL_STALE_AFTER_MS / 1000)} s after this attempt (at the latest), it counts as hung and the next attempt takes the lease over. If it is hung, stop that process, then retry (\`npm run cli -- jobs locks\` shows the lease).${tail}`
      : `Wait for ${holder}${pid} to finish (\`npm run cli -- jobs locks\` shows the lease and whether its process is alive), then retry. If you stop that process, retry once its lease expired (${Math.round(MANUAL_LEASE_MS / 1000)} s), or release it with ${release}.${tail}`;
  }
  return `Wait for ${holder} to finish (${liveness.detail}; \`npm run cli -- jobs locks\` shows the lease). A lease from another machine is taken over once it expires (${Math.round(MANUAL_LEASE_MS / 1000)} s after its last heartbeat), then retry.${tail}`;
}

/** "sync gsc" for the `gsc` subcommand of `sync` (the root program is not included). */
export function commandPathOf(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/**
 * Helpers shared by all command modules. Command modules live in
 * src/cli/commands/<area>.ts and export `register(program, cli)`; they are
 * discovered automatically (see main.ts).
 */
/** Options of a CLI runtime (tests inject the host identity and short lease timings). */
export interface CliRuntimeOptions {
  /** Settings of the per-site lease that manual MUTATING_COMMANDS hold while they run. */
  lease?: Partial<Pick<ManualSiteLeaseOptions, 'hostname' | 'pid' | 'startedAt' | 'isPidAlive' | 'processStartedAt' | 'leaseMs' | 'heartbeatMs' | 'localStaleAfterMs' | 'unrenewedAfterMs'>>;
}

export class CliRuntime {
  /** Path of the command whose action is running (e.g. "sync gsc"), set by buildProgram's preAction hook. */
  commandPath: string | null = null;
  /** The running command's own options (for CONDITIONALLY_MUTATING_COMMANDS), set with commandPath. */
  commandOptions: Readonly<Record<string, unknown>> = {};
  /** Site leases held by the running manual command, keyed by database file and site. */
  private readonly leases = new Map<string, ManualSiteLease>();
  /** Output streams; everything written to `err` is terminal-safe (see terminalSafeIO). */
  readonly io: CliIO;

  constructor(
    io: CliIO = defaultIO,
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly options: CliRuntimeOptions = {},
  ) {
    this.io = terminalSafeIO(io);
  }

  /** Record which command is about to run (called by the preAction hook installed in main.ts). */
  tagCommand(cmd: Command): void {
    this.commandPath = commandPathOf(cmd);
    this.commandOptions = typeof cmd.opts === 'function' ? { ...cmd.opts() } : {};
  }

  /**
   * Hold the per-site lease for a data-changing or chargeable manual command
   * (spec 27), or refuse with LOCKED while a job or another manual command
   * holds it. A lease that expired (crashed holder) no longer counts, unless
   * its holder process is still alive on this host (a laptop that just woke
   * up; a pid reused by another process does not count, and a live holder
   * seen unrenewed for a few heartbeats counts as hung). The lease is released before the context's database connection
   * closes; a second context of the same invocation for the same site shares
   * it. On refusal the context's database is closed and nothing was done.
   */
  private holdSiteLease(ctx: AppContext, command: string): void {
    const db = ctx.db;
    const key = `${db.file}\u0000${ctx.siteId}`;
    let lease = this.leases.get(key);
    if (lease && !lease.join(db)) {
      this.leases.delete(key);
      lease = undefined;
    }
    if (!lease) {
      let r: ReturnType<typeof ManualSiteLease.acquire>;
      try {
        r = ManualSiteLease.acquire(db, {
          siteId: ctx.siteId,
          command,
          clock: ctx.clock,
          ...this.options.lease,
          onLost: (message) => {
            this.io.err(`Warning: ${redactString(message)}`);
            ctx.logger.warn(message, { command });
          },
        });
      } catch (err) {
        // Could not even try (e.g. the database stayed busy): nothing was done, do not leak the connection.
        db.close();
        throw err;
      }
      if (!r.acquired) {
        const held = r.heldBy;
        db.close();
        const alive = r.aliveReason ? ` Its lease expired, but ${r.aliveReason}.` : '';
        throw new AppError(
          'LOCKED',
          `Site ${ctx.siteId} is locked by ${r.holder} (held by ${held.owner}, lease until ${held.expiresAt}).${alive} "${command}" changes data or spends money, so it never runs alongside ${held.jobId ? 'a job' : 'another data-changing run'} of the same site. Nothing was done.`,
          {
            hint: held.jobId
              ? `Wait for job ${held.jobId} to finish (\`npm run cli -- jobs list\` or \`jobs show ${held.jobId}\`), or cancel it with \`jobs cancel ${held.jobId}\`, then retry. --dry-run previews still work meanwhile.`
              : manualHolderHint(r.holder, held.lockName, r.holderLiveness, r.aliveReason !== null),
            details: { command, siteId: ctx.siteId, lockName: held.lockName, jobId: held.jobId, owner: held.owner, expiresAt: held.expiresAt },
          },
        );
      }
      if (r.takenOverFrom) ctx.logger.warn(`Took over the expired ${r.takenOverFrom.lockName} lease of ${describeLeaseHolder(r.takenOverFrom)} (held by ${r.takenOverFrom.owner}, expired ${r.takenOverFrom.expiresAt})`, { command });
      lease = r.lease;
      this.leases.set(key, lease);
    }
    // Release the lease while the connection is still open, whenever the command closes it.
    const held = lease;
    const close = db.close.bind(db);
    db.close = () => {
      try {
        held.leave(db);
        if (!held.connections && this.leases.get(key) === held) this.leases.delete(key);
      } finally {
        close();
      }
    };
  }

  /**
   * Release every site lease still held by this runtime (called when a
   * command's action ends, and by main() on exit). Leases whose connections
   * were already closed were released at that point.
   */
  releaseLeases(): void {
    for (const lease of this.leases.values()) {
      try {
        lease.release();
      } catch {
        /* database closed or busy: the lease runs out on its own */
      }
    }
    this.leases.clear();
  }

  /** Merge a command's options with the root program's global options. */
  globals(cmd: Command): GlobalOptions {
    return cmd.optsWithGlobals() as GlobalOptions;
  }

  mode(g: GlobalOptions): RuntimeMode {
    return parseMode(g.mode);
  }

  workspace(g: GlobalOptions): WorkspacePaths {
    return workspacePaths(resolveWorkspaceDir(g.workspace, this.env));
  }

  /**
   * The workspace for commands that operate on one. Refuses a missing workspace
   * and one written by a newer application (higher manifest formatVersion):
   * an older application must never create or migrate data inside a layout it
   * does not understand.
   */
  requireWorkspace(g: GlobalOptions): WorkspacePaths {
    const paths = this.workspace(g);
    const manifest = readManifest(paths);
    if (!manifest) {
      throw new AppError('WORKSPACE_MISSING', `No workspace found at ${paths.root}`, {
        hint: 'Run `npm run cli -- init` (or `npm run demo` to try the synthetic demo first).',
      });
    }
    if (manifest.formatVersion > WORKSPACE_FORMAT_VERSION) {
      throw new AppError('WORKSPACE_UNSAFE', `Workspace ${paths.root} uses format ${manifest.formatVersion}, newer than this application supports (${WORKSPACE_FORMAT_VERSION}). Nothing was changed.`, {
        hint: 'Upgrade the application to the version that created this workspace (see docs/UPGRADING.md); never downgrade a live workspace.',
        details: { formatVersion: manifest.formatVersion, supported: WORKSPACE_FORMAT_VERSION },
      });
    }
    return paths;
  }

  /**
   * Build the per-site application context. A normal run applies pending
   * migrations (with a verified backup) and records the site configuration;
   * --dry-run never writes: it fails with MIGRATION_PENDING when migrations
   * are pending, only reports unrecorded configuration changes, and plans
   * against an empty in-memory database when none exists yet. A command in
   * MUTATING_COMMANDS, or in CONDITIONALLY_MUTATING_COMMANDS with its paid or
   * data-changing option set (not a dry run), holds the per-site lease until
   * its database connection closes, and is refused with LOCKED while a job or
   * another manual command holds it.
   */
  context(g: GlobalOptions, extra: { runId?: string } = {}): AppContext {
    const paths = this.requireWorkspace(g);
    const siteId = resolveSiteId(paths, g.site);
    const ctx = createAppContext({
      workspaceRoot: paths.root,
      siteId,
      mode: this.mode(g),
      dryRun: !!g.dryRun,
      prepareDatabase: g.dryRun ? 'verify' : 'migrate',
      ...(g.offline ? { offline: true } : {}),
      ...(extra.runId ? { runId: extra.runId } : {}),
      onMigrated: (r) => this.io.err(`Database migrated (${r.applied.join(', ')}).${r.backupFile ? ` Pre-migration backup: ${r.backupFile}` : ''}`),
      onNotice: (message) => this.io.err(message),
    });
    if (!ctx.dryRun && this.commandPath && needsSiteLease(this.commandPath, this.commandOptions)) this.holdSiteLease(ctx, this.commandPath);
    return ctx;
  }

  /**
   * Print a result: JSON when --json, otherwise the human renderer. Always
   * redacted. Human output is also terminal-safe: untrusted text (page titles,
   * imported questions, memory hits) can carry ANSI/OSC escape sequences, so
   * control, bidi, and invisible characters are printed as visible
   * `[U+XXXX]` markers (src/core/terminal.ts). JSON is left exact (its string
   * escaping already neutralizes C0 controls).
   */
  print(g: GlobalOptions, result: unknown, human?: (r: any) => string): void {
    if (g.json || !human) this.io.out(JSON.stringify(redact(result), null, 2));
    else this.io.out(forTerminal(redactString(human(result))));
  }

  /** Wrap an action: consistent error rendering and exit codes. */
  action<A extends unknown[]>(fn: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
    return async (...args: A) => {
      try {
        await fn(...args);
      } catch (err) {
        const cmd = args[args.length - 1] as Command | undefined;
        const json = !!(cmd && typeof cmd.optsWithGlobals === 'function' && (cmd.optsWithGlobals() as GlobalOptions).json);
        this.fail(err, json);
      } finally {
        // A command that did not close its connection still gives its site lease back when it ends.
        this.releaseLeases();
      }
    };
  }

  fail(err: unknown, json: boolean): never {
    if (isAppError(err)) {
      if (json) this.io.out(JSON.stringify({ ok: false, error: redact(err.toJSON()) }, null, 2));
      else {
        // Error text can quote untrusted input (a file's column, a page title): terminal-safe like all of stderr.
        this.io.err(forTerminal(`Error [${err.code}]: ${redactString(err.message)}`));
        if (err.hint) this.io.err(forTerminal(`Next step: ${redactString(err.hint)}`));
        const errors = (err.details as { errors?: string[] } | undefined)?.errors;
        if (Array.isArray(errors)) for (const e of errors) this.io.err(forTerminal(`  - ${redactString(String(e))}`));
      }
      process.exitCode = err.code === 'BUDGET_EXCEEDED' || err.code === 'CREDENTIALS_MISSING' || err.code === 'INTEGRATION_DISABLED' ? 3 : 1;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      if (json) this.io.out(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: redactString(message) } }, null, 2));
      else this.io.err(forTerminal(`Error: ${redactString(message)}`));
      if (process.env.SEO_AGENT_DEBUG && err instanceof Error && err.stack) this.io.err(forTerminal(redactString(err.stack)));
      process.exitCode = 1;
    }
    throw new CliExit();
  }
}

/** Thrown after an error has been rendered; main.ts swallows it. */
export class CliExit extends Error {
  constructor() {
    super('cli-exit');
  }
}

/** Contract for command modules in src/cli/commands/. */
export interface CommandModule {
  register(program: Command, cli: CliRuntime): void;
}
