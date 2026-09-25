import os from 'node:os';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { appRoot, isWithinRealPath, resolveRealPath, type WorkspacePaths } from '../config/paths.js';
import type { SecretStore } from '../config/secrets.js';
import { isWithin } from '../security/paths.js';

/**
 * Google credential file locations. Defaults live in the protected workspace
 * directory `secrets/google` (0700). Overrides come from the environment or
 * the workspace secrets file (GOOGLE_OAUTH_CLIENT_FILE, GOOGLE_TOKEN_FILE,
 * GOOGLE_APPLICATION_CREDENTIALS). Relative overrides resolve against the
 * workspace root. Credentials are never allowed inside the vault or the
 * application repository.
 */

export interface GoogleCredentialPaths {
  clientFile: string;
  clientFileSource: 'env' | 'secrets-file' | 'default';
  tokenFile: string;
  tokenFileSource: 'env' | 'secrets-file' | 'default';
  serviceAccountFile: string | null;
  serviceAccountFileSource: 'env' | 'secrets-file' | 'unset';
}

export const DEFAULT_CLIENT_FILENAME = 'oauth-client.json';
export const DEFAULT_TOKEN_FILENAME = 'token.json';

function expand(p: string, root: string): string {
  const home = process.env.HOME || os.homedir();
  const e = p.startsWith('~') ? path.join(home, p.slice(1)) : p;
  return path.isAbsolute(e) ? path.resolve(e) : path.resolve(root, e);
}

function sourceOf(secrets: SecretStore, key: 'GOOGLE_OAUTH_CLIENT_FILE' | 'GOOGLE_TOKEN_FILE' | 'GOOGLE_APPLICATION_CREDENTIALS'): 'env' | 'secrets-file' | null {
  const s = secrets.sourceOf(key);
  return s === 'env' || s === 'secrets-file' ? s : null;
}

export function googleCredentialPaths(paths: WorkspacePaths, secrets: SecretStore): GoogleCredentialPaths {
  const clientRaw = secrets.get('GOOGLE_OAUTH_CLIENT_FILE');
  const tokenRaw = secrets.get('GOOGLE_TOKEN_FILE');
  const saRaw = secrets.get('GOOGLE_APPLICATION_CREDENTIALS');
  const out: GoogleCredentialPaths = {
    clientFile: clientRaw ? expand(clientRaw, paths.root) : path.join(paths.googleDir, DEFAULT_CLIENT_FILENAME),
    clientFileSource: clientRaw ? (sourceOf(secrets, 'GOOGLE_OAUTH_CLIENT_FILE') ?? 'env') : 'default',
    tokenFile: tokenRaw ? expand(tokenRaw, paths.root) : path.join(paths.googleDir, DEFAULT_TOKEN_FILENAME),
    tokenFileSource: tokenRaw ? (sourceOf(secrets, 'GOOGLE_TOKEN_FILE') ?? 'env') : 'default',
    serviceAccountFile: saRaw ? expand(saRaw, paths.root) : null,
    serviceAccountFileSource: saRaw ? (sourceOf(secrets, 'GOOGLE_APPLICATION_CREDENTIALS') ?? 'env') : 'unset',
  };
  for (const f of [out.clientFile, out.tokenFile, out.serviceAccountFile]) if (f) assertSafeCredentialPath(f, paths);
  return out;
}

/**
 * Credentials must stay outside the vault and outside tracked application
 * files. Paths are compared as written AND by where they really are
 * (isWithinRealPath: symbolic links resolved through the deepest existing
 * ancestor of a file that does not exist yet, canonical letter case, and case
 * ignored on a case-insensitive volume), so a path that reaches the vault or
 * the repository through a symlinked directory, or by a different letter case
 * on macOS ("<ws>/Vault/token.json"), is refused like a direct one.
 */
export function assertSafeCredentialPath(file: string, paths: WorkspacePaths): void {
  const abs = path.resolve(file);
  const real = resolveRealPath(abs);
  const via = real === abs ? '' : real.toLowerCase() === abs.toLowerCase() ? ` (it is ${real} spelled with a different letter case)` : ` (it resolves to ${real} through a symbolic link or a different letter case)`;
  const vault = path.resolve(paths.vaultRoot);
  if (isWithin(vault, abs) || isWithinRealPath(vault, real)) {
    throw new AppError('UNSAFE_PATH', `Google credential file ${abs} is inside the Obsidian vault${via}. Credentials must never live in the vault.`, {
      hint: `Move it to ${paths.googleDir} (mode 0600) or another private directory outside the vault.`,
    });
  }
  let repo: string | null = null;
  try {
    repo = appRoot();
  } catch {
    repo = null;
  }
  if (!repo) return;
  const root = path.resolve(paths.root);
  const lexicalInRepo = isWithin(repo, abs) && !isWithin(root, abs);
  const realInRepo = isWithinRealPath(repo, real) && !isWithinRealPath(root, real);
  if (lexicalInRepo || realInRepo) {
    throw new AppError('UNSAFE_PATH', `Google credential file ${abs} is inside the application repository${via}, where it could be committed.`, {
      hint: `Move it to ${paths.googleDir} (mode 0600) in your private workspace.`,
    });
  }
}
