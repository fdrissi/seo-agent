import { Command } from 'commander';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';

export interface CliRun {
  out: string;
  err: string;
  failed: boolean;
  exitCode: number | undefined;
}

/**
 * Run one command module in-process with captured output. Only the given
 * module is registered (other areas' command modules are not loaded).
 */
export async function runCommand(
  register: (program: Command, cli: CliRuntime) => void,
  args: string[],
  opts: { onErr?: (text: string) => void } = {},
): Promise<CliRun> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({
    out: (t) => {
      out += t.endsWith('\n') ? t : `${t}\n`;
    },
    err: (t) => {
      err += t.endsWith('\n') ? t : `${t}\n`;
      opts.onErr?.(t);
    },
  });
  const program = new Command();
  program
    .name('seo-agent')
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .exitOverride()
    .configureOutput({ writeErr: (s) => (err += s), writeOut: (s) => (out += s) });
  register(program, cli);
  const before = process.exitCode;
  process.exitCode = undefined;
  let failed = false;
  try {
    await program.parseAsync(['node', 'seo-agent', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    failed = true;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = before;
  return { out, err, failed, exitCode };
}
