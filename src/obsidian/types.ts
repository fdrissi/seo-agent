/**
 * Vault contract. The vault is standard Markdown (useful without Obsidian or
 * community plugins); Obsidian features (wikilinks, properties) are layered on.
 *
 * Ownership:
 * - Human-maintained business facts and approved decisions live in designated notes.
 * - SQLite owns measurements, job state, budgets, and approval records.
 * - Generated Markdown presents those records.
 *
 * Generated regions are delimited by markers; everything outside them is
 * human-owned and preserved. If a generated region was edited by a human
 * since the last write, a conflict artifact is created instead of overwriting.
 */

export const GENERATED_START = '<!-- seo-agent:generated:start -->';
export const GENERATED_END = '<!-- seo-agent:generated:end -->';

export const VAULT_FOLDERS = [
  '00 Dashboard',
  '01 Business',
  '02 Website/Pages',
  '03 Keywords',
  '04 Competitors',
  '05 Content/Briefs',
  '05 Content/Drafts',
  '06 Experiments',
  '07 Reports/Weekly',
  '07 Reports/Monthly',
  '08 Research/Sources',
  '09 AI Search',
  '10 Content Opportunities',
  '11 Content Farm',
  '12 Decisions',
  '13 Learnings',
  '14 System Logs',
  'Templates',
] as const;
export type VaultFolder = (typeof VAULT_FOLDERS)[number];

export interface GeneratedNote {
  /** Vault-relative POSIX path including folder and '.md', e.g. '02 Website/Pages/Pricing.md'. */
  relPath: string;
  /** Stable id persisted in frontmatter (`id`). */
  noteId: string;
  kind: string;
  title: string;
  /** Generated frontmatter properties (merged with human-added properties, which are preserved). */
  frontmatter: Record<string, unknown>;
  /** Generated Markdown body placed inside the generated region. */
  body: string;
}

export type WriteStatus = 'created' | 'updated' | 'unchanged' | 'conflict';

export interface WriteOutcome {
  status: WriteStatus;
  relPath: string;
  conflictPath?: string;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  generatedRegion: string | null;
}

export interface VaultWriter {
  readonly siteId: string;
  readonly vaultDir: string;
  writeGenerated(note: GeneratedNote): WriteOutcome;
  readNote(relPath: string): ParsedNote | null;
  /** Path-aware wikilink from one note to another: [[folder/Note|alias]]. */
  link(toRelPath: string, alias?: string): string;
  /** Record a line in the append-only system log note for today. */
  appendSystemLog(line: string): void;
}
