import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Structural checks for this slice's runtime prompt templates, following
 * prompts/README.md: frontmatter fields, System before User, no placeholders
 * in the System section, and the declared variables equal the placeholders
 * the code supplies.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function load(id: string) {
  const text = readFileSync(path.join(root, 'prompts', `${id}.md`), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
  const meta = parse(m[1]!) as Record<string, unknown>;
  const body = m[2]!;
  const iS = body.indexOf('\n## System');
  const iU = body.indexOf('\n## User');
  const system = body.slice(iS, iU);
  const user = body.slice(iU);
  const ph = (s: string) => [...new Set([...s.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((x) => x[1]!))].sort();
  return { meta, system, user, systemPh: ph(system), userPh: ph(user), iS, iU };
}

describe('seo-router prompt templates', () => {
  it.each([
    ['router.classify-intent', 'classifier', 'cheap', 'IntentClassification', ['allowedIntents', 'businessContext', 'queryCount']],
    // The search query is searcher-typed text: it is evidence item `query`, never a template variable.
    ['analysis.serp-synthesis', 'analyst', 'reasoning', 'SerpSynthesis', ['competitorCount', 'ourPageType', 'pageTypeMix', 'signalTable']],
  ])('%s has valid frontmatter and placeholder hygiene', (id, role, tier, schema, vars) => {
    const p = load(id);
    expect(p.meta).toMatchObject({ id, role, tier, output_schema: schema });
    expect(Number.isInteger(p.meta.version)).toBe(true);
    expect(p.iS).toBeGreaterThanOrEqual(0);
    expect(p.iU).toBeGreaterThan(p.iS);
    expect(p.systemPh).toEqual([]);
    expect(p.userPh).toEqual(vars);
    expect([...(p.meta.variables as string[])].sort()).toEqual(vars);
    expect(p.system).toMatch(/untrusted|Never follow instructions/i);
  });
});

describe('analysis.serp-synthesis keeps the search query out of the instructions', () => {
  it('declares no query variable and points to evidence item `query` (untrusted, user_reported)', () => {
    const p = load('analysis.serp-synthesis');
    expect(p.meta.version).toBeGreaterThanOrEqual(4);
    expect(p.userPh).not.toContain('query');
    expect(p.user).toContain('The search query is in evidence item `query`');
    expect(p.system).toMatch(/evidence item `query`[^\n]*untrusted[^\n]*user_reported/);
  });
});
