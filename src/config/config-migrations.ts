import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, parseDocument } from 'yaml';
import { unifiedDiff } from '../approvals/diff.js';
import { AppError } from '../core/errors.js';
import { stableStringify } from '../core/hash.js';
import { atomicWriteFile } from '../obsidian/fs-safe.js';
import { listSiteIds, parseYamlSafe } from './load.js';
import { siteConfigFile, validateWorkspacePathOverrides, type WorkspacePaths } from './paths.js';
import { SITE_CONFIG_SCHEMA_VERSION, safeParseSiteConfig } from './site-schema.js';
import { WORKSPACE_FORMAT_VERSION } from './workspace.js';

/**
 * Versioned configuration migrations (preamble: "configuration/schema
 * migrations, pre-migration backups").
 *
 * - Two ordered registries of vN -> vN+1 transforms: one for the site YAML
 *   (`schemaVersion`) and one for the workspace manifest (`formatVersion`).
 *   Both are EMPTY at version 1 (there is no older format yet); tests inject
 *   a synthetic v0 -> v1 transform.
 * - Transforms are pure functions of the parsed document. Nothing migrates
 *   automatically: loading an older site config fails with CONFIG_INVALID
 *   and points at `config migrate`, which shows a diff and writes only with
 *   `--yes`, after copying every original to backups/config/<timestamp>/.
 * - The migrated YAML keeps the comments and layout of every unchanged
 *   section (only changed keys are rewritten) and must validate against the
 *   current schema before anything can be written.
 */

export interface ConfigMigration {
  /** Version this transform upgrades from; it produces `from + 1`. */
  from: number;
  /** One line shown in the plan, e.g. "rename research.serpDepth to research.dataforseo.serpDepth". */
  description: string;
  /** Pure transform of the parsed document. The runner sets the version field afterwards. */
  migrate(doc: Record<string, unknown>): Record<string, unknown>;
}

/**
 * The registries used by the application. Production transforms are added
 * here in version order when a format changes; at version 1 both are empty.
 * (Tests push a synthetic transform and remove it again.)
 */
export const configMigrationRegistry: { site: ConfigMigration[]; workspace: ConfigMigration[] } = {
  site: [],
  workspace: [],
};

export type ConfigMigrationStatus = 'current' | 'pending' | 'newer' | 'unsupported' | 'invalid';

export interface ConfigMigrationPlan {
  kind: 'site-config' | 'workspace-manifest';
  file: string;
  status: ConfigMigrationStatus;
  /** Version found in the file (null when it could not be read). */
  fromVersion: number | null;
  toVersion: number;
  /** Descriptions of the transforms that would run, in order. */
  steps: string[];
  currentText: string;
  proposedText: string | null;
  diff: string | null;
  /** Why the file cannot be migrated (status unsupported/invalid/newer). */
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The contiguous chain from `from` to `to`, or null when a step is missing. */
export function migrationChain(migrations: readonly ConfigMigration[], from: number, to: number): ConfigMigration[] | null {
  const chain: ConfigMigration[] = [];
  for (let v = from; v < to; v++) {
    const step = migrations.filter((m) => m.from === v);
    if (step.length !== 1) return null;
    chain.push(step[0]!);
  }
  return chain;
}

function runChain(doc: Record<string, unknown>, chain: ConfigMigration[], versionKey: string): Record<string, unknown> {
  let current: Record<string, unknown> = structuredClone(doc);
  for (const m of chain) {
    const next = m.migrate(structuredClone(current));
    if (!isPlainObject(next)) throw new AppError('CONFIG_INVALID', `Configuration migration from version ${m.from} did not return an object.`);
    current = { ...next, [versionKey]: m.from + 1 };
  }
  return current;
}

/** Apply the difference between two plain values to a YAML document, touching only changed keys (comments elsewhere survive). */
function applyValueDiff(doc: Document, before: unknown, after: unknown, at: Array<string | number>): void {
  if (stableStringify(before) === stableStringify(after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const k of Object.keys(before)) if (!Object.hasOwn(after, k)) doc.deleteIn([...at, k]);
    for (const [k, v] of Object.entries(after)) {
      if (!Object.hasOwn(before, k)) doc.setIn([...at, k], v);
      else applyValueDiff(doc, before[k], v, [...at, k]);
    }
    return;
  }
  if (at.length === 0) doc.contents = doc.createNode(after) as Document['contents'];
  else doc.setIn(at, after);
}

function versionOf(raw: unknown, key: string, fallback: number): number | null {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, key) || raw[key] === undefined || raw[key] === null) return fallback;
  const v = raw[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Plan the migration of one site configuration file (read-only). */
export function planSiteConfigMigration(file: string, opts: { migrations?: readonly ConfigMigration[]; target?: number } = {}): ConfigMigrationPlan {
  const target = opts.target ?? SITE_CONFIG_SCHEMA_VERSION;
  const migrations = opts.migrations ?? configMigrationRegistry.site;
  const currentText = readFileSync(file, 'utf8');
  const base: ConfigMigrationPlan = { kind: 'site-config', file, status: 'current', fromVersion: null, toVersion: target, steps: [], currentText, proposedText: null, diff: null, errors: [] };
  let raw: unknown;
  try {
    raw = parseYamlSafe(currentText, file);
  } catch (err) {
    return { ...base, status: 'invalid', errors: [(err as Error).message] };
  }
  // A config without schemaVersion predates nothing: the schema default (the current version) applies.
  const from = versionOf(raw, 'schemaVersion', target);
  if (from === null) return { ...base, status: 'invalid', errors: ['schemaVersion: must be a whole number'] };
  if (from === target) return { ...base, fromVersion: from };
  if (from > target) {
    return { ...base, fromVersion: from, status: 'newer', errors: [`schemaVersion ${from} is newer than this application supports (${target}); upgrade the application instead.`] };
  }
  const chain = migrationChain(migrations, from, target);
  if (!chain) return { ...base, fromVersion: from, status: 'unsupported', errors: [`No configuration migration path from schemaVersion ${from} to ${target} in this application version.`] };
  const steps = chain.map((m) => `v${m.from} -> v${m.from + 1}: ${m.description}`);
  let migrated: Record<string, unknown>;
  try {
    migrated = runChain(isPlainObject(raw) ? raw : {}, chain, 'schemaVersion');
  } catch (err) {
    return { ...base, fromVersion: from, steps, status: 'invalid', errors: [(err as Error).message] };
  }
  const doc = parseDocument(currentText);
  applyValueDiff(doc, raw, migrated, []);
  const proposedText = doc.toString();
  const check = safeParseSiteConfig(parseYamlSafe(proposedText, `${file} (migrated)`));
  const diff = unifiedDiff(currentText, proposedText, { fromLabel: `${path.basename(file)} (v${from})`, toLabel: `${path.basename(file)} (v${target})` }).unified;
  if (!check.ok) return { ...base, fromVersion: from, steps, proposedText, diff, status: 'invalid', errors: check.errors };
  return { ...base, fromVersion: from, steps, proposedText, diff, status: 'pending' };
}

/** Plan the migration of the workspace manifest (read-only). */
export function planWorkspaceManifestMigration(paths: WorkspacePaths, opts: { migrations?: readonly ConfigMigration[]; target?: number } = {}): ConfigMigrationPlan | null {
  if (!existsSync(paths.manifest)) return null;
  const target = opts.target ?? WORKSPACE_FORMAT_VERSION;
  const migrations = opts.migrations ?? configMigrationRegistry.workspace;
  const currentText = readFileSync(paths.manifest, 'utf8');
  const base: ConfigMigrationPlan = { kind: 'workspace-manifest', file: paths.manifest, status: 'current', fromVersion: null, toVersion: target, steps: [], currentText, proposedText: null, diff: null, errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(currentText);
  } catch (err) {
    return { ...base, status: 'invalid', errors: [`workspace.json is not valid JSON (${(err as Error).message})`] };
  }
  const from = isPlainObject(raw) && typeof raw.formatVersion === 'number' && Number.isInteger(raw.formatVersion) ? raw.formatVersion : null;
  if (from === null) return { ...base, status: 'invalid', errors: ['formatVersion: missing or not a whole number'] };
  if (from === target) return { ...base, fromVersion: from };
  if (from > target) return { ...base, fromVersion: from, status: 'newer', errors: [`formatVersion ${from} is newer than this application supports (${target}); upgrade the application instead.`] };
  const chain = migrationChain(migrations, from, target);
  if (!chain) return { ...base, fromVersion: from, status: 'unsupported', errors: [`No workspace format migration from ${from} to ${target} in this application version.`] };
  const steps = chain.map((m) => `format ${m.from} -> ${m.from + 1}: ${m.description}`);
  let migrated: Record<string, unknown>;
  try {
    migrated = runChain(raw as Record<string, unknown>, chain, 'formatVersion');
  } catch (err) {
    return { ...base, fromVersion: from, steps, status: 'invalid', errors: [(err as Error).message] };
  }
  const proposedText = `${JSON.stringify(migrated, null, 2)}\n`;
  const diff = unifiedDiff(currentText, proposedText, { fromLabel: `workspace.json (format ${from})`, toLabel: `workspace.json (format ${target})` }).unified;
  const errors: string[] = [];
  if (migrated.kind !== 'live' && migrated.kind !== 'demo') errors.push('kind: must be "live" or "demo"');
  errors.push(...validateWorkspacePathOverrides(paths.root, migrated.paths).errors);
  if (errors.length) return { ...base, fromVersion: from, steps, proposedText, diff, status: 'invalid', errors };
  return { ...base, fromVersion: from, steps, proposedText, diff, status: 'pending' };
}

/** Plans for the workspace manifest and every site configuration (read-only). */
export function planWorkspaceConfigMigrations(paths: WorkspacePaths, opts: { siteMigrations?: readonly ConfigMigration[]; workspaceMigrations?: readonly ConfigMigration[] } = {}): ConfigMigrationPlan[] {
  const plans: ConfigMigrationPlan[] = [];
  const manifest = planWorkspaceManifestMigration(paths, opts.workspaceMigrations ? { migrations: opts.workspaceMigrations } : {});
  if (manifest) plans.push(manifest);
  for (const id of listSiteIds(paths)) {
    plans.push(planSiteConfigMigration(siteConfigFile(paths, id), opts.siteMigrations ? { migrations: opts.siteMigrations } : {}));
  }
  return plans;
}

export interface AppliedConfigMigration {
  backupDir: string | null;
  written: Array<{ file: string; backup: string }>;
}

function freshBackupDir(paths: WorkspacePaths, now: Date): string {
  const parent = path.join(paths.backupsDir, 'config');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (let i = 0; i < 100; i++) {
    const dir = path.join(parent, i === 0 ? stamp : `${stamp}-${i}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new AppError('CONFLICT', `Could not create a fresh backup directory under ${parent}.`);
}

/**
 * Write the pending plans: every original is first copied to
 * backups/config/<timestamp>/ (0600, never overwriting), then each file is
 * replaced atomically with mode 0600. A file that changed after planning is
 * not overwritten (CONFLICT).
 */
export function applyConfigMigrations(paths: WorkspacePaths, plans: readonly ConfigMigrationPlan[], now: Date): AppliedConfigMigration {
  const pending = plans.filter((p) => p.status === 'pending' && p.proposedText !== null);
  if (!pending.length) return { backupDir: null, written: [] };
  const backupDir = freshBackupDir(paths, now);
  const backups = pending.map((p) => {
    const name = p.kind === 'workspace-manifest' ? 'workspace.json' : path.join('sites', path.basename(p.file));
    const backup = path.join(backupDir, name);
    mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    writeFileSync(backup, p.currentText, { mode: 0o600, flag: 'wx' });
    return backup;
  });
  const written: AppliedConfigMigration['written'] = [];
  pending.forEach((p, i) => {
    try {
      atomicWriteFile(p.file, p.proposedText!, { mode: 0o600, expectedCurrent: p.currentText });
    } catch (err) {
      throw new AppError('CONFLICT', `${p.file} changed while the migration was being prepared; it was not overwritten.`, {
        cause: err,
        details: { written: written.map((w) => w.file), backupDir },
        hint: 'Run `npm run cli -- config migrate` again to review a fresh diff.',
      });
    }
    if (process.platform !== 'win32') chmodSync(p.file, 0o600);
    written.push({ file: p.file, backup: backups[i]! });
  });
  return { backupDir, written };
}
