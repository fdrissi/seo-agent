import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationStatus, StatusCheckOptions } from '../../../src/integrations/types.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { renderAll } from '../../../src/obsidian/notes.js';
import { collectDashboardStatuses, registerIntegrationStatusProvider, vaultIntegrationStatus } from '../../../src/obsidian/status.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';

let ctx: TestContext | undefined;
afterEach(() => {
  registerIntegrationStatusProvider(null);
  ctx?.cleanup();
  ctx = undefined;
});

const gsc = (over: Partial<IntegrationStatus> = {}): IntegrationStatus => ({
  id: 'google_gsc',
  state: 'missing_credentials',
  detail: 'No OAuth token stored',
  nextStep: 'Run auth google',
  sendsExternally: [],
  checkedAt: '2026-09-24T09:00:00.000Z',
  networkChecked: false,
  chargeable: false,
  ...over,
});

describe('dashboard integration statuses (offline only)', () => {
  it('always reports the vault itself, honestly, without a network check', () => {
    ctx = createTestContext();
    const writer = createVaultWriter(ctx);
    expect(vaultIntegrationStatus(ctx, writer.vaultDir)).toMatchObject({ id: 'obsidian', state: 'degraded', networkChecked: false, chargeable: false, sendsExternally: [] });
    mkdirSync(path.join(writer.vaultDir, '01 Business'), { recursive: true });
    expect(vaultIntegrationStatus(ctx, writer.vaultDir).state).toBe('ready');
    const off = createTestContext({ config: testSiteConfig({ features: { obsidian: false } }) });
    try {
      expect(vaultIntegrationStatus(off, writer.vaultDir).state).toBe('disabled');
    } finally {
      off.cleanup();
    }
  });

  it('without a registered provider, says the other integrations were not checked', async () => {
    ctx = createTestContext();
    const r = await collectDashboardStatuses(ctx, createVaultWriter(ctx).vaultDir);
    expect(r.statuses.map((s) => s.id)).toEqual(['obsidian']);
    expect(r.note).toMatch(/Other integrations were not checked/);
  });

  it('a registered provider is called with network: false and its statuses are shown on the dashboard', async () => {
    ctx = createTestContext();
    const calls: StatusCheckOptions[] = [];
    registerIntegrationStatusProvider((_c, opts) => {
      calls.push(opts);
      return [gsc(), gsc({ id: 'obsidian', state: 'unreachable' })];
    });
    const writer = createVaultWriter(ctx);
    const r = await collectDashboardStatuses(ctx, writer.vaultDir);
    expect(calls).toEqual([{ network: false }]);
    expect(r.statuses.map((s) => `${s.id}:${s.state}`)).toEqual(['obsidian:degraded', 'google_gsc:missing_credentials']);
    expect(r.note).toMatch(/Offline checks only/);
    renderAll(ctx, writer, { only: ['dashboard'], integrationStatuses: r.statuses, integrationStatusNote: r.note });
    const dash = parseNote(readFileSync(path.join(writer.vaultDir, '00 Dashboard', 'Dashboard.md'), 'utf8')).generatedRegion!;
    expect(dash).toContain('| google_gsc | missing_credentials | No OAuth token stored | Run auth google | 2026-09-24 (no network check) |');
    expect(dash).toContain('| obsidian | degraded |');
    expect(dash).toContain('Offline checks only');
    expect(dash).not.toContain('Live integration status was not collected');
  });

  it('a failing provider is reported, not hidden', async () => {
    ctx = createTestContext();
    const r = await collectDashboardStatuses(ctx, createVaultWriter(ctx).vaultDir, () => {
      throw new Error('doctor unavailable');
    });
    expect(r.statuses.map((s) => s.id)).toEqual(['obsidian']);
    expect(r.note).toMatch(/could not be checked during this render \(doctor unavailable\)/);
  });
});
