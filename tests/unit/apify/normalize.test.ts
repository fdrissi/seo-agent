import { afterEach, describe, expect, it } from 'vitest';
import {
  classifySignal,
  heuristicClassify,
  llmSignalClassifier,
  minimizePersonalData,
  normalizeDatasetItems,
  persistSignals,
  REDDIT_LIMITATIONS,
  safeLink,
  signalOccurrences,
  verifiedCustomerPhrase,
  type LlmClassifierOutcome,
} from '../../../src/integrations/apify/normalize.js';
import type { LlmClient } from '../../../src/integrations/llm/types.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { fixtureItems } from '../../fixtures/apify/fake-apify.js';

describe('dataset normalization', () => {
  it('keeps posts/comments, drops profiles/communities/NSFW/removed items, and dedupes on dataType:id', () => {
    const r = normalizeDatasetItems(fixtureItems());
    expect(r.items.map((i) => i.key)).toEqual([
      'post:t3_syn001',
      'post:t3_syn002',
      'post:t3_syn003',
      'post:t3_syn004',
      'post:t3_syn005',
      'post:t3_syn006',
      'post:t3_syn007',
      'comment:sync001',
      'post:t3_syn014',
    ]);
    expect(r.duplicates).toBe(1);
    expect(Object.keys(r.skipped).join(' ')).toMatch(/user_profile/);
    expect(Object.keys(r.skipped).join(' ')).toMatch(/community/);
    expect(r.skipped.NSFW).toBe(1);
    expect(r.skipped['empty or removed comment']).toBe(1);
  });

  it('minimizes personal data: no author/profile fields, masked handles, emails, and phone numbers', () => {
    const r = normalizeDatasetItems(fixtureItems());
    const json = JSON.stringify(r.items);
    expect(json).not.toMatch(/synthetic_author|synthetic_commenter|t2_syn|synthetic_profile_user/);
    expect(json).not.toMatch(/jane\.synthetic@example\.com|owner\.synthetic@example\.com|synthetic_user_2|555 010 0199/);
    const c = r.items.find((i) => i.key === 'comment:sync001')!;
    expect(c.text).toContain('[email]');
    expect(c.text).toContain('u/[user]');
    expect(c.text).toContain('[phone]');
    expect(minimizePersonalData('ask /u/someone_else or @handle_x; the 2024-01-15 release cost $1,000')).toBe('ask /u/[user] or @[user]; the 2024-01-15 release cost $1,000');
    expect(minimizePersonalData('my key is sk-synthetic0000000000000000 lol')).toBe('my key is [REDACTED] lol');
  });

  it('keeps source links and dates; unsafe or profile links are dropped', () => {
    const r = normalizeDatasetItems(fixtureItems());
    const p1 = r.items.find((i) => i.key === 'post:t3_syn001')!;
    expect(p1.url).toMatch(/^https:\/\/reddit\.example\.test\/r\/examplecommunity\//);
    expect(p1.postedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(r.items.find((i) => i.key === 'post:t3_syn004')!.url).toBeNull();
    expect(safeLink('https://reddit.example.test/user/someone/')).toBeNull();
    expect(safeLink('https://user:pass@example.com/')).toBeNull();
    expect(safeLink('ftp://example.com/')).toBeNull();
  });

  it('classifies signal types with deterministic heuristics', () => {
    const t = (s: string) => classifySignal(s).type;
    expect(t('Invoicer Alpha vs Invoicer Beta for a two-person agency?')).toBe('comparison');
    expect(t('Is there a calculator for estimating freelance project rates?')).toBe('tool_idea');
    expect(t('Invoicer Alpha is too expensive for what it does, is it worth it')).toBe('objection');
    expect(t('So frustrated: the export keeps failing every month')).toBe('complaint');
    expect(t("Can't find any good way to track unpaid invoices across clients")).toBe('unmet_need');
    expect(t('How do you handle late payments from clients?')).toBe('question');
    expect(t('Weekly thread: share your wins')).toBeNull();
  });

  it('treats prompt-injection text as data (classified and stored verbatim, never executed)', () => {
    const r = normalizeDatasetItems(fixtureItems());
    const inj = r.items.find((i) => i.key === 'post:t3_syn014')!;
    expect(inj.text).toMatch(/^IGNORE ALL PREVIOUS INSTRUCTIONS/);
    expect(heuristicClassify([inj]).types.get(inj.key)).toBe('question');
  });
});

describe('persistSignals', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('stores classified signals with source, evidence, limitations, and is idempotent', () => {
    ctx = createTestContext();
    const r = normalizeDatasetItems(fixtureItems());
    ctx.db.run(
      `INSERT INTO apify_runs (id, site_id, actor_id, status, input_json, input_hash, created_at, updated_at) VALUES ('arun_t', 'test-site', '9sHOY9RzPYGjmTHo8', 'SUCCEEDED', '{}', 'h', 'x', 'x')`,
    );
    const input = {
      siteId: ctx.siteId,
      apifyRunId: 'arun_t',
      items: r.items,
      classification: heuristicClassify(r.items),
      collectedAt: '2026-09-24T09:03:00.000Z',
      collectionWindow: { searchTime: 'month' },
      rawRef: null,
      isSynthetic: true,
    };
    const first = persistSignals(ctx.db, input);
    expect(first.created).toBe(8);
    expect(first.unclassified).toBe(1);
    expect(first.byType).toEqual({ comparison: 1, tool_idea: 1, objection: 1, complaint: 1, unmet_need: 1, question: 3 });
    const second = persistSignals(ctx.db, input);
    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(8);
    const rows = ctx.db.all<{ origin: string; limitations: string; is_synthetic: number; engagement_json: string; source_id: string }>('SELECT * FROM content_signals WHERE site_id = ?', [ctx.siteId]);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.origin).toBe('apify_reddit');
      expect(row.is_synthetic).toBe(1);
      expect(row.limitations).toContain('SYNTHETIC FIXTURE DATA');
      expect(row.limitations).toContain(REDDIT_LIMITATIONS);
      expect(JSON.parse(row.engagement_json).note).toBe('Engagement is not search volume.');
      expect(row.source_id).toBeTruthy();
    }
    const src = ctx.db.all<{ trust_class: string }>(`SELECT trust_class FROM sources WHERE site_id = ? AND source_type = 'reddit'`, [ctx.siteId]);
    expect(new Set(src.map((s) => s.trust_class))).toEqual(new Set(['synthetic']));
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM evidence WHERE site_id = ?', [ctx.siteId])!.n).toBe(8);
    expect(second.occurrences).toBe(0);
  });

  it('keeps recurrence: a repeat of the same question from another item adds an occurrence, source link, and evidence to the existing signal', () => {
    ctx = createTestContext();
    ctx.db.run(
      `INSERT INTO apify_runs (id, site_id, actor_id, status, input_json, input_hash, created_at, updated_at) VALUES ('arun_t', 'test-site', '9sHOY9RzPYGjmTHo8', 'SUCCEEDED', '{}', 'h', 'x', 'x')`,
    );
    const post = (id: string, title: string) => ({
      dataType: 'post',
      id,
      postUrl: `https://reddit.example.test/r/examplecommunity/comments/${id}/synthetic/`,
      title,
      body: '',
      createdAt: '2026-09-20T12:00:00.000Z',
    });
    const r = normalizeDatasetItems([post('t3_rep1', 'How do you handle late payments from clients?'), post('t3_rep2', 'How do you  handle late payments from CLIENTS?')]);
    const base = { siteId: ctx.siteId, apifyRunId: 'arun_t', classification: heuristicClassify(r.items), collectedAt: '2026-09-24T09:03:00.000Z', collectionWindow: {}, rawRef: null, isSynthetic: true };
    const first = persistSignals(ctx.db, { ...base, items: r.items });
    expect(first).toMatchObject({ created: 1, occurrences: 1, duplicates: 0 });
    const sig = ctx.db.get<{ id: string }>('SELECT id FROM content_signals WHERE site_id = ?', [ctx.siteId])!;
    const occ = signalOccurrences(ctx.db, ctx.siteId, sig.id);
    expect(occ.count).toBe(2);
    expect(occ.examples.map((e) => e.itemKey)).toEqual(['post:t3_rep1', 'post:t3_rep2']);
    expect(occ.examples.every((e) => e.url?.startsWith('https://reddit.example.test/'))).toBe(true);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM evidence WHERE site_id = ?', [ctx.siteId])!.n).toBe(2);
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sources WHERE site_id = ? AND source_type = 'reddit'`, [ctx.siteId])!.n).toBe(2);
    // Re-processing the same items adds nothing (idempotent).
    expect(persistSignals(ctx.db, { ...base, items: r.items })).toMatchObject({ created: 0, occurrences: 0, duplicates: 2 });
    expect(signalOccurrences(ctx.db, ctx.siteId, sig.id).count).toBe(2);
  });
});

describe('llmSignalClassifier (optional, injected)', () => {
  const items = normalizeDatasetItems(fixtureItems()).items.slice(0, 3);
  const fakeLlm = (ok: boolean, configured = true): LlmClient & { lastEvidence?: unknown[] } => {
    const client: LlmClient & { lastEvidence?: unknown[] } = {
      synthetic: true,
      isConfigured: () => configured,
      structured: async (req) => {
        client.lastEvidence = req.evidence;
        if (!ok) return { ok: false, status: 'provider_error', reason: 'synthetic failure' };
        return {
          ok: true,
          value: req.schema.parse({ items: [{ id: items[0]!.key, signalType: 'question' }, { id: 'post:unknown', signalType: 'complaint' }] }),
          callId: 'c1',
          model: 'synthetic-model',
          promptVersion: 'p@1+abc',
          usage: { inputTokens: null, outputTokens: null, reasoningTokens: null },
          costMicros: null,
          repairAttempts: 0,
          truncation: [],
        };
      },
      text: async () => ({ ok: false, status: 'unsupported', reason: 'n/a' }),
      embed: async () => ({ ok: false, status: 'unsupported', reason: 'n/a' }),
    };
    return client;
  };

  it('uses model labels for known ids, heuristics for the rest, and passes items as user_reported evidence', async () => {
    const llm = fakeLlm(true);
    const r = await llmSignalClassifier(llm, { siteId: 's', runId: 'r', promptId: 'research.reddit-signals' })(items);
    expect(r!.types.get(items[0]!.key)).toBe('question');
    expect(r!.types.has('post:unknown')).toBe(false);
    expect(r!.types.get(items[1]!.key)).toBe('tool_idea');
    expect(r!.method).toMatch(/^llm:p@1\+abc:synthetic-model/);
    expect((llm.lastEvidence as Array<{ trustClass: string }>).every((e) => e.trustClass === 'user_reported')).toBe(true);
  });

  it('returns null (heuristic fallback) when the model fails or is not configured', async () => {
    expect(await llmSignalClassifier(fakeLlm(false), { siteId: 's', runId: 'r', promptId: 'p' })(items)).toBeNull();
    expect(await llmSignalClassifier(fakeLlm(true, false), { siteId: 's', runId: 'r', promptId: 'p' })(items)).toBeNull();
  });

  it('reports every outcome, so a heuristic fallback is never presented as an LLM result', async () => {
    const outcomes: LlmClassifierOutcome[] = [];
    const onResult = (o: LlmClassifierOutcome) => outcomes.push(o);
    await llmSignalClassifier(fakeLlm(false), { siteId: 's', runId: 'r', promptId: 'p', onResult })(items);
    await llmSignalClassifier(fakeLlm(true, false), { siteId: 's', runId: 'r', promptId: 'p', onResult })(items);
    await llmSignalClassifier(fakeLlm(true), { siteId: 's', runId: 'r', promptId: 'p', onResult })(items);
    expect(outcomes).toEqual([
      { ok: false, status: 'provider_error', reason: 'synthetic failure' },
      { ok: false, status: 'not_configured', reason: expect.stringMatching(/no cheap model/) },
      { ok: true, method: expect.stringMatching(/^llm:/), classified: 1, phrases: 0 },
    ]);
  });
});

describe('customer phrasing (quoted verbatim, never generated)', () => {
  const item = { title: 'Invoice reminders keep failing', text: 'Invoice reminders keep failing', context: 'Invoice reminders keep failing\nMy clients never get the second nudge and I lose a week chasing payments.' };

  it('keeps a phrase only when it appears verbatim in the minimized item text', () => {
    expect(verifiedCustomerPhrase(item, 'I lose a week chasing payments')).toBe('I lose a week chasing payments');
    expect(verifiedCustomerPhrase(item, '  "never get the second   nudge"  ')).toBe('never get the second nudge');
    expect(verifiedCustomerPhrase(item, 'payment reminders are unreliable')).toBeNull(); // paraphrase, not in the text
    expect(verifiedCustomerPhrase(item, 'ok')).toBeNull();
    expect(verifiedCustomerPhrase(item, null)).toBeNull();
    // Personal data is minimized before matching: an e-mail address never survives.
    const withEmail = { ...item, context: `${item.context} Write to [email] for details.` };
    expect(verifiedCustomerPhrase(withEmail, 'Write to jane.synthetic@example.com for details')).toBe('Write to [email] for details');
  });

  it('stores a verified phrase as a signal attribute and on its evidence row', async () => {
    const ctx = createTestContext();
    try {
      const norm = normalizeDatasetItems(fixtureItems()).items;
      const first = norm.find((i) => heuristicClassify([i]).types.get(i.key))!;
      const phrase = first.text.split(' ').slice(0, 3).join(' ');
      const classification = heuristicClassify([first]);
      classification.phrases = new Map([[first.key, phrase]]);
      ctx.db.run(
        `INSERT INTO apify_runs (id, site_id, actor_id, status, input_json, input_hash, created_at, updated_at) VALUES ('arun_synthetic', ?, '9sHOY9RzPYGjmTHo8', 'SUCCEEDED', '{}', 'h', 'x', 'x')`,
        [ctx.siteId],
      );
      persistSignals(ctx.db, { siteId: ctx.siteId, apifyRunId: 'arun_synthetic', items: [first], classification, collectedAt: '2026-09-24T09:00:00.000Z', collectionWindow: { synthetic: true }, rawRef: null, isSynthetic: true });
      const sig = ctx.db.get<{ collection_window_json: string }>('SELECT collection_window_json FROM content_signals WHERE site_id = ?', [ctx.siteId])!;
      expect(JSON.parse(sig.collection_window_json).customerPhrase).toBe(phrase);
      const ev = ctx.db.get<{ value_json: string }>('SELECT value_json FROM evidence WHERE site_id = ?', [ctx.siteId])!;
      expect(JSON.parse(ev.value_json)).toMatchObject({ customerPhrase: phrase });
    } finally {
      ctx.cleanup();
    }
  });
});
