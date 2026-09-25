import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSiteIds, loadSiteConfig, loadSiteConfigFile, parseYamlSafe, resolveRuntimeSettings, resolveSiteId } from '../../../src/config/load.js';
import { defaultWorkspaceDir, resolveWorkspaceDir, siteConfigFile, siteVaultDir, workspacePaths } from '../../../src/config/paths.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { parseSiteConfig, type SiteConfigInput } from '../../../src/config/site-schema.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-load-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const site = (id: string) => `site:\n  id: ${id}\n  businessName: Synthetic ${id}\n  url: https://www.example.com/\n  allowedHostnames: [www.example.com]\n`;
const cfg = (extra: Partial<SiteConfigInput> = {}) =>
  parseSiteConfig({ site: { id: 'example-site', businessName: 'Example (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] }, ...extra });

describe('parseYamlSafe', () => {
  it('parses plain YAML 1.2 core values (dates stay strings)', () => {
    expect(parseYamlSafe('a: 1\nb: [x, y]\nc: {d: null}\ne: 2026-09-24\nf: yes\ng: !!str 5')).toEqual({ a: 1, b: ['x', 'y'], c: { d: null }, e: '2026-09-24', f: 'yes', g: '5' });
  });

  it.each([
    ['a: !!js/function "function () { return 1 }"', 'js/function'],
    ['a: !!binary aGVsbG8=', 'binary'],
    ['a: !!set {x: null}', 'set'],
    ['a: !custom value', '!custom'],
  ])('rejects non-core tag %j instead of coercing it', (text, fragment) => {
    expect(() => parseYamlSafe(text, 'test.yaml')).toThrow(fragment);
  });

  it('rejects duplicate keys, malformed YAML, and alias bombs', () => {
    expect(() => parseYamlSafe('a: 1\na: 2')).toThrow(/unique/);
    expect(() => parseYamlSafe('a: [unclosed')).toThrow(/invalid YAML/);
    const bomb = ['a: &a [x,x,x,x,x,x,x,x,x]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]', 'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]', 'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]'].join('\n');
    expect(() => parseYamlSafe(bomb)).toThrow(/invalid YAML/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the key %j at any depth (Object.prototype names never reach the schema)', (key) => {
    expect(() => parseYamlSafe(`${key}:\n  token: synthetic\n`, 'top.yaml')).toThrow(`the key "${key}" is not allowed`);
    expect(() => parseYamlSafe(`site:\n  deep:\n    - ${key}: 1\n`, 'deep.yaml')).toThrow(`the key "${key}" is not allowed`);
    expect(() => parseYamlSafe(`{ "${key}": { "polluted": true } }`, 'flow.yaml')).toThrow(`the key "${key}" is not allowed`);
    // As a value (not a key) it is plain text.
    expect(parseYamlSafe(`note: ${key}`)).toEqual({ note: key });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('site config files', () => {
  it('loads, lists, and resolves sites; file name must match site.id', () => {
    const paths = workspacePaths(dir);
    mkdirSync(paths.sitesDir, { recursive: true });
    writeFileSync(path.join(paths.sitesDir, 'alpha-site.yaml'), site('alpha-site'));
    expect(listSiteIds(paths)).toEqual(['alpha-site']);
    expect(resolveSiteId(paths)).toBe('alpha-site');
    expect(loadSiteConfig(paths, 'alpha-site').site.businessName).toBe('Synthetic alpha-site');
    writeFileSync(path.join(paths.sitesDir, 'beta-site.yaml'), site('other-id'));
    writeFileSync(path.join(paths.sitesDir, '.hidden.yaml'), site('hidden'));
    expect(listSiteIds(paths)).toEqual(['alpha-site', 'beta-site']);
    expect(() => resolveSiteId(paths)).toThrow(/Multiple sites/);
    expect(resolveSiteId(paths, 'beta-site')).toBe('beta-site');
    expect(() => loadSiteConfig(paths, 'beta-site')).toThrow(/must match/);
  });

  it('reports missing/invalid configs with actionable errors', () => {
    const paths = workspacePaths(dir);
    expect(() => resolveSiteId(paths)).toThrow(expect.objectContaining({ code: 'CONFIG_MISSING' }));
    expect(() => loadSiteConfigFile(path.join(dir, 'nope.yaml'))).toThrow(expect.objectContaining({ code: 'CONFIG_MISSING' }));
    writeFileSync(path.join(dir, 'bad.yaml'), 'site:\n  id: BAD\n');
    try {
      loadSiteConfigFile(path.join(dir, 'bad.yaml'));
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toMatchObject({ code: 'CONFIG_INVALID' });
      expect((err as { details: { errors: string[] } }).details.errors.some((e) => e.startsWith('site.id:'))).toBe(true);
    }
  });

  it('an older schemaVersion is never migrated or rewritten on load: CONFIG_INVALID pointing at `config migrate`; a newer one asks for an upgrade', () => {
    const paths = workspacePaths(dir);
    mkdirSync(paths.sitesDir, { recursive: true });
    const file = path.join(paths.sitesDir, 'alpha-site.yaml');
    const old = `schemaVersion: 0\n${site('alpha-site')}`;
    writeFileSync(file, old);
    expect(() => loadSiteConfig(paths, 'alpha-site')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', hint: expect.stringContaining('config migrate'), details: expect.objectContaining({ schemaVersion: 0, supported: 1 }) }));
    expect(readFileSync(file, 'utf8')).toBe(old);
    writeFileSync(file, `schemaVersion: 2\n${site('alpha-site')}`);
    expect(() => loadSiteConfig(paths, 'alpha-site')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', hint: expect.stringContaining('Upgrade the application') }));
    writeFileSync(file, `schemaVersion: 1\n${site('alpha-site')}`);
    expect(loadSiteConfig(paths, 'alpha-site').schemaVersion).toBe(1);
  });

  it('site file and vault paths reject traversal in site ids', () => {
    const paths = workspacePaths(dir);
    expect(() => siteConfigFile(paths, '../../etc/passwd')).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => siteVaultDir(paths, '../outside')).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(siteVaultDir(paths, 'alpha-site')).toBe(path.join(dir, 'vault', 'alpha-site'));
  });
});

describe('workspace resolution precedence: --workspace > SEO_AGENT_WORKSPACE > ~/seo-agent-workspace', () => {
  it('resolves in order and expands only "~" and "~/"', () => {
    const env = { HOME: '/home/synthetic', SEO_AGENT_WORKSPACE: '/srv/ws-from-env' } as NodeJS.ProcessEnv;
    expect(resolveWorkspaceDir('/flag/ws', env)).toBe('/flag/ws');
    expect(resolveWorkspaceDir(undefined, env)).toBe('/srv/ws-from-env');
    expect(resolveWorkspaceDir(null, { HOME: '/home/synthetic' })).toBe('/home/synthetic/seo-agent-workspace');
    expect(defaultWorkspaceDir({ HOME: '/home/synthetic' })).toBe('/home/synthetic/seo-agent-workspace');
    expect(resolveWorkspaceDir('~/private-ws', env)).toBe('/home/synthetic/private-ws');
    expect(resolveWorkspaceDir('~', env)).toBe('/home/synthetic');
    expect(resolveWorkspaceDir('~other/ws', env)).toBe(path.resolve('~other/ws'));
    expect(resolveWorkspaceDir('relative/ws', env)).toBe(path.resolve('relative/ws'));
  });

  it('workspacePaths lays out the private workspace', () => {
    const p = workspacePaths('/ws');
    expect(p).toMatchObject({
      manifest: '/ws/workspace.json',
      sitesDir: '/ws/config/sites',
      secretsEnvFile: '/ws/secrets/secrets.env',
      googleDir: '/ws/secrets/google',
      dbFile: '/ws/data/seo-agent.sqlite',
      rawDir: '/ws/data/raw',
      qdrantDir: '/ws/qdrant',
      backupsDir: '/ws/backups',
    });
  });
});

describe('resolveRuntimeSettings precedence', () => {
  it('models: environment (or secrets file) > site config > unset', () => {
    const config = cfg({ models: { cheap: 'config-cheap', reasoning: 'config-reasoning', embedding: null } });
    const s = resolveRuntimeSettings(config, new MemorySecretStore({ CHEAP_MODEL: 'env-cheap' }));
    expect(s.models).toMatchObject({ cheap: 'env-cheap', reasoning: 'config-reasoning', embedding: null });
    expect(s.models.source).toEqual({ cheap: 'env:CHEAP_MODEL', reasoning: 'site-config', embedding: 'unset' });
  });

  it('Apify actor id: explicit env/secrets-file > site config; the built-in default never overrides config', () => {
    const config = cfg({ research: { apify: { actorId: 'configActor01', build: '1.2.3' } } });
    const fromConfig = resolveRuntimeSettings(config, new MemorySecretStore({}));
    expect(fromConfig.apify).toEqual({ actorId: 'configActor01', build: '1.2.3', actorIdSource: 'site-config' });
    const fromEnv = resolveRuntimeSettings(config, new MemorySecretStore({ APIFY_CONTENT_ACTOR_ID: 'envActor02', APIFY_CONTENT_ACTOR_BUILD: '2.0.0' }));
    expect(fromEnv.apify).toEqual({ actorId: 'envActor02', build: '2.0.0', actorIdSource: 'env' });
  });

  it('non-secret endpoints and auth mode use env values or safe defaults', () => {
    const d = resolveRuntimeSettings(cfg(), new MemorySecretStore({}));
    expect(d.llmBaseUrl).toBe('https://api.llmgateway.io/v1');
    expect(d.qdrantUrl).toBe('http://127.0.0.1:6333');
    expect(d.googleAuthMode).toBe('oauth');
    const e = resolveRuntimeSettings(cfg(), new MemorySecretStore({ GOOGLE_AUTH_MODE: 'service_account', QDRANT_URL: 'http://127.0.0.1:7333' }));
    expect(e.googleAuthMode).toBe('service_account');
    expect(e.qdrantUrl).toBe('http://127.0.0.1:7333');
  });

  it('converts budgets to integer micros and resolves features from the profile', () => {
    const s = resolveRuntimeSettings(cfg({ profile: 'full', budgets: { accountMonthlyUsd: { dataforseo: '50.5' } }, features: { qdrant: false } }), new MemorySecretStore({}));
    expect(s.budgets).toEqual({
      llmGateway: { monthly: 5_000_000, perRun: 500_000 },
      dataforseo: { weekly: 1_000_000, monthly: 10_000_000, perRun: 500_000 },
      apify: { monthly: 10_000_000, perRun: 1_000_000 },
      pagespeed: { monthly: 0, perRun: 0 },
      combinedMonthly: 25_000_000,
      accountMonthly: { dataforseo: 50_500_000 },
    });
    expect(s.features.qdrant).toBe(false);
    expect(s.features.apify).toBe(true);
    expect(s.configHash).toMatch(/^[0-9a-f]{64}$/);
    const a = resolveRuntimeSettings(cfg(), new MemorySecretStore({})).configHash;
    expect(resolveRuntimeSettings(cfg(), new MemorySecretStore({ CHEAP_MODEL: 'env-only' })).configHash).toBe(a); // env never changes the config hash
    expect(a).not.toBe(s.configHash);
  });
});
