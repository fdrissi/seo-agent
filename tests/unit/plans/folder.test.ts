import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appRoot, workspacePaths } from '../../../src/config/paths.js';
import { PLANS_GITIGNORE, PLANS_GITIGNORE_MARKER, checkPlansDirLocation, inspectPlansDir, preparePlansDir, resolvePlansDir } from '../../../src/plans/folder.js';
import { testSiteConfig } from '../../helpers/context.js';

// The plans folder is dedicated and git-ignored (src/plans/folder.ts). Temporary folders only.

const dirs: string[] = [];
function tmp(prefix = 'seo-agent-plans-test-'): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctxFor(root: string, dir: string | null = null) {
  return { paths: workspacePaths(root), siteId: 'test-site', config: testSiteConfig({ actionPlans: { dir } }) };
}

describe('plans folder location', () => {
  it('defaults to <workspace>/plans/<site-id>; accepts absolute and "~/" paths; refuses relative ones', () => {
    const root = tmp();
    expect(resolvePlansDir(ctxFor(root))).toEqual({ dir: path.join(root, 'plans', 'test-site'), source: 'default' });
    expect(resolvePlansDir(ctxFor(root, '/srv/site/seo-plans'))).toEqual({ dir: '/srv/site/seo-plans', source: 'config' });
    expect(resolvePlansDir(ctxFor(root, '~/site/seo-plans')).dir).toBe(path.join(os.homedir(), 'site/seo-plans'));
    expect(() => resolvePlansDir(ctxFor(root, 'seo-plans'))).toThrow(/absolute path/);
  });

  it('refuses the home directory, the application folder, and the workspace secrets, data, and vault folders', () => {
    const root = tmp();
    const paths = workspacePaths(root);
    expect(() => checkPlansDirLocation({ paths }, os.homedir())).toThrow(/home directory/);
    expect(() => checkPlansDirLocation({ paths }, path.join(appRoot(), 'plans'))).toThrow(/application folder/);
    expect(() => checkPlansDirLocation({ paths }, path.join(paths.secretsDir, 'plans'))).toThrow(/secrets folder/);
    expect(() => checkPlansDirLocation({ paths }, path.join(paths.dataDir, 'plans'))).toThrow(/data folder/);
    expect(() => checkPlansDirLocation({ paths }, path.join(paths.vaultRoot, 'plans'))).toThrow(/vault/);
    expect(() => checkPlansDirLocation({ paths }, path.join(root, 'plans', 'test-site'))).not.toThrow();
  });
});

describe('plans folder preparation', () => {
  it('creates a missing folder with a .gitignore that ignores everything', () => {
    const root = tmp();
    const dir = path.join(tmp(), 'nested', 'seo-plans');
    expect(preparePlansDir({ paths: workspacePaths(root) }, dir)).toEqual({ created: true });
    const ignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(ignore).toBe(PLANS_GITIGNORE);
    expect(ignore.startsWith(PLANS_GITIGNORE_MARKER)).toBe(true);
    expect(ignore.split('\n')).toContain('*');
    expect(inspectPlansDir(dir)).toEqual({ state: 'managed' });
    // Idempotent.
    expect(preparePlansDir({ paths: workspacePaths(root) }, dir)).toEqual({ created: false });
  });

  it('adopts an empty folder but refuses a non-empty or foreign one', () => {
    const root = tmp();
    const empty = tmp();
    expect(preparePlansDir({ paths: workspacePaths(root) }, empty)).toEqual({ created: false });
    expect(inspectPlansDir(empty)).toEqual({ state: 'managed' });

    const busy = tmp();
    writeFileSync(path.join(busy, 'README.md'), 'site docs (synthetic)');
    expect(() => preparePlansDir({ paths: workspacePaths(root) }, busy)).toThrow(/not created by seo-agent/);
    expect(readFileSync(path.join(busy, 'README.md'), 'utf8')).toBe('site docs (synthetic)');

    const foreign = tmp();
    writeFileSync(path.join(foreign, '.gitignore'), 'node_modules\n');
    expect(() => preparePlansDir({ paths: workspacePaths(root) }, foreign)).toThrow(/did not write/);

    const weakened = tmp();
    writeFileSync(path.join(weakened, '.gitignore'), `${PLANS_GITIGNORE_MARKER}: edited\n!*.md\n`);
    expect(() => preparePlansDir({ paths: workspacePaths(root) }, weakened)).toThrow(/would be committed/);
  });

  it('refuses a symbolic link and a file', () => {
    const root = tmp();
    const real = tmp();
    const link = path.join(tmp(), 'link');
    symlinkSync(real, link);
    expect(() => preparePlansDir({ paths: workspacePaths(root) }, link)).toThrow(/symbolic link/);
    const file = path.join(tmp(), 'plans.txt');
    writeFileSync(file, 'x');
    expect(() => preparePlansDir({ paths: workspacePaths(root) }, file)).toThrow(/not a folder/);
  });

  it('keeps plans out of git in a repository around the folder', () => {
    const root = tmp();
    const repo = tmp('seo-agent-plans-repo-');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    const dir = path.join(repo, 'seo-plans');
    preparePlansDir({ paths: workspacePaths(root) }, dir);
    writeFileSync(path.join(dir, '2026-W39.md'), '# synthetic plan\n');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'index.html'), '<p>synthetic</p>');
    // Only the site's own files are untracked; nothing from the plans folder shows up.
    expect(git('status', '--porcelain', '--untracked-files=all').trim().split('\n')).toEqual(['?? src/index.html']);
  });
});
