/**
 * The weekly `site_structure` stage output reaches the report builder input
 * (`siteStructure`). SYNTHETIC: demo-profile fixtures, offline.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteStructureSummary } from '../../../src/seo/site-structure.js';
import type { ReportOutput } from '../../../src/workflows/pipelines/common.js';
import { runPipeline } from '../../../src/workflows/pipelines/handlers.js';
import type { SiteStructureOutput } from '../../../src/workflows/pipelines/site-structure.js';
import { WEEKLY_STAGE_ORDER } from '../../../src/workflows/pipelines/weekly.js';
import type { TestContext } from '../../helpers/context.js';
import { pipelineContext, testEnv } from './helpers.js';

const seen = vi.hoisted(() => ({ inputs: [] as Array<{ kind: string; input: Record<string, unknown> }> }));

vi.mock('../../../src/reports/build.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/reports/build.js')>();
  return {
    ...mod,
    buildReportOfKind: async (...args: Parameters<typeof mod.buildReportOfKind>) => {
      seen.inputs.push({ kind: String(args[1]), input: args[2] as unknown as Record<string, unknown> });
      return mod.buildReportOfKind(...args);
    },
  };
});

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  seen.inputs.length = 0;
});

describe('weekly: site structure handed to the report builder', () => {
  it('runs site_structure after recommend and passes internal links, potential orphans, and AEO checks as report input', async () => {
    expect(WEEKLY_STAGE_ORDER.indexOf('site_structure')).toBe(WEEKLY_STAGE_ORDER.indexOf('recommend') + 1);
    expect(WEEKLY_STAGE_ORDER.indexOf('report')).toBe(WEEKLY_STAGE_ORDER.indexOf('site_structure') + 1);
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    expect(r.workflow.stages.find((s) => s.stage === 'site_structure')?.status).toBe('succeeded');
    const out = r.outputs.site_structure as SiteStructureOutput;
    expect(out.summary.synthetic).toBe(true); // demo crawl: never presented as observed
    expect(out.summary.crawl?.status).toBe('completed');
    expect(out.summary.aeo.assessed).toBeGreaterThan(0);
    expect(out.summary.orphans.coverageNote).toMatch(/Relative to crawl/);
    const weekly = seen.inputs.filter((x) => x.kind === 'weekly');
    expect(weekly).toHaveLength(1);
    const passed = weekly[0]!.input.siteStructure as SiteStructureSummary;
    expect(passed).toEqual(out.summary);
    const report = r.outputs.report as ReportOutput;
    expect(report.kind).toBe('weekly');
    // The weekly report renders the run's data (reports module): the potential orphan found by this crawl is listed.
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    expect(md).toMatch(/Internal links \(suggestions and potential orphans\)/);
    for (const o of out.summary.orphans.potentialOrphans) expect(md).toContain(new URL(o.url).pathname);
    expect(md).toMatch(/Page-level AEO/);
  }, 60_000);

  it('baseline passes no site structure (it has no site_structure stage)', async () => {
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'baseline', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    expect(seen.inputs.find((x) => x.kind === 'baseline')?.input.siteStructure).toBeUndefined();
  }, 60_000);
});
