/**
 * Human-decision gates accept only a named human (C4-01): `content
 * mark-reviewed`, `content revise-manual`, and `vault apply-business` refuse
 * the names automation uses (system, claude, scheduler, agent, ...), for
 * every caller of the library functions as well as through the CLI, and
 * record nothing. `vault apply-business` no longer falls back to the
 * anonymous actor "owner": without --by the actor is the operating-system
 * user, validated the same way. SYNTHETIC drafts and business notes on
 * example.test domains only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveApprover, validateApproverName } from '../../../src/approvals/approver.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { siteVaultDir } from '../../../src/config/paths.js';
import { registerContentDepsFactory } from '../../../src/content/deps.js';
import { markHumanReviewed } from '../../../src/content/publication.js';
import { reviseDraftManually } from '../../../src/content/review.js';
import { insertQualityReview } from '../../../src/content/store.js';
import { sha256 } from '../../../src/core/hash.js';
import { experimentsSiteConfig, seedDraft } from '../../fixtures/experiments/seed.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

const AUTOMATION_NAMES = ['system', 'claude', 'scheduler', 'agent'];
const NOW = '2026-09-20T09:00:00.000Z';
const BUSINESS_FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'fixtures', 'obsidian', 'business');

let ctx: TestContext | undefined;
beforeEach(() => registerContentDepsFactory(null));
afterEach(() => {
  registerContentDepsFactory(null);
  ctx?.cleanup();
  ctx = undefined;
});

async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  const runtime = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: ctx!.paths.root, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx!.paths.root, ...args]);
  } catch (e) {
    if (!(e instanceof CliExit) && !(e as { code?: string }).code?.startsWith('commander.')) throw e;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, err, code };
}

/** A seeded draft with an automated review (what mark-reviewed needs before a human accepts it). */
function reviewableDraft(c: TestContext): { draftId: string; body: string; bodyHash: string } {
  const { draftId } = seedDraft(c.db, c.siteId);
  insertQualityReview(c.db, { siteId: c.siteId, subjectType: 'draft', subjectId: draftId, verdict: 'pass', deterministic: { synthetic: true }, aiReview: null, reasons: [], revisionRound: 0, now: NOW });
  const body = (JSON.parse(c.db.get<{ package_json: string }>('SELECT package_json FROM content_drafts WHERE id = ?', [draftId])!.package_json) as { body: string }).body;
  return { draftId, body, bodyHash: sha256(body) };
}

const humanReviews = (c: TestContext, draftId: string) => c.db.all<{ id: string }>(`SELECT id FROM quality_reviews WHERE subject_id = ? AND deterministic_json LIKE '%humanReview%'`, [draftId]).length;
const draftVersions = (c: TestContext) => c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_drafts WHERE site_id = ?', [c.siteId])!.n;

describe('content mark-reviewed and revise-manual accept only a named human', () => {
  it('markHumanReviewed refuses automation names for every caller and records nothing', () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'DRAFT' });
    const { draftId, bodyHash } = reviewableDraft(ctx);
    for (const name of AUTOMATION_NAMES) {
      for (const variant of [name, name.toUpperCase(), ` ${name} `]) {
        expect(() => markHumanReviewed(ctx!, draftId, { reviewer: variant, confirmHashPrefix: bodyHash.slice(0, 12) })).toThrow(
          expect.objectContaining({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/is reserved for automation and cannot record a human review/), hint: expect.stringMatching(/named human/) }),
        );
      }
    }
    // Names containing an automation token (e.g. "claude-bot", "owner:system") are refused too.
    expect(() => markHumanReviewed(ctx!, draftId, { reviewer: 'claude bot', confirmHashPrefix: bodyHash.slice(0, 12) })).toThrow(/reserved for automation/);
    expect(() => markHumanReviewed(ctx!, draftId, { reviewer: 'owner:system', confirmHashPrefix: bodyHash.slice(0, 12) })).toThrow(/VALIDATION_FAILED|unsupported characters/);
    expect(humanReviews(ctx, draftId)).toBe(0);
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'content.human_review'`)!.n).toBe(0);

    // A named human is recorded as given (trimmed), with the owner:<name> audit actor.
    const ok = markHumanReviewed(ctx, draftId, { reviewer: '  Alice  ', confirmHashPrefix: bodyHash.slice(0, 12) });
    expect(ok.reviewer).toBe('Alice');
    expect(ctx.db.get<{ actor: string }>(`SELECT actor FROM audit_events WHERE event_type = 'content.human_review'`)!.actor).toBe('owner:Alice');
  });

  it('reviseDraftManually refuses automation names for every caller (even in a dry run) and stores no version', () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'DRAFT' });
    const { draftId, body } = reviewableDraft(ctx);
    const before = draftVersions(ctx);
    for (const name of AUTOMATION_NAMES) {
      expect(() => reviseDraftManually(ctx!, draftId, { body: `${body}\nOne more synthetic sentence.\n`, reviewer: name })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/is reserved for automation and cannot author a human revision/) }),
      );
    }
    expect(() => reviseDraftManually(ctx!, draftId, { body, reviewer: '' })).toThrow(/A named author is required/);
    expect(draftVersions(ctx)).toBe(before);
    const dry = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'DRAFT', dryRun: true });
    try {
      const d = reviewableDraft(dry);
      expect(() => reviseDraftManually(dry, d.draftId, { body: d.body, reviewer: 'scheduler' })).toThrow(/reserved for automation/);
    } finally {
      dry.cleanup();
    }
  });

  it('the CLI refuses `--as system` / `--as claude` for mark-reviewed and revise-manual (exit 1, nothing recorded)', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'DRAFT' });
    const { draftId, body, bodyHash } = reviewableDraft(ctx);
    const bodyFile = path.join(ctx.paths.root, 'edited.md');
    writeFileSync(bodyFile, `${body}\nOne more synthetic sentence.\n`);
    for (const name of AUTOMATION_NAMES) {
      const mark = await cli(['content', 'mark-reviewed', draftId, '--as', name, '--confirm', bodyHash.slice(0, 12)]);
      expect(mark.code).toBe(1);
      expect(mark.err).toMatch(/reserved for automation and cannot record a human review/);
      const revise = await cli(['--mode', 'DRAFT', 'content', 'revise-manual', draftId, '--body-file', bodyFile, '--as', name]);
      expect(revise.code).toBe(1);
      expect(revise.err).toMatch(/reserved for automation and cannot author a human revision/);
    }
    expect(humanReviews(ctx, draftId)).toBe(0);
    expect(draftVersions(ctx)).toBe(1);
    const ok = await cli(['content', 'mark-reviewed', draftId, '--as', 'Alice', '--confirm', bodyHash.slice(0, 12)]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(new RegExp(`Draft ${draftId} accepted by Alice \\(status review_passed\\)`));
  });
});

describe('vault apply-business --by accepts only a named human (no anonymous "owner" default)', () => {
  async function recordedProfile(): Promise<{ diffHash: string; configFile: string; original: string }> {
    await cli(['vault', 'init']);
    const profile = path.join(siteVaultDir(ctx!.paths, ctx!.siteId), '01 Business', 'Business Profile.md');
    writeFileSync(profile, readFileSync(path.join(BUSINESS_FIXTURES, 'profile.valid.md'), 'utf8'));
    expect((await cli(['vault', 'import-business', '--apply'])).code).toBe(0);
    const show = await cli(['--json', 'vault', 'apply-business']);
    const shown = JSON.parse(show.out) as { status: string; diffHash: string };
    expect(shown.status).toBe('confirmation_required');
    const configFile = path.join(ctx!.paths.sitesDir, `${ctx!.siteId}.yaml`);
    return { diffHash: shown.diffHash, configFile, original: readFileSync(configFile, 'utf8') };
  }
  const applications = () => ctx!.db.all<{ applied_by: string }>('SELECT applied_by FROM business_profile_applications WHERE site_id = ?', [ctx!.siteId]);

  it('refuses system, claude, scheduler, and agent (preview and --confirm); the config is not written', async () => {
    ctx = createTestContext();
    const { diffHash, configFile, original } = await recordedProfile();
    for (const name of AUTOMATION_NAMES) {
      for (const args of [['vault', 'apply-business', '--by', name], ['vault', 'apply-business', '--confirm', diffHash, '--by', name]]) {
        const r = await cli(args);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(new RegExp(`"${name}" is reserved for automation`));
      }
    }
    expect(readFileSync(configFile, 'utf8')).toBe(original);
    expect(applications()).toEqual([]);

    const ok = await cli(['--json', 'vault', 'apply-business', '--confirm', diffHash, '--by', 'Alice']);
    expect(JSON.parse(ok.out).status).toBe('applied');
    expect(applications()).toEqual([{ applied_by: 'owner:Alice' }]);
  });

  it('without --by, --confirm records the operating-system user as the actor, never the literal "owner"', async () => {
    ctx = createTestContext();
    const { diffHash } = await recordedProfile();
    let osActor: string | null;
    try {
      osActor = `owner:${resolveApprover(undefined)}`;
    } catch {
      // An OS user named like automation or a service account (CI "runner", the Docker image's "node") is refused,
      // not replaced by "owner".
      osActor = null;
    }
    const r = await cli(['--json', 'vault', 'apply-business', '--confirm', diffHash]);
    if (osActor) {
      expect(r.code).toBe(0);
      expect(applications()).toEqual([{ applied_by: osActor }]);
    } else {
      expect(r.code).toBe(1);
      expect(applications()).toEqual([]);
    }
    expect(applications().some((a) => a.applied_by === 'owner:owner')).toBe(false);
  });
});

/**
 * D3-01: names are asserted, not authenticated, so the checks can only refuse
 * obvious automation and account names. They now also refuse the anonymous
 * "owner", generic account names, look-alike (homoglyph, fullwidth) and
 * concatenated automation names, apostrophe forms, and a service-account
 * operating-system user, while ordinary names stay valid.
 */
const NOT_A_NAMED_HUMAN = [
  'owner',
  'Owner',
  'root',
  'node',
  '\u0421laude', // Cyrillic capital Es + Latin "laude"
  '\uff43\uff4c\uff41\uff55\uff44\uff45', // fullwidth "claude"
  'claudecode',
  'seoagent',
  'agent007',
  "claude's",
];
const NAMED_HUMANS = ['Alice', 'Kai', 'Jos\u00e9', "O'Brien", 'Demo Approver - synthetic persona'];

describe('obvious automation, account, and look-alike names are refused at every human gate (D3-01)', () => {
  it('validateApproverName refuses them and keeps real names (Alice, Kai, Jos\u00e9, O\'Brien, the demo persona)', () => {
    for (const n of NOT_A_NAMED_HUMAN) expect(() => validateApproverName(n), n).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    for (const n of NAMED_HUMANS) expect(validateApproverName(n), n).toBe(n);
  });

  it('markHumanReviewed and reviseDraftManually refuse them for every caller and record nothing', () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'DRAFT' });
    const { draftId, body, bodyHash } = reviewableDraft(ctx);
    const before = draftVersions(ctx);
    for (const n of NOT_A_NAMED_HUMAN) {
      expect(() => markHumanReviewed(ctx!, draftId, { reviewer: n, confirmHashPrefix: bodyHash.slice(0, 12) }), n).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
      expect(() => reviseDraftManually(ctx!, draftId, { body: `${body}\nOne more synthetic sentence.\n`, reviewer: n }), n).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    // The anonymous "owner" gets the content wording of the refusal.
    expect(() => markHumanReviewed(ctx!, draftId, { reviewer: 'owner', confirmHashPrefix: bodyHash.slice(0, 12) })).toThrow(/"owner" is reserved for automation and service accounts .* cannot record a human review/);
    expect(humanReviews(ctx, draftId)).toBe(0);
    expect(draftVersions(ctx)).toBe(before);
    const ok = markHumanReviewed(ctx, draftId, { reviewer: "O'Brien", confirmHashPrefix: bodyHash.slice(0, 12) });
    expect(ok.reviewer).toBe("O'Brien");
  });

  it('confirmRateScale refuses "owner" and "owner:owner" as the asserting human (C1-13 follow-up)', () => {
    ctx = createTestContext({ now: NOW });
    for (const actor of ['owner', 'owner:owner', 'Owner', 'owner:node', 'owner:\u0421laude']) {
      expect(() => confirmRateScale(ctx!, 'properties/123456789', { scale: 'fraction', evidence: 'synthetic comparison with the GA4 interface', actor }), actor).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ga4_rate_scale_confirmations WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
  });

  it('the CLI refuses them for content mark-reviewed --as and vault apply-business --by (exit 1, nothing recorded)', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'DRAFT' });
    const { draftId, bodyHash } = reviewableDraft(ctx);
    for (const n of ['owner', '\u0421laude', '\uff43\uff4c\uff41\uff55\uff44\uff45', 'agent007', "claude's"]) {
      const r = await cli(['content', 'mark-reviewed', draftId, '--as', n, '--confirm', bodyHash.slice(0, 12)]);
      expect(r.code, n).toBe(1);
      expect(r.err, n).toMatch(/VALIDATION_FAILED|reserved for automation|mixes letters/);
      const v = await cli(['vault', 'apply-business', '--by', n]);
      expect(v.code, n).toBe(1);
    }
    expect(humanReviews(ctx, draftId)).toBe(0);
    const ok = await cli(['content', 'mark-reviewed', draftId, '--as', 'Kai', '--confirm', bodyHash.slice(0, 12)]);
    expect(ok.code, ok.err).toBe(0);
  });

  it('the operating-system fallback refuses a service account (the Docker image runs as node, CI as runner) and asks for --as', () => {
    for (const u of ['node', 'runner', 'root', 'daemon', 'www-data', 'ubuntu', 'ec2-user', 'nobody']) {
      expect(() => resolveApprover(undefined, () => u), u).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/is a service account, not a named human/), hint: expect.stringMatching(/Pass --as "<your name>"/) }),
      );
      // An explicit name is what such an environment passes.
      expect(resolveApprover('Alice', () => u)).toBe('Alice');
    }
    expect(resolveApprover(undefined, () => 'alice')).toBe('alice');
  });
});
