import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RANDOM_TOKEN_RULES,
  compileAllowlist,
  containsMarker,
  fingerprint,
  globToRegExp,
  hasRepeatedRun,
  hasSequentialRun,
  isDotenvPath,
  looksLikePlaceholder,
  scanFileContent,
  scanPathName,
  scanText,
  shannonEntropy,
  validateAllowlist,
} from '../../../scripts/lib/secret-rules.mjs';
import { opensshEd25519PrivateKey } from './openssh-key.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' }).error === undefined;

// All secret-shaped values are generated at runtime so no literal credential shape exists in this file.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function rand(n: number, charset = ALNUM): string {
  // Avoid accidental ascending runs/markers: regenerate until clean.
  for (;;) {
    const s = Array.from(randomBytes(n), (b) => charset[b % charset.length]).join('');
    if (!hasSequentialRun(s, 4) && !containsMarker(s, ['fake', 'test', 'example', 'dummy', 'sample', 'mock'])) return s;
  }
}
const HEX = '0123456789abcdef';
/**
 * A random hex credential that has the character-class mix and entropy of a generated secret.
 * Plain `rand(16, HEX)` occasionally yields a low-entropy or digit-free value that the rule
 * correctly ignores, which made the detection test flaky.
 */
function hexSecret(n: number): string {
  for (;;) {
    const v = rand(n, HEX);
    if (/[0-9]/.test(v) && /[a-f]/.test(v) && shannonEntropy(v) >= 3.3) return v;
  }
}
const plain = compileAllowlist({});

function rules(text: string, path = 'src/example.ts'): string[] {
  return scanFileContent(path, text, plain)
    .filter((f) => !f.allowlisted)
    .map((f) => f.rule);
}

describe('secret rules: detection of credential shapes', () => {
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it.each([
    ['google-api-key', () => `const key = "AIza${rand(35)}";`],
    ['google-oauth-client-secret', () => `secret=GOCSPX-${rand(28)}`],
    ['google-oauth-refresh-token', () => `refresh: 1//0${rand(45)}`],
    ['google-oauth-access-token', () => `ya29.${rand(80)}`],
    ['apify-token', () => `APIFY_TOKEN=apify_api_${rand(36)}`],
    ['llm-gateway-key', () => `LLM_GATEWAY_API_KEY=llmgtwy_${rand(32)}`],
    ['openai-style-key', () => `key sk-${rand(40)}`],
    ['github-token', () => `ghp_${rand(36)}`],
    ['aws-access-key-id', () => `AKIA${rand(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`],
    ['jwt', () => `eyJ${rand(20)}.eyJ${rand(30)}.${rand(30)}`],
    ['authorization-bearer', () => `curl -H "Authorization: Bearer ${rand(48)}"`],
    ['authorization-basic', () => `Authorization: Basic ${Buffer.from(`login@example.invalid:${rand(16)}`).toString('base64')}`],
    ['url-credentials', () => `postgres://admin:${rand(14)}@db.internal.invalid/app`],
    ['google-service-account-key', () => JSON.stringify({ type: 'service_account', private_key_id: rand(40, HEX) })],
    ['oauth-client-secret-json', () => JSON.stringify({ installed: { client_id: 'x.apps.googleusercontent.com', client_secret: rand(24) } })],
    ['secret-assignment', () => `const apiKey = "${rand(32)}";`],
    ['secret-assignment', () => `DATAFORSEO_PASSWORD=${hexSecret(16)}`],
    ['npmrc-auth-token', () => `//registry.npmjs.org/:_authToken=${rand(36)}`],
  ])('detects %s', (rule, make) => {
    expect(rules(make())).toContain(rule);
  });

  it('detects letters-only values when they are literals (URL passwords, quoted strings, KEY=value)', () => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    expect(rules(`https://admin:${rand(14, letters)}@db.internal.invalid/x`)).toContain('url-credentials');
    expect(rules(`const apiKey = "${rand(32, letters)}";`)).toContain('secret-assignment');
    expect(rules(`DATAFORSEO_PASSWORD=${rand(16, letters)}`, '.env.local')).toContain('secret-assignment');
  });

  it('detects PEM private keys, including JSON-escaped service-account keys', () => {
    expect(rules(pem)).toContain('private-key');
    expect(rules(JSON.stringify({ private_key: pem }))).toContain('private-key');
  });

  it('flags .env files with values and credential/database file names', () => {
    expect(scanFileContent('.env.production', `NODE_ENV=production\n`, plain).map((f) => f.rule)).toContain('dotenv-with-values');
    expect(scanFileContent('.env.example', `LLM_GATEWAY_API_KEY=\nQDRANT_URL=http://127.0.0.1:6333\n`, plain)).toEqual([]);
    expect(isDotenvPath('config/.env')).toBe(true);
    expect(isDotenvPath('.env.example')).toBe(false);
    expect(scanPathName('keys/id_ed25519', plain).map((f) => f.rule)).toEqual(['private-key-file']);
    expect(scanPathName('data/seo-agent.sqlite', plain).map((f) => f.rule)).toEqual(['database-file']);
    expect(scanPathName('secrets/secrets.env', plain).map((f) => f.rule)).toEqual(['credential-file']);
  });

  it('reports line numbers, length, and a fingerprint but never the value', () => {
    const value = `apify_api_${rand(36)}`;
    const findings = scanText(`line one\nline two\nconst t = '${value}';\n`, 'src/a.ts', plain);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f).toMatchObject({ rule: 'apify-token', path: 'src/a.ts', line: 3, length: value.length });
    expect(f.fingerprint).toBe(fingerprint(value));
    expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(findings)).not.toContain(value);
    expect(JSON.stringify(findings)).not.toContain(value.slice(10, 30));
  });

  it('maps history hunk lines through a line map', () => {
    const value = `ya29.${rand(60)}`;
    const f = scanText(`a\n${value}`, 'x.txt', plain, 0, [40, 41]);
    expect(f[0]?.line).toBe(41);
  });
});

describe('secret rules: false-positive resistance', () => {
  it.each([
    'LLM_GATEWAY_API_KEY=',
    'GOOGLE_TOKEN_FILE=\nLLM_GATEWAY_BASE_URL=https://api.llmgateway.io/v1',
    'const token = opts.token;',
    'hasRefreshToken: !!tokens.refresh_token,',
    'secretsEnvFile: path.join(secretsDir, "secrets.env"),',
    'export const TOKEN_ESTIMATOR_VERSION = "tok-heuristic-v1";',
    'const SPECIAL_TOKEN_RE = /<\\|[^|<>]{0,40}\\|>/g;',
    'keptTokens: estimateTokens(cut),',
    'apiKey: process.env.LLM_GATEWAY_API_KEY,',
    'password: z.string().min(1),',
    'Authorization: Bearer ${token}',
    'Send `Authorization: Bearer <access_token>`',
    'url: "https://user:pass@example.com/"',
    'apiKey: ${QDRANT_API_KEY}',
    '"integrity": "sha512-YSbfekd470/33YgGpIULDkoTsnNaYdbGpTcmjgsMXxHEuIOy3meqtAX6PoICvy6D/uiJ9gu/mvJT5fIo6zzBJw=="',
    'regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/g',
    "message: 'Service-account mode without GOOGLE_APPLICATION_CREDENTIALS: Application Default Credentials'",
    'const apiKey = apiKeyFromStore;',
  ])('ignores %s', (text) => {
    expect(rules(text)).toEqual([]);
  });

  it('treats placeholders and references as non-secrets', () => {
    for (const v of ['<token>', '${API_KEY}', '{{secret}}', 'changeme', 'REDACTED', 'process.env.X', 'LLM_GATEWAY_API_KEY', '********']) {
      expect(looksLikePlaceholder(v), v).toBe(true);
    }
    expect(looksLikePlaceholder(rand(24))).toBe(false);
  });
});

describe('secret rules: allowlist', () => {
  it('exempts values with a marker only at a word boundary', () => {
    expect(containsMarker('ya29.FAKE-access-token', ['fake'])).toBe(true);
    expect(containsMarker('sk-SYNTHETIC0000', ['synthetic'])).toBe(true);
    expect(containsMarker('Xy7fakeQ9', ['fake'])).toBe(false); // random-looking interior match is not exempt
    const f = scanText(`ya29.FAKE-${rand(40)}`, 'src/a.ts', plain)[0]!;
    expect(f.allowlisted).toBe('marker');
  });

  it('exempts long markers anywhere and short markers only at a boundary or when repeated', () => {
    expect(containsMarker('sk-thisisasyntheticvalue123', ['synthetic'])).toBe(true); // 6+ chars: anywhere
    expect(containsMarker('AIzaSyFAKEFAKEFAKE123', ['fake'])).toBe(true); // repeated short marker
    expect(containsMarker('Q9fakeZ', ['fake'])).toBe(false); // single short marker inside random text
  });

  it('exempts obviously fabricated ascending or identical runs', () => {
    expect(hasSequentialRun('abcdefgh')).toBe(true);
    expect(hasSequentialRun('x12345678y')).toBe(true);
    expect(hasSequentialRun('abcdXYZ1234')).toBe(false);
    expect(hasRepeatedRun('AIzaSy000000000000')).toBe(true);
    expect(hasRepeatedRun('aabbccdd')).toBe(false);
    const f = scanText(`AIza${rand(20)}000000000000000`, 'src/a.ts', plain)[0]!;
    expect(f.allowlisted).toBe('sequence');
  });

  it('supports path-scoped markers and fingerprints with rule/path constraints', () => {
    const value = `ya29.test-${rand(40)}`;
    const al = compileAllowlist({ pathMarkers: [{ glob: 'tests/**', markers: ['test'] }] });
    expect(scanText(value, 'tests/unit/a.test.ts', al)[0]?.allowlisted).toBe('path-marker');
    expect(scanText(value, 'src/a.ts', al)[0]?.allowlisted).toBeUndefined();

    const real = `apify_api_${rand(36)}`;
    const fp = fingerprint(real);
    const byFp = compileAllowlist({ fingerprints: [{ fingerprint: fp, rule: 'apify-token', path: 'tests/**', reason: 'unit' }] });
    expect(scanText(real, 'tests/x.ts', byFp)[0]?.allowlisted).toBe('fingerprint');
    expect(scanText(real, 'src/x.ts', byFp)[0]?.allowlisted).toBeUndefined();
  });

  it('globToRegExp handles ** and *', () => {
    expect(globToRegExp('tests/**').test('tests/a/b.ts')).toBe(true);
    expect(globToRegExp('tests/**/*.json').test('tests/x.json')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('secret rules: private keys are never exempted by body content or indentation (regression)', () => {
  const repoAllowlist = compileAllowlist(JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts', 'secret-scan-allowlist.json'), 'utf8')));
  const findingsFor = (p: string, text: string) => scanFileContent(p, text, repoAllowlist).filter((f) => f.rule === 'private-key');

  it('flags an OpenSSH-format key (long "AAAA" runs in the base64 body) with the repository allowlist', () => {
    const key = opensshEd25519PrivateKey('someone@host.invalid');
    expect(key).toMatch(/AAAAAAAA/); // the structural zero runs that used to trigger the sequence exemption
    const f = findingsFor('deploy/deploy_key', key);
    expect(f).toHaveLength(1);
    expect(f[0]?.allowlisted).toBeUndefined();
  });

  it.skipIf(!hasSshKeygen)('flags real ssh-keygen output (ed25519 and RSA)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-sshkey-'));
    try {
      for (const [type, extra] of [['ed25519', []], ['rsa', ['-b', '2048']]] as const) {
        const file = path.join(dir, `k_${type}`);
        const r = spawnSync('ssh-keygen', ['-q', '-t', type, ...extra, '-N', '', '-C', 'synthetic@host.invalid', '-f', file], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const f = findingsFor(`deploy/id_${type}_copy`, readFileSync(file, 'utf8'));
        expect(f, type).toHaveLength(1);
        expect(f[0]?.allowlisted, type).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags PEM keys indented by 8+ spaces (YAML block scalars, template literals)', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const yaml = `apiVersion: v1\nkind: Secret\nstringData:\n  key.pem: |\n${pem.split('\n').map((l) => `        ${l}`).join('\n')}\n`;
    const ts = `export const k = \`\n${pem.split('\n').map((l) => `            ${l}`).join('\n')}\`;\n`;
    for (const [p, text] of [['k8s/secret.yaml', yaml], ['src/key.ts', ts]] as const) {
      const f = findingsFor(p, text);
      expect(f, p).toHaveLength(1);
      expect(f[0]?.allowlisted, p).toBeUndefined();
    }
  });

  it('honors a marker only in the BEGIN label or a comment line, never inside the base64 body', () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const labelled = pem.replace(/PRIVATE KEY-----/g, 'SYNTHETIC PRIVATE KEY-----').replace(/-----BEGIN SYNTHETIC/, '-----BEGIN FAKE SYNTHETIC');
    expect(findingsFor('src/a.ts', labelled)[0]?.allowlisted).toBe('marker');
    const lines = pem.split('\n');
    lines.splice(2, 0, 'SYNTHETICSYNTHETICSYNTHETICexampleEXAMPLEfakeFAKE0123456789abcdefghij');
    expect(findingsFor('src/b.ts', lines.join('\n'))[0]?.allowlisted).toBeUndefined();
    // Words after the key (outside the block) do not exempt a truncated key either.
    const truncated = `${lines.slice(0, 3).join('\n')}\n\nThis is an example config file.`;
    expect(findingsFor('src/c.ts', truncated)[0]?.allowlisted).toBeUndefined();
  });
});

describe('secret rules: the fabricated-run heuristic applies only to machine-generated token rules (regression)', () => {
  // Human-chosen passwords with ascending runs, assembled at runtime so this
  // source file itself contains no credential-shaped literal.
  const pw = (...parts: string[]) => parts.join('');
  it.each([
    ['.env.production', `DB_PASSWORD=${pw('Summer', '12345678!')}\n`, ['secret-assignment', 'dotenv-with-values']],
    ['src/db.ts', `const u = "postgres://app:${pw('Qwerty', '12345678')}@db.internal.invalid/app";`, ['url-credentials']],
    ['config/mail.yaml', `smtp_password: "${pw('Welcome2', 'abcdefgh')}"\n`, ['secret-assignment']],
    ['src/basic.ts', `const h = "Basic ${Buffer.from(pw('admin:', 'Password', '123456789')).toString('base64')}";`, ['authorization-basic']],
  ])('does not exempt human-chosen secrets with ascending runs (%s)', (p, text, expected) => {
    const f = scanFileContent(p, text, compileAllowlist({}));
    for (const rule of expected) {
      const hit = f.find((x) => x.rule === rule);
      expect(hit, rule).toBeDefined();
      expect(hit?.allowlisted, rule).toBeUndefined();
    }
  });

  it('still exempts random-token rules with a 10+ character fabricated run, but not an 8-character one', () => {
    expect(RANDOM_TOKEN_RULES.has('google-api-key')).toBe(true);
    expect(RANDOM_TOKEN_RULES.has('secret-assignment')).toBe(false);
    expect(RANDOM_TOKEN_RULES.has('private-key')).toBe(false);
    expect(scanText(`AIza${rand(25)}0000000000`, 'src/a.ts', plain)[0]?.allowlisted).toBe('sequence');
    expect(scanText(`AIza${rand(27)}abcdefgh`, 'src/a.ts', plain)[0]?.allowlisted).toBeUndefined();
  });

  it('treats quoted multi-word prose assigned to a secret-named key as prose', () => {
    expect(rules("  DATAFORSEO_PASSWORD: 'DataForSEO API password.',")).toEqual([]);
    expect(rules(`  DATAFORSEO_PASSWORD: '${rand(18)}',`)).toContain('secret-assignment');
  });
});

describe('secret rules: allowlist validation', () => {
  it('accepts the repository allowlist file', () => {
    expect(validateAllowlist(JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts', 'secret-scan-allowlist.json'), 'utf8')))).toEqual([]);
  });

  it.each([
    ['bare-string ignore glob', { version: 1, ignorePaths: ['**'] }, /bare strings/],
    ['catch-all ignore glob', { version: 1, ignorePaths: [{ glob: '**', reason: 'synthetic reason text' }] }, /literal directory/],
    ['extension-wide ignore glob', { version: 1, ignorePaths: [{ glob: '*.json', reason: 'synthetic reason text' }] }, /literal directory/],
    ['whole top-level directory', { version: 1, ignorePaths: [{ glob: 'tests/**', reason: 'synthetic reason text' }] }, /whole top-level directory/],
    ['ignore entry without reason', { version: 1, ignorePaths: [{ glob: 'tests/fixtures/x.json' }] }, /reason/],
    ['one-letter marker', { version: 1, markers: ['e'] }, /shorter than 4/],
    ['short path marker', { version: 1, pathMarkers: [{ glob: 'tests/**', markers: ['ab'], reason: 'synthetic reason text' }] }, /shorter than 4/],
    ['fingerprint without reason', { version: 1, fingerprints: [{ fingerprint: '0123456789abcdef' }] }, /reason/],
    ['malformed fingerprint', { version: 1, fingerprints: [{ fingerprint: 'xyz', reason: 'synthetic reason text' }] }, /16-hex/],
    ['unknown key', { version: 1, ignore: [] }, /unknown top-level key/],
    ['wrong version', { version: 2 }, /version/],
  ])('rejects %s', (_name, raw, re) => {
    const problems = validateAllowlist(raw);
    expect(problems.join('\n')).toMatch(re);
  });

  it('accepts a narrow, reasoned ignore entry', () => {
    expect(validateAllowlist({ version: 1, ignorePaths: [{ glob: 'tests/fixtures/security/injection/fixtures.json', reason: 'generated synthetic fixture file' }] })).toEqual([]);
  });
});
