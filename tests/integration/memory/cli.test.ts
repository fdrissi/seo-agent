import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { register } from '../../../src/cli/commands/memory.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { workspacePaths } from '../../../src/config/paths.js';
import { cpSync } from 'node:fs';
import { testSiteConfig } from '../../helpers/context.js';
import { FIXTURE_VAULT } from '../../fixtures/memory/setup.js';

let root: string;
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

async function run(...args: string[]): Promise<{ out: string; err: string; json: () => any }> {
  out = [];
  err = [];
  try {
    await program().parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const o = out.join('\n');
  return { out: o, err: err.join('\n'), json: () => JSON.parse(o) };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-memcli-'));
  initWorkspace(root, { allowInsideRepo: true });
  const paths = workspacePaths(root);
  writeFileSync(path.join(paths.sitesDir, 'test-site.yaml'), stringify(testSiteConfig({ market: { languages: ['en'] } })));
  cpSync(FIXTURE_VAULT, path.join(paths.vaultRoot, 'test-site'), { recursive: true });
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('memory CLI (offline, synthetic workspace)', () => {
  it('sync --dry-run plans without writing; sync ingests; search falls back to full-text honestly', async () => {
    const dry = await run('--dry-run', '--json', 'memory', 'sync');
    const d = dry.json();
    expect(d.ingest.dryRun).toBe(true);
    expect(d.ingest.bySourceType.business_note.created).toBe(3);
    expect(d.index.dryRun).toBe(true);
    const dryHuman = await run('--dry-run', 'memory', 'sync');
    expect(dryHuman.out).toMatch(/Paid embeddings: none will be made\. Vector indexing is not enabled/);
    expect(dryHuman.out).not.toMatch(/none needed/);

    const sync = await run('memory', 'sync');
    expect(sync.out).toMatch(/business_note\s+collected 3, new 3/);
    expect(sync.out).toMatch(/SKIPPED/);

    const s = await run('--json', 'memory', 'search', 'school', 'discount');
    const r = s.json();
    // The Core profile disables Qdrant by configuration: full-text only BY POLICY, not a degraded retrieval.
    expect(r.method).toBe('fts_only');
    expect(r.degraded).toBe(false);
    expect(r.degradedReason).toBeUndefined();
    expect(r.detail).toMatch(/full-text only by policy \(Qdrant is disabled for this site by configuration: features\.qdrant=false\)/);
    expect(r.chunks[0].title).toBe('Pricing');
    expect(Array.isArray(r.chunks[0].explanation)).toBe(true);
    expect(r.chunks[0].scores.fused).toBeGreaterThan(0);

    const human = await run('memory', 'search', 'school', 'discount');
    expect(human.out).toMatch(/Method: fts_only; /);
    expect(human.out).not.toMatch(/DEGRADED/);
    expect(human.out).toMatch(/Semantic search skipped: full-text only by policy \(Qdrant is disabled/);
    expect(human.out).toMatch(/1\. Pricing/);

    const ev = await run('--json', 'memory', 'evidence', r.chunks[0].chunkId);
    expect(ev.json()).toMatchObject({ status: 'found', original: { kind: 'vault_note' } });
  });

  it('status, rebuild --dry-run, and reconcile report honest statuses without network', async () => {
    await run('memory', 'sync');
    const st = (await run('--json', 'memory', 'status')).json();
    expect(st.integration.id).toBe('qdrant');
    expect(st.integration.state).toBe('disabled');
    expect(st.integration.networkChecked).toBe(false);
    expect(st.documents.total).toBe(3);
    expect(st.embeddings.state).toBe('disabled');
    expect(st.integration.sendsExternally.length).toBeGreaterThan(0);

    const rb = (await run('--dry-run', '--json', 'memory', 'rebuild')).json();
    expect(rb.dryRun).toBe(true);
    expect(rb.messages.join(' ')).toMatch(/Would skip rebuild/);

    const rc = (await run('--json', 'memory', 'reconcile')).json();
    expect(rc.status).toBe('skipped');

    const bad = await run('--json', 'memory', 'search', 'x', '--type', 'nonsense');
    expect(bad.json().ok).toBe(false);
  });
});
