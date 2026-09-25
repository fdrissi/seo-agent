import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LicenseReport } from '../../../scripts/check-licenses.mjs';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-licenses.mjs');

// SYNTHETIC package tree: names and authors are fabricated.
const MIT_TEXT = 'MIT License\n\nCopyright (c) 2024 Synthetic Author One\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...\n';
const APACHE_NOTICE = 'Synthetic Apache Package\nCopyright 2023 Synthetic Foundation\n\nThis product includes software developed at Synthetic Labs (https://example.invalid/).\n';

function write(dir: string, rel: string, content: string) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}

function makeTree(opts: { mystery?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-licenses-'));
  const deps: Record<string, string> = { 'synthetic-mit': '1.0.0', 'synthetic-apache': '2.0.0' };
  if (opts.mystery) deps['synthetic-mystery'] = '0.1.0';
  write(dir, 'package.json', JSON.stringify({ name: 'fixture', version: '0.0.0', license: 'UNLICENSED', dependencies: deps, devDependencies: { 'synthetic-gpl-tool': '3.0.0' } }));
  const packages: Record<string, unknown> = {
    '': { name: 'fixture', version: '0.0.0', license: 'UNLICENSED', dependencies: deps },
    'node_modules/synthetic-mit': { version: '1.0.0', license: 'MIT' },
    'node_modules/synthetic-mit/node_modules/synthetic-nested-isc': { version: '0.2.0', license: 'ISC' },
    'node_modules/synthetic-apache': { version: '2.0.0', license: 'Apache-2.0' },
    'node_modules/synthetic-gpl-tool': { version: '3.0.0', license: 'GPL-3.0-only', dev: true },
    'node_modules/@synthetic/platform-only': { version: '1.0.0', license: 'MIT', optional: true, os: ['aix'] },
  };
  if (opts.mystery) packages['node_modules/synthetic-mystery'] = { version: '0.1.0' };
  write(dir, 'package-lock.json', JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }));
  write(dir, 'node_modules/synthetic-mit/package.json', JSON.stringify({ name: 'synthetic-mit', version: '1.0.0', license: 'MIT', repository: 'git+https://example.invalid/synthetic-mit.git' }));
  write(dir, 'node_modules/synthetic-mit/LICENSE', MIT_TEXT);
  write(dir, 'node_modules/synthetic-mit/node_modules/synthetic-nested-isc/package.json', JSON.stringify({ name: 'synthetic-nested-isc', version: '0.2.0', license: 'ISC' }));
  write(dir, 'node_modules/synthetic-mit/node_modules/synthetic-nested-isc/LICENSE.md', 'ISC License\n\nCopyright (c) 2022, Synthetic Author Two\n');
  write(dir, 'node_modules/synthetic-apache/package.json', JSON.stringify({ name: 'synthetic-apache', version: '2.0.0', license: 'Apache-2.0' }));
  write(dir, 'node_modules/synthetic-apache/LICENSE', 'Apache License\nVersion 2.0, January 2004\n(synthetic abbreviated text)\n');
  write(dir, 'node_modules/synthetic-apache/NOTICE', APACHE_NOTICE);
  write(dir, 'node_modules/synthetic-gpl-tool/package.json', JSON.stringify({ name: 'synthetic-gpl-tool', version: '3.0.0', license: 'GPL-3.0-only' }));
  if (opts.mystery) write(dir, 'node_modules/synthetic-mystery/package.json', JSON.stringify({ name: 'synthetic-mystery', version: '0.1.0' }));
  write(dir, 'node_modules/.package-lock.json', '{}');
  return dir;
}

function run(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('scripts/check-licenses.mjs', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('with an unknown runtime license', () => {
    beforeEach(() => {
      dir = makeTree({ mystery: true });
    });

    it('flags missing runtime licenses as errors and dev-only copyleft as warnings', () => {
      const r = run(dir, '--json');
      expect(r.status).toBe(1);
      const report = JSON.parse(r.stdout) as LicenseReport;
      const byName = Object.fromEntries(report.packages.map((p) => [p.name, p]));
      expect(byName['synthetic-mit']).toMatchObject({ scope: 'runtime', category: 'permissive', direct: true });
      expect(byName['synthetic-nested-isc']).toMatchObject({ scope: 'runtime', category: 'permissive', direct: false });
      expect(byName['synthetic-gpl-tool']).toMatchObject({ scope: 'dev', category: 'strong-copyleft' });
      expect(byName['synthetic-mystery']).toMatchObject({ scope: 'runtime', category: 'missing' });
      expect(report.problems).toContainEqual(expect.objectContaining({ severity: 'error', package: 'synthetic-mystery@0.1.0' }));
      expect(report.problems).toContainEqual(expect.objectContaining({ severity: 'warning', package: 'synthetic-gpl-tool@3.0.0' }));
      expect(report.notInstalledLockEntries).toBe(1);
      expect(report.projectLicense).toEqual({ packageJson: 'UNLICENSED', licenseFile: false, selected: false });
    });
  });

  describe('with permissive runtime dependencies', () => {
    beforeEach(() => {
      dir = makeTree();
    });

    it('generates THIRD_PARTY_NOTICES.md for runtime deps only, preserving NOTICE files and copyright lines', () => {
      const w = run(dir, '--write');
      expect(w.status).toBe(0);
      const notices = readFileSync(path.join(dir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
      expect(notices).toContain('### synthetic-apache@2.0.0');
      expect(notices).toContain(APACHE_NOTICE.trim());
      expect(notices).toContain('Copyright (c) 2024 Synthetic Author One');
      expect(notices).toContain('Copyright (c) 2022, Synthetic Author Two');
      expect(notices).toContain('https://example.invalid/synthetic-mit');
      expect(notices).not.toContain('synthetic-gpl-tool');
      expect(notices).toMatch(/not yet been selected/);
      expect(notices).toMatch(/does not cover, and grants no rights to, third-party services/);
      // Deterministic: regenerating produces identical content.
      expect(run(dir, '--check').status).toBe(0);
    });

    it('--check fails when the notices file is missing or stale', () => {
      expect(existsSync(path.join(dir, 'THIRD_PARTY_NOTICES.md'))).toBe(false);
      const missing = run(dir, '--check');
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain('MISSING');
      run(dir, '--write');
      write(dir, 'node_modules/synthetic-mit/LICENSE', `${MIT_TEXT}\nCopyright (c) 2025 Synthetic Author Three\n`);
      const stale = run(dir, '--check');
      expect(stale.status).toBe(1);
      expect(stale.stdout).toContain('STALE');
      // Without --check a stale file is only a warning; --strict turns warnings into failures.
      expect(run(dir).status).toBe(0);
      expect(run(dir, '--strict').status).toBe(1);
    });
  });

  it('this repository: runtime licenses are all recognized and THIRD_PARTY_NOTICES.md is current', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-licenses-noop-'));
    const r = spawnSync(process.execPath, [SCRIPT, '--root', ROOT, '--json', '--check'], { encoding: 'utf8' });
    const report = JSON.parse(r.stdout) as LicenseReport;
    expect(report.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(report.notices.upToDate).toBe(true);
    expect(r.status).toBe(0);
  });
});
