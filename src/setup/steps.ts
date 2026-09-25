import { existsSync } from 'node:fs';
import { googleCredentialPaths } from '../auth/paths.js';
import { AppError, errorMessage } from '../core/errors.js';
import { PROFILE_DEFAULTS, type Profile } from '../config/profiles.js';
import { FEATURE_DESCRIPTIONS, FEATURE_KEYS, parseSiteConfig, type FeatureKey, type SiteConfig } from '../config/site-schema.js';
import { dateInZone } from '../core/time.js';
import { parseCron } from '../jobs/scheduler.js';
import {
  bad,
  choice,
  commaList,
  countryCode,
  currencyCode,
  decimal,
  ga4EventName,
  ga4PropertyId,
  gscPropertyFormat,
  hostname,
  httpUrl,
  integer,
  isoDate,
  languageCode,
  modelId,
  ok,
  optionalInteger,
  optionalText,
  requiredText,
  sitePath,
  subreddit,
  timeZone,
  yesNo,
  cronExpression,
  type Parsed,
  type Parser,
} from './parse.js';
import { renderProfileInfo } from './profiles.js';
import { featuresOf, secretNeeds, validateSecretValue } from './secrets.js';
import type { ModelChoice, WizardSession } from './session.js';
import { getAt, hasValue, isPlainObject } from './values.js';

/**
 * Wizard steps (spec section 3). A step runs only when it applies to the
 * chosen profile and its information is missing (not in the existing config,
 * not answered in the draft). Every prompt goes through WizardSession.ask, so
 * each answer is saved before the next question.
 */

export interface WizardStep {
  id: string;
  section: string;
  /** Config paths this step writes (used for "only missing" checks and to map validation errors back to steps). */
  paths: string[];
  applies?(s: WizardSession): boolean;
  /** Default: every path lacks a value. */
  isMissing?(s: WizardSession): boolean;
  run(s: WizardSession): Promise<void>;
}

/** Raised when the owner picks the Demo profile for a live workspace: nothing is written. */
export class DemoProfileSelected extends Error {
  constructor() {
    super('demo profile selected');
    this.name = 'DemoProfileSelected';
  }
}

let cachedDefaults: SiteConfig | null = null;
/** Schema defaults (for showing defaults and writing explicit ceilings). */
export function schemaDefaults(): SiteConfig {
  cachedDefaults ??= parseSiteConfig({ site: { id: 'defaults', businessName: 'defaults', url: 'https://example.invalid/', allowedHostnames: ['example.invalid'] } });
  return cachedDefaults;
}

const profileOf = (s: WizardSession): Profile => ((getAt(s.values(), 'profile') as Profile | undefined) ?? 'core');
const notDemo = (s: WizardSession) => profileOf(s) !== 'demo';
const feature = (s: WizardSession, k: FeatureKey) => featuresOf(s.values())[k];

function optional<T>(p: Parser<T>): Parser<T | null> {
  return (raw) => (raw.trim() === '' ? ok(null) : p(raw));
}

/** One item per line until a blank line. Each line is saved as it is entered. */
async function collectLines(s: WizardSession, stepId: string, keyBase: string, question: string, parse: Parser<string> = requiredText(1000)): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 200; i++) {
    const v = await s.ask<string | null>(stepId, `${keyBase}[${i}]`, { question: i === 0 ? question : '  Next (blank to finish): ', parse: optional(parse) });
    if (v === null) break;
    out.push(v);
  }
  return out;
}

function simpleStep(def: {
  id: string;
  section: string;
  path?: string;
  question: string;
  help?: string;
  parse: Parser<unknown>;
  default?: (s: WizardSession) => string | undefined;
  applies?: (s: WizardSession) => boolean;
}): WizardStep {
  const path = def.path ?? def.id;
  return {
    id: def.id,
    section: def.section,
    paths: [path],
    ...(def.applies ? { applies: def.applies } : {}),
    async run(s) {
      const d = def.default?.(s);
      const v = await s.ask(def.id, def.id, { question: def.question, parse: def.parse, ...(def.help ? { help: def.help } : {}), ...(d !== undefined ? { default: d } : {}) });
      s.set(path, v);
    },
  };
}

function hostOf(url: unknown): string | undefined {
  try {
    return typeof url === 'string' ? new URL(url).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const profileStep: WizardStep = {
  id: 'profile',
  section: 'Profile',
  paths: ['profile'],
  async run(s) {
    const v = await s.ask(this.id, 'profile', {
      help: `${renderProfileInfo()}\n`,
      question: 'Choose a profile (1 demo, 2 core, 3 full) [2]: ',
      parse: choice(['demo', 'core', 'full'] as const, 'core'),
    });
    if (v === 'demo' && s.workspaceKind === 'live') {
      // Never mix synthetic demo data into a live workspace; do not replay this answer
      // (the answer was already saved to the draft, so save its removal too).
      s.forget(this.id, 'profile');
      s.save();
      throw new DemoProfileSelected();
    }
    if (v !== 'demo' && s.workspaceKind === 'demo') {
      // Never put a live (core/full) site with real credentials into a demo workspace (a demo refresh deletes it).
      s.forget(this.id, 'profile');
      s.save();
      throw new AppError('POLICY_DENIED', `The ${v} profile cannot be set up in a demo workspace: real credentials and data never belong there, and a demo refresh deletes the workspace contents. Nothing was written.`, {
        hint: 'Create a live workspace (`npm run cli -- --workspace <dir> init`) and run setup there.',
      });
    }
    s.set('profile', v);
  },
};

const identitySteps: WizardStep[] = [
  simpleStep({ id: 'site.businessName', section: 'Website identity', question: 'Business or brand name: ', parse: requiredText(200) }),
  simpleStep({ id: 'site.url', section: 'Website identity', question: 'Canonical website URL (e.g. https://www.example.com/): ', parse: httpUrl }),
  {
    id: 'site.allowedHostnames',
    section: 'Website identity',
    paths: ['site.allowedHostnames'],
    async run(s) {
      const host = hostOf(getAt(s.values(), 'site.url'));
      const v = await s.ask(this.id, this.id, {
        help: 'Hostnames that belong to this site. www and non-www (and http/https) are NOT merged automatically: list another hostname only if it serves this same site.',
        question: 'Allowed hostnames, comma-separated: ',
        parse: commaList(hostname, { min: 1 }),
        ...(host ? { default: host } : {}),
      });
      s.set(this.id, v);
    },
  },
  {
    id: 'site.urlAliases',
    section: 'Website identity',
    paths: ['site.urlAliases'],
    async run(s) {
      s.print('Known URL aliases: URLs that data sources report differently but that are the same page (for example an old URL that 301-redirects). Only add aliases you can back with evidence; unknown equivalences are never assumed.');
      const out: Array<{ alias: string; canonical: string; evidence: string | null }> = [];
      for (let i = 0; i < 100; i++) {
        const alias = await s.ask<string | null>(this.id, `site.urlAliases[${i}].alias`, { question: i === 0 ? 'Alias URL (blank for none): ' : 'Next alias URL (blank to finish): ', parse: optional(httpUrl) });
        if (alias === null) break;
        const canonical = await s.ask<string>(this.id, `site.urlAliases[${i}].canonical`, { question: '  Canonical URL it is equivalent to: ', parse: httpUrl });
        const evidence = await s.ask<string | null>(this.id, `site.urlAliases[${i}].evidence`, { question: '  Evidence (e.g. "301 redirect", "canonical tag", "owner statement"; blank = none recorded): ', parse: optionalText(500) });
        out.push({ alias, canonical, evidence });
      }
      s.set(this.id, out);
    },
  },
];

const businessSteps: WizardStep[] = [
  simpleStep({ id: 'business.offer', section: 'Business', question: 'What does the business offer? (blank = not yet provided): ', parse: optionalText(2000) }),
  simpleStep({ id: 'business.targetCustomer', section: 'Business', question: 'Who is the target customer? (blank = not yet provided): ', parse: optionalText(2000) }),
  {
    id: 'business.differentiators',
    section: 'Business',
    paths: ['business.differentiators'],
    async run(s) {
      s.print('Real, verifiable differentiators only (one per line). Nothing is invented for you; blank finishes.');
      s.set(this.id, await collectLines(s, this.id, this.id, 'Differentiator (blank for none): '));
    },
  },
  {
    id: 'business.productFacts',
    section: 'Business',
    paths: ['business.productFacts'],
    async run(s) {
      s.print('Verified product facts drafts may cite (prices, features, guarantees). Unknown facts stay unknown.');
      const out: unknown[] = [];
      // Stored facts (update mode / re-asked step): each is kept unchanged, with its id, unless the owner
      // answers "n" (like the conversion-event steps). A blank answer never drops a stored fact, and
      // new facts are appended after the kept ones.
      const stored = getAt(s.values(), this.id);
      const existing = Array.isArray(stored) ? stored : [];
      const isOffered = (f: unknown): f is Record<string, unknown> & { statement: string } => isPlainObject(f) && typeof f.statement === 'string' && f.statement.trim() !== '';
      const offered = existing.filter(isOffered);
      if (offered.length) {
        s.print(
          [
            `Stored product facts (${offered.length}); each is kept unless you answer "n":`,
            ...offered.map((f) => `  - ${typeof f.id === 'string' ? `${f.id}: ` : ''}${f.statement}${typeof f.source === 'string' ? ` (source: ${f.source})` : ''}${typeof f.verifiedAt === 'string' ? `, verified ${f.verifiedAt}` : ''}`),
          ].join('\n'),
        );
      }
      let asked = 0;
      let removed = 0;
      for (const f of existing) {
        // An entry without a statement is not offered and stays as it is (config validation reports it).
        if (!isOffered(f)) {
          out.push(f);
          continue;
        }
        const keep = await s.ask<boolean>(this.id, `${this.id}.current[${asked++}].keep`, { question: `Keep "${f.statement}"? [Y/n]: `, parse: yesNo(true) });
        if (keep) out.push(f);
        else removed++;
      }
      if (offered.length) s.print(`Keeping ${offered.length - removed} of ${offered.length} stored product fact(s)${removed ? `; ${removed} will be removed when you confirm the change` : ''}. New facts are added after them.`);
      // New ids never reuse a stored one (kept or removed), so a citation of an old fact id never points at a new fact.
      const usedIds = new Set(existing.flatMap((f) => (isPlainObject(f) && typeof f.id === 'string' ? [f.id] : [])));
      let next = Math.max(existing.length, ...[...usedIds].map((id) => Number(/^fact-(\d+)$/.exec(id)?.[1] ?? 0))) + 1;
      const newId = (): string => {
        while (usedIds.has(`fact-${next}`)) next++;
        const id = `fact-${next++}`;
        usedIds.add(id);
        return id;
      };
      for (let i = 0; i < 200; i++) {
        const first = i === 0 && !out.length;
        const statement = await s.ask<string | null>(this.id, `business.productFacts[${i}].statement`, {
          question: first ? 'Product fact (blank for none): ' : `${i === 0 ? 'Additional' : 'Next'} product fact (blank to finish): `,
          parse: optionalText(1000),
        });
        if (statement === null) break;
        const source = await s.ask<string | null>(this.id, `business.productFacts[${i}].source`, { question: '  Where is it verified? (URL, document, or "owner"; blank = unknown): ', parse: optionalText(500) });
        const verifiedAt = await s.ask<string | null>(this.id, `business.productFacts[${i}].verifiedAt`, { question: '  Last verified on (YYYY-MM-DD; blank = never verified): ', parse: isoDate({ optional: true }) });
        out.push({ id: newId(), statement, source, verifiedAt });
      }
      s.set(this.id, out);
    },
  },
  {
    id: 'business.approvedClaims',
    section: 'Business',
    paths: ['business.approvedClaims'],
    async run(s) {
      s.set(this.id, await collectLines(s, this.id, this.id, 'Marketing claim you approve for use (one per line; blank for none): '));
    },
  },
];

const marketSteps: WizardStep[] = [
  simpleStep({
    id: 'market.countries',
    section: 'Target market',
    question: 'Target countries, ISO codes comma-separated (e.g. EE, FI; blank = not yet decided): ',
    help: 'The target market is never inferred from your scheduler time zone or location.',
    parse: commaList(countryCode),
  }),
  simpleStep({ id: 'market.languages', section: 'Target market', question: 'Content languages, comma-separated BCP 47 tags (e.g. en, et): ', parse: commaList(languageCode) }),
  {
    id: 'market.searchLocations',
    section: 'Target market',
    paths: ['market.searchLocations'],
    async run(s) {
      s.print('Search locations for external research requests. Provider location codes are optional here: leave them blank unless you verified them with `research locations` (they are never guessed).');
      const langs = (getAt(s.values(), 'market.languages') as string[] | undefined) ?? [];
      const out: Array<{ name: string | null; locationCode: number | null; languageCode: string }> = [];
      for (let i = 0; i < 50; i++) {
        const name = await s.ask<string | null>(this.id, `market.searchLocations[${i}].name`, { question: i === 0 ? 'Search location name, e.g. "Estonia" (blank for none): ' : 'Next search location (blank to finish): ', parse: optionalText(200) });
        if (name === null) break;
        const lang = await s.ask<string>(this.id, `market.searchLocations[${i}].languageCode`, { question: '  Language code for this location: ', parse: languageCode, ...(langs[0] ? { default: langs[0] } : {}) });
        const code = await s.ask<number | null>(this.id, `market.searchLocations[${i}].locationCode`, { question: '  Verified provider location code (blank = resolve later): ', parse: optionalInteger({ min: 1, max: 99_999_999 }) });
        out.push({ name, locationCode: code, languageCode: lang });
      }
      s.set(this.id, out);
    },
  },
  simpleStep({
    id: 'market.devices',
    section: 'Target market',
    question: 'Devices to consider (desktop, mobile, tablet; comma-separated): ',
    parse: commaList(choice(['desktop', 'mobile', 'tablet'] as const), { min: 1 }),
    default: () => 'desktop, mobile',
  }),
];

const reportingSteps: WizardStep[] = [
  simpleStep({ id: 'reporting.currency', section: 'Reporting and time', question: 'Reporting currency, ISO 4217 (e.g. EUR; blank = unknown): ', parse: currencyCode }),
  simpleStep({
    id: 'reporting.businessTimezone',
    section: 'Reporting and time',
    question: 'Business time zone for reports, IANA name (e.g. Europe/Tallinn; blank = unknown): ',
    help: 'Reports and budget periods use the business time zone (or the scheduler zone while it is unknown).',
    parse: timeZone({ optional: true }),
  }),
  simpleStep({
    id: 'scheduler.timezone',
    section: 'Reporting and time',
    question: 'Scheduler time zone (IANA): ',
    help: "The scheduler time zone is where YOUR machine runs scheduled jobs. It does not describe the website's target market.",
    parse: timeZone({ optional: false }),
    default: () => schemaDefaults().scheduler.timezone,
  }),
];

function googleWanted(s: WizardSession): boolean {
  const f = featuresOf(s.values());
  return notDemo(s) && (f.gsc || f.ga4 || f.urlInspection);
}

const googleSteps: WizardStep[] = [
  {
    id: 'google.auth',
    section: 'Google access',
    paths: [],
    applies: googleWanted,
    isMissing: (s) => ['default', 'unset'].includes(s.secrets.sourceOf('GOOGLE_AUTH_MODE')),
    async run(s) {
      s.print(
        [
          'Google access uses credentials you create in your own Google Cloud project (read-only scopes: webmasters.readonly, analytics.readonly).',
          '  oauth: a Desktop OAuth client; you authorize in your browser with `npm run cli -- auth google` (recommended for personal use).',
          '  service_account: for unattended servers; the service-account email must be added to the Search Console and GA4 properties.',
        ].join('\n'),
      );
      const mode = await s.ask(this.id, 'google.authMode', { question: 'Google authorization mode (1 oauth, 2 service_account) [1]: ', parse: choice(['oauth', 'service_account'] as const, 'oauth') });
      s.secrets.set('GOOGLE_AUTH_MODE', mode);
      const gpaths = googleCredentialPaths(s.paths, s.secrets);
      if (mode === 'service_account') {
        const file = await s.ask<string | null>(this.id, 'google.serviceAccountFile', {
          question: 'Path to the service-account key or workload identity config file (blank = set GOOGLE_APPLICATION_CREDENTIALS later): ',
          help: `Keep the key file in ${s.paths.googleDir} (mode 0600). Only its path is stored; the file is never copied or printed.`,
          parse: (raw) => {
            const v = raw.trim();
            if (!v) return ok(null);
            if (!existsSync(v)) return bad(`File not found: ${v}`);
            return ok(v);
          },
        });
        if (file) {
          try {
            s.secrets.set('GOOGLE_APPLICATION_CREDENTIALS', file);
            googleCredentialPaths(s.paths, s.secrets);
          } catch (err) {
            s.print(`  Not stored: ${errorMessage(err)}`);
          }
        }
      } else if (!existsSync(gpaths.clientFile)) {
        s.print(
          `Next (after setup): create a "Desktop app" OAuth client in Google Auth Platform > Clients, save its JSON as ${gpaths.clientFile} (chmod 600), then run \`npm run cli -- auth google\`. See docs/ACCESS_SETUP.md.`,
        );
      }
    },
  },
  {
    id: 'google.searchConsoleProperty',
    section: 'Google access',
    paths: ['google.searchConsoleProperty'],
    applies: (s) => notDemo(s) && (feature(s, 'gsc') || feature(s, 'urlInspection')),
    async run(s) {
      const key = 'google.searchConsoleProperty';
      if (!s.hasAnswer(this.id, key)) {
        const avail = s.services.googleCredentialsPresent?.() ?? { present: false, detail: 'property discovery is not available in this session' };
        const cfg = s.candidateConfig();
        if (s.services.discoverGscProperties && cfg && avail.present && !s.offline) {
          const lookup = await s.ask(this.id, `${key}.lookup`, { question: 'Look up the Search Console properties your Google identity can access? (one free, read-only request to Google) [Y/n]: ', parse: yesNo(true) });
          if (lookup) {
            const r = await s.services.discoverGscProperties(cfg);
            if (r.ok) {
              const readable = r.properties.filter((p) => p.canReadData);
              if (r.properties.length) {
                s.print('Accessible Search Console properties:');
                readable.forEach((p, i) => s.print(`  ${i + 1}) ${p.siteUrl}  [${p.permissionLevel}]`));
                for (const p of r.properties.filter((x) => !x.canReadData)) s.print(`     ${p.siteUrl}  [${p.permissionLevel}; cannot read data]`);
              }
              if (readable.length) {
                const v = await s.ask<string | null>(this.id, key, {
                  question: 'Choose a property by number (blank = decide later): ',
                  parse: (raw): Parsed<string | null> => {
                    const t = raw.trim();
                    if (!t) return ok(null);
                    if (/^\d+$/.test(t)) {
                      const p = readable[Number(t) - 1];
                      return p ? ok(p.siteUrl) : bad(`Choose a number between 1 and ${readable.length}.`);
                    }
                    const exact = readable.find((p) => p.siteUrl === t);
                    return exact ? ok(exact.siteUrl) : bad('Choose one of the listed properties; the property must match an accessible one exactly.');
                  },
                });
                s.set(key, v);
                return;
              }
              s.print('No readable Search Console property is accessible to this identity. Grant it Restricted or Full access in Search Console, then run `setup --update`.');
            } else {
              s.print(`Property lookup failed: ${r.reason}${r.nextStep ? `\n  Next step: ${r.nextStep}` : ''}`);
            }
          }
        } else if (s.offline) {
          s.print('Offline: accessible Search Console properties are not looked up now; `npm run cli -- auth status` lists them later.');
        } else {
          s.print(`Property discovery is not available yet (${avail.detail}). After \`npm run cli -- auth google\`, \`npm run cli -- auth status\` lists the exact properties, and \`setup --update\` can pick one.`);
        }
      }
      const v = await s.ask(this.id, key, {
        question: 'Exact Search Console property, e.g. "sc-domain:example.com" or "https://www.example.com/" (blank = set later): ',
        help: 'Copy the property exactly as Search Console shows it. It is never constructed or guessed from the site URL.',
        parse: gscPropertyFormat,
      });
      s.set(key, v);
    },
  },
  simpleStep({
    id: 'google.ga4PropertyId',
    section: 'Google access',
    question: 'Numeric GA4 property ID (GA4 Admin > Property details; blank = set later): ',
    parse: ga4PropertyId,
    applies: (s) => notDemo(s) && feature(s, 'ga4'),
  }),
];

type EventDef = { name: string; meaning: string; kind: string; value: { amount: string; currency: string } | null; verifiedAt: string | null; verificationNote: string | null };

/** Configured events already present (existing config in update mode, or an earlier answer in this draft). */
function currentEvents(s: WizardSession, path: string): Array<Record<string, unknown> & { name: string }> {
  const v = getAt(s.values(), path);
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is Record<string, unknown> & { name: string } => isPlainObject(e) && typeof e.name === 'string' && e.name.trim() !== '');
}

/** Today's date in the business (or scheduler) time zone: verification dates cannot be in the future. */
function todayFor(s: WizardSession): string {
  const v = s.values();
  const tz = (getAt(v, 'reporting.businessTimezone') as string | null | undefined) || (getAt(v, 'scheduler.timezone') as string | undefined) || schemaDefaults().scheduler.timezone;
  try {
    return dateInZone(s.clock.now(), tz);
  } catch {
    return dateInZone(s.clock.now(), schemaDefaults().scheduler.timezone);
  }
}

/**
 * Owner verification of one primary event (spec section 12): the date the
 * owner confirmed the event fires for its business outcome (e.g. a safe test
 * submission seen in GA4 DebugView) and how. Never inferred: blank keeps the
 * current record (or "not verified").
 */
async function askVerification(s: WizardSession, stepId: string, keyBase: string, name: string, current: { verifiedAt: string | null; verificationNote: string | null }): Promise<{ verifiedAt: string | null; verificationNote: string | null }> {
  const today = todayFor(s);
  const verifiedAt = await s.ask<string | null>(stepId, `${keyBase}.verifiedAt`, {
    question: `  Date you verified that "${name}" fires for this outcome (YYYY-MM-DD; blank = ${current.verifiedAt ? `keep ${current.verifiedAt}` : 'not verified yet'}): `,
    parse: (raw) => {
      if (!raw.trim()) return ok(current.verifiedAt);
      const r = isoDate({ optional: false })(raw);
      if (!r.ok) return r;
      return r.value! > today ? bad(`A verification date cannot be in the future (today is ${today}).`) : r;
    },
  });
  if (verifiedAt === null) return { verifiedAt: null, verificationNote: null };
  // A newly entered date needs a note; a kept date keeps its note (or its missing note).
  const kept = verifiedAt === current.verifiedAt;
  const verificationNote = await s.ask<string | null>(stepId, `${keyBase}.verificationNote`, {
    question: `  How was it verified? (e.g. "test submission seen in GA4 DebugView")${kept ? ` [${current.verificationNote ?? 'blank = keep: not recorded'}]` : ''}: `,
    parse: (raw) => (!raw.trim() && kept ? ok(current.verificationNote) : requiredText(500)(raw)),
  });
  return { verifiedAt, verificationNote };
}

function eventsStep(id: 'conversions.primaryEvents' | 'conversions.secondaryEvents', label: string): WizardStep {
  const primary = id === 'conversions.primaryEvents';
  return {
    id,
    section: 'Conversions',
    paths: [id],
    async run(s) {
      s.print(
        primary
          ? 'Primary conversion events: the GA4 events that are real business outcomes (purchase, qualified lead, signup, booking, ...). Names are exact and case-sensitive. A value per conversion is optional: unknown stays unknown.'
          : 'Secondary events are reported separately and never mixed into primary conversions.',
      );
      const currency = (getAt(s.values(), 'reporting.currency') as string | null | undefined) ?? undefined;
      const out: EventDef[] = [];
      // Configured events (update mode / re-asked step): keep them unchanged unless the owner removes one;
      // primary events also get their owner verification recorded (never inferred).
      const existing = currentEvents(s, id);
      if (existing.length) {
        s.print(
          [
            `Configured ${label.toLowerCase()} events:`,
            ...existing.map((e) => `  - ${e.name}${typeof e.meaning === 'string' ? ` (${e.meaning})` : ''}${primary ? `: ${typeof e.verifiedAt === 'string' ? `verified ${e.verifiedAt}` : 'not verified yet'}` : ''}`),
          ].join('\n'),
        );
        for (const [i, e] of existing.entries()) {
          const k = `${id}.current[${i}]`;
          const keep = await s.ask<boolean>(id, `${k}.keep`, { question: `Keep "${e.name}"? [Y/n]: `, parse: yesNo(true) });
          if (!keep) continue;
          // A kept event stays exactly as configured (no diff) unless its verification changes.
          const kept = { ...e } as unknown as EventDef;
          if (primary) {
            const cur = {
              verifiedAt: typeof e.verifiedAt === 'string' ? e.verifiedAt : null,
              verificationNote: typeof e.verificationNote === 'string' ? e.verificationNote : null,
            };
            const v = await askVerification(s, id, k, e.name, cur);
            if (v.verifiedAt !== cur.verifiedAt || v.verificationNote !== cur.verificationNote) Object.assign(kept, v);
          }
          out.push(kept);
        }
      }
      for (let i = 0; i < 50; i++) {
        const k = `${id}[${i}]`;
        const first = i === 0 && !out.length;
        const name = await s.ask<string | null>(id, `${k}.name`, {
          question: first ? `${label} event name (blank for none): ` : `${out.length ? 'Additional' : 'Next'} ${label.toLowerCase()} event name (blank to finish): `,
          parse: (raw) => {
            const r = optional(ga4EventName)(raw);
            return r.ok && r.value !== null && out.some((e) => e.name === r.value) ? bad(`"${r.value}" is already listed.`) : r;
          },
        });
        if (name === null) break;
        const meaning = await s.ask<string>(id, `${k}.meaning`, { question: '  What it means for the business (e.g. "Demo request form submitted"): ', parse: requiredText(500) });
        const kind = await s.ask<string>(id, `${k}.kind`, {
          question: '  Outcome type (1 purchase, 2 lead, 3 signup, 4 booking, 5 subscription, 6 other) [6]: ',
          parse: choice(['purchase', 'lead', 'signup', 'booking', 'subscription', 'other'] as const, 'other'),
        });
        const amount = await s.ask<string | null>(id, `${k}.valueAmount`, { question: '  Configured value per conversion, e.g. 120.00 (blank = unknown): ', parse: decimal({ optional: true }) });
        let value: { amount: string; currency: string } | null = null;
        if (amount !== null) {
          const cur = await s.ask<string | null>(id, `${k}.valueCurrency`, {
            question: '  Currency of that value (ISO 4217): ',
            parse: (raw) => {
              const r = currencyCode(raw);
              return r.ok && r.value === null ? bad('A currency is required when a value is given.') : r;
            },
            ...(currency ? { default: currency } : {}),
          });
          value = { amount, currency: cur! };
        }
        const verification = primary ? await askVerification(s, id, k, name, { verifiedAt: null, verificationNote: null }) : { verifiedAt: null, verificationNote: null };
        out.push({ name, meaning, kind, value, ...verification });
      }
      s.set(id, out);
    },
  };
}

const scopeSteps: WizardStep[] = [
  eventsStep('conversions.primaryEvents', 'Primary'),
  eventsStep('conversions.secondaryEvents', 'Secondary'),
  {
    id: 'brand.aliases',
    section: 'Brand and scope',
    paths: ['brand.aliases'],
    async run(s) {
      const name = getAt(s.values(), 'site.businessName') as string | undefined;
      const v = await s.ask(this.id, this.id, {
        question: 'Brand spellings for branded-query classification, comma-separated: ',
        parse: commaList(requiredText(100)),
        ...(name ? { default: name } : {}),
      });
      s.set(this.id, v);
    },
  },
  simpleStep({
    id: 'crawl.protectedPaths',
    section: 'Brand and scope',
    question: 'Protected pages (never proposed for deletion/redirect/noindex without review), comma-separated paths like /pricing (blank for none): ',
    parse: commaList(sitePath),
  }),
  simpleStep({ id: 'crawl.excludedPaths', section: 'Brand and scope', question: 'Paths the crawler must skip, comma-separated (e.g. /admin/*; blank for none): ', parse: commaList(sitePath) }),
  simpleStep({ id: 'research.approvedDomains', section: 'Brand and scope', question: 'Domains approved for research crawling beyond SERP competitors, comma-separated (blank for none): ', parse: commaList(hostname) }),
  {
    id: 'crawl.limits',
    section: 'Brand and scope',
    paths: ['crawl.maxPages', 'crawl.maxDepth', 'crawl.requestDelayMs'],
    isMissing: (s) => getAt(s.values(), 'crawl.maxPages') === undefined,
    async run(s) {
      const d = schemaDefaults().crawl;
      s.print(`Crawl limits (own site): max ${d.maxPages} pages, depth ${d.maxDepth}, ${d.requestDelayMs} ms between requests to the same host. robots.txt is always respected.`);
      const keep = await s.ask(this.id, 'crawl.limits.keep', { question: 'Keep these crawl limits? [Y/n]: ', parse: yesNo(true) });
      if (keep) {
        s.set('crawl.maxPages', d.maxPages);
        s.set('crawl.maxDepth', d.maxDepth);
        s.set('crawl.requestDelayMs', d.requestDelayMs);
        return;
      }
      s.set('crawl.maxPages', await s.ask(this.id, 'crawl.maxPages', { question: 'Maximum pages per crawl: ', parse: integer({ min: 1, max: 10_000 }), default: String(d.maxPages) }));
      s.set('crawl.maxDepth', await s.ask(this.id, 'crawl.maxDepth', { question: 'Maximum link depth: ', parse: integer({ min: 0, max: 20 }), default: String(d.maxDepth) }));
      s.set('crawl.requestDelayMs', await s.ask(this.id, 'crawl.requestDelayMs', { question: 'Delay between requests to the same host (ms): ', parse: integer({ min: 0, max: 60_000 }), default: String(d.requestDelayMs) }));
    },
  },
];

const researchSteps: WizardStep[] = [
  {
    id: 'research.competitors',
    section: 'Research',
    paths: ['research.competitors'],
    async run(s) {
      const out: Array<{ domain: string; name: string | null }> = [];
      for (let i = 0; i < 100; i++) {
        const domain = await s.ask<string | null>(this.id, `research.competitors[${i}].domain`, { question: i === 0 ? 'Known competitor domain (blank for none): ' : 'Next competitor domain (blank to finish): ', parse: optional(hostname) });
        if (domain === null) break;
        const name = await s.ask<string | null>(this.id, `research.competitors[${i}].name`, { question: '  Display name (optional): ', parse: optionalText(200) });
        out.push({ domain, name });
      }
      s.set(this.id, out);
    },
  },
  {
    id: 'research.seedTopics',
    section: 'Research',
    paths: ['research.seedTopics'],
    async run(s) {
      s.set(this.id, await collectLines(s, this.id, this.id, 'Seed topic for content discovery (one per line; blank for none): ', requiredText(300)));
    },
  },
  simpleStep({ id: 'research.subreddits', section: 'Research', question: 'Optional relevant subreddits, comma-separated (e.g. r/analytics; blank for none): ', parse: commaList(subreddit) }),
  simpleStep({
    id: 'research.dataforseo.mode',
    section: 'Research',
    question: 'DataForSEO mode (1 disabled, 2 sandbox, 3 live) [2]: ',
    help: 'sandbox returns free synthetic data (never used in recommendations); live requests are paid and need credentials plus budget. Start with the sandbox.',
    parse: choice(['disabled', 'sandbox', 'live'] as const, 'sandbox'),
    applies: (s) => notDemo(s) && feature(s, 'dataforseo'),
  }),
];

const editorialSteps: WizardStep[] = [
  simpleStep({ id: 'editorial.brandVoice', section: 'Editorial', question: 'Brand voice for drafts: ', parse: requiredText(1000), default: () => schemaDefaults().editorial.brandVoice }),
  {
    id: 'business.prohibitedClaims',
    section: 'Editorial',
    paths: ['business.prohibitedClaims'],
    async run(s) {
      s.set(this.id, await collectLines(s, this.id, this.id, 'Claim that must never appear (one per line; blank for none): '));
    },
  },
  {
    id: 'editorial.rules',
    section: 'Editorial',
    paths: ['editorial.avoidEmojis', 'editorial.avoidEmDashes', 'editorial.requirements'],
    isMissing: (s) => getAt(s.values(), 'editorial.avoidEmojis') === undefined || getAt(s.values(), 'editorial.avoidEmDashes') === undefined,
    async run(s) {
      const keep = await s.ask(this.id, 'editorial.defaults', { question: 'Use the default editorial rules: clear language, no emojis, no em dashes? [Y/n]: ', parse: yesNo(true) });
      if (keep) {
        s.set('editorial.avoidEmojis', true);
        s.set('editorial.avoidEmDashes', true);
      } else {
        s.set('editorial.avoidEmojis', await s.ask(this.id, 'editorial.avoidEmojis', { question: '  Avoid emojis in drafts? [Y/n]: ', parse: yesNo(true) }));
        s.set('editorial.avoidEmDashes', await s.ask(this.id, 'editorial.avoidEmDashes', { question: '  Avoid em dashes in drafts? [Y/n]: ', parse: yesNo(true) }));
      }
      if (!hasValue(getAt(s.values(), 'editorial.requirements'))) {
        s.set('editorial.requirements', await collectLines(s, this.id, 'editorial.requirements', 'Additional editorial requirement (one per line; blank for none): '));
      }
    },
  },
];

const featuresStep: WizardStep = {
  id: 'features',
  section: 'Features',
  paths: ['features'],
  applies: notDemo,
  isMissing: (s) => !isPlainObject(getAt(s.values(), 'features')),
  async run(s) {
    const profile = profileOf(s);
    const defaults = PROFILE_DEFAULTS[profile];
    s.print(`Feature flags for the ${profile} profile (enabled flags still need credentials; without them the integration reports "missing credentials"):`);
    for (const k of FEATURE_KEYS) s.print(`  ${defaults[k] ? '[on] ' : '[off]'} ${k}: ${FEATURE_DESCRIPTIONS[k]}`);
    const keep = await s.ask(this.id, 'features.keep', { question: 'Keep the profile defaults? [Y/n]: ', parse: yesNo(true) });
    const flags: Partial<Record<FeatureKey, boolean>> = {};
    if (!keep) {
      for (const k of FEATURE_KEYS) {
        const paid = k === 'aiCitations' || (k.startsWith('dataforseo') && k !== 'dataforseo');
        const v = await s.ask(this.id, `features.${k}`, { question: `  ${k}${paid ? ' (paid add-on; each request still needs approval)' : ''} [${defaults[k] ? 'Y/n' : 'y/N'}]: `, parse: yesNo(defaults[k]) });
        if (v !== defaults[k]) flags[k] = v;
      }
    }
    s.set('features', flags);
  },
};

const credentialsStep: WizardStep = {
  id: 'credentials',
  section: 'Credentials',
  paths: [],
  applies: notDemo,
  isMissing: (s) => secretNeeds(s.values()).some((n) => !s.secrets.has(n.key)),
  async run(s) {
    const needs = secretNeeds(s.values()).filter((n) => !s.secrets.has(n.key));
    s.print(
      [
        'Credentials are stored separately from the site configuration: in the environment (for example injected by a password manager) or in',
        `${s.paths.secretsEnvFile} (mode 0600). Secrets are never echoed, never written to the site config or the vault, and never requested in chat.`,
      ].join('\n'),
    );
    for (const need of needs) {
      if (s.secrets.has(need.key)) continue;
      s.print(`\n${need.label} (${need.key})${need.optional ? ' [optional]' : ''}${need.paid ? ' [paid service]' : ''}: ${need.why}\n  How to get it: ${need.howToGet}`);
      const how = await s.ask(this.id, `secret.${need.key}`, {
        question: `  How will you provide ${need.key}? 1) enter it now (hidden input, saved to secrets.env) 2) I will inject it through the environment 3) skip for now [3]: `,
        parse: choice(['now', 'env', 'skip'] as const, 'skip'),
      });
      if (how === 'now') {
        let stored = false;
        for (let attempt = 0; attempt < 3 && !stored; attempt++) {
          const value = await s.askSecret(`secret.${need.key}.value`, `  ${need.key} (input hidden; blank to skip): `);
          if (!value) break;
          const problem = validateSecretValue(value);
          if (problem) {
            s.print(`  Not stored: ${problem}`);
            continue;
          }
          s.secrets.set(need.key, value);
          s.storedSecrets.push(need.key);
          stored = true;
          s.print(`  Saved ${need.key} to ${s.paths.secretsEnvFile} (mode 0600). The value was not displayed.`);
        }
        if (!stored) s.deferredSecrets.set(need.key, 'skipped');
      } else if (how === 'env') {
        s.deferredSecrets.set(need.key, 'env');
        s.print(`  Set ${need.key} in the environment when running commands, e.g. with a password manager: op run --env-file=<your .env template> -- npm run cli -- doctor`);
      } else {
        s.deferredSecrets.set(need.key, 'skipped');
      }
    }
  },
};

function modelKind(tier: 'cheap' | 'reasoning' | 'embedding'): 'chat' | 'embedding' {
  return tier === 'embedding' ? 'embedding' : 'chat';
}

const MODEL_ENV = { cheap: 'CHEAP_MODEL', reasoning: 'REASONING_MODEL', embedding: 'EMBEDDING_MODEL' } as const;

function modelTiers(s: WizardSession): Array<'cheap' | 'reasoning' | 'embedding'> {
  const f = featuresOf(s.values());
  return [...(f.llm ? (['cheap', 'reasoning'] as const) : []), ...(f.embeddings ? (['embedding'] as const) : [])];
}

const modelsStep: WizardStep = {
  id: 'models',
  section: 'Models',
  paths: ['models.cheap', 'models.reasoning', 'models.embedding'],
  applies: (s) => notDemo(s) && modelTiers(s).length > 0,
  isMissing: (s) => modelTiers(s).some((t) => !s.secrets.get(MODEL_ENV[t]) && !hasValue(getAt(s.values(), `models.${t}`))),
  async run(s) {
    s.print('Model ids are never hardcoded or guessed. CHEAP_MODEL / REASONING_MODEL / EMBEDDING_MODEL in the environment override these values.');
    let catalog: ModelChoice[] | null = null;
    const cfg = s.candidateConfig();
    if (s.services.listModels && cfg && !s.offline && s.secrets.has('LLM_GATEWAY_API_KEY')) {
      const verify = await s.ask(this.id, 'models.verify', { question: 'Fetch the LLM Gateway model list to verify the ids? (one free GET /v1/models request) [Y/n]: ', parse: yesNo(true) });
      if (verify) {
        const r = await s.services.listModels(cfg);
        if (r.ok) {
          catalog = r.models;
          s.print(`Model catalog: ${r.models.length} models (${r.authenticated ? 'filtered for your key' : 'public list'}, retrieved ${r.retrievedAt}).`);
        } else s.print(`Model list unavailable: ${r.reason}. Ids entered now stay unverified; run \`npm run cli -- models check\` later.`);
      }
    } else if (!s.secrets.has('LLM_GATEWAY_API_KEY')) {
      s.print('Without LLM_GATEWAY_API_KEY the ids cannot be verified now; leave them blank or verify later with `npm run cli -- models check`.');
    } else if (s.offline) {
      s.print('Offline: model ids are not verified now; run `npm run cli -- models check` (free) later.');
    }
    for (const tier of modelTiers(s)) {
      const env = MODEL_ENV[tier];
      if (s.secrets.get(env)) {
        s.print(`  ${tier}: set by ${env} in the environment.`);
        continue;
      }
      if (hasValue(getAt(s.base, `models.${tier}`)) && !s.only?.has(this.id)) continue;
      const kind = modelKind(tier);
      if (catalog) {
        const sample = catalog
          .filter((m) => m.kind === kind)
          .sort((a, b) => Number(b.priced) - Number(a.priced) || a.id.localeCompare(b.id))
          .slice(0, 12);
        if (sample.length) s.print(`  Some ${kind} models in the catalog: ${sample.map((m) => m.id).join(', ')}${sample.length === 12 ? ', ...' : ''}`);
      }
      const v = await s.ask<string | null>(this.id, `models.${tier}`, {
        question: `${tier === 'cheap' ? 'Cheap (extraction/classification)' : tier === 'reasoning' ? 'Reasoning (synthesis/prioritization)' : 'Embedding'} model id (blank = leave unset): `,
        parse: (raw) => {
          const r = modelId(raw);
          if (!r.ok || r.value === null || !catalog) return r;
          const m = catalog.find((x) => x.id === r.value);
          if (!m) return bad(`"${r.value}" is not in the gateway model list for this key. Copy an id exactly from \`npm run cli -- models list\`.`);
          if (m.kind !== kind) return bad(`"${r.value}" is a ${m.kind} model; the ${tier} tier needs a ${kind} model.`);
          return r;
        },
      });
      if (v && catalog && !catalog.find((m) => m.id === v)?.priced) {
        s.print(`  Note: no verified price is known for ${v}; its calls are skipped (BUDGET_UNKNOWN_PRICE) until llm.pricingOverrides holds a verified price.`);
      }
      s.set(`models.${tier}`, v);
    }
  },
};

type BudgetField = { path: string; label: string };

function budgetFields(s: WizardSession): BudgetField[] {
  const f = featuresOf(s.values());
  const out: BudgetField[] = [];
  if (f.llm || f.embeddings) out.push({ path: 'llmGateway.monthlyUsd', label: 'LLM Gateway per month (incl. embeddings)' }, { path: 'llmGateway.perRunUsd', label: 'LLM Gateway per run' });
  if (f.dataforseo) out.push({ path: 'dataforseo.weeklyUsd', label: 'DataForSEO per week' }, { path: 'dataforseo.monthlyUsd', label: 'DataForSEO per month' }, { path: 'dataforseo.perRunUsd', label: 'DataForSEO per run' });
  if (f.apify) out.push({ path: 'apify.monthlyUsd', label: 'Apify per month' }, { path: 'apify.perRunUsd', label: 'Apify per run' });
  out.push({ path: 'combinedMonthlyUsd', label: 'Combined variable API ceiling per month' });
  return out;
}

const budgetsStep: WizardStep = {
  id: 'budgets',
  section: 'Budgets',
  paths: ['budgets'],
  applies: notDemo,
  isMissing: (s) => !isPlainObject(getAt(s.values(), 'budgets')),
  async run(s) {
    const d = schemaDefaults().budgets as unknown as Record<string, unknown>;
    const fields = budgetFields(s);
    s.print(
      [
        'Budget ceilings in USD. These are spending CEILINGS you configure, not price quotes or promises that every workload fits.',
        'Subscriptions, funding minimums, taxes, and infrastructure are separate. Nothing is topped up or raised automatically.',
        ...fields.map((f) => `  ${f.label}: $${String(getAt(d, f.path))}`),
      ].join('\n'),
    );
    const keep = await s.ask(this.id, 'budgets.keep', { question: 'Keep these ceilings? [Y/n]: ', parse: yesNo(true) });
    for (const f of fields) {
      const def = String(getAt(d, f.path));
      const v = keep ? def : await s.ask<string | null>(this.id, `budgets.${f.path}`, { question: `  ${f.label} (USD): `, parse: decimal(), default: def });
      s.set(`budgets.${f.path}`, v);
    }
  },
};

function scheduleStep(job: 'weekly' | 'monthly'): WizardStep {
  return {
    id: `scheduler.${job}`,
    section: 'Scheduling',
    paths: [`scheduler.${job}`],
    applies: notDemo,
    isMissing: (s) => !isPlainObject(getAt(s.values(), `scheduler.${job}`)),
    async run(s) {
      if (job === 'weekly') {
        s.print('Scheduling is opt-in. This only records your preference; enable it with `npm run cli -- schedule enable <weekly|monthly>` after a successful manual run. A sleeping or offline machine cannot run jobs.');
      }
      const d = schemaDefaults().scheduler[job];
      const enabled = await s.ask(this.id, `scheduler.${job}.enabled`, { question: `Prefer scheduled ${job} runs? [y/N]: `, parse: yesNo(false) });
      let cron = d.cron;
      if (enabled) {
        const tz = (getAt(s.values(), 'scheduler.timezone') as string | undefined) ?? schemaDefaults().scheduler.timezone;
        cron = await s.ask<string>(this.id, `scheduler.${job}.cron`, {
          question: `  Cron expression in ${tz}: `,
          default: d.cron,
          parse: (raw) => {
            const r = cronExpression(raw);
            if (!r.ok) return r;
            try {
              parseCron(r.value, tz);
              return r;
            } catch (err) {
              return bad(`Invalid cron expression: ${errorMessage(err)}`);
            }
          },
        });
      }
      s.set(`scheduler.${job}`, { enabled, cron });
    },
  };
}

/** All steps in the order they are asked. The wizard asks the site id before these (the draft is named after it); the profile comes first. */
export function wizardSteps(): WizardStep[] {
  return [
    profileStep,
    ...identitySteps,
    ...businessSteps,
    ...marketSteps,
    ...reportingSteps,
    ...googleSteps,
    ...scopeSteps,
    ...researchSteps,
    ...editorialSteps,
    featuresStep,
    credentialsStep,
    modelsStep,
    budgetsStep,
    scheduleStep('weekly'),
    scheduleStep('monthly'),
  ];
}

/**
 * Step groups for `setup --only`: every dotted prefix of a step id that is not
 * itself a step id (e.g. "conversions" = conversions.primaryEvents +
 * conversions.secondaryEvents, "google" = google.auth +
 * google.searchConsoleProperty + google.ga4PropertyId). Derived from the step
 * list, so a new step joins its group automatically.
 */
export function wizardStepGroups(steps: WizardStep[] = wizardSteps()): Array<{ group: string; stepIds: string[] }> {
  const ids = steps.map((s) => s.id);
  const known = new Set(ids);
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const parts = id.split('.');
    for (let n = 1; n < parts.length; n++) {
      const prefix = parts.slice(0, n).join('.');
      if (known.has(prefix)) continue;
      const members = groups.get(prefix) ?? [];
      members.push(id);
      groups.set(prefix, members);
    }
  }
  return [...groups].map(([group, stepIds]) => ({ group, stepIds }));
}

/**
 * Resolve `--only` selectors to step ids, in wizard order. A selector is an
 * exact step id or a group (a dotted prefix such as "conversions" or
 * "reporting"; a trailing ".*" or "." is accepted). Selectors that match
 * nothing are returned in `unknown` (never silently ignored).
 */
export function resolveStepSelectors(selectors: readonly string[], steps: WizardStep[] = wizardSteps()): { stepIds: string[]; unknown: string[] } {
  const ids = steps.map((s) => s.id);
  const known = new Set(ids);
  const selected = new Set<string>();
  const unknown: string[] = [];
  for (const raw of selectors) {
    const sel = raw.trim().replace(/\.\*$/, '').replace(/\.$/, '');
    if (!sel) continue;
    if (known.has(sel)) {
      selected.add(sel);
      continue;
    }
    const members = ids.filter((id) => id.startsWith(`${sel}.`));
    if (members.length) members.forEach((id) => selected.add(id));
    else unknown.push(raw.trim());
  }
  return { stepIds: ids.filter((id) => selected.has(id)), unknown };
}

export function stepIsMissing(step: WizardStep, s: WizardSession): boolean {
  if (step.isMissing) return step.isMissing(s);
  const v = s.values();
  return step.paths.every((p) => !hasValue(getAt(v, p)));
}

/** Steps whose paths cover a config validation error path such as "site.url" or "budgets.llmGateway". */
export function stepsForErrorPath(errorPath: string, steps: WizardStep[] = wizardSteps()): WizardStep[] {
  const p = errorPath.replace(/\[\d+\]/g, '').replace(/\.\d+(?=\.|$)/g, '');
  return steps.filter((st) => st.paths.some((sp) => p === sp || p.startsWith(`${sp}.`) || sp.startsWith(`${p}.`)));
}
