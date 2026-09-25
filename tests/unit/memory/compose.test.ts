import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('compose.yaml (Qdrant service)', () => {
  const raw = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const doc = parse(raw) as { services: Record<string, { image: string; ports: string[]; volumes: string[]; environment?: Record<string, string>; healthcheck?: { test: unknown } }> };
  const q = doc.services.qdrant!;

  it('pins the verified image tag', () => {
    expect(q.image).toBe('qdrant/qdrant:v1.19.1');
  });

  it('binds every published port to localhost only', () => {
    expect(q.ports.length).toBeGreaterThan(0);
    for (const p of q.ports) expect(p.startsWith('127.0.0.1:')).toBe(true);
  });

  it('persists storage in the private workspace, not the repository', () => {
    expect(q.volumes).toContain('${SEO_AGENT_WORKSPACE:-~/seo-agent-workspace}/qdrant:/qdrant/storage');
  });

  it('has a healthcheck against /healthz and no hardcoded API key', () => {
    expect(JSON.stringify(q.healthcheck?.test)).toContain('/healthz');
    expect(q.environment?.QDRANT__SERVICE__API_KEY).toBeUndefined();
    expect(raw).not.toMatch(/API_KEY:\s*[A-Za-z0-9]{8,}/);
  });
});
