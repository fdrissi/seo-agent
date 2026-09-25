/**
 * A3-07: one dashboard builder. `vault render` (obsidian/dashboard.ts) and the
 * pipeline report stage (reports/dashboard.ts) must write the SAME
 * Dashboard.md from the same database. All data is SYNTHETIC.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { buildDashboard, DASHBOARD_REL_PATH } from '../../../src/reports/dashboard.js';
import { wikiLinkResolver } from '../../../src/reports/links.js';
import { buildNotes, renderAll } from '../../../src/obsidian/notes.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import type { IntegrationStatus } from '../../../src/integrations/types.js';
import { GSC_PROPERTY, insertRow, reportsTestConfig, seedApproval, seedBatch, seedContent, seedExperiment, seedRecommendation, seedWeeklyScenario, sid } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const statuses: IntegrationStatus[] = [
  { id: 'google_gsc', state: 'ready', detail: 'synthetic ok', sendsExternally: [], checkedAt: '2026-09-24T08:00:00.000Z', networkChecked: false, chargeable: false },
  { id: 'apify', state: 'disabled', detail: 'feature flag off', sendsExternally: [], checkedAt: '2026-09-24T08:00:00.000Z', networkChecked: false, chargeable: false },
];
const statusNote = 'Offline checks only during this run (synthetic).';

describe('one dashboard builder for the pipeline and vault render', () => {
  it('renders identical Dashboard.md notes from both paths on one database, using the last complete days', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId });
    seedExperiment(ctx.db, ctx.siteId, { pageId: s.guidePageId, status: 'observing', implementedAt: '2026-09-10T10:00:00.000Z' });
    seedContent(ctx.db, ctx.siteId);
    seedApproval(ctx.db, ctx.siteId);
    // A NON-final (incomplete) Search Console day after the latest complete date: never "current performance".
    const batch = seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_property_daily', property: GSC_PROPERTY, start: '2026-09-21', end: '2026-09-21' });
    insertRow(ctx.db, 'gsc_property_daily', { site_id: ctx.siteId, property: GSC_PROPERTY, search_type: 'web', date: '2026-09-21', date_tz: 'America/Los_Angeles', clicks: 99999, impressions: 999999, ctr: 0.1, position: 3, aggregation_type: 'byProperty', is_final: 0, revision: 1, is_current: 1, row_hash: sid('h'), batch_id: batch, collected_at: '2026-09-22T06:00:00.000Z', transformation_version: 'test@1', is_synthetic: 0 });

    const built = await buildWeeklyReport(ctx, { statuses });
    const writer = createVaultWriter(ctx);
    writer.writeGenerated(built.note);

    // Path 1: `vault render` writes the dashboard through obsidian/dashboard.ts.
    const summary = renderAll(ctx, writer, { integrationStatuses: statuses, integrationStatusNote: statusNote });
    expect(summary.errors).toEqual([]);
    const onDisk = parseNote(readFileSync(path.join(writer.vaultDir, ...DASHBOARD_REL_PATH.split('/')), 'utf8'));

    // Path 2: the pipeline report stage: buildDashboard with a VaultWriter.link resolver (src/workflows/pipelines/common.ts).
    const pipelineNote = buildDashboard(ctx, { statuses, statusNote, linkResolver: wikiLinkResolver({ link: (p, a) => writer.link(p, a), notePath: () => null }) });
    // The vault path's note, built from the same plan the render used.
    const vaultNote = buildNotes(ctx, writer, { integrationStatuses: statuses, integrationStatusNote: statusNote }).notes.find((n) => n.kind === 'dashboard')!.note!;

    expect(pipelineNote).toEqual(vaultNote);
    expect(onDisk.generatedRegion?.trim()).toBe(pipelineNote.body.trim());
    expect(onDisk.frontmatter.period_end).toBe('2026-09-20');

    // One period rule: the last 28 COMPLETE days; the non-final day is excluded from current performance.
    expect(pipelineNote.body).toContain('## Current performance (2026-08-24 to 2026-09-20)');
    expect(pipelineNote.body).not.toContain('99,999');
    expect(pipelineNote.frontmatter).toMatchObject({ period_start: '2026-08-24', period_end: '2026-09-20', period_rule: 'last 28 complete days' });
    // Links resolve to notes of this vault (report note, content farm pipeline, index).
    expect(pipelineNote.body).toMatch(/\[\[07 Reports\/Weekly\/2026-09-20 Weekly report rpt_[A-Z0-9]+\|weekly 2026-09-14 to 2026-09-20\]\]/);
    expect(pipelineNote.body).toContain('[[00 Dashboard/Index|Vault index]]');
    expect(pipelineNote.body).toContain('| google_gsc | ready | synthetic ok | - | 2026-09-24 (no network check) |');
    expect(pipelineNote.body).toContain(statusNote);

    // Re-rendering an unchanged database leaves the note unchanged (no render timestamp in the body).
    const again = renderAll(ctx, writer, { integrationStatuses: statuses, integrationStatusNote: statusNote });
    expect(again.outcomes.find((o) => o.kind === 'dashboard')?.status).toBe('unchanged');
  });
});
