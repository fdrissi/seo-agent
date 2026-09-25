import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newId } from '../core/ids.js';
import { redact } from '../security/redact.js';
import { safeResolve } from '../security/paths.js';

/**
 * Raw API responses live in the private workspace (data/raw), never in the
 * repository or vault. Observations store the returned `ref` as their
 * raw-response reference. Payloads are redacted before writing.
 */
export class RawStore {
  constructor(private readonly rawDir: string) {}

  save(input: { siteId: string; provider: string; kind: string; payload: unknown; at?: Date }): string {
    const at = input.at ?? new Date();
    const day = at.toISOString().slice(0, 10);
    const id = newId('raw');
    const rel = path.posix.join(input.siteId, input.provider, day, `${input.kind}-${id}.json`);
    const abs = safeResolve(this.rawDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    const tmp = `${abs}.tmp`;
    writeFileSync(tmp, JSON.stringify({ savedAt: at.toISOString(), provider: input.provider, kind: input.kind, payload: redact(input.payload) }), { mode: 0o600 });
    renameSync(tmp, abs);
    return `raw:${rel}`;
  }

  load<T = unknown>(ref: string): T | null {
    if (!ref.startsWith('raw:')) return null;
    const abs = safeResolve(this.rawDir, ref.slice(4));
    if (!existsSync(abs)) return null;
    return (JSON.parse(readFileSync(abs, 'utf8')) as { payload: T }).payload;
  }
}
