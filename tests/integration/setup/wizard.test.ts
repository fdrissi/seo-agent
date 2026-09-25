import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSiteConfig } from '../../../src/config/load.js';
import { siteConfigFile } from '../../../src/config/paths.js';
import { draftFile, loadDraft } from '../../../src/setup/draft.js';
import type { SetupServices } from '../../../src/setup/session.js';
import { resolveStepSelectors, wizardStepGroups } from '../../../src/setup/steps.js';
import { BASE_ANSWERS, makeWorkspace, runWizard, secretStore, type TestWorkspace } from './helpers.js';

const SECRET = 'sk-synthetic-test-value-9f8e7d6c5b4a';

let ws: TestWorkspace;
beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

const mode = (file: string) => (statSync(file).mode & 0o777).toString(8);

describe('setup wizard: create', () => {
  it('writes a validated 0600 site config from minimal answers and removes the draft', async () => {
    const { result, io } = await runWizard(ws, { ...BASE_ANSWERS, 'market.countries': 'ee, fi', 'market.languages': 'en,ET', 'reporting.currency': 'eur' });
    expect(result.status).toBe('written');
    const file = siteConfigFile(ws.paths, 'acme-test');
    expect(result.configFile).toBe(file);
    if (process.platform !== 'win32') expect(mode(file)).toBe('600');
    const cfg = loadSiteConfig(ws.paths, 'acme-test');
    expect(cfg.profile).toBe('core');
    expect(cfg.site).toMatchObject({ businessName: 'Acme Test Co (synthetic)', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'] });
    expect(cfg.market).toMatchObject({ countries: ['EE', 'FI'], languages: ['en', 'et'], devices: ['desktop', 'mobile'] });
    expect(cfg.reporting).toEqual({ currency: 'EUR', businessTimezone: null });
    // Scheduler zone default is Europe/Tallinn and says nothing about the market.
    expect(cfg.scheduler.timezone).toBe('Europe/Tallinn');
    expect(io.output()).toContain('does not describe the website');
    // Unknown facts stay unknown.
    expect(cfg.business.offer).toBeNull();
    expect(cfg.google).toMatchObject({ searchConsoleProperty: null, ga4PropertyId: null });
    expect(cfg.models).toMatchObject({ cheap: null, reasoning: null });
    expect(cfg.editorial).toMatchObject({ avoidEmojis: true, avoidEmDashes: true });
    // Budget defaults are presented as ceilings, not quotes.
    expect(io.output()).toMatch(/spending CEILINGS you configure, not price quotes/);
    expect(existsSync(draftFile(ws.paths, 'acme-test'))).toBe(false);
    expect(result.nextSteps.join('\n')).toContain('setup vault --site acme-test');
    expect(result.missingSecrets).toEqual([{ key: 'LLM_GATEWAY_API_KEY', optional: true }]);
  });

  it('explains the profiles and never writes a demo config into a live workspace', async () => {
    const { result, io } = await runWizard(ws, { ...BASE_ANSWERS, profile: '1' });
    expect(result.status).toBe('demo');
    expect(io.output()).toMatch(/Demo: .*No credentials/);
    expect(io.output()).toMatch(/Full: .*DataForSEO/);
    expect(io.output()).toContain('npm run demo');
    expect(readdirSync(ws.paths.sitesDir)).toEqual([]);
  });
});

describe('setup wizard: resume after interruption', () => {
  it('saves every answer to a 0600 draft and resumes without re-asking', async () => {
    const first = await runWizard(ws, { ...BASE_ANSWERS, 'business.offer': 'Synthetic widgets' }, { script: { interruptAt: 'market.countries' } });
    expect(first.result.status).toBe('interrupted');
    const file = draftFile(ws.paths, 'acme-test');
    expect(first.result.draftFile).toBe(file);
    if (process.platform !== 'win32') expect(mode(file)).toBe('600');
    const draft = loadDraft(ws.paths, 'acme-test')!;
    expect(draft.answered).toEqual(expect.arrayContaining(['profile', 'site.id', 'site.businessName', 'site.url', 'business.offer']));
    expect(existsSync(siteConfigFile(ws.paths, 'acme-test'))).toBe(false);
    // Drafts are not sites.
    expect(readdirSync(ws.paths.sitesDir).filter((f) => !f.startsWith('.'))).toEqual([]);

    const second = await runWizard(ws, { resume: 'y', 'market.countries': 'EE' });
    expect(second.result.status).toBe('written');
    const asked = second.io.keys();
    for (const k of ['profile', 'site.id', 'site.businessName', 'site.url', 'business.offer', 'site.allowedHostnames']) expect(asked).not.toContain(k);
    expect(asked[0]).toBe('resume');
    expect(asked).toContain('market.countries');
    const cfg = loadSiteConfig(ws.paths, 'acme-test');
    expect(cfg.business.offer).toBe('Synthetic widgets');
    expect(cfg.market.countries).toEqual(['EE']);
  });

  it('resumes inside a multi-part answer (an event half entered)', async () => {
    const first = await runWizard(ws, { ...BASE_ANSWERS, 'conversions.primaryEvents[0].name': 'generate_lead' }, { script: { interruptAt: 'conversions.primaryEvents[0].meaning' } });
    expect(first.result.status).toBe('interrupted');
    const second = await runWizard(ws, {
      resume: 'y',
      'conversions.primaryEvents[0].meaning': 'Demo request form submitted',
      'conversions.primaryEvents[0].kind': '2',
      'conversions.primaryEvents[0].valueAmount': '',
    });
    expect(second.result.status).toBe('written');
    expect(second.io.keys()).not.toContain('conversions.primaryEvents[0].name');
    const cfg = loadSiteConfig(ws.paths, 'acme-test');
    expect(cfg.conversions.primaryEvents).toEqual([{ name: 'generate_lead', meaning: 'Demo request form submitted', kind: 'lead', value: null, verifiedAt: null, verificationNote: null }]);
  });

  it('resuming with --site picks the draft directly', async () => {
    await runWizard(ws, BASE_ANSWERS, { script: { interruptAt: 'business.offer' } });
    const second = await runWizard(ws, {}, { siteId: 'acme-test' });
    expect(second.result.status).toBe('written');
    expect(second.io.keys()).not.toContain('resume');
    expect(second.io.keys()).not.toContain('site.url');
  });
});

describe('setup wizard: the site ID is asked first, so every later answer is saved (B1-11)', () => {
  it('asks the site ID before the profile and keeps the profile answer across an interruption', async () => {
    const first = await runWizard(ws, BASE_ANSWERS, { script: { interruptAt: 'site.businessName' } });
    expect(first.io.keys().slice(0, 2)).toEqual(['site.id', 'profile']);
    expect(first.io.output()).toContain('Once the site ID is set, answers are saved after every question');
    expect(first.result).toMatchObject({ status: 'interrupted', siteId: 'acme-test', draftFile: draftFile(ws.paths, 'acme-test') });
    const draft = loadDraft(ws.paths, 'acme-test')!;
    expect(draft.values).toMatchObject({ profile: 'core', site: { id: 'acme-test' } });
    expect(draft.answered).toEqual(expect.arrayContaining(['site.id', 'profile']));

    const second = await runWizard(ws, { resume: 'y', 'site.businessName': 'Acme Test Co (synthetic)', 'site.url': 'https://www.example.test/' });
    expect(second.result.status).toBe('written');
    expect(second.io.keys()).not.toContain('profile');
    expect(second.io.keys()).not.toContain('site.id');
    expect(loadSiteConfig(ws.paths, 'acme-test').profile).toBe('core');
  });

  it('an interruption at the profile question keeps the site ID and resumes at the profile', async () => {
    const first = await runWizard(ws, BASE_ANSWERS, { script: { interruptAt: 'profile' } });
    const file = draftFile(ws.paths, 'acme-test');
    expect(first.result).toMatchObject({ status: 'interrupted', draftFile: file });
    expect(first.io.output()).toContain(`Setup interrupted. Progress is saved in ${file}. Run \`npm run cli -- setup --site acme-test\` to resume.`);
    const second = await runWizard(ws, { ...BASE_ANSWERS, resume: 'y' });
    expect(second.result.status).toBe('written');
    expect(second.io.keys()).toContain('profile');
    expect(second.io.keys()).not.toContain('site.id');
  });

  it('an interruption at the site ID prompt saves nothing and never tells the owner to "resume"', async () => {
    const first = await runWizard(ws, BASE_ANSWERS, { script: { interruptAt: 'site.id' } });
    expect(first.result).toMatchObject({ status: 'interrupted', siteId: null, draftFile: null });
    expect(readdirSync(ws.paths.sitesDir)).toEqual([]);
    const out = first.io.output();
    expect(out).toContain('Setup interrupted before any answer was saved (answers are saved once the site ID is set). Run `npm run cli -- setup` to start again.');
    // The interruption message itself (the intro explains resuming in general).
    expect(out.slice(out.indexOf('Setup interrupted'))).not.toMatch(/to resume|Progress is saved/);
  });

  it('declining to resume and stopping at the site ID mentions the drafts that can still be resumed', async () => {
    await runWizard(ws, BASE_ANSWERS, { script: { interruptAt: 'site.url' } });
    const second = await runWizard(ws, { resume: 'n' }, { script: { interruptAt: 'site.id' } });
    expect(second.result).toMatchObject({ status: 'interrupted', draftFile: null });
    expect(second.io.output()).toContain('Setup interrupted; nothing new was saved. Unfinished setup(s) for "acme-test" can still be resumed with `npm run cli -- setup`.');
  });

  it('choosing the demo profile leaves no draft behind (not even a hidden one) and is not replayed', async () => {
    const { result } = await runWizard(ws, { ...BASE_ANSWERS, profile: '1' });
    expect(result.status).toBe('demo');
    expect(readdirSync(ws.paths.sitesDir)).toEqual([]);
    const again = await runWizard(ws, BASE_ANSWERS);
    expect(again.result.status).toBe('written');
    expect(again.io.keys()).not.toContain('resume');
  });
});

describe('setup wizard: a refused profile answer is never replayed', () => {
  it('choosing Demo in `--update --only profile` writes nothing, leaves no empty draft, and asks again next time', async () => {
    expect((await runWizard(ws, BASE_ANSWERS)).result.status).toBe('written');
    const demo = await runWizard(ws, { profile: '1' }, { update: true, siteId: 'acme-test', only: ['profile'] });
    expect(demo.result.status).toBe('demo');
    expect(existsSync(draftFile(ws.paths, 'acme-test'))).toBe(false);
    expect(loadSiteConfig(ws.paths, 'acme-test').profile).toBe('core');
    const again = await runWizard(ws, { profile: '2' }, { update: true, siteId: 'acme-test', only: ['profile'] });
    expect(again.io.keys()).toContain('profile');
    expect(again.result.status).toBe('unchanged');
  });
});

describe('setup wizard: only missing information', () => {
  const existing = [
    '# owner comment that must survive an update',
    'profile: core',
    'site:',
    '  id: acme-test',
    '  businessName: Acme Test Co (synthetic)',
    '  url: https://www.example.test/',
    '  allowedHostnames: [www.example.test]',
    '  urlAliases: []',
    'business:',
    '  offer: Synthetic widgets',
    '  targetCustomer: null',
    'market:',
    '  countries: [EE]',
    '  languages: [en]',
    '  devices: [desktop, mobile]',
    'reporting: { currency: EUR, businessTimezone: Europe/Tallinn }',
    'scheduler:',
    '  timezone: Europe/Tallinn',
    '  weekly: { enabled: false, cron: "0 7 * * 1" }',
    '  monthly: { enabled: false, cron: "0 8 2 * *" }',
    'google:',
    '  searchConsoleProperty: "sc-domain:example.test"',
    '  ga4PropertyId: "123456789"',
    'brand: { aliases: [Acme] }',
    'crawl: { maxPages: 100, maxDepth: 4, requestDelayMs: 1500 }',
    'editorial: { brandVoice: Plain, avoidEmojis: true, avoidEmDashes: true, requirements: [] }',
    'budgets:',
    '  llmGateway: { monthlyUsd: "5.00", perRunUsd: "0.50" }',
    '  combinedMonthlyUsd: "25.00"',
    'features: {}',
    '',
  ].join('\n');

  it('--update asks only for empty fields, shows a diff, keeps comments, and backs up the old file', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, existing, { mode: 0o600 });
    const secrets = secretStore(ws, { CHEAP_MODEL: 'env-model-cheap', REASONING_MODEL: 'env-model-reasoning', GOOGLE_AUTH_MODE: 'oauth' });
    const { result, io } = await runWizard(ws, { 'business.targetCustomer': 'Small synthetic shops' }, { update: true, siteId: 'acme-test', secrets });
    expect(result.status).toBe('written');
    const asked = io.keys();
    for (const k of [
      'profile',
      'site.businessName',
      'site.url',
      'business.offer',
      'market.countries',
      'google.searchConsoleProperty',
      'google.ga4PropertyId',
      'google.authMode',
      'crawl.limits.keep',
      'budgets.keep',
      'features.keep',
      'scheduler.weekly.enabled',
      'models.cheap',
      'models.reasoning',
      'reporting.currency',
    ]) {
      expect(asked).not.toContain(k);
    }
    expect(asked).toContain('business.targetCustomer');
    expect(asked).toContain('conversions.primaryEvents[0].name');
    expect(result.diff).toContain('+  targetCustomer: Small synthetic shops');
    expect(result.diff).toContain('-  targetCustomer: null');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# owner comment that must survive an update');
    expect(result.backupFile).toBeTruthy();
    expect(readFileSync(result.backupFile!, 'utf8')).toBe(existing);
    expect(loadSiteConfig(ws.paths, 'acme-test').crawl.maxPages).toBe(100);
  });

  it('--only re-asks one step and changes nothing else', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, existing, { mode: 0o600 });
    const { result, io } = await runWizard(ws, { 'google.ga4PropertyId': ['G-ABCDEF1234', '987654321'] }, { update: true, siteId: 'acme-test', only: ['google.ga4PropertyId'] });
    expect(result.status).toBe('written');
    expect(io.keys().filter((k) => k !== 'confirm.write')).toEqual(['google.ga4PropertyId', 'google.ga4PropertyId']);
    expect(io.output()).toContain('is a measurement ID');
    expect(result.diff).toContain('+  ga4PropertyId: "987654321"');
    expect(result.diff!.split('\n').filter((l) => /^[+-] /.test(l))).toHaveLength(2);
  });

  it('rejects unknown step ids for --only', async () => {
    await expect(runWizard(ws, {}, { update: true, siteId: 'acme-test', only: ['nope'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // A group is a whole dotted prefix, never a partial word.
    await expect(runWizard(ws, {}, { update: true, siteId: 'acme-test', only: ['conv'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('conv') });
  });

  const withEvents = existing.replace(
    'brand: { aliases: [Acme] }',
    [
      'conversions:',
      '  primaryEvents:',
      '    - { name: generate_lead, meaning: Demo request form submitted, kind: lead }',
      '  secondaryEvents:',
      '    - { name: newsletter_signup, meaning: Newsletter signup, kind: signup }',
      'brand: { aliases: [Acme] }',
    ].join('\n'),
  );

  it('--only conversions (the group named in owner-verification hints) asks both event steps and records the verification', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, withEvents, { mode: 0o600 });
    const { result, io } = await runWizard(
      ws,
      {
        'conversions.primaryEvents.current[0].verifiedAt': ['2026-12-01', '2026-09-20'],
        'conversions.primaryEvents.current[0].verificationNote': 'Synthetic test submission seen in GA4 DebugView',
      },
      { update: true, siteId: 'acme-test', only: ['conversions'] },
    );
    expect(result.status).toBe('written');
    const keys = io.keys().filter((k) => k !== 'confirm.write');
    // Only the two conversion steps were asked; nothing else.
    expect(keys.every((k) => k.startsWith('conversions.'))).toBe(true);
    expect(keys).toEqual(expect.arrayContaining(['conversions.primaryEvents.current[0].keep', 'conversions.primaryEvents[0].name', 'conversions.secondaryEvents.current[0].keep', 'conversions.secondaryEvents[0].name']));
    // Secondary events never ask for owner verification.
    expect(keys.filter((k) => k.startsWith('conversions.secondaryEvents') && k.includes('verif'))).toEqual([]);
    // A future verification date is refused (clock: 2026-09-24).
    expect(io.output()).toContain('cannot be in the future');
    expect(io.output()).toContain('generate_lead (Demo request form submitted): not verified yet');
    const cfg = loadSiteConfig(ws.paths, 'acme-test');
    expect(cfg.conversions.primaryEvents).toEqual([
      { name: 'generate_lead', meaning: 'Demo request form submitted', kind: 'lead', value: null, verifiedAt: '2026-09-20', verificationNote: 'Synthetic test submission seen in GA4 DebugView' },
    ]);
    expect(cfg.conversions.secondaryEvents).toEqual([{ name: 'newsletter_signup', meaning: 'Newsletter signup', kind: 'signup', value: null, verifiedAt: null, verificationNote: null }]);
    expect(result.diff).toContain('2026-09-20');
    // A kept secondary event is left exactly as written (no diff noise).
    expect(result.diff!.split('\n').filter((l) => /^[+-] /.test(l) && l.includes('newsletter_signup'))).toEqual([]);
    expect(result.diff!.split('\n').filter((l) => /^[+-] /.test(l) && l.includes('verifiedAt: null'))).toEqual([]);
    // Nothing outside the conversions block changed.
    expect(cfg.google.ga4PropertyId).toBe('123456789');
    expect(readFileSync(file, 'utf8')).toContain('# owner comment that must survive an update');
  });

  it('a blank verification keeps what is recorded; an event can be removed; a new event is verified only when a date is given', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(
      file,
      withEvents.replace('kind: lead }', 'kind: lead, verifiedAt: "2026-09-01", verificationNote: Seen in DebugView }'),
      { mode: 0o600 },
    );
    const { result, io } = await runWizard(
      ws,
      {
        'conversions.primaryEvents[0].name': ['start_trial', ''],
        'conversions.primaryEvents[0].meaning': 'Free trial started',
        'conversions.primaryEvents[0].kind': '3',
        'conversions.secondaryEvents.current[0].keep': 'n',
      },
      { update: true, siteId: 'acme-test', only: ['conversions.primaryEvents', 'conversions.secondaryEvents'] },
    );
    expect(result.status).toBe('written');
    expect(io.output()).toContain('generate_lead (Demo request form submitted): verified 2026-09-01');
    const cfg = loadSiteConfig(ws.paths, 'acme-test');
    expect(cfg.conversions.primaryEvents).toEqual([
      { name: 'generate_lead', meaning: 'Demo request form submitted', kind: 'lead', value: null, verifiedAt: '2026-09-01', verificationNote: 'Seen in DebugView' },
      { name: 'start_trial', meaning: 'Free trial started', kind: 'signup', value: null, verifiedAt: null, verificationNote: null },
    ]);
    expect(cfg.conversions.secondaryEvents).toEqual([]);
    // The new event's verification was asked (blank = not verified yet), its note was not.
    expect(io.keys()).toContain('conversions.primaryEvents[0].verifiedAt');
    expect(io.keys()).not.toContain('conversions.primaryEvents[0].verificationNote');
  });

  it('an interrupted --only run resumes the half-answered step even without --only (saved answers are never dropped)', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, withEvents, { mode: 0o600 });
    const answers = {
      'conversions.primaryEvents.current[0].verifiedAt': '2026-09-20',
      'conversions.primaryEvents.current[0].verificationNote': 'Synthetic test submission seen in GA4 DebugView',
      'conversions.secondaryEvents.current[0].keep': 'y',
    };
    // Interrupted inside the primary events step, after the verification was entered.
    const first = await runWizard(ws, answers, { update: true, siteId: 'acme-test', only: ['conversions'], script: { interruptAt: 'conversions.primaryEvents[0].name' } });
    expect(first.result.status).toBe('interrupted');
    const second = await runWizard(ws, answers, { update: true, siteId: 'acme-test' });
    expect(second.result.status).toBe('written');
    expect(second.io.keys()).not.toContain('conversions.primaryEvents.current[0].verifiedAt');
    expect(second.io.keys()).toContain('conversions.primaryEvents[0].name');
    expect(loadSiteConfig(ws.paths, 'acme-test').conversions.primaryEvents[0]).toMatchObject({ name: 'generate_lead', verifiedAt: '2026-09-20', verificationNote: 'Synthetic test submission seen in GA4 DebugView' });
  });

  const withFacts = existing.replace(
    '  targetCustomer: null',
    [
      '  targetCustomer: null',
      '  productFacts:',
      '    - { id: fact-1, statement: "Plans start at 10 EUR per month (synthetic)", source: owner, verifiedAt: "2026-09-01" }',
      '    - { id: fact-2, statement: "Setup takes one working day (synthetic)", source: null, verifiedAt: null }',
    ].join('\n'),
  );

  it('re-running business.productFacts with blank answers keeps every stored fact: nothing is silently wiped (NF-15)', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, withFacts, { mode: 0o600 });
    // Every answer blank: the keep questions default to Y, the first new-fact question finishes.
    const { result, io } = await runWizard(ws, {}, { update: true, siteId: 'acme-test', only: ['business.productFacts'] });
    expect(io.keys()).toEqual(['business.productFacts.current[0].keep', 'business.productFacts.current[1].keep', 'business.productFacts[0].statement']);
    const out = io.output();
    expect(out).toContain('Stored product facts (2); each is kept unless you answer "n":');
    expect(out).toContain('  - fact-1: Plans start at 10 EUR per month (synthetic) (source: owner), verified 2026-09-01');
    expect(out).toContain('Keep "Plans start at 10 EUR per month (synthetic)"? [Y/n]: ');
    expect(out).toContain('Additional product fact (blank to finish): ');
    expect(result.status).toBe('unchanged');
    expect(readFileSync(file, 'utf8')).toBe(withFacts);
    expect(loadSiteConfig(ws.paths, 'acme-test').business.productFacts).toEqual([
      { id: 'fact-1', statement: 'Plans start at 10 EUR per month (synthetic)', source: 'owner', verifiedAt: '2026-09-01' },
      { id: 'fact-2', statement: 'Setup takes one working day (synthetic)', source: null, verifiedAt: null },
    ]);
  });

  it('business.productFacts removes only facts answered "n", keeps ids, and appends new facts with fresh ids (NF-15)', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, withFacts, { mode: 0o600 });
    const { result, io } = await runWizard(
      ws,
      {
        'business.productFacts.current[0].keep': 'n',
        'business.productFacts.current[1].keep': 'y',
        'business.productFacts[0].statement': 'Free returns within 30 days (synthetic)',
        'business.productFacts[0].source': 'https://www.example.test/returns',
        'business.productFacts[0].verifiedAt': '2026-09-20',
      },
      { update: true, siteId: 'acme-test', only: ['business.productFacts'] },
    );
    expect(result.status).toBe('written');
    expect(io.output()).toContain('Keeping 1 of 2 stored product fact(s); 1 will be removed when you confirm the change.');
    // The removed fact's id (fact-1) is not reused, and the new fact never takes a stored id.
    expect(loadSiteConfig(ws.paths, 'acme-test').business.productFacts).toEqual([
      { id: 'fact-2', statement: 'Setup takes one working day (synthetic)', source: null, verifiedAt: null },
      { id: 'fact-3', statement: 'Free returns within 30 days (synthetic)', source: 'https://www.example.test/returns', verifiedAt: '2026-09-20' },
    ]);
    // The diff shown before writing names the removed fact and the new one (a changed list is re-rendered as a whole).
    const changed = result.diff!.split('\n').filter((l) => /^[+-] /.test(l));
    expect(changed.some((l) => l.startsWith('-') && l.includes('Plans start at 10 EUR per month (synthetic)'))).toBe(true);
    expect(changed.some((l) => l.startsWith('+') && l.includes('Plans start at 10 EUR'))).toBe(false);
    expect(changed.some((l) => l.startsWith('+') && l.includes('Free returns within 30 days (synthetic)'))).toBe(true);
    // Nothing outside the facts changed.
    expect(changed.every((l) => /fact|statement|source|verifiedAt|productFacts/.test(l))).toBe(true);
    expect(loadSiteConfig(ws.paths, 'acme-test').business.offer).toBe('Synthetic widgets');
    expect(readFileSync(file, 'utf8')).toContain('# owner comment that must survive an update');
  });

  it('other groups work the same way (reporting, google)', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, existing, { mode: 0o600 });
    const secrets = secretStore(ws, { GOOGLE_AUTH_MODE: 'oauth' });
    const { result, io } = await runWizard(ws, { 'reporting.businessTimezone': 'Europe/Helsinki', 'google.ga4PropertyId': '987654321', 'google.authMode': '1' }, { update: true, siteId: 'acme-test', only: ['reporting', 'google'], secrets });
    expect(result.status).toBe('written');
    const asked = new Set(io.keys());
    for (const k of ['reporting.currency', 'reporting.businessTimezone', 'google.authMode', 'google.searchConsoleProperty', 'google.ga4PropertyId']) expect(asked.has(k)).toBe(true);
    expect(asked.has('business.offer')).toBe(false);
    const cfg = loadSiteConfig(ws.paths, 'acme-test');
    expect(cfg.reporting.businessTimezone).toBe('Europe/Helsinki');
    expect(cfg.google.ga4PropertyId).toBe('987654321');
  });
});

describe('setup --only selectors', () => {
  it('resolves exact step ids and dotted-prefix groups in wizard order', () => {
    expect(resolveStepSelectors(['conversions'])).toEqual({ stepIds: ['conversions.primaryEvents', 'conversions.secondaryEvents'], unknown: [] });
    expect(resolveStepSelectors(['conversions.*']).stepIds).toEqual(['conversions.primaryEvents', 'conversions.secondaryEvents']);
    expect(resolveStepSelectors(['reporting']).stepIds).toEqual(['reporting.currency', 'reporting.businessTimezone']);
    expect(resolveStepSelectors(['google']).stepIds).toEqual(['google.auth', 'google.searchConsoleProperty', 'google.ga4PropertyId']);
    expect(resolveStepSelectors(['google.ga4PropertyId', 'conversions.secondaryEvents'])).toEqual({ stepIds: ['google.ga4PropertyId', 'conversions.secondaryEvents'], unknown: [] });
    expect(resolveStepSelectors(['models', 'conv', 'nope'])).toEqual({ stepIds: ['models'], unknown: ['conv', 'nope'] });
    const groups = new Map(wizardStepGroups().map((g) => [g.group, g.stepIds]));
    expect(groups.get('conversions')).toEqual(['conversions.primaryEvents', 'conversions.secondaryEvents']);
    // Exact step ids are never listed as groups.
    expect(groups.has('models')).toBe(false);
  });
});

describe('setup wizard: invalid input is re-prompted', () => {
  it('re-asks with the specific problem until the answer is valid', async () => {
    const { result, io } = await runWizard(ws, {
      ...BASE_ANSWERS,
      'site.id': 'acme-test',
      'site.url': ['ftp://example.test/', 'www.example.test', 'https://www.example.test/'],
      'site.allowedHostnames': ['https://www.example.test/', 'www.example.test'],
      'reporting.businessTimezone': ['+02:00', 'Mars/Olympus', 'Europe/Tallinn'],
      'market.countries': ['Estonia', 'EE'],
    });
    expect(result.status).toBe('written');
    const count = (k: string) => io.keys().filter((x) => x === k).length;
    expect(count('site.url')).toBe(3);
    expect(count('site.allowedHostnames')).toBe(2);
    expect(count('reporting.businessTimezone')).toBe(3);
    expect(count('market.countries')).toBe(2);
    expect(io.output()).toContain('Only http(s) URLs are supported');
    expect(io.output()).toContain('not a UTC offset');
    expect(io.output()).toContain('not a bare hostname');
    const cfg = loadSiteConfig(ws.paths, 'acme-test');
    expect(cfg.reporting.businessTimezone).toBe('Europe/Tallinn');
  });

  it('re-asks the step behind a whole-config validation error', async () => {
    const { result, io } = await runWizard(ws, {
      ...BASE_ANSWERS,
      'budgets.keep': 'n',
      'budgets.combinedMonthlyUsd': ['0', '20.00'],
    });
    expect(result.status).toBe('written');
    expect(io.output()).toContain('combinedMonthlyUsd is zero while service budgets are positive');
    expect(loadSiteConfig(ws.paths, 'acme-test').budgets.combinedMonthlyUsd).toBe('20.00');
  });
});

describe('setup wizard: secrets', () => {
  it('stores a secret only in the 0600 secrets file via hidden input; never in the draft, config, or output', async () => {
    const secrets = secretStore(ws);
    const first = await runWizard(ws, { ...BASE_ANSWERS, 'secret.LLM_GATEWAY_API_KEY': '1', 'secret.LLM_GATEWAY_API_KEY.value': SECRET }, { secrets, script: { interruptAt: 'models.cheap' } });
    expect(first.result.status).toBe('interrupted');
    expect(first.result.storedSecrets).toEqual(['LLM_GATEWAY_API_KEY']);
    const hidden = first.io.asked.filter((a) => a.hidden).map((a) => a.key);
    expect(hidden).toEqual(['secret.LLM_GATEWAY_API_KEY.value']);
    expect(first.io.output()).not.toContain(SECRET);
    const env = readFileSync(ws.paths.secretsEnvFile, 'utf8');
    expect(env).toContain(`LLM_GATEWAY_API_KEY=${SECRET}`);
    if (process.platform !== 'win32') expect(mode(ws.paths.secretsEnvFile)).toBe('600');
    expect(readFileSync(draftFile(ws.paths, 'acme-test'), 'utf8')).not.toContain(SECRET);

    const second = await runWizard(ws, { resume: 'y' }, { secrets: secretStore(ws) });
    expect(second.result.status).toBe('written');
    // The stored key is not asked for again.
    expect(second.io.keys().some((k) => k.startsWith('secret.'))).toBe(false);
    const config = readFileSync(siteConfigFile(ws.paths, 'acme-test'), 'utf8');
    expect(config).not.toContain(SECRET);
    expect(config).not.toMatch(/LLM_GATEWAY_API_KEY/);
    expect(second.io.output()).not.toContain(SECRET);
    expect(second.result.missingSecrets).toEqual([]);
  });

  it('refuses to save a known secret typed into a visible answer', async () => {
    const secrets = secretStore(ws, { LLM_GATEWAY_API_KEY: SECRET });
    await expect(runWizard(ws, { ...BASE_ANSWERS, 'business.offer': `our key is ${SECRET}` }, { secrets })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const draft = draftFile(ws.paths, 'acme-test');
    if (existsSync(draft)) expect(readFileSync(draft, 'utf8')).not.toContain(SECRET);
  });

  it('refuses to display or write a diff when the existing config contains a secret value (hand-pasted)', async () => {
    await runWizard(ws, BASE_ANSWERS);
    const file = siteConfigFile(ws.paths, 'acme-test');
    const leaked = readFileSync(file, 'utf8').replace('offer: null', `offer: "${SECRET}"`);
    writeFileSync(file, leaked);
    const secrets = secretStore(ws, { LLM_GATEWAY_API_KEY: SECRET });
    let output = '';
    await expect(
      runWizard(ws, { 'business.targetCustomer': 'Someone' }, { update: true, siteId: 'acme-test', only: ['business.targetCustomer'], secrets }).catch((err) => {
        output = String(err);
        throw err;
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(output).not.toContain(SECRET);
    expect(readFileSync(file, 'utf8')).toBe(leaked);
  });

  it('lets the owner choose environment injection instead of storing the secret', async () => {
    const { result, io } = await runWizard(ws, { ...BASE_ANSWERS, profile: 'full', 'secret.LLM_GATEWAY_API_KEY': '2', 'research.dataforseo.mode': '1' });
    expect(result.status).toBe('written');
    expect(io.asked.some((a) => a.hidden)).toBe(false);
    expect(io.output()).toContain('inject it through the environment');
    expect(readFileSync(ws.paths.secretsEnvFile, 'utf8')).not.toMatch(/^LLM_GATEWAY_API_KEY=/m);
    const keys = result.missingSecrets.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['LLM_GATEWAY_API_KEY', 'APIFY_TOKEN', 'PAGESPEED_API_KEY']));
    // DataForSEO disabled: its credentials are not requested.
    expect(keys).not.toContain('DATAFORSEO_LOGIN');
  });
});

describe('setup wizard: existing configs are never overwritten', () => {
  it('refuses to create a config whose file already exists and leaves it untouched', async () => {
    const file = siteConfigFile(ws.paths, 'acme-test');
    writeFileSync(file, 'owner: content\n');
    await expect(runWizard(ws, BASE_ANSWERS)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(runWizard(ws, {}, { siteId: 'acme-test' })).rejects.toMatchObject({ code: 'CONFLICT', hint: expect.stringContaining('--update') });
    expect(readFileSync(file, 'utf8')).toBe('owner: content\n');
  });

  it('a declined update writes nothing and keeps the draft for later', async () => {
    const first = await runWizard(ws, BASE_ANSWERS);
    const file = first.result.configFile!;
    const before = readFileSync(file, 'utf8');
    const { result } = await runWizard(ws, { 'business.offer': 'Changed offer', 'confirm.write': 'n' }, { update: true, siteId: 'acme-test', only: ['business.offer'] });
    expect(result.status).toBe('declined');
    expect(result.diff).toContain('+  offer: Changed offer');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(draftFile(ws.paths, 'acme-test'))).toBe(true);
    expect(readdirSync(path.join(ws.paths.backupsDir)).includes('config')).toBe(false);
  });

  it('an update draft is not resumed without --update', async () => {
    await runWizard(ws, BASE_ANSWERS);
    await runWizard(ws, { 'confirm.write': 'n', 'business.offer': 'x' }, { update: true, siteId: 'acme-test', only: ['business.offer'] });
    await expect(runWizard(ws, {}, { siteId: 'acme-test' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('setup wizard: discovery and verification helpers', () => {
  it('offers discovered Search Console properties and only accepts one of them exactly', async () => {
    const discover = vi.fn(async () => ({
      ok: true as const,
      properties: [
        { siteUrl: 'https://www.example.test/', permissionLevel: 'siteOwner', canReadData: true },
        { siteUrl: 'sc-domain:example.test', permissionLevel: 'siteFullUser', canReadData: true },
        { siteUrl: 'sc-domain:other.test', permissionLevel: 'siteUnverifiedUser', canReadData: false },
      ],
    }));
    const services: SetupServices = { googleCredentialsPresent: () => ({ present: true, detail: 'test' }), discoverGscProperties: discover };
    const { result, io } = await runWizard(ws, { ...BASE_ANSWERS, 'google.searchConsoleProperty': ['sc-domain:guessed.test', '7', '2'] }, { services });
    expect(result.status).toBe('written');
    expect(discover).toHaveBeenCalledTimes(1);
    expect(io.output()).toContain('cannot read data');
    expect(io.output()).toContain('must match an accessible one exactly');
    expect(loadSiteConfig(ws.paths, 'acme-test').google.searchConsoleProperty).toBe('sc-domain:example.test');
  });

  it('does not call discovery when Google is not authorized yet and never guesses the property', async () => {
    const discover = vi.fn();
    const services: SetupServices = { googleCredentialsPresent: () => ({ present: false, detail: 'no token' }), discoverGscProperties: discover };
    const { result, io } = await runWizard(ws, { ...BASE_ANSWERS, 'google.searchConsoleProperty': ['https://www.example.test', ''] }, { services });
    expect(result.status).toBe('written');
    expect(discover).not.toHaveBeenCalled();
    expect(io.output()).toContain('end with "/" exactly as shown');
    expect(loadSiteConfig(ws.paths, 'acme-test').google.searchConsoleProperty).toBeNull();
  });

  it('verifies model ids against the gateway list (never hardcoded) and re-prompts unknown or wrong-kind ids', async () => {
    const listModels = vi.fn(async () => ({
      ok: true as const,
      retrievedAt: '2026-09-24T09:00:00.000Z',
      authenticated: true,
      models: [
        { id: 'vendor/chat-small', kind: 'chat' as const, priced: true },
        { id: 'vendor/chat-large', kind: 'chat' as const, priced: false },
        { id: 'vendor/embed-1', kind: 'embedding' as const, priced: true },
      ],
    }));
    const secrets = secretStore(ws, { LLM_GATEWAY_API_KEY: SECRET });
    const { result, io } = await runWizard(
      ws,
      { ...BASE_ANSWERS, 'models.cheap': ['vendor/embed-1', 'vendor/does-not-exist', 'vendor/chat-small'], 'models.reasoning': 'vendor/chat-large' },
      { services: { listModels }, secrets },
    );
    expect(result.status).toBe('written');
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(io.output()).toContain('is a embedding model');
    expect(io.output()).toContain('is not in the gateway model list');
    expect(io.output()).toContain('no verified price is known for vendor/chat-large');
    expect(loadSiteConfig(ws.paths, 'acme-test').models).toMatchObject({ cheap: 'vendor/chat-small', reasoning: 'vendor/chat-large' });
  });

  it('skips model questions that the environment already answers', async () => {
    const secrets = secretStore(ws, { CHEAP_MODEL: 'env/cheap', REASONING_MODEL: 'env/reasoning' });
    const { io } = await runWizard(ws, BASE_ANSWERS, { secrets });
    expect(io.keys().filter((k) => k.startsWith('models.'))).toEqual([]);
  });

  it('offline mode makes no discovery calls', async () => {
    const discover = vi.fn();
    const listModels = vi.fn();
    const secrets = secretStore(ws, { LLM_GATEWAY_API_KEY: SECRET });
    const { result } = await runWizard(ws, BASE_ANSWERS, { services: { googleCredentialsPresent: () => ({ present: true, detail: 'x' }), discoverGscProperties: discover, listModels }, secrets, offline: true });
    expect(result.status).toBe('written');
    expect(discover).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
  });
});
