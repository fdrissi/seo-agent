import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { researchSerps } from '../../../src/integrations/dataforseo/research.js';
import { researchKeywordVolumes } from '../../../src/integrations/dataforseo/volume.js';
import { dataforseoStatus } from '../../../src/integrations/dataforseo/status.js';
import { pollPendingTasks } from '../../../src/integrations/dataforseo/tasks.js';
import { redactString } from '../../../src/security/redact.js';
import type { TestContext } from '../../helpers/context.js';
import { SYNTHETIC_LOGIN, SYNTHETIC_PASSWORD, SYNTHETIC_TOKEN, clockSleep, dfsContext, fakeDataForSeo } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('DataForSEO credentials never leak', () => {
  it('keeps login, password, and the Basic token out of logs, raw files, the database, and results', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const results: unknown[] = [];
    results.push(await dataforseoStatus(ctx, { network: true }));
    results.push(await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 30_000, sleep: clockSleep(ctx) }));
    results.push(await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true }));
    fake.setPostBehavior('timeout');
    results.push(await researchSerps(ctx, ['synthetic gadget review'], { allowPaid: true, requestTimeoutMs: 20 }));
    fake.setPostBehavior('http401');
    results.push(await researchSerps(ctx, ['synthetic third query'], { allowPaid: true }));
    results.push(await pollPendingTasks(ctx));

    // The fake saw the real header (so auth was actually sent) ...
    expect(fake.fetch.calls.some((c) => c.headers.authorization === `Basic ${SYNTHETIC_TOKEN}`)).toBe(true);
    // ... but nothing we persisted or returned contains a credential.
    const secrets = [SYNTHETIC_LOGIN, SYNTHETIC_PASSWORD, SYNTHETIC_TOKEN];
    const haystacks: Array<[string, string]> = [
      ['logs', JSON.stringify(ctx.logEntries)],
      ['results', JSON.stringify(results)],
    ];
    for (const table of ['provider_requests', 'dataforseo_tasks', 'budget_reservations', 'cost_ledger', 'audit_events', 'research_cache', 'serp_snapshots', 'sources', 'keyword_metrics']) {
      haystacks.push([table, JSON.stringify(ctx.db.all(`SELECT * FROM ${table}`))]);
    }
    const raw = walk(ctx.paths.rawDir);
    expect(raw.length).toBeGreaterThan(0);
    for (const f of raw) haystacks.push([f, readFileSync(f, 'utf8')]);
    for (const f of walk(ctx.paths.logsDir)) haystacks.push([f, readFileSync(f, 'utf8')]);
    for (const [where, text] of haystacks) {
      for (const s of secrets) expect(text.includes(s), `${where} contains a credential`).toBe(false);
    }
    // Registered for redaction everywhere (including the login and the base64 token).
    expect(redactString(`x ${SYNTHETIC_LOGIN} ${SYNTHETIC_TOKEN} ${SYNTHETIC_PASSWORD}`)).toBe('x [REDACTED] [REDACTED] [REDACTED]');
  });

  it('never sends credentials in the URL or the request body', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    for (const c of fake.fetch.calls) {
      expect(c.url).not.toContain(SYNTHETIC_PASSWORD);
      expect(c.url).not.toContain('@');
      expect(c.body ?? '').not.toContain(SYNTHETIC_PASSWORD);
      expect(c.body ?? '').not.toContain(SYNTHETIC_LOGIN);
    }
  });
});
