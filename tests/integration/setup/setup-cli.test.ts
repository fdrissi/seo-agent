import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupCliDeps } from '../../../src/cli/commands/setup.js';
import { appDirs, siteConfigFile, siteVaultDir } from '../../../src/config/paths.js';
import { readManifest } from '../../../src/config/workspace.js';
import { ScriptedPromptIO } from '../../../src/setup/prompt-io.js';
import { BASE_ANSWERS, makeWorkspace, runCli, type TestWorkspace } from './helpers.js';

const SECRET = 'sk-synthetic-import-check-1a2b3c4d5e';

let ws: TestWorkspace;
const originalDeps = { ...setupCliDeps };
beforeEach(() => {
  ws = makeWorkspace({ migrate: true });
});
afterEach(() => {
  Object.assign(setupCliDeps, originalDeps);
  ws.cleanup();
});

const exampleText = () => readFileSync(appDirs.exampleSiteConfig(), 'utf8');
function writeSource(name: string, text: string): string {
  const file = path.join(ws.tmp, name);
  writeFileSync(file, text);
  return file;
}

describe('setup --from (non-interactive import)', () => {
  it('imports a valid config verbatim with mode 0600', async () => {
    const src = writeSource('site.yaml', exampleText());
    const r = await runCli(ws, ['setup', '--from', src, '--json']);
    expect(r.exitCode).toBeUndefined();
    expect(r.json()).toMatchObject({ status: 'created', siteId: 'example-site', profile: 'core' });
    const file = siteConfigFile(ws.paths, 'example-site');
    expect(readFileSync(file, 'utf8')).toBe(exampleText());
    if (process.platform !== 'win32') expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  it('rejects an invalid config with field errors and writes nothing', async () => {
    const src = writeSource('bad.yaml', exampleText().replace('url: https://www.example.com/', 'url: ftp://www.example.com/'));
    const r = await runCli(ws, ['setup', '--from', src]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('site.url');
    expect(existsSync(siteConfigFile(ws.paths, 'example-site'))).toBe(false);
  });

  it('refuses unknown keys (typos)', async () => {
    const src = writeSource('typo.yaml', `${exampleText()}\nfeaturs: { llm: true }\n`);
    const r = await runCli(ws, ['setup', '--from', src]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('featurs: unknown key');
    expect(readdirSync(ws.paths.sitesDir)).toEqual([]);
  });

  it('refuses secret-named keys and credential-shaped values anywhere (comments included), never printing the value', async () => {
    const pasted = writeSource('pasted.yaml', `${exampleText()}\nLLM_GATEWAY_API_KEY: not-a-real-key-000\n`);
    const r1 = await runCli(ws, ['setup', '--from', pasted]);
    expect(r1.exitCode).toBe(1);
    expect(r1.err).toContain('Error [POLICY_DENIED]');
    expect(r1.err).toContain('LLM_GATEWAY_API_KEY is a secret-named key');
    expect(r1.err + r1.out).not.toContain('not-a-real-key-000');
    // A credential shape hidden in a comment (never configured in this workspace, so only its shape gives it away).
    const shaped = writeSource('shaped.yaml', exampleText().replace('# Unknown facts stay null/empty.', '# old key sk-synthetic0000000000000000 Unknown facts stay null/empty.'));
    const r2 = await runCli(ws, ['setup', '--from', shaped]);
    expect(r2.exitCode).toBe(1);
    expect(r2.err).toMatch(/line \d+: looks like a credential \(API secret key\)/);
    expect(r2.err + r2.out).not.toContain('sk-synthetic0000000000000000');
    // A secret-named key nested inside a record (records accept free-form keys) is refused too.
    const nested = writeSource('nested.yaml', exampleText().replace('combinedMonthlyUsd: "25.00"', 'combinedMonthlyUsd: "25.00"\n  accountMonthlyUsd: { client_secret: "1.00" }'));
    const r3 = await runCli(ws, ['setup', '--from', nested]);
    expect(r3.exitCode).toBe(1);
    expect(r3.err).toContain('budgets.accountMonthlyUsd.client_secret is a secret-named key');
    expect(readdirSync(ws.paths.sitesDir)).toEqual([]);
  });

  it('refuses Object.prototype key names that used to bypass the unknown-key check', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const src = writeSource(`${key}.yaml`, `${exampleText()}\n${key}:\n  note: synthetic smuggled block\n`);
      const r = await runCli(ws, ['setup', '--from', src]);
      expect(r.exitCode, key).toBe(1);
      expect(r.err).toContain(`the key "${key}" is not allowed`);
    }
    expect(readdirSync(ws.paths.sitesDir)).toEqual([]);
  });

  it('refuses a file that contains a configured secret value', async () => {
    const src = writeSource('leak.yaml', exampleText().replace('Synthetic example offer used for documentation only.', `Offer ${SECRET}`));
    const r = await runCli(ws, ['setup', '--from', src], { LLM_GATEWAY_API_KEY: SECRET });
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('LLM_GATEWAY_API_KEY');
    expect(r.err + r.out).not.toContain(SECRET);
    expect(readdirSync(ws.paths.sitesDir)).toEqual([]);
  });

  it('never overwrites an existing config without --update; --update shows the diff and keeps a backup', async () => {
    const src = writeSource('site.yaml', exampleText());
    await runCli(ws, ['setup', '--from', src]);
    const file = siteConfigFile(ws.paths, 'example-site');
    const changed = writeSource('site2.yaml', exampleText().replace('maxPages: 200', 'maxPages: 150'));

    const refused = await runCli(ws, ['setup', '--from', changed]);
    expect(refused.exitCode).toBe(1);
    expect(refused.err).toContain('Error [CONFLICT]');
    expect(refused.err).toContain('+  maxPages: 150');
    expect(readFileSync(file, 'utf8')).toBe(exampleText());

    const dry = await runCli(ws, ['setup', '--from', changed, '--update', '--dry-run', '--json']);
    expect(dry.json()).toMatchObject({ status: 'dry_run', changed: true });
    expect(readFileSync(file, 'utf8')).toBe(exampleText());

    const updated = await runCli(ws, ['setup', '--from', changed, '--update']);
    expect(updated.exitCode).toBeUndefined();
    expect(updated.out).toContain('-  maxPages: 200');
    expect(updated.out).toContain('+  maxPages: 150');
    expect(readFileSync(file, 'utf8')).toContain('maxPages: 150');
    const backups = readdirSync(path.join(ws.paths.backupsDir, 'config'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(ws.paths.backupsDir, 'config', backups[0]!), 'utf8')).toBe(exampleText());

    const same = await runCli(ws, ['setup', '--from', changed, '--update', '--json']);
    expect(same.json()).toMatchObject({ status: 'unchanged' });
  });

  it('refuses a demo-profile config in a live workspace', async () => {
    const src = writeSource('demo.yaml', exampleText().replace('profile: core', 'profile: demo'));
    const r = await runCli(ws, ['setup', '--from', src]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('npm run demo');
  });

  it('creates the workspace first when it does not exist yet', async () => {
    const fresh = makeWorkspace({ init: false });
    try {
      const src = path.join(fresh.tmp, 'site.yaml');
      writeFileSync(src, exampleText());
      const r = await runCli(fresh, ['setup', '--from', src]);
      expect(r.exitCode).toBeUndefined();
      expect(readManifest(fresh.paths)?.kind).toBe('live');
      expect(existsSync(fresh.paths.dbFile)).toBe(true);
      expect(existsSync(siteConfigFile(fresh.paths, 'example-site'))).toBe(true);
    } finally {
      fresh.cleanup();
    }
  });
});

describe('setup (interactive, via the CLI)', () => {
  it('uses the injectable prompt IO, creates a missing workspace on request, and writes the config', async () => {
    const fresh = makeWorkspace({ init: false });
    try {
      const io = new ScriptedPromptIO({ 'workspace.create': 'y', ...BASE_ANSWERS });
      setupCliDeps.createPromptIO = () => io;
      setupCliDeps.createServices = () => ({});
      const r = await runCli(fresh, ['setup']);
      expect(r.exitCode).toBeUndefined();
      expect(io.keys()[0]).toBe('workspace.create');
      expect(existsSync(siteConfigFile(fresh.paths, 'acme-test'))).toBe(true);
      // Next steps only name commands that exist in this build.
      expect(io.output()).toContain('npm run cli -- doctor --site acme-test');
    } finally {
      fresh.cleanup();
    }
  });

  it('stores a hidden secret only in secrets.env; the (redacted) CLI output stays readable and secret-free', async () => {
    const io = new ScriptedPromptIO({ ...BASE_ANSWERS, 'secret.LLM_GATEWAY_API_KEY': '1', 'secret.LLM_GATEWAY_API_KEY.value': SECRET });
    setupCliDeps.createPromptIO = () => io;
    setupCliDeps.createServices = () => ({});
    const r = await runCli(ws, ['setup']);
    expect(r.exitCode).toBeUndefined();
    expect(readFileSync(ws.paths.secretsEnvFile, 'utf8')).toContain(`LLM_GATEWAY_API_KEY=${SECRET}`);
    expect(readFileSync(siteConfigFile(ws.paths, 'acme-test'), 'utf8')).not.toContain(SECRET);
    const out = io.output() + r.out + r.err;
    expect(out).not.toContain(SECRET);
    expect(out).toContain('How will you provide LLM_GATEWAY_API_KEY? 1) enter it now');
    expect(out).toContain('Saved LLM_GATEWAY_API_KEY to');
  });

  it('an interruption exits with code 130 and keeps the draft', async () => {
    const io = new ScriptedPromptIO(BASE_ANSWERS, { interruptAt: 'business.offer' });
    setupCliDeps.createPromptIO = () => io;
    setupCliDeps.createServices = () => ({});
    const r = await runCli(ws, ['setup']);
    expect(r.exitCode).toBe(130);
    expect(io.output()).toContain('Progress is saved in');
    expect(readdirSync(ws.paths.sitesDir)).toEqual(['.acme-test.setup-draft.yaml']);
  });

  it('`setup --update --only conversions` (the command in owner-verification hints) asks exactly the two conversion steps', async () => {
    // Create a config first, then follow the hint through the real CLI.
    setupCliDeps.createServices = () => ({});
    setupCliDeps.createPromptIO = () => new ScriptedPromptIO({ ...BASE_ANSWERS, 'conversions.primaryEvents[0].name': ['generate_lead', ''], 'conversions.primaryEvents[0].meaning': 'Demo request form submitted', 'conversions.primaryEvents[0].kind': '2' });
    expect((await runCli(ws, ['setup'])).exitCode).toBeUndefined();
    const io = new ScriptedPromptIO({ 'conversions.primaryEvents.current[0].verifiedAt': '2025-01-15', 'conversions.primaryEvents.current[0].verificationNote': 'Synthetic test submission seen in GA4 DebugView' });
    setupCliDeps.createPromptIO = () => io;
    const r = await runCli(ws, ['setup', '--update', '--site', 'acme-test', '--only', 'conversions']);
    expect(r.exitCode).toBeUndefined();
    expect(io.keys().filter((k) => k !== 'confirm.write').every((k) => k.startsWith('conversions.'))).toBe(true);
    expect(io.keys()).toContain('conversions.secondaryEvents[0].name');
    expect(readFileSync(siteConfigFile(ws.paths, 'acme-test'), 'utf8')).toContain('verificationNote: Synthetic test submission seen in GA4 DebugView');
    const bad = await runCli(ws, ['setup', '--update', '--site', 'acme-test', '--only', 'conversion']);
    expect(bad.exitCode).toBe(1);
    expect(bad.err).toContain('Unknown step id(s) or group(s): conversion');
    expect(bad.err).toContain('conversions');
  });

  it('--dry-run is only for --from; the wizard refuses it', async () => {
    const r = await runCli(ws, ['setup', '--dry-run']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('--from');
  });

  it('--list-steps prints the step ids usable with --only', async () => {
    const r = await runCli(ws, ['setup', '--list-steps', '--json']);
    const ids = r.json<Array<{ id: string }>>().map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['profile', 'site.url', 'google.searchConsoleProperty', 'credentials', 'models', 'budgets']));
    // The text view also lists the groups --only accepts (e.g. the "conversions" group used in owner-verification hints).
    const text = await runCli(ws, ['setup', '--list-steps']);
    expect(text.out).toContain('Groups (--only <group> asks every step in it):');
    expect(text.out).toMatch(/conversions\s+conversions\.primaryEvents, conversions\.secondaryEvents/);
  });
});

describe('setup vault', () => {
  it('creates the site vault from the template and never overwrites', async () => {
    copyFileSync(appDirs.exampleSiteConfig(), siteConfigFile(ws.paths, 'example-site'));
    const r1 = await runCli(ws, ['setup', 'vault', '--json']);
    expect(r1.exitCode).toBeUndefined();
    const vault = siteVaultDir(ws.paths, 'example-site');
    expect(r1.json().vaultDir).toBe(vault);
    expect(existsSync(path.join(vault, '01 Business'))).toBe(true);
    const profile = readdirSync(path.join(vault, '01 Business')).find((f) => f.endsWith('.md'))!;
    writeFileSync(path.join(vault, '01 Business', profile), 'human edits');
    const r2 = await runCli(ws, ['setup', 'vault', '--json']);
    expect(r2.json().existing.length).toBeGreaterThan(0);
    expect(readFileSync(path.join(vault, '01 Business', profile), 'utf8')).toBe('human edits');
  });

  it('rejects unknown targets', async () => {
    const r = await runCli(ws, ['setup', 'nonsense']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('Unknown setup target');
  });
});
