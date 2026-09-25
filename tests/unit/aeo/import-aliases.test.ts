/**
 * B4A2-04: column aliasing in the AI-citation manual import uses own keys
 * only. A header or JSON key named after an Object.prototype member
 * (`constructor`, `__proto__`, `toString`, `hasOwnProperty`) is an unknown
 * column and is reported as ignored, never silently accepted. SYNTHETIC data:
 * the invented brand "Qwertle Tools" on reserved *.test hostnames.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importAiCitations } from '../../../src/aeo/import.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { aeoSiteConfig } from '../../fixtures/aeo/config.js';

const contexts: TestContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

function newCtx(): TestContext {
  const c = createTestContext({ config: aeoSiteConfig(), now: '2026-09-24T09:00:00.000Z' });
  contexts.push(c);
  return c;
}

function write(c: TestContext, name: string, content: string): string {
  const p = path.join(c.paths.root, name);
  writeFileSync(p, content);
  return p;
}

describe('AI-citation import: Object.prototype member names are unknown columns', () => {
  it('reports constructor, __proto__, toString, and hasOwnProperty CSV headers as ignored columns', () => {
    const c = newCtx();
    const f = write(
      c,
      'obs.csv',
      ['# SYNTHETIC observations', 'engine,query,date,grounded,constructor,__proto__,toString,hasOwnProperty', 'perplexity,best qwertle widgets,2026-09-20,yes,a,b,c,d'].join('\n'),
    );
    const r = importAiCitations(c, f, { preview: true });
    expect(r.rowsRead).toBe(1);
    expect(r.accepted).toBe(1);
    expect(r.warnings).toContain('Ignored columns: constructor, __proto__, tostring, hasownproperty.');
  });

  it('reports the same JSON keys as ignored (JSON.parse makes "__proto__" an own key)', () => {
    const c = newCtx();
    const f = write(
      c,
      'obs.json',
      '{"_synthetic": true, "checks": [{"engine": "perplexity", "query": "best qwertle widgets", "date": "2026-09-20", "grounded": true, "constructor": "a", "__proto__": {"polluted": true}, "toString": "c", "hasOwnProperty": "d"}]}',
    );
    const r = importAiCitations(c, f, { preview: true });
    expect(r.accepted).toBe(1);
    expect(r.warnings).toContain('Ignored columns: constructor, __proto__, toString, hasOwnProperty.');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('a file whose only "engine" column is a prototype name is missing the engine column', () => {
    const c = newCtx();
    const f = write(c, 'bad.csv', ['constructor,query,date,grounded', 'perplexity,best qwertle widgets,2026-09-20,yes'].join('\n'));
    expect(() => importAiCitations(c, f, { preview: true })).toThrow(/missing required column\(s\): engine/);
  });
});
