/**
 * Helpers for the end-to-end tests. Everything is SYNTHETIC and offline:
 * tests/setup.ts makes the global fetch throw, and every adapter used here is
 * a fixture (reserved example domains only).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildProgram } from '../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../src/cli/runtime.js';

export const DEMO_START = '2026-09-20T09:00:00.000Z';

export interface TempDir {
  root: string;
  cleanup(): void;
}

export function tempDir(prefix: string): TempDir {
  const root = mkdtempSync(path.join(os.tmpdir(), `seo-agent-e2e-${prefix}-`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface CliRun {
  out: string;
  err: string;
  code: number;
  json<T = any>(): T;
}

/** Run the real CLI in-process (commands discovered from src/cli/commands) with an isolated environment. */
export async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { HOME: env.HOME ?? os.tmpdir(), ...env });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit) && !String((e as { code?: string }).code ?? '').startsWith('commander.')) throw e;
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  const stdout = out.join('\n');
  return { out: stdout, err: err.join('\n'), code, json: () => JSON.parse(stdout) };
}

/** Read-only SQLite access for assertions. */
export function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}

export function scalar(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): number {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] : 0);
}

/** Every file below `dir` with its bytes (for byte-identity checks). */
export function snapshotFiles(dir: string, filter: (rel: string) => boolean = () => true): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile() && filter(r)) out.set(r, readFileSync(a));
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir, '');
  return out;
}
