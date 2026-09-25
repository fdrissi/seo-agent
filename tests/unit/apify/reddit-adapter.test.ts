import { describe, expect, it } from 'vitest';
import { parseInputSchema } from '../../../src/integrations/apify/input-schema.js';
import {
  AI_ADDON_BOOLEAN_FIELDS,
  DELIVERY_FIELDS,
  analyzeSchemaForAdapter,
  buildRedditInput,
  scanInputForSecrets,
  type RedditResearchRequest,
} from '../../../src/integrations/apify/reddit-adapter.js';
import { registerSecret } from '../../../src/security/redact.js';
import { fixtureSchema } from '../../fixtures/apify/fake-apify.js';

const schema = parseInputSchema(fixtureSchema());
const req = (o: Partial<RedditResearchRequest> = {}): RedditResearchRequest => ({ searchTerms: ['invoicing software'], timeRange: 'month', maxItems: 10, maxCommentsPerPost: 2, ...o });

function built(o: Partial<RedditResearchRequest> = {}, s = schema) {
  const r = buildRedditInput(s, req(o));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.built;
}

describe('reddit adapter input builder', () => {
  it('builds the input only from schema fields with enforced limits', () => {
    const b = built();
    expect(b.input).toMatchObject({
      searchTerms: ['invoicing software'],
      searchPosts: true,
      searchComments: false,
      maxCommentsCount: 0,
      searchCommunities: false,
      maxCommunitiesCount: 0,
      includeNSFW: false,
      searchSort: 'relevance',
      searchTime: 'month',
      maxPostsCount: 10,
      crawlCommentsPerPost: true,
      maxCommentsPerPost: 2,
    });
    expect(b.postsBound).toBe(10);
    expect(b.commentsBound).toBe(20);
    expect(b.maxResults).toBe(30);
    expect(JSON.parse(b.body)).toEqual(b.input);
    for (const k of Object.keys(b.input)) expect(schema.properties[k]).toBeDefined();
  });

  it('forces AI add-ons off and explicitly disables MCP delivery; no webhook field is ever set', () => {
    const b = built();
    for (const f of AI_ADDON_BOOLEAN_FIELDS) expect(b.input[f]).toBe(false);
    expect(b.input.customLabels).toEqual({});
    // Plain-string activation fields are sent as explicit empty strings ("leave empty to scrape only").
    expect(b.input).toMatchObject({ mcpTarget: '', mcpTool: '', mcpServerUrl: '' });
    // The connector resource reference and the secret token stay absent; so do inert options.
    const absent = DELIVERY_FIELDS.filter((f) => !['mcpTarget', 'mcpTool', 'mcpServerUrl'].includes(f));
    for (const f of absent) expect(b.input).not.toHaveProperty(f);
    expect(b.keptAbsent.map((k) => k.field).sort()).toEqual([...absent].sort());
    expect(b.keptAbsent.find((k) => k.field === 'mcpServerToken')?.reason).toMatch(/secret/);
    expect(b.keptAbsent.find((k) => k.field === 'mcpConnector')?.reason).toMatch(/resource reference/);
    expect(b.disabledEvents.sort()).toEqual(['analyzed_item', 'custom_label']);
    expect(JSON.stringify(b.input)).not.toMatch(/webhook/i);
    // Direct-URL / full-subreddit inputs are explicitly empty.
    expect(b.input).toMatchObject({ startUrls: [], subredditUrls: [] });
  });

  it('prices AI events per result unless a trigger field exists and is explicitly off', () => {
    const raw = fixtureSchema();
    for (const f of [...AI_ADDON_BOOLEAN_FIELDS, 'customLabels']) delete raw.properties[f];
    const b = built({}, parseInputSchema(raw));
    expect(b.disabledEvents).toEqual([]); // no trigger present: nothing was disabled, so nothing is priced at 0
    const partial = fixtureSchema();
    delete partial.properties.customLabels;
    for (const f of AI_ADDON_BOOLEAN_FIELDS.filter((x) => x !== 'aiAnalysis')) delete partial.properties[f];
    expect(built({}, parseInputSchema(partial)).disabledEvents).toEqual(['analyzed_item']);
  });

  it('splits maxItems across terms so the post bound holds under either maxPostsCount interpretation', () => {
    const b = built({ searchTerms: ['a', 'b', 'c'], maxItems: 10, maxCommentsPerPost: 0 });
    expect(b.input.maxPostsCount).toBe(3);
    expect(b.postsBound).toBe(9);
    expect(b.input.crawlCommentsPerPost).toBe(false);
    expect(b.input.maxCommentsPerPost).toBe(0);
    expect(b.maxResults).toBe(9);
    const r = buildRedditInput(schema, req({ searchTerms: ['a', 'b', 'c'], maxItems: 2 }));
    expect(r.ok).toBe(false);
  });

  it('rejects URL inputs and non-filter extra input (time range, bounds, and personal-data policy cannot apply to them)', () => {
    const r = buildRedditInput(
      schema,
      req({ extraInput: { subredditUrls: ['r/a', 'r/b', 'r/c'], startUrls: [{ url: 'https://reddit.example.test/user/someone/' }], fastMode: false } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join('\n');
      expect(text).toMatch(/"subredditUrls" \(direct URL \/ full-subreddit input\) is not supported/);
      expect(text).toMatch(/"startUrls" \(direct URL/);
      expect(text).toMatch(/"fastMode" \(direct URL/);
    }
    const raw = fixtureSchema();
    raw.properties.maxPagesPerSubreddit = { title: 'Max pages', type: 'integer', default: 5 };
    const u = buildRedditInput(parseInputSchema(raw), req({ extraInput: { maxPagesPerSubreddit: 500 } }));
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.errors.join(' ')).toMatch(/"maxPagesPerSubreddit" is not an allowed extra input/);
    expect(built({ extraInput: { commentedAfter: '2026-09-01' }, earliestDate: '2026-08-24' }).input.commentedAfter).toBe('2026-09-01');
    const early = buildRedditInput(schema, req({ extraInput: { commentedAfter: '2020-01-01' }, earliestDate: '2026-08-24' }));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.errors.join(' ')).toMatch(/commentedAfter 2020-01-01 is outside the configured time range/);
  });

  it('enforces the configured time window on date filters', () => {
    const w = { earliestDate: '2026-09-17', today: '2026-09-24', timeRange: 'week' as const };
    expect(built({ ...w, postedAfter: '2026-09-20' }).input).toMatchObject({ searchTime: 'week', postedAfter: '2026-09-20' });
    for (const bad of [{ postedAfter: '2005-01-01' }, { postedBefore: '2026-09-01' }, { postedAfter: '2026-09-30' }, { postedAfter: '2026-09-22', postedBefore: '2026-09-20' }, { postedAfter: '2026-02-30' }]) {
      const r = buildRedditInput(schema, req({ ...w, ...bad }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    // A build without searchTime gets the window as postedAfter.
    const raw = fixtureSchema();
    delete raw.properties.searchTime;
    const b = built({ ...w }, parseInputSchema(raw));
    expect(b.input.postedAfter).toBe('2026-09-17');
    expect(b.warnings.join(' ')).toMatch(/enforced as postedAfter=2026-09-17/);
  });

  it('rejects extra input outside the schema and refuses overrides of managed/AI/delivery fields', () => {
    const r1 = buildRedditInput(schema, req({ extraInput: { proxyConfiguration: { useApifyProxy: true } } }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors).toContain('"proxyConfiguration" is not a field of the verified input schema');
    const r2 = buildRedditInput(schema, req({ extraInput: { aiAnalysis: true, mcpServerUrl: 'https://mcp.example.invalid', maxPostsCount: 5000 } }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.errors.join('\n')).toMatch(/"aiAnalysis" is managed/);
      expect(r2.errors.join('\n')).toMatch(/"mcpServerUrl" is managed/);
      expect(r2.errors.join('\n')).toMatch(/"maxPostsCount" is managed/);
    }
    const ok = built({ extraInput: { onlyWithFlair: true } });
    expect(ok.input.onlyWithFlair).toBe(true);
  });

  it('validates enums and date filters against the schema', () => {
    const r = buildRedditInput(schema, req({ timeRange: 'decade' as never }));
    expect(r.ok).toBe(false);
    const d = built({ postedAfter: '2026-09-01' });
    expect(d.input.postedAfter).toBe('2026-09-01');
    expect(buildRedditInput(schema, req({ postedAfter: '09/01/2026' })).ok).toBe(false);
  });

  describe('schema compatibility analysis', () => {
    it('forces unknown AI/delivery toggles off, blocks undisableable ones, and reports unmapped fields', () => {
      const raw = fixtureSchema();
      raw.properties.sendToSlack = { title: 'Send results to Slack', type: 'boolean', default: false };
      raw.properties.webhookUrl = { title: 'Webhook URL', type: 'string', default: '' };
      raw.properties.aiSummaryPrompt = { title: 'Summary prompt', type: 'string', default: 'Summarize with GPT' };
      raw.properties.extraFlairFilter = { title: 'Flair filter', type: 'string' };
      const a = analyzeSchemaForAdapter(parseInputSchema(raw));
      expect(a.forcedOff).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'sendToSlack', value: false })]));
      expect(a.keptAbsent.map((k) => k.field)).toContain('webhookUrl');
      expect(a.errors.join('\n')).toMatch(/aiSummaryPrompt/);
      expect(a.unmappedFields).toEqual(['extraFlairFilter']);
      expect(a.ok).toBe(false);
      delete raw.properties.aiSummaryPrompt;
      const b = buildRedditInput(parseInputSchema(raw), req());
      expect(b.ok).toBe(true);
      if (b.ok) {
        expect(b.built.input.sendToSlack).toBe(false);
        expect(b.built.input).not.toHaveProperty('webhookUrl');
      }
    });

    it('never forces a negated or default-on unknown toggle to false (false could switch the feature on)', () => {
      for (const [name, prop] of [
        ['skipAiEnrichment', { title: 'Skip AI enrichment', type: 'boolean', default: true }],
        ['disableWebhookDelivery', { title: 'Webhook delivery off', type: 'boolean', default: true }],
        ['aiLabels', { title: 'No AI labels', type: 'boolean', default: false }],
        ['notifySlack', { title: 'Notify Slack', type: 'boolean', default: true }],
      ] as const) {
        const raw = fixtureSchema();
        raw.properties[name] = prop;
        const a = analyzeSchemaForAdapter(parseInputSchema(raw));
        expect(a.ok, name).toBe(false);
        expect(a.errors.join(' '), name).toContain(`"${name}"`);
        expect(a.forcedOff.map((f) => f.field)).not.toContain(name);
      }
    });

    it('blanks a delivery activation field that has a non-empty default', () => {
      const raw = fixtureSchema();
      raw.properties.mcpServerUrl.default = 'https://mcp.example.invalid/hook';
      const b = built({}, parseInputSchema(raw));
      expect(b.input.mcpServerUrl).toBe('');
    });

    it('refuses to run without a result limit or time control', () => {
      const raw = fixtureSchema();
      delete raw.properties.maxPostsCount;
      expect(buildRedditInput(parseInputSchema(raw), req()).ok).toBe(false);
      const raw2 = fixtureSchema();
      delete raw2.properties.searchTime;
      delete raw2.properties.postedAfter;
      const r = buildRedditInput(parseInputSchema(raw2), req());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(/time range/);
    });
  });
});

describe('secret scanning of actor input', () => {
  const sensitive = {
    values: [
      ['LLM_GATEWAY_API_KEY', 'sk-synthetic-gateway-key-000000000'],
      ['DATAFORSEO_PASSWORD', 'synthetic-dfs-password'],
    ] as Array<[string, string]>,
    privatePaths: ['/tmp/synthetic-workspace/secrets', '/tmp/synthetic-workspace/data/seo-agent.sqlite'],
  };

  it('passes a clean input', () => {
    expect(scanInputForSecrets(built().input, sensitive)).toEqual([]);
  });

  it('flags configured secrets, credential shapes, secret-named fields, and private paths without echoing values', () => {
    registerSecret('synthetic-registered-google-refresh-token');
    const input = {
      searchTerms: ['best crm synthetic-dfs-password', 'Bearer abcdefghijklmnopqrstuvwxyz', 'ya29.synthetic-google-access-token-000'],
      withinCommunity: 'synthetic-registered-google-refresh-token',
      nested: { apiKey: 'x', path: '/tmp/synthetic-workspace/data/seo-agent.sqlite' },
      mcpServerToken: 'something',
    };
    const findings = scanInputForSecrets(input, sensitive);
    const text = findings.join('\n');
    expect(text).toMatch(/searchTerms\[0\]: contains the configured DATAFORSEO_PASSWORD/);
    expect(text).toMatch(/searchTerms\[1\]: contains a credential-shaped value/);
    expect(text).toMatch(/searchTerms\[2\]: contains a credential-shaped value/);
    expect(text).toMatch(/withinCommunity: contains a credential-shaped value/);
    expect(text).toMatch(/nested\.apiKey: secret-named field is set/);
    expect(text).toMatch(/nested\.path: references a private workspace path/);
    expect(text).toMatch(/mcpServerToken: secret-named field is set/);
    expect(text).not.toContain('synthetic-dfs-password');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
