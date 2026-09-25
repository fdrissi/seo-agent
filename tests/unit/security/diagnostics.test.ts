import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { appRoot, workspacePaths } from '../../../src/config/paths.js';
import {
  IdentifierMasker,
  gatherDiagnostics,
  inspectIntegrations,
  redactConfigShape,
  registerConfigIdentifiers,
  registerConfigTextIdentifiers,
  scrubConfigError,
} from '../../../src/security/diagnostics.js';
import { REDACTED } from '../../../src/security/redact.js';
import { testSiteConfig } from '../../helpers/context.js';

const rand = (n: number) => randomBytes(n).toString('hex').slice(0, n);

// SYNTHETIC identifiers only (reserved TLDs).
function syntheticConfig() {
  return testSiteConfig({
    profile: 'full',
    site: { id: 'synthetic-shop', businessName: 'Synthetic Shop (fixture)', url: 'https://www.synthetic-shop.test/', allowedHostnames: ['www.synthetic-shop.test'] },
    google: { searchConsoleProperty: 'sc-domain:synthetic-shop.test', ga4PropertyId: '987654321' },
    conversions: { primaryEvents: [{ name: 'synthetic_lead_submit', meaning: 'Synthetic lead form', kind: 'lead' }] },
    brand: { aliases: ['SynthShop'] },
    business: { offer: 'Synthetic offer. Contact owner@synthetic-shop.test' },
    research: { competitors: [{ domain: 'rival-one.example', name: 'Rival One (synthetic)' }], subreddits: ['synthetic_subreddit'], dataforseo: { mode: 'sandbox' } },
    features: { playwright: true },
  });
}

describe('IdentifierMasker.scrub', () => {
  const key = Buffer.alloc(32, 7);

  it('masks registered identifiers, emails, URLs, IPs, long numbers, and unregistered hostnames', () => {
    const m = new IdentifierMasker(key);
    registerConfigIdentifiers(syntheticConfig(), m);
    const input =
      'fetch https://www.synthetic-shop.test/pricing?utm=1 failed for sc-domain:synthetic-shop.test (property 987654321); ' +
      'mail dfs-owner@synthetic-shop.test; host api.unlisted-host.invalid at 203.0.113.7; event synthetic_lead_submit; brand SynthShop; competitor rival-one.example';
    const out = m.scrub(input);
    for (const leak of ['synthetic-shop.test', '987654321', 'dfs-owner', 'unlisted-host', '203.0.113.7', 'synthetic_lead_submit', 'SynthShop', 'rival-one', '/pricing']) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toMatch(/<url h:[0-9a-f]{8}>/);
    expect(out).toMatch(/<email h:[0-9a-f]{8}>/);
    expect(out).toMatch(/<ip h:[0-9a-f]{8}>/);
  });

  it('keeps loopback addresses, public API hosts (without path), and file names useful for debugging', () => {
    const m = new IdentifierMasker(key);
    const out = m.scrub('connect ECONNREFUSED 127.0.0.1:6333; GET https://api.llmgateway.io/v1/chat/completions returned 401; file seo-agent.sqlite and config.ts; site.id missing');
    expect(out).toContain('127.0.0.1:6333');
    expect(out).toContain('https://api.llmgateway.io/<path redacted>');
    expect(out).not.toContain('/chat/completions');
    expect(out).toContain('seo-agent.sqlite');
    expect(out).toContain('config.ts');
    expect(out).toContain('site.id');
  });

  it('removes secret values and credential shapes', () => {
    const m = new IdentifierMasker(key);
    const secret = `v${rand(24)}`;
    m.registerSecret(secret);
    const token = `llmgtwy_${rand(24)}`;
    const out = m.scrub(`auth failed with ${secret}; Authorization: Bearer ${rand(30)}; key ${token}`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED);
  });

  it('replaces absolute path prefixes with placeholders', () => {
    const m = new IdentifierMasker(key);
    m.registerPath('/srv/private/ws', '<WORKSPACE>');
    expect(m.scrub('cannot open /srv/private/ws/data/seo-agent.sqlite')).toBe('cannot open <WORKSPACE>/data/seo-agent.sqlite');
  });

  it('hashes consistently within one masker and differently across keys', () => {
    const a = new IdentifierMasker(Buffer.alloc(32, 1));
    const b = new IdentifierMasker(Buffer.alloc(32, 2));
    expect(a.hash('www.synthetic-shop.test')).toBe(a.hash('WWW.synthetic-shop.test'));
    expect(a.hash('www.synthetic-shop.test')).not.toBe(b.hash('www.synthetic-shop.test'));
  });

  it('finalCheck removes any leftover identifier or secret and keeps JSON valid', () => {
    const m = new IdentifierMasker(key);
    m.register('host', 'www.synthetic-shop.test');
    m.registerSecret('s3cr3t-value-xyz');
    const r = m.finalCheck(JSON.stringify({ a: 'www.synthetic-shop.test', b: 'x s3cr3t-value-xyz' }));
    expect(r.removed).toBe(2);
    expect(JSON.parse(r.text)).toEqual({ a: '<removed>', b: `x ${REDACTED}` });
  });

  it('finalCheck never rewrites object keys, even when an identifier equals a key name (regression)', () => {
    const m = new IdentifierMasker(key);
    for (const word of ['database', 'environment', 'Format', 'sites', 'valid']) m.register('name', word);
    m.registerSecret('s3cr3t-value-xyz');
    const input = { format: 'seo-agent-diagnostics', environment: [{ key: 'X' }], database: { present: true }, sites: [{ configStatus: 'valid', note: 'r/database spam' }], 's3cr3t-value-xyz': 1 };
    const r = m.finalCheckValue(input, [/^\$\.format$/, /^\$\.sites\[\]\.configStatus$/]);
    expect(Object.keys(r.value)).toEqual(['format', 'environment', 'database', 'sites', REDACTED]);
    expect(r.value.format).toBe('seo-agent-diagnostics');
    expect(r.value.sites[0]?.configStatus).toBe('valid'); // structural path kept
    expect(r.value.sites[0]?.note).toBe('r/<removed> spam'); // free text still cleaned
    // The string form behaves the same and stays valid JSON.
    const t = m.finalCheck(JSON.stringify({ database: 'the database' }));
    expect(JSON.parse(t.text)).toEqual({ database: 'the <removed>' });
  });

  it('registers identifiers from a schema-INVALID raw config object and from unparseable YAML text', () => {
    const m = new IdentifierMasker(key);
    registerConfigIdentifiers(
      {
        budgets: 'not-an-object',
        site: { id: 'bravo-site', businessName: 'Bravo Widgets Synthetic Ltd', url: 'https://shop.bravo-widgets.localhost/', allowedHostnames: 'wrong-type' },
        conversions: { primaryEvents: [{ name: 'bravo_quote_request' }, 42, null] },
        research: { competitors: [{ domain: 'rival-bravo.localhost', name: 'Rival Bravo Synthetic' }], subreddits: ['bravowidgetfans'] },
        google: { searchConsoleProperty: 'sc-domain:bravo-widgets.localhost', ga4PropertyId: 123456789 },
      },
      m,
    );
    const out = m.scrub('crawl of shop.bravo-widgets.localhost for Bravo Widgets Synthetic Ltd; event bravo_quote_request; Rival Bravo Synthetic at rival-bravo.localhost; r/bravowidgetfans; ga4 123456789');
    for (const leak of ['bravo-widgets', 'Bravo Widgets', 'bravo_quote_request', 'Rival Bravo', 'rival-bravo', 'bravowidgetfans', '123456789']) expect(out, leak).not.toContain(leak);

    const t = new IdentifierMasker(key);
    registerConfigTextIdentifiers(
      [
        'site:',
        '  id: bravo-site',
        '  businessName: "Bravo Widgets Synthetic Ltd"',
        '  url: https://shop.bravo-widgets.localhost/',
        '  allowedHostnames:',
        '    - shop.bravo-widgets.localhost',
        'brand:',
        '  aliases: [BravoWidgetsSyn, "Bravo W Syn"]',
        'research:',
        '  subreddits:',
        '    - bravowidgetfans',
        'conversions:',
        '  primaryEvents:',
        '    - name: bravo_quote_request',
        '  broken: [unclosed',
      ].join('\n'),
      t,
    );
    const out2 = t.scrub('Bravo Widgets Synthetic Ltd / shop.bravo-widgets.localhost / BravoWidgetsSyn / Bravo W Syn / bravowidgetfans / bravo_quote_request / bravo-site');
    for (const leak of ['Bravo Widgets', 'bravo-widgets', 'BravoWidgetsSyn', 'Bravo W Syn', 'bravowidgetfans', 'bravo_quote_request', 'bravo-site']) expect(out2, leak).not.toContain(leak);
  });

  it('scrubs config errors: quoted values masked, YAML snippets dropped', () => {
    const m = new IdentifierMasker(key);
    const lines = scrubConfigError('Site config file x.yaml declares site.id "private-other-site"; they must match.\n\nsite:\n  url: https://www.private-other.test/', m);
    expect(lines.join('\n')).not.toContain('private-other');
    expect(lines[0]).toContain('declares site.id "<value h:');
  });
});

describe('config shape redaction', () => {
  it('keeps booleans, numbers, enums, time zones, cron, budgets; hashes identifiers; redacts other strings', () => {
    const m = new IdentifierMasker(Buffer.alloc(32, 3));
    const shape = redactConfigShape(syntheticConfig(), m) as Record<string, any>;
    expect(shape.profile).toBe('full');
    expect(shape.research.dataforseo.mode).toBe('sandbox');
    expect(shape.market.devices).toEqual(['desktop', 'mobile']);
    expect(shape.scheduler.timezone).toBe('Europe/Tallinn');
    expect(shape.scheduler.weekly).toEqual({ enabled: false, cron: '0 7 * * 1' });
    expect(shape.budgets.llmGateway.monthlyUsd).toBe('5.00');
    expect(shape.crawl.maxPages).toBe(200);
    expect(shape.features.playwright).toBe(true);
    expect(shape.site.url).toMatch(/^<url h:[0-9a-f]{8}>$/);
    expect(shape.site.allowedHostnames[0]).toMatch(/^<host h:[0-9a-f]{8}>$/);
    expect(shape.google.searchConsoleProperty).toMatch(/^<sc-domain property h:[0-9a-f]{8}>$/);
    expect(shape.google.ga4PropertyId).toMatch(/^<ga4 h:[0-9a-f]{8}>$/);
    expect(shape.site.businessName).toBe('<redacted>');
    expect(shape.business.offer).toBe('<redacted>');
    expect(shape.conversions.primaryEvents[0]).toMatchObject({ name: '<redacted>', kind: 'lead' });
    expect(shape.research.apify.actorId).toContain('default public Actor ID');
    expect(shape.models.cheap).toBeNull();
    const text = JSON.stringify(shape);
    for (const leak of ['synthetic-shop', '987654321', 'Synthetic Shop', 'owner@', 'rival-one', 'synthetic_lead_submit', 'SynthShop']) expect(text, leak).not.toContain(leak);
  });
});

describe('local integration inspection', () => {
  const paths = workspacePaths('/nonexistent/synthetic-workspace');

  it('reports honest states from credential presence without network access', () => {
    const cfg = syntheticConfig();
    const states = Object.fromEntries(
      inspectIntegrations(cfg, new MemorySecretStore({ LLM_GATEWAY_API_KEY: `llmgtwy_${rand(20)}`, APIFY_TOKEN: `apify_api_${rand(24)}` }), paths).map((i) => [i.id, i]),
    );
    expect(states.google_gsc?.state).toBe('missing_credentials');
    expect(states.llm_gateway?.state).toBe('misconfigured'); // key but no model IDs
    expect(states.apify?.state).toBe('misconfigured'); // build not pinned
    expect(states.dataforseo?.state).toBe('missing_credentials');
    expect(states.pagespeed?.state).toBe('missing_credentials');
    expect(states.playwright?.state).toBe('disabled');
    expect(states.playwright?.detail).toContain('optional-disabled');
    expect(Object.values(states).every((s) => s.networkChecked === false && s.source === 'local-inspection')).toBe(true);
  });

  it('marks sandbox DataForSEO as fixture data and disabled features as disabled', () => {
    const cfg = syntheticConfig();
    const states = Object.fromEntries(inspectIntegrations(cfg, new MemorySecretStore({ DATAFORSEO_LOGIN: 'dfs@synthetic-shop.test', DATAFORSEO_PASSWORD: rand(16) }), paths).map((i) => [i.id, i]));
    expect(states.dataforseo?.state).toBe('fixture');
    const core = testSiteConfig();
    const coreStates = Object.fromEntries(inspectIntegrations(core, new MemorySecretStore({}), paths).map((i) => [i.id, i]));
    expect(coreStates.dataforseo?.state).toBe('disabled');
    expect(coreStates.qdrant?.state).toBe('disabled');
  });

  it('never includes credential values in details', () => {
    const secret = rand(24);
    const all = JSON.stringify(inspectIntegrations(syntheticConfig(), new MemorySecretStore({ LLM_GATEWAY_API_KEY: secret, QDRANT_API_KEY: secret, PAGESPEED_API_KEY: secret, APIFY_TOKEN: secret }), paths));
    expect(all).not.toContain(secret);
  });
});

describe('workspace location in diagnostics', () => {
  it('reports a workspace reached through a symlink into the application repository as inside it (symlinks resolved)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-diag-link-'));
    try {
      const link = path.join(tmp, 'repo-link');
      symlinkSync(path.join(appRoot(), 'src'), link);
      const inside = path.join(link, `ws-diag-${process.pid}`);
      const bundle = gatherDiagnostics({ paths: workspacePaths(inside), env: {}, secrets: new MemorySecretStore({}) });
      expect(bundle.workspace.insideAppRepository).toBe(true);
      expect(existsSync(path.join(appRoot(), 'src', `ws-diag-${process.pid}`))).toBe(false);
      const outside = gatherDiagnostics({ paths: workspacePaths(path.join(tmp, 'ws')), env: {}, secrets: new MemorySecretStore({}) });
      expect(outside.workspace.insideAppRepository).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
