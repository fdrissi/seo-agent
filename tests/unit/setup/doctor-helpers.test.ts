import { describe, expect, it } from 'vitest';
import type { IntegrationState } from '../../../src/integrations/types.js';
import { doctorFetch, levelForState, nodeCheck, requiredNodeMajor } from '../../../src/setup/doctor.js';
import { PROFILE_INFO } from '../../../src/setup/profiles.js';
import { secretNeeds } from '../../../src/setup/secrets.js';

describe('doctor: Node.js check', () => {
  it('reads the minimum from package.json engines instead of hardcoding it', () => {
    expect(requiredNodeMajor()).toBeGreaterThanOrEqual(20);
  });

  it('distinguishes LTS, Current, odd, and too-old releases', () => {
    expect(nodeCheck({ version: 'v24.9.0', lts: 'Krypton' }, 24)).toMatchObject({ level: 'ok', detail: expect.stringContaining('LTS release ("Krypton")') });
    expect(nodeCheck({ version: 'v26.3.0', lts: null }, 24)).toMatchObject({ level: 'warn', detail: expect.stringContaining('"Current" release') });
    expect(nodeCheck({ version: 'v25.1.0', lts: null }, 24)).toMatchObject({ level: 'warn', detail: expect.stringContaining('never becomes LTS') });
    expect(nodeCheck({ version: 'v22.20.0', lts: 'Jod' }, 24)).toMatchObject({ level: 'fail', nextStep: expect.stringContaining('24') });
  });
});

describe('doctor: status levels and network guard', () => {
  it('maps every integration state to a level (misconfiguration fails; missing credentials warn)', () => {
    const states: IntegrationState[] = ['ready', 'configured_unverified', 'disabled', 'missing_credentials', 'misconfigured', 'degraded', 'unreachable', 'permission_denied', 'unresolved', 'fixture'];
    const levels = Object.fromEntries(states.map((s) => [s, levelForState(s)]));
    expect(levels).toMatchObject({ ready: 'ok', missing_credentials: 'warn', misconfigured: 'fail', permission_denied: 'fail', disabled: 'info', fixture: 'info' });
  });

  it('refuses and records requests when network is not allowed; never records query strings', async () => {
    const log = { requests: [] as Array<{ method: string; host: string; path: string }>, blocked: [] as Array<{ method: string; host: string; path: string }> };
    let baseCalls = 0;
    const base = async () => {
      baseCalls++;
      return new Response('ok');
    };
    const denied = doctorFetch(false, base, log);
    await expect(denied('https://api.example.test/v1/x?key=SYNTHETIC-KEY', { method: 'POST' })).rejects.toThrow(/network access is disabled/);
    expect(baseCalls).toBe(0);
    expect(log.blocked).toEqual([{ method: 'POST', host: 'api.example.test', path: '/v1/x' }]);
    const allowed = doctorFetch(true, base, log);
    await allowed('https://api.example.test/v1/y?key=SYNTHETIC-KEY');
    expect(baseCalls).toBe(1);
    expect(JSON.stringify(log)).not.toContain('SYNTHETIC-KEY');
  });
});

describe('setup profiles and credential needs', () => {
  it('profile explanations are derived from the real feature defaults', () => {
    expect(PROFILE_INFO.core.enables.some((e) => e.startsWith('gsc:'))).toBe(true);
    expect(PROFILE_INFO.core.enables.some((e) => e.startsWith('apify:'))).toBe(false);
    expect(PROFILE_INFO.full.enables.some((e) => e.startsWith('qdrant:'))).toBe(true);
    expect(PROFILE_INFO.demo.credentials).toEqual(['None.']);
  });

  it('asks only for credentials the enabled features need', () => {
    expect(secretNeeds({ profile: 'demo' })).toEqual([]);
    expect(secretNeeds({ profile: 'core' }).map((n) => [n.key, n.optional])).toEqual([['LLM_GATEWAY_API_KEY', true]]);
    const full = secretNeeds({ profile: 'full', research: { dataforseo: { mode: 'sandbox' } } }).map((n) => n.key);
    expect(full).toEqual(['LLM_GATEWAY_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'APIFY_TOKEN', 'PAGESPEED_API_KEY', 'QDRANT_API_KEY']);
    expect(secretNeeds({ profile: 'full' }).map((n) => n.key)).not.toContain('DATAFORSEO_LOGIN');
    expect(secretNeeds({ profile: 'core', features: { llm: false } })).toEqual([]);
  });
});
