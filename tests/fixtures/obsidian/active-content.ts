/**
 * SYNTHETIC hostile text for vault escaping tests. It combines every construct
 * that Markdown, Obsidian, or a common plugin (Dataview, Templater) would turn
 * into a link, a query, or executable code. Domains use the reserved .invalid
 * TLD. Nothing here is real data.
 */
export const HOSTILE_ACTIVE_TEXT = [
  'Click [verify your account](https://evil.invalid/login) or [open](obsidian://open?vault=x&file=y) or [ref][1]',
  '[1]: https://evil.invalid/ref',
  'Fields: [approved:: true] and owner_ok:: yes',
  '```dataviewjs',
  'app.vault.adapter.write("pwned.md", "pwned")',
  '```',
  'Inline `$= dv.el("b", "x")` and `= this.file.name` and www.evil.invalid and $\\href{https://evil.invalid}{x}$',
  '~~~dataview',
  'LIST FROM ""',
  '~~~',
  '<% tp.file.cursor() %> and <https://evil.invalid/auto>',
].join('\n');

/**
 * Raw substrings that must never survive in a generated note built from
 * HOSTILE_ACTIVE_TEXT: each one would be a live link, field, fence, inline
 * query, math, or Templater tag.
 */
const FORBIDDEN_SUBSTRINGS = [
  '](https://evil.invalid',
  '](obsidian://',
  'obsidian://open',
  'https://evil.invalid',
  '[ref][1]',
  '[1]:',
  '[approved::',
  'owner_ok::',
  '```dataviewjs',
  '~~~dataview',
  '`$=',
  'www.evil.invalid',
  '$\\href',
  '<%',
  '<https://',
];

/** Patterns for constructs whose escaped form still contains the raw text (checked for a preceding backslash). */
const FORBIDDEN_UNESCAPED = [/(^|[^\\])`= this/, /^[ \t>]*(```|~~~)/m];

/** Returns every live construct found (empty when the text is inert). */
export function findLiveSyntax(markdown: string): string[] {
  const found: string[] = FORBIDDEN_SUBSTRINGS.filter((s) => markdown.includes(s));
  for (const re of FORBIDDEN_UNESCAPED) {
    const m = re.exec(markdown);
    if (m) found.push(m[0]);
  }
  return found;
}
