import { createHash } from 'node:crypto';

/**
 * Near-duplicate detection helpers: 64-bit SimHash over word 3-shingles.
 * Represented as a 16-hex-digit string so it can be stored in SQLite and
 * compared without BigInt. A small Hamming distance means SUSPECTED
 * near-duplication only; it is never proof that a page should be removed.
 */

export const SIMHASH_MIN_WORDS = 50;
const MAX_TOKENS = 20_000;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TOKENS);
}

export function simhash64(text: string, shingleSize = 3): string | null {
  const tokens = tokenize(text);
  if (tokens.length < Math.max(shingleSize, 1)) return null;
  const v = new Int32Array(64);
  for (let i = 0; i + shingleSize <= tokens.length; i++) {
    const shingle = tokens.slice(i, i + shingleSize).join(' ');
    const h = createHash('md5').update(shingle).digest();
    for (let byte = 0; byte < 8; byte++) {
      const b = h[byte]!;
      for (let bit = 0; bit < 8; bit++) v[byte * 8 + bit]! += (b >> bit) & 1 ? 1 : -1;
    }
  }
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 64; i++) if (v[i]! > 0) bytes[i >> 3]! |= 1 << (i & 7);
  return Buffer.from(bytes).toString('hex');
}

function popcount32(n: number): number {
  let x = n >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  const hiA = parseInt(a.slice(0, 8), 16);
  const loA = parseInt(a.slice(8), 16);
  const hiB = parseInt(b.slice(0, 8), 16);
  const loB = parseInt(b.slice(8), 16);
  return popcount32(hiA ^ hiB) + popcount32(loA ^ loB);
}
