import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { forTerminal, hasUnsafeTerminalChars } from '../../core/terminal.js';
import { EXPORT_DATASET_NAMES, exportDataset, formatExport, isExportDataset, type ExportResult } from '../../data/export.js';
import { IMPORT_DATASETS, IMPORT_DATASET_NAMES, importDataset, isImportDataset, type DataImportResult } from '../../data/import.js';
import { appRoot, isWithinRealPath, type WorkspacePaths } from '../../config/paths.js';
import { atomicWriteFile } from '../../obsidian/fs-safe.js';
import { isWithin, safeResolve } from '../../security/paths.js';
import { redactString } from '../../security/redact.js';
import type { CliRuntime } from '../runtime.js';

/**
 * data export <dataset> --format csv|json [--from --to] [--out <file>|-]
 * data import <dataset> <file.csv|json> [--property --search-type --replace --skip-invalid --complete --synthetic --provider --unguard]
 *
 * CSV/JSON exchange instead of extra integrations (spec 2). Exports read one
 * dataset at its stored grain (never mixing property totals with page rows);
 * imports become versioned ingestion batches with source 'import' and
 * provenance. Neither makes a network request or spends anything.
 *
 * Where an export is written:
 * - default: <workspace>/exports/data/<file>, resolved with safeResolve (no
 *   traversal, no symlink out of the exports folder) and written atomically
 *   (0600);
 * - --out <file>: the owner's chosen path, but never written through an
 *   existing symbolic link (the link could point anywhere), never inside the
 *   application repository outside the workspace (private data could be
 *   committed), and never inside the vault or the workspace secrets/ folder;
 * - --out -: standard output. Piped, the bytes are exact; on a terminal,
 *   control, bidi, and invisible characters in stored text are shown as
 *   visible [U+XXXX] markers (stored text can never drive the terminal) and a
 *   notice says how to get the exact bytes.
 */

/** Whether standard output is a terminal (a function so tests can stand in for a TTY). */
export const stdoutIsTerminal = { check: (): boolean => process.stdout.isTTY === true };

/**
 * The text `data export --out -` writes: exact when piped; terminal-safe on a
 * terminal (CRLF row ends become newlines, every other control, bidi, or
 * invisible character a visible [U+XXXX] marker). `marked` says whether
 * anything was replaced.
 */
export function stdoutExportText(text: string, isTerminal: boolean): { text: string; marked: boolean } {
  const body = text.replace(/\r?\n$/, '');
  if (!isTerminal) return { text: body, marked: false };
  const lines = body.replace(/\r\n/g, '\n');
  return { text: forTerminal(lines), marked: hasUnsafeTerminalChars(lines) };
}

/** The workspace locations an explicit `--out` is checked against. */
export type ExportTargetGuard = Pick<WorkspacePaths, 'root' | 'vaultRoot' | 'secretsDir'>;

/**
 * The file an export is written to. Default: inside <workspace>/exports/data
 * through safeResolve (refuses traversal and symlinks that leave the exports
 * folder). An explicit --out stays the owner's choice, with limits (D1-R09):
 * - an existing symbolic link there is refused: writing through it would put
 *   private data wherever the link points;
 * - a path inside the application repository is refused unless it is inside
 *   the workspace (a workspace may live in a checkout for tests), because a
 *   file there could be committed;
 * - a path inside the vault or the workspace secrets/ folder is refused.
 * Locations are compared as written and by where they really are (symlinks
 * resolved, letter case ignored on a case-insensitive volume). Without
 * `workspace`, only the symbolic-link and repository checks apply (no
 * workspace exemption).
 */
export function exportTarget(exportsDir: string, fileName: string, out?: string, workspace?: ExportTargetGuard): string {
  if (!out) return safeResolve(exportsDir, path.join('data', fileName));
  const target = path.resolve(out);
  let isLink = false;
  try {
    isLink = lstatSync(target).isSymbolicLink();
  } catch {
    /* does not exist yet */
  }
  if (isLink) throw new AppError('UNSAFE_PATH', `Refusing to write the export through a symbolic link: ${target}. Remove the link or choose another --out file.`);
  const inside = (dir: string) => isWithin(path.resolve(dir), target) || isWithinRealPath(dir, target);
  const hint = 'Omit --out to write inside <workspace>/exports/data, or choose a private folder outside the application repository, the vault, and secrets/.';
  if (workspace && inside(workspace.secretsDir)) {
    throw new AppError('UNSAFE_PATH', `Refusing to write the export inside the workspace secrets/ folder: ${target}.`, { hint });
  }
  if (workspace && inside(workspace.vaultRoot)) {
    throw new AppError('UNSAFE_PATH', `Refusing to write the export inside the Obsidian vault: ${target}. Exports hold private measurement data; the vault holds notes.`, { hint });
  }
  let repo: string | null = null;
  try {
    repo = appRoot();
  } catch {
    repo = null;
  }
  if (repo && inside(repo) && !(workspace && inside(workspace.root))) {
    throw new AppError('UNSAFE_PATH', `Refusing to write the export inside the application repository: ${target}. Private data never enters the repository, where it could be committed.`, { hint });
  }
  return target;
}

function exportSummary(r: ExportResult, written: string | null): string {
  return [
    `${r.rowCount} row(s) of ${r.dataset} (${r.grain})${r.containsSynthetic ? ' [contains SYNTHETIC rows]' : ''}.`,
    `Filter: ${r.filters.from ?? 'start'} to ${r.filters.to ?? 'latest'} on ${r.filters.appliesTo}.`,
    ...r.notes.map((n) => `Note: ${n}`),
    written ? `Written: ${written}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function importSummary(r: DataImportResult): string {
  const lines = [
    `${r.preview ? 'DRY RUN (nothing written): ' : ''}${r.dataset} from ${path.basename(r.file)} (${r.format}${r.synthetic ? ', SYNTHETIC' : ''}): ${r.accepted} of ${r.rowsRead} row(s) valid; status ${r.status}.`,
    r.dateRange ? `Dates: ${r.dateRange.start} to ${r.dateRange.end}.` : '',
    r.batchId ? `Batch ${r.batchId}: ${r.counts.newRevisions} new or revised, ${r.counts.unchanged} unchanged, ${r.skippedExisting} kept from a Google sync.` : '',
    r.keywords ? `Keywords: ${r.keywords.created} created, ${r.keywords.matchedExisting} already known, ${r.keywords.volumes} search-volume estimate(s) stored.` : '',
    r.rawRef ? `Stored file (private workspace): ${r.rawRef}` : '',
    ...r.warnings.map((w) => `Note: ${w}`),
    ...r.rejected.slice(0, 20).map((e) => `  row ${e.row}: ${e.errors.join('; ')}`),
    r.rejected.length > 20 ? `  ... ${r.rejected.length - 20} more invalid row(s) (see --json)` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function register(program: Command, cli: CliRuntime): void {
  const data = program.command('data').description('CSV/JSON exchange: export one dataset at its stored grain, or import Search Console exports and keyword lists with provenance');

  data
    .command('export <dataset>')
    .description(`Export one dataset (${EXPORT_DATASET_NAMES.join(', ')}) as CSV or JSON; current revisions only, never aggregated or mixed`)
    .option('--format <format>', 'csv | json', 'csv')
    .option('--from <date>', 'first date (YYYY-MM-DD) to include')
    .option('--to <date>', 'last date (YYYY-MM-DD) to include')
    .option('--out <file>', 'output file, or "-" for standard output (default: <workspace>/exports/data/<site>-<dataset>-<from>-<to>.<format>); never a symbolic link, a file in the application repository outside the workspace, the vault, or secrets/')
    .action(
      cli.action(async (datasetArg: string, opts: { format: string; from?: string; to?: string; out?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (!isExportDataset(datasetArg)) throw new AppError('VALIDATION_FAILED', `Unknown dataset "${datasetArg}". Use one of: ${EXPORT_DATASET_NAMES.join(', ')}.`);
        if (opts.format !== 'csv' && opts.format !== 'json') throw new AppError('VALIDATION_FAILED', '--format must be csv or json');
        const format = opts.format;
        const ctx = cli.context(g);
        try {
          const r = exportDataset(ctx, datasetArg, { from: opts.from ?? null, to: opts.to ?? null });
          const text = formatExport(r, format);
          if (opts.out === '-') {
            const shown = stdoutExportText(redactString(text), stdoutIsTerminal.check());
            cli.io.out(shown.text);
            if (shown.marked) {
              cli.io.err('Notice: the export contains control, bidi, or invisible characters; on this terminal they are shown as visible [U+XXXX] markers. Pipe the output or write it with --out <file> to keep the exact bytes.');
            }
            return;
          }
          const target = exportTarget(ctx.paths.exportsDir, `${ctx.siteId}-${datasetArg}-${opts.from ?? 'start'}-${opts.to ?? 'latest'}.${format}`, opts.out, ctx.paths);
          if (ctx.dryRun) {
            cli.print(g, { dryRun: true, dataset: r.dataset, rows: r.rowCount, wouldWrite: target, grain: r.grain }, (x: { rows: number; wouldWrite: string }) => `DRY RUN: would write ${x.rows} row(s) to ${x.wouldWrite}.`);
            return;
          }
          mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          // Re-checked after the folder exists (a link could have appeared in between), then written atomically (0600).
          const dest = exportTarget(ctx.paths.exportsDir, path.basename(target), opts.out, ctx.paths);
          atomicWriteFile(dest, redactString(text), { mode: 0o600 });
          cli.print(g, { ...r, rows: undefined, file: dest }, () => exportSummary(r, dest));
        } finally {
          ctx.db.close();
        }
      }),
    );

  data
    .command('import <dataset> <file>')
    .description(`Import a file as a versioned ingestion batch (source "import"): ${IMPORT_DATASET_NAMES.map((n) => `${n} = ${IMPORT_DATASETS[n]!.description}`).join('; ')}`)
    .option('--format <format>', 'csv | json (default: by file extension)')
    .option('--property <property>', 'Search Console property (default: google.searchConsoleProperty; never guessed)')
    .option('--search-type <type>', 'search type when the file has no search type column', 'web')
    .option('--replace', "let the file's values supersede rows collected by a Google sync (default: keep them)")
    .option('--skip-invalid', 'import the valid rows and record the batch as partial (default: refuse the whole file)')
    .option('--complete', 'assert the file is complete for its date range, so dates or pages without rows are real zeros')
    .option('--synthetic', 'label the imported rows synthetic (test or demo data)')
    .option('--provider <name>', 'tool the keyword search volumes come from (stored as provider import:<name>)')
    .option('--unguard', 'CSV written by `data export` but not recognized as one: remove its spreadsheet formula guard (one leading apostrophe). Recognized exports are unguarded automatically; other files are kept exactly as written')
    .action(
      cli.action(
        async (
          dataset: string,
          file: string,
          opts: { format?: string; property?: string; searchType: string; replace?: boolean; skipInvalid?: boolean; complete?: boolean; synthetic?: boolean; provider?: string; unguard?: boolean },
          cmd: Command,
        ) => {
          const g = cli.globals(cmd);
          if (!isImportDataset(dataset)) throw new AppError('VALIDATION_FAILED', `Unknown import dataset "${dataset}". Use one of: ${IMPORT_DATASET_NAMES.join(', ')}.`);
          if (opts.format && opts.format !== 'csv' && opts.format !== 'json') throw new AppError('VALIDATION_FAILED', '--format must be csv or json');
          const ctx = cli.context(g);
          try {
            const r = importDataset(ctx, dataset, file, {
              ...(opts.format ? { format: opts.format as 'csv' | 'json' } : {}),
              ...(opts.property ? { property: opts.property } : {}),
              searchType: opts.searchType,
              replace: !!opts.replace,
              skipInvalid: !!opts.skipInvalid,
              complete: !!opts.complete,
              synthetic: !!opts.synthetic,
              ...(opts.provider ? { provider: opts.provider } : {}),
              ...(opts.unguard ? { unguard: true } : {}),
              preview: ctx.dryRun,
            });
            cli.print(g, r, importSummary);
            if (r.status === 'failed') process.exitCode = 1;
            else if (r.status === 'partial') process.exitCode = 2;
          } finally {
            ctx.db.close();
          }
        },
      ),
    );
}

