import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { safeResolve } from '../security/paths.js';
import { atomicWriteFile, ensureVaultDir, lstatOrNull, resolveInVault, validateVaultRelPath } from './fs-safe.js';
import { inline } from './markdown.js';
import { VAULT_FOLDERS } from './types.js';

/**
 * `vault init`: create a site vault from `vault/_template/`.
 *
 * - Never overwrites: every file is created with a create-only atomic write;
 *   existing files (and anything a human put there) are left untouched.
 * - Missing standard folders are created; nothing is ever deleted.
 * - Symlinks in the template are skipped; nothing is written through symlinks
 *   in the target vault.
 * - `{{site_id}}` and `{{business_name}}` placeholders are filled in notes
 *   outside `Templates/` (Obsidian's own `{{title}}`/`{{date}}` placeholders in
 *   `Templates/` are left for Obsidian's core Templates plugin).
 */

export interface VaultInitResult {
  vaultDir: string;
  created: string[];
  existing: string[];
  skipped: string[];
  dryRun: boolean;
}

export interface VaultInitOptions {
  templateDir: string;
  vaultRoot: string;
  siteId: string;
  businessName: string;
  dryRun?: boolean;
}

function fillPlaceholders(text: string, opts: { siteId: string; businessName: string }): string {
  return text.replace(/\{\{site_id\}\}/g, opts.siteId).replace(/\{\{business_name\}\}/g, inline(opts.businessName, 200));
}

export function initSiteVault(opts: VaultInitOptions): VaultInitResult {
  const dryRun = !!opts.dryRun;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(opts.siteId)) throw new AppError('UNSAFE_PATH', `Invalid site id for a vault: ${JSON.stringify(opts.siteId)}`);
  const vaultDir = safeResolve(opts.vaultRoot, opts.siteId);
  const result: VaultInitResult = { vaultDir, created: [], existing: [], skipped: [], dryRun };
  const templateStat = lstatOrNull(opts.templateDir);
  if (!templateStat || !templateStat.isDirectory()) {
    throw new AppError('NOT_FOUND', `Vault template not found: ${opts.templateDir}`, { hint: 'Reinstall the application; vault/_template/ ships with it.' });
  }
  const vaultExisted = existsSync(vaultDir);
  ensureVaultDir(opts.vaultRoot, vaultDir, !dryRun);
  if (!vaultExisted) result.created.push('.');

  /** Create a folder (component by component, no symlinks). Records it when it did not exist. */
  const ensureFolder = (rel: string): void => {
    const abs = path.join(vaultDir, ...rel.split('/'));
    const existed = existsSync(abs);
    resolveInVault(vaultDir, `${rel}/.seo-agent-probe`, { createParents: !dryRun });
    if (!existed) result.created.push(`${rel}/`);
  };

  const walk = (srcDir: string, relDir: string) => {
    for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const src = path.join(srcDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const st = lstatSync(src);
      if (st.isSymbolicLink()) {
        result.skipped.push(rel);
        continue;
      }
      if (st.isDirectory()) {
        ensureFolder(rel);
        walk(src, rel);
        continue;
      }
      if (!st.isFile() || entry.name === '.gitkeep' || entry.name.startsWith('.')) continue;
      validateVaultRelPath(rel, 'read', { requireMd: false });
      const target = resolveInVault(vaultDir, rel, { createParents: !dryRun });
      if (existsSync(target) || lstatOrNull(target)) {
        result.existing.push(rel);
        continue;
      }
      const raw = readFileSync(src, 'utf8');
      const content = rel.startsWith('Templates/') ? raw : fillPlaceholders(raw, { siteId: opts.siteId, businessName: opts.businessName });
      if (!dryRun) {
        try {
          atomicWriteFile(target, content, { noOverwrite: true, mode: 0o600 });
        } catch (err) {
          if (err instanceof AppError && err.code === 'CONFLICT') {
            result.existing.push(rel);
            continue;
          }
          throw err;
        }
      }
      result.created.push(rel);
    }
  };
  walk(opts.templateDir, '');

  for (const folder of VAULT_FOLDERS) {
    if (!result.created.includes(`${folder}/`) && !existsSync(path.join(vaultDir, ...folder.split('/')))) ensureFolder(folder);
  }
  return result;
}
