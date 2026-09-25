import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { redact, redactString } from '../security/redact.js';
import { forTerminal } from './terminal.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Human-readable lines to stderr (CLI). */
  console?: boolean;
  /** Append JSON lines to this file (workspace logs directory). */
  file?: string;
  base?: Record<string, unknown>;
}

/** Parse a log level name; unknown or empty values fall back to 'info' (never "log everything"). */
export function parseLogLevel(value: string | undefined | null): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  return Object.hasOwn(ORDER, v) ? (v as LogLevel) : 'info';
}

/**
 * Structured logger. All messages and fields are redacted before output.
 * Logs go to stderr so stdout stays clean for machine-readable command output.
 * Console lines are terminal-safe: control, bidi, and invisible characters in
 * a message or field (e.g. an ESC sequence in a scraped page title) are shown
 * as visible `[U+XXXX]` markers instead of reaching the terminal
 * (src/core/terminal.ts). The JSON log file keeps the exact (redacted) text.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? parseLogLevel(process.env.SEO_AGENT_LOG_LEVEL);
  const base = opts.base ?? {};
  if (opts.file) mkdirSync(path.dirname(opts.file), { recursive: true });

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const safeMsg = redactString(msg);
    const safeFields = redact({ ...base, ...(fields ?? {}) });
    if (opts.console !== false) {
      const extra = Object.keys(safeFields).length ? ` ${JSON.stringify(safeFields)}` : '';
      process.stderr.write(`${forTerminal(`[${lvl}] ${safeMsg}${extra}`)}\n`);
    }
    if (opts.file) {
      appendFileSync(opts.file, JSON.stringify({ at: new Date().toISOString(), level: lvl, msg: safeMsg, ...safeFields }) + '\n', {
        mode: 0o600,
      });
    }
  };

  const make = (extraBase: Record<string, unknown>): Logger => ({
    debug: (m, f) => emit('debug', m, { ...extraBase, ...f }),
    info: (m, f) => emit('info', m, { ...extraBase, ...f }),
    warn: (m, f) => emit('warn', m, { ...extraBase, ...f }),
    error: (m, f) => emit('error', m, { ...extraBase, ...f }),
    child: (f) => make({ ...extraBase, ...f }),
  });
  return make({});
}

/** Logger that records entries in memory (tests). */
export function memoryLogger(): Logger & { entries: Array<{ level: LogLevel; msg: string; fields: Record<string, unknown> }> } {
  const entries: Array<{ level: LogLevel; msg: string; fields: Record<string, unknown> }> = [];
  const make = (extra: Record<string, unknown>): Logger => ({
    debug: (m, f) => entries.push({ level: 'debug', msg: redactString(m), fields: redact({ ...extra, ...f }) }),
    info: (m, f) => entries.push({ level: 'info', msg: redactString(m), fields: redact({ ...extra, ...f }) }),
    warn: (m, f) => entries.push({ level: 'warn', msg: redactString(m), fields: redact({ ...extra, ...f }) }),
    error: (m, f) => entries.push({ level: 'error', msg: redactString(m), fields: redact({ ...extra, ...f }) }),
    child: (f) => make({ ...extra, ...f }),
  });
  return Object.assign(make({}), { entries });
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
