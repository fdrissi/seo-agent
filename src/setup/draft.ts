import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { stringify } from 'yaml';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { parseYamlSafe } from '../config/load.js';
import type { WorkspacePaths } from '../config/paths.js';
import type { SecretStore } from '../config/secrets.js';
import { atomicWriteFile } from '../obsidian/fs-safe.js';
import { safeResolve } from '../security/paths.js';
import { assertNoKnownSecrets } from './secrets.js';

/**
 * Resumable setup drafts. Progress is saved after every answer to
 * `<workspace>/config/sites/.<site-id>.setup-draft.yaml` (mode 0600). The
 * leading dot keeps drafts out of the site list; a draft is never a valid
 * site config and never contains secret values (only non-secret answers and
 * decisions such as "I will inject this key through the environment").
 */

export const DRAFT_VERSION = 1;
export const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DRAFT_SUFFIX = '.setup-draft.yaml';

const draftSchema = z.object({
  draftVersion: z.literal(DRAFT_VERSION),
  siteId: z.string().regex(SITE_ID_RE),
  mode: z.enum(['create', 'update']),
  startedAt: z.string(),
  updatedAt: z.string(),
  answered: z.array(z.string()).default([]),
  values: z.record(z.string(), z.unknown()).default({}),
  partial: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export type SetupDraft = z.infer<typeof draftSchema>;

export function draftFile(paths: WorkspacePaths, siteId: string): string {
  if (!SITE_ID_RE.test(siteId)) throw new AppError('VALIDATION_FAILED', `Invalid site id ${JSON.stringify(siteId)}`);
  return safeResolve(paths.sitesDir, `.${siteId}${DRAFT_SUFFIX}`);
}

export function newDraft(siteId: string, mode: 'create' | 'update', now: Date): SetupDraft {
  const at = now.toISOString();
  return { draftVersion: DRAFT_VERSION, siteId, mode, startedAt: at, updatedAt: at, answered: [], values: {}, partial: {} };
}

export interface DraftSummary {
  siteId: string;
  file: string;
  mode: 'create' | 'update' | 'unknown';
  updatedAt: string | null;
  answered: number;
  valid: boolean;
}

/** Drafts present in the workspace (invalid ones are listed with valid=false, never deleted). */
export function listDrafts(paths: WorkspacePaths): DraftSummary[] {
  if (!existsSync(paths.sitesDir)) return [];
  const out: DraftSummary[] = [];
  for (const name of readdirSync(paths.sitesDir).sort()) {
    if (!name.startsWith('.') || !name.endsWith(DRAFT_SUFFIX)) continue;
    const siteId = name.slice(1, -DRAFT_SUFFIX.length);
    if (!SITE_ID_RE.test(siteId)) continue;
    const file = draftFile(paths, siteId);
    try {
      const d = loadDraft(paths, siteId);
      out.push({ siteId, file, mode: d?.mode ?? 'unknown', updatedAt: d?.updatedAt ?? null, answered: d?.answered.length ?? 0, valid: !!d });
    } catch {
      out.push({ siteId, file, mode: 'unknown', updatedAt: null, answered: 0, valid: false });
    }
  }
  return out;
}

export function loadDraft(paths: WorkspacePaths, siteId: string): SetupDraft | null {
  const file = draftFile(paths, siteId);
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new AppError('UNSAFE_PATH', `Setup draft ${file} is not a regular file.`);
  const raw = parseYamlSafe(readFileSync(file, 'utf8'), file);
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success || parsed.data.siteId !== siteId) {
    throw new AppError('CONFIG_INVALID', `Setup draft ${file} is unreadable or was written by another version.`, {
      hint: `Inspect it, then delete it to start over: rm "${file}"`,
      details: { errors: parsed.success ? ['siteId does not match the file name'] : parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) },
    });
  }
  return parsed.data;
}

const HEADER = [
  '# seo-agent setup draft (private, resumable). This is NOT a site configuration.',
  '# It holds answers given so far so `npm run cli -- setup` can resume. It never contains secrets.',
  '# Delete it to start over.',
].join('\n');

/** Persist the draft atomically with mode 0600. Refuses to write if a known secret value would be stored. */
export function saveDraft(paths: WorkspacePaths, draft: SetupDraft, now: Date, secrets?: SecretStore): string {
  const file = draftFile(paths, draft.siteId);
  draft.updatedAt = now.toISOString();
  const text = `${HEADER}\n${stringify(draft)}`;
  if (secrets) assertNoKnownSecrets(text, secrets, 'the setup draft');
  atomicWriteFile(file, text, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}

export function deleteDraft(paths: WorkspacePaths, siteId: string): void {
  rmSync(draftFile(paths, siteId), { force: true });
}
