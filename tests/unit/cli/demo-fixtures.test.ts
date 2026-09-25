import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_FIXTURE_PATHS, assertDemoFixtures } from '../../../src/cli/commands/demo.js';
import { assertGoogleFixturesDir, defaultGoogleFixturesDir } from '../../../src/auth/providers.js';
import { appDirs } from '../../../src/config/paths.js';
import { AppError } from '../../../src/core/errors.js';

// A1-03: an installation without tests/fixtures (e.g. a container image built without them)
// must stop with an actionable AppError, never a raw ENOENT.
describe('demo fixture presence', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('accepts the fixtures shipped with the application', () => {
    expect(() => assertDemoFixtures()).not.toThrow();
    expect(assertGoogleFixturesDir(defaultGoogleFixturesDir())).toBe(path.join(appDirs.fixtures(), 'google'));
  });

  it('refuses a missing fixture directory with CONFIG_MISSING and a next step', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-nofixtures-'));
    dirs.push(empty);
    let err: unknown;
    try {
      assertDemoFixtures(empty);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    const a = err as AppError;
    expect(a.code).toBe('CONFIG_MISSING');
    expect(a.message).toMatch(/synthetic demo fixtures are missing/);
    expect(a.message).not.toMatch(/ENOENT/);
    expect(a.hint).toMatch(/Dockerfile copies tests\/fixtures/);
    expect(a.details).toMatchObject({ missing: [...DEMO_FIXTURE_PATHS] });

    // Partially present: only the missing ones are named.
    mkdirSync(path.join(empty, 'demo'), { recursive: true });
    writeFileSync(path.join(empty, 'demo', 'site.yaml'), '# SYNTHETIC\n');
    expect(() => assertDemoFixtures(empty)).toThrow(/google, .*pipelines\/site/);

    expect(() => assertGoogleFixturesDir(path.join(empty, 'google'))).toThrow(expect.objectContaining({ code: 'CONFIG_MISSING', hint: expect.stringMatching(/tests\/fixtures\/google/) }));
  });
});
