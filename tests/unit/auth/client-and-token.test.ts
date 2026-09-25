import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOAuthClientFile, maskClientId, parseOAuthClientJson } from '../../../src/auth/client-file.js';
import { TOKEN_FORMAT, TokenStore, atomicWritePrivate, type StoredGoogleToken } from '../../../src/auth/token-store.js';
import { assertSafeCredentialPath, googleCredentialPaths } from '../../../src/auth/paths.js';
import { fixedClock } from '../../../src/core/clock.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { appRoot, workspacePaths } from '../../../src/config/paths.js';
import { redactString } from '../../../src/security/redact.js';
import { GOOGLE_FIXTURES } from '../../integration/google/_helpers.js';

const ACCESS = 'ya29.synthetic-access-token-value-0123456789';
const REFRESH = '1//synthetic-refresh-token-value-abcdefghijklmnopqrstuvwxyz';

/** Whether the temporary directory's filesystem ignores letter case (macOS APFS by default); probed independently of src/. */
function probeCaseInsensitive(): boolean {
  const d = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-case-probe-'));
  try {
    writeFileSync(path.join(d, 'probe-file'), 'x');
    return existsSync(path.join(d, 'PROBE-FILE'));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = probeCaseInsensitive();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-auth-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(overrides: Partial<StoredGoogleToken> = {}): StoredGoogleToken {
  return {
    format: TOKEN_FORMAT,
    client_id: 'synthetic-client.apps.googleusercontent.com',
    requested_scopes: ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'],
    tokens: { access_token: ACCESS, refresh_token: REFRESH, expiry_date: Date.parse('2026-09-24T10:00:00Z'), token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly' },
    obtained_via: 'desktop_loopback_pkce',
    created_at: '2026-09-10T09:00:00.000Z',
    updated_at: '2026-09-10T09:00:00.000Z',
    refresh_token_expires_at: null,
    ...overrides,
  };
}

describe('OAuth client file', () => {
  it('accepts a Desktop ("installed") client and masks the client id', () => {
    const info = loadOAuthClientFile(path.join(GOOGLE_FIXTURES, 'oauth/client-installed.json'));
    expect(info.type).toBe('installed');
    expect(info.clientId).toMatch(/apps\.googleusercontent\.com$/);
    expect(maskClientId(info.clientId)).not.toContain(info.clientId.split('.')[0]!.slice(8, -4));
    // The client secret is registered for redaction.
    expect(redactString(`secret=${info.clientSecret}`)).not.toContain(info.clientSecret!);
  });

  it('rejects a Web application client and a service-account key with actionable messages', () => {
    expect(() => loadOAuthClientFile(path.join(GOOGLE_FIXTURES, 'oauth/client-web.json'))).toThrow(/Desktop app/);
    expect(() => parseOAuthClientJson({ type: 'service_account', client_email: 'x@example.iam.gserviceaccount.com' })).toThrow(/service-account key/);
    expect(() => parseOAuthClientJson({})).toThrow(/installed/);
  });

  it('reports a missing client file as missing credentials', () => {
    try {
      loadOAuthClientFile(path.join(dir, 'nope.json'));
      expect.unreachable();
    } catch (err) {
      expect((err as { code: string }).code).toBe('CREDENTIALS_MISSING');
      expect((err as { hint: string }).hint).toMatch(/Desktop app/);
    }
  });
});

describe('TokenStore', () => {
  it('writes atomically with mode 0600 inside a 0700 directory', () => {
    const file = path.join(dir, 'secrets', 'google', 'token.json');
    const store = new TokenStore(file, fixedClock('2026-09-24T09:00:00Z'));
    store.write(record());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(file))).toEqual(['token.json']); // no temp files left behind
    expect(store.read()!.tokens.refresh_token).toBe(REFRESH);
  });

  it('tightens an existing permissive default directory and file on rewrite', () => {
    const gdir = path.join(dir, 'google');
    mkdirSync(gdir, { recursive: true, mode: 0o755 });
    chmodSync(gdir, 0o755);
    const file = path.join(gdir, 'token.json');
    writeFileSync(file, JSON.stringify(record()), { mode: 0o644 });
    chmodSync(file, 0o644);
    const store = new TokenStore(file, fixedClock('2026-09-24T09:00:00Z'));
    expect(store.summary().permissionsOk).toBe(false);
    expect(store.summary().hints.join(' ')).toMatch(/chmod 600/);
    store.write(record());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(gdir).mode & 0o777).toBe(0o700);
  });

  it('merges refreshed credentials and keeps the stored refresh token', () => {
    const store = new TokenStore(path.join(dir, 'token.json'), fixedClock('2026-09-24T09:00:00Z'));
    store.write(record());
    store.merge({ access_token: 'ya29.synthetic-new-access-token-9876543210', expiry_date: Date.parse('2026-09-24T11:00:00Z') });
    const r = store.read()!;
    expect(r.tokens.refresh_token).toBe(REFRESH);
    expect(r.tokens.access_token).toBe('ya29.synthetic-new-access-token-9876543210');
    expect(r.updated_at).toBe('2026-09-24T09:00:00.000Z');
  });

  it('summary exposes expiry hints but never token values', () => {
    const store = new TokenStore(path.join(dir, 'token.json'), fixedClock('2026-09-24T09:00:00Z'));
    store.write(record());
    const s = store.summary();
    const text = JSON.stringify(s);
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(REFRESH);
    expect(s).toMatchObject({ present: true, valid: true, hasRefreshToken: true, accessTokenExpiresAt: '2026-09-24T10:00:00.000Z', accessTokenExpired: false, ageDays: 14 });
    expect(s.hints.join(' ')).toMatch(/7 days after consent/);
    // Token values read from disk are registered for redaction everywhere.
    expect(redactString(`leak ${REFRESH} ${ACCESS}`)).not.toMatch(/synthetic-(refresh|access)/);
  });

  it('flags a missing refresh token and unreadable files', () => {
    const file = path.join(dir, 'token.json');
    const store = new TokenStore(file, fixedClock('2026-09-24T09:00:00Z'));
    store.write(record({ tokens: { access_token: ACCESS, expiry_date: 1 } }));
    expect(store.summary().hints.join(' ')).toMatch(/No refresh token/);
    writeFileSync(file, '{not json');
    expect(store.summary()).toMatchObject({ present: true, valid: false });
    expect(store.delete()).toBe(true);
    expect(store.summary().present).toBe(false);
  });
});

describe('credential paths', () => {
  it('defaults to the protected workspace directory and honours overrides', () => {
    const paths = workspacePaths(dir);
    const def = googleCredentialPaths(paths, new MemorySecretStore({}));
    expect(def.clientFile).toBe(path.join(dir, 'secrets', 'google', 'oauth-client.json'));
    expect(def.tokenFile).toBe(path.join(dir, 'secrets', 'google', 'token.json'));
    expect(def.tokenFileSource).toBe('default');
    const custom = googleCredentialPaths(paths, new MemorySecretStore({ GOOGLE_TOKEN_FILE: 'private/tok.json' }));
    expect(custom.tokenFile).toBe(path.join(dir, 'private', 'tok.json'));
    expect(custom.tokenFileSource).toBe('env');
  });

  it('refuses credential files inside the vault', () => {
    const paths = workspacePaths(dir);
    expect(() => googleCredentialPaths(paths, new MemorySecretStore({ GOOGLE_TOKEN_FILE: path.join(dir, 'vault', 'site', 'token.json') }))).toThrow(/vault/);
  });

  it('refuses a credential path that reaches the vault through a symlinked directory, even for a file that does not exist yet (C2-03)', () => {
    const paths = workspacePaths(dir);
    const vaultSite = path.join(paths.vaultRoot, 'site');
    mkdirSync(vaultSite, { recursive: true });
    // "private" looks like an ordinary workspace folder but is a symlink into the vault.
    symlinkSync(vaultSite, path.join(dir, 'private'), 'dir');
    for (const key of ['GOOGLE_TOKEN_FILE', 'GOOGLE_OAUTH_CLIENT_FILE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      expect(() => googleCredentialPaths(paths, new MemorySecretStore({ [key]: 'private/tok.json' }))).toThrow(/inside the Obsidian vault.*symbolic link/);
      // A deeper, not-yet-existing path under the link is resolved through its nearest existing ancestor.
      expect(() => googleCredentialPaths(paths, new MemorySecretStore({ [key]: path.join(dir, 'private', 'nested', 'deeper', 'tok.json') }))).toThrow(/vault/);
    }
    // A plain directory (no symlink) outside the vault is still accepted.
    mkdirSync(path.join(dir, 'real-private'));
    expect(googleCredentialPaths(paths, new MemorySecretStore({ GOOGLE_TOKEN_FILE: 'real-private/tok.json' })).tokenFile).toBe(path.join(dir, 'real-private', 'tok.json'));
  });

  it('refuses a credential path that reaches the application repository through a symlink (C2-03)', () => {
    const paths = workspacePaths(dir);
    symlinkSync(appRoot(), path.join(dir, 'repo-link'), 'dir');
    expect(() => assertSafeCredentialPath(path.join(dir, 'repo-link', 'never-written-token.json'), paths)).toThrow(/application repository/);
    expect(existsSync(path.join(appRoot(), 'never-written-token.json'))).toBe(false);
  });

  it('TokenStore re-checks the location right before writing: a parent swapped for a symlink into the vault is refused and nothing lands in the vault (C2-03)', () => {
    const paths = workspacePaths(dir);
    const vaultSite = path.join(paths.vaultRoot, 'site');
    mkdirSync(vaultSite, { recursive: true });
    const file = path.join(dir, 'private', 'token.json');
    assertSafeCredentialPath(file, paths); // fine when the store is created
    const store = new TokenStore(file, fixedClock('2026-09-24T09:00:00Z'), false, paths);
    symlinkSync(vaultSite, path.join(dir, 'private'), 'dir'); // swapped afterwards
    try {
      store.write(record());
      expect.unreachable();
    } catch (err) {
      expect((err as { code: string }).code).toBe('UNSAFE_PATH');
    }
    expect(readdirSync(vaultSite)).toEqual([]); // no token and no temp file in the vault
    // Without the swap the same store writes normally.
    rmSync(path.join(dir, 'private'));
    store.write(record());
    expect(store.read()!.tokens.refresh_token).toBe(REFRESH);
  });

  it.skipIf(!CASE_INSENSITIVE)('refuses "<ws>/Vault/token.json" and an upper-cased repository path on a case-insensitive filesystem (D3-02)', () => {
    const paths = workspacePaths(dir);
    // The vault does not exist yet: "Vault" is still the vault once it is created.
    expect(() => assertSafeCredentialPath(path.join(dir, 'Vault', 'token.json'), paths)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH', message: expect.stringMatching(/inside the Obsidian vault/) }));
    mkdirSync(path.join(paths.vaultRoot, 'site'), { recursive: true });
    for (const key of ['GOOGLE_TOKEN_FILE', 'GOOGLE_OAUTH_CLIENT_FILE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      expect(() => googleCredentialPaths(paths, new MemorySecretStore({ [key]: 'Vault/token.json' })), key).toThrow(/inside the Obsidian vault.*different letter case/);
      expect(() => googleCredentialPaths(paths, new MemorySecretStore({ [key]: path.join(dir, 'VAULT', 'Site', 'tok.json') })), key).toThrow(/vault/);
    }
    const repoUpper = appRoot().replace(/[a-z]/g, (c) => c.toUpperCase());
    expect(() => assertSafeCredentialPath(path.join(repoUpper, 'never-written-token.json'), paths)).toThrow(/application repository/);
    expect(existsSync(path.join(appRoot(), 'never-written-token.json'))).toBe(false);
  });

  it.skipIf(!CASE_INSENSITIVE)('TokenStore.write refuses a token file in the vault spelled with a different letter case; nothing lands in the vault (D3-02)', () => {
    const paths = workspacePaths(dir);
    const vaultSite = path.join(paths.vaultRoot, 'site');
    mkdirSync(vaultSite, { recursive: true });
    const store = new TokenStore(path.join(dir, 'Vault', 'Site', 'token.json'), fixedClock('2026-09-24T09:00:00Z'), false, paths);
    expect(() => store.write(record())).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(readdirSync(vaultSite)).toEqual([]);
  });

  it('atomicWritePrivate runs the check before creating the temp file and again before the rename', () => {
    const file = path.join(dir, 'token.json');
    let calls = 0;
    atomicWritePrivate(file, '{}\n', { check: () => void calls++ });
    expect(calls).toBe(2);
    let n = 0;
    expect(() =>
      atomicWritePrivate(path.join(dir, 'late.json'), '{}\n', {
        check: () => {
          if (++n === 2) throw new Error('location changed');
        },
      }),
    ).toThrow(/location changed/);
    expect(readdirSync(dir).sort()).toEqual(['token.json']); // the temp file was removed, nothing renamed
  });
});
