import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSiteConfig } from '../../../src/config/load.js';
import { siteConfigFile, siteVaultDir } from '../../../src/config/paths.js';
import { applyBusinessProfile, businessNoteTrustClass, diffBusinessProfile, importBusinessNotes, listBusinessNoteVersions, parseBusinessNote } from '../../../src/obsidian/business-sync.js';
import { GENERATED_END, GENERATED_START } from '../../../src/obsidian/types.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'fixtures', 'obsidian', 'business');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

let ctx: TestContext;
let businessDir: string;

function putNote(name: string, content: string): string {
  mkdirSync(businessDir, { recursive: true });
  writeFileSync(path.join(businessDir, name), content);
  return `01 Business/${name}`;
}

beforeEach(() => {
  ctx = createTestContext();
  businessDir = path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business');
});
afterEach(() => ctx.cleanup());

describe('parseBusinessNote', () => {
  it('parses a valid business profile into structured, validated data', () => {
    const p = parseBusinessNote('01 Business/Business Profile.md', fixture('profile.valid.md'), { siteId: 'test-site' });
    expect(p.errors).toEqual([]);
    expect(p.valid).toBe(true);
    expect(p.noteType).toBe('business_profile');
    expect(p.data).toMatchObject({
      offer: 'Synthetic scheduling software for small test clinics.',
      targetCustomer: 'Clinic managers who book appointments by phone today.',
      differentiators: ['Setup takes one day.', 'Works offline for up to one hour.'],
      approvedClaims: ['Setup takes one day.'],
      prohibitedClaims: ['Guaranteed more bookings.'],
      brandVoice: 'Plain, calm, and specific.',
      editorialRequirements: ['No emojis.'],
    });
    expect(p.data!.productFacts).toEqual([
      { id: 'pf-offline-hour', statement: 'Bookings keep working offline for up to one hour.', source: 'https://www.example.test/docs/offline', verifiedAt: '2026-09-01' },
      { id: 'pf-languages', statement: 'The interface is available in two languages.', source: 'owner', verifiedAt: null },
    ]);
  });

  it('rejects invalid notes with actionable errors', () => {
    const p = parseBusinessNote('01 Business/Business Profile.md', fixture('profile.invalid.md'), { siteId: 'test-site' });
    expect(p.valid).toBe(false);
    expect(p.data).toBeNull();
    const all = p.errors.join('\n');
    expect(all).toMatch(/expected a bulleted list item/);
    expect(all).toMatch(/must start with a stable id/);
    expect(all).toMatch(/duplicate fact id \[pf-dup\]/);
    expect(all).toMatch(/YYYY-MM-DD/);
    expect(all).toMatch(/both approved and prohibited/);
  });

  it('rejects unsafe YAML tags without executing them', () => {
    const p = parseBusinessNote('01 Business/Business Profile.md', fixture('profile.unsafe-yaml.md'), { siteId: 'test-site' });
    expect(p.valid).toBe(false);
    expect(p.errors.join(' ')).toMatch(/explicit YAML tags are not allowed/);
  });

  it('requires a known type, a stable id, and the right site', () => {
    expect(parseBusinessNote('01 Business/x.md', '# no frontmatter', { siteId: 'test-site' }).errors.join(' ')).toMatch(/type/);
    expect(parseBusinessNote('01 Business/x.md', '---\ntype: business_note\n---\n## A\ntext', { siteId: 'test-site' }).errors.join(' ')).toMatch(/stable "id"/);
    expect(parseBusinessNote('01 Business/x.md', '---\nid: a\ntype: business_note\nsite: other-site\n---\n', { siteId: 'test-site' }).errors.join(' ')).toMatch(/does not match/);
    expect(parseBusinessNote('01 Business/x.md', '---\nid: a\ntype: business_note\nsite: "{{site_id}}"\n---\n', { siteId: 'test-site' }).errors.join(' ')).toMatch(/placeholder/);
  });

  it('approval spoofing: approved/trusted/trust_class properties are ignored and reported', () => {
    const p = parseBusinessNote('01 Business/Business Profile.md', fixture('profile.spoofed.md'), { siteId: 'test-site' });
    expect(p.valid).toBe(true);
    expect(p.ignoredAuthorityKeys.sort()).toEqual(['approved', 'authorized_by', 'trust_class', 'trusted', 'verified']);
    expect(p.warnings.join(' ')).toMatch(/granted only through the CLI/);
    expect(JSON.stringify(p.data)).not.toMatch(/approved"?:\s*true|trusted/);
  });

  it('agent-generated notes cannot be imported as owner facts (markers, tracked path, generated type, generated id)', () => {
    const base = fixture('profile.valid.md');
    const withMarkers = base.replace('## Offer', `${GENERATED_START}\n## Offer`).concat(`\n${GENERATED_END}\n`);
    expect(parseBusinessNote('01 Business/a.md', withMarkers, { siteId: 'test-site' }).errors.join(' ')).toMatch(/generated markers/);
    expect(parseBusinessNote('01 Business/a.md', base, { siteId: 'test-site', trackedPaths: new Set(['01 Business/a.md']) }).errors.join(' ')).toMatch(/tracked as a generated note/);
    expect(parseBusinessNote('01 Business/a.md', base.replace('type: business_profile', 'type: source'), { siteId: 'test-site' }).errors.join(' ')).toMatch(/produced by seo-agent/);
    expect(parseBusinessNote('01 Business/a.md', base, { siteId: 'test-site', generatedNoteIds: new Set(['business-profile']) }).errors.join(' ')).toMatch(/belongs to a generated note/);
  });

  it('parses customer questions and owner decisions (which never authorize actions)', () => {
    const q = parseBusinessNote('01 Business/Customer Questions.md', fixture('questions.valid.md'), { siteId: 'test-site' });
    expect(q.data).toEqual({ questions: ['Can I import my existing appointments?', 'Does it work without internet?'] });
    const d = parseBusinessNote('01 Business/Owner Decisions.md', fixture('decisions.valid.md'), { siteId: 'test-site' });
    expect(d.data).toEqual({ decisions: [{ date: '2026-09-01', text: 'We do not target competitor brand queries.' }], authorizesProductionActions: false });
    expect(d.ignoredAuthorityKeys).toEqual(['approved']);
  });

  it('an untouched template imports as a valid note with no config changes', () => {
    const template = readFileSync(path.join(FIXTURES, '..', '..', '..', '..', 'vault', '_template', '01 Business', 'Business Profile.md'), 'utf8').replace('{{site_id}}', 'test-site');
    const p = parseBusinessNote('01 Business/Business Profile.md', template, { siteId: 'test-site' });
    expect(p.errors).toEqual([]);
    expect(diffBusinessProfile(p.data as never, ctx.config).changes).toEqual([]);
  });
});

describe('importBusinessNotes (version history)', () => {
  it('previews without recording, then records versions with --apply, never touching the config', () => {
    putNote('Business Profile.md', fixture('profile.valid.md'));
    putNote('Customer Questions.md', fixture('questions.valid.md'));
    const configBefore = readFileSync(siteConfigFile(ctx.paths, ctx.siteId), 'utf8');

    const preview = importBusinessNotes(ctx);
    expect(preview.notes.map((n) => n.status)).toEqual(['new', 'new']);
    expect(preview.profile!.lines).toContain('~ business.offer: (unset) -> "Synthetic scheduling software for small test clinics."');
    expect(preview.profile!.lines.some((l) => l.startsWith('+ business.productFacts[pf-offline-hour]'))).toBe(true);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM business_note_versions')!.n).toBe(0);

    const applied = importBusinessNotes(ctx, { apply: true });
    expect(applied.recorded).toBe(2);
    const profile = applied.notes.find((n) => n.noteType === 'business_profile')!;
    expect(profile).toMatchObject({ status: 'recorded', recordedStatus: 'pending_review', version: 1 });
    expect(applied.notes.find((n) => n.noteType === 'customer_questions')).toMatchObject({ recordedStatus: 'imported', version: 1 });
    expect(readFileSync(siteConfigFile(ctx.paths, ctx.siteId), 'utf8')).toBe(configBefore);

    // Re-import of identical content records nothing new.
    const again = importBusinessNotes(ctx, { apply: true });
    expect(again.recorded).toBe(0);
    expect(again.notes.every((n) => n.status === 'already_recorded')).toBe(true);

    // An edit creates version 2; history keeps both.
    putNote('Business Profile.md', fixture('profile.valid.md').replace('Plain, calm, and specific.', 'Plain and specific.'));
    const v2 = importBusinessNotes(ctx, { apply: true });
    expect(v2.notes.find((n) => n.noteType === 'business_profile')).toMatchObject({ status: 'recorded', version: 2 });
    const history = listBusinessNoteVersions(ctx, '01 Business/Business Profile.md');
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect(history.every((h) => h.trustClass === 'user_reported')).toBe(true);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'vault.business_note_recorded'")!.n).toBe(3);
  });

  it('records rejected notes with their validation errors', () => {
    putNote('Business Profile.md', fixture('profile.invalid.md'));
    const r = importBusinessNotes(ctx, { apply: true });
    expect(r.rejected).toBe(1);
    expect(r.notes[0]).toMatchObject({ status: 'rejected', recordedStatus: 'rejected' });
    const row = ctx.db.get<{ status: string; validation_errors_json: string; parsed_json: string | null }>('SELECT * FROM business_note_versions')!;
    expect(row.status).toBe('rejected');
    expect(row.parsed_json).toBeNull();
    expect(JSON.parse(row.validation_errors_json).length).toBeGreaterThan(2);
    expect(businessNoteTrustClass({ status: 'rejected', note_type: 'business_profile' })).toBeNull();
    expect(r.nextStep).toMatch(/Fix the listed errors/);
  });

  it('rejects two business profiles and a generated note copied into 01 Business', () => {
    putNote('Business Profile.md', fixture('profile.valid.md'));
    putNote('Profile copy.md', fixture('profile.valid.md').replace('id: business-profile', 'id: business-profile-2'));
    const writer = createVaultWriter(ctx);
    const gen = writer.writeGenerated({ relPath: '02 Website/Pages/Home.md', noteId: 'page_home', kind: 'page', title: 'Home', frontmatter: {}, body: 'Generated.' });
    copyFileSync(path.join(writer.vaultDir, ...gen.relPath.split('/')), path.join(businessDir, 'Copied generated.md'));
    const r = importBusinessNotes(ctx, { apply: true });
    const byPath = new Map(r.notes.map((n) => [n.relPath, n]));
    expect(byPath.get('01 Business/Business Profile.md')!.errors.join(' ')).toMatch(/Only one business_profile/);
    expect(byPath.get('01 Business/Copied generated.md')!.errors.join(' ')).toMatch(/generated markers/);
    expect(r.rejected).toBe(3);
  });

  it('never follows symlinks in 01 Business', () => {
    mkdirSync(businessDir, { recursive: true });
    const outside = path.join(ctx.paths.root, 'outside.md');
    writeFileSync(outside, fixture('profile.valid.md'));
    symlinkSync(outside, path.join(businessDir, 'Business Profile.md'));
    const r = importBusinessNotes(ctx, { apply: true });
    expect(r.notes[0]!.errors.join(' ')).toMatch(/symlinks are never followed/i);
    expect(r.recorded).toBe(0);
  });
});

describe('applyBusinessProfile (explicit, diff-bound config update)', () => {
  it('requires a recorded version, shows the diff, and only writes with the matching confirmation hash', () => {
    putNote('Business Profile.md', fixture('profile.valid.md'));
    expect(() => applyBusinessProfile(ctx)).toThrow(/has not been recorded yet/);
    importBusinessNotes(ctx, { apply: true });

    const preview = applyBusinessProfile(ctx);
    expect(preview.status).toBe('confirmation_required');
    expect(preview.lines.length).toBeGreaterThan(5);
    expect(loadSiteConfig(ctx.paths, ctx.siteId).business.offer).toBeNull();

    expect(() => applyBusinessProfile(ctx, { confirmHash: 'not-the-hash' })).toThrow(/does not match the current diff/);
    expect(applyBusinessProfile(ctx, { confirmHash: preview.diffHash, dryRun: true }).status).toBe('would_apply');
    expect(loadSiteConfig(ctx.paths, ctx.siteId).business.offer).toBeNull();

    const logged: string[] = [];
    const done = applyBusinessProfile(ctx, { confirmHash: preview.diffHash, actor: 'owner:test', log: (l) => logged.push(l) });
    expect(done.status).toBe('applied');
    expect(done.backupFile && existsSync(done.backupFile)).toBe(true);
    const cfg = loadSiteConfig(ctx.paths, ctx.siteId);
    expect(cfg.business.offer).toBe('Synthetic scheduling software for small test clinics.');
    expect(cfg.business.productFacts.map((f) => f.id)).toEqual(['pf-offline-hour', 'pf-languages']);
    expect(cfg.editorial.brandVoice).toBe('Plain, calm, and specific.');
    expect(cfg.editorial.requirements).toEqual(['No emojis.']);
    const version = ctx.db.get<{ source: string; version: number }>('SELECT source, version FROM config_versions WHERE site_id = ? ORDER BY version DESC LIMIT 1', [ctx.siteId])!;
    expect(version.source).toBe('business_note_sync');
    expect(done.configVersion).toBe(version.version);
    const row = ctx.db.get<{ status: string; applied_config_version: number; applied_by: string }>('SELECT * FROM business_note_versions WHERE site_id = ?', [ctx.siteId])!;
    expect(row).toMatchObject({ status: 'imported', applied_config_version: version.version, applied_by: 'owner:test' });
    expect(listBusinessNoteVersions(ctx)[0]!.trustClass).toBe('owner_approved');
    expect(logged[0]).toMatch(/applied to the site config/);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'config.business_note_sync'")!.n).toBe(1);

    // Nothing left to apply; the old hash cannot be replayed against the new config.
    expect(applyBusinessProfile(ctx).status).toBe('no_changes');
    expect(applyBusinessProfile(ctx, { confirmHash: preview.diffHash }).status).toBe('no_changes');
  });

  it('keeps comments elsewhere in the YAML config', () => {
    const file = siteConfigFile(ctx.paths, ctx.siteId);
    writeFileSync(file, `# my private comment\n${readFileSync(file, 'utf8')}`);
    putNote('Business Profile.md', fixture('profile.valid.md'));
    importBusinessNotes(ctx, { apply: true });
    const preview = applyBusinessProfile(ctx);
    applyBusinessProfile(ctx, { confirmHash: preview.diffHash });
    expect(readFileSync(file, 'utf8')).toContain('# my private comment');
    expect(readdirSync(path.join(ctx.paths.backupsDir, 'config'))).toHaveLength(1);
  });

  it('a changed note after review invalidates the confirmation', () => {
    putNote('Business Profile.md', fixture('profile.valid.md'));
    importBusinessNotes(ctx, { apply: true });
    const preview = applyBusinessProfile(ctx);
    putNote('Business Profile.md', fixture('profile.valid.md').replace('small test clinics', 'large test clinics'));
    importBusinessNotes(ctx, { apply: true });
    expect(() => applyBusinessProfile(ctx, { confirmHash: preview.diffHash })).toThrow(/does not match/);
  });

  it('approval spoofing: "approved: true" in the note never applies anything by itself', () => {
    putNote('Business Profile.md', fixture('profile.spoofed.md'));
    const r = importBusinessNotes(ctx, { apply: true });
    expect(r.notes[0]).toMatchObject({ recordedStatus: 'pending_review' });
    expect(r.notes[0]!.ignoredAuthorityKeys).toContain('approved');
    const cfg = loadSiteConfig(ctx.paths, ctx.siteId);
    expect(cfg.business.offer).toBeNull();
    expect(cfg.business.approvedClaims).toEqual([]);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM config_versions WHERE source = 'business_note_sync'")!.n).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approvals')!.n).toBe(0);
    expect(listBusinessNoteVersions(ctx)[0]!.trustClass).toBe('user_reported');
  });

  it('an explicit "(none)" clears a list; an empty section leaves the config unchanged', () => {
    putNote('Business Profile.md', fixture('profile.valid.md'));
    importBusinessNotes(ctx, { apply: true });
    applyBusinessProfile(ctx, { confirmHash: applyBusinessProfile(ctx).diffHash });
    const cleared = fixture('profile.valid.md')
      .replace('- Setup takes one day.\n- Works offline for up to one hour.', '- (none)')
      .replace('Clinic managers who book appointments by phone today.', '');
    putNote('Business Profile.md', cleared);
    importBusinessNotes(ctx, { apply: true });
    const preview = applyBusinessProfile(ctx);
    expect(preview.lines).toEqual(['- business.differentiators: "Setup takes one day."', '- business.differentiators: "Works offline for up to one hour."']);
    applyBusinessProfile(ctx, { confirmHash: preview.diffHash });
    const cfg = loadSiteConfig(ctx.paths, ctx.siteId);
    expect(cfg.business.differentiators).toEqual([]);
    expect(cfg.business.targetCustomer).toBe('Clinic managers who book appointments by phone today.');
  });
});


describe('business note revisions (A -> B -> A)', () => {
  const A = () => fixture('profile.valid.md');
  const B = () => fixture('profile.valid.md').replace('small test clinics', 'large test clinics');
  const applyNow = (actor: string) => applyBusinessProfile(ctx, { confirmHash: applyBusinessProfile(ctx).diffHash, actor });

  it('records a return to earlier content as a new revision, re-derives trust against the config, and keeps every application', () => {
    putNote('Business Profile.md', A());
    importBusinessNotes(ctx, { apply: true });
    const firstApply = applyNow('owner:first');
    ctx.clock.advanceMs(86_400_000);
    putNote('Business Profile.md', B());
    importBusinessNotes(ctx, { apply: true });
    applyNow('owner:second');
    ctx.clock.advanceMs(86_400_000);

    // Back to A: not "already recorded", and not trusted while the config still holds B.
    putNote('Business Profile.md', A());
    const preview = importBusinessNotes(ctx);
    expect(preview.notes[0]).toMatchObject({ status: 'new', returnsToVersion: 1, recordedStatus: null });
    expect(() => applyBusinessProfile(ctx)).toThrow(/has not been recorded yet/);
    const rec = importBusinessNotes(ctx, { apply: true });
    expect(rec.recorded).toBe(1);
    expect(rec.notes[0]).toMatchObject({ status: 'recorded', version: 1, revision: 3, returnsToVersion: 1, recordedStatus: 'pending_review' });
    expect(rec.profile!.lines).toContain('~ business.offer: "Synthetic scheduling software for large test clinics." -> "Synthetic scheduling software for small test clinics."');
    let history = listBusinessNoteVersions(ctx, '01 Business/Business Profile.md');
    expect(history.map((h) => [h.version, h.revisions, h.current, h.trustClass])).toEqual([
      [1, [1, 3], true, 'user_reported'],
      [2, [2], false, 'owner_approved'],
    ]);
    // The memory module's trust rule (status = 'imported' for the exact content) no longer trusts A.
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM business_note_versions WHERE site_id = ? AND content_hash = ? AND status = 'imported'", [ctx.siteId, rec.notes[0]!.contentHash])!.n).toBe(0);

    const again = applyNow('owner:third');
    expect(again.status).toBe('applied');
    expect(loadSiteConfig(ctx.paths, ctx.siteId).business.offer).toBe('Synthetic scheduling software for small test clinics.');
    history = listBusinessNoteVersions(ctx, '01 Business/Business Profile.md');
    const v1 = history.find((h) => h.version === 1)!;
    expect(v1.trustClass).toBe('owner_approved');
    expect(v1.applications.map((a) => [a.configVersion, a.appliedBy, a.appliedAt.slice(0, 10)])).toEqual([
      [firstApply.configVersion, 'owner:first', '2026-09-24'],
      [firstApply.configVersion, 'owner:third', '2026-09-26'],
    ]);
    expect(v1.applications[1]!.configChanged).toBe(false);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM business_profile_applications WHERE site_id = ?', [ctx.siteId])!.n).toBe(3);
    expect(() => ctx.db.run('UPDATE business_profile_applications SET applied_by = ? WHERE site_id = ?', ['x', ctx.siteId])).toThrow(/append-only/);
  });

  it('an unchanged note is re-checked against the config on --apply (trust follows the config)', () => {
    putNote('Business Profile.md', A());
    importBusinessNotes(ctx, { apply: true });
    applyNow('owner:test');
    expect(listBusinessNoteVersions(ctx)[0]!.trustClass).toBe('owner_approved');
    // The config is edited by hand so it no longer matches the recorded profile.
    const file = siteConfigFile(ctx.paths, ctx.siteId);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Synthetic scheduling software for small test clinics.', 'Edited by hand.'));
    const r = importBusinessNotes(ctx, { apply: true });
    expect(r.notes[0]).toMatchObject({ status: 'already_recorded', recordedStatus: 'pending_review' });
    expect(listBusinessNoteVersions(ctx)[0]!.trustClass).toBe('user_reported');
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'vault.business_note_status_changed'")!.n).toBe(1);
  });
});

describe('owner decisions -> decisions table', () => {
  const decisions = () => ctx.db.all<{ subject_type: string; subject_id: string; decision: string; decided_by: string; vault_path: string }>(`SELECT subject_type, subject_id, decision, decided_by, vault_path FROM decisions ORDER BY decided_at`);

  it('a preview, a dry run, or an invalid note writes no decision; --apply imports each entry once (owner, vault path)', () => {
    putNote('Owner Decisions.md', fixture('decisions.valid.md'));
    importBusinessNotes(ctx);
    importBusinessNotes(ctx, { apply: true, dryRun: true });
    expect(decisions()).toEqual([]);
    const r = importBusinessNotes(ctx, { apply: true, actor: 'owner:Alice' });
    expect(r.notes[0]!.ownerDecisions).toEqual({ rows: 1, inserted: 1, withdrawn: 0, siteWide: 1 });
    expect(decisions()).toEqual([{ subject_type: 'site', subject_id: 'test-site', decision: 'We do not target competitor brand queries.', decided_by: 'owner', vault_path: '01 Business/Owner Decisions.md' }]);
    expect(ctx.db.get<{ actor: string }>(`SELECT actor FROM audit_events WHERE event_type = 'vault.owner_decision_imported'`)!.actor).toBe('owner:Alice');
    // An edit that makes the note invalid is recorded as rejected and leaves the imported decisions alone.
    putNote('Owner Decisions.md', fixture('decisions.valid.md').replace('- 2026-09-01: We do not', '- sometime: We do not'));
    const bad = importBusinessNotes(ctx, { apply: true, actor: 'owner:Alice' });
    expect(bad.rejected).toBe(1);
    expect(bad.notes[0]!.ownerDecisions).toBeUndefined();
    expect(decisions()).toHaveLength(1);
  });
});
