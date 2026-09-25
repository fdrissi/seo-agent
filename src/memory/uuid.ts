import { createHash } from 'node:crypto';

/**
 * RFC 4122 version-5 (SHA-1, name-based) UUIDs. Qdrant point ids must be
 * unsigned integers or UUIDs; deterministic ids make upserts idempotent and
 * let SQLite recompute every expected point id for reconciliation.
 */

/** Fixed namespace for seo-agent memory point ids (randomly generated once; never change). */
export const MEMORY_POINT_NAMESPACE = '6f1d3c2a-8b7e-4f5a-9c0d-2e4b6a8c1f37';

function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new RangeError(`Invalid UUID: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

export function uuidv5(name: string, namespace: string = MEMORY_POINT_NAMESPACE): string {
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Point id for a chunk's content inside a document. Chunks of a new document
 * version whose content (and occurrence) is unchanged keep the same point id,
 * so their vectors are reused and only removed content is tombstoned.
 */
export function pointIdFor(siteId: string, documentId: string, contentHash: string, occurrence: number): string {
  return uuidv5(`${siteId}\u0000${documentId}\u0000${contentHash}\u0000${occurrence}`);
}
