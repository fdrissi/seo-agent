import { coerceFactCheckNote, factCheckNoteLine } from '../content/fact-notes.js';
import { internalLinkSuggestionLine, isInternalLinkSuggestion, NO_STRUCTURED_DATA_PROPOSAL, type PackageLineFormat } from '../content/package-notes.js';
import { neutralizeMarkers } from './frontmatter.js';
import { bulletList, callout, cell, code, codeBlock, describeJson, escapeMarkdownText, fmtDate, fmtInt, fmtNum, fmtTimestamp, inline, markBidiControls, parseJsonSafe, quoteUntrusted, rawCell, syntheticBanner, table, yesNo } from './markdown.js';
import { aeoIndexSection } from './notes-site.js';
import { all, num, one, str, type RenderContext, type Row } from './render-context.js';
import type { GeneratedNote } from './types.js';

/**
 * Content pipeline presentation: content opportunities (10), briefs and
 * drafts (05), the content-farm pipeline index (11), and AI-citation checks
 * (09). The pipeline itself lives in SQLite; these notes make it browsable.
 */

const ACTIVE_PRODUCTION_STAGES = ['briefed', 'drafted', 'quality_checked', 'in_review', 'approved', 'exported'];
const STAGE_ORDER = [
  'discovered',
  'deduplicated',
  'classified',
  'clustered',
  'demand_validated',
  'existing_checked',
  'prioritized',
  'briefed',
  'drafted',
  'quality_checked',
  'in_review',
  'approved',
  'exported',
  'published',
  'measuring',
  'deferred',
  'rejected',
];

function banner(isSynthetic: boolean, lines: string[]): string[] {
  return isSynthetic ? [syntheticBanner(), '', ...lines] : lines;
}

// ---------------------------------------------------------------- content opportunity (content_items)

export function buildContentItemNote(rc: RenderContext, it: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const id = String(it.id);
  const ref = plan.get(`content:${id}`)!;
  const isSynthetic = ctx.synthetic || num(it.is_synthetic) === 1;
  const cluster = it.cluster_id ? one(rc, 'SELECT label, intent FROM keyword_clusters WHERE site_id = ? AND id = ?', [site, it.cluster_id]) : undefined;
  const clusterKeywords = it.cluster_id ? all(rc, 'SELECT id, keyword FROM keywords WHERE site_id = ? AND cluster_id = ? ORDER BY keyword LIMIT 30', [site, it.cluster_id]) : [];
  const signals = all(rc, 'SELECT * FROM content_signals WHERE site_id = ? AND content_item_id = ? ORDER BY collected_at DESC, id LIMIT 25', [site, id]);
  const reviews = all(
    rc,
    `SELECT subject_type, verdict, reasons_json, revision_round, created_at FROM quality_reviews
      WHERE site_id = ? AND ((subject_type = 'brief' AND subject_id IN (SELECT id FROM content_briefs WHERE site_id = ? AND content_item_id = ?))
         OR (subject_type = 'draft' AND subject_id IN (SELECT id FROM content_drafts WHERE site_id = ? AND content_item_id = ?)))
      ORDER BY created_at DESC LIMIT 10`,
    [site, site, id, site, id],
  );
  const decisions = all(rc, "SELECT id FROM decisions WHERE site_id = ? AND subject_type IN ('content_item', 'content') AND subject_id = ? ORDER BY decided_at DESC", [site, id]);
  const targetKey = it.target_page_id ? `page:${String(it.target_page_id)}` : null;

  const lines = banner(isSynthetic, [`# ${inline(it.title, 200)}`, '']);
  lines.push(
    `- Stage: **${inline(it.stage)}** · Decision: ${it.decision ? `**${inline(it.decision)}**` : 'not decided'}${it.decision_reason ? ` (${inline(it.decision_reason, 400)})` : ''}`,
    `- Primary question: ${it.primary_question ? inline(it.primary_question, 400) : 'not recorded'}`,
    `- Intent: ${inline(str(it.intent) ?? 'unknown')} · Priority score: ${it.priority_score === null || it.priority_score === undefined ? 'not scored' : fmtNum(num(it.priority_score), 2)}`,
    `- Existing page: ${targetKey && plan.has(targetKey) ? plan.link(targetKey) : it.target_page_id ? `${code(it.target_page_id, 60)}` : 'none (new content candidate)'}`,
    `- Cluster: ${cluster ? inline(cluster.label, 120) : 'none'}${clusterKeywords.length ? ` · keywords: ${clusterKeywords.map((k) => (plan.has(`keyword:${String(k.id)}`) ? plan.link(`keyword:${String(k.id)}`) : inline(k.keyword))).join(', ')}` : ''}`,
    `- Brief: ${plan.has(`brief:${id}`) ? plan.link(`brief:${id}`) : 'none yet'} · Draft: ${plan.has(`draft:${id}`) ? plan.link(`draft:${id}`) : 'none yet'}`,
    '',
    '## Why this deserves to exist',
    '',
    `- Why it exists: ${it.why_exists ? inline(it.why_exists, 800) : 'NOT EXPLAINED (required before briefing)'}`,
    `- Who benefits: ${it.who_benefits ? inline(it.who_benefits, 800) : 'NOT EXPLAINED'}`,
    `- Relation to the business: ${it.business_relation ? inline(it.business_relation, 800) : 'NOT EXPLAINED'}`,
    `- Original value available: ${it.original_value ? inline(it.original_value, 800) : 'NOT EXPLAINED'}`,
    `- Likely next step for a reader: ${it.reader_next_step ? inline(it.reader_next_step, 800) : 'NOT EXPLAINED'}`,
    '',
    '## Demand signals',
    '',
    describeJson(parseJsonSafe(it.demand_json)),
    '',
  );
  if (signals.length) {
    lines.push('### Supporting examples (third-party text, data only)', '');
    for (const sg of signals) {
      const engagement = parseJsonSafe<Record<string, unknown>>(sg.engagement_json);
      lines.push(
        `- **${inline(sg.origin)}** / ${inline(sg.signal_type)} · collected ${fmtDate(str(sg.collected_at))}${sg.url ? ` · ${code(sg.url, 200)}` : ''}${num(sg.is_synthetic) ? ' · SYNTHETIC' : ''}`,
        `  - Limitations: ${inline(sg.limitations, 300)}`,
        ...(engagement ? [`  - Engagement (not search volume): ${inline(JSON.stringify(engagement), 200)}`] : []),
        '',
        quoteUntrusted(sg.text, 600)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
        '',
      );
    }
  }
  lines.push('Engagement on forums or social sites is not search volume. Each signal keeps its origin, collection window, and limitations.', '');
  lines.push('## Existing-content overlap', '', describeJson(parseJsonSafe(it.overlap_json)), '');
  lines.push('## Quality reviews', '');
  lines.push(
    reviews.length
      ? bulletList(reviews.map((r) => `${fmtDate(str(r.created_at))} · ${inline(r.subject_type)} · **${inline(r.verdict)}** (round ${inline(r.revision_round)}): ${inline(summarizeReasons(r.reasons_json), 400)}`))
      : '_No quality reviews yet._',
  );
  lines.push('', '## Decisions', '', decisions.length ? bulletList(decisions.map((d) => (plan.has(`decision:${String(d.id)}`) ? plan.link(`decision:${String(d.id)}`) : `${code(d.id, 60)}`))) : '_None recorded._');
  lines.push('', `Pipeline: ${plan.has('farm') ? plan.link('farm') : 'Content farm pipeline'}`);
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'content_opportunity',
    title: ref.title,
    frontmatter: {
      source_ids: [id, ...signals.map((s) => String(s.id))],
      stage: str(it.stage),
      decision: str(it.decision),
      priority_score: num(it.priority_score),
      ...(isSynthetic ? { synthetic: true } : {}),
    },
    body: lines.join('\n'),
  };
}

function summarizeReasons(reasonsJson: unknown): string {
  const v = parseJsonSafe<unknown>(reasonsJson);
  if (!v) return 'no reasons recorded';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as Record<string, unknown>).reason ?? (x as Record<string, unknown>).message ?? JSON.stringify(x)) : String(x))).join('; ');
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- briefs

const BRIEF_SECTIONS: Array<[string, string[]]> = [
  ['Audience', ['audience']],
  ['Primary question', ['primaryquestion']],
  ['Query cluster', ['querycluster', 'cluster', 'queries']],
  ['Intent', ['intent']],
  ['Proposed URL and page type', ['proposedurl', 'url', 'slug', 'pagetype', 'proposedpagetype']],
  ['Existing-page overlap', ['existingpageoverlap', 'overlap']],
  ['Business purpose', ['businesspurpose']],
  ['Research findings', ['researchfindings', 'findings']],
  ['Evidence sources', ['evidencesources', 'sources']],
  ['Unique contribution', ['uniquecontribution', 'originalcontribution']],
  ['Outline', ['outline']],
  ['Useful examples', ['usefulexamples', 'examples']],
  ['Internal links', ['internallinks']],
  ['Call to action', ['cta', 'calltoaction']],
  ['Unresolved factual questions', ['unresolvedquestions', 'unresolvedfactualquestions', 'openquestions']],
];

function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '_Not provided._';
  if (typeof v === 'string') return sanitizeDraftMarkdown(v.length > 20_000 ? `${v.slice(0, 19_999)}…` : v);
  if (Array.isArray(v)) return v.length ? v.map((x) => (x !== null && typeof x === 'object' ? `- ${inline(JSON.stringify(x), 400)}` : `- ${inline(x, 600)}`)).join('\n') : '_None._';
  if (typeof v === 'object') return describeJson(v);
  return inline(v);
}

/** Render a model-generated brief object: known sections in the spec order, then anything else. */
export function renderBriefObject(brief: Record<string, unknown>): string[] {
  const used = new Set<string>();
  const byNorm = new Map(Object.keys(brief).map((k) => [normKey(k), k] as const));
  const lines: string[] = [];
  for (const [label, keys] of BRIEF_SECTIONS) {
    const parts: string[] = [];
    for (const nk of keys) {
      const original = byNorm.get(nk);
      if (original && !used.has(original)) {
        used.add(original);
        parts.push(renderValue(brief[original]));
      }
    }
    lines.push(`### ${label}`, '', parts.length ? parts.join('\n\n') : '_Not provided._', '');
  }
  const rest = Object.keys(brief).filter((k) => !used.has(k));
  if (rest.length) {
    lines.push('### Other fields', '');
    for (const k of rest) lines.push(`- **${inline(k, 80)}**: ${inline(typeof brief[k] === 'object' ? JSON.stringify(brief[k]) : brief[k], 600)}`);
    lines.push('');
  }
  return lines;
}

export function buildBriefNote(rc: RenderContext, it: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const itemId = String(it.id);
  const ref = plan.get(`brief:${itemId}`)!;
  const versions = all(rc, 'SELECT * FROM content_briefs WHERE site_id = ? AND content_item_id = ? ORDER BY version DESC', [site, itemId]);
  const latest = versions[0]!;
  const isSynthetic = ctx.synthetic || num(it.is_synthetic) === 1;
  const brief = parseJsonSafe<Record<string, unknown>>(latest.brief_json) ?? {};
  const gate = parseJsonSafe<unknown>(latest.gate_json);
  const lines = banner(isSynthetic, [`# ${inline(ref.title, 200)}`, '']);
  lines.push(
    callout('note', 'Model-assisted brief for human review', ['Unresolved facts stay unresolved until verified. A brief never authorizes drafting or publication by itself.']),
    '',
    `- Content item: ${plan.has(`content:${itemId}`) ? plan.link(`content:${itemId}`) : inline(it.title)}`,
    `- Version: **v${inline(latest.version)}** · Status: **${inline(latest.status)}** · Created ${fmtTimestamp(str(latest.created_at))}`,
    `- Content hash: ${code(latest.content_hash, 80)} · Prompt: ${inline(str(latest.prompt_version) ?? 'n/a')} · Model: ${inline(str(latest.model_id) ?? 'n/a')}`,
    `- Gate: ${gate ? inline(JSON.stringify(gate), 400) : 'not evaluated'}`,
    '',
    '## Brief',
    '',
    ...renderBriefObject(brief),
    '## Version history',
    '',
    table(
      ['Version', 'Status', 'Hash', 'Created'],
      versions.map((v) => [inline(`v${String(v.version)}`), cell(v.status), cell(String(v.content_hash).slice(0, 12)), fmtDate(str(v.created_at))]),
    ),
  );
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'brief',
    title: ref.title,
    frontmatter: {
      source_ids: [itemId, ...versions.map((v) => String(v.id))],
      brief_id: str(latest.id),
      brief_version: num(latest.version),
      brief_status: str(latest.status),
      brief_hash: str(latest.content_hash),
      ...(isSynthetic ? { synthetic: true } : {}),
    },
    body: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- drafts

/**
 * Model-written (or other untrusted) multi-line Markdown kept readable for
 * review: blockquote markers, headings (demoted two levels so they sit under
 * the note's own), lists, tables, and emphasis keep their structure. Every
 * other construct is escaped like `inline`: links of every form, embeds and
 * images, raw HTML, code spans and fences (so a ```dataviewjs block or a
 * `$= ...` inline query can never be formed), Dataview inline fields, math,
 * tags, and Obsidian comments. Bidi embedding, override, and isolate
 * controls are shown as visible `[U+XXXX]` markers (`markBidiControls`), so
 * the draft a reviewer reads before `content mark-reviewed` reads the same as
 * the stored body.
 */
export function sanitizeDraftMarkdown(body: string): string {
  return neutralizeMarkers(body)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => {
      const m = /^([ \t]*(?:>[ \t]?)*)(#{1,6}(?=[ \t]|$))?(.*)$/.exec(line)!;
      const quote = m[1] ?? '';
      const heading = m[2] ? '#'.repeat(Math.min(6, m[2].length + 2)) : '';
      return `${quote}${heading}${escapeMarkdownText(markBidiControls(m[3] ?? ''))}`;
    })
    .join('\n');
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  const byNorm = new Map(Object.keys(obj).map((k) => [normKey(k), k] as const));
  for (const k of keys) {
    const original = byNorm.get(normKey(k));
    if (original !== undefined) return obj[original];
  }
  return undefined;
}

/**
 * Fact-check notes exactly as the content pipeline's draft note shows them
 * (factCheckNoteLine): a writer's "verified" reads "model-claimed verified
 * (evidence: ...)", a downgraded note gives its reason, and only a human
 * confirmation names a reviewer; never a bare "verified" or a raw JSON status.
 * Each line is stored text, so it goes through `inline` (redaction, then
 * neutralized links, HTML, and markers). A stored entry that is not a
 * readable note is labeled as such, never as a verification.
 */
function renderFactCheckNotes(v: unknown): string {
  if (!Array.isArray(v)) return renderValue(v);
  if (!v.length) return '_None._';
  return v
    .map((x) => {
      const n = coerceFactCheckNote(x);
      if (n) return `- ${inline(factCheckNoteLine(n).replace(/^- /, ''), 1200)}`;
      const raw = typeof x === 'string' ? x : JSON.stringify(x);
      return `- **unreadable fact-check note** (shown as stored; not a verification): ${inline(raw, 400)}`;
    })
    .join('\n');
}

export function buildDraftNote(rc: RenderContext, it: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const itemId = String(it.id);
  const ref = plan.get(`draft:${itemId}`)!;
  const versions = all(rc, 'SELECT id, version, status, body_hash, brief_version, brief_hash, unresolved_facts, revision_round, created_at FROM content_drafts WHERE site_id = ? AND content_item_id = ? ORDER BY version DESC', [site, itemId]);
  const latest = one(rc, 'SELECT * FROM content_drafts WHERE site_id = ? AND content_item_id = ? ORDER BY version DESC LIMIT 1', [site, itemId])!;
  const pkg = parseJsonSafe<Record<string, unknown>>(latest.package_json) ?? {};
  const isSynthetic = ctx.synthetic || num(it.is_synthetic) === 1;
  const unresolved = num(latest.unresolved_facts) ?? 0;
  const lines = banner(isSynthetic, [`# ${inline(ref.title, 200)}`, '']);
  lines.push(callout('note', 'Draft for human review', ['This draft is not published. Publication requires a separate human approval through the CLI; editing this note approves nothing.']), '');
  if (unresolved > 0) lines.push(callout('danger', `${unresolved} unresolved fact(s)`, ['Publication is blocked until every unresolved fact is verified or removed.']), '');
  lines.push(
    `- Content item: ${plan.has(`content:${itemId}`) ? plan.link(`content:${itemId}`) : inline(it.title)} · Brief: ${plan.has(`brief:${itemId}`) ? plan.link(`brief:${itemId}`) : 'n/a'} (approved brief v${inline(latest.brief_version)}, hash ${code(String(latest.brief_hash).slice(0, 12))})`,
    `- Version: **v${inline(latest.version)}** · Status: **${inline(latest.status)}** · Revision round ${inline(latest.revision_round)} of 2 · Created ${fmtTimestamp(str(latest.created_at))}`,
    `- Prompt: ${inline(str(latest.prompt_version) ?? 'n/a')} · Model: ${inline(str(latest.model_id) ?? 'n/a')} · Body hash: ${code(String(latest.body_hash).slice(0, 12))}`,
    '',
    '## Review package',
    '',
    `- Title options: ${renderInlineList(pick(pkg, 'titleOptions', 'titles'))}`,
    `- Meta description: ${inline(str(pick(pkg, 'metaDescription', 'meta')) ?? 'not provided', 400)}`,
    `- Slug suggestion: ${pick(pkg, 'slug', 'slugSuggestion') ? `${code(pick(pkg, 'slug', 'slugSuggestion'), 200)}` : 'not provided'}`,
    '',
    '### Internal-link suggestions',
    '',
    renderInternalLinkSuggestions(pick(pkg, 'internalLinks', 'internalLinkSuggestions')),
    '',
    '### Structured-data proposal',
    '',
    renderStructuredDataProposal(pick(pkg, 'structuredData', 'schema', 'structuredDataProposal')),
    '',
    '### Source ledger',
    '',
    renderValue(pick(pkg, 'sourceLedger', 'sources')),
    '',
    '### Fact-check notes',
    '',
    renderFactCheckNotes(pick(pkg, 'factCheckNotes', 'factCheck')),
    '',
    '## Draft body',
    '',
    typeof pick(pkg, 'body', 'bodyMarkdown') === 'string' ? sanitizeDraftMarkdown(String(pick(pkg, 'body', 'bodyMarkdown'))) : '_No body in the package._',
    '',
    '## Version history',
    '',
    table(
      ['Version', 'Status', 'Brief', 'Unresolved facts', 'Created'],
      versions.map((v) => [inline(`v${String(v.version)}`), cell(v.status), inline(`v${String(v.brief_version)}`), fmtInt(num(v.unresolved_facts)), fmtDate(str(v.created_at))]),
    ),
  );
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'draft',
    title: ref.title,
    frontmatter: {
      source_ids: [itemId, String(latest.id), String(latest.brief_id)],
      draft_id: str(latest.id),
      draft_version: num(latest.version),
      draft_status: str(latest.status),
      unresolved_facts: unresolved,
      brief_version: num(latest.brief_version),
      ...(isSynthetic ? { synthetic: true } : {}),
    },
    body: lines.join('\n'),
  };
}

/** Stored text in the draft note: the URL literally (a code span, never escaped or linked), other text escaped. */
const VAULT_PACKAGE_FORMAT: PackageLineFormat = { url: (u) => code(u, 400) || inline(u, 400), text: (t) => inline(t, 200) };

/**
 * Internal-link suggestions exactly as the content pipeline's draft note shows
 * them (internalLinkSuggestionLine): `- <url> ("anchor", placement)`, marked
 * UNVERIFIED unless the target was verified. A stored entry of another shape
 * is shown as stored text, never as a suggestion.
 */
function renderInternalLinkSuggestions(v: unknown): string {
  if (!Array.isArray(v)) return renderValue(v);
  if (!v.length) return '_None._';
  return v
    .map((x) => (isInternalLinkSuggestion(x) ? internalLinkSuggestionLine(x, VAULT_PACKAGE_FORMAT) : `- **unreadable suggestion** (shown as stored): ${inline(typeof x === 'string' ? x : JSON.stringify(x), 400)}`))
    .join('\n');
}

/**
 * The structured-data proposal: its note, then the JSON-LD in a code block
 * (bidi controls marked, like body text). A package with no proposal (null)
 * reads "None proposed.", never a `null` code block.
 */
function renderStructuredDataProposal(v: unknown): string {
  if (v === undefined) return '_Not provided._';
  if (v === null || v === '') return NO_STRUCTURED_DATA_PROPOSAL;
  const block = (x: unknown) => codeBlock(markBidiControls(typeof x === 'string' ? x : (JSON.stringify(x, null, 2) ?? 'null')));
  if (typeof v === 'object' && !Array.isArray(v) && 'jsonLd' in v) {
    const p = v as Record<string, unknown>;
    const head = [p.type ? `Type: ${inline(p.type, 120)}` : '', p.note ? inline(p.note, 600) : '', p.visibleContentBasis ? `Visible-content basis: ${inline(p.visibleContentBasis, 600)}` : ''].filter(Boolean);
    return [...head.flatMap((l) => [l, '']), block(p.jsonLd)].join('\n');
  }
  return block(v);
}

function renderInlineList(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map((x) => `"${inline(x, 200)}"`).join(', ') : 'none';
  if (v === undefined || v === null || v === '') return 'not provided';
  return inline(v, 400);
}

// ---------------------------------------------------------------- content farm index

export function buildContentFarmNote(rc: RenderContext): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const ref = plan.get('farm')!;
  const counts = all(rc, 'SELECT stage, COUNT(*) AS n, MAX(is_synthetic) AS syn FROM content_items WHERE site_id = ? GROUP BY stage', [site]);
  const items = all(rc, 'SELECT id, title, stage, decision, priority_score, updated_at, is_synthetic FROM content_items WHERE site_id = ? ORDER BY updated_at DESC, id LIMIT ?', [site, rc.limits.contentItems]);
  const signals = all(rc, 'SELECT origin, COUNT(*) AS n, MIN(collected_at) AS first, MAX(collected_at) AS last, MAX(is_synthetic) AS syn FROM content_signals WHERE site_id = ? GROUP BY origin ORDER BY origin', [site]);
  const cfg = ctx.config.content;
  const isSynthetic = ctx.synthetic || counts.some((c) => num(c.syn) === 1);
  const countBy = new Map(counts.map((c) => [String(c.stage), num(c.n) ?? 0]));
  // From the unlimited per-stage counts, not the (limited) item list below.
  const active = ACTIVE_PRODUCTION_STAGES.reduce((sum, stage) => sum + (countBy.get(stage) ?? 0), 0);
  const listed = items.length < counts.reduce((sum, c) => sum + (num(c.n) ?? 0), 0);
  const lines = banner(isSynthetic, ['# Content farm pipeline', '']);
  lines.push(
    'DISCOVER → DEDUPLICATE → CLASSIFY → CLUSTER → VALIDATE DEMAND → CHECK EXISTING CONTENT → PRIORITIZE → BRIEF → DRAFT → QUALITY GATES → HUMAN REVIEW → EXPORT/PUBLISH WHEN AUTHORIZED → MEASURE',
    '',
    `- Active production items (briefed through exported): **${active}** · configured limit: ${cfg.maxInProduction}${active > cfg.maxInProduction ? ' · OVER LIMIT' : ''}`,
    `- Batch expansion: ${cfg.batchEnabled ? 'enabled' : 'disabled'} · Pilot approved: ${yesNo(cfg.pilotApproved)}`,
    '- Nothing is drafted or published automatically. Human review and a CLI approval are required for publication.',
    '',
    '## Items by stage',
    '',
  );
  const stageRows = STAGE_ORDER.filter((s) => countBy.has(s)).map((s) => [cell(s), fmtInt(countBy.get(s) ?? 0)]);
  lines.push(stageRows.length ? table(['Stage', 'Items'], stageRows) : '_No content items yet. Discovery is an explicitly enabled, separate queue._', '');
  if (items.length) {
    lines.push(
      '## Items',
      '',
      ...(listed ? [`Showing the ${fmtInt(items.length)} most recently updated items; the counts above include every item.`, ''] : []),
      table(
        ['Item', 'Stage', 'Decision', 'Priority', 'Brief', 'Draft', 'Updated'],
        items.map((i) => {
          const id = String(i.id);
          return [
            plan.has(`content:${id}`) ? rawCell(plan.link(`content:${id}`)) : cell(i.title),
            cell(i.stage),
            cell(str(i.decision) ?? 'undecided'),
            i.priority_score === null ? 'not scored' : fmtNum(num(i.priority_score), 2),
            plan.has(`brief:${id}`) ? rawCell(plan.link(`brief:${id}`, 'brief')) : '-',
            plan.has(`draft:${id}`) ? rawCell(plan.link(`draft:${id}`, 'draft')) : '-',
            fmtDate(str(i.updated_at)),
          ];
        }),
      ),
      '',
    );
  }
  lines.push('## Discovery signals by origin', '');
  lines.push(
    signals.length
      ? table(
          ['Origin', 'Signals', 'First collected', 'Last collected', 'Synthetic'],
          signals.map((s) => [cell(s.origin), fmtInt(num(s.n)), fmtDate(str(s.first)), fmtDate(str(s.last)), yesNo(num(s.syn))]),
        ) + '\n\nForum or social engagement is not Google search volume.'
      : '_No discovery signals recorded._',
  );
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'content_farm_index',
    title: ref.title,
    frontmatter: { source_ids: [], active_items: active, max_in_production: cfg.maxInProduction, ...(isSynthetic ? { synthetic: true } : {}) },
    body: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- AI search

export function buildAiSearchNote(rc: RenderContext): GeneratedNote {
  const { ctx, plan } = rc;
  const ref = plan.get('ai_search')!;
  const checks = all(rc, 'SELECT * FROM ai_citation_checks WHERE site_id = ? ORDER BY checked_at DESC, id LIMIT 50', [ctx.siteId]);
  const isSynthetic = ctx.synthetic || checks.some((c) => num(c.is_synthetic) === 1);
  const enabled = ctx.settings.features.aiCitations;
  const aeo = aeoIndexSection(rc);
  const labelSynthetic = isSynthetic || aeo.synthetic;
  const lines = banner(labelSynthetic, ['# AI citation checks', '']);
  lines.push(
    `- Monitoring: ${enabled ? 'enabled (separately budgeted)' : 'disabled (optional, separately budgeted, off by default)'}`,
    '- A brand mention is not a citation, a citation is not a click, and a click is not a conversion.',
    '',
  );
  lines.push(
    checks.length
      ? table(
          ['Checked', 'Engine', 'Query', 'Method', 'Grounded', 'Brand mentioned', 'Our site cited'],
          checks.map((c) => [fmtDate(str(c.checked_at)), cell(c.engine), cell(c.query, 160), cell(c.method), yesNo(num(c.is_grounded)), yesNo(num(c.brand_mentioned)), yesNo(num(c.own_site_cited))]),
        )
      : 'DATA UNAVAILABLE: no AI citation checks recorded.',
  );
  // Page-level AEO readiness (spec 17) of our own pages, from the latest own-site crawl.
  lines.push('', ...aeo.lines);
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'ai_search_index',
    title: ref.title,
    frontmatter: { source_ids: [...checks.map((c) => String(c.id)).slice(0, 50), ...aeo.sourceIds], checks: checks.length, ...(labelSynthetic ? { synthetic: true } : {}) },
    body: lines.join('\n'),
  };
}

