import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { appDirs } from '../../config/paths.js';
import { AppError } from '../../core/errors.js';
import { DEMO_APPROVER, renderDemoSummary, runDemo, type DemoResult } from '../../demo/index.js';
import { assertDemoDirSafe, defaultDemoDir } from '../../demo/workspace.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `demo`: the offline demo (spec 29 / 31). Runs the real pipelines on
 * SYNTHETIC fixtures in an ISOLATED demo workspace (default
 * `<os.tmpdir()>/seo-agent-demo`, or --dir) with zero external network
 * access and no credentials. It never touches a live workspace: --workspace
 * and SEO_AGENT_WORKSPACE are ignored, and a directory that holds a live
 * workspace (or anything that is not a previous demo) is refused.
 */

const PLAN = [
  'workspace       create/refresh the isolated demo workspace (kind "demo") with a fictional site config and vault',
  'baseline        ingest GSC/GA4 fixtures (versioned revisions), crawl the synthetic site in-process, report + dashboard',
  'interrupt       run the weekly job in RESEARCH mode and interrupt it mid-run (simulated Ctrl+C)',
  'resume          resume the job from its checkpoints (completed stages and paid research are not redone)',
  'routing         deterministic routes with reason codes',
  'recommendation  one sourced recommendation (claim labels + evidence); blocked competitor pages recorded honestly',
  'content         Apify dataset fixture -> content queue -> brief -> draft approval (demo persona) -> draft -> quality review',
  'experiment      proposed -> approved -> EXECUTE-mode manual export -> synthetic implementation time -> observing',
  'budgets         an over-budget and an unknown-price request are denied before anything is sent',
  'vault           re-render notes and the dashboard; check wikilinks',
  'isolation       zero network requests, synthetic flags, separate database',
];

/** Synthetic fixture paths (relative to appDirs.fixtures()) the demo reads at runtime. */
export const DEMO_FIXTURE_PATHS = ['demo/site.yaml', 'google', 'pipelines/site'] as const;

/**
 * The demo reads SYNTHETIC fixtures shipped with the application
 * (<appRoot>/tests/fixtures: the npm package and the container image include
 * them). When they are missing, say so with a next step instead of failing
 * with a raw ENOENT halfway through the run.
 */
export function assertDemoFixtures(fixturesRoot: string = appDirs.fixtures()): void {
  const missing = DEMO_FIXTURE_PATHS.filter((p) => !existsSync(path.join(fixturesRoot, p)));
  if (!missing.length) return;
  throw new AppError('CONFIG_MISSING', `The synthetic demo fixtures are missing from this installation: ${missing.map((p) => path.join(fixturesRoot, p)).join(', ')}. Nothing was run.`, {
    hint: 'The demo needs tests/fixtures (demo, google, pipelines) next to the application. They ship with the npm package and the container image; reinstall the application, or rebuild the image from a current checkout (the Dockerfile copies tests/fixtures), then run `demo` again.',
    details: { fixturesRoot, missing },
  });
}

interface DemoOpts {
  dir?: string;
  approver?: string;
  startAt?: string;
}

export function register(program: Command, cli: CliRuntime): void {
  program
    .command('demo')
    .description('Offline demo on SYNTHETIC fixtures in an isolated demo workspace (no credentials, no network): baseline, interrupted + resumed weekly job, routing, sourced recommendation, content draft workflow, experiment, budget denials')
    .option('--dir <dir>', `demo directory (default ${defaultDemoDir()}); a previous demo there is refreshed, anything else is refused`)
    .option('--approver <name>', `name of the explicit demo approver persona that records the demo approvals (default "${DEMO_APPROVER}")`)
    .option('--start-at <iso>', 'start of the simulated demo timeline (ISO-8601 with zone; default: two days ago)')
    .action(
      cli.action(async (opts: DemoOpts, cmd: Command) => {
        const g = cli.globals(cmd);
        const dir = path.resolve(opts.dir ?? defaultDemoDir());
        if (g.workspace || cli.env.SEO_AGENT_WORKSPACE) {
          cli.io.err(`Note: the demo ignores --workspace / SEO_AGENT_WORKSPACE; it runs only in its own isolated demo directory (${dir}).`);
        }
        if (opts.startAt !== undefined && (!/(Z|[+-]\d{2}:\d{2})$/.test(opts.startAt) || Number.isNaN(Date.parse(opts.startAt)))) {
          throw new AppError('VALIDATION_FAILED', `--start-at must be an ISO-8601 time with a zone, e.g. 2026-09-20T09:00:00Z (got "${opts.startAt}").`);
        }
        assertDemoFixtures();
        if (g.dryRun) {
          const { existingDemo } = assertDemoDirSafe(dir, cli.env);
          const plan = { dryRun: true, synthetic: true, dir, action: existingDemo ? 'refresh the previous demo' : 'create a new demo workspace', steps: PLAN };
          cli.print(g, plan, (p: typeof plan) =>
            [`Dry run: the demo would ${p.action} in ${p.dir} and run (SYNTHETIC fixtures, no network):`, ...p.steps.map((s, i) => `  ${String(i + 1).padStart(2)}. ${s}`), 'Nothing was written.'].join('\n'),
          );
          return;
        }
        const result: DemoResult = await runDemo({
          dir,
          env: cli.env,
          ...(opts.approver ? { approver: opts.approver } : {}),
          ...(opts.startAt ? { startAt: opts.startAt } : {}),
          ...(g.json ? {} : { onStep: (s) => cli.io.err(`  [${s.status}] ${s.id}: ${s.title}`) }),
        });
        cli.print(g, result, renderDemoSummary);
        if (!result.ok) process.exitCode = 1;
      }),
    );
}
