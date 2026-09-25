import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, parseDocument } from 'yaml';
import { AppError, ConfigError } from '../core/errors.js';
import { stableStringify } from '../core/hash.js';
import { parseYamlSafe } from '../config/load.js';
import { siteConfigFile, type WorkspacePaths } from '../config/paths.js';
import type { SecretStore } from '../config/secrets.js';
import { safeParseSiteConfig, siteConfigSchema, siteConfigWarnings, type SiteConfig } from '../config/site-schema.js';
import { unifiedDiff, type DiffResult } from '../approvals/diff.js';
import { atomicWriteFile } from '../obsidian/fs-safe.js';
import { SITE_ID_RE } from './draft.js';
import { assertNoKnownSecrets, findSecretLikeContent } from './secrets.js';
import { leafEntries, orderKeys, type Values } from './values.js';

/**
 * Site configuration files written by setup.
 *
 * - A config is written only after it validates against the site schema.
 * - A new file is created without ever replacing an existing one.
 * - An existing file changes only with an explicit --update: the diff is
 *   shown first, comments and formatting of the existing file are kept (only
 *   the answered keys change), a copy of the previous version goes to
 *   <workspace>/backups/config/, and the write fails if the file changed
 *   after the diff was computed.
 * - Secret values are never written (checked against the configured secrets).
 */

export const CONFIG_KEY_ORDER: readonly string[] = Object.keys(siteConfigSchema.shape);

export function renderNewConfig(values: Values, now: Date): string {
  const doc = new Document(orderKeys(values, CONFIG_KEY_ORDER));
  doc.commentBefore = [
    ` seo-agent site configuration (private). Created by \`seo-agent setup\` on ${now.toISOString().slice(0, 10)}.`,
    ' Validated against the site schema. Unknown facts stay null/empty; never invent them.',
    ' Never put secrets here: they belong in <workspace>/secrets/secrets.env or the environment.',
    ' Field reference: docs/CONFIGURATION.md. Change it later with `npm run cli -- setup --update`.',
  ].join('\n');
  return doc.toString();
}

/**
 * Apply answered values to an existing config text, keeping its comments and
 * layout: the YAML document is updated with setIn, then every section whose
 * value did not change is copied back verbatim from the original text so the
 * diff shows only real changes. If that splice ever parses to a different
 * value, the plain re-serialization is used instead (correctness first).
 */
export function applyToExistingConfig(existingText: string, answered: Values): string {
  const doc = parseDocument(existingText);
  if (doc.errors.length) throw new ConfigError(`Existing config is not valid YAML: ${doc.errors[0]!.message}`);
  for (const [p, value] of leafEntries(answered)) {
    if (!p.length) continue;
    doc.setIn(p, value);
  }
  const full = doc.toString();
  try {
    const oldValue = parseYamlSafe(existingText, 'current config');
    const newValue = parseYamlSafe(full, 'proposed config');
    const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
    const spliced = spliceBlocks(existingText.replace(/\r\n/g, '\n').split('\n'), full.split('\n'), oldValue, newValue, 0).join('\n');
    const out = eol === '\n' ? spliced : spliced.replace(/\n/g, eol);
    if (stableStringify(parseYamlSafe(out, 'spliced config')) === stableStringify(newValue)) return out;
  } catch {
    /* fall back below */
  }
  return full;
}

interface LineBlock {
  key: string | null;
  lines: string[];
}

/** Split lines into blocks that start at a `key:` line with exactly `indent` spaces (leading comments attach to the next key). */
function lineBlocks(lines: string[], indent: number): { head: string[]; blocks: LineBlock[]; tail: string[] } {
  const keyRe = new RegExp(`^ {${indent}}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_$][^:#\\s]*))\\s*:(\\s|$)`);
  const head: string[] = [];
  const blocks: LineBlock[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    const m = keyRe.exec(line);
    if (m) {
      blocks.push({ key: m[1] ?? m[2] ?? m[3]!, lines: [...pending, line] });
      pending = [];
      continue;
    }
    const isCommentOrBlank = line.trim() === '' || line.trim().startsWith('#');
    const indentOf = line.length - line.trimStart().length;
    if (isCommentOrBlank && (indentOf <= indent || line.trim() === '')) {
      pending.push(line);
      continue;
    }
    if (blocks.length) {
      blocks[blocks.length - 1]!.lines.push(...pending, line);
      pending = [];
    } else {
      head.push(...pending, line);
      pending = [];
    }
  }
  if (!blocks.length) return { head: [...head, ...pending], blocks, tail: [] };
  return { head, blocks, tail: pending };
}

function spliceBlocks(oldLines: string[], newLines: string[], oldValue: unknown, newValue: unknown, indent: number): string[] {
  const o = lineBlocks(oldLines, indent);
  const n = lineBlocks(newLines, indent);
  const oldObj = isPlainObjectValue(oldValue) ? oldValue : {};
  const newObj = isPlainObjectValue(newValue) ? newValue : {};
  const out: string[] = [...o.head];
  for (const nb of n.blocks) {
    const ob = o.blocks.find((b) => b.key === nb.key);
    const k = nb.key ?? '';
    if (ob && stableStringify(oldObj[k]) === stableStringify(newObj[k])) {
      out.push(...ob.lines);
      continue;
    }
    const oldHeader = ob?.lines.find((l) => !l.trim().startsWith('#') && l.trim() !== '');
    const newHeader = nb.lines.find((l) => !l.trim().startsWith('#') && l.trim() !== '');
    const blockMapping = (l: string | undefined) => !!l && /:\s*(#.*)?$/.test(l);
    if (ob && isPlainObjectValue(oldObj[k]) && isPlainObjectValue(newObj[k]) && blockMapping(oldHeader) && blockMapping(newHeader)) {
      const oIdx = ob.lines.indexOf(oldHeader!);
      const nIdx = nb.lines.indexOf(newHeader!);
      out.push(...ob.lines.slice(0, oIdx + 1));
      out.push(...spliceBlocks(ob.lines.slice(oIdx + 1), nb.lines.slice(nIdx + 1), oldObj[k], newObj[k], indent + 2));
      continue;
    }
    out.push(...nb.lines);
  }
  out.push(...o.tail);
  return out;
}

function isPlainObjectValue(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export interface ValidatedConfigText {
  config: SiteConfig;
  warnings: string[];
  unknownKeys: string[];
}

/** Parse YAML text and validate it against the site schema (throws CONFIG_INVALID with field errors). */
export function validateConfigText(text: string, source: string): ValidatedConfigText {
  const raw = parseYamlSafe(text, source);
  const parsed = safeParseSiteConfig(raw);
  if (!parsed.ok) throw new ConfigError(`Site config from ${source} is invalid`, { details: { errors: parsed.errors } });
  const warnings = siteConfigWarnings(raw, parsed.config);
  const unknownKeys = warnings.filter((w) => w.includes(': unknown key')).map((w) => w.split(':')[0]!);
  return { config: parsed.config, warnings, unknownKeys };
}

export interface ConfigWritePlan {
  siteId: string;
  file: string;
  exists: boolean;
  currentText: string | null;
  proposedText: string;
  config: SiteConfig;
  warnings: string[];
  diff: DiffResult | null;
  changed: boolean;
}

export function planConfigWrite(paths: WorkspacePaths, siteId: string, proposedText: string): ConfigWritePlan {
  if (!SITE_ID_RE.test(siteId)) throw new AppError('VALIDATION_FAILED', `Invalid site id ${JSON.stringify(siteId)}`);
  const file = siteConfigFile(paths, siteId);
  const v = validateConfigText(proposedText, `${siteId}.yaml (proposed)`);
  if (v.config.site.id !== siteId) throw new ConfigError(`The proposed config declares site.id "${v.config.site.id}" but is written as ${siteId}.yaml; they must match.`);
  const exists = existsSync(file);
  const currentText = exists ? readFileSync(file, 'utf8') : null;
  const diff = currentText !== null ? unifiedDiff(currentText, proposedText, { fromLabel: `${siteId}.yaml (current)`, toLabel: `${siteId}.yaml (proposed)` }) : null;
  return { siteId, file, exists, currentText, proposedText, config: v.config, warnings: v.warnings, diff, changed: currentText !== proposedText };
}

export interface ConfigWriteResult {
  file: string;
  backupFile: string | null;
  created: boolean;
}

/**
 * Write a planned config. Creating never overwrites; replacing an existing
 * file requires `update: true` and fails if the file changed since planning.
 */
export function writeConfigFile(paths: WorkspacePaths, plan: ConfigWritePlan, opts: { update: boolean; secrets: SecretStore; now: Date }): ConfigWriteResult {
  assertNoKnownSecrets(plan.proposedText, opts.secrets, `the site config ${plan.file}`);
  mkdirSync(paths.sitesDir, { recursive: true, mode: 0o700 });
  if (!plan.exists) {
    try {
      atomicWriteFile(plan.file, plan.proposedText, { mode: 0o600, noOverwrite: true });
    } catch (err) {
      if (err instanceof AppError && err.code === 'CONFLICT') {
        throw new AppError('CONFLICT', `${plan.file} was created while setup was running; it was not overwritten.`, { hint: 'Re-run with --update to review a diff against it.' });
      }
      throw err;
    }
    if (process.platform !== 'win32') chmodSync(plan.file, 0o600);
    return { file: plan.file, backupFile: null, created: true };
  }
  if (!opts.update) {
    throw new AppError('CONFLICT', `Site config ${plan.file} already exists; it was not changed.`, { hint: 'Re-run with --update to review the diff and apply the changes.' });
  }
  const dir = path.join(paths.backupsDir, 'config');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backupFile = path.join(dir, `${plan.siteId}-${opts.now.toISOString().replace(/[:.]/g, '-')}.yaml`);
  writeFileSync(backupFile, plan.currentText ?? '', { mode: 0o600, flag: 'wx' });
  atomicWriteFile(plan.file, plan.proposedText, { mode: 0o600, expectedCurrent: plan.currentText ?? '' });
  if (process.platform !== 'win32') chmodSync(plan.file, 0o600);
  return { file: plan.file, backupFile, created: false };
}

export interface ImportPlan extends ConfigWritePlan {
  source: string;
}

/**
 * Non-interactive import (`setup --from <yaml>`): the file must validate,
 * must not contain unknown keys (typos would silently disable settings), and
 * must not contain any configured secret value, secret-named key, or
 * credential-shaped text (comments included). The profile must match the
 * workspace kind (demo only in a demo workspace, core/full only in a live
 * one). Its text is kept verbatim.
 */
export function planImport(paths: WorkspacePaths, sourceFile: string, opts: { siteFlag?: string | undefined; workspaceKind: 'live' | 'demo'; secrets: SecretStore }): ImportPlan {
  if (!existsSync(sourceFile)) throw new AppError('NOT_FOUND', `File not found: ${sourceFile}`);
  const text = readFileSync(sourceFile, 'utf8');
  assertNoKnownSecrets(text, opts.secrets, `a site config imported from ${sourceFile}`);
  const secretLike = findSecretLikeContent(text, parseYamlSafe(text, sourceFile));
  if (secretLike.length) {
    throw new AppError('POLICY_DENIED', `${sourceFile} looks like it contains credentials; nothing was imported (values are never shown).`, {
      details: { errors: secretLike },
      hint: 'Remove them from the file: secrets belong only in <workspace>/secrets/secrets.env or the environment (see docs/CONFIGURATION.md#environment-variables).',
    });
  }
  const v = validateConfigText(text, sourceFile);
  if (v.unknownKeys.length) {
    throw new ConfigError(`${sourceFile} contains keys the site schema does not know; nothing was imported.`, {
      details: { errors: v.unknownKeys.map((k) => `${k}: unknown key (check the spelling against docs/CONFIGURATION.md; secrets never belong in site config)`) },
      hint: 'Fix or remove those keys and import again.',
    });
  }
  const siteId = v.config.site.id;
  if (opts.siteFlag && opts.siteFlag !== siteId) throw new ConfigError(`--site ${opts.siteFlag} does not match site.id "${siteId}" in ${sourceFile}.`);
  if (v.config.profile === 'demo' && opts.workspaceKind === 'live') {
    throw new AppError('POLICY_DENIED', 'A demo-profile config cannot be imported into a live workspace: synthetic demo data must never mix with live reporting.', {
      hint: 'Run `npm run demo` (it uses its own isolated workspace), or import a core/full config.',
    });
  }
  if (v.config.profile !== 'demo' && opts.workspaceKind === 'demo') {
    throw new AppError('POLICY_DENIED', `A ${v.config.profile}-profile config cannot be imported into a demo workspace: real credentials and data never belong there, and a demo refresh deletes the workspace contents.`, {
      hint: 'Create a separate live workspace (`npm run cli -- --workspace <dir> init`) and import the config there with `setup --from`.',
    });
  }
  const plan = planConfigWrite(paths, siteId, text);
  return { ...plan, source: sourceFile };
}
