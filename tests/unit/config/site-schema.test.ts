import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseYamlSafe } from '../../../src/config/load.js';
import { appDirs } from '../../../src/config/paths.js';
import {
  FEATURE_KEYS,
  MAX_DECIMAL_AMOUNT,
  ROUTER_RULE_IDS,
  SITE_CONFIG_SCHEMA_VERSION,
  describeSiteConfigFields,
  parseSiteConfig,
  safeParseSiteConfig,
  siteConfigWarnings,
  type SiteConfigInput,
} from '../../../src/config/site-schema.js';

const minimal = (extra: Record<string, unknown> = {}): SiteConfigInput =>
  ({
    site: { id: 'example-site', businessName: 'Example Co (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] },
    ...extra,
  }) as SiteConfigInput;

const errorsOf = (raw: unknown): string[] => {
  const r = safeParseSiteConfig(raw);
  if (r.ok) throw new Error('expected validation errors');
  return r.errors;
};

describe('site config defaults', () => {
  it('fills every section with documented defaults; unknown facts stay null/empty', () => {
    const cfg = parseSiteConfig(minimal());
    expect(cfg.schemaVersion).toBe(SITE_CONFIG_SCHEMA_VERSION);
    expect(cfg.profile).toBe('core');
    expect(cfg.site.urlAliases).toEqual([]);
    expect(cfg.business).toEqual({ offer: null, targetCustomer: null, differentiators: [], productFacts: [], approvedClaims: [], prohibitedClaims: [] });
    expect(cfg.reporting).toEqual({ currency: null, businessTimezone: null });
    expect(cfg.scheduler.timezone).toBe('Europe/Tallinn');
    expect(cfg.scheduler.weekly).toEqual({ enabled: false, cron: '0 7 * * 1' });
    expect(cfg.google.searchConsoleProperty).toBeNull();
    expect(cfg.google.ga4PropertyId).toBeNull();
    expect(cfg.models).toEqual({ cheap: null, reasoning: null, embedding: null, embeddingDimensions: null });
    expect(cfg.research.dataforseo.mode).toBe('disabled');
    expect(cfg.research.apify.build).toBeNull();
    expect(cfg.features).toEqual({});
    expect(cfg.editorial).toMatchObject({ avoidEmojis: true, avoidEmDashes: true });
  });

  it('uses the spec starting budgets as configurable defaults', () => {
    const { budgets } = parseSiteConfig(minimal());
    expect(budgets).toEqual({
      llmGateway: { monthlyUsd: '5.00', perRunUsd: '0.50' },
      dataforseo: { weeklyUsd: '1.00', monthlyUsd: '10.00', perRunUsd: '0.50' },
      apify: { monthlyUsd: '10.00', perRunUsd: '1.00' },
      pagespeed: { monthlyUsd: '0.00', perRunUsd: '0.00' },
      combinedMonthlyUsd: '25.00',
      accountMonthlyUsd: {},
    });
  });

  it('accepts YAML numbers for USD amounts and keeps them as exact decimal strings', () => {
    const cfg = parseSiteConfig(minimal({ budgets: { llmGateway: { monthlyUsd: 3, perRunUsd: 0.25 }, accountMonthlyUsd: { dataforseo: 50 } } }));
    expect(cfg.budgets.llmGateway).toEqual({ monthlyUsd: '3', perRunUsd: '0.25' });
    expect(cfg.budgets.accountMonthlyUsd).toEqual({ dataforseo: '50' });
  });

  it('adds the shared contract fields with defaults that keep current behaviour (schemaVersion stays 1)', () => {
    const cfg = parseSiteConfig(minimal({ conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Form sent (synthetic)' }] } }));
    expect(SITE_CONFIG_SCHEMA_VERSION).toBe(1);
    expect(cfg.site.pageTypes).toEqual([]);
    expect(cfg.router).toMatchObject({
      commercialPageTypes: ['offer', 'product', 'category', 'tool'],
      conversionPoorRatio: 0.5,
      notSetShareMax: 0.2,
      requireConversionDefinition: true,
      minClicksForJoinCheck: 20,
      minPreviousConversionsForDecline: 5,
      ruleOrder: null,
    });
    expect(cfg.llm).toMatchObject({ allowPersonalData: false, personalDataReason: null });
    expect(cfg.conversions.primaryEvents[0]).toMatchObject({ verifiedAt: null, verificationNote: null });
    expect(cfg.research.dataforseo.liveQueueJustification).toBeNull();
    expect(ROUTER_RULE_IDS).toHaveLength(12);
  });

  it('validates the contract fields', () => {
    const typed = parseSiteConfig(
      minimal({
        site: { id: 'example-site', businessName: 'x', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'], pageTypes: [{ match: '/products/*', type: 'product' }] },
        router: { ruleOrder: ['invalid_data', 'healthy', 'ranking'], commercialPageTypes: ['product'] },
        conversions: { primaryEvents: [{ name: 'purchase', meaning: 'Order paid (synthetic)', verifiedAt: '2026-09-01', verificationNote: 'Test order seen in DebugView (synthetic)' }] },
      }),
    );
    expect(typed.site.pageTypes).toEqual([{ match: '/products/*', type: 'product' }]);
    expect(typed.router.ruleOrder).toEqual(['invalid_data', 'healthy', 'ranking']);
    expect(typed.conversions.primaryEvents[0]!.verifiedAt).toBe('2026-09-01');
    expect(errorsOf(minimal({ router: { ruleOrder: ['ranking', 'ranking'] } })).join('\n')).toMatch(/router\.ruleOrder: List each router rule at most once/);
    expect(errorsOf(minimal({ router: { ruleOrder: ['guess'] } })).some((e) => e.startsWith('router.ruleOrder.0:'))).toBe(true);
    expect(errorsOf(minimal({ router: { conversionPoorRatio: 1.5 } })).some((e) => e.startsWith('router.conversionPoorRatio:'))).toBe(true);
    expect(errorsOf(minimal({ router: { notSetShareMax: -0.1 } })).some((e) => e.startsWith('router.notSetShareMax:'))).toBe(true);
    expect(errorsOf(minimal({ router: { minClicksForJoinCheck: 1.5 } })).some((e) => e.startsWith('router.minClicksForJoinCheck:'))).toBe(true);
    expect(errorsOf(minimal({ site: { id: 'example-site', businessName: 'x', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'], pageTypes: [{ match: '', type: 'x' }] } })).some((e) => e.startsWith('site.pageTypes.0.match:'))).toBe(true);
    for (const bad of ['2026-13-01', '2026-02-30', '01.09.2026']) {
      expect(errorsOf(minimal({ conversions: { secondaryEvents: [{ name: 'sign_up', meaning: 'x', verifiedAt: bad }] } })).some((e) => e.startsWith('conversions.secondaryEvents.0.verifiedAt:')), bad).toBe(true);
    }
  });

  it('llm.allowPersonalData requires a stated reason', () => {
    expect(errorsOf(minimal({ llm: { allowPersonalData: true } }))).toContain('llm.personalDataReason: llm.allowPersonalData is true; state why personal data may be sent to the LLM Gateway');
    expect(errorsOf(minimal({ llm: { allowPersonalData: true, personalDataReason: '   ' } })).length).toBe(1);
    expect(parseSiteConfig(minimal({ llm: { allowPersonalData: true, personalDataReason: 'Owner-approved: review handles are needed for attribution (synthetic).' } })).llm.allowPersonalData).toBe(true);
  });

  it('the synthetic example config validates; its only warning is the unknown business time zone (C2-08)', () => {
    const file = appDirs.exampleSiteConfig();
    const raw = parseYamlSafe(readFileSync(file, 'utf8'), file);
    const cfg = parseSiteConfig(raw);
    expect(cfg.site.id).toBe('example-site');
    // The owner's scheduler default (Europe/Tallinn) is never copied into the business zone:
    // a copied example keeps the business zone unknown, and validation says so.
    expect(cfg.reporting.businessTimezone).toBeNull();
    expect(cfg.scheduler.timezone).toBe('Europe/Tallinn');
    expect(siteConfigWarnings(raw, cfg)).toEqual([
      'reporting.businessTimezone: unknown; reports and budget periods use scheduler.timezone Europe/Tallinn. Next step: npm run cli -- setup --update --only reporting.businessTimezone --site example-site',
    ]);
  });
});

describe('site config validation errors', () => {
  it('requires the site identity', () => {
    expect(errorsOf({}).some((e) => e.startsWith('site:'))).toBe(true);
    const errs = errorsOf({ site: { id: 'X', businessName: '', url: 'not a url', allowedHostnames: [] } });
    expect(errs.some((e) => e.startsWith('site.id:') && e.includes('lowercase'))).toBe(true);
    expect(errs.some((e) => e.startsWith('site.businessName:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('site.url:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('site.allowedHostnames:'))).toBe(true);
  });

  it('accepts only http(s) site URLs', () => {
    for (const url of ['javascript:alert(1)', 'ftp://example.com/', 'file:///etc/passwd']) {
      expect(errorsOf(minimal({ site: { id: 'example-site', businessName: 'x', url, allowedHostnames: ['example.com'] } })).some((e) => e.startsWith('site.url:'))).toBe(true);
    }
    expect(safeParseSiteConfig(minimal({ site: { id: 'example-site', businessName: 'x', url: 'http://localhost:3000/', allowedHostnames: ['localhost'] } })).ok).toBe(true);
  });

  it('rejects invalid IANA time zones, including raw UTC offsets', () => {
    expect(errorsOf(minimal({ scheduler: { timezone: 'Mars/Olympus' } })).some((e) => e.startsWith('scheduler.timezone:') && e.includes('IANA'))).toBe(true);
    expect(errorsOf(minimal({ scheduler: { timezone: '+02:00' } })).some((e) => e.startsWith('scheduler.timezone:'))).toBe(true);
    expect(errorsOf(minimal({ reporting: { businessTimezone: 'EET+2' } })).length).toBeGreaterThan(0);
    expect(parseSiteConfig(minimal({ reporting: { businessTimezone: 'America/Los_Angeles' } })).reporting.businessTimezone).toBe('America/Los_Angeles');
  });

  it('rejects guessed Search Console / GA4 property formats', () => {
    for (const p of ['example.com', 'https://www.example.com', 'sc-domain:', 'sc-domain:exa mple.com']) {
      expect(errorsOf(minimal({ google: { searchConsoleProperty: p } })).some((e) => e.startsWith('google.searchConsoleProperty:'))).toBe(true);
    }
    for (const p of ['sc-domain:example.com', 'https://www.example.com/']) expect(parseSiteConfig(minimal({ google: { searchConsoleProperty: p } })).google.searchConsoleProperty).toBe(p);
    expect(errorsOf(minimal({ google: { ga4PropertyId: 'G-ABC123' } })).some((e) => e.startsWith('google.ga4PropertyId:'))).toBe(true);
    expect(parseSiteConfig(minimal({ google: { ga4PropertyId: '123456789' } })).google.ga4PropertyId).toBe('123456789');
  });

  it('rejects invalid budgets (negative, exponent, too precise, wrong type)', () => {
    for (const v of ['-1', '1e3', '0.1234567', 'five', '$5', -1, true]) {
      expect(errorsOf(minimal({ budgets: { apify: { monthlyUsd: v } } })).some((e) => e.startsWith('budgets.apify.monthlyUsd:'))).toBe(true);
    }
    expect(errorsOf(minimal({ budgets: { accountMonthlyUsd: { apify: 'lots' } } })).some((e) => e.startsWith('budgets.accountMonthlyUsd.apify:'))).toBe(true);
  });

  it('rejects amounts above the sanity ceiling with the field path instead of throwing an internal error', () => {
    for (const v of ['99999999999', '1000000000.000001', 1e12]) {
      const errors = errorsOf(minimal({ budgets: { combinedMonthlyUsd: v } }));
      expect(errors.some((e) => e.startsWith('budgets.combinedMonthlyUsd: Amount must be at most'))).toBe(true);
    }
    expect(errorsOf(minimal({ conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'synthetic', value: { amount: '99999999999999', currency: 'EUR' } }] } })).join('\n')).toMatch(/value\.amount: Amount must be at most/);
    expect(safeParseSiteConfig(minimal({ budgets: { combinedMonthlyUsd: MAX_DECIMAL_AMOUNT } })).ok).toBe(true);
  });

  it('rejects out-of-range limits and invalid enums', () => {
    expect(errorsOf(minimal({ crawl: { maxPages: 0 } })).some((e) => e.startsWith('crawl.maxPages:'))).toBe(true);
    expect(errorsOf(minimal({ llm: { maxRepairAttempts: 3 } })).some((e) => e.startsWith('llm.maxRepairAttempts:'))).toBe(true);
    expect(errorsOf(minimal({ profile: 'enterprise' })).some((e) => e.startsWith('profile:'))).toBe(true);
    expect(errorsOf(minimal({ schemaVersion: 2 })).some((e) => e.startsWith('schemaVersion:'))).toBe(true);
    expect(errorsOf(minimal({ features: { llm: 'yes' } })).some((e) => e.startsWith('features.llm:'))).toBe(true);
    expect(errorsOf(minimal({ conversions: { primaryEvents: [{ name: 'lead' }] } })).some((e) => e.startsWith('conversions.primaryEvents.0.meaning:'))).toBe(true);
  });

  it('runs cross-field checks', () => {
    expect(errorsOf(minimal({ memory: { chunkMinTokens: 900 } }))).toContain('memory: require chunkMinTokens <= chunkTargetTokens <= chunkMaxTokens');
    expect(errorsOf(minimal({ router: { rankingPositionMin: 30 } }))).toContain('router: rankingPositionMin must be <= rankingPositionMax');
    expect(errorsOf(minimal({ crawl: { competitorPagesPerQuery: 8, competitorPagesPerQueryMax: 5 } }))).toContain('crawl: competitorPagesPerQuery must be <= competitorPagesPerQueryMax');
    expect(errorsOf(minimal({ budgets: { combinedMonthlyUsd: '0' } }))).toContain('budgets: combinedMonthlyUsd is zero while service budgets are positive');
    // All-zero budgets are a valid "spend nothing" configuration.
    const zero = { monthlyUsd: '0', perRunUsd: '0' };
    expect(
      safeParseSiteConfig(minimal({ budgets: { llmGateway: zero, dataforseo: { ...zero, weeklyUsd: '0' }, apify: zero, pagespeed: zero, combinedMonthlyUsd: '0' } })).ok,
    ).toBe(true);
  });
});

describe('siteConfigWarnings', () => {
  it('reports unknown keys (typos are otherwise silently ignored)', () => {
    const raw = minimal({ featurs: { llm: true }, crawl: { maxPage: 5 }, conversions: { primaryEvents: [{ name: 'lead', meaning: 'x', vlaue: 1 }] } });
    const w = siteConfigWarnings(raw, parseSiteConfig(raw));
    expect(w).toEqual(
      expect.arrayContaining([expect.stringMatching(/^featurs: unknown key/), expect.stringMatching(/^crawl\.maxPage: unknown key/), expect.stringMatching(/^conversions\.primaryEvents\[0\]\.vlaue: unknown key/)]),
    );
  });

  it('never treats Object.prototype names (__proto__, constructor) as known keys', () => {
    const raw = JSON.parse(`{"site": {"id": "example-site", "businessName": "x", "url": "https://www.example.com/", "allowedHostnames": ["www.example.com"]}, "__proto__": {"token": "synthetic"}, "constructor": {"secret": "synthetic"}, "crawl": {"constructor": 1, "hasOwnProperty": 2}}`);
    const w = siteConfigWarnings(raw, parseSiteConfig(raw));
    expect(w).toEqual(expect.arrayContaining([expect.stringMatching(/^__proto__: unknown key/), expect.stringMatching(/^constructor: unknown key/), expect.stringMatching(/^crawl\.constructor: unknown key/), expect.stringMatching(/^crawl\.hasOwnProperty: unknown key/)]));
  });

  it('warns about an unknown business time zone, too many serious queries, an unjustified live queue, and personal data sent to the LLM', () => {
    const quiet = minimal({ reporting: { businessTimezone: 'Europe/Tallinn' } });
    expect(siteConfigWarnings(quiet, parseSiteConfig(quiet))).toEqual([]);
    const raw = minimal({
      scheduler: { timezone: 'America/New_York' },
      research: { seriousQueriesPerRun: 7, dataforseo: { mode: 'sandbox', queue: 'live' } },
      llm: { allowPersonalData: true, personalDataReason: 'Owner approved review handles (synthetic)' },
    });
    const w = siteConfigWarnings(raw, parseSiteConfig(raw)).join('\n');
    expect(w).toContain('reporting.businessTimezone: unknown; reports and budget periods use scheduler.timezone America/New_York');
    expect(w).toContain('setup --update --only reporting.businessTimezone');
    expect(w).toContain('research.seriousQueriesPerRun (7) is above the 3-5');
    expect(w).toContain('research.dataforseo.queue is "live" without research.dataforseo.liveQueueJustification');
    expect(w).toContain('llm.allowPersonalData is true');
    expect(w).toContain('Owner approved review handles (synthetic)');
    const justified = minimal({ reporting: { businessTimezone: 'Europe/Tallinn' }, research: { seriousQueriesPerRun: 5, dataforseo: { queue: 'live', liveQueueJustification: 'Same-day answers for a launch (synthetic)' } } });
    expect(siteConfigWarnings(justified, parseSiteConfig(justified))).toEqual([]);
    expect(errorsOf(minimal({ research: { seriousQueriesPerRun: 11 } })).some((e) => e.startsWith('research.seriousQueriesPerRun:'))).toBe(true);
  });

  it('flags suspicious but valid combinations', () => {
    const raw = minimal({
      site: { id: 'example-site', businessName: 'x', url: 'https://shop.example.com/', allowedHostnames: ['https://www.example.com'] },
      budgets: { apify: { monthlyUsd: '1.00', perRunUsd: '2.00' }, dataforseo: { weeklyUsd: '20', monthlyUsd: '10' }, accountMonthlyUsd: { openai: '5' } },
    });
    const w = siteConfigWarnings(raw, parseSiteConfig(raw)).join('\n');
    expect(w).toContain('does not include the host of site.url (shop.example.com)');
    expect(w).toContain('looks like a URL');
    expect(w).toContain('budgets.apify: perRunUsd (2.00) exceeds monthlyUsd (1.00)');
    expect(w).toContain('budgets.dataforseo: weeklyUsd (20) exceeds monthlyUsd (10)');
    expect(w).toContain('budgets.accountMonthlyUsd.openai: unknown provider key');
  });
});

describe('describeSiteConfigFields', () => {
  it('documents every field with a description', () => {
    const fields = describeSiteConfigFields();
    const undocumented = fields.filter((f) => !f.description.trim()).map((f) => f.path);
    expect(undocumented).toEqual([]);
    const byPath = new Map(fields.map((f) => [f.path, f]));
    expect(byPath.get('site.id')).toMatchObject({ required: true, type: 'string' });
    expect(byPath.get('budgets.llmGateway.monthlyUsd')).toMatchObject({ default: '"5.00"', required: false });
    expect(byPath.get('google.ga4PropertyId')).toMatchObject({ nullable: true, default: 'null' });
    expect(byPath.get('conversions.primaryEvents[].name')).toBeDefined();
    expect(byPath.get('llm.pricingOverrides.<key>.inputPerMillionUsd')).toBeDefined();
    for (const k of FEATURE_KEYS) expect(byPath.get(`features.${k}`)?.type).toBe('boolean');
  });
});
