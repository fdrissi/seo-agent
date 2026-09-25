import { describe, expect, it } from 'vitest';
import { DataForSeoApiError, envelopeCost, mapStatusCode, parseEnvelope, taskError, taskOutcome } from '../../../src/integrations/dataforseo/envelope.js';
import { parseDfsDatetime, parseSerpResult } from '../../../src/integrations/dataforseo/store.js';
import { fixture } from '../../integration/dataforseo/helpers.js';

describe('DataForSEO envelope parsing', () => {
  it('parses the documented envelope and rejects non-envelopes', () => {
    const env = parseEnvelope(fixture('serp-task-post-created.json'));
    expect(env?.status_code).toBe(20000);
    expect(env?.tasks[0]?.status_code).toBe(20100);
    expect(parseEnvelope({ hello: 'world' })).toBeNull();
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope({ status_code: 20000, tasks: 'nope' })).toBeNull();
    expect(parseEnvelope({ status_code: 20000, tasks: [{ id: 'x' }] })).toBeNull();
  });

  it('parses the documented 401 body that has no version key', () => {
    const env = parseEnvelope(fixture('unauthorized-401.json'));
    expect(env?.status_code).toBe(40100);
    expect(env?.version).toBeUndefined();
  });

  it('classifies task-level outcomes (pending, no results, partial are not failures)', () => {
    expect(taskOutcome(20000)).toBe('ok');
    expect(taskOutcome(20100)).toBe('created');
    expect(taskOutcome(40601)).toBe('pending');
    expect(taskOutcome(40602)).toBe('pending');
    expect(taskOutcome(40102)).toBe('no_results');
    expect(taskOutcome(40106)).toBe('partial');
    expect(taskOutcome(40403)).toBe('expired');
    expect(taskOutcome(40501)).toBe('error');
  });

  it('detects errors inside HTTP 200 responses at the task level', () => {
    const env = parseEnvelope(fixture('task-error-in-200.json'))!;
    expect(env.status_code).toBe(20000);
    const err = taskError(env.tasks[0]!, 'serp/google/organic/task_post');
    expect(err).toBeInstanceOf(DataForSeoApiError);
    expect(err!.code).toBe('VALIDATION_FAILED');
    expect(err!.level).toBe('task');
    expect(taskError({ ...env.tasks[0]!, status_code: 40602 }, 'x')).toBeNull();
  });

  it('maps internal status codes to typed errors with retry guidance', () => {
    expect(mapStatusCode(40100)).toMatchObject({ kind: 'auth', code: 'PERMISSION_DENIED', retryableGet: false });
    expect(mapStatusCode(40210)).toMatchObject({ kind: 'funds', retryableGet: false });
    expect(mapStatusCode(40200)).toMatchObject({ kind: 'funds' });
    expect(mapStatusCode(40202)).toMatchObject({ kind: 'rate_limit', code: 'RATE_LIMITED', retryableGet: true });
    expect(mapStatusCode(40209)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(mapStatusCode(40204)).toMatchObject({ kind: 'access_denied' });
    expect(mapStatusCode(40501)).toMatchObject({ kind: 'invalid_request', retryableGet: false });
    expect(mapStatusCode(50301)).toMatchObject({ kind: 'server', retryableGet: true });
    expect(mapStatusCode(40103)).toMatchObject({ kind: 'task_failed_resubmit', retryableGet: false });
  });
});

describe('DataForSEO cost extraction (no double counting)', () => {
  it('sums TASK-level costs and never adds the response-level total', () => {
    const c = envelopeCost({ status_code: 20000, status_message: 'Ok.', cost: 0.0012, tasks: [
      { id: 'a', status_code: 20100, status_message: '', cost: 0.0006, result: null },
      { id: 'b', status_code: 20100, status_message: '', cost: 0.0006, result: null },
    ] });
    expect(c.actualMicros).toBe(1200);
    expect(c.responseLevelMicros).toBe(1200);
    expect(c.basis).toBe('task_level');
  });

  it('keeps cost unknown (null, never 0) when any task cost is missing', () => {
    const c = envelopeCost({ status_code: 20000, status_message: 'Ok.', cost: 0.0006, tasks: [
      { id: 'a', status_code: 20100, status_message: '', cost: 0.0006, result: null },
      { id: 'b', status_code: 20100, status_message: '', cost: null, result: null },
    ] });
    expect(c.actualMicros).toBeNull();
    expect(c.basis).toBe('unknown');
  });

  it('uses the response-level cost only when there are no tasks', () => {
    expect(envelopeCost({ status_code: 40210, status_message: '', cost: 0, tasks: [] })).toMatchObject({ actualMicros: 0, basis: 'response_level_no_tasks' });
    expect(envelopeCost({ status_code: 40210, status_message: '', cost: null, tasks: [] })).toMatchObject({ actualMicros: null, basis: 'unknown' });
  });
});

describe('SERP result parsing', () => {
  it('parses provider datetimes into ISO UTC', () => {
    expect(parseDfsDatetime('2019-11-15 12:57:46 +00:00')).toBe('2019-11-15T12:57:46.000Z');
    expect(parseDfsDatetime('2026-09-24 10:00:00 +02:00')).toBe('2026-09-24T08:00:00.000Z');
    expect(parseDfsDatetime('garbage')).toBeNull();
    expect(parseDfsDatetime(null)).toBeNull();
  });

  it('parses advanced items tolerantly (missing fields stay null, not 0)', () => {
    const env = fixture('serp-task-get-advanced.json');
    const serp = parseSerpResult(env.tasks[0].result[0]);
    expect(serp.items).toHaveLength(10);
    const paa = serp.items.find((i) => i.type === 'people_also_ask')!;
    expect(paa.url).toBeNull();
    expect(paa.domain).toBeNull();
    expect(serp.seResultsCount).toBe(123000);
    const empty = parseSerpResult(null);
    expect(empty.items).toEqual([]);
    expect(empty.seResultsCount).toBeNull();
  });
});
