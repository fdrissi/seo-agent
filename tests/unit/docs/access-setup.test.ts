import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appRoot } from '../../../src/config/paths.js';

/**
 * Spec section 30: docs/ACCESS_SETUP.md walks the owner through steps 1-8 and
 * must "include a first-month checklist covering baseline/tracking, one
 * researched opportunity, one approved implementation, and sufficient
 * observation", without forcing premature results after four weeks.
 * These checks read the Markdown only; nothing runs and nothing touches the network.
 */

const docsDir = path.join(appRoot(), 'docs');
const accessSetup = readFileSync(path.join(docsDir, 'ACCESS_SETUP.md'), 'utf8');
const firstMonth = readFileSync(path.join(docsDir, 'FIRST_MONTH.md'), 'utf8');

/** GitHub-style heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function headings(markdown: string, level: number): string[] {
  const prefix = `${'#'.repeat(level)} `;
  let inFence = false;
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    else if (!inFence && line.startsWith(prefix)) out.push(line.slice(prefix.length).trim());
  }
  return out;
}

/** The body of a `## ` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) return '';
  const next = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, next < 0 ? undefined : next);
}

/** First-column cells of the Markdown table rows in a block of text (header and divider excluded). */
function tableItems(block: string): string[] {
  const rows = block.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
  return rows.slice(1).map((r) => r.split('|')[1]!.trim());
}

const CHECKLIST_ITEMS = ['Baseline and tracking', 'One researched opportunity', 'One approved implementation', 'Sufficient observation'];

describe('docs/ACCESS_SETUP.md first-month checklist (spec 30)', () => {
  const checklist = section(accessSetup, '10. First-month checklist');

  it('has a numbered section 10 with a Contents entry that links to it', () => {
    expect(headings(accessSetup, 2)).toContain('10. First-month checklist');
    expect(accessSetup).toContain('10. [First-month checklist](#10-first-month-checklist)');
    expect(slug('10. First-month checklist')).toBe('10-first-month-checklist');
  });

  it('lists every spec item in the end-of-month table, plus an explicit no-forced-results row', () => {
    const items = tableItems(checklist);
    for (const item of CHECKLIST_ITEMS) expect(items, `missing checklist row "${item}"`).toContain(item);
    expect(items).toContain('No forced results');
    expect(checklist).toMatch(/inconclusive\*\*, not negative/);
  });

  it('keeps the observation minimums in line with the documented defaults', () => {
    expect(checklist).toContain('at least 28 days');
    expect(checklist).toContain('56 for low-traffic pages');
    expect(firstMonth).toContain('The default minimum window is 28 days');
  });

  it('links the detailed week-by-week plan, which covers the same items', () => {
    expect(checklist).toContain('[FIRST_MONTH.md](FIRST_MONTH.md)');
    expect(existsSync(path.join(docsDir, 'FIRST_MONTH.md'))).toBe(true);
    const monthItems = tableItems(section(firstMonth, 'End-of-month checklist'));
    for (const item of CHECKLIST_ITEMS) expect(monthItems, `FIRST_MONTH.md is missing "${item}"`).toContain(item);
  });

  it('keeps the Contents list complete: every numbered section is listed and every entry resolves', () => {
    const numbered = headings(accessSetup, 2).filter((h) => /^\d+\. /.test(h));
    expect(numbered.length).toBeGreaterThanOrEqual(11);
    const contents = section(accessSetup, 'Contents');
    for (const h of numbered) expect(contents, `Contents is missing "${h}"`).toContain(`](#${slug(h)})`);
    const anchors = new Set([...headings(accessSetup, 2), ...headings(accessSetup, 3)].map(slug));
    for (const m of contents.matchAll(/\]\(#([^)]+)\)/g)) expect(anchors, `Contents links to a missing heading #${m[1]}`).toContain(m[1]);
  });

  it('every relative document link in ACCESS_SETUP.md points at a file that exists', () => {
    const missing: string[] = [];
    for (const m of accessSetup.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)) {
      const target = m[1]!;
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(path.join(docsDir, target))) missing.push(target);
    }
    expect(missing).toEqual([]);
  });
});
