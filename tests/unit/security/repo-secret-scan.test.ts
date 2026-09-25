import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRepository } from '../../../scripts/scan-secrets.mjs';

/**
 * Regression guard for the documented release gate (`npm run security:scan`,
 * part of `npm run release:check` and CI): the repository's own working tree
 * must scan clean. A synthetic credential-shaped test value without a FAKE or
 * SYNTHETIC marker (or an allowlisted fingerprint with a reason) fails here
 * instead of failing the release gate with a false "rotate every exposed
 * credential" alarm. Only the working tree is scanned (history needs Git and
 * is covered by the CLI); finding values are never printed, only locations.
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('repository secret scan', () => {
  it('the working tree has no credential pattern outside the allowlist', async () => {
    const report = await scanRepository({ root: REPO_ROOT, history: false });
    expect(report.tree).not.toBeNull();
    expect(report.tree!.scanned).toBeGreaterThan(100);
    expect(report.findings.map((f) => `${f.path}:${f.line} rule=${f.rule} fp=${f.fingerprint}`)).toEqual([]);
    expect(report.status).toBe('clean');
  }, 120_000);
});
