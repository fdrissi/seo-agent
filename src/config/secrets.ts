import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerSecret } from '../security/redact.js';
import { ENV_DEFAULTS, ENV_KEYS, SECRET_ENV_KEYS, checkSecretFilePermissions, parseDotenv, readDotenvFile, upsertDotenv, type EnvKey } from './env.js';

/**
 * Secret store. Secrets are read programmatically and never printed. Sources,
 * highest precedence first:
 *   1. Process environment (e.g. injected by a password manager: `op run -- ...`)
 *   2. Workspace protected secrets file: <workspace>/secrets/secrets.env (0600,
 *      directory 0700)
 *   3. Built-in non-secret defaults (e.g. LLM_GATEWAY_BASE_URL)
 *
 * Secrets never belong in the vault, site config, reports, or the repository.
 */
export interface SecretStore {
  get(key: EnvKey): string | undefined;
  has(key: EnvKey): boolean;
  /** Where a key's effective value comes from (never the value itself). */
  sourceOf(key: EnvKey): 'env' | 'secrets-file' | 'default' | 'unset';
  /** Persist a value to the protected secrets file (used by the setup wizard's hidden prompts). */
  set(key: EnvKey, value: string): void;
  warnings(): string[];
}

export class LayeredSecretStore implements SecretStore {
  private fileValues: Record<string, string>;

  constructor(
    private readonly secretsFile: string | null,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.fileValues = secretsFile ? readDotenvFile(secretsFile) : {};
    for (const key of ENV_KEYS) if (SECRET_ENV_KEYS.has(key)) registerSecret(this.get(key));
  }

  get(key: EnvKey): string | undefined {
    const fromEnv = this.env[key];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    const fromFile = this.fileValues[key];
    if (fromFile !== undefined && fromFile !== '') return fromFile;
    return ENV_DEFAULTS[key];
  }

  has(key: EnvKey): boolean {
    const v = this.get(key);
    return v !== undefined && v !== '';
  }

  sourceOf(key: EnvKey): 'env' | 'secrets-file' | 'default' | 'unset' {
    if (this.env[key]) return 'env';
    if (this.fileValues[key]) return 'secrets-file';
    if (ENV_DEFAULTS[key]) return 'default';
    return 'unset';
  }

  set(key: EnvKey, value: string): void {
    if (!this.secretsFile) throw new Error('No secrets file configured for this store');
    const dir = path.dirname(this.secretsFile);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    if (/[\r\n\0]/.test(key)) throw new Error('Invalid secret key name');
    // Update only this key's line: comments, guidance, and every other line stay verbatim.
    const current = existsSync(this.secretsFile) ? readFileSync(this.secretsFile, 'utf8') : '';
    const content = upsertDotenv(current, key, value);
    const next = parseDotenv(content);
    // Atomic replace: write a fresh 0600 temp file (never reuse a stale one whose
    // mode could be wider), then rename over the target in the same directory.
    const tmp = `${this.secretsFile}.tmp-${process.pid}-${Date.now()}`;
    rmSync(tmp, { force: true });
    try {
      writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') chmodSync(tmp, 0o600);
      renameSync(tmp, this.secretsFile);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    if (process.platform !== 'win32') chmodSync(this.secretsFile, 0o600);
    this.fileValues = next;
    if (SECRET_ENV_KEYS.has(key)) registerSecret(value);
  }

  warnings(): string[] {
    const out: string[] = [];
    if (this.secretsFile) {
      const w = checkSecretFilePermissions(this.secretsFile);
      if (w) out.push(w.message);
      if (existsSync(path.dirname(this.secretsFile)) && process.platform !== 'win32') {
        const dw = checkSecretFilePermissions(path.dirname(this.secretsFile));
        if (dw) out.push(dw.message.replace('chmod 600', 'chmod 700'));
      }
    }
    return out;
  }
}

/** In-memory store for tests and demo mode (no real credentials). */
export class MemorySecretStore implements SecretStore {
  constructor(private readonly values: Partial<Record<EnvKey, string>> = {}) {
    for (const [k, v] of Object.entries(values)) if (SECRET_ENV_KEYS.has(k as EnvKey)) registerSecret(v);
  }
  get(key: EnvKey): string | undefined {
    return this.values[key] ?? ENV_DEFAULTS[key];
  }
  has(key: EnvKey): boolean {
    return !!this.get(key);
  }
  sourceOf(key: EnvKey): 'env' | 'secrets-file' | 'default' | 'unset' {
    if (this.values[key]) return 'env';
    return ENV_DEFAULTS[key] ? 'default' : 'unset';
  }
  set(key: EnvKey, value: string): void {
    this.values[key] = value;
    if (SECRET_ENV_KEYS.has(key)) registerSecret(value);
  }
  warnings(): string[] {
    return [];
  }
}
