import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { appRoot, forbiddenRootLabel, isWithinRealPath } from '../config/paths.js';

/**
 * The folder that holds a site's weekly action plans.
 *
 * Plans contain private search data (page URLs, queries, clicks), and the
 * folder may live inside a website repository, so it is always a DEDICATED
 * folder whose contents are git-ignored:
 *
 * - a new or empty folder gets a `.gitignore` that starts with the marker
 *   line below and ignores everything (`*`, the `.gitignore` included), so
 *   nothing in it shows up in `git status` of any repository around it;
 * - an existing folder is used only when it already carries that marker
 *   `.gitignore` with its `*` rule. Any other non-empty folder is refused:
 *   ignoring `*` there would hide files that are not ours.
 */

export const PLANS_GITIGNORE_MARKER = '# seo-agent action plans';
export const PLANS_GITIGNORE = `${PLANS_GITIGNORE_MARKER}: written by seo-agent. Plans contain private search data (page URLs,
# queries, clicks), so nothing in this folder is ever committed. Keep this file.
*
`;

export interface PlansDir {
  dir: string;
  /** Where the location came from: the site config (`actionPlans.dir`) or the default under the workspace. */
  source: 'config' | 'default';
}

/** The configured plans folder (absolute; "~/" expanded), or `<workspace>/plans/<site-id>`. */
export function resolvePlansDir(ctx: Pick<AppContext, 'config' | 'paths' | 'siteId'>): PlansDir {
  const raw = ctx.config.actionPlans.dir;
  if (!raw) return { dir: path.join(ctx.paths.root, 'plans', ctx.siteId), source: 'default' };
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new AppError('VALIDATION_FAILED', `actionPlans.dir must be an absolute path (or start with "~/"): ${raw}`, {
      hint: 'Use a full path such as "/Users/you/projects/my-site/seo-plans", or remove actionPlans.dir to use <workspace>/plans/<site-id>.',
    });
  }
  return { dir: path.resolve(expanded), source: 'config' };
}

/**
 * Refuse locations that must never hold plans: the filesystem root, the home
 * directory, the system temp directory itself, the seo-agent application
 * folder (a public repository), and the workspace's secrets, data, and vault
 * folders. Symlinks are resolved and case is ignored where the volume is
 * case-insensitive (isWithinRealPath).
 */
export function checkPlansDirLocation(ctx: Pick<AppContext, 'paths'>, dir: string): void {
  const hint = 'Choose a dedicated folder, for example "<your website repo>/seo-plans", or remove actionPlans.dir to use <workspace>/plans/<site-id>.';
  const root = forbiddenRootLabel(dir);
  if (root) throw new AppError('VALIDATION_FAILED', `The action plans folder cannot be ${root}: ${dir}`, { hint });
  const refused: Array<[string, string]> = [
    [appRoot(), 'the seo-agent application folder (plans contain private data and never belong in its repository)'],
    [ctx.paths.secretsDir, 'the workspace secrets folder'],
    [ctx.paths.dataDir, 'the workspace data folder'],
    [ctx.paths.vaultRoot, 'the Obsidian vault (the vault writer owns it)'],
  ];
  for (const [parent, label] of refused) {
    if (isWithinRealPath(parent, dir)) throw new AppError('VALIDATION_FAILED', `The action plans folder cannot be inside ${label}: ${dir}`, { hint });
  }
}

export type PlansDirState = { state: 'missing' } | { state: 'managed' } | { state: 'empty' } | { state: 'refused'; reason: string };

/** What is at the plans location now, without changing anything. */
export function inspectPlansDir(dir: string): PlansDirState {
  if (!existsSync(dir)) return { state: 'missing' };
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return { state: 'refused', reason: 'it is a symbolic link; point actionPlans.dir at the real folder' };
  if (!st.isDirectory()) return { state: 'refused', reason: 'it is a file, not a folder' };
  const ignore = path.join(dir, '.gitignore');
  if (existsSync(ignore)) {
    const text = readFileSync(ignore, 'utf8');
    if (!text.startsWith(PLANS_GITIGNORE_MARKER)) return { state: 'refused', reason: 'it has a .gitignore that seo-agent did not write, so it is not a dedicated plans folder' };
    if (!text.split(/\r?\n/).some((l) => l.trim() === '*')) return { state: 'refused', reason: 'its seo-agent .gitignore no longer ignores everything ("*" line missing); plans would be committed' };
    return { state: 'managed' };
  }
  const entries = readdirSync(dir).filter((e) => e !== '.DS_Store');
  return entries.length ? { state: 'refused', reason: `it already contains ${entries.length} item(s) and was not created by seo-agent` } : { state: 'empty' };
}

/**
 * Create the plans folder (0700) with its `.gitignore`, or confirm an
 * existing one is managed. Throws VALIDATION_FAILED when the folder cannot be
 * used; nothing is written in that case.
 */
export function preparePlansDir(ctx: Pick<AppContext, 'paths'>, dir: string): { created: boolean } {
  checkPlansDirLocation(ctx, dir);
  const found = inspectPlansDir(dir);
  if (found.state === 'refused') {
    throw new AppError('VALIDATION_FAILED', `The action plans folder cannot be used: ${dir} (${found.reason}).`, {
      hint: `Point actionPlans.dir at a new or empty folder (seo-agent creates it and adds a .gitignore), or restore its .gitignore to:\n${PLANS_GITIGNORE}`,
    });
  }
  if (found.state === 'managed') return { created: false };
  if (found.state === 'missing') mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, '.gitignore'), PLANS_GITIGNORE, { flag: 'wx', mode: 0o644 });
  return { created: found.state === 'missing' };
}
