import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importManualQuestions, parseCsv, parseImportContent, scrubPersonalData } from '../../../src/content/import.js';
import { runStagesSequentially } from '../../../src/content/pipeline.js';
import { contentStageAllowances, createContentProductionStages, createContentResearchStages } from '../../../src/content/stages.js';
import { listSignals } from '../../../src/content/store.js';
import { NO_RETRY } from '../../../src/core/retry.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { contentConfig } from '../../fixtures/content/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('manual question import', () => {
  it('parses RFC 4180 CSV with quotes, escaped quotes, and embedded newlines', () => {
    expect(parseCsv('text,count\n"Hello, ""world""",2\n"multi\nline",1\n')).toEqual([
      ['text', 'count'],
      ['Hello, "world"', '2'],
      ['multi\nline', '1'],
    ]);
  });

  it('accepts JSON arrays of strings/objects and question aliases', () => {
    expect(parseImportContent('["How do I plan?", {"question": "What about weekends?", "frequency": 3}]', 'json')).toEqual([{ text: 'How do I plan?' }, { text: 'What about weekends?', count: 3 }]);
    expect(() => parseImportContent('{"nope": 1}', 'json')).toThrow(/array/);
    expect(() => parseImportContent('title\nx', 'csv')).toThrow(/text/);
  });

  it('removes personal data before storage', () => {
    const r = scrubPersonalData('Email me at jane.doe@example.test or call +372 5555 1234 about shifts');
    expect(r.text).not.toMatch(/jane|5555/);
    expect(r.redactions).toBe(2);
    expect(scrubPersonalData('Or call (555) 123-4567 after 6pm').redactions).toBe(1);
  });

  it('keeps dates, date ranges, and numeric ranges in imported questions (they are not phone numbers)', () => {
    const q = 'How do I schedule 1,000,000 loaves between 2026-01-01 and 2026-12-31?';
    expect(scrubPersonalData(q)).toEqual({ text: q, redactions: 0 });
    for (const t of ['Plans for 2019-2026 seasons?', 'Batch sizes of 1000-2000 rolls?', 'Opening on 01.02.2026 at 06:30?', 'Starting 2026-01-05T04:30 - 2026-01-11?', 'Budget of 1 000 000 per year?']) {
      expect(scrubPersonalData(t).redactions, t).toBe(0);
    }
  });

  it('imports valid rows, reports invalid ones, and stores origin/window/limitations', () => {
    ctx = createTestContext({ config: contentConfig() });
    const file = path.join(ctx.paths.root, 'q.csv');
    writeFileSync(file, 'question,type,url,count\n"How do I schedule early shifts?",question,https://forum.example.test/t/1,4\nhi,question,,\n"Is there a flour calculator?",tool_idea,not-a-url,\n');
    const r = importManualQuestions(ctx, file);
    expect(r.accepted).toBe(1);
    expect(r.rejected.map((x) => x.row)).toEqual([2, 3]);
    const s = listSignals(ctx.db, ctx.siteId, { origins: ['manual'] });
    expect(s).toHaveLength(1);
    expect(s[0]!.limitations).toMatch(/unverified/);
    expect(s[0]!.collectionWindow?.description).toMatch(/Manual import q.csv/);
    expect(s[0]!.sourceId).toBeTruthy();
    // Re-import is idempotent.
    importManualQuestions(ctx, file);
    expect(listSignals(ctx.db, ctx.siteId, { origins: ['manual'] })).toHaveLength(1);
    // Preview writes nothing.
    const file2 = path.join(ctx.paths.root, 'q2.json');
    writeFileSync(file2, JSON.stringify(['What oven schedule works for croissants?']));
    const p = importManualQuestions(ctx, file2, { preview: true });
    expect(p.accepted).toBe(1);
    expect(listSignals(ctx.db, ctx.siteId, { origins: ['manual'] })).toHaveLength(1);
  });
});

describe('runtime prompt templates', () => {
  const root = path.resolve(__dirname, '../../../prompts');
  const CODE_VARIABLES: Record<string, string[]> = {
    'content.classify': ['allowed_intents', 'candidate_ids', 'site_name', 'languages'],
    'content.brief': ['business_name', 'target_customer', 'language', 'decision', 'intent', 'page_type', 'proposed_url', 'target_page_url', 'primary_signal_id', 'cta_target', 'primary_conversion', 'allowed_evidence_ids', 'product_fact_ids'],
    'content.draft': ['business_name', 'language', 'brand_voice', 'avoid_emojis', 'avoid_em_dashes', 'editorial_requirements', 'prohibited_claims', 'page_type', 'decision', 'intent', 'proposed_url', 'target_page_url', 'product_fact_ids', 'allowed_evidence_ids', 'revision_round', 'structured_data_rules'],
    'content.review': ['language', 'brand_voice', 'page_type', 'intent', 'decision', 'revision_round'],
  };

  for (const [id, vars] of Object.entries(CODE_VARIABLES)) {
    it(`${id} follows the prompt format and declares exactly the variables the code passes`, () => {
      const text = readFileSync(path.join(root, `${id}.md`), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
      expect(fm).toBeTruthy();
      expect(fm[1]).toMatch(new RegExp(`^id: ${id.replace('.', '\\.')}$`, 'm'));
      for (const key of ['version', 'role', 'tier', 'description', 'output_schema']) expect(fm[1]).toMatch(new RegExp(`^${key}: \\S`, 'm'));
      const declared = /^variables: \[(.*)\]$/m.exec(fm[1]!)![1]!.split(',').map((v) => v.trim());
      expect(declared.sort()).toEqual([...vars].sort());
      const body = fm[2]!;
      const sys = body.indexOf('## System');
      const usr = body.indexOf('## User');
      expect(sys).toBeGreaterThanOrEqual(0);
      expect(usr).toBeGreaterThan(sys);
      const system = body.slice(sys, usr);
      const user = body.slice(usr);
      expect(system).not.toMatch(/\{\{/); // no runtime values can alter the system prompt
      const used = [...user.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)].map((m) => m[1]!).filter((v) => v !== 'evidence');
      expect([...new Set(used)].sort()).toEqual([...vars].sort());
      expect(text).not.toMatch(/—/); // house style: no em dashes
    });
  }
});

describe('stage definitions (workflow contract)', () => {
  it('define schemas, prerequisites, evidence, timeouts, retry, cost allowance, stopping conditions, and next states', () => {
    ctx = createTestContext({ config: contentConfig() });
    const deps = { llm: null, memory: null, approvals: null, vault: null };
    const allowances = contentStageAllowances(ctx.settings);
    const stages = [...createContentResearchStages(deps, { allowances }), ...createContentProductionStages(deps, { allowances })];
    expect(stages.map((s) => s.name)).toEqual(['discover', 'dedupe', 'classify', 'cluster', 'validate_demand', 'check_existing', 'prioritize', 'brief', 'draft', 'quality_review']);
    for (const s of stages) {
      expect(s.version).toMatch(/content-stages@/);
      expect(s.input).toBeDefined();
      expect(s.output).toBeDefined();
      expect(s.evidence.requirement.length).toBeGreaterThan(5);
      expect(s.timeoutMs).toBeGreaterThan(0);
      expect(s.stoppingConditions.length).toBeGreaterThan(0);
      expect(s.next.length).toBeGreaterThan(0);
      if (Array.isArray(s.costAllowance)) {
        for (const a of s.costAllowance) {
          expect(a.provider).toBe('llm_gateway');
          expect(a.maxMicros).toBeLessThanOrEqual(ctx.settings.budgets.llmGateway.perRun);
        }
        // Stages that may spend money never retry blindly.
        expect(s.retry).toEqual(NO_RETRY);
      }
    }
    expect(stages.find((s) => s.name === 'draft')!.prerequisites).toEqual(['brief']);
    expect(stages.find((s) => s.name === 'quality_review')!.prerequisites).toEqual(['draft']);
  });

  it('the sequential runner refuses a stage whose predecessor output is missing', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const deps = { llm: null, memory: null, approvals: null, vault: null };
    const stages = createContentResearchStages(deps, { allowances: contentStageAllowances(ctx.settings) });
    const r = await runStagesSequentially(ctx, stages.slice(1), {});
    expect(r.failed?.stage).toBe('dedupe');
    expect(r.failed?.error?.message).toMatch(/prerequisite/);
  });
});
