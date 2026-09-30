/**
 * `doctor` with Telegram notifications and the action plans folder (SYNTHETIC).
 * Provider requests go to a fake fetch; no real network access. The token is
 * SYNTHETIC and has the documented "<bot id>:<secret>" shape.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { siteConfigFile } from '../../../src/config/paths.js';
import { LayeredSecretStore } from '../../../src/config/secrets.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import { clearRegisteredSecrets } from '../../../src/security/redact.js';
import { renderDoctorReport, runDoctor, type DoctorReport } from '../../../src/setup/doctor.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import { makeWorkspace, type TestWorkspace } from './helpers.js';

const TOKEN = '123456789:SYNTHETIC_fake_token_for_tests_only_000';
const SITE = 'doctor-telegram-test';

let ws: TestWorkspace;
beforeEach(() => {
  ws = makeWorkspace({ migrate: true });
});
afterEach(() => {
  ws.cleanup();
  clearRegisteredSecrets();
});

function writeSite(extra: Partial<SiteConfigInput> = {}): void {
  const cfg = {
    profile: 'core',
    site: { id: SITE, businessName: 'Doctor Telegram Test (synthetic)', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'] },
    features: { crawl: false, playwright: false, gsc: false, ga4: false, pagespeed: false, urlInspection: false, qdrant: false, dataforseo: false, apify: false, llm: false, embeddings: false },
    ...extra,
  } as SiteConfigInput;
  writeFileSync(siteConfigFile(ws.paths, SITE), stringify(cfg), { mode: 0o600 });
}

function check(r: DoctorReport, id: string) {
  return r.checks.find((c) => c.id === id);
}

describe('doctor: Telegram', () => {
  it('reports disabled by default, and missing credentials when enabled without a token', async () => {
    writeSite();
    const off = await runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, {}), network: false, node: { version: 'v24.9.0', lts: 'Krypton' } });
    expect(off.sites[0]!.integrations.find((i) => i.id === 'telegram')?.state).toBe('disabled');

    writeSite({ notifications: { telegram: { enabled: true, chatId: '123456789' } } });
    const missing = await runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, {}), network: false, node: { version: 'v24.9.0', lts: 'Krypton' } });
    const t = missing.sites[0]!.integrations.find((i) => i.id === 'telegram')!;
    expect(t.state).toBe('missing_credentials');
    expect(t.nextStep).toMatch(/secrets\.env/);
  });

  it('--network checks the token with getMe and never shows the token in the request log or the report', async () => {
    writeSite({ notifications: { telegram: { enabled: true, chatId: '123456789' } } });
    const tg = fakeFetch([match('GET', `https://api.telegram.org/bot${TOKEN}/getMe`, () => jsonResponse({ ok: true, result: { id: 123456789, is_bot: true, username: 'synthetic_seo_bot' } }))]);
    const r = await runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, { TELEGRAM_BOT_TOKEN: TOKEN }), network: true, fetch: tg, node: { version: 'v24.9.0', lts: 'Krypton' } });
    const t = r.sites[0]!.integrations.find((i) => i.id === 'telegram')!;
    expect(t).toMatchObject({ state: 'ready', networkChecked: true, chargeable: false });
    expect(t.detail).toContain('@synthetic_seo_bot');
    expect(tg.calls).toHaveLength(1);
    expect(r.network.requests).toContainEqual({ method: 'GET', host: 'api.telegram.org', path: '/bot[REDACTED]/getMe' });
    expect(JSON.stringify(r)).not.toContain('SYNTHETIC_fake_token');
    expect(renderDoctorReport(r)).not.toContain('SYNTHETIC_fake_token');
  });
});

describe('doctor: action plans folder', () => {
  it('names the default folder, and warns about a folder that cannot be used without creating anything', async () => {
    writeSite();
    const ok = await runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, {}), network: false, node: { version: 'v24.9.0', lts: 'Krypton' } });
    expect(check(ok, 'plans.folder')).toMatchObject({ level: 'ok', detail: expect.stringContaining(path.join(ws.paths.root, 'plans', SITE)) });

    const busy = path.join(ws.paths.root, 'site-repo', 'docs');
    mkdirSync(busy, { recursive: true });
    writeFileSync(path.join(busy, 'README.md'), 'site docs (synthetic)');
    writeSite({ actionPlans: { dir: busy } });
    const warned = await runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, {}), network: false, node: { version: 'v24.9.0', lts: 'Krypton' } });
    expect(check(warned, 'plans.folder')).toMatchObject({ level: 'warn', detail: expect.stringMatching(/not created by seo-agent/) });
  });
});
