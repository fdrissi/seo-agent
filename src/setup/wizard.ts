import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { googleCredentialPaths } from '../auth/paths.js';
import { systemClock, type Clock } from '../core/clock.js';
import { AppError, ConfigError, errorMessage } from '../core/errors.js';
import { parseYamlSafe } from '../config/load.js';
import { siteConfigFile, siteVaultDir, type WorkspacePaths } from '../config/paths.js';
import type { SecretStore } from '../config/secrets.js';
import { safeParseSiteConfig } from '../config/site-schema.js';
import { assertProfileMatchesWorkspace, readManifest } from '../config/workspace.js';
import { applyToExistingConfig, planConfigWrite, renderNewConfig, writeConfigFile, type ConfigWritePlan } from './config-file.js';
import { SITE_ID_RE, deleteDraft, draftFile, listDrafts, loadDraft, newDraft, saveDraft, type SetupDraft } from './draft.js';
import { choice, yesNo, type Parser } from './parse.js';
import { SetupInterruptedError, type PromptIO } from './prompt-io.js';
import { assertNoKnownSecrets, featuresOf, secretNeeds } from './secrets.js';
import { WizardSession, type SetupServices } from './session.js';
import { DemoProfileSelected, resolveStepSelectors, stepIsMissing, stepsForErrorPath, wizardStepGroups, wizardSteps, type WizardStep } from './steps.js';
import { PROFILE_INFO } from './profiles.js';
import { getAt, isPlainObject, type Values } from './values.js';

/**
 * Interactive, resumable setup wizard (spec section 3).
 *
 * - Asks only for missing information: answered steps (draft) and values
 *   already present in an existing config (update mode) are skipped.
 * - Asks for the site ID first (the 0600 draft file is named after it), then
 *   saves progress after every answer, including the profile, so an
 *   interrupted run resumes where it stopped. An interruption before the site
 *   ID is known saves nothing and says so.
 * - Secrets go through a hidden prompt straight into the protected secrets
 *   file (or are left for environment injection); they never reach the draft,
 *   the site config, or any output.
 * - Writes <workspace>/config/sites/<id>.yaml only when the whole config
 *   validates, never overwriting an existing file without --update (which
 *   shows a diff and asks first).
 */

export interface SetupWizardOptions {
  io: PromptIO;
  paths: WorkspacePaths;
  secrets: SecretStore;
  clock?: Clock;
  services?: SetupServices;
  offline?: boolean;
  /** --site */
  siteId?: string | undefined;
  /** --update: allow changing an existing config (diff shown, confirmation asked). */
  update?: boolean;
  /** --only: step ids or step groups (e.g. "conversions", "google") to (re-)ask even when already answered. */
  only?: string[] | undefined;
  /** Command names available in this build (next steps only mention these). */
  availableCommands?: ReadonlySet<string>;
}

export type SetupStatus = 'written' | 'unchanged' | 'declined' | 'demo' | 'interrupted';

export interface SetupWizardResult {
  status: SetupStatus;
  siteId: string | null;
  mode: 'create' | 'update' | null;
  configFile: string | null;
  draftFile: string | null;
  backupFile: string | null;
  diff: string | null;
  warnings: string[];
  /** Names of secrets stored in the protected secrets file during this run (never values). */
  storedSecrets: string[];
  /** Credentials the enabled features need that are still missing (names only). */
  missingSecrets: Array<{ key: string; optional: boolean }>;
  nextSteps: string[];
}

const SITE_ID_HELP = 'Site ID: a short stable identifier used in every database row, job, budget, and vector (lowercase letters, digits, hyphens; e.g. "acme-shop").';

async function askDirect<T>(io: PromptIO, key: string, question: string, parse: Parser<T>): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const r = parse(await io.ask(question, { key }));
    if (r.ok) return r.value;
    io.print(`  Invalid: ${r.error}`);
  }
  throw new AppError('VALIDATION_FAILED', `Too many invalid answers for ${key}.`);
}

const siteIdParser: Parser<string> = (raw) => {
  const v = raw.trim();
  if (!SITE_ID_RE.test(v)) return { ok: false, error: 'Use 2-63 lowercase letters, digits, and hyphens, starting with a letter or digit (e.g. acme-shop).' };
  return { ok: true, value: v };
};

function readExistingConfig(paths: WorkspacePaths, siteId: string): { text: string; values: Values } {
  const file = siteConfigFile(paths, siteId);
  if (!existsSync(file)) throw new AppError('CONFIG_MISSING', `No site config for "${siteId}" at ${file}.`, { hint: 'Run `npm run cli -- setup` (without --update) to create it.' });
  const text = readFileSync(file, 'utf8');
  const raw = parseYamlSafe(text, file);
  if (!isPlainObject(raw)) throw new ConfigError(`${file} is not a YAML mapping.`);
  return { text, values: raw };
}

/** A draft holding nothing but the site id (no step answered, no partial answer). */
function isEmptyDraft(d: SetupDraft): boolean {
  return d.answered.every((a) => a === 'site.id') && Object.values(d.partial).every((p) => !Object.keys(p).length);
}

function emptyResult(status: SetupStatus): SetupWizardResult {
  return { status, siteId: null, mode: null, configFile: null, draftFile: null, backupFile: null, diff: null, warnings: [], storedSecrets: [], missingSecrets: [], nextSteps: [] };
}

export async function runSetupWizard(opts: SetupWizardOptions): Promise<SetupWizardResult> {
  const { io, paths, secrets } = opts;
  const clock = opts.clock ?? systemClock;
  const manifest = readManifest(paths);
  if (!manifest) throw new AppError('WORKSPACE_MISSING', `No workspace found at ${paths.root}`, { hint: 'Run `npm run cli -- init` first.' });
  mkdirSync(paths.sitesDir, { recursive: true, mode: 0o700 });
  let only: Set<string> | null = null;
  if (opts.only?.length) {
    // Exact step ids or groups ("conversions" = conversions.primaryEvents + conversions.secondaryEvents).
    const sel = resolveStepSelectors(opts.only);
    if (sel.unknown.length) {
      const groups = wizardStepGroups().map((g) => g.group);
      throw new AppError('VALIDATION_FAILED', `Unknown step id(s) or group(s): ${sel.unknown.join(', ')}.`, {
        hint: `Use a step id or a group (${groups.join(', ')}). List them with \`npm run cli -- setup --list-steps\`.`,
      });
    }
    if (sel.stepIds.length) only = new Set(sel.stepIds);
  }

  let draft: SetupDraft | null = null;
  let session: WizardSession | null = null;
  /** True when this run created the draft file (so a refusal can remove it again). */
  let createdDraft = false;
  try {
    // 1. Resume a draft when there is one.
    if (opts.siteId) {
      const r = siteIdParser(opts.siteId);
      if (!r.ok) throw new AppError('VALIDATION_FAILED', `--site: ${r.error}`);
      draft = loadDraft(paths, opts.siteId);
    } else {
      const drafts = listDrafts(paths).filter((d) => d.valid);
      if (drafts.length === 1) {
        const d = drafts[0]!;
        const resume = await askDirect(io, 'resume', `Resume the unfinished setup for site "${d.siteId}" (${d.answered} step(s) answered, saved ${d.updatedAt ?? 'earlier'})? [Y/n]: `, yesNo(true));
        if (resume) draft = loadDraft(paths, d.siteId);
      } else if (drafts.length > 1) {
        io.print(`Unfinished setups: ${drafts.map((d) => d.siteId).join(', ')}`);
        const pick = await askDirect(io, 'resume.site', `Resume which site? (${drafts.map((d, i) => `${i + 1}) ${d.siteId}`).join(', ')}, or "new") [new]: `, choice([...drafts.map((d) => d.siteId), 'new'], 'new'));
        if (pick !== 'new') draft = loadDraft(paths, pick);
      }
    }

    let base: Values = {};
    if (draft) {
      const exists = existsSync(siteConfigFile(paths, draft.siteId));
      if (draft.mode === 'update' && !opts.update) {
        throw new AppError('CONFLICT', `The unfinished setup for "${draft.siteId}" updates an existing config.`, { hint: `Resume it with: npm run cli -- setup --update --site ${draft.siteId}` });
      }
      if (draft.mode === 'create' && exists) {
        throw new AppError('CONFLICT', `A site config for "${draft.siteId}" was created after this setup draft started; the draft was not applied.`, {
          hint: `Use \`npm run cli -- setup --update --site ${draft.siteId}\` after removing the old draft (${draftFile(paths, draft.siteId)}).`,
        });
      }
      if (draft.mode === 'update') base = readExistingConfig(paths, draft.siteId).values;
      io.print(`Resuming setup for site "${draft.siteId}": ${draft.answered.length} step(s) already answered; only missing information is asked.`);
    } else if (opts.update) {
      // 2a. Update an existing config: only the site id is needed to start.
      io.print('Updating an existing site configuration. Only missing information is asked; a diff is shown before anything is written.');
      const siteId = opts.siteId ?? (await askDirect(io, 'site.id', 'Site ID of the config to update: ', siteIdParser));
      if (!existsSync(siteConfigFile(paths, siteId))) {
        throw new AppError('CONFIG_MISSING', `No site config for "${siteId}" to update.`, { hint: 'Run `npm run cli -- setup` (without --update) to create it.' });
      }
      base = readExistingConfig(paths, siteId).values;
      draft = newDraft(siteId, 'update', clock.now());
      saveDraft(paths, draft, clock.now(), secrets);
      createdDraft = true;
    } else {
      // 2b. New config: the site id first. The draft file is named after it, so from here on
      // every answer (the profile, asked first by the step loop, included) is saved.
      if (opts.siteId && existsSync(siteConfigFile(paths, opts.siteId))) {
        throw new AppError('CONFLICT', `A site config for "${opts.siteId}" already exists at ${siteConfigFile(paths, opts.siteId)}; it was not changed.`, {
          hint: `To add missing information or change it, run: npm run cli -- setup --update --site ${opts.siteId} (a diff is shown before writing).`,
        });
      }
      io.print('seo-agent setup. Once the site ID is set, answers are saved after every question; press Ctrl+C at any time and run setup again to resume.');
      io.print('Secrets are never asked in plain text here; you can enter them with hidden input later or inject them through the environment.\n');
      if (!opts.siteId) io.print(SITE_ID_HELP);
      const siteId = opts.siteId ?? (await askDirect(io, 'site.id', 'Site ID: ', siteIdParser));
      if (existsSync(siteConfigFile(paths, siteId))) {
        throw new AppError('CONFLICT', `A site config for "${siteId}" already exists at ${siteConfigFile(paths, siteId)}; it was not changed.`, {
          hint: `To add missing information or change it, run: npm run cli -- setup --update --site ${siteId} (a diff is shown before writing).`,
        });
      }
      draft = loadDraft(paths, siteId);
      if (draft) {
        if (draft.mode !== 'create') throw new AppError('CONFLICT', `An unfinished update draft exists for "${siteId}".`, { hint: `Resume it with: npm run cli -- setup --update --site ${siteId}` });
        io.print(`An unfinished setup for "${siteId}" exists; resuming it.`);
      } else {
        draft = newDraft(siteId, 'create', clock.now());
        draft.values = { site: { id: siteId } };
        draft.answered = ['site.id'];
        saveDraft(paths, draft, clock.now(), secrets);
        createdDraft = true;
        io.print(`Progress is saved to ${draftFile(paths, siteId)} (mode 0600).`);
      }
    }

    // 3. Ask the missing steps.
    session = new WizardSession({ io, paths, secrets, clock, services: opts.services ?? {}, offline: !!opts.offline, draft, base, workspaceKind: manifest.kind, only });
    const steps = wizardSteps();
    let section = '';
    const runStep = async (step: WizardStep) => {
      if (step.section !== section) {
        section = step.section;
        io.print(`\n== ${section} ==`);
      }
      await step.run(session!);
      session!.finishStep(step.id);
    };
    for (const step of steps) {
      if (step.applies && !step.applies(session)) {
        if (only?.has(step.id)) io.print(`Step ${step.id} does not apply to this configuration (profile or features); it was not asked.`);
        continue;
      }
      // A step interrupted mid-way (partial answers saved, e.g. one started with --only) is always
      // finished on resume, so its saved answers are never dropped silently.
      const interrupted = !draft.answered.includes(step.id) && Object.keys(draft.partial[step.id] ?? {}).length > 0;
      const forced = !!only?.has(step.id);
      if (only && !forced && !interrupted) continue;
      if (!forced && !interrupted && (draft.answered.includes(step.id) || !stepIsMissing(step, session))) continue;
      // A completed step is re-opened when forced; a forced step interrupted mid-way keeps its partial answers.
      if (forced && draft.answered.includes(step.id)) session.reopenStep(step.id);
      await runStep(step);
    }

    // 4. Validate the whole config; re-ask the steps behind any error.
    for (let round = 0; ; round++) {
      const r = safeParseSiteConfig(session.values());
      if (r.ok) break;
      io.print('\nThe configuration does not validate yet:');
      for (const e of r.errors) io.print(`  - ${e}`);
      const redo = [...new Set(r.errors.flatMap((e) => stepsForErrorPath(e.split(': ')[0] ?? '', steps)))].filter((st) => !st.applies || st.applies(session!));
      if (!redo.length || round >= 2) {
        throw new ConfigError('The configuration is still invalid; nothing was written. Your answers are saved in the draft.', { details: { errors: r.errors }, hint: 'Run setup again to resume, or fix the listed fields with `setup --only <step>`.' });
      }
      for (const st of redo) {
        session.reopenStep(st.id);
        await runStep(st);
      }
    }

    // 5. Build the file text, show it (or the diff), confirm, write.
    const siteId = draft.siteId;
    let plan: ConfigWritePlan;
    if (draft.mode === 'update') {
      const current = readExistingConfig(paths, siteId);
      plan = planConfigWrite(paths, siteId, applyToExistingConfig(current.text, draft.values));
    } else {
      plan = planConfigWrite(paths, siteId, renderNewConfig(session.values(), clock.now()));
    }
    // Demo/live separation: whatever the answers or the existing file say, the profile must match the workspace kind.
    assertProfileMatchesWorkspace(manifest.kind, plan.config.profile, { root: paths.root, siteId });
    // Never display (or later write) a config that contains a known secret value, e.g. one pasted into the existing file by hand.
    assertNoKnownSecrets(plan.proposedText, secrets, `the site config ${plan.file}`);
    if (plan.currentText !== null) assertNoKnownSecrets(plan.currentText, secrets, `a diff of ${plan.file} (the existing file contains a secret value; remove it by hand first)`);
    for (const w of plan.warnings) io.print(`Warning: ${w}`);
    const result: SetupWizardResult = {
      ...emptyResult('written'),
      siteId,
      mode: draft.mode,
      configFile: plan.file,
      draftFile: draftFile(paths, siteId),
      diff: plan.diff?.unified ?? null,
      warnings: plan.warnings,
      storedSecrets: [...session.storedSecrets],
    };
    if (plan.exists && !plan.changed) {
      io.print(`\nNo changes: ${plan.file} already contains these values.`);
      deleteDraft(paths, siteId);
      return finish({ ...result, status: 'unchanged', draftFile: null }, session, opts);
    }
    if (plan.exists) io.print(`\nChanges to ${plan.file}:\n${plan.diff?.unified ?? ''}`);
    else io.print(`\nProposed configuration for ${plan.file}:\n${plan.proposedText}`);
    const confirmed = await askDirect(io, 'confirm.write', `${plan.exists ? 'Apply these changes' : 'Write this configuration'}? [Y/n]: `, yesNo(true));
    if (!confirmed) {
      io.print(`Nothing was written. Your answers are kept in ${draftFile(paths, siteId)}; run setup again to resume.`);
      return finish({ ...result, status: 'declined' }, session, opts);
    }
    const written = writeConfigFile(paths, plan, { update: draft.mode === 'update', secrets, now: clock.now() });
    deleteDraft(paths, siteId);
    io.print(`\nSaved ${written.file} (mode 0600).${written.backupFile ? ` Previous version: ${written.backupFile}` : ''}`);
    return finish({ ...result, status: 'written', draftFile: null, backupFile: written.backupFile }, session, opts);
  } catch (err) {
    if (err instanceof SetupInterruptedError) {
      const file = draft ? draftFile(paths, draft.siteId) : null;
      const saved = !!file && existsSync(file);
      if (saved) {
        io.print(`\nSetup interrupted. Progress is saved in ${file}. Run \`npm run cli -- setup --site ${draft!.siteId}${draft!.mode === 'update' ? ' --update' : ''}\` to resume.`);
      } else {
        // Nothing was saved by this run: never claim that there is something to resume.
        const others = listDrafts(paths).filter((d) => d.valid);
        io.print(
          others.length
            ? `\nSetup interrupted; nothing new was saved. Unfinished setup(s) for ${others.map((d) => `"${d.siteId}"`).join(', ')} can still be resumed with \`npm run cli -- setup\`.`
            : `\nSetup interrupted before any answer was saved (answers are saved once the site ID is set). Run \`npm run cli -- setup${opts.update ? ' --update' : ''}\` to start again.`,
        );
      }
      return { ...emptyResult('interrupted'), siteId: draft?.siteId ?? null, mode: draft?.mode ?? null, draftFile: saved ? file : null, storedSecrets: session ? [...session.storedSecrets] : [] };
    }
    if (err instanceof DemoProfileSelected) {
      // A draft that holds nothing but the site id is removed: nothing stays behind in the workspace.
      if (draft && isEmptyDraft(draft)) deleteDraft(paths, draft.siteId);
      io.print(['', 'Demo profile selected.', ...PROFILE_INFO.demo.notes, 'Nothing was written to this workspace.'].join('\n'));
      return { ...emptyResult('demo'), nextSteps: ['npm run demo'] };
    }
    // A refusal (for example a live profile in a demo workspace) leaves no empty draft created by this run behind.
    if (createdDraft && draft && isEmptyDraft(draft)) deleteDraft(paths, draft.siteId);
    throw err;
  }
}

function finish(result: SetupWizardResult, s: WizardSession, opts: SetupWizardOptions): SetupWizardResult {
  const values = s.values();
  const needs = secretNeeds(values);
  result.missingSecrets = needs.filter((n) => !s.secrets.has(n.key)).map((n) => ({ key: n.key, optional: n.optional }));
  result.nextSteps = nextSteps(result, s, opts);
  if (result.status === 'written' || result.status === 'unchanged') {
    s.print('\nNext steps:');
    result.nextSteps.forEach((step, i) => s.print(`  ${i + 1}. ${step}`));
  }
  return result;
}

function nextSteps(result: SetupWizardResult, s: WizardSession, opts: SetupWizardOptions): string[] {
  const has = (c: string) => !opts.availableCommands || opts.availableCommands.has(c);
  const id = s.siteId;
  const v = s.values();
  const f = featuresOf(v);
  const out: string[] = [];
  const required = result.missingSecrets.filter((m) => !m.optional).map((m) => m.key);
  const optional = result.missingSecrets.filter((m) => m.optional).map((m) => m.key);
  if (required.length) out.push(`Add the missing credentials (${required.join(', ')}) to ${s.paths.secretsEnvFile} (mode 0600) or inject them through the environment (password manager). Never paste secrets into a chat.`);
  if (optional.length) out.push(`Optional credentials not set (${optional.join(', ')}); see docs/ACCESS_SETUP.md.`);
  const googleOn = f.gsc || f.ga4 || f.urlInspection;
  if (googleOn) {
    let authorized = false;
    try {
      const gp = googleCredentialPaths(s.paths, s.secrets);
      authorized = s.secrets.get('GOOGLE_AUTH_MODE') === 'service_account' ? !!gp.serviceAccountFile && existsSync(gp.serviceAccountFile) : existsSync(gp.tokenFile);
    } catch (err) {
      out.push(`Google credential path problem: ${errorMessage(err)}`);
    }
    if (!authorized && has('auth')) {
      out.push(
        s.secrets.get('GOOGLE_AUTH_MODE') === 'service_account'
          ? 'Set GOOGLE_APPLICATION_CREDENTIALS to the service-account key file (mode 0600) and grant that identity read access in Search Console and GA4.'
          : `Authorize Google read-only access: npm run cli -- auth google --site ${id}`,
      );
    }
    const missingIds = [
      ...((f.gsc || f.urlInspection) && !getAt(v, 'google.searchConsoleProperty') ? ['google.searchConsoleProperty'] : []),
      ...(f.ga4 && !getAt(v, 'google.ga4PropertyId') ? ['google.ga4PropertyId'] : []),
    ];
    if (missingIds.length) out.push(`Set the Google property ids once authorized (\`auth status\` lists accessible properties): npm run cli -- setup --update --site ${id} --only ${missingIds.join(',')}`);
  }
  if (f.obsidian && !existsSync(siteVaultDir(s.paths, id))) out.push(`Create the Markdown vault (Obsidian optional): npm run cli -- setup vault --site ${id}`);
  if (f.qdrant) out.push('Start the local Qdrant container: docker compose up -d qdrant');
  if (f.apify && has('apify')) out.push(`Verify the Apify actor build, schema, and pricing (free): npm run cli -- apify inspect --site ${id}`);
  if (has('doctor')) out.push(`Check everything without network or spending: npm run cli -- doctor --site ${id}; then free read-only checks: npm run cli -- doctor --site ${id} --network`);
  if (has('baseline')) out.push(`Create the first baseline: npm run cli -- baseline --site ${id}`);
  return out;
}

/** Step ids with their sections, for `setup --list-steps` and `--only`. */
export function listWizardSteps(): Array<{ id: string; section: string; paths: string[] }> {
  return wizardSteps().map((s) => ({ id: s.id, section: s.section, paths: s.paths }));
}

/** Step groups accepted by `--only` (a group selects every step whose id starts with "<group>."). */
export function listWizardStepGroups(): Array<{ group: string; stepIds: string[] }> {
  return wizardStepGroups();
}
