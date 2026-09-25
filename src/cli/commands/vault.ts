import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { ownerActor, resolveApprover } from '../../approvals/approver.js';
import { appDirs, siteVaultDir } from '../../config/paths.js';
import { AppError } from '../../core/errors.js';
import { applyBusinessProfile, importBusinessNotes, listBusinessNoteVersions, type ApplyBusinessResult, type BusinessImportResult, type BusinessNoteVersionView } from '../../obsidian/business-sync.js';
import { checkVault, type VaultCheckReport } from '../../obsidian/check.js';
import { renderAll, RENDER_KINDS, type RenderKind, type RenderSummary } from '../../obsidian/notes.js';
import { collectDashboardStatuses } from '../../obsidian/status.js';
import { initSiteVault, type VaultInitResult } from '../../obsidian/template.js';
import { createVaultWriter, type ResolveResult } from '../../obsidian/writer.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `vault` commands: the Obsidian-compatible vault for one site.
 *   vault init              create the site vault from the template (never overwrites)
 *   vault render            regenerate notes from SQLite (human edits preserved; conflicts reported)
 *   vault check             broken wikilinks, conflicts, malformed notes
 *   vault import-business   validate 01 Business notes and show the config diff; --apply records versions
 *   vault apply-business    show the config diff of the recorded business profile; --confirm <hash> writes it
 *   vault business-history  version history of imported business notes
 *   vault resolve <path>    resolve a conflict (--use-generated or --detach)
 */

function renderInit(r: VaultInitResult): string {
  const files = r.created.filter((c) => !c.endsWith('/') && c !== '.');
  return [
    `${r.dryRun ? '[dry run] ' : ''}Vault: ${r.vaultDir}`,
    `Created ${files.length} file(s) and ${r.created.length - files.length} folder(s); left ${r.existing.length} existing file(s) untouched.`,
    ...(r.skipped.length ? [`Skipped (symlinks in the template): ${r.skipped.join(', ')}`] : []),
    '',
    'Next steps:',
    '  1. Fill in "01 Business/Business Profile.md" (human-maintained; seo-agent never writes there).',
    '  2. npm run cli -- vault import-business           # validate and preview the config diff; records nothing',
    '  3. npm run cli -- vault import-business --apply   # record the reviewed note versions',
    '  4. npm run cli -- vault apply-business            # show the site-config diff and its hash',
    '     npm run cli -- vault apply-business --confirm <diff-hash>   # write exactly that reviewed diff',
    '  5. npm run cli -- vault render                    # generate notes from the database',
    '  Optional: open the folder above as a vault in Obsidian. It is plain Markdown and works without plugins.',
  ].join('\n');
}

function renderRender(r: RenderSummary): string {
  if (r.status === 'disabled') return `Vault rendering is disabled: ${r.detail}`;
  const lines = [`${r.dryRun ? '[dry run] ' : ''}Vault render (${r.vaultDir}): ${r.detail}.`];
  if (Object.keys(r.byKind).length) lines.push(`By type: ${Object.entries(r.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (r.conflicts.length) {
    lines.push('', 'Conflicts (these notes were NOT overwritten):');
    for (const c of r.conflicts) lines.push(`  ${c.relPath}${c.conflictPath ? ` -> proposed version: ${c.conflictPath}` : ''}${c.reason ? `\n    reason: ${c.reason}` : ''}`);
    lines.push('Resolve: npm run cli -- vault resolve "<note path>" --use-generated (or --detach), then vault render.');
  }
  if (r.errors.length) {
    lines.push('', 'Errors:');
    for (const e of r.errors) lines.push(`  ${e.relPath ?? e.key}: ${e.error}`);
  }
  if (r.withdrawn.length) {
    lines.push('', 'Not written and not linked from other notes (they failed and do not exist on disk):');
    for (const w of r.withdrawn) lines.push(`  ${w.relPath} (${w.reason})`);
  }
  return lines.join('\n');
}

function renderCheck(r: VaultCheckReport): string {
  const lines = [`Vault check (${r.vaultDir}): ${r.notesScanned} notes, ${r.linksChecked} links checked; ${r.counts.errors} error(s), ${r.counts.warnings} warning(s), ${r.counts.info} info.`];
  for (const i of r.issues) lines.push(`  [${i.severity}] ${i.code} ${i.relPath}${i.line ? `:${i.line}` : ''}: ${i.detail}`);
  if (r.ok) lines.push(r.issues.length ? 'No errors.' : 'No problems found.');
  return lines.join('\n');
}

function renderImport(r: BusinessImportResult): string {
  const lines = [`${r.dryRun ? '[dry run] ' : ''}Business notes in ${r.vaultDir}/01 Business (${r.apply ? 'recording versions' : 'preview only; nothing recorded'}):`];
  for (const n of r.notes) {
    const where = n.version ? ` (v${n.version}${n.revision ? `, revision ${n.revision}` : ''}${n.recordedStatus ? `, ${n.recordedStatus}` : ''})` : '';
    lines.push(`  ${n.relPath}: ${n.status}${where}${n.noteType ? ` [${n.noteType}]` : ''}${n.returnsToVersion && n.status !== 'already_recorded' ? ` (returns to the content of v${n.returnsToVersion})` : ''}`);
    for (const e of n.errors) lines.push(`    ERROR: ${e}`);
    for (const w of n.warnings) lines.push(`    warning: ${w}`);
  }
  if (!r.notes.length) lines.push('  (no notes)');
  if (r.profile) {
    lines.push('', `Config diff from ${r.profile.relPath}:`);
    lines.push(...(r.profile.lines.length ? r.profile.lines.map((l) => `  ${l}`) : ['  (no changes: the site config already matches)']));
    lines.push('The site config is NOT changed by this command.');
  }
  lines.push('', `Next step: ${r.nextStep}`);
  return lines.join('\n');
}

function renderApply(r: ApplyBusinessResult): string {
  const lines = [`Business profile ${r.relPath} (version ${r.version ?? '?'}, ${r.versionId}): ${r.status}`];
  if (r.lines.length) lines.push('', 'Config diff:', ...r.lines.map((l) => `  ${l}`));
  lines.push('', `Diff hash: ${r.diffHash}`, `Next step: ${r.nextStep}`);
  return lines.join('\n');
}

function renderHistory(rows: BusinessNoteVersionView[]): string {
  if (!rows.length) return 'No business note versions recorded yet. Run: npm run cli -- vault import-business --apply';
  return rows
    .map(
      (r) =>
        `${r.notePath} v${r.version ?? '?'}${r.current ? ' (current)' : ''} ${r.status} · imported ${r.importedAt} · trust ${r.trustClass ?? 'none'} · ${r.contentHash.slice(0, 12)}` +
        (r.revisions.length ? `\n  revisions: ${r.revisions.join(', ')}` : '') +
        r.applications.map((a) => `\n  applied as config v${a.configVersion}${a.configChanged ? '' : ' (reused identical config version)'} by ${a.appliedBy} at ${a.appliedAt}`).join('') +
        (!r.applications.length && r.appliedConfigVersion ? `\n  applied as config v${r.appliedConfigVersion} by ${r.appliedBy} at ${r.appliedAt}` : '') +
        (r.errors.length ? `\n  errors: ${r.errors.join('; ')}` : ''),
    )
    .join('\n');
}

function parseKinds(value: string | undefined): RenderKind[] | undefined {
  if (!value) return undefined;
  const kinds = value.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = kinds.filter((k) => !(RENDER_KINDS as readonly string[]).includes(k));
  if (bad.length) throw new AppError('VALIDATION_FAILED', `Unknown note kind(s): ${bad.join(', ')}. Use: ${RENDER_KINDS.join(', ')}`);
  return kinds as RenderKind[];
}

export function register(program: Command, cli: CliRuntime): void {
  const vault = program.command('vault').description('Obsidian-compatible Markdown vault: init, render, check, business-note sync');

  vault
    .command('init')
    .description('Create the site vault from the template (never overwrites existing files)')
    .action(
      cli.action(async (_opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const result = initSiteVault({ templateDir: appDirs.vaultTemplate(), vaultRoot: ctx.paths.vaultRoot, siteId: ctx.siteId, businessName: ctx.config.site.businessName, dryRun: ctx.dryRun });
          if (!ctx.dryRun && result.created.length) createVaultWriter(ctx).appendSystemLog(`Vault initialized from template: ${result.created.length} item(s) created, ${result.existing.length} existing left untouched.`);
          cli.print(g, result, renderInit);
        } finally {
          ctx.db.close();
        }
      }),
    );

  vault
    .command('render')
    .description('Regenerate notes from SQLite; human text outside generated markers is preserved and edited notes get conflict artifacts')
    .option('--only <kinds>', `comma-separated subset: ${RENDER_KINDS.join(', ')}`)
    .action(
      cli.action(async (opts: { only?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const only = parseKinds(opts.only);
        const ctx = cli.context(g);
        try {
          const writer = createVaultWriter(ctx);
          // Offline statuses only: rendering never makes network requests.
          const status = await collectDashboardStatuses(ctx, writer.vaultDir);
          const result = renderAll(ctx, writer, { ...(only ? { only } : {}), integrationStatuses: status.statuses, integrationStatusNote: status.note });
          const initialized = existsSync(path.join(writer.vaultDir, '01 Business'));
          cli.print(g, { ...result, vaultInitialized: initialized }, (r: RenderSummary) =>
            initialized || ctx.dryRun ? renderRender(r) : `${renderRender(r)}\nNote: the business-note templates are missing. Run \`npm run cli -- vault init\` (never overwrites).`,
          );
          if (result.status === 'disabled') process.exitCode = 3;
          else if (result.errors.length) process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  vault
    .command('check')
    .description('Check broken or ambiguous wikilinks, conflicts, edited generated regions, and malformed notes')
    .action(
      cli.action(async (_opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const result = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: siteVaultDir(ctx.paths, ctx.siteId) });
          cli.print(g, result, renderCheck);
          if (!result.ok) process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  vault
    .command('import-business')
    .description('Validate human notes in "01 Business" and show the config diff; --apply records versions (never changes the config)')
    .option('--apply', 'record new note versions in the database (rejected notes are recorded with their errors)')
    .action(
      cli.action(async (opts: { apply?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const result = importBusinessNotes(ctx, { apply: !!opts.apply, dryRun: ctx.dryRun });
          if (opts.apply && !ctx.dryRun && result.recorded) createVaultWriter(ctx).appendSystemLog(`Business notes recorded: ${result.recorded} version(s), ${result.rejected} rejected.`);
          cli.print(g, result, renderImport);
          if (result.rejected) process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  vault
    .command('apply-business')
    .description('Show the site-config diff of the recorded business profile; with --confirm <diff-hash>, write it as a new config version')
    .option('--confirm <diffHash>', 'the diff hash shown by the preview; binds the change to exactly the reviewed diff')
    .option('--by <name>', 'the named human confirming (recorded in the audit log as asserted, not authenticated; defaults to your operating-system user unless it is a service account such as node or runner; obvious automation or account names such as system, claude, owner, or root are refused)')
    .action(
      cli.action(async (opts: { confirm?: string; by?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        // Writing the reviewed diff is a human decision: the actor is a named human (--by, else the OS user),
        // validated like an approver. A preview records nothing, so it only validates an explicit --by.
        const actor = opts.confirm || opts.by !== undefined ? ownerActor(resolveApprover(opts.by)) : undefined;
        const ctx = cli.context(g);
        try {
          const writer = createVaultWriter(ctx);
          const result = applyBusinessProfile(ctx, {
            ...(opts.confirm ? { confirmHash: opts.confirm } : {}),
            ...(actor ? { actor } : {}),
            dryRun: ctx.dryRun,
            log: (line) => writer.appendSystemLog(line),
          });
          cli.print(g, result, renderApply);
        } finally {
          ctx.db.close();
        }
      }),
    );

  vault
    .command('business-history')
    .description('List recorded versions of business notes')
    .option('--note <path>', 'vault-relative note path, e.g. "01 Business/Business Profile.md"')
    .action(
      cli.action(async (opts: { note?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          cli.print(g, listBusinessNoteVersions(ctx, opts.note), renderHistory);
        } finally {
          ctx.db.close();
        }
      }),
    );

  vault
    .command('resolve <relPath>')
    .description('Resolve a vault conflict: --use-generated (back up, then let the next render replace the generated region) or --detach (keep the note as human-owned)')
    .option('--use-generated', 'accept regeneration of the generated region; text outside the markers is preserved')
    .option('--detach', 'stop generating this note; it becomes human-owned')
    .action(
      cli.action(async (relPath: string, opts: { useGenerated?: boolean; detach?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (!!opts.useGenerated === !!opts.detach) throw new AppError('VALIDATION_FAILED', 'Choose exactly one of --use-generated or --detach.');
        const ctx = cli.context(g);
        try {
          const result: ResolveResult = createVaultWriter(ctx).resolveConflict(relPath, opts.detach ? 'detach' : 'use_generated', 'cli');
          cli.print(g, result, (r: ResolveResult) => [`${ctx.dryRun ? '[dry run] ' : ''}Resolved ${r.relPath} (${r.mode}).`, ...(r.backupPath ? [`Backup: ${r.backupPath}`] : []), `Next step: ${r.nextStep}`].join('\n'));
        } finally {
          ctx.db.close();
        }
      }),
    );
}
