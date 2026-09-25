import path from 'node:path';
import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { appDirs, workspacePaths } from '../../config/paths.js';
import { LayeredSecretStore } from '../../config/secrets.js';
import { initWorkspace, readManifest } from '../../config/workspace.js';
import { openDatabase } from '../../database/db.js';
import { migrate } from '../../database/migrate.js';
import { initSiteVault, type VaultInitResult } from '../../obsidian/template.js';
import { createVaultWriter } from '../../obsidian/writer.js';
import { planImport, writeConfigFile } from '../../setup/config-file.js';
import { listDrafts } from '../../setup/draft.js';
import { yesNo } from '../../setup/parse.js';
import { createSetupServices } from '../../setup/probe.js';
import { createTerminalPromptIO, SetupInterruptedError, type PromptIO } from '../../setup/prompt-io.js';
import { listWizardStepGroups, listWizardSteps, runSetupWizard, type SetupWizardResult } from '../../setup/wizard.js';
import { redactString } from '../../security/redact.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

/**
 * `setup`:
 *   setup                     interactive, resumable wizard (asks only for missing information)
 *   setup --update            add missing information to an existing config (diff shown before writing)
 *   setup --only <steps>      ask specific steps or step groups again (see --list-steps),
 *                             e.g. --only conversions (= conversions.primaryEvents,conversions.secondaryEvents)
 *   setup --from <file.yaml>  non-interactive import of a prepared, validated config
 *   setup vault               create the site vault from the template (never overwrites)
 */

/** Injectable for tests: the prompt IO and the network-backed wizard helpers. */
export const setupCliDeps: {
  createPromptIO: () => PromptIO;
  createServices: typeof createSetupServices;
} = {
  createPromptIO: () => createTerminalPromptIO(),
  createServices: createSetupServices,
};

interface SetupOpts {
  from?: string;
  update?: boolean;
  only?: string;
  listSteps?: boolean;
}

function createWorkspace(root: string, env: NodeJS.ProcessEnv): { created: number; migrations: string[]; backupFile: string | null } {
  // Same guards as `init`: never the home/root/temp directory, never a non-empty directory without workspace.json.
  const init = initWorkspace(root, { allowExistingDir: false, env });
  const paths = workspacePaths(root);
  const db = openDatabase(paths.dbFile);
  try {
    const r = migrate(db, { backupDir: paths.backupsDir });
    return { created: init.created.length, migrations: r.applied, backupFile: r.backupFile };
  } finally {
    db.close();
  }
}

function renderVaultInit(r: VaultInitResult): string {
  const files = r.created.filter((c) => !c.endsWith('/') && c !== '.');
  return [
    `${r.dryRun ? '[dry run] ' : ''}Vault: ${r.vaultDir}`,
    `Created ${files.length} file(s) and ${r.created.length - files.length} folder(s); left ${r.existing.length} existing file(s) untouched.`,
    ...(r.skipped.length ? [`Skipped (symlinks in the template): ${r.skipped.join(', ')}`] : []),
    '',
    'The vault is plain Markdown; Obsidian is optional and no community plugins are required.',
    'Next steps:',
    '  1. Fill in "01 Business/Business Profile.md" (human-maintained; seo-agent never writes there).',
    '  2. npm run cli -- vault import-business           # validate and preview the config diff; records nothing',
    '  3. npm run cli -- vault import-business --apply   # record the reviewed note versions',
    '  4. npm run cli -- vault apply-business            # show the site-config diff and its hash',
    '     npm run cli -- vault apply-business --confirm <diff-hash>   # write exactly that reviewed diff',
    '  5. npm run cli -- vault render                    # generate notes from the database',
  ].join('\n');
}

function renderWizardResult(r: SetupWizardResult): string {
  return `Setup ${r.status}${r.siteId ? ` for site ${r.siteId}` : ''}${r.configFile && (r.status === 'written' || r.status === 'unchanged') ? `: ${r.configFile}` : ''}.`;
}

export function register(program: Command, cli: CliRuntime): void {
  program
    .command('setup [target]')
    .description('Resumable setup wizard: asks only for missing information and saves after every answer (`setup vault` creates the site vault)')
    .option('--from <yaml>', 'import a prepared site config non-interactively (validated; unknown keys and secret values are refused)')
    .option('--update', 'change an existing site config: the diff is shown before anything is written')
    .option('--only <steps>', 'comma-separated wizard step ids or groups to ask (again), e.g. google.searchConsoleProperty or conversions (both conversion event steps)')
    .option('--list-steps', 'list the wizard step ids and step groups, and exit')
    .action(
      cli.action(async (target: string | undefined, opts: SetupOpts, cmd: Command) => {
        const g = cli.globals(cmd);
        if (opts.listSteps) {
          const steps = listWizardSteps();
          const groups = listWizardStepGroups();
          // JSON keeps the step array (backward compatible); the text view also lists the groups --only accepts.
          cli.print(g, steps, (rs: typeof steps) =>
            [
              ...rs.map((s) => `${s.id.padEnd(32)} ${s.section}${s.paths.length ? `  (${s.paths.join(', ')})` : ''}`),
              '',
              'Groups (--only <group> asks every step in it):',
              ...groups.map((x) => `${x.group.padEnd(32)} ${x.stepIds.join(', ')}`),
            ].join('\n'),
          );
          return;
        }
        if (target === 'vault') return setupVault(cli, g);
        if (target !== undefined) throw new AppError('VALIDATION_FAILED', `Unknown setup target "${target}". Use \`setup\` or \`setup vault\`.`);
        if (opts.from) return importConfig(cli, g, opts);
        return wizard(cli, g, opts, program);
      }),
    );
}

async function setupVault(cli: CliRuntime, g: GlobalOptions): Promise<void> {
  const ctx = cli.context(g);
  try {
    const result = initSiteVault({ templateDir: appDirs.vaultTemplate(), vaultRoot: ctx.paths.vaultRoot, siteId: ctx.siteId, businessName: ctx.config.site.businessName, dryRun: ctx.dryRun });
    if (!ctx.dryRun && result.created.length) createVaultWriter(ctx).appendSystemLog(`Vault initialized from template by setup: ${result.created.length} item(s) created, ${result.existing.length} existing left untouched.`);
    cli.print(g, result, renderVaultInit);
  } finally {
    ctx.db.close();
  }
}

async function importConfig(cli: CliRuntime, g: GlobalOptions, opts: SetupOpts): Promise<void> {
  const paths = cli.workspace(g);
  let workspaceCreated = false;
  if (!readManifest(paths)) {
    if (g.dryRun) throw new AppError('WORKSPACE_MISSING', `No workspace found at ${paths.root}; a dry run creates nothing.`, { hint: 'Run `npm run cli -- init` first.' });
    const w = createWorkspace(paths.root, cli.env);
    workspaceCreated = true;
    cli.io.err(`Created the private workspace at ${paths.root} (${w.created} item(s); database initialized).`);
  }
  cli.requireWorkspace(g);
  const manifest = readManifest(paths)!;
  const secrets = new LayeredSecretStore(paths.secretsEnvFile, cli.env);
  const source = path.resolve(opts.from!);
  const plan = planImport(paths, source, { siteFlag: g.site, workspaceKind: manifest.kind, secrets });
  const draft = listDrafts(paths).find((d) => d.siteId === plan.siteId);
  const base = {
    source,
    siteId: plan.siteId,
    profile: plan.config.profile,
    configFile: plan.file,
    exists: plan.exists,
    diff: plan.diff?.unified ?? null,
    warnings: plan.warnings,
    workspaceCreated,
    ...(draft ? { unfinishedDraft: draft.file } : {}),
  };
  if (plan.exists && !opts.update) {
    if (!g.json && plan.changed) cli.io.err(`Differences from the existing config:\n${plan.diff?.unified ?? ''}`);
    throw new AppError('CONFLICT', `Site config ${plan.file} already exists; it was not changed.`, {
      hint: plan.changed ? `Re-run with --update to apply the changes shown (a backup of the current file is kept): npm run cli -- setup --from ${opts.from} --update` : 'The file already has exactly this content.',
    });
  }
  if (g.dryRun) {
    cli.print(g, { ...base, status: 'dry_run', changed: plan.changed }, (r) =>
      [
        `[dry run] ${r.exists ? (r.changed ? `Would update ${r.configFile}:` : `${r.configFile} already has this content.`) : `Would create ${r.configFile} (site ${r.siteId}, profile ${r.profile}).`}`,
        ...(r.exists && r.changed ? [r.diff] : []),
        ...r.warnings.map((w: string) => `Warning: ${w}`),
        'Nothing was written.',
      ].join('\n'),
    );
    return;
  }
  if (plan.exists && !plan.changed) {
    cli.print(g, { ...base, status: 'unchanged' }, (r) => `${r.configFile} already has exactly this content; nothing was written.`);
    return;
  }
  if (plan.exists && !g.json) cli.io.out(`Changes to ${plan.file}:\n${plan.diff?.unified ?? ''}`);
  const written = writeConfigFile(paths, plan, { update: !!opts.update, secrets, now: new Date() });
  const nextSteps = [
    `npm run cli -- doctor --site ${plan.siteId}           # no network, no spending`,
    `npm run cli -- setup --update --site ${plan.siteId}   # fill in anything still missing (interactive)`,
    `npm run cli -- setup vault --site ${plan.siteId}      # create the Markdown vault`,
  ];
  cli.print(g, { ...base, status: written.created ? 'created' : 'updated', backupFile: written.backupFile, nextSteps }, (r) =>
    [
      `${r.status === 'created' ? 'Created' : 'Updated'} ${r.configFile} from ${r.source} (site ${r.siteId}, profile ${r.profile}; mode 0600).`,
      ...(r.backupFile ? [`Previous version kept at ${r.backupFile}`] : []),
      ...r.warnings.map((w: string) => `Warning: ${w}`),
      ...(r.unfinishedDraft ? [`Note: an unfinished setup draft for this site was left untouched: ${r.unfinishedDraft}`] : []),
      '',
      'Next steps:',
      ...nextSteps.map((s, i) => `  ${i + 1}. ${s}`),
    ].join('\n'),
  );
}

async function wizard(cli: CliRuntime, g: GlobalOptions, opts: SetupOpts, program: Command): Promise<void> {
  if (g.dryRun) {
    throw new AppError('VALIDATION_FAILED', '--dry-run applies to `setup --from <file>` (validate and show the diff without writing). The interactive wizard saves each answer to a private draft and asks before writing the config.');
  }
  const paths = cli.workspace(g);
  const io = redactingIO(setupCliDeps.createPromptIO());
  try {
    if (!readManifest(paths)) {
      const create = await askYesNo(io, 'workspace.create', `No workspace at ${paths.root}. Create it now (private; existing files are never overwritten)? [Y/n]: `, true);
      if (!create) throw new AppError('WORKSPACE_MISSING', `No workspace found at ${paths.root}`, { hint: 'Run `npm run cli -- init` (or pass --workspace <dir>).' });
      const w = createWorkspace(paths.root, cli.env);
      io.print(`Created the private workspace at ${paths.root} (${w.created} item(s); database initialized).`);
    }
    cli.requireWorkspace(g);
    const secrets = new LayeredSecretStore(paths.secretsEnvFile, cli.env);
    const services = setupCliDeps.createServices(paths, secrets, { offline: !!g.offline });
    const result = await runSetupWizard({
      io,
      paths,
      secrets,
      services,
      offline: !!g.offline,
      siteId: g.site,
      update: !!opts.update,
      only: opts.only
        ? opts.only
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      availableCommands: new Set(program.commands.map((c) => c.name())),
    });
    if (g.json) cli.print(g, result);
    else if (result.status === 'interrupted' || result.status === 'declined') cli.io.err(renderWizardResult(result));
    if (result.status === 'interrupted') process.exitCode = 130;
  } catch (err) {
    if (err instanceof SetupInterruptedError) {
      cli.io.err('Setup interrupted before anything was saved.');
      process.exitCode = 130;
      return;
    }
    throw err;
  } finally {
    io.close();
  }
}

/** Defense in depth: everything the wizard displays passes through secret redaction (hidden input is untouched). */
function redactingIO(io: PromptIO): PromptIO {
  return {
    print: (text) => io.print(redactString(text)),
    ask: (question, meta) => io.ask(redactString(question), meta),
    askSecret: (question, meta) => io.askSecret(question, meta),
    close: () => io.close(),
  };
}

async function askYesNo(io: PromptIO, key: string, question: string, def: boolean): Promise<boolean> {
  const parse = yesNo(def);
  for (let i = 0; i < 10; i++) {
    const r = parse(await io.ask(question, { key }));
    if (r.ok) return r.value;
    io.print(`  Invalid: ${r.error}`);
  }
  return false;
}
