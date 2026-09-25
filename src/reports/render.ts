import { redact, redactString } from '../security/redact.js';
import type { ClaimLabel } from '../core/modes.js';
import { escapeMd, isHttpUrl, renderLink, type LinkResolver } from './links.js';
import { fmtInt } from './metrics.js';
import { SYNTHETIC_WATERMARK, type Claim, type EvidenceLink, type Report, type ReportSection, type ReportTable } from './model.js';

/**
 * Rendering. Markdown is standard (usable without Obsidian); wikilinks are
 * optional through a link resolver. JSON is the full structured report.
 * Both outputs pass through secret redaction, and reports only ever contain
 * aggregates and top-N tables, never full raw datasets.
 */

export interface RenderOptions {
  linkResolver?: LinkResolver;
  /** Max evidence links shown per claim in Markdown (JSON keeps all). Default 3. */
  maxEvidencePerClaim?: number;
}

/** Shown next to the label of any claim that rests on synthetic, fixture, or sandbox rows. */
export const SYNTHETIC_CLAIM_MARKER = '[SYNTHETIC]';

export const LABEL_TEXT: Record<ClaimLabel, string> = {
  OBSERVED: 'OBSERVED',
  INFERRED: 'INFERRED',
  HYPOTHESIS: 'HYPOTHESIS',
  RECOMMENDATION: 'RECOMMENDATION',
  DATA_UNAVAILABLE: 'DATA UNAVAILABLE',
};

const KIND_TITLE = { baseline: 'Baseline', weekly: 'Weekly', monthly: 'Monthly' } as const;

export function reportTitle(r: Pick<Report, 'kind' | 'siteName'>): string {
  return `${KIND_TITLE[r.kind]} SEO report: ${r.siteName}`;
}

function cell(v: string | number | null): string {
  if (v === null || v === undefined) return 'n/a';
  if (typeof v === 'number') return Number.isInteger(v) ? fmtInt(v) : String(Math.round(v * 10_000) / 10_000);
  const s = escapeMd(v); // also escapes '|' and collapses newlines
  return s === '' ? ' ' : s;
}

export function renderTable(t: ReportTable): string {
  if (t.rows.length === 0) return `_${escapeMd(t.title)}: no rows._`;
  const lines = [`**${escapeMd(t.title)}**`, '', `| ${t.columns.map((c) => cell(c)).join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`];
  for (const r of t.rows) lines.push(`| ${t.columns.map((_, i) => cell(r[i] ?? null)).join(' | ')} |`);
  if (t.totalRows !== undefined && t.totalRows > t.rows.length) lines.push('', `_Showing ${t.rows.length} of ${fmtInt(t.totalRows)} rows (top-N only; full datasets stay in the private database)._`);
  if (t.note) lines.push('', `_${escapeMd(t.note)}_`);
  return lines.join('\n');
}

/** Inline code for record references. Redacted BEFORE backticks are replaced, so a secret is never altered past matching. */
function code(s: string): string {
  return `\`${redactString(s).replace(/`/g, "'").replace(/\r?\n+/g, ' ')}\``;
}

function evidenceText(e: EvidenceLink): string {
  const ref = redactString(e.ref);
  if (e.kind === 'url' && isHttpUrl(ref)) return `[${escapeMd(e.label)}](${ref.replace(/[()\s<>]/g, (c) => encodeURIComponent(c))})${e.supportsClaim ? '' : ' (location only; does not by itself support the claim)'}`;
  if (e.kind === 'report') return `${escapeMd(e.label)} (${escapeMd(ref.replace(/^section:/, 'section '))})`;
  return `${escapeMd(e.label)}: ${code(ref)}${e.supportsClaim ? '' : ' (context only)'}`;
}

function shortDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

export function renderClaim(c: Claim, opts: RenderOptions = {}): string {
  const max = opts.maxEvidencePerClaim ?? 3;
  const links = c.links?.length ? ` (${c.links.map((l) => renderLink(l, opts.linkResolver)).join(', ')})` : '';
  const lines = [`- **${LABEL_TEXT[c.label]}**${c.synthetic ? ` ${SYNTHETIC_CLAIM_MARKER}` : ''} ${escapeMd(c.text)}${links}`];
  if (c.label === 'DATA_UNAVAILABLE' && c.reason) lines.push(`  - Reason: ${escapeMd(c.reason)}`);
  const meta: string[] = [];
  if (c.sourceIds.length) meta.push(`Sources: ${c.sourceIds.slice(0, 5).map(code).join(', ')}${c.sourceIds.length > 5 ? ` (+${c.sourceIds.length - 5} more)` : ''}`);
  const dates = [...new Set(c.retrievedAt.map(shortDate))];
  if (dates.length) meta.push(`Retrieved: ${dates.slice(0, 3).join(', ')}${dates.length > 3 ? ` (+${dates.length - 3})` : ''}`);
  if (c.metricIds.length) meta.push(`Metrics: ${c.metricIds.map(code).join(', ')}`);
  if (meta.length) lines.push(`  - ${meta.join('; ')}`);
  if (c.evidence.length) lines.push(`  - Evidence: ${c.evidence.slice(0, max).map(evidenceText).join('; ')}${c.evidence.length > max ? ` (+${c.evidence.length - max} more in JSON)` : ''}`);
  if (c.evidenceStatus === 'missing' && (c.label === 'OBSERVED' || c.label === 'INFERRED')) lines.push('  - Evidence status: MISSING (not verifiable from this report)');
  if (c.evidenceStatus === 'context_only' && (c.label === 'OBSERVED' || c.label === 'INFERRED')) lines.push('  - Evidence status: context only (no linked item supports this claim)');
  return lines.join('\n');
}

export function renderSection(s: ReportSection, opts: RenderOptions = {}): string {
  const parts: string[] = [`## ${escapeMd(s.title)}`, ''];
  if (s.claims.length) parts.push(s.claims.map((c) => renderClaim(c, opts)).join('\n'), '');
  for (const t of s.tables) parts.push(renderTable(t), '');
  for (const n of s.notes) parts.push(`_Note: ${escapeMd(n)}_`, '');
  return parts.join('\n').trimEnd();
}

export function renderMarkdown(input: Report, opts: RenderOptions = {}): string {
  // Deep-redact the RAW strings first (escaping would otherwise hide secrets from
  // the matchers); the final pass over the joined output is defense in depth.
  const report = redact(input);
  const out: string[] = [`# ${escapeMd(reportTitle(report))}`, ''];
  if (report.isSynthetic) out.push(`> **${SYNTHETIC_WATERMARK}**`, '');
  out.push(
    `Report ${code(report.id)} | Period ${report.period.start} to ${report.period.end} (${report.period.timeZone}) | Generated ${report.generatedAt} | Evidence confidence: ${(report.data.confidence?.level ?? 'n/a').toUpperCase()}`,
    '',
    'Claim labels: OBSERVED (measured), INFERRED (derived judgement), HYPOTHESIS (untested explanation), RECOMMENDATION (proposed action), DATA UNAVAILABLE (not measured; never shown as zero).',
    '',
  );
  for (const s of report.sections) out.push(renderSection(s, opts), '');
  out.push('---', '');
  if (report.isSynthetic) out.push(`> **${SYNTHETIC_WATERMARK}**`, '');
  const llm = report.generator.llmSummary;
  out.push(`_Generated by seo-agent ${report.generator.version}; numbers computed deterministically in code. LLM summary: ${llm.status}${llm.detail ? ` (${escapeMd(llm.detail)})` : ''}. Reports are append-only: a re-run creates a new report and never rewrites this one._`);
  return redactString(out.join('\n').replace(/\n{3,}/g, '\n\n')) + '\n';
}

export function renderJson(report: Report): string {
  return JSON.stringify(redact(report), null, 2) + '\n';
}
