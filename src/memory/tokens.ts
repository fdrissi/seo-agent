/**
 * Multilingual token estimation heuristic (no tokenizer dependency).
 *
 * Embedding and chat models use different BPE vocabularies, so an exact count
 * is impossible without the model's tokenizer. This estimate is deliberately
 * conservative (it tends to over-count) so chunk sizes and context budgets stay
 * within limits across scripts:
 *
 *   - CJK ideographs, Hiragana, Katakana, Hangul, Thai, Lao, Khmer, Myanmar:
 *     1 token per character (these scripts are written without spaces and BPE
 *     vocabularies typically spend ~1 token per character or more).
 *   - Other non-ASCII characters (Cyrillic, Greek, Arabic, Hebrew, Devanagari,
 *     accented Latin letters, ...): 1 token per 2 characters.
 *   - ASCII characters (including spaces and punctuation): 1 token per 4
 *     characters (the common English rule of thumb).
 *
 * The result is the maximum of that character-based estimate and the number
 * of whitespace-separated words, so text made of many very short words is not
 * under-counted.
 */

const DENSE_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export const TOKEN_ESTIMATOR_VERSION = 'tok-heuristic-v1';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let dense = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) ascii++;
    else if (DENSE_SCRIPT_RE.test(ch)) dense++;
    else other++;
  }
  const charBased = dense + Math.ceil(ascii / 4) + Math.ceil(other / 2);
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(charBased, words);
}

/**
 * Truncate `text` so that its estimate fits `maxTokens`. Cuts at a whitespace
 * boundary when one exists close to the limit. Returns the original string
 * when it already fits.
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 };
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  // Binary search on code-point length.
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(chars.slice(0, mid).join('')) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  let cut = chars.slice(0, lo).join('');
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > cut.length * 0.8) cut = cut.slice(0, lastSpace);
  return { text: cut.trimEnd(), truncated: true };
}
