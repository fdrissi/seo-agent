import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { fixedClock } from '../../../src/core/clock.js';
import { workspacePaths, type WorkspacePaths } from '../../../src/config/paths.js';
import { LayeredSecretStore } from '../../../src/config/secrets.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { openDatabase } from '../../../src/database/db.js';
import { migrate } from '../../../src/database/migrate.js';
import { runSetupWizard, type SetupWizardOptions, type SetupWizardResult } from '../../../src/setup/wizard.js';
import { ScriptedPromptIO, type ScriptedAnswer, type ScriptedPromptOptions } from '../../../src/setup/prompt-io.js';

/** Synthetic answers for a minimal Core setup (reserved example domains only). */
export const BASE_ANSWERS: Record<string, ScriptedAnswer> = {
  profile: 'core',
  'site.id': 'acme-test',
  'site.businessName': 'Acme Test Co (synthetic)',
  'site.url': 'https://www.example.test/',
};

export interface TestWorkspace {
  tmp: string;
  root: string;
  paths: WorkspacePaths;
  cleanup(): void;
}

export function makeWorkspace(opts: { init?: boolean; migrate?: boolean } = {}): TestWorkspace {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-setup-'));
  const root = path.join(tmp, 'workspace');
  if (opts.init !== false) {
    initWorkspace(root);
    if (opts.migrate) {
      const db = openDatabase(workspacePaths(root).dbFile);
      try {
        migrate(db);
      } finally {
        db.close();
      }
    }
  }
  return { tmp, root, paths: workspacePaths(root), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

export function secretStore(ws: TestWorkspace, env: NodeJS.ProcessEnv = {}): LayeredSecretStore {
  return new LayeredSecretStore(ws.paths.secretsEnvFile, env);
}

export async function runWizard(
  ws: TestWorkspace,
  answers: Record<string, ScriptedAnswer>,
  opts: Partial<Omit<SetupWizardOptions, 'io' | 'paths'>> & { script?: ScriptedPromptOptions } = {},
): Promise<{ result: SetupWizardResult; io: ScriptedPromptIO }> {
  const io = new ScriptedPromptIO(answers, opts.script ?? {});
  const { script: _script, ...rest } = opts;
  const result = await runSetupWizard({
    io,
    paths: ws.paths,
    secrets: rest.secrets ?? secretStore(ws),
    clock: fixedClock('2026-09-24T09:00:00.000Z'),
    offline: false,
    ...rest,
  });
  return { result, io };
}

export interface CliRun {
  out: string;
  err: string;
  exitCode: number | undefined;
  json<T = any>(): T;
}

export async function runCli(ws: TestWorkspace, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { HOME: ws.tmp, SEO_AGENT_WORKSPACE: ws.root, ...env });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
  process.exitCode = undefined;
  const stdout = out.join('\n');
  return { out: stdout, err: err.join('\n'), exitCode, json: () => JSON.parse(stdout) };
}
