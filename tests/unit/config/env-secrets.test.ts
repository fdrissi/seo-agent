import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_DEFAULTS, ENV_KEYS, SECRET_ENV_KEYS, checkSecretFilePermissions, parseDotenv, readDotenvFile, serializeDotenv, upsertDotenv } from '../../../src/config/env.js';
import { LayeredSecretStore, MemorySecretStore } from '../../../src/config/secrets.js';
import { REDACTED, redactString } from '../../../src/security/redact.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-secrets-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Synthetic values only (never real credentials).
const FAKE = { llm: 'llmgw-synthetic-key-000000000001', apify: 'apify_api_SYNTHETICSYNTHETIC000001', dfs: 'synthetic-dfs-password-1' };

describe('parseDotenv', () => {
  it('parses KEY=VALUE lines with optional export, spaces, and CRLF', () => {
    expect(parseDotenv('A=1\r\nexport B = two\n  C=three  \n')).toEqual({ A: '1', B: 'two', C: 'three' });
  });

  it('skips comments, blank lines, and malformed lines', () => {
    expect(parseDotenv('# comment\n\n   # indented comment\nnot a pair\n1BAD=x\nGOOD=yes\n')).toEqual({ GOOD: 'yes' });
  });

  it('strips inline comments from unquoted values only', () => {
    expect(parseDotenv('A=value # note\nB=val#ue\nC="quoted # kept" # note\nD=\'single # kept\'  # note\nE=x\t# tab comment')).toEqual({
      A: 'value',
      B: 'val#ue',
      C: 'quoted # kept',
      D: 'single # kept',
      E: 'x',
    });
  });

  it('handles quotes and escapes without expansion or command substitution', () => {
    const parsed = parseDotenv(['A="line1\\nline2"', 'B=\'literal \\n $HOME\'', 'C=$HOME/x', 'D="$(rm -rf /) `id`"', 'E="say \\"hi\\""', 'F="C:\\\\new"', 'G="keep \\q"', 'H=""', 'I='].join('\n'));
    expect(parsed).toEqual({
      A: 'line1\nline2',
      B: 'literal \\n $HOME',
      C: '$HOME/x',
      D: '$(rm -rf /) `id`',
      E: 'say "hi"',
      F: 'C:\\new',
      G: 'keep \\q',
      H: '',
      I: '',
    });
  });

  it('serializeDotenv round-trips arbitrary values', () => {
    const values = { A: 'plain', B: 'with space', C: 'quote " and \\ backslash', D: 'multi\nline\r\nvalue\ttab', E: '#hash', F: "it's", G: '', H: 'C:\\new\\table' };
    expect(parseDotenv(serializeDotenv(values))).toEqual(values);
  });

  it('readDotenvFile returns {} for a missing file', () => {
    expect(readDotenvFile(path.join(dir, 'missing.env'))).toEqual({});
  });
});

describe('ENV metadata', () => {
  it('lists the documented variables; secrets are marked; defaults are non-secret', () => {
    for (const k of ['LLM_GATEWAY_API_KEY', 'GOOGLE_AUTH_MODE', 'APIFY_CONTENT_ACTOR_ID', 'QDRANT_URL', 'SEO_AGENT_WORKSPACE']) expect(ENV_KEYS).toContain(k);
    for (const k of SECRET_ENV_KEYS) expect(ENV_DEFAULTS[k]).toBeUndefined();
    expect(SECRET_ENV_KEYS.has('DATAFORSEO_PASSWORD')).toBe(true);
    expect(SECRET_ENV_KEYS.has('QDRANT_URL')).toBe(false);
  });

  it('the .env.example documents every recognised variable', () => {
    const example = readFileSync(path.join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
    for (const k of ENV_KEYS) expect(example).toContain(k);
  });

  it('the .env.example sets exactly the spec section 29 keys and defaults, uncommented', () => {
    // Spec section 29: `.env.example` with at least these KEY=default pairs (empty = no default).
    const SPEC_29_ENV: Array<[string, string]> = [
      ['LLM_GATEWAY_API_KEY', ''],
      ['LLM_GATEWAY_BASE_URL', 'https://api.llmgateway.io/v1'],
      ['CHEAP_MODEL', ''],
      ['REASONING_MODEL', ''],
      ['EMBEDDING_MODEL', ''],
      ['GOOGLE_AUTH_MODE', 'oauth'],
      ['GOOGLE_OAUTH_CLIENT_FILE', ''],
      ['GOOGLE_TOKEN_FILE', ''],
      ['GOOGLE_APPLICATION_CREDENTIALS', ''],
      ['DATAFORSEO_LOGIN', ''],
      ['DATAFORSEO_PASSWORD', ''],
      ['APIFY_TOKEN', ''],
      ['APIFY_CONTENT_ACTOR_ID', '9sHOY9RzPYGjmTHo8'],
      ['APIFY_CONTENT_ACTOR_BUILD', ''],
      ['QDRANT_URL', 'http://127.0.0.1:6333'],
      ['QDRANT_API_KEY', ''],
      ['PAGESPEED_API_KEY', ''],
    ];
    expect(SPEC_29_ENV).toHaveLength(17); // the spec lists 17 keys
    const example = readFileSync(path.join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
    // Uncommented assignment lines only (a commented-out key does not count).
    const pairs = new Map<string, string[]>();
    for (const raw of example.split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw);
      if (m) pairs.set(m[1]!, [...(pairs.get(m[1]!) ?? []), m[2]!]);
    }
    for (const [key, value] of SPEC_29_ENV) {
      expect(pairs.get(key), `${key} must appear exactly once, uncommented`).toEqual([value]);
    }
    // Secrets never carry a value in the example.
    for (const k of SECRET_ENV_KEYS) if (pairs.has(k)) expect(pairs.get(k), k).toEqual(['']);
    // parseDotenv reads the same pairs the application will see.
    const parsed = parseDotenv(example);
    for (const [key, value] of SPEC_29_ENV) expect(parsed[key], key).toBe(value);
  });
});

describe('LayeredSecretStore precedence: env > secrets file > defaults', () => {
  const secretsFile = () => path.join(dir, 'secrets', 'secrets.env');
  const writeSecrets = (content: string, mode = 0o600) => {
    mkdirSync(path.dirname(secretsFile()), { recursive: true, mode: 0o700 });
    writeFileSync(secretsFile(), content, { mode });
    chmodSync(secretsFile(), mode);
  };

  it('prefers the process environment, then the secrets file, then built-in defaults', () => {
    writeSecrets(`CHEAP_MODEL=file-model\nREASONING_MODEL=file-reasoning\nQDRANT_URL=http://127.0.0.1:7000\nAPIFY_TOKEN=${FAKE.apify}\n`);
    const store = new LayeredSecretStore(secretsFile(), { CHEAP_MODEL: 'env-model', REASONING_MODEL: '' });
    expect(store.get('CHEAP_MODEL')).toBe('env-model');
    expect(store.sourceOf('CHEAP_MODEL')).toBe('env');
    // An empty env var does not mask the file value.
    expect(store.get('REASONING_MODEL')).toBe('file-reasoning');
    expect(store.sourceOf('REASONING_MODEL')).toBe('secrets-file');
    expect(store.get('QDRANT_URL')).toBe('http://127.0.0.1:7000');
    expect(store.get('LLM_GATEWAY_BASE_URL')).toBe(ENV_DEFAULTS.LLM_GATEWAY_BASE_URL);
    expect(store.sourceOf('LLM_GATEWAY_BASE_URL')).toBe('default');
    expect(store.get('PAGESPEED_API_KEY')).toBeUndefined();
    expect(store.has('PAGESPEED_API_KEY')).toBe(false);
    expect(store.sourceOf('PAGESPEED_API_KEY')).toBe('unset');
    expect(store.has('APIFY_TOKEN')).toBe(true);
  });

  it('registers secret values (from env and file) for redaction, but not public values', () => {
    writeSecrets(`APIFY_TOKEN=${FAKE.apify}\nDATAFORSEO_LOGIN=owner@example.invalid\nQDRANT_URL=http://127.0.0.1:6333\n`);
    new LayeredSecretStore(secretsFile(), { LLM_GATEWAY_API_KEY: FAKE.llm });
    expect(redactString(`keys ${FAKE.llm} ${FAKE.apify}`)).toBe(`keys ${REDACTED} ${REDACTED}`);
    // The DataForSEO login is an account identifier (often an e-mail address): masked too.
    expect(redactString('owner@example.invalid')).toBe(REDACTED);
    // Public, non-secret values stay readable.
    expect(redactString('http://127.0.0.1:6333')).toBe('http://127.0.0.1:6333');
  });

  it('works without a secrets file', () => {
    const store = new LayeredSecretStore(null, {});
    expect(store.get('GOOGLE_AUTH_MODE')).toBe('oauth');
    expect(store.warnings()).toEqual([]);
    expect(() => store.set('APIFY_TOKEN', FAKE.apify)).toThrow(/No secrets file/);
  });

  it('warns (without printing values) when the secrets file or directory is readable by others', () => {
    writeSecrets(`APIFY_TOKEN=${FAKE.apify}\n`, 0o644);
    chmodSync(path.dirname(secretsFile()), 0o755);
    const warnings = new LayeredSecretStore(secretsFile(), {}).warnings();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('chmod 600');
    expect(warnings[1]).toContain('chmod 700');
    expect(warnings.join('\n')).not.toContain(FAKE.apify);
    expect(checkSecretFilePermissions(path.join(dir, 'missing'))).toBeNull();
  });

  it('set() writes a 0600 file atomically (rename), creates a 0700 dir, and keeps other keys', () => {
    writeSecrets('# header comment\nQDRANT_URL=http://127.0.0.1:7000\n');
    const before = statSync(secretsFile()).ino;
    const store = new LayeredSecretStore(secretsFile(), {});
    store.set('DATAFORSEO_PASSWORD', `${FAKE.dfs} with "quotes" and \\ #hash`);
    const st = statSync(secretsFile());
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.ino).not.toBe(before); // replaced by rename, never truncated in place
    expect(statSync(path.dirname(secretsFile())).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(secretsFile()))).toEqual(['secrets.env']); // no temp files left
    const reread = readDotenvFile(secretsFile());
    expect(reread).toEqual({ QDRANT_URL: 'http://127.0.0.1:7000', DATAFORSEO_PASSWORD: `${FAKE.dfs} with "quotes" and \\ #hash` });
    expect(store.get('DATAFORSEO_PASSWORD')).toBe(reread.DATAFORSEO_PASSWORD);
    // Comments and other lines are kept verbatim; the new key is appended.
    expect(readFileSync(secretsFile(), 'utf8').split('\n').slice(0, 2)).toEqual(['# header comment', 'QDRANT_URL=http://127.0.0.1:7000']);
    // The whole stored value is registered for redaction.
    expect(redactString(`error: ${reread.DATAFORSEO_PASSWORD!} rejected`)).toBe(`error: ${REDACTED} rejected`);
  });

  it('set() keeps the init template guidance, comments, and unparsed lines verbatim and updates only the target line', () => {
    const original = [
      '# Private secrets for this workspace. Mode 0600. Never commit or share.',
      '# LLM_GATEWAY_API_KEY=',
      'export APIFY_TOKEN=FAKE-old-value # rotated monthly',
      '',
      'this line is not KEY=VALUE for the parser',
      'QDRANT_URL=http://127.0.0.1:6333',
      'APIFY_TOKEN=FAKE-duplicate-old-value',
    ].join('\n') + '\n';
    writeSecrets(original);
    const store = new LayeredSecretStore(secretsFile(), {});
    store.set('APIFY_TOKEN', FAKE.apify);
    store.set('LLM_GATEWAY_API_KEY', FAKE.llm);
    const text = readFileSync(secretsFile(), 'utf8');
    expect(text).toBe(
      [
        '# Private secrets for this workspace. Mode 0600. Never commit or share.',
        '# LLM_GATEWAY_API_KEY=',
        `export APIFY_TOKEN=${FAKE.apify}`,
        '',
        'this line is not KEY=VALUE for the parser',
        'QDRANT_URL=http://127.0.0.1:6333',
        `APIFY_TOKEN=${FAKE.apify}`,
        `LLM_GATEWAY_API_KEY=${FAKE.llm}`,
      ].join('\n') + '\n',
    );
    expect(readDotenvFile(secretsFile())).toEqual({ APIFY_TOKEN: FAKE.apify, QDRANT_URL: 'http://127.0.0.1:6333', LLM_GATEWAY_API_KEY: FAKE.llm });
    expect(new LayeredSecretStore(secretsFile(), {}).get('APIFY_TOKEN')).toBe(FAKE.apify);
  });

  it('upsertDotenv preserves CRLF line endings and a missing final newline is added once', () => {
    expect(upsertDotenv('# c\r\nA=1\r\n', 'A', '2')).toBe('# c\r\nA=2\r\n');
    expect(upsertDotenv('A=1', 'B', 'x y')).toBe('A=1\nB="x y"\n');
    expect(upsertDotenv('', 'B', 'v')).toBe('B=v\n');
    expect(upsertDotenv('  B = old\n', 'B', 'new')).toBe('  B=new\n');
    expect(() => upsertDotenv('', 'BAD KEY', 'v')).toThrow(/Invalid/);
  });

  it('set() creates the secrets directory and file when missing', () => {
    const file = path.join(dir, 'fresh', 'secrets', 'secrets.env');
    new LayeredSecretStore(file, {}).set('APIFY_TOKEN', FAKE.apify);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});

describe('MemorySecretStore', () => {
  it('serves given values, falls back to defaults, and registers secrets', () => {
    const store = new MemorySecretStore({ APIFY_TOKEN: FAKE.apify, CHEAP_MODEL: 'test-cheap' });
    expect(store.get('APIFY_TOKEN')).toBe(FAKE.apify);
    expect(store.sourceOf('CHEAP_MODEL')).toBe('env');
    expect(store.get('QDRANT_URL')).toBe('http://127.0.0.1:6333');
    expect(store.sourceOf('QDRANT_URL')).toBe('default');
    expect(store.sourceOf('REASONING_MODEL')).toBe('unset');
    expect(redactString(FAKE.apify)).toBe(REDACTED);
    store.set('QDRANT_API_KEY', 'synthetic-qdrant-key-01');
    expect(redactString('synthetic-qdrant-key-01')).toBe(REDACTED);
  });
});
