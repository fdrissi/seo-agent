import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, isoNow, systemClock } from '../../../src/core/clock.js';
import { AppError, BudgetExceededError, ConfigError, CredentialsMissingError, IntegrationDisabledError, errorMessage, isAppError } from '../../../src/core/errors.js';
import { createLogger, memoryLogger, parseLogLevel, silentLogger } from '../../../src/core/logger.js';
import { CLAIM_LABELS, DEFAULT_MODE, modeAtLeast, parseMode } from '../../../src/core/modes.js';
import { REDACTED, registerSecret } from '../../../src/security/redact.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('logger redaction', () => {
  it('memoryLogger redacts messages, fields, and child bindings', () => {
    const secret = 'synthetic-secret-value-123456';
    registerSecret(secret);
    const log = memoryLogger();
    const child = log.child({ apiKey: 'sk-abcdefghijklmnopqrstuv', site: 'test-site' });
    child.warn(`request with ${secret}`, { url: `https://x.example.invalid/?token=${secret}`, nested: { password: 'hunter2hunter2' } });
    const entry = log.entries[0]!;
    expect(entry.level).toBe('warn');
    expect(entry.msg).toBe(`request with ${REDACTED}`);
    expect(entry.fields).toMatchObject({ apiKey: REDACTED, site: 'test-site', nested: { password: REDACTED } });
    expect(JSON.stringify(log.entries)).not.toContain(secret);
    expect(JSON.stringify(log.entries)).not.toContain('hunter2hunter2');
  });

  it('createLogger writes redacted JSON lines (0600) and stderr lines, honoring the level', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-log-'));
    dirs.push(dir);
    const file = path.join(dir, 'logs', 'app.log');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = createLogger({ level: 'info', file, base: { site: 's1' } });
    log.debug('hidden');
    log.info('Authorization: Bearer abcdefghijklmnopqrstuvwxyz', { at: new Date('2026-09-24T00:00:00Z'), token: 'x-secret-token' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({ level: 'info', msg: `Authorization: Bearer ${REDACTED}`, site: 's1', token: REDACTED, at: '2026-09-24T00:00:00.000Z' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('[info] Authorization: Bearer [REDACTED]');
    expect(written).not.toContain('hidden');
    expect(written).not.toContain('x-secret-token');
  });

  it('console lines are terminal-safe (ESC/OSC/CSI shown as markers) while the JSON log file keeps the exact text (B4A2-02)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-log-'));
    dirs.push(dir);
    const file = path.join(dir, 'logs', 'app.log');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const title = 'Rival guide\u001b]0;owned\u0007\u001b[8m concealed\u009b2J\rX‮';
    createLogger({ level: 'info', file }).warn(`Fetched competitor page: ${title}`, { title });
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‮]/);
    expect(written).toContain('[warn] Fetched competitor page: Rival guide[U+001B]]0;owned[U+0007][U+001B][8m concealed[U+009B]2J[U+000D]X[U+202E]');
    expect(written.endsWith('\n')).toBe(true);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim()) as { msg: string; title: string };
    expect(rec.msg).toBe(`Fetched competitor page: ${title}`);
    expect(rec.title).toBe(title);
  });

  it('console output can be disabled', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createLogger({ console: false }).error('quiet');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('parseLogLevel falls back to info for unknown values (never "log everything")', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel(' warn ')).toBe('warn');
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel('toString')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('silentLogger swallows everything', () => {
    expect(() => silentLogger.child({ a: 1 }).error('x')).not.toThrow();
  });
});

describe('errors', () => {
  it('AppError carries a stable code, hint, details, and cause', () => {
    const cause = new Error('root');
    const e = new AppError('NOT_FOUND', 'missing thing', { details: { id: 1 }, hint: 'create it', cause });
    expect(isAppError(e)).toBe(true);
    expect(e.cause).toBe(cause);
    expect(e.toJSON()).toEqual({ code: 'NOT_FOUND', message: 'missing thing', hint: 'create it', details: { id: 1 } });
    expect(isAppError(new Error('x'))).toBe(false);
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(new Error('msg'))).toBe('msg');
  });

  it('specialized errors map to actionable codes', () => {
    expect(new ConfigError('bad').code).toBe('CONFIG_INVALID');
    const creds = new CredentialsMissingError('apify', ['APIFY_TOKEN']);
    expect(creds.code).toBe('CREDENTIALS_MISSING');
    expect(creds.hint).toMatch(/never in chat/);
    expect(new IntegrationDisabledError('qdrant', 'profile core').code).toBe('INTEGRATION_DISABLED');
    const budget = new BudgetExceededError('over', { scope: 'run' });
    expect(budget.code).toBe('BUDGET_EXCEEDED');
    expect(budget.hint).toMatch(/No automatic budget increases/);
  });
});

describe('modes and clock', () => {
  it('parses modes case-insensitively, defaults to ANALYZE, and orders them', () => {
    expect(parseMode(undefined)).toBe(DEFAULT_MODE);
    expect(DEFAULT_MODE).toBe('ANALYZE');
    expect(parseMode('research')).toBe('RESEARCH');
    expect(() => parseMode('ROOT')).toThrow(RangeError);
    expect(modeAtLeast('EXECUTE', 'DRAFT')).toBe(true);
    expect(modeAtLeast('ANALYZE', 'RESEARCH')).toBe(false);
    expect(CLAIM_LABELS).toContain('DATA_UNAVAILABLE');
  });

  it('fixedClock is deterministic and adjustable', () => {
    const c = fixedClock('2026-09-24T09:00:00.000Z');
    expect(isoNow(c)).toBe('2026-09-24T09:00:00.000Z');
    c.advanceMs(1_500);
    expect(isoNow(c)).toBe('2026-09-24T09:00:01.500Z');
    c.set('2027-01-01T00:00:00Z');
    expect(c.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
    // now() returns a copy: callers cannot mutate the clock.
    c.now().setUTCFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2027);
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});
