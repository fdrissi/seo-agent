import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { forTerminal as approvalsForTerminal } from '../../../src/approvals/display.js';
import { buildProgram, fatalLine } from '../../../src/cli/main.js';
import { renderCompetitor } from '../../../src/cli/commands/crawl.js';
import { stdoutExportText } from '../../../src/cli/commands/data.js';
import { renderDaemonTick, renderTick } from '../../../src/cli/commands/schedule.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { insertItem } from '../../../src/content/store.js';
import { crawlCompetitorPages } from '../../../src/crawler/competitor.js';
import { AppError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import { forTerminal, hasUnsafeTerminalChars, markControlChars, stripControlChars } from '../../../src/core/terminal.js';
import { escapeMd } from '../../../src/reports/links.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { mapResolver, send, startServer, testFetcher, type TestServer } from '../../integration/crawler/helpers.js';

/**
 * B4A2-02: untrusted text (competitor titles, content item titles, stored
 * reports, log messages) must never reach the operator's terminal as ANSI /
 * OSC / CSI escape sequences. Every human output path shows control, bidi, and
 * invisible characters as visible [U+XXXX] markers. SYNTHETIC data only.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const CSI_C1 = '\u009b';
/** OSC retitles the terminal; CSI 8m conceals the rest of the line; CSI 2K erases it; a lone CR returns to column 0. */
const HOSTILE = `Widget guide${ESC}]0;owned${BEL}${ESC}[8m hidden${ESC}[2K${CSI_C1}31m\rOVERWRITE‮gnp.exe`;
// Any C0 control except \t and \n, DEL, C1, and the bidi override.
const RAW_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‮]/;

interface Run {
  out: string;
  err: string;
  exitCode: number;
}

async function runCli(root: string, args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--site', 'test-site', '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

const contexts: TestContext[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (contexts.length) contexts.pop()!.cleanup();
  process.exitCode = undefined;
});

function newCtx(opts: Parameters<typeof createTestContext>[0] = {}): TestContext {
  const c = createTestContext(opts);
  contexts.push(c);
  return c;
}

describe('core/terminal', () => {
  it('forTerminal shows every control, bidi, and invisible character as a visible marker; newlines and tabs are kept', () => {
    const s = forTerminal(`${HOSTILE}\nnext\tcol​­`);
    expect(s).not.toMatch(RAW_CONTROL);
    expect(s).toContain('[U+001B]]0;owned[U+0007]');
    expect(s).toContain('[U+001B][8m hidden');
    expect(s).toContain('[U+009B]31m');
    expect(s).toContain('[U+000D]OVERWRITE');
    expect(s).toContain('[U+202E]gnp.exe');
    expect(s).toContain('\nnext\tcol[U+200B][U+00AD]');
    expect(forTerminal(s)).toBe(s); // idempotent: output already printed safely is never double-marked
    expect(forTerminal(null)).toBe('');
    expect(hasUnsafeTerminalChars(HOSTILE)).toBe(true);
    expect(hasUnsafeTerminalChars('plain text\nwith\ttabs, ünïcödé and עברית')).toBe(false);
  });

  it('follows the same rules as the approvals review output (src/approvals/display.ts)', () => {
    const sample = `${HOSTILE}؜᠎⁦x⁩﻿\u0085\u007F\t\n`;
    expect(forTerminal(sample)).toBe(approvalsForTerminal(sample));
  });

  it('stripControlChars removes C0/C1 controls for ingestion but keeps text, newlines, tabs, and bidi marks of real RTL text', () => {
    expect(stripControlChars(`a${ESC}[31mb${BEL}c${CSI_C1}d\re`)).toBe('a [31mb c d e');
    expect(stripControlChars('line\nnext\tcol ‏שלום')).toBe('line\nnext\tcol ‏שלום');
    expect(markControlChars(`x${ESC}y‮z`)).toBe('x[U+001B]y‮z');
  });
});

describe('CliRuntime output paths', () => {
  it('prints human output terminal-safe and keeps --json output exact', () => {
    const out: string[] = [];
    const cli = new CliRuntime({ out: (t) => void out.push(t), err: () => undefined }, {});
    cli.print({}, { title: HOSTILE }, (r: { title: string }) => `Title: ${r.title}`);
    expect(out[0]).not.toMatch(RAW_CONTROL);
    expect(out[0]).toContain('Title: Widget guide[U+001B]]0;owned[U+0007][U+001B][8m hidden');
    cli.print({ json: true }, { title: HOSTILE }, (r: { title: string }) => r.title);
    // JSON keeps the stored value exactly (C0 controls are \u-escaped by JSON itself).
    expect(JSON.parse(out[1]!)).toEqual({ title: HOSTILE });
  });

  it('writes errors, hints, error lists, and every stderr notice terminal-safe', () => {
    const err: string[] = [];
    const cli = new CliRuntime({ out: () => undefined, err: (t) => void err.push(t) }, {});
    expect(() => cli.fail(new AppError('VALIDATION_FAILED', `Unknown column "${HOSTILE}"`, { hint: `Rename ${ESC}[2K`, details: { errors: [`row 2: ${ESC}]0;x${BEL}`] } }), false)).toThrow(CliExit);
    expect(() => cli.fail(new Error(`boom ${ESC}[8m`), false)).toThrow(CliExit);
    cli.io.err(`Notice: ${HOSTILE}`);
    for (const line of err) expect(line, line).not.toMatch(RAW_CONTROL);
    expect(err.join('\n')).toContain('Error [VALIDATION_FAILED]: Unknown column "Widget guide[U+001B]]0;owned[U+0007]');
    expect(err.join('\n')).toContain('Next step: Rename [U+001B][2K');
    expect(err.join('\n')).toContain('  - row 2: [U+001B]]0;x[U+0007]');
    expect(err.join('\n')).toContain('Error: boom [U+001B][8m');
    expect(err.join('\n')).toContain('Notice: Widget guide[U+001B]');
    process.exitCode = undefined;
  });
});

describe('console logger', () => {
  it('writes terminal-safe console lines (message and fields) while the JSON log file keeps the exact text', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const log = createLogger({ level: 'info' });
    log.warn(`Fetched ${HOSTILE}`, { title: `${ESC}]0;owned${BEL}`, c1: `${CSI_C1}2J` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(RAW_CONTROL);
    expect(lines[0]).toMatch(/\n$/);
    expect(lines[0]).toContain('[warn] Fetched Widget guide[U+001B]]0;owned[U+0007]');
    expect(lines[0]).toContain('[U+009B]2J');
  });
});

describe('report Markdown escaping (escapeMd)', () => {
  it('neutralizes ESC sequences, C1 controls, and a lone carriage return', () => {
    const s = escapeMd(`Title${ESC}]0;owned${BEL} one\rtwo\r\nthree${CSI_C1}2J`);
    expect(s).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(s).toBe('Title\\[U+001B\\]\\]0;owned\\[U+0007\\] one two three\\[U+009B\\]2J');
  });
});

describe('CLI commands that print untrusted text', () => {
  it('`content list` shows an ESC/OSC/CSI title as visible markers', async () => {
    const ctx = newCtx();
    insertItem(ctx.db, { siteId: ctx.siteId, title: `Synthetic ${HOSTILE}`, primaryQuestion: null, stage: 'prioritized', intent: 'informational', clusterId: null, isSynthetic: true, now: '2026-09-24T09:00:00.000Z' });
    const r = await runCli(ctx.paths.root, ['content', 'list']);
    expect(r.exitCode).toBe(0);
    expect(r.out).not.toMatch(RAW_CONTROL);
    expect(r.out).toContain('Synthetic Widget guide[U+001B]]0;owned[U+0007][U+001B][8m hidden[U+001B][2K[U+009B]31m[U+000D]OVERWRITE[U+202E]gnp.exe');
    // --json keeps the stored title exactly.
    const json = await runCli(ctx.paths.root, ['--json', 'content', 'list']);
    expect((JSON.parse(json.out) as Array<{ title: string }>)[0]!.title).toBe(`Synthetic ${HOSTILE}`);
  });

  it('`report show` prints a stored Markdown report terminal-safe (the stored file is unchanged)', async () => {
    const ctx = newCtx();
    const rel = 'test-site/weekly/2026-09-14_2026-09-20-rpt_synthetic_terminal.md';
    const file = path.join(ctx.paths.reportsDir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const md = `# Weekly report (SYNTHETIC)\n\nTop page: ${HOSTILE}\n`;
    writeFileSync(file, md);
    ctx.db.run('INSERT INTO reports (id, site_id, kind, period_start, period_end, markdown_path, json_path, content_hash, is_synthetic, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      'rpt_synthetic_terminal',
      ctx.siteId,
      'weekly',
      '2026-09-14',
      '2026-09-20',
      rel,
      null,
      'synthetic-hash',
      1,
      '2026-09-21T06:00:00.000Z',
    ]);
    const r = await runCli(ctx.paths.root, ['report', 'show', 'weekly']);
    expect(r.exitCode, r.err).toBe(0);
    expect(r.out).not.toMatch(RAW_CONTROL);
    expect(r.out).toContain('# Weekly report (SYNTHETIC)\n\nTop page: Widget guide[U+001B]]0;owned[U+0007][U+001B][8m hidden');
  });
});

describe('crawl competitor: a hostile <title> never reaches the terminal', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer((req, res, url) => {
      if (url.pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain' });
      if (url.pathname === '/guide')
        // Entities decode to ESC/BEL/CR; a raw C1 CSI (U+009B) is kept by the HTML parser (the entity &#x9b; would decode to U+203A).
        return send(res, 200, '<html><head><title>Widget guide&#x1b;]0;owned&#x07;&#x1b;[8m\u009b2J&#13;X</title></head><body><main><h1>Guide&#x1b;[2K</h1><p>A synthetic competitor page about widgets and nothing else.</p></main></body></html>');
      return send(res, 404, 'nope');
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('stores the title without control characters and renders it safely', async () => {
    const config = testSiteConfig({ crawl: { requestDelayMs: 0 }, research: { competitors: [{ domain: 'rival.test', name: 'Rival (synthetic)' }] } as never });
    const ctx = newCtx({ config, fetch: fakeFetch([]) });
    const r = await crawlCompetitorPages(ctx, [{ url: `${server.origin('rival.test')}/guide`, query: 'synthetic widgets' }], { fetcher: testFetcher({ resolver: mapResolver({ 'rival.test': '127.0.0.1' }) }) });
    const page = r.pages[0]!;
    expect(page.status).toBe('fetched');
    expect(page.title).toBe('Widget guide ]0;owned [8m 2J X');
    const out: string[] = [];
    new CliRuntime({ out: (t) => void out.push(t), err: () => undefined }, {}).print({}, r, renderCompetitor);
    expect(out.join('\n')).not.toMatch(RAW_CONTROL);
    expect(out.join('\n')).toContain('"Widget guide ]0;owned [8m 2J X"');
  });
});

describe('output paths that bypass CliRuntime.print (C1-10)', () => {
  const tick = {
    siteId: 'test-site',
    at: '2026-09-24T09:00:00.000Z',
    items: [{ jobType: 'weekly', scheduledFor: '2026-09-24T06:00:00.000Z', action: 'skipped', reason: `note ${HOSTILE}` }],
    recovered: [{ jobId: 'job_synthetic', type: 'weekly', reason: `crashed ${ESC}]0;owned${BEL}` }],
    ran: [],
    needsAttention: [{ jobId: 'job_synthetic', type: 'weekly', status: 'interrupted', reason: `error text ${CSI_C1}2J` }],
    handledElsewhere: [],
  } as unknown as Parameters<typeof renderTick>[0];

  it('`schedule run` (foreground daemon) prints each tick terminal-safe and redacted', () => {
    expect(renderTick(tick)).toMatch(RAW_CONTROL); // what the daemon used to print
    const line = renderDaemonTick(tick);
    expect(line).not.toMatch(RAW_CONTROL);
    expect(line).toContain('skipped weekly slot 2026-09-24T06:00:00.000Z: note Widget guide[U+001B]]0;owned[U+0007]');
    expect(line).toContain('recovered job_synthetic (weekly) as interrupted: crashed [U+001B]]0;owned[U+0007]');
    expect(line).toContain('ATTENTION: error text [U+009B]2J');
    expect(line.split('\n').length).toBe(renderTick(tick).split('\n').length);
  });

  it('the last-resort "Fatal:" line is terminal-safe and redacted', async () => {
    const line = await fatalLine(new Error(`boom ${HOSTILE} Bearer synthetic${'x'.repeat(20)}`));
    expect(line).not.toMatch(RAW_CONTROL);
    expect(line).toMatch(/^Fatal: boom Widget guide\[U\+001B\]\]0;owned\[U\+0007\]/);
    expect(line).not.toContain('x'.repeat(20));
    expect(line).toContain('Bearer [REDACTED');
    expect(line.endsWith('\n')).toBe(true);
    expect(await fatalLine(`plain ${ESC}[2K`)).toBe('Fatal: plain [U+001B][2K\n');
  });

  it('`data export --out -` output is terminal-safe on a terminal and exact when piped', () => {
    const csv = `query\r\n${HOSTILE}\r\n`;
    const tty = stdoutExportText(csv, true);
    expect(tty.marked).toBe(true);
    expect(tty.text).not.toMatch(RAW_CONTROL);
    expect(tty.text.startsWith('query\nWidget guide[U+001B]]0;owned[U+0007]')).toBe(true);
    expect(stdoutExportText(csv, false)).toEqual({ text: `query\r\n${HOSTILE}`, marked: false });
  });
});
