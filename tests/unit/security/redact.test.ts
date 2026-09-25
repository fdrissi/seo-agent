import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REDACTED, clearRegisteredSecrets, isSecretKey, redact, redactHeaders, redactString, registerSecret } from '../../../src/security/redact.js';
import { memoryLogger } from '../../../src/core/logger.js';

// Section 31: secret redaction. Values are generated at runtime (never committed).
const rand = (n: number) => randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);

describe('redaction of credential-bearing text', () => {
  it('masks Authorization Bearer and Basic headers in free text', () => {
    const bearer = rand(40);
    const basic = Buffer.from(`login@example.invalid:${rand(16)}`).toString('base64');
    const out = redactString(`GET /v1 HTTP/1.1\nAuthorization: Bearer ${bearer}\nProxy-Authorization: Basic ${basic}\n`);
    expect(out).not.toContain(bearer);
    expect(out).not.toContain(basic);
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).toContain(`Basic ${REDACTED}`);
  });

  it('masks Authorization and cookie headers in header objects and Headers instances', () => {
    const token = rand(32);
    const obj = redactHeaders({ Authorization: `Bearer ${token}`, 'X-Api-Key': rand(20), Cookie: `session=${rand(20)}`, 'content-type': 'application/json' });
    expect(obj.authorization).toBe(REDACTED);
    expect(obj['x-api-key']).toBe(REDACTED);
    expect(obj.cookie).toBe(REDACTED);
    expect(obj['content-type']).toBe('application/json');
    const h = new Headers({ authorization: `Bearer ${token}`, accept: 'text/html' });
    const fromHeaders = redactHeaders(h);
    expect(fromHeaders.authorization).toBe(REDACTED);
    expect(JSON.stringify(fromHeaders)).not.toContain(token);
  });

  it('masks credentials embedded in URLs and secret query parameters', () => {
    const pw = rand(14);
    const key = rand(30);
    const out = redactString(`connecting to https://admin:${pw}@db.example.invalid:5432/x?key=${key}&page=2 and qdrant http://u:${pw}@127.0.0.1:6333`);
    expect(out).not.toContain(pw);
    expect(out).not.toContain(key);
    expect(out).toContain('page=2');
    expect(out).toContain(`https://${REDACTED}@db.example.invalid`);
  });

  it('masks PEM private keys (multi-line and JSON-escaped)', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const body = pem.split('\n')[1]!;
    const out = redactString(`key file:\n${pem}\nend`);
    expect(out).not.toContain(body);
    expect(out).toContain(REDACTED);
    const inJson = redact({ credentials: { type: 'service_account', private_key: pem } });
    expect(JSON.stringify(inJson)).not.toContain(body);
  });

  it('masks registered secret values exactly, wherever they appear', () => {
    const secret = `v${rand(20)}`;
    registerSecret(secret);
    expect(redactString(`error: provider rejected ${secret}.`)).toBe(`error: provider rejected ${REDACTED}.`);
    expect(JSON.stringify(redact({ nested: [{ message: `x${secret}y` }] }))).not.toContain(secret);
  });

  it('masks known token shapes (Google, Apify, sk- keys) and env assignments', () => {
    const values = [`ya29.${rand(40)}`, `AIza${rand(35)}`, `GOCSPX-${rand(24)}`, `apify_api_${rand(30)}`, `sk-${rand(30)}`];
    const out = redactString(values.join(' | '));
    for (const v of values) expect(out).not.toContain(v);
    const env = redactString(`APIFY_TOKEN=${rand(20)}\nDATAFORSEO_PASSWORD=${rand(12)}\nQDRANT_URL=http://127.0.0.1:6333`);
    expect(env).toContain(`APIFY_TOKEN=${REDACTED}`);
    expect(env).toContain(`DATAFORSEO_PASSWORD=${REDACTED}`);
    expect(env).toContain('QDRANT_URL=http://127.0.0.1:6333');
  });

  it('masks secret-named keys in structured objects but keeps ordinary fields', () => {
    const out = redact({ apiKey: rand(20), password: rand(10), refresh_token: rand(30), client_secret: rand(20), status: 'ok', count: 3, empty_token: '' });
    expect(out).toMatchObject({ apiKey: REDACTED, password: REDACTED, refresh_token: REDACTED, client_secret: REDACTED, status: 'ok', count: 3, empty_token: '' });
  });

  it('logger output never contains registered secrets', () => {
    const secret = `k${rand(24)}`;
    registerSecret(secret);
    const log = memoryLogger();
    log.error(`request failed with key ${secret}`, { authorization: `Bearer ${secret}`, detail: { url: `https://x.example.invalid/?api_key=${secret}` } });
    expect(JSON.stringify(log.entries)).not.toContain(secret);
  });

  it('masks Google refresh tokens, OAuth authorization codes, and client secrets', () => {
    const refresh = `1//0${rand(40)}`;
    const code = `4/0${rand(40)}`;
    const out = redactString(`refresh=${refresh} redirect http://127.0.0.1:53682/?state=abc&code=${code}&scope=x`);
    expect(out).not.toContain(refresh);
    expect(out).not.toContain(code);
    expect(out).toContain('state=abc');
  });

  it('masks unterminated (truncated) PEM private keys', () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const truncated = pem.slice(0, pem.length - 40);
    const body = pem.split('\n')[1]!;
    const out = redactString(`log line: ${truncated}`);
    expect(out).not.toContain(body);
    expect(out).toContain(REDACTED);
    const escaped = JSON.stringify({ private_key: truncated }).slice(0, 200);
    expect(redactString(escaped)).not.toContain(body.slice(0, 20));
  });

  it('masks key=value query parameters including signatures and secrets, keeping ordinary parameters', () => {
    const vals = { access_token: rand(24), refresh_token: rand(24), client_secret: rand(24), signature: rand(24), apikey: rand(24) };
    const url = `https://api.example.invalid/v1?page=3&${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join('&')}#frag`;
    const out = redactString(url);
    for (const v of Object.values(vals)) expect(out).not.toContain(v);
    expect(out).toContain('page=3');
    expect(out).toContain('#frag');
  });

  it('keeps a closing parenthesis after a masked query parameter value', () => {
    const k = rand(16);
    const s = rand(16);
    expect(redactString(`map (x?key=${k}&sig=${s})`)).toBe(`map (x?key=${REDACTED}&sig=${REDACTED})`);
    // A Markdown link target stays a well-formed link.
    const link = redactString(`[download](https://www.example.test/dl?page=2&token=${k}) next`);
    expect(link).toBe(`[download](https://www.example.test/dl?page=2&token=${REDACTED}) next`);
    expect(link).not.toContain(k);
    // Values that merely contain other punctuation are still masked whole.
    expect(redactString(`?access_token=${k}.${s}`)).toBe(`?access_token=${REDACTED}`);
    // A parenthesis opened earlier on the line (prose, log messages) is closed again after the mask.
    expect(redactString(`request failed (GET https://api.example.invalid/v1?key=${k}).`)).toBe(`request failed (GET https://api.example.invalid/v1?key=${REDACTED}).`);
    expect(redactString(`[d](https://www.example.test/p_(x)?token=${k})`)).toBe(`[d](https://www.example.test/p_(x)?token=${REDACTED})`);
  });

  it("masks query parameter values that contain ')' or \"'\" whole (C4-06)", () => {
    const a = rand(12);
    const b = rand(12);
    // ')' and "'" are legal unescaped query characters (encodeURIComponent keeps them): they never end a secret.
    for (const ch of [')', "'"]) {
      const out = redactString(`https://api.example.invalid/v1?token=${a}${ch}${b}&page=2`);
      expect(out).toBe(`https://api.example.invalid/v1?token=${REDACTED}&page=2`);
      expect(out).not.toContain(b);
      // Inside a Markdown link the value is still masked whole; only the link's own ')' comes back.
      const link = redactString(`[x](https://www.example.test/dl?sig=${a}${ch}${b}) next`);
      expect(link).toBe(`[x](https://www.example.test/dl?sig=${REDACTED}) next`);
      expect(link).not.toContain(b);
    }
    // A trailing ')' with no '(' before it on the line is part of the value.
    expect(redactString(`?client_secret=${a})`)).toBe(`?client_secret=${REDACTED}`);
    // A trailing "'" is put back only when a quote opened the URL.
    expect(redactString(`fetch('https://api.example.invalid/?apikey=${a}')`)).toBe(`fetch('https://api.example.invalid/?apikey=${REDACTED}')`);
    expect(redactString(`url='https://api.example.invalid/?password=${a}'`)).toBe(`url='https://api.example.invalid/?password=${REDACTED}'`);
    expect(redactString(`?password=${a}'`)).toBe(`?password=${REDACTED}`);
    // An empty parameter is left alone; '#' and '"' still end the value.
    expect(redactString('(x?token=)')).toBe('(x?token=)');
    expect(redactString(`"https://a.example.invalid/?sig=${a}"#`)).toBe(`"https://a.example.invalid/?sig=${REDACTED}"#`);
    expect(redactString(`https://a.example.invalid/?sig=${a}#frag`)).toBe(`https://a.example.invalid/?sig=${REDACTED}#frag`);
  });

  it('keeps the text around a masked query value: angle brackets, a closing attribute quote, and a following URL (D1-R07)', () => {
    const a = rand(16);
    // An angle-bracket URL keeps its closing '>' and the text after it.
    expect(redactString(`see <https://x.example.invalid/?token=${a}> for details`)).toBe(`see <https://x.example.invalid/?token=${REDACTED}> for details`);
    // A single-quoted HTML attribute keeps its closing quote, the tag end, and the link text.
    const html = redactString(`<a href='https://x.example.invalid/?key=${a}'>link text</a>`);
    expect(html).toBe(`<a href='https://x.example.invalid/?key=${REDACTED}'>link text</a>`);
    expect(html).not.toContain(a);
    // A comma-separated list keeps the next URL (with or without a quote before it).
    expect(redactString(`https://a.example.invalid/?password=${a},https://b.example.invalid/`)).toBe(`https://a.example.invalid/?password=${REDACTED},https://b.example.invalid/`);
    expect(redactString(`'https://a.example.invalid/?password=${a},https://b.example.invalid/'`)).toBe(`'https://a.example.invalid/?password=${REDACTED},https://b.example.invalid/'`);
    expect(redactString(`['https://a.example.invalid/?sig=${a}','https://b.example.invalid/']`)).toBe(`['https://a.example.invalid/?sig=${REDACTED}','https://b.example.invalid/']`);
    // A comma that does not start another URL is still part of the value (masked whole).
    expect(redactString(`?token=${a},${a}`)).toBe(`?token=${REDACTED}`);
    // Values containing ')' or "'" are still masked whole (C4-06 unchanged).
    expect(redactString(`<https://x.example.invalid/?token=${a}'${a}>`)).toBe(`<https://x.example.invalid/?token=${REDACTED}>`);
  });

  it('masks env lines (export-prefixed, indented, mid-line) without swallowing the next line', () => {
    const k = rand(24);
    const p = rand(16);
    const text = [`export LLM_GATEWAY_API_KEY=${k}`, '  DATAFORSEO_PASSWORD = "' + p + ' with spaces"', 'PAGESPEED_API_KEY=', 'QDRANT_URL=http://127.0.0.1:6333', `boot failed: APIFY_TOKEN=${k} while starting`].join('\n');
    const out = redactString(text);
    expect(out).not.toContain(k);
    expect(out).not.toContain(p);
    expect(out).toContain(`export LLM_GATEWAY_API_KEY=${REDACTED}`);
    expect(out).toContain('PAGESPEED_API_KEY=\n');
    expect(out).toContain('QDRANT_URL=http://127.0.0.1:6333');
    expect(out).toContain(`APIFY_TOKEN=${REDACTED} while starting`);
  });

  it('masks secret-named string fields inside JSON text (e.g. logged raw bodies)', () => {
    const t = rand(30);
    const body = JSON.stringify({ refresh_token: t, access_token: t, client_secret: t, nested: { password: t }, max_tokens: 1500, nextPageToken: 'page-2' });
    const out = redactString(body);
    expect(out).not.toContain(t);
    expect(out).toContain('"max_tokens":1500');
    expect(out).toContain('"nextPageToken":"page-2"');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('masks URL-encoded forms of registered secrets', () => {
    const secret = `p@ss w0rd/${rand(12)}`;
    registerSecret(secret);
    const out = redactString(`POST body: password=${encodeURIComponent(secret)}&user=x and raw ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(encodeURIComponent(secret));
  });

  it('ignores trivially short registered values and can be cleared', () => {
    registerSecret('abc');
    expect(redactString('abc')).toBe('abc');
    const secret = `z${rand(20)}`;
    registerSecret(secret);
    expect(redactString(secret)).toBe(REDACTED);
    clearRegisteredSecrets();
    expect(redactString(secret)).toBe(secret);
  });

  it('masks nested objects with secret-named keys (snake, kebab, camel) at any depth', () => {
    const v = rand(20);
    const out = redact({
      config: { google: { client_secret: v, 'x-api-key': v, accessToken: v, private_key: v, clientSecret: v } },
      list: [{ credentials: { a: 1 } }, { session: v }],
      headers: { Authorization: `Bearer ${v}`, cookie: v },
      tokens_used: 10,
      empty: { password: null, token: undefined },
    });
    expect(JSON.stringify(out)).not.toContain(v);
    expect(out.config.google).toEqual({ client_secret: REDACTED, 'x-api-key': REDACTED, accessToken: REDACTED, private_key: REDACTED, clientSecret: REDACTED });
    // Structure under a secret key is kept; every non-metadata leaf is masked.
    expect(out.list[0]).toEqual({ credentials: { a: REDACTED } });
    expect(out.tokens_used).toBe(10);
    expect(out.empty).toEqual({ password: null, token: undefined });
    expect(isSecretKey('refreshToken')).toBe(true);
    expect(isSecretKey('status')).toBe(false);
  });

  it('marks only true cycles as [Circular]; shared references are redacted at each position', () => {
    const shared = { note: 'ok', password: 'hunter2hunter2' };
    const out = redact({ a: shared, b: shared, list: [shared, shared] });
    expect(out.a).toEqual({ note: 'ok', password: REDACTED });
    expect(out.b).toEqual({ note: 'ok', password: REDACTED });
    expect(out.list).toEqual([out.a, out.a]);
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('keeps Dates, redacts URLs/Errors/Maps, and summarizes binary data', () => {
    const t = rand(24);
    const when = new Date('2026-09-24T00:00:00Z');
    const out = redact({
      when,
      url: new URL(`https://user:${t}@example.invalid/path?token=${t}`),
      err: new Error(`failed with Bearer ${t}`),
      map: new Map<string, unknown>([['api_key', t], ['count', 2]]),
      set: new Set([`Bearer ${t}`]),
      bytes: Buffer.from('secret bytes'),
    });
    expect(out.when).toBe(when);
    expect(JSON.stringify(out)).toContain('"when":"2026-09-24T00:00:00.000Z"');
    expect(String(out.url)).not.toContain(t);
    expect(out.err).toEqual({ name: 'Error', message: `failed with Bearer ${REDACTED}` });
    expect(out.map).toEqual({ api_key: REDACTED, count: 2 });
    expect(out.set).toEqual([`Bearer ${REDACTED}`]);
    expect(out.bytes).toBe('[binary 12 bytes]');
    expect(JSON.stringify(out)).not.toContain(t);
  });

  it('keeps booleans, statuses, and metadata fields readable while still masking secret values', () => {
    const v = rand(20);
    const out = redact({
      auth_mode: 'oauth',
      session_count: 12,
      credentials: false,
      dataforseo: { credentials: 'missing' },
      GOOGLE_AUTH_MODE: { source: 'default', secret: false, set: true },
      GOOGLE_TOKEN_FILE: '/private/workspace/secrets/google/token.json',
      LLM_GATEWAY_API_KEY: { source: 'secrets-file', secret: true, set: true },
      token_expires_at: '2026-10-01T00:00:00Z',
      password: 12_345_678,
      token: [v, `x${v}`],
      api_key: { primary: v, status: 'active', enabled: true },
      secret: { name: 'APIFY_TOKEN', value: v },
      oauth: { refresh_token: v, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/webmasters.readonly' },
    });
    expect(out).toMatchObject({
      auth_mode: 'oauth',
      session_count: 12,
      credentials: false,
      dataforseo: { credentials: 'missing' },
      GOOGLE_AUTH_MODE: { source: 'default', secret: false, set: true },
      GOOGLE_TOKEN_FILE: '/private/workspace/secrets/google/token.json',
      LLM_GATEWAY_API_KEY: { source: 'secrets-file', secret: true, set: true },
      token_expires_at: '2026-10-01T00:00:00Z',
      password: REDACTED,
      token: [REDACTED, REDACTED],
      api_key: { primary: REDACTED, status: 'active', enabled: true },
      secret: { name: 'APIFY_TOKEN', value: REDACTED },
      oauth: { refresh_token: REDACTED, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/webmasters.readonly' },
    });
    expect(JSON.stringify(out)).not.toContain(v);
    expect(isSecretKey('auth_mode')).toBe(false);
    expect(isSecretKey('session_count')).toBe(false);
    expect(isSecretKey('GOOGLE_APPLICATION_CREDENTIALS')).toBe(true);
    expect(isSecretKey('x-api-key')).toBe(true);
    expect(isSecretKey('session_id')).toBe(true);
  });

  it('masks YAML/colon assignments, any Authorization scheme, and token-only URL userinfo', () => {
    const pw = rand(14);
    const key = `sk_live_${rand(24)}`;
    const tok = `ghp_${rand(30)}`;
    const text = [
      `password: ${pw}`,
      `  dataforseo_password: "${pw} with spaces"`,
      `api_key: ${key}`,
      `Authorization: Token ${tok}`,
      `authorization: ${tok}`,
      `cloning https://${tok}@github.com/owner/repo.git`,
      'max_tokens: 1500',
      'token: missing',
      'password: null',
      'ssh://git@github.com/owner/repo.git',
      '{"nextPageToken":"page-2","max_tokens":10}',
    ].join('\n');
    const out = redactString(text);
    for (const secret of [pw, key, tok]) expect(out).not.toContain(secret);
    expect(out).toContain(`password: ${REDACTED}`);
    expect(out).toContain(`  dataforseo_password: ${REDACTED}`);
    expect(out).toContain(`Authorization: Token ${REDACTED}`);
    expect(out).toContain(`authorization: ${REDACTED}`);
    expect(out).toContain(`https://${REDACTED}@github.com/owner/repo.git`);
    expect(out).toContain('max_tokens: 1500');
    expect(out).toContain('token: missing');
    expect(out).toContain('password: null');
    expect(out).toContain('ssh://git@github.com/owner/repo.git');
    expect(out).toContain('{"nextPageToken":"page-2","max_tokens":10}');
    // Idempotent: redacting twice changes nothing more.
    expect(redactString(out)).toBe(out);
  });

  it('keeps status prose and setup guidance readable (no garbled words or placeholders)', () => {
    // Regression: "authorization:" in prose is not a header, and ordinary words are not credentials.
    const prose = 'Blocked by Google authorization: OAuth client file not found (/ws/secrets/google/client.json).';
    expect(redactString(prose)).toBe(prose);
    const status = 'google_gsc: missing_credentials - Blocked until Google access works: OAuth client file not found.';
    expect(redactString(status)).toBe(status);
    const label = 'Google authorization: invalid_grant: Token has been expired or revoked.';
    expect(redactString(label)).toBe(label);
    // Regression: angle-bracket placeholders in guidance are not secret values.
    const guidance = 'Add APIFY_TOKEN=<token> to <workspace>/secrets/secrets.env (mode 0600), then run `apify status`.';
    expect(redactString(guidance)).toBe(guidance);
    for (const line of ['APIFY_TOKEN=<token>', 'export LLM_GATEWAY_API_KEY=<your-key>', 'DATAFORSEO_PASSWORD="<password>"', 'api_key: <your-api-key>', 'Send `Authorization: Bearer <access_token>`']) {
      expect(redactString(line), line).toBe(line);
    }
    expect(redactString('Authorization: required')).toBe('Authorization: required');
  });

  it('still masks real Authorization header values and env assignments next to the prose fixes', () => {
    const tok = `ghp_${rand(30)}`;
    const opaque = rand(24);
    const lower = 'hunter2hunter2hunter2';
    const cases = [
      `Authorization: Bearer ${opaque}`,
      `  authorization: ${tok}`,
      `curl -H "Authorization: Token ${opaque}" https://api.example.invalid/`,
      `{"headers":{"x":1},authorization: ${opaque}}`,
      `request headers were Authorization: Custom ${opaque}`,
      `> Proxy-Authorization: Digest ${opaque}`,
      `https://api.example.invalid/v1?authorization=${opaque}`,
      `APIFY_TOKEN=${opaque}`,
      `boot failed: APIFY_TOKEN=${opaque} while starting`,
      `PASSWORD=${lower}`,
    ];
    for (const c of cases) {
      const out = redactString(c);
      expect(out, c).toContain(REDACTED);
      expect(out, c).not.toContain(opaque);
      expect(out, c).not.toContain(tok);
      expect(out, c).not.toContain(lower);
    }
  });

  it('does not mutate the input object', () => {
    const input = { password: 'hunter2hunter2', nested: { token: 'abcdefghijkl' } };
    const copy = structuredClone(input);
    redact(input);
    expect(input).toEqual(copy);
  });
});

describe('redact() keeps an own "__proto__" key as data (B4A2-05)', () => {
  it('preserves the key, never re-parents the copy, and still redacts inside it', () => {
    const secret = rand(24);
    // JSON.parse creates an OWN "__proto__" property (untrusted provider/raw payload shape).
    const input = JSON.parse(`{"__proto__": {"polluted": true, "api_key": "${secret}"}, "ok": 1}`) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(input, '__proto__')).toBe(true);
    const out = redact(input);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect((out as Record<string, unknown>).polluted).toBeUndefined();
    const json = JSON.parse(JSON.stringify(out));
    expect(Object.prototype.hasOwnProperty.call(json, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toContain('"__proto__":{"polluted":true');
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).toContain(REDACTED);
    expect(json.ok).toBe(1);
    // Nested objects and Map keys are handled the same way; nothing global is touched.
    const nested = redact(JSON.parse('{"a": {"__proto__": {"x": 1}}}') as Record<string, Record<string, unknown>>);
    expect(Object.getPrototypeOf(nested.a)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(nested.a, '__proto__')).toBe(true);
    const fromMap = redact(new Map<string, unknown>([['__proto__', { y: 2 }]])) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(fromMap)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(fromMap, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('redactHeaders keeps a "__proto__" header name as data', () => {
    const h = redactHeaders(JSON.parse('{"__proto__": "x", "content-type": "text/html"}') as Record<string, string>);
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(h, '__proto__')).toBe(true);
    expect(h['content-type']).toBe('text/html');
  });
});
