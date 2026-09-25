import { describe, expect, it } from 'vitest';
import { checkGatewayBaseUrl, classifyHttpFailure, classifyTransportError, fetchWithTimeout, gatewayUrl, normalizeBaseUrl, parseErrorEnvelope, reconcileNextStep, TransportError } from '../../../src/integrations/llm/http.js';
import { extractJson, validateOutput, decodeEmbeddings } from '../../../src/integrations/llm/gateway.js';
import { z } from 'zod';

describe('gateway error mapping (verified error envelope and statuses)', () => {
  const env = (message: string, code: string | null = null) => ({ message, type: 'x', code });
  it.each([
    [400, env('Model does not support JSON schema output mode'), 'unsupported', 'not_billed'],
    [400, env('bad', 'model_not_found'), 'invalid_model', 'not_billed'],
    [400, env('bad request'), 'provider_error', 'not_billed'],
    [401, env('Unauthorized: LLMGateway API key reached its usage limit.', 'invalid_api_key'), 'budget_exceeded', 'not_billed'],
    [401, env('Invalid key', 'invalid_api_key'), 'not_configured', 'not_billed'],
    [402, env('credits'), 'budget_exceeded', 'not_billed'],
    [403, env('denied'), 'provider_error', 'not_billed'],
    [404, env('Model x not found', 'model_not_found'), 'invalid_model', 'not_billed'],
    [413, env('too large'), 'unsupported', 'not_billed'],
    [429, env('slow down'), 'provider_error', 'not_billed'],
    [529, env('overloaded'), 'provider_error', 'not_billed'],
    [408, env('timeout'), 'provider_error', 'ambiguous'],
    [504, env('timeout'), 'provider_error', 'ambiguous'],
    [500, env('upstream'), 'provider_error', 'ambiguous'],
    [502, env('all providers failed'), 'provider_error', 'ambiguous'],
  ] as const)('HTTP %i -> %s (%s)', (status, e, expected, billing) => {
    const c = classifyHttpFailure(status, e);
    expect(c.status).toBe(expected);
    expect(c.billing).toBe(billing);
    expect(c.nextStep.length).toBeGreaterThan(10);
    // A possibly billed failure points to the audited reconcile command (costs reconcile), never a blind retry.
    if (billing === 'ambiguous') {
      expect(c.nextStep).toContain('npm run cli -- costs reconcile <reservation-id> --actual-usd');
      expect(c.nextStep).toContain('--not-charged');
    } else expect(c.nextStep).not.toContain('costs reconcile');
  });

  it('reconcileNextStep names the reservation when it is known', () => {
    expect(reconcileNextStep('res_123')).toContain('settle reservation res_123: `npm run cli -- costs reconcile res_123 --actual-usd <amount from the usage log> --evidence "<what the usage log shows>" --by "<your name>"`');
    expect(reconcileNextStep()).toContain('`npm run cli -- costs --unresolved` shows its id');
    expect(reconcileNextStep(null)).toContain('costs reconcile <reservation-id>');
  });

  it('reads Retry-After and parses envelopes defensively (redacted)', () => {
    const c = classifyHttpFailure(429, env('x'), new Headers({ 'retry-after': '12' }));
    expect(c.retryAfterMs).toBe(12_000);
    expect(parseErrorEnvelope('{"error":{"message":"m","type":"t","param":null,"code":"c"}}')).toEqual({ message: 'm', type: 't', code: 'c' });
    expect(parseErrorEnvelope('<html>bad gateway</html>').message).toContain('bad gateway');
    expect(parseErrorEnvelope('{"error":{"message":"key Bearer abcdefghijklmnopqrstuv"}}').message).not.toContain('abcdefghijklmnopqrstuv');
  });
});

describe('transport errors', () => {
  it('classifies timeouts and aborts as ambiguous kinds and connection refusals as not sent', () => {
    expect(classifyTransportError(Object.assign(new Error('x'), { name: 'TimeoutError' }), false, false).kind).toBe('timeout');
    expect(classifyTransportError(new Error('x'), true, false).kind).toBe('timeout');
    expect(classifyTransportError(Object.assign(new Error('x'), { name: 'AbortError' }), false, true).kind).toBe('aborted');
    expect(classifyTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), false, false).kind).toBe('not_sent');
    expect(classifyTransportError(Object.assign(new Error('offline'), { code: 'OFFLINE' }), false, false).kind).toBe('not_sent');
    expect(classifyTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), false, false).kind).toBe('unknown');
  });

  it('fetchWithTimeout aborts a hanging request and never sends a pre-aborted one', async () => {
    const hanging = (_: string | URL, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    await expect(fetchWithTimeout(hanging, 'https://api.example.invalid/x', {}, 20)).rejects.toMatchObject({ kind: 'timeout' });
    const ac = new AbortController();
    ac.abort();
    let called = false;
    await expect(
      fetchWithTimeout(async () => {
        called = true;
        return new Response('');
      }, 'https://api.example.invalid/x', {}, 1000, ac.signal),
    ).rejects.toBeInstanceOf(TransportError);
    expect(called).toBe(false);
  });
});

describe('output parsing', () => {
  it('extracts JSON from fenced or surrounded text and reports errors', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('Here: [1,2] done')).toEqual({ ok: true, value: [1, 2] });
    expect(extractJson('')).toMatchObject({ ok: false });
    expect(extractJson('{"a":')).toMatchObject({ ok: false });
  });

  it('validateOutput returns path-qualified zod errors', () => {
    const r = validateOutput('{"a":"x"}', z.object({ a: z.number(), b: z.string() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/^a: .*\n?b: /m);
  });

  it('decodeEmbeddings validates counts and index sequences', () => {
    expect(() => decodeEmbeddings({ data: [{ index: 0, embedding: [1] }] }, 2)).toThrow(/expected 2/);
    expect(() => decodeEmbeddings({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }, 2)).toThrow(/indices/);
    expect(() => decodeEmbeddings({ data: [{ index: 0, embedding: ['x'] }] }, 1)).toThrow(/non-numeric/);
    expect(() => decodeEmbeddings({}, 1)).toThrow(/data/);
  });
});

describe('LLM_GATEWAY_BASE_URL transport security (the Bearer key never travels in cleartext)', () => {
  it('accepts https, and plain http only to loopback hosts', () => {
    expect(normalizeBaseUrl(' https://api.llmgateway.io/v1/ ')).toBe('https://api.llmgateway.io/v1');
    expect(gatewayUrl('https://api.llmgateway.io/v1', '/chat/completions')).toBe('https://api.llmgateway.io/v1/chat/completions');
    for (const ok of ['http://127.0.0.1:8787/v1', 'http://localhost:8787/v1', 'http://[::1]:8787/v1', 'http://127.1.2.3/v1', 'http://proxy.localhost:8787/v1']) {
      expect(checkGatewayBaseUrl(ok).ok, ok).toBe(true);
    }
  });

  it('refuses plain http to a network host, other schemes, embedded credentials, and invalid URLs', () => {
    for (const bad of ['http://gateway.example.test/v1', 'http://10.0.0.5:8080/v1', 'http://127.evil.example/v1', 'ftp://api.llmgateway.io/v1', 'https://user:pass@api.llmgateway.io/v1', 'not a url']) {
      const c = checkGatewayBaseUrl(bad);
      expect(c.ok, bad).toBe(false);
      expect(() => normalizeBaseUrl(bad), bad).toThrow();
    }
    try {
      normalizeBaseUrl('http://gateway.example.test/v1');
    } catch (err) {
      expect(err).toMatchObject({ code: 'CONFIG_INVALID' });
      expect((err as { hint?: string }).hint).toMatch(/https/);
    }
    expect(() => gatewayUrl('http://gateway.example.test/v1', 'models')).toThrow(/plain http/);
  });
});
