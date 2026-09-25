import type { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appRoot, siteVaultDir } from '../../../src/config/paths.js';
import { MARK_OFFER_PAGE, readinessChecks } from '../../../src/content/bootstrap.js';
import { isAppError } from '../../../src/core/errors.js';
import { applyBusinessProfile, importBusinessNotes } from '../../../src/obsidian/business-sync.js';
import { reconcileNextStep } from '../../../src/integrations/llm/http.js';
import { REBUILD_STEPS } from '../../../src/setup/build-info.js';
import { PAID_TESTS_NOTE } from '../../../src/setup/doctor.js';
import { resolveStepSelectors } from '../../../src/setup/steps.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { contentConfig, seedPages } from '../../fixtures/content/seed.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { rateScaleUnverifiedReason } from '../../../src/seo/metrics.js';
import { GA4_PROPERTY, PRIMARY_EVENT, WEEK, reportsTestConfig, seedWeeklyScenario } from '../../fixtures/reports/seed.js';

/**
 * Owner-facing hints name exact commands. This test parses every
 * `npm run cli -- ...` command in those hints and checks it against the real
 * CLI program: the command path exists, every --flag is defined on it (or a
 * parent/global option), and every `setup --only` selector resolves to wizard
 * steps. A renamed command or option makes these hints fail here instead of
 * misleading the owner.
 */

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

async function program(): Promise<Command> {
  const runtime = new CliRuntime({ out: () => undefined, err: () => undefined }, { HOME: '/nonexistent-home.invalid' });
  return buildProgram(runtime);
}

/** Every `npm run cli -- ...` command in a text (up to the closing backtick, a paren, or the end of the sentence). */
function commandsIn(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(/npm run cli -- ([^`()]+?)(?=`|\)|\.\s|\.$|;|$)/g)) {
    const tokens = (m[1] ?? '').trim().match(/"[^"]*"|<[^>]*>|\S+/g) ?? [];
    out.push(tokens);
  }
  return out;
}

function problems(root: Command, tokens: string[]): string[] {
  const errs: string[] = [];
  let cmd = root;
  const chain: Command[] = [root];
  let i = 0;
  // Leading global options (e.g. --workspace <dir>) are allowed before the command.
  while (i < tokens.length && tokens[i]!.startsWith('-')) i += 2;
  for (; i < tokens.length; i++) {
    const sub = cmd.commands.find((c) => c.name() === tokens[i]);
    if (!sub) break;
    cmd = sub;
    chain.push(sub);
  }
  if (cmd === root) return [`unknown command "${tokens.join(' ')}"`];
  const known = new Set(chain.flatMap((c) => c.options.flatMap((o) => [o.long, o.short, o.long?.replace(/^--no-/, '--')]).filter(Boolean) as string[]));
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (/^--[a-z]/.test(t) && !known.has(t)) errs.push(`"${chain.slice(1).map((c) => c.name()).join(' ')}" has no option ${t}`);
    if (t === '--only' && chain[1]?.name() === 'setup') {
      const sel = (tokens[j + 1] ?? '').split(',');
      const r = resolveStepSelectors(sel);
      if (r.unknown.length || !r.stepIds.length) errs.push(`setup --only ${tokens[j + 1]}: unknown step(s) ${r.unknown.join(', ')}`);
    }
  }
  return errs;
}

async function expectValidHints(texts: Array<string | null | undefined>): Promise<number> {
  const root = await program();
  let n = 0;
  for (const text of texts) {
    if (!text) continue;
    for (const tokens of commandsIn(text)) {
      n++;
      expect(problems(root, tokens), `${tokens.join(' ')}\n  in: ${text}`).toEqual([]);
    }
  }
  return n;
}

describe('owner hints name real commands and options', () => {
  it('the checker itself rejects stale commands, options, and setup steps', async () => {
    const root = await program();
    expect(problems(root, ['apify', 'test', '--no-such-flag'])).toEqual(['"apify test" has no option --no-such-flag']);
    expect(problems(root, ['costs', '--unresolved'])).toEqual([]);
    expect(problems(root, ['setup', '--update', '--only', 'conv'])[0]).toContain('unknown step');
    expect(problems(root, ['setup', '--update', '--only', 'conversions'])).toEqual([]);
    expect(problems(root, ['nosuchcommand'])[0]).toContain('unknown command');
  });

  it('doctor: the paid-test note (apify test/research need --mode RESEARCH, --confirm-spend, --max-usd)', async () => {
    expect(await expectValidHints([PAID_TESTS_NOTE])).toBe(3);
    expect(PAID_TESTS_NOTE).toContain('npm run cli -- apify test --mode RESEARCH --confirm-spend --max-usd <cap>');
  });

  it('build freshness: the rebuild steps name `schedule instructions`', async () => {
    expect(await expectValidHints([REBUILD_STEPS])).toBe(1);
  });

  it('vault init: the business-note sequence is preview, import-business --apply, apply-business, then --confirm', async () => {
    ctx = createTestContext();
    const out: string[] = [];
    const runtime = new CliRuntime({ out: (t) => void out.push(t), err: () => undefined }, { HOME: ctx.paths.root, SEO_AGENT_WORKSPACE: ctx.paths.root });
    const root = await buildProgram(runtime);
    root.exitOverride();
    await root.parseAsync(['node', 'seo-agent', '--dry-run', 'vault', 'init']);
    const text = out.join('\n');
    const order = ['vault import-business  ', 'vault import-business --apply', 'vault apply-business  ', 'vault apply-business --confirm <diff-hash>', 'vault render'].map((c) => text.indexOf(c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(await expectValidHints(text.split('\n'))).toBe(5);
  });

  it('business notes: preview -> import-business --apply -> apply-business --confirm (FIRST_MONTH week 1)', async () => {
    ctx = createTestContext();
    const dir = path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business');
    mkdirSync(dir, { recursive: true });
    const note = readFileSync(path.join(appRoot(), 'tests', 'fixtures', 'obsidian', 'business', 'profile.valid.md'), 'utf8');
    writeFileSync(path.join(dir, 'Business Profile.md'), note);
    const preview = importBusinessNotes(ctx, { apply: false });
    expect(preview.nextStep).toContain('npm run cli -- vault import-business --apply');
    let hint: string | undefined;
    try {
      applyBusinessProfile(ctx);
    } catch (err) {
      hint = isAppError(err) ? err.hint : undefined;
    }
    // apply-business refuses an unrecorded note and names the missing step.
    expect(hint).toContain('npm run cli -- vault import-business --apply');
    const recorded = importBusinessNotes(ctx, { apply: true });
    expect(recorded.nextStep).toContain('npm run cli -- vault apply-business');
    const shown = applyBusinessProfile(ctx);
    expect(shown.nextStep).toContain(`npm run cli -- vault apply-business --confirm ${shown.diffHash}`);
    expect(await expectValidHints([preview.nextStep, hint, recorded.nextStep, shown.nextStep])).toBeGreaterThanOrEqual(4);
  });

  it('LLM gateway: unknown charges point to the costs reconcile command', async () => {
    expect(await expectValidHints([reconcileNextStep('res_synthetic'), reconcileNextStep()])).toBe(3);
  });

  it('content bootstrap: every readiness next step (the offer page is marked with pages set-type)', async () => {
    // A fresh synthetic site with nothing measured, crawled, or configured: every check fails with a next step.
    ctx = createTestContext({ config: contentConfig({ business: { offer: null, targetCustomer: null, productFacts: [] }, conversions: { primaryEvents: [] }, google: { searchConsoleProperty: null, ga4PropertyId: null } }) });
    const checks = readinessChecks(ctx);
    const offer = checks.find((c) => c.id === 'offer_page')!;
    expect(offer.status).toBe('unknown');
    expect(offer.nextStep).toContain('npm run cli -- pages set-type <url> offer');
    expect(MARK_OFFER_PAGE).toBe('npm run cli -- pages set-type <url> offer');
    expect(checks.find((c) => c.id === 'primary_conversion')!.nextStep).toContain(`npm run cli -- setup --update --site ${ctx.siteId} --only conversions`);
    const steps = checks.map((c) => c.nextStep).filter((s): s is string => !!s);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(await expectValidHints(steps)).toBeGreaterThanOrEqual(10);
  });

  it('content bootstrap: a site root used as the offer candidate says how to mark the real offer page', () => {
    ctx = createTestContext({ config: contentConfig() });
    seedPages(ctx, [{ path: '/', pageType: 'article', title: 'Home', text: 'Synthetic home page.' }]);
    const offer = readinessChecks(ctx).find((c) => c.id === 'offer_page')!;
    expect(offer).toMatchObject({ status: 'pass', detail: expect.stringContaining('site root; no page typed as offer') });
    expect(offer.nextStep).toContain(MARK_OFFER_PAGE);
    ctx.cleanup();
    ctx = createTestContext({ config: contentConfig() });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Home', text: 'Synthetic offer page.' }]);
    expect(readinessChecks(ctx).find((c) => c.id === 'offer_page')!.nextStep).toBeNull();
  });
});

/** Sample values for the placeholders of a printed command (the owner types their own). */
const PLACEHOLDER_SAMPLES: Record<string, string> = {
  '<what you compared>': 'GA4 UI shows 20.00% for /pricing on 2026-09-14; stored 0.2 (synthetic)',
  '<your name>': 'Alice',
};

/** A printed command as the owner would type it: one of "a|b" chosen, placeholders filled, quotes removed (the shell would). */
function asTyped(tokens: string[]): string[] {
  return tokens.map((t) => {
    if (t === 'fraction|percent') return 'fraction';
    const bare = t.replace(/^"(.*)"$/, '$1');
    if (/^<[^>]+>$/.test(bare)) {
      const v = PLACEHOLDER_SAMPLES[bare];
      if (!v) throw new Error(`no sample value for placeholder ${bare}`);
      return v;
    }
    return bare;
  });
}

/** Run one command through the full registered program (every command module, global options, preAction hooks) in the test workspace. */
async function runInWorkspace(c: TestContext, args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { HOME: c.paths.root, SEO_AGENT_WORKSPACE: c.paths.root });
  const root = await buildProgram(runtime);
  root.exitOverride();
  root.configureOutput({ writeErr: (t) => void err.push(t), writeOut: (t) => void out.push(t) });
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await root.parseAsync(['node', 'seo-agent', ...args]);
  } catch (e) {
    err.push(e instanceof Error ? e.message : String(e));
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('the GA4 rate-scale command printed by reports and metrics runs as printed (R3-NF-G7)', () => {
  it('report next action, data-quality next steps, and the RATE_SCALE_UNVERIFIED reason pass the CLI with --dry-run (no VALIDATION_FAILED, nothing recorded)', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'undetermined' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const go = b.report.data.googleOrganic!;
    const texts: Array<string | null | undefined> = [
      b.report.data.nextAction?.command,
      b.report.data.dataQuality!.find((d) => d.code === 'ga4_rate_scale_unverified')?.nextStep,
      go.status === 'observed' && go.value.primarySessionRate.status !== 'observed' ? go.value.primarySessionRate.reason : null,
      rateScaleUnverifiedReason(`sessionKeyEventRate:${PRIMARY_EVENT}`),
    ];
    expect(texts.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
    // Recording an owner assertion adds a data-quality item whose next step names the command too (D3-03).
    confirmRateScale(ctx, GA4_PROPERTY, { scale: 'fraction', evidence: PLACEHOLDER_SAMPLES['<what you compared>']!, actor: 'owner:Alice' });
    const confirmed = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    texts.push(confirmed.report.data.dataQuality!.find((d) => d.code === 'ga4_rate_scale_owner_assertion')?.nextStep);
    const recorded = () => ctx!.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ga4_rate_scale_confirmations WHERE site_id = ?', [ctx!.siteId])!.n;
    expect(recorded()).toBe(1);

    const printed = texts.flatMap((t) => commandsIn(t ?? '')).filter((tokens) => tokens.includes('--confirm-rate-scale'));
    expect(printed).toHaveLength(5);
    expect(await expectValidHints(texts)).toBe(5);
    for (const tokens of printed) {
      const typed = asTyped(tokens);
      expect(typed).toContain('--as');
      const r = await runInWorkspace(ctx, ['--dry-run', '--json', '--site', ctx.siteId, ...typed]);
      const shown = `${typed.join(' ')}\n  out: ${r.out}\n  err: ${r.err}`;
      expect(r.err, shown).not.toMatch(/VALIDATION_FAILED|needs --as|required option|unknown option|error:/i);
      expect(r.exitCode ?? 0, shown).toBe(0);
      expect(JSON.parse(r.out), shown).toMatchObject({ dryRun: true, confirmationId: null, scale: 'fraction', basis: 'owner_assertion' });
    }
    // Dry runs recorded nothing.
    expect(recorded()).toBe(1);

    // The check has teeth: the same command without --as is refused.
    const withoutAs = asTyped(printed[0]!).filter((t, i, all) => t !== '--as' && all[i - 1] !== '--as');
    const refused = await runInWorkspace(ctx, ['--dry-run', '--site', ctx.siteId, ...withoutAs]);
    expect(refused.err).toMatch(/VALIDATION_FAILED/);
    expect(refused.err).toMatch(/needs --as "<your name>"/);
  });
});
