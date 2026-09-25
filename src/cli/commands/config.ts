import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { budgetTimeZone } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { formatUsd, toMicros } from '../../core/money.js';
import { listSiteIds, loadSiteConfig, loadSiteConfigFile, parseYamlSafe, resolveRuntimeSettings, resolveSiteId } from '../../config/load.js';
import { siteConfigFile } from '../../config/paths.js';
import { LayeredSecretStore } from '../../config/secrets.js';
import { siteConfigSchema, siteConfigWarnings, type SiteConfig } from '../../config/site-schema.js';
import { ENV_KEYS, SECRET_ENV_KEYS } from '../../config/env.js';
import { GENERATED_BLOCKS, generatedBlock } from '../../config/docs.js';
import { applyConfigMigrations, planWorkspaceConfigMigrations, type ConfigMigrationPlan } from '../../config/config-migrations.js';
import type { CliRuntime } from '../runtime.js';

function renderMigrationPlan(p: ConfigMigrationPlan): string[] {
  const name = p.kind === 'workspace-manifest' ? 'workspace.json' : p.file;
  if (p.status === 'pending') return [`Pending: ${name} (version ${p.fromVersion} -> ${p.toVersion})`, ...p.steps.map((st) => `  - ${st}`), ...(p.diff ? [p.diff] : [])];
  if (p.status === 'current') return [];
  return [`Cannot migrate: ${name}${p.fromVersion !== null ? ` (version ${p.fromVersion})` : ''}`, ...p.errors.map((e) => `  - ${e}`)];
}

/**
 * Cross-site warnings: shared account caps are workspace-wide (the smallest
 * declared cap binds every site), so disagreement is worth surfacing, as are
 * different budget time zones (each site computes the account month in its own zone).
 */
export function workspaceBudgetWarnings(configs: SiteConfig[]): Map<string, string[]> {
  const out = new Map<string, string[]>(configs.map((c) => [c.site.id, []]));
  if (configs.length < 2) return out;
  const providers = [...new Set(configs.flatMap((c) => Object.keys(c.budgets.accountMonthlyUsd)))].sort();
  for (const provider of providers) {
    const declared = configs.map((c) => ({ id: c.site.id, value: c.budgets.accountMonthlyUsd[provider] ?? null }));
    const values = declared.map((d) => (d.value === null ? null : toMicros(d.value)));
    const distinct = new Set(values.map((v) => (v === null ? 'none' : String(v))));
    if (distinct.size < 2) continue;
    const known = values.filter((v): v is number => v !== null);
    const min = Math.min(...known);
    const list = declared.map((d) => `${d.id}: ${d.value === null ? 'not declared' : `$${d.value}`}`).join(', ');
    for (const d of declared) out.get(d.id)!.push(`budgets.accountMonthlyUsd.${provider}: sites in this workspace disagree (${list}); the smallest (${formatUsd(min)}) applies to every site because the provider account is shared.`);
  }
  if (providers.length) {
    const zones = new Set(configs.map((c) => budgetTimeZone(c)));
    if (zones.size > 1) {
      for (const c of configs) out.get(c.site.id)!.push(`Shared account caps are counted per budget month, and sites use different budget time zones (${[...zones].join(', ')}); near month boundaries the account month may differ between sites. Use one zone for sites sharing a provider account.`);
    }
  }
  return out;
}

/** Non-fatal warnings for a config file that already validated. */
function warningsFor(file: string, cfg: SiteConfig): string[] {
  if (!existsSync(file)) return [];
  try {
    return siteConfigWarnings(parseYamlSafe(readFileSync(file, 'utf8'), file), cfg);
  } catch {
    return [];
  }
}

export function register(program: Command, cli: CliRuntime): void {
  const config = program.command('config').description('Validate and inspect site configuration');

  config
    .command('validate')
    .description('Validate a site config (workspace site, or --file) and list non-fatal warnings')
    .option('--file <path>', 'validate a specific YAML file')
    .action(
      cli.action(async (opts: { file?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (opts.file) {
          const cfg = loadSiteConfigFile(opts.file);
          const warnings = warningsFor(opts.file, cfg);
          cli.print(g, { ok: true, file: opts.file, siteId: cfg.site.id, profile: cfg.profile, warnings }, (r) =>
            [`OK: ${r.file} (site ${r.siteId}, profile ${r.profile})`, ...r.warnings.map((w: string) => `  warning: ${w}`)].join('\n'),
          );
          return;
        }
        const paths = cli.requireWorkspace(g);
        const ids = g.site ? [g.site] : listSiteIds(paths);
        // Cross-site checks always consider every valid site in the workspace, even with --site.
        const valid: SiteConfig[] = [];
        for (const id of listSiteIds(paths)) {
          try {
            valid.push(loadSiteConfig(paths, id));
          } catch {
            // Reported below when selected.
          }
        }
        const cross = workspaceBudgetWarnings(valid);
        const results = ids.map((id) => {
          try {
            const cfg = loadSiteConfig(paths, id);
            return { siteId: id, ok: true, profile: cfg.profile, warnings: [...warningsFor(siteConfigFile(paths, id), cfg), ...(cross.get(id) ?? [])] };
          } catch (err) {
            return {
              siteId: id,
              ok: false,
              error: (err as Error).message,
              ...(err instanceof AppError ? { code: err.code } : {}),
              details: (err as { details?: unknown }).details,
            };
          }
        });
        cli.print(g, results, (rs: typeof results) =>
          rs
            .map((r) =>
              r.ok
                ? [`OK: ${r.siteId}`, ...('warnings' in r ? (r.warnings ?? []) : []).map((w) => `  warning: ${w}`)].join('\n')
                : `INVALID: ${r.siteId}: ${'error' in r ? r.error : ''}\n${JSON.stringify(('details' in r ? r.details : undefined) ?? {}, null, 2)}`,
            )
            .join('\n') || 'No sites configured.',
        );
        if (results.some((r) => !r.ok)) process.exitCode = 1;
      }),
    );

  config
    .command('show')
    .description('Show effective (non-secret) settings and where each override comes from')
    .action(
      cli.action(async (_o: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        const siteId = resolveSiteId(paths, g.site);
        const cfg = loadSiteConfig(paths, siteId);
        const secrets = new LayeredSecretStore(paths.secretsEnvFile, cli.env);
        const s = resolveRuntimeSettings(cfg, secrets);
        // Field names are deliberately not secret-looking so JSON output keeps every status readable
        // (values are never included; only where each variable comes from and whether it is set).
        const env = ENV_KEYS.map((name) => ({ name, source: secrets.sourceOf(name), isSecret: SECRET_ENV_KEYS.has(name), isSet: secrets.has(name) }));
        const result = { siteId, profile: cfg.profile, features: s.features, models: s.models, googleAuthMode: s.googleAuthMode, apify: s.apify, env, warnings: secrets.warnings() };
        cli.print(g, result, (r) =>
          [
            `Site: ${r.siteId} (profile ${r.profile})`,
            `Features: ${Object.entries(r.features).filter(([, v]) => v).map(([k]) => k).join(', ')}`,
            `Models: cheap=${r.models.cheap ?? 'unset'} (${r.models.source.cheap}), reasoning=${r.models.reasoning ?? 'unset'} (${r.models.source.reasoning}), embedding=${r.models.embedding ?? 'unset'} (${r.models.source.embedding})`,
            'Environment (values never shown):',
            ...(r.env as typeof env).map((v) => `  ${v.name}: ${v.isSet ? 'set' : 'unset'} (${v.source})${v.isSecret ? ' [secret]' : ''}`),
            ...r.warnings.map((w: string) => `Warning: ${w}`),
          ].join('\n'),
        );
      }),
    );

  config
    .command('migrate')
    .description('Upgrade site configs and workspace.json written in an older format: shows the diff; writes only with --yes (originals are copied to backups/config/<timestamp>/ first)')
    .option('--yes', 'apply the shown migration (without it, nothing is written)')
    .action(
      cli.action(async (opts: { yes?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        const plans = planWorkspaceConfigMigrations(paths);
        const pending = plans.filter((p) => p.status === 'pending');
        const blocked = plans.filter((p) => p.status !== 'pending' && p.status !== 'current');
        const apply = !!opts.yes && !g.dryRun;
        if (apply && pending.length && blocked.length) {
          throw new AppError('CONFIG_INVALID', `Nothing was migrated: ${blocked.length} file(s) cannot be migrated by this application version.`, {
            details: { errors: blocked.flatMap((b) => b.errors.map((e) => `${b.file}: ${e}`)) },
            hint: 'Fix or move those files first, then run `npm run cli -- config migrate` again.',
          });
        }
        const applied = apply && pending.length ? applyConfigMigrations(paths, plans, new Date()) : null;
        const result = {
          applied: !!applied,
          dryRun: !apply,
          backupDir: applied?.backupDir ?? null,
          written: applied?.written ?? [],
          files: plans.map((p) => ({ file: p.file, kind: p.kind, status: p.status, fromVersion: p.fromVersion, toVersion: p.toVersion, steps: p.steps, diff: p.diff, errors: p.errors })),
        };
        cli.print(g, result, () => {
          const lines = plans.flatMap(renderMigrationPlan);
          const current = plans.filter((p) => p.status === 'current').length;
          if (current) lines.push(`Up to date: ${current} file(s).`);
          if (applied) {
            lines.push(`Migrated ${applied.written.length} file(s) (mode 0600). Originals: ${applied.backupDir}`);
            lines.push('Next: npm run cli -- config validate');
          } else if (pending.length) {
            lines.push(`Nothing was written. Apply with: npm run cli -- config migrate --yes   (originals are copied to ${paths.backupsDir}/config/<timestamp>/ first)`);
          } else if (!blocked.length) {
            lines.push('No configuration migration is needed.');
          }
          return lines.join('\n');
        });
        if (blocked.length) process.exitCode = 1;
      }),
    );

  config
    .command('docs')
    .description('Print the generated configuration reference (field table, profiles, environment variables) used in docs/CONFIGURATION.md')
    .action(
      cli.action(async () => {
        cli.io.out(GENERATED_BLOCKS.map((b) => generatedBlock(b)).join('\n\n'));
      }),
    );

  config
    .command('schema')
    .description('Print the JSON Schema of the site configuration')
    .action(
      cli.action(async (_o: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        cli.print({ ...g, json: true }, z.toJSONSchema(siteConfigSchema, { io: 'input', unrepresentable: 'any' }));
      }),
    );
}
