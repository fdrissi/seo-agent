import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import {
  gatherDiagnostics,
  listDiagnosticsFiles,
  readDiagnosticsFile,
  renderDiagnosticsMarkdown,
  resolveDiagnosticsFile,
  writeDiagnosticsBundle,
  type DiagnosticBundle,
} from '../../security/diagnostics.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

/**
 * `diagnostics export | show | list`
 *
 * Produces a REDACTED diagnostic bundle in <workspace>/diagnostics/ for bug
 * reports. Nothing is ever uploaded: the user must inspect the files and decide
 * what, if anything, to attach to a public issue.
 */

const INSPECT_WARNING = [
  'INSPECT both files before attaching anything to a public issue.',
  'The bundle is redacted (secret values, hostnames, URLs, property IDs, emails, and absolute paths are replaced with placeholders),',
  'but masking of free text is heuristic and you are the final reviewer. Remove anything you are not comfortable sharing.',
  'Nothing was uploaded. seo-agent never uploads diagnostics or sends telemetry.',
];

function summarize(b: DiagnosticBundle) {
  return {
    sites: b.sites.length,
    invalidConfigs: b.sites.filter((s) => s.configStatus === 'invalid').length,
    integrationsNeedingAction: b.sites.flatMap((s) => s.integrations).filter((i) => ['missing_credentials', 'misconfigured', 'unreachable', 'permission_denied', 'degraded'].includes(i.state)).length,
    database: b.database.present ? `${b.database.tableCounts.length} tables; ${b.database.migrations ? `${b.database.migrations.pending.length} pending migration(s)` : 'migration status unavailable'}` : 'not present',
    recentJobs: b.database.jobs.recent.length,
    failedJobs: b.database.jobs.recent.filter((j) => j.status === 'failed').length,
    identifiersMasked: b.redaction.identifiersMasked,
    selfCheckPassed: b.redaction.selfCheck.passed,
    scope: b.scope,
  };
}

function workspaceSource(g: GlobalOptions, env: NodeJS.ProcessEnv): 'flag' | 'env' | 'default' {
  if (g.workspace) return 'flag';
  if (env.SEO_AGENT_WORKSPACE) return 'env';
  return 'default';
}

export function register(program: Command, cli: CliRuntime): void {
  const diag = program.command('diagnostics').description('Redacted diagnostic bundle for bug reports (written locally; never uploaded)');

  diag
    .command('export')
    .description('Write a redacted diagnostic bundle (JSON + Markdown) to <workspace>/diagnostics/. With --site, only that site is reported (other sites stay masked). Inspect it before sharing.')
    .option('--recent-jobs <n>', 'number of recent jobs per site to include (0-200)', '20')
    .action(
      cli.action(async (opts: { recentJobs?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        const recentJobs = Number.parseInt(opts.recentJobs ?? '20', 10);
        if (!Number.isFinite(recentJobs) || recentJobs < 0 || recentJobs > 200) throw new AppError('VALIDATION_FAILED', '--recent-jobs must be an integer between 0 and 200');
        const bundle = gatherDiagnostics({ paths, env: cli.env, siteId: g.site ?? null, workspaceSource: workspaceSource(g, cli.env), recentJobs });
        const summary = summarize(bundle);
        if (g.dryRun) {
          const result = { dryRun: true, written: false, uploaded: false, directory: paths.diagnosticsDir, summary, bundle };
          cli.print(g, result, () => [renderDiagnosticsMarkdown(bundle), '', `Dry run: nothing was written. Without --dry-run the bundle is saved to ${paths.diagnosticsDir}.`].join('\n'));
          return;
        }
        const files = writeDiagnosticsBundle(bundle, paths.diagnosticsDir);
        const result = { dryRun: false, written: true, uploaded: false, jsonFile: files.jsonFile, markdownFile: files.markdownFile, summary, notice: INSPECT_WARNING };
        cli.print(g, result, (r: typeof result) =>
          [
            'Redacted diagnostic bundle written (not uploaded):',
            `  ${r.jsonFile}`,
            `  ${r.markdownFile}`,
            '',
            `Sites: ${r.summary.sites}${r.summary.scope.restrictedToSelectedSites ? ` (restricted by --site; ${r.summary.scope.otherSitesExcluded} other site(s) excluded)` : ''} (${r.summary.invalidConfigs} invalid config), integrations needing action: ${r.summary.integrationsNeedingAction}, database: ${r.summary.database}, recent jobs: ${r.summary.recentJobs} (${r.summary.failedJobs} failed).`,
            `Identifiers masked: ${r.summary.identifiersMasked}; redaction self-check ${r.summary.selfCheckPassed ? 'passed' : 'FAILED'}.`,
            '',
            ...INSPECT_WARNING,
            '',
            `Review it with: npm run cli -- diagnostics show ${r.markdownFile}`,
          ].join('\n'),
        );
      }),
    );

  diag
    .command('show <file>')
    .description('Print a diagnostic bundle (JSON or Markdown). A bare file name is looked up in <workspace>/diagnostics/.')
    .action(
      cli.action(async (file: string, _opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.workspace(g);
        const target = resolveDiagnosticsFile(paths.diagnosticsDir, file);
        const read = readDiagnosticsFile(target);
        if (read.kind === 'json') cli.print(g, read.bundle, (b: DiagnosticBundle) => renderDiagnosticsMarkdown(b));
        else cli.print(g, { file: read.file, markdown: read.text }, (r: { markdown: string }) => r.markdown);
      }),
    );

  diag
    .command('list')
    .description('List exported diagnostic bundles in <workspace>/diagnostics/')
    .action(
      cli.action(async (_opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        const files = listDiagnosticsFiles(paths.diagnosticsDir);
        cli.print(g, { directory: paths.diagnosticsDir, files }, (r: { directory: string; files: Array<{ name: string; bytes: number; modifiedAt: string }> }) =>
          r.files.length ? [`Diagnostic bundles in ${r.directory}:`, ...r.files.map((f) => `  ${f.name}  ${f.bytes} bytes  ${f.modifiedAt}`)].join('\n') : `No diagnostic bundles in ${r.directory}. Create one with: npm run cli -- diagnostics export`,
        );
      }),
    );
}
