import { formatUsd } from '../core/money.js';
import { notePath } from '../obsidian/wikilinks.js';
import type { GeneratedNote } from '../obsidian/types.js';
import { demandSummaryLines } from './demand.js';
import { factCheckNoteLine } from './fact-notes.js';
import { internalLinkSuggestionLine, NO_STRUCTURED_DATA_PROPOSAL } from './package-notes.js';
import { aiReviewStatusLabel } from './quality.js';
import { originLabel } from './signals.js';
import { truncate } from './text.js';
import type { BriefRecord, ContentItem, ContentSignal, DraftRecord, PrioritizeOutput, QualityReviewResult } from './types.js';

/**
 * Readable Markdown presentations of content-pipeline records (standard
 * Markdown with Obsidian wikilinks layered on), used as data: `content show`
 * prints an item's body, `runContentResearch` returns them, and the draft
 * note's line formatters are shared with the vault (package-notes.ts,
 * fact-notes.ts).
 *
 * The vault has ONE writer for content notes: `vault render` (and the content
 * commands, which render the content notes through it, see
 * src/obsidian/notes.ts `renderAll` with `only: ['content']`). These notes are
 * NOT written to the vault. Their paths and ids are the vault renderer's own
 * (note id `<item id>`, `<item id>.brief`, `<item id>.draft`,
 * `content-farm-<site>`; default note names in the same folders), so they
 * never describe a second, parallel note. Notes written by earlier versions
 * of the content commands (`<title> <id6>.md`, `... brief v<n>.md`,
 * `11 Content Farm/Content Pipeline.md`, ids `content-item-*`,
 * `content-brief-*`, `content-draft-*`, `content-pipeline-*`) are reported by
 * `vault check` as stale duplicates and marked stale by `vault render`.
 * SQLite remains authoritative. Editing a note never approves anything:
 * approvals exist only through the CLI approval workflow.
 */

export const APPROVAL_NOTICE = 'Editing this note (for example adding `approved: true`) does not approve anything. Approvals are recorded only through `npm run cli -- approvals approve <id>`.';

/** The vault renderer's default path of an item's note (src/obsidian/notes.ts planEntities). */
export function itemNotePath(item: Pick<ContentItem, 'id' | 'title'>): string {
  return notePath('10 Content Opportunities', item.title);
}

/** The vault renderer's default path of an item's brief note (one note per item; it lists every brief version). */
export function briefNotePath(item: Pick<ContentItem, 'id' | 'title'>, _version?: number): string {
  return notePath('05 Content/Briefs', `Brief - ${item.title}`);
}

/** The vault renderer's default path of an item's draft note (one note per item; it lists every draft version). */
export function draftNotePath(item: Pick<ContentItem, 'id' | 'title'>, _version?: number): string {
  return notePath('05 Content/Drafts', `Draft - ${item.title}`);
}

/** The vault renderer's content-farm pipeline note. */
export const PIPELINE_NOTE_PATH = '11 Content Farm/Pipeline.md';

/** Path-aware wikilink: [[folder/Note|alias]]. */
export function wikilink(relPath: string, alias?: string): string {
  const target = relPath.replace(/\.md$/, '');
  return alias ? `[[${target}|${alias.replace(/[|\]]/g, ' ')}]]` : `[[${target}]]`;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function contentItemNote(item: ContentItem, signals: ContentSignal[], links: { brief?: BriefRecord | null; draft?: DraftRecord | null } = {}): GeneratedNote {
  const d = item.demand;
  const lines: string[] = [];
  lines.push(`# ${item.title}`, '');
  if (item.isSynthetic) lines.push('> [!warning] SYNTHETIC fixture data. Never use for real recommendations or publication.', '');
  lines.push(`- Stage: **${item.stage}**`, `- Decision: **${item.decision ?? 'none'}**`, `- Intent: ${item.intent ?? 'unknown'}`, `- Priority score: ${item.priorityScore ?? 'not scored'}`);
  if (item.primaryQuestion) lines.push(`- Primary question: ${item.primaryQuestion}`);
  if (links.brief) lines.push(`- Brief: ${wikilink(briefNotePath(item, links.brief.version), `brief v${links.brief.version} (${links.brief.status})`)}`);
  if (links.draft) lines.push(`- Draft: ${wikilink(draftNotePath(item, links.draft.version), `draft v${links.draft.version} (${links.draft.status})`)}`);
  lines.push('', '## Decision', '', item.decisionReason ?? 'Not decided yet.', '');
  lines.push('## Why this deserves to exist', '', `- **Why it exists:** ${item.whyExists ?? 'n/a'}`, `- **Who benefits:** ${item.whoBenefits ?? 'n/a'}`, `- **Business relation:** ${item.businessRelation ?? 'n/a'}`, `- **Original value available:** ${item.originalValue ?? 'n/a'}`, `- **Reader next step:** ${item.readerNextStep ?? 'n/a'}`, '');
  if (d) {
    lines.push('## Demand evidence', '', `Status: **${d.status}**: ${d.statusReason}`, '', '| Metric | Value | Label |', '| --- | --- | --- |');
    for (const l of demandSummaryLines(d)) lines.push(`| ${esc(l.metric)} | ${esc(l.value)} | ${l.label} |`);
    lines.push('', 'Limitations:', ...d.limitations.map((l) => `- ${l}`), '');
    if (d.scoring) lines.push('## Scoring', '', `Formula: \`${d.scoring.formula}\``, '', ...d.scoring.limitations.map((l) => `- ${l}`), '');
  }
  if (item.overlap) {
    lines.push('## Existing content overlap', '', `Check status: ${item.overlap.status} (${item.overlap.statusReason})`, '', `Cannibalization risk: **${item.overlap.cannibalization.risk}**: ${item.overlap.cannibalization.explanation}`, '');
    for (const p of item.overlap.pages.slice(0, 5)) lines.push(`- ${p.url} (${p.confidence}, score ${p.score}): ${p.evidence.join('; ')}`);
    lines.push('', `_${item.overlap.uncertainty}_`, '');
  }
  lines.push('## Signals', '', '| Origin | Signal | Collected | Window | Limitations |', '| --- | --- | --- | --- | --- |');
  for (const s of signals.slice(0, 25)) {
    lines.push(`| ${originLabel(s.origin)} | ${esc(truncate(s.text, 120))}${s.url ? ` ([source](${s.url}))` : ''} | ${s.collectedAt.slice(0, 10)} | ${esc(s.collectionWindow?.description ?? 'n/a')} | ${esc(truncate(s.limitations, 120))} |`);
  }
  if (signals.length > 25) lines.push('', `${signals.length - 25} more signal(s) in SQLite (content_signals).`);
  lines.push('', '---', APPROVAL_NOTICE);
  return {
    relPath: itemNotePath(item),
    noteId: item.id,
    kind: 'content_opportunity',
    title: item.title,
    frontmatter: {
      site: item.siteId,
      content_item_id: item.id,
      stage: item.stage,
      decision: item.decision,
      intent: item.intent,
      priority_score: item.priorityScore,
      synthetic: item.isSynthetic,
      updated: item.updatedAt,
    },
    body: lines.join('\n'),
  };
}

export function briefNote(item: ContentItem, rec: BriefRecord, approvalId: string | null = null): GeneratedNote {
  const b = rec.brief;
  const L: string[] = [`# Brief v${rec.version}: ${item.title}`, ''];
  if (b.isSynthetic) L.push('> [!warning] Uses SYNTHETIC fixture evidence.', '');
  L.push(`- Item: ${wikilink(itemNotePath(item), item.title)}`, `- Gate: **${rec.gate?.passed ? 'passed' : 'failed'}** (${rec.gate?.gateVersion ?? 'n/a'})`, `- Status: ${rec.status}`, `- Brief hash: \`${rec.contentHash}\``);
  L.push(`- Draft approval: ${approvalId ? `requested (${approvalId}); approve via CLI` : 'not requested'}`);
  L.push(`- Generated by: ${b.generatedBy.synthesized ? `${b.generatedBy.model} (${b.generatedBy.promptVersion})` : 'deterministic code'}`, '');
  if (rec.gate?.issues.length) {
    L.push('## Gate issues', '');
    for (const i of rec.gate.issues) L.push(`- **${i.severity}** \`${i.code}\` (${i.field}): ${i.message}`);
    L.push('');
  }
  L.push('## Audience', '', b.audience, '', '## Primary question', '', b.primaryQuestion, '');
  L.push('## Query cluster', '', `Intent: **${b.intent}**; decision: **${b.decision}**; page type: ${b.pageType}`, '', ...b.queryCluster.queries.map((q) => `- ${q}`), '');
  L.push('## Proposed URL / target', '', `- Proposed: ${b.proposedUrl ?? 'n/a'}`, `- Target page: ${b.targetPageUrl ?? 'n/a'}`, '');
  L.push('## Existing-page overlap', '', `${b.existingPageOverlap.status}; cannibalization: ${b.existingPageOverlap.cannibalizationRisk}`, ...b.existingPageOverlap.pages.map((p) => `- ${p.url} (${p.confidence}): ${p.evidence.join('; ')}`), '', `_${b.existingPageOverlap.uncertainty}_`, '');
  L.push('## Business purpose', '', b.businessPurpose, '');
  L.push('## Research findings', '', ...b.researchFindings.map((f) => `- **${f.label}** ${f.finding} (evidence: ${f.evidenceIds.join(', ')})`), '');
  L.push('## Demand summary', '', '| Metric | Value | Label |', '| --- | --- | --- |', ...b.demandSummary.map((d) => `| ${esc(d.metric)} | ${esc(d.value)} | ${d.label} |`), '');
  L.push('## Unique contribution', '', b.uniqueContribution || '_Missing: the gate requires original value._', '');
  if (b.uniqueContributionEvidenceIds?.length) L.push(`Backed by: ${b.uniqueContributionEvidenceIds.map((id) => `\`${id}\``).join(', ')}`, '');
  L.push('## Outline', '');
  for (const o of b.outline) L.push(`### ${o.heading}`, '', `Purpose: ${o.purpose}`, ...o.answers.map((a) => `- ${a}`), o.evidenceIds.length ? `Evidence: ${o.evidenceIds.join(', ')}` : '', '');
  L.push('## Useful examples', '', ...b.usefulExamples.map((e) => `- ${e.description}${e.needsOwnerInput ? ' **(needs owner input)**' : ''}`), '');
  L.push('## Internal links', '', ...(b.internalLinks.length ? b.internalLinks.map((l) => `- ${l.targetUrl} (anchor idea: "${l.anchorSuggestion}"): ${l.reason}${l.verified ? '' : ' **UNVERIFIED**'}`) : ['- none']), '');
  L.push('## CTA', '', `${b.cta.text}${b.cta.targetUrl ? ` -> ${b.cta.targetUrl}` : ''}`, '', b.cta.rationale, '');
  L.push('## Unresolved factual questions', '', ...(b.unresolvedQuestions.length ? b.unresolvedQuestions.map((q) => `- ${q.blocking ? '**BLOCKING** ' : ''}${q.question}: ${q.whyItMatters}`) : ['- none']), '');
  L.push('## Evidence sources', '', '| Id | Source | Trust | Excerpt | Limitations |', '| --- | --- | --- | --- | --- |');
  for (const e of b.evidenceSources) L.push(`| \`${e.id}\` | ${esc(e.label)}${e.url ? ` ([link](${e.url}))` : ''} | ${e.trustClass}${e.isSynthetic ? ' (synthetic)' : ''} | ${esc(truncate(e.excerpt, 140))} | ${esc(truncate(e.limitations, 100))} |`);
  L.push('', '---', APPROVAL_NOTICE);
  return {
    relPath: briefNotePath(item, rec.version),
    noteId: `${item.id}.brief`,
    kind: 'brief',
    title: `Brief v${rec.version}: ${item.title}`,
    frontmatter: { site: rec.siteId, content_item_id: item.id, brief_id: rec.id, version: rec.version, status: rec.status, gate_passed: !!rec.gate?.passed, brief_hash: rec.contentHash, synthetic: b.isSynthetic, created: rec.createdAt },
    body: L.join('\n'),
  };
}

/** One fact-check note line (never a bare "verified"); shared with the vault renderer. */
export { factCheckNoteLine } from './fact-notes.js';
/** One internal-link suggestion line and the empty structured-data text; shared with the vault renderer. */
export { internalLinkSuggestionLine, NO_STRUCTURED_DATA_PROPOSAL } from './package-notes.js';

export function draftNote(item: ContentItem, d: DraftRecord, review: QualityReviewResult | null): GeneratedNote {
  const p = d.pkg;
  const L: string[] = [`# Draft v${d.version}: ${item.title}`, '', `> [!important] ${p.disclaimer}`, ''];
  if (p.isSynthetic) L.push('> [!warning] SYNTHETIC: generated from fixtures by a fixture model. Never publish.', '');
  const hr = p.humanRevision;
  L.push(
    `- Item: ${wikilink(itemNotePath(item), item.title)}`,
    `- Brief: ${wikilink(briefNotePath(item, d.briefVersion), `brief v${d.briefVersion}`)} (hash \`${d.briefHash.slice(0, 16)}\`)`,
    `- Status: **${d.status}**`,
    `- Revision round: ${d.revisionRound}`,
    `- Unresolved facts: **${d.unresolvedFacts}**`,
    `- Body hash: \`${d.bodyHash}\``,
    hr
      ? `- Author: **human revision by ${hr.reviewer}** (${hr.at}) of draft v${hr.previousVersion}; the text it started from was written by ${p.generatedBy.model} (${p.generatedBy.promptVersion})`
      : `- Model: ${p.generatedBy.model} (${p.generatedBy.promptVersion}); cost: ${formatUsd(p.generatedBy.costMicros)}`,
    '',
  );
  if (hr) {
    L.push('## Human revision', '', `Markers before: ${hr.markersBefore.length}; after: ${hr.markersAfter.length}${hr.addedMarkers.length ? ` (${hr.addedMarkers.length} added)` : ''}.${hr.note ? ` Note: ${hr.note}` : ''}`, '');
    if (hr.resolutions.length) L.push(...hr.resolutions.map((r) => `- ${r.action} by ${r.reviewer}: "${r.statement}" (source: ${r.source}${r.sourceKind === 'human_supplied' ? '' : ` [${r.sourceKind}]`})${r.note ? `: ${r.note}` : ''}`), '');
  }
  if (review) {
    L.push('## Quality review', '', `Verdict: **${review.verdict}**${review.revisionLimitReached ? ' (automated revision limit reached)' : ''}`, '');
    for (const r of review.reasons) L.push(`- [${r.consequence}] \`${r.code}\`: ${r.message} Fix: ${r.fix}`);
    L.push('', `AI review: ${aiReviewStatusLabel(review.aiReview)} (${review.aiReview.reason}). ${review.aiReview.disclaimer}`, '');
  }
  L.push('## Publication blockers', '', ...p.publicationBlockers.map((b) => `- ${b}`), '');
  L.push('## Title options', '', ...p.titleOptions.map((t) => `- ${t}`), '', '## Meta description', '', p.metaDescription, '', '## Slug suggestion', '', `\`${p.slugSuggestion}\``, '');
  L.push('## Body', '', p.body, '');
  L.push('## Internal-link suggestions', '', ...(p.internalLinkSuggestions.length ? p.internalLinkSuggestions.map((l) => internalLinkSuggestionLine(l)) : ['- none']), '');
  L.push('## Structured-data proposal', '', p.structuredDataProposal ? `${p.structuredDataProposal.note}\n\n\`\`\`json\n${JSON.stringify(p.structuredDataProposal.jsonLd, null, 2)}\n\`\`\`` : NO_STRUCTURED_DATA_PROPOSAL, '');
  L.push('## Source ledger', '', ...(p.sourceLedger.length ? p.sourceLedger.map((s) => `- ${s.claim} (${[...s.evidenceIds, ...s.factIds.map((f) => `fact:${f}`)].join(', ') || 'no reference'}; ${s.status})`) : ['- none']), '');
  L.push('## Fact-check notes', '', ...(p.factCheckNotes.length ? p.factCheckNotes.map(factCheckNoteLine) : ['- none']), '');
  L.push('---', APPROVAL_NOTICE);
  return {
    relPath: draftNotePath(item, d.version),
    noteId: `${item.id}.draft`,
    kind: 'draft',
    title: `Draft v${d.version}: ${item.title}`,
    frontmatter: { site: d.siteId, content_item_id: item.id, draft_id: d.id, version: d.version, status: d.status, verdict: review?.verdict ?? null, unresolved_facts: d.unresolvedFacts, brief_hash: d.briefHash, synthetic: p.isSynthetic, created: d.createdAt },
    body: L.join('\n'),
  };
}

export function pipelineNote(siteId: string, items: ContentItem[], capacity: PrioritizeOutput['capacity'] | null, generatedAt: string): GeneratedNote {
  const byStage = new Map<string, ContentItem[]>();
  for (const i of items) byStage.set(i.stage, [...(byStage.get(i.stage) ?? []), i]);
  const L: string[] = ['# Content pipeline', '', 'DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND -> CHECK EXISTING -> PRIORITIZE -> BRIEF -> DRAFT -> QUALITY GATES -> HUMAN REVIEW -> EXPORT/PUBLISH WHEN AUTHORIZED -> MEASURE', ''];
  if (capacity) L.push(`Production capacity: ${capacity.inProduction} of ${capacity.maxInProduction} in production (batch ${capacity.batchEnabled ? 'enabled' : 'disabled'}, pilot ${capacity.pilotApproved ? 'approved' : 'not approved'}).`, '');
  L.push('| Stage | Items |', '| --- | --- |');
  for (const [stage, list] of [...byStage.entries()].sort()) L.push(`| ${stage} | ${list.length} |`);
  L.push('', '## Items', '', '| Item | Stage | Decision | Score | Intent |', '| --- | --- | --- | --- | --- |');
  for (const i of items) L.push(`| ${wikilink(itemNotePath(i), truncate(i.title, 60))} | ${i.stage} | ${i.decision ?? ''} | ${i.priorityScore ?? ''} | ${i.intent ?? ''} |`);
  L.push('', '---', APPROVAL_NOTICE);
  return { relPath: PIPELINE_NOTE_PATH, noteId: `content-farm-${siteId}`, kind: 'content_farm_index', title: 'Content pipeline', frontmatter: { site: siteId, generated: generatedAt, items: items.length }, body: L.join('\n') };
}
