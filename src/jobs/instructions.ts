import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REBUILD_STEPS, REINSTALL_STEPS, buildRepairSteps, checkBuildFreshness, type BuildFreshness } from '../setup/build-info.js';
import { DEFAULT_MAX_AUTO_RESUMES } from './runner.js';

/**
 * Generates (never installs) scheduling snippets for macOS launchd, Linux
 * systemd timers, cron, and a continuously running server daemon.
 *
 * Design: the operating-system timer only wakes seo-agent periodically
 * (`schedule run --once`, default every 15 minutes). WHAT is due and WHEN is
 * decided by seo-agent from the `schedules` table, in the schedule's IANA
 * time zone via croner. The machine's own time zone and any UTC offset are
 * therefore irrelevant, and daylight-saving changes are handled by the time
 * zone database. Installation is always a manual, opt-in step.
 *
 * Unit-file and plist syntax follows launchd.plist(5), systemd.timer(5),
 * systemd.service(5), and crontab(5); verify against the man pages on the
 * target machine before installing.
 */

export const SCHEDULE_PLATFORMS = ['launchd', 'systemd', 'cron', 'server'] as const;
export type SchedulePlatform = (typeof SCHEDULE_PLATFORMS)[number];
export const TICK_INTERVALS_MINUTES = [5, 10, 15, 20, 30, 60] as const;

export interface CliInvocation {
  kind: 'dist' | 'tsx' | 'tsx-import';
  argv: string[];
  workingDirectory: string;
  /**
   * Set when dist/cli/main.js exists but was NOT used because its build stamp
   * (dist/build-info.json) is missing or does not match the version, sources,
   * or migrations on disk. The command then runs the sources instead.
   */
  rejectedDist?: {
    entry: string;
    state: 'stale' | 'unstamped';
    reasons: string[];
    /**
     * What the owner must do (buildRepairSteps): rebuild a checkout, or
     * reinstall/upgrade a packaged install or container image without src/.
     * Absent on hand-built values: the warning then uses REBUILD_STEPS.
     */
    repairSteps?: string;
  };
}

/**
 * Absolute command that runs this application's CLI without relying on PATH
 * or npm. The compiled entry (dist/cli/main.js) is used only when its build
 * stamp matches the checked-out version, src/, and migrations/; a stale or
 * unstamped dist/ (for example one left over from before `git checkout <tag>`)
 * is refused, and the command falls back to the TypeScript sources with
 * `rejectedDist` set so the caller can say so loudly.
 */
export function resolveCliInvocation(appRoot: string, nodePath: string = process.execPath, opts: { freshness?: BuildFreshness } = {}): CliInvocation {
  const dist = path.join(appRoot, 'dist', 'cli', 'main.js');
  let rejectedDist: CliInvocation['rejectedDist'];
  if (existsSync(dist)) {
    const f = opts.freshness ?? checkBuildFreshness({ appRoot });
    if (f.state === 'fresh') return { kind: 'dist', argv: [nodePath, dist], workingDirectory: appRoot };
    if (f.state === 'stale' || f.state === 'unstamped') rejectedDist = { entry: dist, state: f.state, reasons: f.reasons, repairSteps: buildRepairSteps(f) };
  }
  const extra = rejectedDist ? { rejectedDist } : {};
  const tsxCli = path.join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const src = path.join(appRoot, 'src', 'cli', 'main.ts');
  if (existsSync(tsxCli)) return { kind: 'tsx', argv: [nodePath, tsxCli, src], workingDirectory: appRoot, ...extra };
  return { kind: 'tsx-import', argv: [nodePath, '--import', 'tsx', src], workingDirectory: appRoot, ...extra };
}

export interface ScheduleSummaryForInstructions {
  jobType: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunLocal: string | null;
}

export interface InstructionInput {
  siteId: string;
  workspaceRoot: string;
  logsDir: string;
  invocation: CliInvocation;
  timezone: string;
  schedules: ScheduleSummaryForInstructions[];
  intervalMinutes?: number;
  platforms?: SchedulePlatform[];
  /** Service account for the server daemon unit (defaults to a placeholder). */
  serviceUser?: string;
}

export interface InstructionFile {
  suggestedPath: string;
  description: string;
  content: string;
}

export interface InstructionBundle {
  platform: SchedulePlatform;
  title: string;
  summary: string;
  files: InstructionFile[];
  install: string[];
  verify: string[];
  uninstall: string[];
  notes: string[];
}

export interface SchedulingInstructions {
  siteId: string;
  timezone: string;
  intervalMinutes: number;
  tickCommand: string;
  daemonCommand: string;
  schedules: ScheduleSummaryForInstructions[];
  bundles: InstructionBundle[];
  commonNotes: string[];
  warnings: string[];
}

/** POSIX shell quoting. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** systemd ExecStart argument quoting (specifiers % and variables $ are escaped). */
export function systemdQuote(s: string): string {
  const escaped = s.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /^[A-Za-z0-9_/.:=@+,-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildSchedulingInstructions(input: InstructionInput): SchedulingInstructions {
  const interval = input.intervalMinutes ?? 15;
  if (!(TICK_INTERVALS_MINUTES as readonly number[]).includes(interval)) {
    throw new RangeError(`intervalMinutes must be one of ${TICK_INTERVALS_MINUTES.join(', ')}`);
  }
  const platforms = input.platforms?.length ? input.platforms : [...SCHEDULE_PLATFORMS];
  const base = [...input.invocation.argv, '--workspace', input.workspaceRoot, '--site', input.siteId];
  const tickArgv = [...base, 'schedule', 'run', '--once'];
  const daemonArgv = [...base, 'schedule', 'run'];
  const tickCommand = tickArgv.map(shellQuote).join(' ');
  const daemonCommand = daemonArgv.map(shellQuote).join(' ');
  const label = `local.seo-agent.${input.siteId}`;
  const unit = `seo-agent-${input.siteId}`;
  const cwd = input.invocation.workingDirectory;
  const log = (name: string) => path.join(input.logsDir, name);

  const bundles: InstructionBundle[] = [];
  for (const p of platforms) {
    if (p === 'launchd') {
      const plistPath = `~/Library/LaunchAgents/${label}.plist`;
      const content = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  <string>${xmlEscape(label)}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...tickArgv.map((a) => `    <string>${xmlEscape(a)}</string>`),
        '  </array>',
        '  <key>WorkingDirectory</key>',
        `  <string>${xmlEscape(cwd)}</string>`,
        '  <key>StartInterval</key>',
        `  <integer>${interval * 60}</integer>`,
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>ProcessType</key>',
        '  <string>Background</string>',
        '  <key>StandardOutPath</key>',
        `  <string>${xmlEscape(log('scheduler-launchd.log'))}</string>`,
        '  <key>StandardErrorPath</key>',
        `  <string>${xmlEscape(log('scheduler-launchd.log'))}</string>`,
        '</dict>',
        '</plist>',
        '',
      ].join('\n');
      bundles.push({
        platform: 'launchd',
        title: 'macOS (launchd user agent)',
        summary: `Runs \`schedule run --once\` every ${interval} minutes while you are logged in, and once when the agent is loaded.`,
        files: [{ suggestedPath: plistPath, description: 'launchd user agent (review before installing)', content }],
        install: [
          'mkdir -p ~/Library/LaunchAgents',
          `# save the file above as ${plistPath}`,
          `plutil -lint ${plistPath}`,
          `launchctl bootstrap gui/$(id -u) ${plistPath}`,
        ],
        verify: [`launchctl print gui/$(id -u)/${label}`, `tail -n 50 ${shellQuote(log('scheduler-launchd.log'))}`, `${[...base, 'jobs', 'list'].map(shellQuote).join(' ')}`],
        uninstall: [`launchctl bootout gui/$(id -u)/${label}`, `rm ${plistPath}`],
        notes: [
          'A LaunchAgent runs only while your user is logged in, and nothing runs while the Mac sleeps or is shut down. The first tick after waking runs a missed slot once (catch-up "once").',
          'launchd does not wake the Mac for this agent. Wake scheduling (`pmset repeat`) depends on hardware and power settings; see `man pmset` if you want it.',
        ],
      });
    } else if (p === 'systemd') {
      const service = [
        '[Unit]',
        `Description=seo-agent scheduler tick for site ${input.siteId} (enqueues and runs due jobs)`,
        '',
        '[Service]',
        'Type=oneshot',
        `WorkingDirectory=${systemdQuote(cwd)}`,
        `ExecStart=${tickArgv.map(systemdQuote).join(' ')}`,
        '# Secrets are read from the workspace secrets file; never put them in this unit.',
        'Nice=10',
        '',
      ].join('\n');
      const timer = [
        '[Unit]',
        `Description=Run the seo-agent scheduler tick for ${input.siteId} every ${interval} minutes`,
        '',
        '[Timer]',
        `OnCalendar=${interval === 60 ? 'hourly' : `*:0/${interval}`}`,
        'Persistent=true',
        'RandomizedDelaySec=60',
        `Unit=${unit}.service`,
        '',
        '[Install]',
        'WantedBy=timers.target',
        '',
      ].join('\n');
      bundles.push({
        platform: 'systemd',
        title: 'Linux (systemd user timer)',
        summary: `A oneshot service plus a timer that fires every ${interval} minutes. Persistent=true runs a missed tick after the machine was off.`,
        files: [
          { suggestedPath: `~/.config/systemd/user/${unit}.service`, description: 'oneshot tick service', content: service },
          { suggestedPath: `~/.config/systemd/user/${unit}.timer`, description: 'timer', content: timer },
        ],
        install: [
          'mkdir -p ~/.config/systemd/user',
          `# save both files above into ~/.config/systemd/user/`,
          `systemd-analyze --user verify ~/.config/systemd/user/${unit}.service`,
          'systemctl --user daemon-reload',
          `systemctl --user enable --now ${unit}.timer`,
          '# servers without an interactive login: keep user timers running',
          'loginctl enable-linger "$USER"',
        ],
        verify: [`systemctl --user list-timers ${unit}.timer`, `journalctl --user -u ${unit}.service -n 50`, `${[...base, 'jobs', 'list'].map(shellQuote).join(' ')}`],
        uninstall: [`systemctl --user disable --now ${unit}.timer`, `rm ~/.config/systemd/user/${unit}.service ~/.config/systemd/user/${unit}.timer`, 'systemctl --user daemon-reload'],
        notes: [
          'OnCalendar here only sets how often seo-agent checks for due work (in the machine time zone). The due times themselves are computed by seo-agent in the schedule time zone.',
        ],
      });
    } else if (p === 'cron') {
      const expr = interval === 60 ? '0 * * * *' : `*/${interval} * * * *`;
      const line = `${expr} cd ${shellQuote(cwd)} && ${tickCommand} >> ${shellQuote(log('scheduler-cron.log'))} 2>&1`;
      bundles.push({
        platform: 'cron',
        title: 'cron (Linux/Unix server)',
        summary: `One crontab line that runs the tick every ${interval} minutes.`,
        files: [{ suggestedPath: '(crontab -e)', description: 'crontab entry', content: `# seo-agent scheduler tick for site ${input.siteId}; due times are computed by seo-agent in ${input.timezone}\n${line}\n` }],
        install: ['crontab -e', '# append the line above, save, and exit'],
        verify: ['crontab -l', `tail -n 50 ${shellQuote(log('scheduler-cron.log'))}`],
        uninstall: ['crontab -e', '# delete the seo-agent line, save, and exit'],
        notes: [
          'cron runs with a minimal environment, so the command uses absolute paths to node and the application.',
          'cron does not run entries that were due while the machine was off or asleep; the next tick catches up (catch-up "once"). On macOS prefer launchd.',
        ],
      });
    } else {
      const user = input.serviceUser ?? '<service-user>';
      const service = [
        '[Unit]',
        `Description=seo-agent scheduler daemon for site ${input.siteId}`,
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `User=${user}`,
        `WorkingDirectory=${systemdQuote(cwd)}`,
        `ExecStart=${daemonArgv.map(systemdQuote).join(' ')}`,
        'Restart=on-failure',
        'RestartSec=30',
        'KillSignal=SIGTERM',
        'TimeoutStopSec=120',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n');
      bundles.push({
        platform: 'server',
        title: 'Continuously running server (foreground daemon under systemd)',
        summary: '`schedule run` stays in the foreground, checks for due schedules every minute, and runs jobs; systemd restarts it on failure.',
        files: [{ suggestedPath: `/etc/systemd/system/${unit}-daemon.service`, description: 'system service running the foreground daemon', content: service }],
        install: [`sudo cp ${unit}-daemon.service /etc/systemd/system/`, 'sudo systemctl daemon-reload', `sudo systemctl enable --now ${unit}-daemon.service`],
        verify: [`systemctl status ${unit}-daemon.service`, `journalctl -u ${unit}-daemon.service -f`],
        uninstall: [`sudo systemctl disable --now ${unit}-daemon.service`, `sudo rm /etc/systemd/system/${unit}-daemon.service`, 'sudo systemctl daemon-reload'],
        notes: [
          'Use either the daemon or a periodic tick (timer/cron), not both. Both are safe together (site lock and slot compare-and-set) but redundant.',
          `On stop (SIGTERM) a running job is aborted and left "interrupted". The first tick after the next start resumes a scheduled job from its checkpoints, up to ${DEFAULT_MAX_AUTO_RESUMES} interruptions in a row; after that (or for a job you started by hand) \`schedule show\` reports the schedule BLOCKED and \`jobs resume <id>\` or \`jobs cancel <id>\` is needed. A paid stage that was in flight is never rerun automatically (reconcile, then \`jobs resume <id> --rerun-paid-stages\`).`,
          'No inbound network port is opened. Keep the workspace private (directory mode 0700) and the service user unprivileged.',
          ...(input.serviceUser ? [] : ['Replace <service-user> with the unprivileged account that owns the workspace.']),
        ],
      });
    }
  }

  const warnings: string[] = [];
  if (!input.schedules.some((s) => s.enabled)) {
    warnings.push('No schedule is enabled yet. After a successful manual run, opt in with `schedule enable weekly` and/or `schedule enable monthly`; until then a tick does nothing.');
  }
  const rejected = input.invocation.rejectedDist;
  if (rejected) {
    const repair = rejected.repairSteps ?? REBUILD_STEPS;
    // A packaged install or container image has no src/: the fallback commands cannot run either, so it is reinstalled, never rebuilt.
    const fallback =
      repair === REINSTALL_STEPS
        ? 'The commands below point at the TypeScript sources, which this installation does not have, so they cannot run either until it is reinstalled or upgraded'
        : `The commands below run the TypeScript sources through tsx instead${input.invocation.kind === 'tsx-import' ? ', which needs the tsx dev dependency (not installed here)' : ''}`;
    warnings.push(
      `${rejected.entry} was NOT used: its build is ${rejected.state === 'unstamped' ? 'unstamped' : 'out of date'} (${rejected.reasons.join('; ')}). A scheduler running it would execute old compiled code against the current workspace (\`schedule run\` refuses a build that is unstamped or does not match migrations/). ${fallback}. ${repair}`,
    );
  } else if (input.invocation.kind !== 'dist') {
    warnings.push('The command runs the TypeScript sources through tsx. For unattended use prefer `npm run build` and re-run `schedule instructions` so the compiled dist/ entry is used.');
  }
  const tempRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/var/folders', '/private/var/folders'];
  if (tempRoots.some((t) => input.workspaceRoot === t || input.workspaceRoot.startsWith(`${t}${path.sep}`))) {
    warnings.push('The workspace appears to be in a temporary directory; scheduled jobs would lose data when it is cleaned up.');
  }

  return {
    siteId: input.siteId,
    timezone: input.timezone,
    intervalMinutes: interval,
    tickCommand,
    daemonCommand,
    schedules: input.schedules,
    bundles,
    warnings,
    commonNotes: [
      'Nothing is installed automatically. Review a snippet, then install it yourself. Enable scheduling only after a successful manual run (e.g. `npm run cli -- weekly`).',
      `What runs and when lives in the database (\`schedule enable|disable\`, \`schedule show\`). The OS timer only wakes seo-agent every ${interval} minutes; seo-agent computes due times in the schedule's IANA time zone (${input.timezone}), including daylight-saving changes, independent of the machine's own time zone. No UTC offsets are used.`,
      'A sleeping, powered-off, or offline laptop cannot run jobs. After it wakes, the next tick runs a missed slot once (catch-up "once") or skips it (catch-up "skip"). For dependable weekly/monthly runs use an always-on machine or server.',
      `Runs never overlap for a site (site lock). An interrupted scheduled run is resumed from its last successful stage by the next tick (up to ${DEFAULT_MAX_AUTO_RESUMES} interruptions in a row); otherwise use \`jobs resume\`. \`schedule show\` flags a schedule that is blocked by an interrupted job.`,
      'Scheduled jobs run only in ANALYZE or RESEARCH mode and never draft or publish. Budgets and caps still apply; paid requests are never blindly retried.',
      `Secrets stay in ${path.join(input.workspaceRoot, 'secrets', 'secrets.env')} or a password-manager-injected environment. Never put secrets in plist, unit, or crontab files.`,
      `Logs: ${input.logsDir}`,
    ],
  };
}

/** Plain-text rendering for the CLI. */
export function renderInstructions(si: SchedulingInstructions): string {
  const out: string[] = [];
  out.push(`Scheduling instructions for site ${si.siteId} (opt-in; nothing has been installed)`, '');
  out.push('Schedules:');
  if (!si.schedules.length) out.push('  (none recorded)');
  for (const s of si.schedules) out.push(`  ${s.jobType}: ${s.enabled ? 'enabled' : 'disabled'}, cron "${s.cron}" in ${s.timezone}${s.nextRunLocal ? `, next ${s.nextRunLocal}` : ''}`);
  out.push('', `Tick command (run every ${si.intervalMinutes} min):`, `  ${si.tickCommand}`, '', 'Foreground daemon command:', `  ${si.daemonCommand}`, '');
  for (const w of si.warnings) out.push(`WARNING: ${w}`);
  if (si.warnings.length) out.push('');
  for (const b of si.bundles) {
    out.push(`== ${b.title} ==`, b.summary, '');
    for (const f of b.files) {
      out.push(`--- ${f.suggestedPath} (${f.description}) ---`, f.content.trimEnd(), '--- end ---', '');
    }
    out.push('Install:', ...b.install.map((c) => `  ${c}`), 'Verify:', ...b.verify.map((c) => `  ${c}`), 'Uninstall:', ...b.uninstall.map((c) => `  ${c}`));
    for (const n of b.notes) out.push(`Note: ${n}`);
    out.push('');
  }
  out.push('Important:', ...si.commonNotes.map((n) => `  - ${n}`));
  return out.join('\n');
}
