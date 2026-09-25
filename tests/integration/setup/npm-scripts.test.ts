import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { appRoot } from '../../../src/config/paths.js';

describe('npm convenience scripts for setup and doctor', () => {
  it('`npm run setup` and `npm run doctor` point at commands this build registers', async () => {
    const pkg = JSON.parse(readFileSync(path.join(appRoot(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const program = await buildProgram(new CliRuntime({ out: () => undefined, err: () => undefined }, {}));
    const names = new Set(program.commands.map((c) => c.name()));
    for (const script of ['setup', 'doctor']) {
      const m = /src\/cli\/main\.ts ([a-z-]+)/.exec(pkg.scripts[script] ?? '');
      expect(m, `package.json script "${script}"`).not.toBeNull();
      expect(names.has(m![1]!)).toBe(true);
    }
  });
});
