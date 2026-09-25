import { randomBytes, randomUUID } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Time-sortable unique id (ULID layout, Crockford base32). */
export function ulid(time: number = Date.now()): string {
  let t = time;
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return timePart + rand;
}

/** Prefixed id such as `job_01J...`. Prefixes make logs and DB rows self-describing. */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function newTraceId(): string {
  return `trace_${ulid()}`;
}

export function uuid(): string {
  return randomUUID();
}

/** Stable, URL/file-safe slug. */
export function slugify(input: string, maxLength = 80): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return s || 'untitled';
}
