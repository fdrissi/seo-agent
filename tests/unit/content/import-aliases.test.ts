/**
 * Manual customer-question import (content/import.ts):
 * - B4A2-04: column aliasing uses own keys only; `constructor`, `__proto__`,
 *   `toString`, and `hasOwnProperty` headers or JSON keys are reported as
 *   ignored columns, never accepted under a bogus field name.
 * - B4A2-02: C0/C1 control characters (ESC sequences, BEL, a lone CR) never
 *   reach storage or the terminal.
 * SYNTHETIC questions only.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importManualQuestions, parseImportContent, parseImportRecords } from '../../../src/content/import.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

const contexts: TestContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

function newCtx(): TestContext {
  const c = createTestContext();
  contexts.push(c);
  return c;
}

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

describe('content import column aliases', () => {
  it('reports prototype-member CSV headers as ignored and keeps only accepted fields', () => {
    const csv = ['question,constructor,__proto__,toString,hasOwnProperty,notes', 'How do synthetic widgets work?,a,b,c,d,from a synthetic call'].join('\n');
    const r = parseImportRecords(csv, 'csv');
    expect(r.ignoredColumns).toEqual(['constructor', '__proto__', 'tostring', 'hasownproperty']);
    expect(r.records).toEqual([{ text: 'How do synthetic widgets work?', notes: 'from a synthetic call' }]);
    expect(Object.keys(r.records[0]!)).toEqual(['text', 'notes']);
    // Backward-compatible helper: the same records.
    expect(parseImportContent(csv, 'csv')).toEqual(r.records);
  });

  it('reports prototype-member JSON keys as ignored (JSON.parse makes "__proto__" an own key)', () => {
    const json = '[{"text": "Which synthetic widget fits a small team?", "constructor": "a", "__proto__": {"polluted": true}, "toString": "c", "hasOwnProperty": "d"}]';
    const r = parseImportRecords(json, 'json');
    expect(r.ignoredColumns).toEqual(['constructor', '__proto__', 'toString', 'hasOwnProperty']);
    expect(r.records).toEqual([{ text: 'Which synthetic widget fits a small team?' }]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('a CSV whose only question column is a prototype name has no text column', () => {
    expect(() => parseImportRecords('constructor\nHow do synthetic widgets work?', 'csv')).toThrow(/must include a "text" or "question" column/);
  });

  it('importManualQuestions returns the ignored columns (preview writes nothing)', () => {
    const c = newCtx();
    const f = path.join(c.paths.root, 'questions.csv');
    writeFileSync(f, ['text,constructor', 'How long does a synthetic widget last?,x'].join('\n'));
    const r = importManualQuestions(c, f, { preview: true });
    expect(r.accepted).toBe(1);
    expect(r.ignoredColumns).toEqual(['constructor']);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_signals WHERE site_id = ?', [c.siteId])!.n).toBe(0);
  });
});

describe('content import control characters', () => {
  it('replaces ESC/OSC/CSI sequences, BEL, C1, and a lone CR with spaces before storage; newlines are kept', () => {
    const c = newCtx();
    const f = path.join(c.paths.root, 'questions.json');
    const hostile = 'Is the synthetic widget\u001b]0;owned\u0007 safe\u001b[8m for kids\u009b2J?\rOVERWRITE';
    writeFileSync(f, JSON.stringify([{ text: hostile, notes: 'line one\r\nline two\u001b[2K' }]));
    const r = importManualQuestions(c, f);
    expect(r.accepted).toBe(1);
    const stored = r.signals[0]!;
    expect(stored.text).not.toMatch(CONTROL);
    expect(stored.text).toBe('Is the synthetic widget ]0;owned  safe [8m for kids 2J? OVERWRITE');
    const row = c.db.get<{ text: string; engagement_json: string }>('SELECT text, engagement_json FROM content_signals WHERE site_id = ?', [c.siteId])!;
    expect(row.text).not.toMatch(CONTROL);
    expect((JSON.parse(row.engagement_json) as { notes: string }).notes).toBe('line one\nline two [2K');
  });
});
