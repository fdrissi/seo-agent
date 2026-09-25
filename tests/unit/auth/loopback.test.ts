import { afterEach, describe, expect, it } from 'vitest';
import { constantTimeEqual, startLoopbackServer, type LoopbackServer } from '../../../src/auth/loopback.js';
import { httpGet } from './_http.js';

const STATE = 'synthetic-state-0123456789abcdefghijklmnop';

let server: LoopbackServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('OAuth loopback listener', () => {
  it('binds only to 127.0.0.1 on an ephemeral port with a path-less redirect URI', async () => {
    server = await startLoopbackServer({ expectedState: STATE, timeoutMs: 5_000 });
    expect(server.address().address).toBe('127.0.0.1');
    expect(server.address().family).toBe('IPv4');
    expect(server.port).toBeGreaterThan(0);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}`);
  });

  it('accepts exactly one valid callback, then closes', async () => {
    server = await startLoopbackServer({ expectedState: STATE, timeoutMs: 5_000 });
    const wait = server.waitForCallback();
    const res = await httpGet(`${server.redirectUri}/?code=synthetic-code&state=${STATE}&scope=a%20b`);
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/close this tab/);
    expect(res.body).not.toContain('synthetic-code');
    await expect(wait).resolves.toEqual({ code: 'synthetic-code', scope: 'a b' });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.closed).toBe(true);
    await expect(httpGet(`${server.redirectUri}/?code=again&state=${STATE}`)).rejects.toThrow();
  });

  it('rejects a state mismatch (CSRF) and closes the listener', async () => {
    server = await startLoopbackServer({ expectedState: STATE, timeoutMs: 5_000 });
    const wait = server.waitForCallback();
    const res = await httpGet(`${server.redirectUri}/?code=attacker-code&state=wrong-state-value`);
    expect(res.status).toBe(400);
    await expect(wait).rejects.toThrow(/state mismatch/);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.closed).toBe(true);
  });

  it('rejects a callback without state', async () => {
    server = await startLoopbackServer({ expectedState: STATE, timeoutMs: 5_000 });
    const wait = server.waitForCallback();
    await httpGet(`${server.redirectUri}/?code=x`);
    await expect(wait).rejects.toThrow(/state mismatch/);
  });

  it('reports a denied consent', async () => {
    server = await startLoopbackServer({ expectedState: STATE, timeoutMs: 5_000 });
    const wait = server.waitForCallback();
    await httpGet(`${server.redirectUri}/?error=access_denied&state=${STATE}`);
    await expect(wait).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('ignores other paths and unexpected Host headers without settling', async () => {
    server = await startLoopbackServer({ expectedState: STATE, timeoutMs: 5_000 });
    const wait = server.waitForCallback();
    expect((await httpGet(`${server.redirectUri}/favicon.ico`)).status).toBe(404);
    expect((await httpGet(`${server.redirectUri}/?code=c&state=${STATE}`, { host: 'evil.example.com' })).status).toBe(400);
    expect(server.closed).toBe(false);
    await httpGet(`${server.redirectUri}/?code=ok&state=${STATE}`);
    await expect(wait).resolves.toMatchObject({ code: 'ok' });
  });

  it('times out and closes', async () => {
    server = await startLoopbackServer({ expectedState: STATE, timeoutMs: 60 });
    await expect(server.waitForCallback()).rejects.toMatchObject({ code: 'TIMEOUT' });
    await new Promise((r) => setTimeout(r, 30));
    expect(server.closed).toBe(true);
  });

  it('requires a high-entropy state and compares in constant time', async () => {
    await expect(startLoopbackServer({ expectedState: 'short', timeoutMs: 100 })).rejects.toThrow();
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
