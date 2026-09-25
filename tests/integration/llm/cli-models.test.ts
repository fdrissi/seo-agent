import { appendFileSync } from 'node:fs';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../../helpers/context.js';
import { register } from '../../../src/cli/commands/models.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { TEST_KEY, VALID_CLASSIFICATION, chatCompletion, fakeGateway, llmTestContext, type FakeGateway } from './harness.js';

let ctx: TestContext | undefined;
let gw: FakeGateway;
let out: string[];
let err: string[];

function program(): Command {
  const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, {});
  const p = new Command();
  p.exitOverride()
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .configureOutput({ writeErr: (s) => err.push(s), writeOut: (s) => out.push(s) });
  register(p, cli);
  return p;
}

async function run(args: string[]): Promise<{ json: any; text: string }> {
  out = [];
  try {
    await program().parseAsync(['-w', ctx!.paths.root, ...args], { from: 'user' });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const text = out.join('\n');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* human output */
  }
  return { json, text };
}

beforeEach(() => {
  out = [];
  err = [];
  gw = fakeGateway({ chat: [() => chatCompletion('OK', { usage: { prompt_tokens: 700, completion_tokens: 2, total_tokens: 702, cost: 0.000106 } })] });
  ctx = llmTestContext({ fetch: gw.fetch });
  // The CLI builds its own context from the workspace: the key lives in the protected secrets file.
  appendFileSync(ctx.paths.secretsEnvFile, `LLM_GATEWAY_API_KEY=${TEST_KEY}\n`);
  globalThis.fetch = gw.fetch as typeof fetch;
});

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  process.exitCode = undefined;
});

describe('models CLI', () => {
  it('models list --json shows verified capabilities and prices from the catalog', async () => {
    const { json } = await run(['--json', 'models', 'list']);
    expect(json.catalog.authenticated).toBe(true);
    expect(json.catalog.total).toBe(8);
    const cheap = json.models.find((m: { id: string }) => m.id === 'synthetic-cheap-structured');
    expect(cheap).toMatchObject({ kind: 'chat', structuredOutputs: true, tools: true, temperature: true, inputPerMillion: '$0.15', outputPerMillion: '$0.60', pricePrompt: '0.15e-6' });
    const reasoner = json.models.find((m: { id: string }) => m.id === 'synthetic-reasoner');
    expect(reasoner.temperature).toBe(false);
    const { json: emb } = await run(['--json', 'models', 'list', '--embedding']);
    expect(emb.models.map((m: { id: string }) => m.id)).toEqual(['synthetic-embed-small']);
    expect(gw.chatBodies).toHaveLength(0);
    expect(JSON.stringify(json)).not.toContain(TEST_KEY);
  });

  it('models list (human) prints a table and the no-substitution note', async () => {
    const { text } = await run(['models', 'list', '--filter', 'reasoner']);
    expect(text).toContain('synthetic-reasoner');
    expect(text).toContain('never substituted automatically');
  });

  it('models check reports configured models and the key budget without spending', async () => {
    const { json } = await run(['--json', 'models', 'check']);
    expect(json.ok).toBe(true);
    expect(json.checks.map((c: { tier: string; status: string }) => [c.tier, c.status])).toEqual([
      ['cheap', 'ok'],
      ['reasoning', 'ok'],
      ['embedding', 'ok'],
    ]);
    expect(json.key.limitMicros).toBe(5_000_000);
    expect(gw.chatBodies).toHaveLength(0);
  });

  it('models test refuses without an explicit cap or without --confirm-spend', async () => {
    const a = await run(['--json', 'models', 'test']);
    expect(a.json.ok).toBe(false);
    expect(a.json.error.code).toBe('POLICY_DENIED');
    expect(a.json.error.message).toContain('--max-usd');
    out = [];
    const b = await run(['--json', 'models', 'test', '--max-usd', '0.01']);
    expect(b.json.error.code).toBe('POLICY_DENIED');
    expect(b.json.error.message).toContain('--confirm-spend');
    expect(gw.chatBodies).toHaveLength(0);
  });

  it('models test --confirm-spend --max-usd sends exactly one capped, budgeted request and reports its cost', async () => {
    const { json } = await run(['--json', 'models', 'test', '--confirm-spend', '--max-usd', '0.01']);
    expect(json.ok).toBe(true);
    expect(json.cap).toBe('$0.01');
    expect(json.output).toBe('OK');
    expect(json.costMicros).toBe(106);
    expect(gw.chatBodies).toHaveLength(1);
    expect(gw.chatBodies[0].max_tokens).toBe(16);
    expect(gw.chatBodies[0].messages[1].content).toContain('Reply with exactly: OK');
  });

  it('models test --dry-run previews the capped request without sending or reserving', async () => {
    const { json } = await run(['--json', '--dry-run', 'models', 'test', '--max-usd', '0.01']);
    expect(json.ok).toBe(false);
    expect(json.status).toBe('disabled');
    expect(json.reason).toMatch(/Dry run: would call synthetic-cheap-structured/);
    expect(gw.chatBodies).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('models test refuses when the upper bound exceeds the cap (nothing sent)', async () => {
    const { json } = await run(['--json', 'models', 'test', '--confirm-spend', '--max-usd', '0.000001']);
    expect(json.ok).toBe(false);
    expect(json.status).toBe('budget_exceeded');
    expect(json.reason).toContain('exceeds the explicit cap');
    expect(gw.chatBodies).toHaveLength(0);
    expect(process.exitCode).toBe(3);
  });

  it('models check exits non-zero for an invalid configured model and lists similar ids without substituting', async () => {
    const other = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-cheap' } });
    appendFileSync(other.paths.secretsEnvFile, `LLM_GATEWAY_API_KEY=${TEST_KEY}\n`);
    const prev = ctx;
    ctx = other;
    try {
      const { json } = await run(['--json', 'models', 'check']);
      expect(json.ok).toBe(false);
      const cheap = json.checks.find((c: { tier: string }) => c.tier === 'cheap');
      expect(cheap.status).toBe('invalid_model');
      expect(cheap.similar).toContain('synthetic-cheap-structured');
      expect(process.exitCode).toBe(2);
    } finally {
      prev?.cleanup();
    }
  });

  it('--offline without a cached catalog fails honestly', async () => {
    const { json } = await run(['--json', '--offline', 'models', 'list']);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('INTEGRATION_DISABLED');
    expect(gw.fetch.calls).toHaveLength(0);
  });

  it('check uses the same cached catalog after list (no second models request)', async () => {
    await run(['--json', 'models', 'list']);
    out = [];
    await run(['--json', 'models', 'check']);
    expect(gw.modelsRequests).toHaveLength(1);
    expect(VALID_CLASSIFICATION).toBeTruthy();
  });
});
