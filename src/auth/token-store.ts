import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Credentials } from 'google-auth-library';
import { AppError } from '../core/errors.js';
import { systemClock, type Clock } from '../core/clock.js';
import { registerSecret } from '../security/redact.js';
import type { WorkspacePaths } from '../config/paths.js';
import { assertSafeCredentialPath } from './paths.js';

/**
 * Local OAuth token persistence. The token file lives in the protected
 * workspace secrets directory (file 0600, directory 0700) and is written
 * atomically (temp file in the same directory + fsync + rename). Token values
 * are registered with the redactor on load and never returned by `summary()`.
 */

export const TOKEN_FORMAT = 'seo-agent/google-oauth-token@1';

export interface StoredGoogleToken {
  format: typeof TOKEN_FORMAT;
  /** Client the token was issued to (needed for refresh/revoke). Not a secret. */
  client_id: string;
  requested_scopes: string[];
  tokens: Credentials;
  obtained_via: 'desktop_loopback_pkce';
  created_at: string;
  updated_at: string;
  /** Present only when Google granted time-based access (refresh_token_expires_in). */
  refresh_token_expires_at: string | null;
}

export interface TokenSummary {
  present: boolean;
  file: string;
  fileMode: string | null;
  permissionsOk: boolean | null;
  valid: boolean;
  problem: string | null;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  accessTokenExpiresAt: string | null;
  accessTokenExpired: boolean | null;
  grantedScopes: string[];
  requestedScopes: string[];
  createdAt: string | null;
  updatedAt: string | null;
  ageDays: number | null;
  refreshTokenExpiresAt: string | null;
  hints: string[];
}

function registerTokenSecrets(t: Credentials | undefined): void {
  if (!t) return;
  registerSecret(t.access_token ?? null);
  registerSecret(t.refresh_token ?? null);
  registerSecret(t.id_token ?? null);
}

export function fileMode(file: string): number | null {
  if (!existsSync(file)) return null;
  return statSync(file).mode & 0o777;
}

/** Create the directory with 0700 when missing; tighten the default secrets/google directory. */
export function ensurePrivateDir(dir: string, opts: { tighten: boolean }): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && opts.tighten) chmodSync(dir, 0o700);
}

/**
 * Atomic write with mode 0600: temp file in the same directory, fsync, rename.
 * `check` (optional) runs immediately before the temp file is created and
 * again immediately before the rename, so a location check (for example
 * "not inside the vault, even through a symlink") is repeated at write time
 * instead of trusting a check made earlier.
 */
export function atomicWritePrivate(file: string, content: string, opts: { check?: () => void } = {}): void {
  const dir = path.dirname(file);
  opts.check?.();
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    opts.check?.();
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

export class TokenStore {
  constructor(
    readonly file: string,
    private readonly clock: Clock = systemClock,
    /** Whether the parent directory is the default protected directory (then it is chmod 0700). */
    private readonly tightenDir = true,
    /**
     * Workspace paths: when given, every write re-checks (with symlinks resolved and letter case compared
     * canonically, so "<ws>/Vault/token.json" counts as inside "<ws>/vault" on macOS) that the token file is
     * outside the vault and the application repository, right before the directory is created and the
     * file is written.
     */
    private readonly workspace: WorkspacePaths | null = null,
  ) {}

  exists(): boolean {
    return existsSync(this.file);
  }

  read(): StoredGoogleToken | null {
    if (!existsSync(this.file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      throw new AppError('CONFIG_INVALID', `Google token file ${this.file} is not valid JSON.`, { hint: 'Delete it and run `npm run cli -- auth google` again.' });
    }
    const t = parsed as Partial<StoredGoogleToken>;
    if (t.format !== TOKEN_FORMAT || !t.tokens || typeof t.tokens !== 'object' || typeof t.client_id !== 'string') {
      throw new AppError('CONFIG_INVALID', `Google token file ${this.file} has an unexpected format.`, { hint: 'Delete it and run `npm run cli -- auth google` again.' });
    }
    registerTokenSecrets(t.tokens);
    return t as StoredGoogleToken;
  }

  write(record: StoredGoogleToken): void {
    registerTokenSecrets(record.tokens);
    const workspace = this.workspace;
    const check = workspace ? () => assertSafeCredentialPath(this.file, workspace) : undefined;
    check?.();
    ensurePrivateDir(path.dirname(this.file), { tighten: this.tightenDir });
    atomicWritePrivate(this.file, JSON.stringify(record, null, 2) + '\n', check ? { check } : {});
  }

  /** Persist refreshed credentials. The refresh-path 'tokens' event usually lacks refresh_token, so the stored one is kept. */
  merge(update: Credentials): StoredGoogleToken | null {
    const current = this.read();
    if (!current) return null;
    const tokens: Credentials = { ...current.tokens, ...stripUndefined(update), refresh_token: update.refresh_token ?? current.tokens.refresh_token ?? null };
    const next: StoredGoogleToken = { ...current, tokens, updated_at: this.clock.now().toISOString() };
    this.write(next);
    return next;
  }

  delete(): boolean {
    if (!existsSync(this.file)) return false;
    rmSync(this.file, { force: true });
    return true;
  }

  summary(): TokenSummary {
    const now = this.clock.now();
    const mode = fileMode(this.file);
    const base: TokenSummary = {
      present: mode !== null,
      file: this.file,
      fileMode: mode === null ? null : mode.toString(8).padStart(3, '0'),
      permissionsOk: mode === null || process.platform === 'win32' ? null : (mode & 0o077) === 0,
      valid: false,
      problem: null,
      hasRefreshToken: false,
      hasAccessToken: false,
      accessTokenExpiresAt: null,
      accessTokenExpired: null,
      grantedScopes: [],
      requestedScopes: [],
      createdAt: null,
      updatedAt: null,
      ageDays: null,
      refreshTokenExpiresAt: null,
      hints: [],
    };
    if (mode === null) {
      base.hints.push('No token yet: run `npm run cli -- auth google`.');
      return base;
    }
    let rec: StoredGoogleToken | null;
    try {
      rec = this.read();
    } catch (err) {
      base.problem = err instanceof Error ? err.message : String(err);
      return base;
    }
    if (!rec) return base;
    const t = rec.tokens;
    base.valid = true;
    base.hasRefreshToken = !!t.refresh_token;
    base.hasAccessToken = !!t.access_token;
    base.accessTokenExpiresAt = typeof t.expiry_date === 'number' ? new Date(t.expiry_date).toISOString() : null;
    base.accessTokenExpired = typeof t.expiry_date === 'number' ? t.expiry_date <= now.getTime() : null;
    base.grantedScopes = typeof t.scope === 'string' ? t.scope.split(/\s+/).filter(Boolean).sort() : [];
    base.requestedScopes = [...rec.requested_scopes].sort();
    base.createdAt = rec.created_at;
    base.updatedAt = rec.updated_at;
    base.ageDays = Math.floor((now.getTime() - Date.parse(rec.created_at)) / 86_400_000);
    base.refreshTokenExpiresAt = rec.refresh_token_expires_at;
    if (base.permissionsOk === false) base.hints.push(`Token file permissions are ${base.fileMode}; run: chmod 600 "${this.file}"`);
    if (!base.hasRefreshToken) base.hints.push('No refresh token stored: access stops when the access token expires. Re-run `npm run cli -- auth google` (it requests offline access with prompt=consent).');
    if (base.ageDays !== null && base.ageDays >= 6) {
      base.hints.push('If your OAuth app is External with publishing status "Testing", refresh tokens expire 7 days after consent; `auth diagnose` confirms whether a refresh still works.');
    }
    if (base.refreshTokenExpiresAt && Date.parse(base.refreshTokenExpiresAt) <= now.getTime() + 86_400_000) {
      base.hints.push(`Time-based access expires at ${base.refreshTokenExpiresAt}; re-authorize before then.`);
    }
    return base;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
