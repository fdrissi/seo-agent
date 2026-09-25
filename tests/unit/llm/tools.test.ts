import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDatabase } from '../../../src/database/db.js';
import {
  ToolRegistry,
  assertReadOnlySql,
  createDefaultToolRegistry,
  createReadOnlyQuery,
  toolNameProblems,
  type ToolContext,
  type ToolDefinition,
} from '../../../src/security/tools.js';

function def(name: string, extra: Partial<ToolDefinition<any>> = {}): ToolDefinition<any> {
  return { name, description: 'synthetic test tool', args: z.object({ q: z.string() }), readOnly: true, siteScoped: true, resultTrust: 'first_party_measurement', handler: (a: { q: string }) => ({ echo: a.q }), ...extra };
}

const ctx: ToolContext = {
  siteId: 'site-a',
  runId: 'run_1',
  traceId: 'trace_1',
  query: { get: () => undefined, all: () => [] },
  site: { id: 'site-a', businessName: 'Synthetic Co', url: 'https://www.example.test/', offer: null, targetCustomer: null, differentiators: [], productFacts: [], approvedClaims: [], prohibitedClaims: [], languages: ['en'], countries: [] },
  now: () => new Date('2026-09-24T00:00:00Z'),
};

describe('tool registration policy', () => {
  it.each([
    'run_shell',
    'exec_sql',
    'raw_sql_query',
    'get_secret',
    'read_env',
    'update_budget',
    'set_config',
    'approve_action',
    'edit_policy',
    'grant_permission',
    'fetch_url',
    'delete_page',
    'publish_draft',
    'write_file',
  ])('refuses dangerous tool name %s', (name) => {
    expect(toolNameProblems(name).length).toBeGreaterThan(0);
    expect(() => new ToolRegistry().register(def(name))).toThrow(/Refusing to register/);
  });

  it('refuses non-read-only, non-site-scoped tools and forbidden argument keys', () => {
    const r = new ToolRegistry();
    expect(() => r.register(def('lookup_metric', { readOnly: false as unknown as true }))).toThrow(/read-only/);
    expect(() => r.register(def('lookup_metric', { siteScoped: false as unknown as true }))).toThrow(/site-scoped/);
    expect(() => r.register(def('lookup_metric', { args: z.object({ site_id: z.string() }) }))).toThrow(/site_id/);
    expect(() => r.register(def('lookup_metric', { args: z.object({ sql: z.string() }) }))).toThrow(/sql/);
    expect(() => r.register(def('lookup_metric', { args: z.string() as unknown as z.ZodType<any> }))).toThrow(/zod object/);
    r.register(def('lookup_metric'));
    expect(() => r.register(def('lookup_metric'))).toThrow(/already registered/);
  });

  it('built-in tools are read-only and produce OpenAI function specs', () => {
    const r = createDefaultToolRegistry();
    expect(r.names()).toEqual(['get_evidence', 'get_site_profile']);
    const specs = r.specs(['get_evidence']);
    expect(specs[0]!.type).toBe('function');
    expect(specs[0]!.function.name).toBe('get_evidence');
    expect(specs[0]!.function.parameters).toMatchObject({ type: 'object', required: ['evidence_id'] });
    expect(() => r.resolveAllowlist(['nope'])).toThrow(/unregistered/);
  });
});

describe('tool execution', () => {
  it('rejects unknown and non-allowlisted tools and reports them', async () => {
    const r = new ToolRegistry().register(def('lookup_metric')).register(def('lookup_other'));
    const rejected: string[] = [];
    const onRejected = (x: { name: string }) => rejected.push(x.name);
    const a = await r.execute({ id: '1', name: 'run_shell', arguments: '{"command":"ls"}' }, { allowed: new Set(['lookup_metric']), ctx, onRejected });
    expect(a.status).toBe('rejected');
    expect(a.content).toContain('tool_rejected');
    const b = await r.execute({ id: '2', name: 'lookup_other', arguments: '{"q":"x"}' }, { allowed: new Set(['lookup_metric']), ctx, onRejected });
    expect(b.status).toBe('rejected');
    expect(rejected).toEqual(['run_shell', 'lookup_other']);
  });

  it('validates arguments with zod and never throws on model-caused errors', async () => {
    const r = new ToolRegistry().register(def('lookup_metric')).register(def('lookup_failing', { handler: () => { throw new Error('boom with Bearer abcdefghijklmnop123'); } }));
    const allowed = new Set(['lookup_metric', 'lookup_failing']);
    expect((await r.execute({ id: '1', name: 'lookup_metric', arguments: 'not json' }, { allowed, ctx })).status).toBe('invalid_args');
    expect((await r.execute({ id: '2', name: 'lookup_metric', arguments: '{"q": 5}' }, { allowed, ctx })).status).toBe('invalid_args');
    const ok = await r.execute({ id: '3', name: 'lookup_metric', arguments: '{"q":"hello"}' }, { allowed, ctx });
    expect(ok).toMatchObject({ status: 'ok', content: '{"echo":"hello"}' });
    const failed = await r.execute({ id: '4', name: 'lookup_failing', arguments: '{"q":"x"}' }, { allowed, ctx });
    expect(failed.status).toBe('error');
    expect(failed.content).not.toContain('abcdefghijklmnop123');
  });

  it('truncates large results', async () => {
    const r = new ToolRegistry().register(def('lookup_big', { maxResultChars: 100, handler: () => ({ data: 'x'.repeat(1000) }) }));
    const res = await r.execute({ id: '1', name: 'lookup_big', arguments: '{"q":"a"}' }, { allowed: new Set(['lookup_big']), ctx });
    expect(res.truncated).toBe(true);
    expect(res.content).toContain('TRUNCATED tool result');
    // The original size is reported so the client can record a TruncationInfo.
    expect(res.originalChars).toBe(JSON.stringify({ data: 'x'.repeat(1000) }).length);
    expect(res.originalTokens).toBeGreaterThan(300);
  });
});

describe('read-only, site-scoped query helper', () => {
  it('accepts only single SELECT statements bound to the site id', () => {
    const db = openDatabase(':memory:');
    db.exec("CREATE TABLE t (site_id TEXT, v TEXT); INSERT INTO t VALUES ('site-a', 'x'), ('site-b', 'y');");
    const q = createReadOnlyQuery(db, 'site-a');
    expect(q.all('SELECT v FROM t WHERE site_id = ?', ['site-a'])).toEqual([{ v: 'x' }]);
    expect(() => q.all('SELECT v FROM t', [])).toThrow(/scoped to the current site/);
    expect(() => q.all('DELETE FROM t WHERE site_id = ?', ['site-a'])).toThrow(/SELECT/);
    expect(() => q.all("SELECT v FROM t WHERE site_id = ?; DROP TABLE t", ['site-a'])).toThrow(/multiple statements/);
    expect(() => assertReadOnlySql('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toThrow(/modify/);
    expect(() => assertReadOnlySql("SELECT 'delete me' AS s")).not.toThrow();
    db.close();
  });
});
