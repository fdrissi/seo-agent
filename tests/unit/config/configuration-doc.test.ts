import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERATED_BLOCKS, beginMarker, endMarker, generatedBlock, refreshGeneratedBlocks } from '../../../src/config/docs.js';
import { ENV_KEYS } from '../../../src/config/env.js';
import { appRoot } from '../../../src/config/paths.js';
import { describeSiteConfigFields } from '../../../src/config/site-schema.js';

const doc = () => readFileSync(path.join(appRoot(), 'docs', 'CONFIGURATION.md'), 'utf8');

describe('docs/CONFIGURATION.md stays generated from the schema', () => {
  it('contains every generated block, byte-for-byte current (run `npm run cli -- config docs` to refresh)', () => {
    const text = doc();
    for (const block of GENERATED_BLOCKS) {
      const start = text.indexOf(beginMarker(block));
      const end = text.indexOf(endMarker(block));
      expect(start, `missing ${block} block`).toBeGreaterThanOrEqual(0);
      expect(text.slice(start, end + endMarker(block).length)).toBe(generatedBlock(block));
    }
    expect(refreshGeneratedBlocks(text)).toBe(text);
  });

  it('documents every schema field and every environment variable', () => {
    const text = doc();
    for (const f of describeSiteConfigFields()) expect(text).toContain(`\`${f.path}\``);
    for (const k of ENV_KEYS) expect(text).toContain(`\`${k}\``);
  });

  it('documents override precedence and budget semantics', () => {
    const text = doc();
    for (const phrase of ['## Override precedence', 'CLI flags', 'secrets.env', 'Built-in defaults', '## Budgets', 'not price quotes', 'BEGIN IMMEDIATE', 'BUDGET_UNKNOWN_PRICE', 'stays reserved', '## Setup profiles']) {
      expect(text).toContain(phrase);
    }
  });
});
