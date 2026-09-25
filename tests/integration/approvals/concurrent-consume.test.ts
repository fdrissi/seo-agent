import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { sha256 } from '../../../src/core/hash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'consume-worker.ts');

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`worker exited ${code}: ${err}`))));
  });
}

describe('one-time execution across processes', () => {
  let ctx: TestContext | undefined;
  afterEach(() => ctx?.cleanup());

  it('concurrent consumers of one approval: exactly one wins', async () => {
    ctx = createTestContext();
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const hash = sha256('race-proposal');
    const a = gate.request({ siteId: 'test-site', actionType: 'publish_content', target: 'https://www.example.test/new', subjectType: 'draft', subjectId: 'd1', artifactHash: hash, sourceRevision: 'site@synthetic-1', summary: 'Synthetic', requestedBy: 'owner:alice' });
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: hash.slice(0, 12) });
    const startAt = String(Date.now() + 2500);
    const results = await Promise.all([1, 2, 3, 4].map(() => run([ctx!.db.file, a.id, startAt, ctx!.clock.now().toISOString()])));
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(results.filter((r) => r.startsWith('lost:'))).toHaveLength(3);
    for (const r of results.filter((x) => x.startsWith('lost:'))) expect(r).toMatch(/already executed/);
    expect(gate.get(a.id)?.status).toBe('executed');
    const executed = ctx.db.all(`SELECT * FROM audit_events WHERE subject_id = ? AND event_type = 'approval.executed'`, [a.id]);
    expect(executed).toHaveLength(1);
  }, 30_000);
});
