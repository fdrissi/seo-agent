import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSchedulingInstructions, renderInstructions, resolveCliInvocation, shellQuote, systemdQuote, xmlEscape, type CliInvocation } from '../../../src/jobs/instructions.js';
import { BUILD_INFO_FILE, REBUILD_STEPS, REINSTALL_STEPS, hashSourceTree } from '../../../src/setup/build-info.js';

const invocation: CliInvocation = { kind: 'dist', argv: ['/opt/node/bin/node', '/srv/seo agent/dist/cli/main.js'], workingDirectory: '/srv/seo agent' };
const base = {
  siteId: 'example-site',
  workspaceRoot: '/home/owner/seo-agent-workspace',
  logsDir: '/home/owner/seo-agent-workspace/logs',
  invocation,
  timezone: 'Europe/Tallinn',
  schedules: [{ jobType: 'weekly', cron: '0 7 * * 1', timezone: 'Europe/Tallinn', enabled: true, nextRunLocal: 'Mon 2026-09-28 07:00 GMT+3 (Europe/Tallinn)' }],
};

describe('scheduling instructions (generated, never installed)', () => {
  it('generates launchd, systemd, cron, and server snippets that run the IANA-aware tick', () => {
    const si = buildSchedulingInstructions(base);
    expect(si.bundles.map((b) => b.platform)).toEqual(['launchd', 'systemd', 'cron', 'server']);
    expect(si.tickCommand).toBe("/opt/node/bin/node '/srv/seo agent/dist/cli/main.js' --workspace /home/owner/seo-agent-workspace --site example-site schedule run --once");

    const plist = si.bundles[0]!.files[0]!.content;
    expect(plist).toContain('<string>local.seo-agent.example-site</string>');
    expect(plist).toContain('<integer>900</integer>');
    expect(plist).toContain('<string>/srv/seo agent/dist/cli/main.js</string>');
    expect(plist).toContain('<string>--once</string>');
    expect(si.bundles[0]!.install.join('\n')).toContain('launchctl bootstrap gui/$(id -u)');
    expect(si.bundles[0]!.uninstall.join('\n')).toContain('launchctl bootout');

    const [service, timer] = si.bundles[1]!.files.map((f) => f.content);
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('ExecStart=/opt/node/bin/node "/srv/seo agent/dist/cli/main.js" --workspace /home/owner/seo-agent-workspace --site example-site schedule run --once');
    expect(timer).toContain('OnCalendar=*:0/15');
    expect(timer).toContain('Persistent=true');
    expect(si.bundles[1]!.install.join('\n')).toContain('loginctl enable-linger');

    const cron = si.bundles[2]!.files[0]!.content;
    expect(cron).toMatch(/^\*\/15 \* \* \* \* cd '\/srv\/seo agent' && /m);
    expect(cron).toContain('computed by seo-agent in Europe/Tallinn');

    const daemon = si.bundles[3]!.files[0]!.content;
    expect(daemon).toContain('schedule run\n');
    expect(daemon).toContain('Restart=on-failure');
    expect(daemon).toContain('User=<service-user>');
    // The daemon note must describe what actually happens after a restart (automatic resume, capped; else BLOCKED).
    const daemonNotes = si.bundles[3]!.notes.join('\n');
    expect(daemonNotes).toMatch(/first tick after the next start resumes a scheduled job from its checkpoints, up to 3 interruptions in a row/);
    expect(daemonNotes).toMatch(/reports the schedule BLOCKED/);
    expect(daemonNotes).toMatch(/paid stage that was in flight is never rerun automatically/);
  });

  it('explains opt-in installation, sleeping laptops, IANA/DST handling, and secret handling; never embeds UTC offsets', () => {
    const si = buildSchedulingInstructions(base);
    const text = renderInstructions(si);
    expect(text).toMatch(/Nothing is installed automatically/);
    expect(text).toMatch(/sleeping, powered-off, or offline laptop cannot run jobs/);
    expect(text).toMatch(/IANA time zone \(Europe\/Tallinn\), including daylight-saving/);
    expect(text).toMatch(/Never put secrets in plist, unit, or crontab files/);
    expect(text).not.toMatch(/UTC[+-]\d|TZ=|CRON_TZ/);
    expect(si.warnings).toEqual([]);
  });

  it('warns when nothing is enabled, when running from sources, and supports platform/interval selection', () => {
    const si = buildSchedulingInstructions({ ...base, schedules: [], invocation: { ...invocation, kind: 'tsx' }, platforms: ['cron'], intervalMinutes: 60 });
    expect(si.bundles.map((b) => b.platform)).toEqual(['cron']);
    expect(si.bundles[0]!.files[0]!.content).toMatch(/^0 \* \* \* \* /m);
    expect(si.warnings.join('\n')).toMatch(/No schedule is enabled yet/);
    expect(si.warnings.join('\n')).toMatch(/npm run build/);
    expect(() => buildSchedulingInstructions({ ...base, intervalMinutes: 7 })).toThrow(RangeError);
  });

  it('quotes paths safely for each format', () => {
    expect(shellQuote("/a/it's here")).toBe(`'/a/it'\\''s here'`);
    expect(systemdQuote('/a/100%/$HOME dir')).toBe('"/a/100%%/$$HOME dir"');
    expect(xmlEscape('a&b<c>')).toBe('a&amp;b&lt;c&gt;');
  });
});

describe('resolveCliInvocation: never points a scheduler at a stale compiled build (B1-05)', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  /** Synthetic application tree; `stamp` writes dist/build-info.json matching the tree as it is now. */
  function app(opts: { built?: boolean; stamp?: boolean; tsx?: boolean } = {}): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-invocation-'));
    temps.push(root);
    put(path.join(root, 'package.json'), JSON.stringify({ name: 'seo-agent', version: '1.2.3-synthetic' }));
    put(path.join(root, 'src', 'cli', 'main.ts'), 'export {};\n');
    put(path.join(root, 'migrations', '0001_core.sql'), 'CREATE TABLE a (id INTEGER);\n');
    if (opts.tsx !== false) put(path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
    if (opts.built !== false) put(path.join(root, 'dist', 'cli', 'main.js'), 'export {};\n');
    if (opts.built !== false && opts.stamp !== false) {
      put(
        path.join(root, 'dist', BUILD_INFO_FILE),
        JSON.stringify({ schema: 1, name: 'seo-agent', version: '1.2.3-synthetic', builtAt: '2026-09-24T09:00:00.000Z', gitRevision: null, gitDirty: null, srcHash: hashSourceTree(path.join(root, 'src'))!.hash, srcFiles: 1, migrations: ['0001_core.sql'] }),
      );
    }
    return root;
  }

  it('uses dist/cli/main.js when its stamp matches package.json, src/, and migrations/', () => {
    const root = app();
    const inv = resolveCliInvocation(root, '/opt/node/bin/node');
    expect(inv).toEqual({ kind: 'dist', argv: ['/opt/node/bin/node', path.join(root, 'dist', 'cli', 'main.js')], workingDirectory: root });
    expect(buildSchedulingInstructions({ ...base, invocation: inv }).warnings).toEqual([]);
  });

  it('refuses a dist/ that is older than a new migration and falls back to the sources, loudly', () => {
    const root = app();
    put(path.join(root, 'migrations', '0002_new.sql'), 'CREATE TABLE b (id INTEGER);\n');
    const inv = resolveCliInvocation(root, '/opt/node/bin/node');
    expect(inv.kind).toBe('tsx');
    expect(inv.argv).toEqual(['/opt/node/bin/node', path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'src', 'cli', 'main.ts')]);
    expect(inv.rejectedDist).toMatchObject({ entry: path.join(root, 'dist', 'cli', 'main.js'), state: 'stale', reasons: [expect.stringContaining('0002_new.sql')] });
    const si = buildSchedulingInstructions({ ...base, invocation: inv });
    expect(si.tickCommand).not.toContain('dist/cli/main.js');
    const text = renderInstructions(si);
    expect(text).toMatch(/WARNING: .*dist\/cli\/main\.js was NOT used: its build is out of date \(migrations\/ has 1 migration\(s\) the build does not know: 0002_new\.sql\)/);
    expect(text).toMatch(/Run `npm run build`, then re-run `npm run cli -- schedule instructions`/);
    // The generic "prefer a build" warning is replaced by the specific one.
    expect(si.warnings.filter((w) => w.includes('npm run build'))).toHaveLength(1);
  });

  it('refuses a dist/ after changed sources or a new version, and an unstamped dist/', () => {
    const edited = app();
    put(path.join(edited, 'src', 'cli', 'main.ts'), 'export const changed = true;\n');
    expect(resolveCliInvocation(edited).rejectedDist).toMatchObject({ state: 'stale', reasons: [expect.stringMatching(/src\/ changed since the build/)] });

    const upgraded = app();
    put(path.join(upgraded, 'package.json'), JSON.stringify({ name: 'seo-agent', version: '1.3.0-synthetic' }));
    expect(resolveCliInvocation(upgraded).rejectedDist?.reasons.join(' ')).toMatch(/version 1\.2\.3-synthetic, but package\.json is 1\.3\.0-synthetic/);

    const unstamped = app({ stamp: false, tsx: false });
    const inv = resolveCliInvocation(unstamped, '/opt/node/bin/node');
    expect(inv).toMatchObject({ kind: 'tsx-import', rejectedDist: { state: 'unstamped' } });
    expect(buildSchedulingInstructions({ ...base, invocation: inv }).warnings.join('\n')).toMatch(/its build is unstamped .*needs the tsx dev dependency/);
  });

  it('a packaged install without src/ is told to reinstall or upgrade, never to run `npm run build` (R3-NF-R5)', () => {
    const root = app({ stamp: false });
    rmSync(path.join(root, 'src'), { recursive: true, force: true });
    const inv = resolveCliInvocation(root, '/opt/node/bin/node');
    expect(inv.rejectedDist).toMatchObject({ state: 'unstamped', repairSteps: REINSTALL_STEPS });
    const text = buildSchedulingInstructions({ ...base, invocation: inv }).warnings.join('\n');
    expect(text).toContain(REINSTALL_STEPS);
    expect(text).toMatch(/which this installation does not have, so they cannot run either/);
    // The reason may say how the build was (not) made; the advice never tells a packaged install to rebuild.
    expect(text).not.toContain(REBUILD_STEPS);
    expect(text).not.toMatch(/Run `npm run build`|prefer `npm run build`/);
    // A checkout carries the rebuild steps; a hand-built rejectedDist without repairSteps keeps them too.
    const checkout = app({ stamp: false });
    expect(resolveCliInvocation(checkout).rejectedDist?.repairSteps).toBe(REBUILD_STEPS);
    const { repairSteps: _drop, ...legacy } = inv.rejectedDist!;
    expect(buildSchedulingInstructions({ ...base, invocation: { ...inv, rejectedDist: legacy } }).warnings.join('\n')).toContain(REBUILD_STEPS);
  });

  it('without any dist/ it uses the sources with the usual build suggestion', () => {
    const inv = resolveCliInvocation(app({ built: false }));
    expect(inv.kind).toBe('tsx');
    expect(inv.rejectedDist).toBeUndefined();
    expect(buildSchedulingInstructions({ ...base, invocation: inv }).warnings.join('\n')).toMatch(/prefer `npm run build` and re-run `schedule instructions`/);
  });
});
