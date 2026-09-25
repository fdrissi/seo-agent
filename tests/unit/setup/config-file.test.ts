import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseYamlSafe } from '../../../src/config/load.js';
import { workspacePaths } from '../../../src/config/paths.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { applyToExistingConfig, planImport, renderNewConfig, validateConfigText } from '../../../src/setup/config-file.js';
import { findSecretLikeContent, isSecretNamedKey } from '../../../src/setup/secrets.js';
import { stepsForErrorPath } from '../../../src/setup/steps.js';
import { leafEntries, mergeValues, setAt } from '../../../src/setup/values.js';

const EXISTING = [
  '# owner header comment',
  '',
  'profile: core',
  'site:',
  '  id: acme-test   # stable id',
  '  businessName: Acme (synthetic)',
  '  url: https://www.example.test/',
  '  allowedHostnames: [www.example.test]',
  '',
  '# market notes',
  'market: { languages: [en] }',
  'budgets:',
  '  llmGateway: { monthlyUsd: "5.00", perRunUsd: "0.50" }',
  'features: {}',
  '',
].join('\n');

describe('config file helpers', () => {
  it('applying answers keeps comments and the formatting of unchanged sections', () => {
    const out = applyToExistingConfig(EXISTING, { google: { ga4PropertyId: '123456789' }, site: { urlAliases: [] } });
    expect(out).toContain('# owner header comment');
    expect(out).toContain('  id: acme-test   # stable id');
    expect(out).toContain('  allowedHostnames: [www.example.test]');
    expect(out).toContain('# market notes\nmarket: { languages: [en] }');
    expect(out).toContain('  llmGateway: { monthlyUsd: "5.00", perRunUsd: "0.50" }');
    const v = parseYamlSafe(out) as Record<string, any>;
    expect(v.google.ga4PropertyId).toBe('123456789');
    expect(v.site.urlAliases).toEqual([]);
    expect(v.site.businessName).toBe('Acme (synthetic)');
  });

  it('the spliced text always parses to exactly the updated values', () => {
    const answers = { market: { countries: ['EE'] }, budgets: { llmGateway: { perRunUsd: '0.25' } }, business: { offer: 'x: y # not a comment' } };
    const out = applyToExistingConfig(EXISTING, answers);
    const expected = mergeValues(parseYamlSafe(EXISTING), answers);
    expect(parseYamlSafe(out)).toEqual(expected);
  });

  it('new configs carry a header, follow schema key order, and validate', () => {
    const text = renderNewConfig({ site: { id: 'acme-test', businessName: 'A', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'] }, profile: 'core' }, new Date('2026-09-24T00:00:00Z'));
    expect(text.startsWith('# seo-agent site configuration')).toBe(true);
    expect(text.indexOf('profile: core')).toBeLessThan(text.indexOf('site:'));
    expect(text).toContain('Never put secrets here');
    expect(validateConfigText(text, 'test').config.site.id).toBe('acme-test');
  });

  it('validation reports field errors and unknown keys', () => {
    expect(() => validateConfigText('site: { id: x }\n', 't')).toThrow(/invalid/);
    const v = validateConfigText(`${EXISTING}\nfeaturs: {}\n`, 't');
    expect(v.unknownKeys).toEqual(['featurs']);
  });

  it('maps validation error paths back to wizard steps', () => {
    expect(stepsForErrorPath('site.url').map((s) => s.id)).toEqual(['site.url']);
    expect(stepsForErrorPath('budgets').map((s) => s.id)).toEqual(['budgets']);
    expect(stepsForErrorPath('conversions.primaryEvents.0.name').map((s) => s.id)).toEqual(['conversions.primaryEvents']);
    expect(stepsForErrorPath('crawl.maxPages').map((s) => s.id)).toEqual(['crawl.limits']);
  });
});

describe('value helpers', () => {
  it('setAt refuses prototype-polluting paths; leafEntries treats arrays as leaves', () => {
    const v: Record<string, unknown> = {};
    expect(() => setAt(v, '__proto__.x', 1)).toThrow();
    setAt(v, 'a.b', [1, 2]);
    setAt(v, 'a.c.d', null);
    expect(leafEntries(v)).toEqual([
      [['a', 'b'], [1, 2]],
      [['a', 'c', 'd'], null],
    ]);
  });
});

describe('setup --from import guards (planImport)', () => {
  const importInto = (kind: 'live' | 'demo', text: string) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-import-'));
    try {
      const root = path.join(tmp, 'ws');
      initWorkspace(root, { kind });
      const src = path.join(tmp, 'site.yaml');
      writeFileSync(src, text);
      const paths = workspacePaths(root);
      try {
        return { plan: planImport(paths, src, { workspaceKind: kind, secrets: new MemorySecretStore({}) }), error: null, sites: readdirSync(paths.sitesDir) };
      } catch (err) {
        return { plan: null, error: err as { code?: string; message: string; details?: { errors?: string[] } }, sites: readdirSync(paths.sitesDir) };
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  it('keeps demo and live apart in both directions', () => {
    const demoInLive = importInto('live', EXISTING.replace('profile: core', 'profile: demo'));
    expect(demoInLive.error).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('live workspace') });
    for (const profile of ['core', 'full']) {
      const liveInDemo = importInto('demo', EXISTING.replace('profile: core', `profile: ${profile}`));
      expect(liveInDemo.error, profile).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('cannot be imported into a demo workspace') });
      expect(liveInDemo.sites).toEqual([]);
    }
    expect(importInto('live', EXISTING).plan?.config.profile).toBe('core');
    expect(importInto('demo', EXISTING.replace('profile: core', 'profile: demo')).plan?.config.profile).toBe('demo');
  });

  it('refuses secret-named keys and credential shapes without echoing the value', () => {
    const r = importInto('live', `${EXISTING}# DATAFORSEO_PASSWORD=hunter2-synthetic\n`);
    expect(r.error).toMatchObject({ code: 'POLICY_DENIED' });
    expect(r.error!.details!.errors).toEqual(['line 15: "DATAFORSEO_PASSWORD" is assigned a value (secret-named)']);
    expect(JSON.stringify(r.error)).not.toContain('hunter2-synthetic');
  });
});

describe('findSecretLikeContent / isSecretNamedKey', () => {
  it('recognises secret-named keys by word, not by substring', () => {
    for (const k of ['api_key', 'apiKey', 'LLM_GATEWAY_API_KEY', 'refreshToken', 'access_token', 'client_secret', 'clientSecret', 'password', 'DATAFORSEO_PASSWORD', 'privateKey', 'credentials']) expect(isSecretNamedKey(k), k).toBe(true);
    for (const k of ['maxOutputTokensCheap', 'maxInputTokens', 'chunkMinTokens', 'GOOGLE_TOKEN_FILE', 'token_mode', 'secret_name', 'keywordVolume', 'monthlyUsd', 'searchConsoleProperty']) expect(isSecretNamedKey(k), k).toBe(false);
  });

  it('finds keys at any depth, assignments in comments, and distinctive credential shapes; placeholders are fine', () => {
    const text = [
      'site:',
      '  id: acme-test',
      '  nested: { apiKey: abc123456 }',
      '# refresh token: 1//0synthetic-refresh-token-value-000',
      'business:',
      '  offer: "Our key AIzaSyntheticSyntheticSyntheticSynth0000 is here"',
      '# password: <paste into secrets.env, not here>',
      '# token: null',
      'url: https://user:synthetic-pass@www.example.test/',
    ].join('\n');
    const findings = findSecretLikeContent(text, parseYamlSafe(text));
    expect(findings).toEqual(
      expect.arrayContaining([
        'site.nested.apiKey is a secret-named key (secrets never belong in site config)',
        'line 3: "apiKey" is assigned a value (secret-named)',
        'line 4: looks like a credential (Google OAuth refresh token)',
        'line 6: looks like a credential (Google API key)',
        'line 9: looks like a credential (credentials in a URL)',
      ]),
    );
    expect(findings.some((f) => f.startsWith('line 7:') || f.startsWith('line 8:'))).toBe(false);
    expect(findings.join('\n')).not.toMatch(/abc123456|synthetic-pass|1\/\/0synthetic/);
    // The shipped example and ordinary prose are clean.
    expect(findSecretLikeContent(EXISTING, parseYamlSafe(EXISTING))).toEqual([]);
    expect(findSecretLikeContent('business:\n  offer: Token-based pricing; secrets management for teams.\n', null)).toEqual([]);
  });
});
