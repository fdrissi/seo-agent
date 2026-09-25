import type { AppContext } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import { formatMoney, fromMicros } from '../core/money.js';
import type { IntegrationStatus } from '../integrations/types.js';
import { buildContentFarmNote, buildContentItemNote, buildBriefNote, buildDraftNote, buildAiSearchNote } from './notes-content.js';
import { buildDashboardNote, buildIndexNote } from './dashboard.js';
import {
  bulletList,
  callout,
  cell,
  code,
  describeJson,
  fmtDate,
  fmtInt,
  fmtNum,
  fmtPct,
  fmtTimestamp,
  inline,
  maskCredentialUrlParams,
  parseJsonSafe,
  quoteUntrusted,
  rawCell,
  syntheticBanner,
  table,
  yesNo,
} from './markdown.js';
import { aeoPageSection, internalLinksPageSection } from './notes-site.js';
import { NotePlan, type PlanningWriter } from './plan.js';
import {
  all,
  DEFAULT_RENDER_LIMITS,
  dateRange,
  ga4Window,
  gscWindow,
  normalizeDomain,
  normalizeQuery,
  num,
  one,
  pickGa4,
  pickGsc,
  placeholders,
  renderGa4Window,
  renderGscWindow,
  str,
  subjectLink,
  type RenderContext,
  type RenderLimits,
  type Row,
} from './render-context.js';
import { markStaleNotes, markSupersededContentNotes, type StaleNoteOutcome } from './stale.js';
import type { GeneratedNote, VaultWriter, WriteStatus } from './types.js';
import type { VaultWriteOutcome } from './writer.js';
import { wikilinkTarget } from './wikilinks.js';

/**
 * Note renderers: build GeneratedNote objects from SQLite rows (SQLite is the
 * source of truth; notes present it). `renderAll(ctx, writer)` plans every
 * note first (stable paths), then renders bodies with validated path-aware
 * wikilinks, then writes through the VaultWriter (which preserves human
 * content and creates conflict artifacts instead of overwriting edits).
 */

export const RENDER_KINDS = ['dashboard', 'index', 'pages', 'keywords', 'competitors', 'experiments', 'decisions', 'learnings', 'sources', 'content', 'ai_search'] as const;
export type RenderKind = (typeof RENDER_KINDS)[number];

export const FOLDERS = {
  dashboard: '00 Dashboard',
  pages: '02 Website/Pages',
  keywords: '03 Keywords',
  competitors: '04 Competitors',
  briefs: '05 Content/Briefs',
  drafts: '05 Content/Drafts',
  experiments: '06 Experiments',
  sources: '08 Research/Sources',
  aiSearch: '09 AI Search',
  opportunities: '10 Content Opportunities',
  farm: '11 Content Farm',
  decisions: '12 Decisions',
  learnings: '13 Learnings',
} as const;

export interface RenderOptions {
  only?: RenderKind[];
  limits?: Partial<RenderLimits>;
  /** Integration statuses collected by the caller (see status.ts); shown on the dashboard. */
  integrationStatuses?: IntegrationStatus[] | null;
  /** Caveat shown under the statuses (for example "offline checks only"). */
  integrationStatusNote?: string | null;
  windowDays?: number;
}

export interface RenderSummary {
  status: 'rendered' | 'disabled';
  detail: string;
  vaultDir: string;
  dryRun: boolean;
  counts: Record<WriteStatus, number>;
  byKind: Record<string, number>;
  outcomes: VaultWriteOutcome[];
  conflicts: Array<{ relPath: string; conflictPath?: string; reason?: string }>;
  errors: Array<{ key: string; relPath?: string; error: string }>;
  /** Notes that failed to build or write and are not on disk: no generated note links to them. */
  withdrawn: Array<{ key: string; relPath: string; reason: string }>;
  /**
   * Generated entity notes whose record no longer exists, and legacy duplicate
   * content notes (written by earlier versions of the `content` commands;
   * `supersededBy` set), marked `status: stale` in place (never deleted; human
   * text preserved; edited notes get conflicts).
   */
  stale?: StaleNoteOutcome[];
}

// ---------------------------------------------------------------- page names

export function pageDisplayName(url: string, primaryHost: string | null): string {
  let host = '';
  let pathname = '/';
  let search = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    pathname = u.pathname;
    search = u.search;
  } catch {
    pathname = url;
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* keep raw */
  }
  const segments = decoded.split('/').filter(Boolean);
  let name = segments.length ? segments.map((seg) => seg.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' - ') || 'Home' : 'Home';
  name = name.charAt(0).toUpperCase() + name.slice(1);
  // Credential query parameters (?token=, &sig=, ...) never become part of a note name.
  if (search) name += ` (${maskCredentialUrlParams(search).slice(1)})`;
  if (primaryHost && host && host.toLowerCase() !== primaryHost.toLowerCase()) name = `${host} - ${name}`;
  return name;
}

function primaryHostOf(ctx: AppContext): string | null {
  try {
    return new URL(ctx.config.site.url).hostname;
  } catch {
    return null;
  }
}

function syntheticProps(isSynthetic: boolean): Record<string, unknown> {
  return isSynthetic ? { synthetic: true } : {};
}

function withBanner(isSynthetic: boolean, lines: string[]): string[] {
  return isSynthetic ? [syntheticBanner(), '', ...lines] : lines;
}

// ---------------------------------------------------------------- planning

interface Planned {
  kind: RenderKind;
  key: string;
  build: () => GeneratedNote;
}

/**
 * A note for an entity that is not rendered in this run is a valid link
 * target only if it is tracked in its expected folder AND its file is on disk
 * (a tracked row alone is not enough: the file may have been deleted).
 */
function existingNote(rc: RenderContext, noteId: string, folder: string): boolean {
  const row = one(rc, 'SELECT rel_path FROM vault_notes WHERE site_id = ? AND note_id = ?', [rc.ctx.siteId, noteId]);
  if (!row) return false;
  const relPath = String(row.rel_path);
  return relPath.startsWith(`${folder}/`) && rc.plan.fileExists(relPath);
}

/** Plan all entities. Kinds not selected are planned only if their note already exists on disk (so links stay valid). */
function planEntities(rc: RenderContext, selected: Set<RenderKind>): Planned[] {
  const { ctx, plan, limits } = rc;
  const site = ctx.siteId;
  const out: Planned[] = [];
  const want = (kind: RenderKind, noteId: string, folder: string) => selected.has(kind) || existingNote(rc, noteId, folder);
  const primaryHost = primaryHostOf(ctx);

  // Pages
  const pages = all(
    rc,
    `SELECT p.*, (SELECT title FROM crawl_results cr WHERE cr.site_id = p.site_id AND cr.page_id = p.id AND cr.title IS NOT NULL ORDER BY cr.fetched_at DESC LIMIT 1) AS crawl_title
       FROM pages p WHERE p.site_id = ? AND p.is_excluded = 0 ORDER BY p.is_protected DESC, p.path, p.id LIMIT ?`,
    [site, limits.pages],
  );
  for (const p of pages) {
    const id = String(p.id);
    if (!want('pages', id, FOLDERS.pages)) continue;
    const name = pageDisplayName(String(p.url), primaryHost);
    plan.add(`page:${id}`, { noteId: id, kind: 'page', folder: FOLDERS.pages, name, title: str(p.crawl_title) ?? name });
    out.push({ kind: 'pages', key: `page:${id}`, build: () => buildPageNote(rc, p) });
  }

  // Keywords
  const keywords = all(rc, 'SELECT * FROM keywords WHERE site_id = ? ORDER BY first_seen_at, id LIMIT ?', [site, limits.keywords]);
  for (const k of keywords) {
    const id = String(k.id);
    if (!want('keywords', id, FOLDERS.keywords)) continue;
    const ref = plan.add(`keyword:${id}`, { noteId: id, kind: 'keyword', folder: FOLDERS.keywords, name: String(k.keyword), title: String(k.keyword) });
    rc.keywordByNormalized.set(normalizeQuery(String(k.normalized ?? k.keyword)), ref.key);
    out.push({ kind: 'keywords', key: ref.key, build: () => buildKeywordNote(rc, k) });
  }

  // Competitors
  const competitors = all(rc, 'SELECT * FROM competitors WHERE site_id = ? ORDER BY domain LIMIT ?', [site, limits.competitors]);
  for (const c of competitors) {
    const id = String(c.id);
    if (!want('competitors', id, FOLDERS.competitors)) continue;
    const ref = plan.add(`competitor:${id}`, { noteId: id, kind: 'competitor', folder: FOLDERS.competitors, name: String(c.domain), title: str(c.name) ?? String(c.domain) });
    rc.competitorByDomain.set(normalizeDomain(String(c.domain)), ref.key);
    out.push({ kind: 'competitors', key: ref.key, build: () => buildCompetitorNote(rc, c) });
  }

  // Experiments
  const experiments = all(rc, 'SELECT * FROM experiments WHERE site_id = ? ORDER BY created_at DESC, id LIMIT ?', [site, limits.experiments]);
  for (const e of experiments) {
    const id = String(e.id);
    if (!want('experiments', id, FOLDERS.experiments)) continue;
    const pageUrl = e.page_id ? str(one(rc, 'SELECT url FROM pages WHERE site_id = ? AND id = ?', [site, e.page_id])?.url) : null;
    const target = pageUrl ? pageDisplayName(pageUrl, primaryHost) : 'site';
    const name = `${fmtDate(str(e.created_at))} ${String(e.type)} - ${target}`;
    plan.add(`experiment:${id}`, { noteId: id, kind: 'experiment', folder: FOLDERS.experiments, name, title: `Experiment: ${String(e.type)} on ${target}` });
    out.push({ kind: 'experiments', key: `experiment:${id}`, build: () => buildExperimentNote(rc, e) });
  }

  // Sources (with evidence)
  const sources = all(
    rc,
    `SELECT s.* FROM sources s WHERE s.site_id = ? AND EXISTS (SELECT 1 FROM evidence e WHERE e.site_id = s.site_id AND e.source_id = s.id)
      ORDER BY s.retrieved_at DESC, s.id LIMIT ?`,
    [site, limits.sources],
  );
  for (const s of sources) {
    const id = String(s.id);
    if (!want('sources', id, FOLDERS.sources)) continue;
    const name = sourceName(s);
    plan.add(`source:${id}`, { noteId: id, kind: 'source', folder: FOLDERS.sources, name, title: name });
    out.push({ kind: 'sources', key: `source:${id}`, build: () => buildSourceNote(rc, s) });
  }

  // Content items, briefs, drafts
  const items = all(rc, 'SELECT * FROM content_items WHERE site_id = ? ORDER BY created_at, id LIMIT ?', [site, limits.contentItems]);
  for (const it of items) {
    const id = String(it.id);
    if (want('content', id, FOLDERS.opportunities)) {
      plan.add(`content:${id}`, { noteId: id, kind: 'content_opportunity', folder: FOLDERS.opportunities, name: String(it.title), title: String(it.title) });
      out.push({ kind: 'content', key: `content:${id}`, build: () => buildContentItemNote(rc, it) });
    }
    const hasBrief = one(rc, 'SELECT 1 AS x FROM content_briefs WHERE site_id = ? AND content_item_id = ? LIMIT 1', [site, id]);
    if (hasBrief && want('content', `${id}.brief`, FOLDERS.briefs)) {
      plan.add(`brief:${id}`, { noteId: `${id}.brief`, kind: 'brief', folder: FOLDERS.briefs, name: `Brief - ${String(it.title)}`, title: `Brief: ${String(it.title)}` });
      out.push({ kind: 'content', key: `brief:${id}`, build: () => buildBriefNote(rc, it) });
    }
    const hasDraft = one(rc, 'SELECT 1 AS x FROM content_drafts WHERE site_id = ? AND content_item_id = ? LIMIT 1', [site, id]);
    if (hasDraft && want('content', `${id}.draft`, FOLDERS.drafts)) {
      plan.add(`draft:${id}`, { noteId: `${id}.draft`, kind: 'draft', folder: FOLDERS.drafts, name: `Draft - ${String(it.title)}`, title: `Draft: ${String(it.title)}` });
      out.push({ kind: 'content', key: `draft:${id}`, build: () => buildDraftNote(rc, it) });
    }
  }

  // Decisions
  const decisions = all(rc, 'SELECT * FROM decisions WHERE site_id = ? ORDER BY decided_at DESC, id LIMIT ?', [site, limits.decisions]);
  for (const d of decisions) {
    const id = String(d.id);
    if (!want('decisions', id, FOLDERS.decisions)) continue;
    const name = `${fmtDate(str(d.decided_at))} ${String(d.decision).slice(0, 70)}`;
    plan.add(`decision:${id}`, { noteId: id, kind: 'decision', folder: FOLDERS.decisions, name, title: `Decision: ${String(d.decision).slice(0, 120)}` });
    out.push({ kind: 'decisions', key: `decision:${id}`, build: () => buildDecisionNote(rc, d) });
  }

  // Learnings
  const learnings = all(rc, 'SELECT * FROM learnings WHERE site_id = ? ORDER BY created_at DESC, id LIMIT ?', [site, limits.learnings]);
  for (const l of learnings) {
    const id = String(l.id);
    if (!want('learnings', id, FOLDERS.learnings)) continue;
    const name = String(l.statement).slice(0, 80);
    plan.add(`learning:${id}`, { noteId: id, kind: 'learning', folder: FOLDERS.learnings, name, title: `Learning: ${String(l.statement).slice(0, 120)}` });
    out.push({ kind: 'learnings', key: `learning:${id}`, build: () => buildLearningNote(rc, l) });
  }

  // Index notes (always planned so the dashboard can link to them)
  const farmId = `content-farm-${site}`;
  if (want('content', farmId, FOLDERS.farm)) {
    plan.add('farm', { noteId: farmId, kind: 'content_farm_index', folder: FOLDERS.farm, name: 'Pipeline', title: 'Content farm pipeline' });
    out.push({ kind: 'content', key: 'farm', build: () => buildContentFarmNote(rc) });
  }
  const aiId = `ai-search-${site}`;
  if (want('ai_search', aiId, FOLDERS.aiSearch)) {
    plan.add('ai_search', { noteId: aiId, kind: 'ai_search_index', folder: FOLDERS.aiSearch, name: 'AI Citation Checks', title: 'AI citation checks' });
    out.push({ kind: 'ai_search', key: 'ai_search', build: () => buildAiSearchNote(rc) });
  }
  const indexId = `vault-index-${site}`;
  if (want('index', indexId, FOLDERS.dashboard)) {
    plan.add('index', { noteId: indexId, kind: 'vault_index', folder: FOLDERS.dashboard, name: 'Index', title: 'Vault index' });
    out.push({ kind: 'index', key: 'index', build: () => buildIndexNote(rc) });
  }
  const dashId = `dashboard-${site}`;
  if (want('dashboard', dashId, FOLDERS.dashboard)) {
    plan.add('dashboard', { noteId: dashId, kind: 'dashboard', folder: FOLDERS.dashboard, name: 'Dashboard', title: `Dashboard: ${ctx.config.site.businessName}` });
    out.push({ kind: 'dashboard', key: 'dashboard', build: () => buildDashboardNote(rc) });
  }
  return out;
}

function sourceName(s: Row): string {
  const title = str(s.title);
  if (title) return title.slice(0, 90);
  const url = str(s.url);
  if (url) {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 90);
    } catch {
      return url.slice(0, 90);
    }
  }
  return `${String(s.source_type)} ${fmtDate(str(s.retrieved_at))}`;
}

export function createRenderContext(ctx: AppContext, writer: PlanningWriter, opts: RenderOptions = {}): RenderContext {
  return {
    ctx,
    plan: new NotePlan(ctx.db, ctx.siteId, writer),
    limits: { ...DEFAULT_RENDER_LIMITS, ...(opts.limits ?? {}) },
    windowDays: opts.windowDays ?? 28,
    gsc: pickGsc(ctx),
    ga4: pickGa4(ctx),
    nowIso: ctx.clock.now().toISOString(),
    integrationStatuses: opts.integrationStatuses ?? null,
    integrationStatusNote: opts.integrationStatusNote ?? null,
    keywordByNormalized: new Map(),
    competitorByDomain: new Map(),
    cache: new Map(),
  };
}

/** Plan every selected note (stable paths) without building bodies. */
export function planRender(ctx: AppContext, writer: PlanningWriter, opts: RenderOptions = {}): { rc: RenderContext; planned: Planned[] } {
  const rc = createRenderContext(ctx, writer, opts);
  const selected = new Set<RenderKind>(opts.only?.length ? opts.only : RENDER_KINDS);
  const planned = planEntities(rc, selected).filter((p) => selected.has(p.kind));
  return { rc, planned };
}

/** Build (but do not write) every selected note. Useful for previews and tests. */
export function buildNotes(ctx: AppContext, writer: PlanningWriter, opts: RenderOptions = {}): { rc: RenderContext; notes: Array<{ kind: RenderKind; key: string; note?: GeneratedNote; error?: string }> } {
  const { rc, planned } = planRender(ctx, writer, opts);
  const notes = planned.map((p) => {
    try {
      return { kind: p.kind, key: p.key, note: p.build() };
    } catch (err) {
      return { kind: p.kind, key: p.key, error: errorMessage(err) };
    }
  });
  return { rc, notes };
}

/**
 * Regenerate the vault from SQLite. Never overwrites human edits (see writer).
 * Entity notes are written first; the index and dashboard are built last so
 * they reflect conflicts detected in this same render.
 */
export function renderAll(ctx: AppContext, writer: VaultWriter, opts: RenderOptions = {}): RenderSummary {
  const counts: Record<WriteStatus, number> = { created: 0, updated: 0, unchanged: 0, conflict: 0 };
  const dryRun = (writer as { dryRun?: boolean }).dryRun ?? ctx.dryRun;
  if (!ctx.settings.features.obsidian) {
    return {
      status: 'disabled',
      detail: 'Obsidian-compatible vault output is disabled for this site (features.obsidian = false). Enable it in the site config to render notes.',
      vaultDir: writer.vaultDir,
      dryRun,
      counts,
      byKind: {},
      outcomes: [],
      conflicts: [],
      errors: [],
      withdrawn: [],
      stale: [],
    };
  }
  const { rc, planned } = planRender(ctx, writer as unknown as PlanningWriter, opts);
  const entities = planned.filter((p) => p.kind !== 'dashboard' && p.kind !== 'index');
  const tail = [...planned.filter((p) => p.kind === 'index'), ...planned.filter((p) => p.kind === 'dashboard')];
  const outcomes: RenderSummary['outcomes'] = [];
  // Notes whose untrusted name was unsafe were planned under a note-id-based name (not aborted): report them.
  const errors: RenderSummary['errors'] = rc.plan.errors.map((e) => ({ key: e.key, relPath: e.relPath, error: e.error }));
  const withdrawn: RenderSummary['withdrawn'] = [];
  const byKind: Record<string, number> = {};

  // A planned note that fails and does not exist on disk is withdrawn from the plan, so no note links to it.
  const withdraw = (key: string, reason: string): boolean => {
    const ref = rc.plan.get(key);
    if (!ref || rc.plan.fileExists(ref.relPath)) return false;
    rc.plan.remove(key);
    withdrawn.push({ key, relPath: ref.relPath, reason });
    return true;
  };
  const buildAll = (list: Planned[]) => list.map((p) => {
    try {
      return { p, note: p.build() };
    } catch (err) {
      return { p, error: errorMessage(err) };
    }
  });

  // 1. Build every entity note; withdraw failures, then rebuild once so no body links to them.
  let built = buildAll(entities);
  const buildFailures = built.filter((b) => b.error !== undefined);
  if (buildFailures.map((b) => withdraw(b.p.key, 'failed to build')).some(Boolean)) {
    const failedKeys = new Set(buildFailures.map((b) => b.p.key));
    built = [...buildAll(entities.filter((p) => !failedKeys.has(p.key))), ...buildFailures];
  }
  for (const b of built) if (b.error !== undefined) errors.push({ key: b.p.key, error: b.error });

  // 2. Write. A new note that fails to write is withdrawn and the notes already written that link to it are rebuilt.
  const written: Array<{ p: Planned; note: GeneratedNote; index: number }> = [];
  const write = (p: Planned, note: GeneratedNote): VaultWriteOutcome | null => {
    try {
      const outcome = writer.writeGenerated(note) as VaultWriteOutcome;
      return { ...outcome, noteId: outcome.noteId ?? note.noteId, kind: outcome.kind ?? note.kind };
    } catch (err) {
      errors.push({ key: p.key, relPath: note.relPath, error: errorMessage(err) });
      return null;
    }
  };
  const record = (outcome: VaultWriteOutcome, kind: string): number => {
    counts[outcome.status]++;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    return outcomes.push(outcome) - 1;
  };
  const writeFailedPaths: string[] = [];
  for (const b of built) {
    if (!b.note) continue;
    if (writeFailedPaths.some((rel) => linksTo(b.note!.body, rel))) {
      // Built before an earlier target failed: rebuild so it does not link to it.
      try {
        b.note = b.p.build();
      } catch (err) {
        errors.push({ key: b.p.key, relPath: b.note.relPath, error: `rebuild after a failed link target: ${errorMessage(err)}` });
        continue;
      }
    }
    const outcome = write(b.p, b.note);
    if (!outcome) {
      if (withdraw(b.p.key, 'failed to write')) writeFailedPaths.push(b.note.relPath);
      continue;
    }
    const index = record(outcome, b.note.kind);
    if (outcome.status !== 'conflict') written.push({ p: b.p, note: b.note, index });
  }
  if (writeFailedPaths.length) {
    for (const w of written) {
      if (!writeFailedPaths.some((rel) => linksTo(w.note.body, rel))) continue;
      let note: GeneratedNote;
      try {
        note = w.p.build();
      } catch (err) {
        errors.push({ key: w.p.key, relPath: w.note.relPath, error: `rebuild after a failed link target: ${errorMessage(err)}` });
        continue;
      }
      const again = write(w.p, note);
      const first = outcomes[w.index]!;
      if (again && again.status !== 'unchanged' && first.status !== again.status && first.status === 'unchanged') {
        counts[first.status]--;
        counts[again.status]++;
        outcomes[w.index] = again;
      }
    }
  }

  // 2b. Tracked entity notes whose record no longer exists: marked stale in place (never deleted).
  const selected = new Set<RenderKind>(opts.only?.length ? opts.only : RENDER_KINDS);
  const staleRun = markStaleNotes(rc, writer, selected);
  for (const o of staleRun.outcomes) record(o, o.kind);
  errors.push(...staleRun.errors);
  // 2c. Content notes written by earlier versions of the `content` commands: stale duplicates, marked in place.
  const supersededRun = markSupersededContentNotes(rc, writer, selected);
  for (const o of supersededRun.outcomes) record(o, o.kind);
  errors.push(...supersededRun.errors);
  rc.staleNotes = [...staleRun.stale, ...supersededRun.stale];

  // 3. The index and the dashboard last, so they reflect this run (conflicts, withdrawn and stale notes).
  for (const p of tail) {
    let note: GeneratedNote;
    try {
      note = p.build();
    } catch (err) {
      errors.push({ key: p.key, error: errorMessage(err) });
      continue;
    }
    const outcome = write(p, note);
    if (outcome) record(outcome, note.kind);
  }

  const conflicts = outcomes
    .filter((o) => o.status === 'conflict')
    .map((o) => ({ relPath: o.relPath, ...(o.conflictPath ? { conflictPath: o.conflictPath } : {}), ...(o.reason ? { reason: o.reason } : {}) }));
  const allStale = [...staleRun.stale, ...supersededRun.stale];
  const staleNew = allStale.filter((x) => x.status !== 'unchanged');
  const detail = `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.conflict} conflict(s), ${errors.length} error(s)${staleRun.stale.length ? `, ${staleRun.stale.length} stale note(s) (record no longer exists)` : ''}${supersededRun.stale.length ? `, ${supersededRun.stale.length} legacy duplicate content note(s) marked stale (see \`vault check\`)` : ''}`;
  if (!dryRun) {
    writer.appendSystemLog(
      `Vault render: ${detail}.${withdrawn.length ? ` Not linked (failed, not on disk): ${withdrawn.map((w) => w.relPath).join(', ')}.` : ''}${staleNew.length ? ` Marked stale: ${staleNew.map((x) => `${x.relPath} (${x.status})`).join(', ')}.` : ''}`,
    );
  }
  return { status: 'rendered', detail, vaultDir: writer.vaultDir, dryRun, counts, byKind, outcomes, conflicts, errors, withdrawn, stale: allStale };
}

/** True when a generated body contains a wikilink to `relPath` (plain or table-escaped, with or without `.md`). */
function linksTo(body: string, relPath: string): boolean {
  const target = wikilinkTarget(relPath);
  return [`[[${target}|`, `[[${target}\\|`, `[[${target}]]`, `[[${target}.md|`, `[[${target}.md\\|`, `[[${target}.md]]`].some((s) => body.includes(s));
}

// ---------------------------------------------------------------- page notes

export function buildPageNote(rc: RenderContext, p: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const id = String(p.id);
  const ref = plan.get(`page:${id}`)!;
  const isSynthetic = p.first_source === 'fixture' || ctx.synthetic;
  const url = String(p.url);

  const crawl = one(
    rc,
    `SELECT cr.*, c.is_synthetic AS crawl_is_synthetic FROM crawl_results cr LEFT JOIN crawls c ON c.id = cr.crawl_id AND c.site_id = cr.site_id
      WHERE cr.site_id = ? AND cr.page_id = ? ORDER BY cr.fetched_at DESC LIMIT 1`,
    [site, id],
  );
  const route = one(rc, 'SELECT * FROM route_decisions WHERE site_id = ? AND page_id = ? ORDER BY decided_at DESC LIMIT 1', [site, id]);
  const gsc = gscWindow(rc, 'gsc_page_daily_current', { pageId: id });
  const ga4 = ga4Window(rc, { pageId: id });
  const issues = all(
    rc,
    `SELECT issue_type, severity, confirmed, is_heuristic, last_seen_at FROM technical_issues
      WHERE site_id = ? AND (page_id = ? OR url = ?) AND status = 'open'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, issue_type LIMIT 50`,
    [site, id, url],
  );
  const perf = all(rc, 'SELECT source, data_kind, field_scope, device, metrics_json, checked_at, is_synthetic FROM performance_checks WHERE site_id = ? AND page_id = ? ORDER BY checked_at DESC LIMIT 20', [site, id]);
  const latestPerf = new Map<string, Row>();
  for (const r of perf) {
    const k = `${String(r.data_kind)}:${String(r.device)}`;
    if (!latestPerf.has(k)) latestPerf.set(k, r);
  }

  // Visible query rows (targeted page/query dataset).
  let queries: Row[] = [];
  let queryWindow = '';
  if (rc.gsc) {
    const latest = str(one(rc, "SELECT MAX(date) AS d FROM gsc_page_query_daily_current WHERE site_id = ? AND property = ? AND search_type = ? AND page_id = ? AND segment_key = ''", [site, rc.gsc.property, rc.gsc.searchType, id])?.d);
    if (latest) {
      const start = new Date(Date.parse(`${latest}T00:00:00Z`) - (rc.windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
      queryWindow = `${start} to ${latest}`;
      queries = all(
        rc,
        `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) AS pw
           FROM gsc_page_query_daily_current
          WHERE site_id = ? AND property = ? AND search_type = ? AND page_id = ? AND segment_key = '' AND date BETWEEN ? AND ?
          GROUP BY query ORDER BY impressions DESC, query LIMIT 15`,
        [site, rc.gsc.property, rc.gsc.searchType, id, start, latest],
      );
    }
  }

  const keywordKeys = new Set<string>();
  for (const r of all(rc, 'SELECT DISTINCT keyword_id FROM rankings WHERE site_id = ? AND page_id = ? AND keyword_id IS NOT NULL', [site, id])) {
    if (plan.has(`keyword:${String(r.keyword_id)}`)) keywordKeys.add(`keyword:${String(r.keyword_id)}`);
  }
  for (const q of queries) {
    const k = rc.keywordByNormalized.get(normalizeQuery(String(q.query)));
    if (k) keywordKeys.add(k);
  }
  const keywordIds = [...keywordKeys].map((k) => k.slice('keyword:'.length));
  const competitorKeys = new Set<string>();
  if (keywordIds.length) {
    for (const r of all(
      rc,
      `SELECT DISTINCT sr.domain FROM serp_results sr JOIN serp_snapshots ss ON ss.id = sr.snapshot_id
        WHERE ss.site_id = ? AND sr.site_id = ? AND sr.is_own_site = 0 AND sr.domain IS NOT NULL AND ss.keyword_id IN (${placeholders(keywordIds)})`,
      [site, site, ...keywordIds],
    )) {
      const k = rc.competitorByDomain.get(normalizeDomain(String(r.domain)));
      if (k) competitorKeys.add(k);
    }
  }

  const opportunities = all(rc, 'SELECT * FROM opportunities WHERE site_id = ? AND page_id = ? ORDER BY updated_at DESC, id LIMIT 20', [site, id]);
  const recommendations = all(rc, 'SELECT * FROM recommendations WHERE site_id = ? AND page_id = ? ORDER BY created_at DESC, id LIMIT 20', [site, id]);
  const experiments = all(rc, 'SELECT id, type, status FROM experiments WHERE site_id = ? AND page_id = ? ORDER BY created_at DESC', [site, id]);
  const contentItems = all(rc, 'SELECT id, title, stage FROM content_items WHERE site_id = ? AND target_page_id = ? ORDER BY created_at DESC', [site, id]);
  const decisions = all(
    rc,
    `SELECT id FROM decisions WHERE site_id = ? AND (
        (subject_type = 'page' AND subject_id = ?)
     OR (subject_type = 'experiment' AND subject_id IN (SELECT id FROM experiments WHERE site_id = ? AND page_id = ?))
     OR (subject_type = 'recommendation' AND subject_id IN (SELECT id FROM recommendations WHERE site_id = ? AND page_id = ?))
     OR (subject_type = 'opportunity' AND subject_id IN (SELECT id FROM opportunities WHERE site_id = ? AND page_id = ?))
     OR (subject_type IN ('content_item', 'content') AND subject_id IN (SELECT id FROM content_items WHERE site_id = ? AND target_page_id = ?)))
     ORDER BY decided_at DESC LIMIT 30`,
    [site, id, site, id, site, id, site, id, site, id],
  );
  const claims = all(
    rc,
    `SELECT ce.claim_label, ce.claim_text, ce.support, ce.subject_type, ce.subject_id, e.summary, e.source_id
       FROM claim_evidence ce LEFT JOIN evidence e ON e.id = ce.evidence_id AND e.site_id = ce.site_id
      WHERE ce.site_id = ? AND (
            (ce.subject_type = 'recommendation' AND ce.subject_id IN (SELECT id FROM recommendations WHERE site_id = ? AND page_id = ?))
         OR (ce.subject_type = 'opportunity' AND ce.subject_id IN (SELECT id FROM opportunities WHERE site_id = ? AND page_id = ?))
         OR (ce.subject_type = 'experiment' AND ce.subject_id IN (SELECT id FROM experiments WHERE site_id = ? AND page_id = ?)))
      ORDER BY ce.created_at DESC LIMIT 30`,
    [site, site, id, site, id, site, id],
  );

  const sourceIds = new Set<string>();
  for (const c of claims) if (c.source_id) sourceIds.add(String(c.source_id));

  const lines: string[] = withBanner(isSynthetic, [`# ${inline(ref.title, 200)}`, '']);
  lines.push(
    `- URL: ${code(url, 400)}`,
    `- Page type: ${inline(str(p.page_type) ?? 'unknown')} · Language: ${inline(str(p.language) ?? 'unknown')} · Lifecycle: ${inline(str(p.lifecycle))}`,
    `- Protected: ${yesNo(num(p.is_protected))}${num(p.is_protected) ? ' (never proposed for deletion, redirect, or noindex without explicit owner review)' : ''}`,
    `- First seen ${fmtDate(str(p.first_seen_at))} via ${inline(str(p.first_source))}; last seen ${fmtDate(str(p.last_seen_at))}`,
    '',
    '## Route',
    '',
  );
  if (route) {
    const reasons = parseJsonSafe<unknown[]>(route.reason_codes_json) ?? [];
    lines.push(
      `- **${inline(route.route)}** (decided by ${inline(route.decided_by)} on ${fmtTimestamp(str(route.decided_at))}, rules ${inline(route.rules_version)})`,
      `- Reason codes: ${reasons.length ? reasons.map((r) => `${code(typeof r === 'string' ? r : JSON.stringify(r), 120)}`).join(', ') : 'none recorded'}`,
    );
  } else lines.push('_No routing decision recorded yet._');

  lines.push('', '## Metrics', '', ...renderGscWindow(rc, gsc, 'Search Console page totals'), ...renderGa4Window(ga4, 'GA4 landing page'));
  lines.push('- Page totals and property totals are separate datasets; they are never summed together.');

  lines.push('', '### Top visible queries', '');
  if (queries.length) {
    lines.push(
      `Visible page/query rows, ${queryWindow}. Anonymized queries are omitted and row limits apply: these rows are NOT page totals.`,
      '',
      table(
        ['Query', 'Clicks', 'Impressions', 'CTR', 'Avg position'],
        queries.map((q) => {
          const k = rc.keywordByNormalized.get(normalizeQuery(String(q.query)));
          const imp = num(q.impressions) ?? 0;
          const clk = num(q.clicks) ?? 0;
          const pw = num(q.pw);
          return [k ? rawCell(plan.link(k, String(q.query))) : cell(q.query), fmtInt(clk), fmtInt(imp), imp > 0 ? fmtPct(clk / imp) : 'n/a', imp > 0 && pw !== null ? fmtNum(pw / imp, 1) : 'n/a'];
        }),
      ),
    );
  } else lines.push('DATA UNAVAILABLE: no page/query detail has been fetched for this page (it is fetched only for shortlisted pages).');

  lines.push('', '## Crawl snapshot', '');
  if (crawl) {
    lines.push(
      `- Fetched ${fmtTimestamp(str(crawl.fetched_at))} (${inline(crawl.render_mode)})${num(crawl.crawl_is_synthetic) === 1 ? ' · SYNTHETIC crawl' : ''} · HTTP ${inline(str(crawl.status_code) ?? 'n/a')}${crawl.final_url && crawl.final_url !== crawl.requested_url ? ` · final URL ${code(crawl.final_url, 300)}` : ''}`,
      `- Title: ${crawl.title ? inline(crawl.title, 300) : 'missing'}`,
      `- Meta description: ${crawl.meta_description ? inline(crawl.meta_description, 400) : 'missing'}`,
      `- Canonical: ${crawl.canonical_url ? `${code(crawl.canonical_url, 300)}` : 'none declared'} · Meta robots: ${inline(str(crawl.meta_robots) ?? 'none')} · X-Robots-Tag: ${inline(str(crawl.x_robots_tag) ?? 'none')}`,
      `- Word count: ${fmtInt(num(crawl.word_count))} · Internal links: ${fmtInt(num(crawl.links_internal))} · External links: ${fmtInt(num(crawl.links_external))}`,
    );
    if (crawl.blocked_reason) lines.push(`- Blocked: ${inline(crawl.blocked_reason)}${crawl.error ? ` (${inline(crawl.error, 200)})` : ''}`);
  } else lines.push('_Not crawled yet._');

  lines.push('', '## Technical issues', '');
  lines.push(
    issues.length
      ? table(
          ['Severity', 'Issue', 'Status', 'Last seen'],
          issues.map((i) => [cell(i.severity), cell(i.issue_type), num(i.confirmed) ? 'confirmed' : num(i.is_heuristic) ? 'editorial heuristic' : 'suspected', fmtDate(str(i.last_seen_at))]),
        )
      : '_No open technical issues recorded._',
  );

  lines.push('', ...internalLinksPageSection(rc, id, url));
  lines.push('', ...aeoPageSection(rc, id));

  lines.push('', '## Performance', '');
  if (latestPerf.size) {
    lines.push(
      table(
        ['Kind', 'Device', 'Source', 'Checked', 'Metrics', 'Synthetic'],
        [...latestPerf.values()].map((r) => {
          const metrics = parseJsonSafe<Record<string, unknown>>(r.metrics_json) ?? {};
          const summary = Object.entries(metrics)
            .filter(([, v]) => v === null || typeof v !== 'object')
            .slice(0, 6)
            .map(([k, v]) => `${k}: ${v === null ? 'missing' : String(v)}`)
            .join(', ');
          const kind = String(r.data_kind) === 'field' ? `field (${String(r.field_scope ?? 'unknown scope')})` : 'lab';
          return [cell(kind), cell(r.device), cell(r.source), fmtDate(str(r.checked_at)), cell(summary || 'no scalar metrics', 300), num(r.is_synthetic) === 1 ? 'SYNTHETIC' : 'no'];
        }),
      ),
      '',
      'Lab (Lighthouse) and field (CrUX) data are different measurements and are shown separately.',
    );
  } else lines.push('_No performance checks recorded._');

  lines.push('', '## Opportunities and recommendations', '');
  const oppLines = opportunities.map(
    (o) => `Opportunity ${code(o.id, 60)}: ${inline(o.kind)} / ${inline(o.route)} · status **${inline(o.status)}**${o.score !== null && o.score !== undefined ? ` · score ${fmtNum(num(o.score), 2)} (${inline(str(o.scoring_version) ?? 'unversioned')})` : ''}${o.query ? ` · query "${inline(o.query, 120)}"` : ''}`,
  );
  const recLines = recommendations.map(
    (r) => `Recommendation: **${inline(r.title, 200)}** (${inline(r.kind)}, ${inline(r.action_type)}) · status **${inline(r.status)}**${r.review_date ? ` · review ${fmtDate(str(r.review_date))}` : ''}`,
  );
  lines.push(bulletList([...recLines, ...oppLines], '_None recorded._'));

  lines.push('', '## Related notes', '');
  lines.push(`- Keywords: ${[...keywordKeys].map((k) => plan.link(k)).join(', ') || 'none linked'}`);
  lines.push(`- Competitors: ${[...competitorKeys].map((k) => plan.link(k)).join(', ') || 'none linked'}`);
  lines.push(`- Experiments: ${experiments.map((e) => (plan.has(`experiment:${String(e.id)}`) ? `${plan.link(`experiment:${String(e.id)}`)} (${inline(e.status)})` : `${inline(e.type)} (${inline(e.status)})`)).join(', ') || 'none'}`);
  const contentLinks: string[] = [];
  for (const c of contentItems) {
    const cid = String(c.id);
    const parts = [plan.has(`content:${cid}`) ? plan.link(`content:${cid}`) : inline(c.title)];
    if (plan.has(`brief:${cid}`)) parts.push(plan.link(`brief:${cid}`, 'brief'));
    if (plan.has(`draft:${cid}`)) parts.push(plan.link(`draft:${cid}`, 'draft'));
    contentLinks.push(`${parts.join(' · ')} (${inline(c.stage)})`);
  }
  lines.push(`- Content and briefs: ${contentLinks.join('; ') || 'none'}`);
  lines.push(`- Decisions: ${decisions.map((d) => (plan.has(`decision:${String(d.id)}`) ? plan.link(`decision:${String(d.id)}`) : `${code(d.id, 60)}`)).join(', ') || 'none'}`);

  lines.push('', '## Evidence', '');
  lines.push(
    claims.length
      ? bulletList(
          claims.map((c) => {
            const src = c.source_id && plan.has(`source:${String(c.source_id)}`) ? ` · source ${plan.link(`source:${String(c.source_id)}`)}` : c.source_id ? ` · source ${code(c.source_id, 60)}` : '';
            return `**${inline(c.claim_label)}** (${inline(c.support)}): ${inline(c.claim_text, 300)}${c.summary ? ` · evidence: ${inline(c.summary, 200)}` : ' · no evidence item attached'}${src}`;
          }),
        )
      : '_No claims with evidence recorded for this page._',
  );

  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'page',
    title: ref.title,
    frontmatter: {
      source_ids: [id, ...sourceIds],
      url,
      page_type: str(p.page_type),
      lifecycle: str(p.lifecycle),
      protected: num(p.is_protected) === 1,
      route: str(route?.route),
      ...syntheticProps(isSynthetic),
    },
    body: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- keyword notes

export function buildKeywordNote(rc: RenderContext, k: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const id = String(k.id);
  const ref = plan.get(`keyword:${id}`)!;
  const cluster = k.cluster_id ? one(rc, 'SELECT label, intent, method FROM keyword_clusters WHERE site_id = ? AND id = ?', [site, k.cluster_id]) : undefined;
  const metrics = all(rc, 'SELECT * FROM keyword_metrics WHERE site_id = ? AND keyword_id = ? ORDER BY collected_at DESC LIMIT 3', [site, id]);
  const snapshot = one(rc, 'SELECT * FROM serp_snapshots WHERE site_id = ? AND keyword_id = ? ORDER BY collected_at DESC LIMIT 1', [site, id]);
  const results = snapshot ? all(rc, 'SELECT * FROM serp_results WHERE site_id = ? AND snapshot_id = ? ORDER BY rank_absolute LIMIT 10', [site, snapshot.id]) : [];
  const rankings = all(rc, 'SELECT rank_absolute, observed_at, page_id FROM rankings WHERE site_id = ? AND keyword_id = ? ORDER BY observed_at DESC LIMIT 10', [site, id]);
  const normalized = normalizeQuery(String(k.normalized ?? k.keyword));
  let gscRows: Row[] = [];
  let gscWindowText = '';
  if (rc.gsc) {
    const latest = str(one(rc, "SELECT MAX(date) AS d FROM gsc_page_query_daily_current WHERE site_id = ? AND property = ? AND search_type = ? AND lower(trim(query)) = ? AND segment_key = ''", [site, rc.gsc.property, rc.gsc.searchType, normalized])?.d);
    if (latest) {
      const start = new Date(Date.parse(`${latest}T00:00:00Z`) - (rc.windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
      gscWindowText = `${start} to ${latest}`;
      gscRows = all(
        rc,
        `SELECT page_id, page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) AS pw
           FROM gsc_page_query_daily_current
          WHERE site_id = ? AND property = ? AND search_type = ? AND lower(trim(query)) = ? AND segment_key = '' AND date BETWEEN ? AND ?
          GROUP BY page_id, page ORDER BY impressions DESC LIMIT 10`,
        [site, rc.gsc.property, rc.gsc.searchType, normalized, start, latest],
      );
    }
  }
  const clusterItems = k.cluster_id ? all(rc, 'SELECT id, title, stage FROM content_items WHERE site_id = ? AND cluster_id = ?', [site, k.cluster_id]) : [];
  const isSandbox = metrics.some((m) => num(m.is_sandbox) === 1) || num(snapshot?.is_sandbox) === 1;
  const isSynthetic = ctx.synthetic;

  const lines = withBanner(isSynthetic, [`# ${inline(k.keyword, 200)}`, '']);
  if (isSandbox) lines.push(callout('warning', 'SANDBOX DATA', ['Some research data below came from a provider sandbox. Sandbox data is synthetic and never used in recommendations.']), '');
  lines.push(
    `- Normalized: ${code(k.normalized, 200)} · Language: ${inline(str(k.language) ?? 'unknown')}`,
    `- Branded: ${yesNo(num(k.is_branded))} · Intent: ${inline(str(k.intent) ?? 'unknown')}${k.intent_source ? ` (${inline(k.intent_source)})` : ''}`,
    `- Cluster: ${cluster ? `${inline(cluster.label, 120)} (${inline(cluster.method)})` : 'none'}`,
    `- First seen: ${fmtDate(str(k.first_seen_at))} · Origins: ${inline(describeOrigins(k.origins_json), 300)}`,
    '',
    '## Search volume estimates',
    '',
  );
  lines.push(
    metrics.length
      ? table(
          ['Provider', 'Volume (estimate)', 'CPC', 'Competition', 'Locale', 'Collected', 'Sandbox'],
          metrics.map((m) => [
            cell(m.provider),
            m.search_volume === null ? 'not provided' : fmtInt(num(m.search_volume)),
            m.cpc_micros === null || m.cpc_micros === undefined ? 'not provided' : m.cpc_currency ? cell(formatMoney(num(m.cpc_micros), String(m.cpc_currency))) : `${fromMicros(num(m.cpc_micros) ?? 0)} (currency not reported)`,
            m.competition === null ? 'not provided' : fmtNum(num(m.competition), 2),
            cell(`${str(m.location_code) ?? '?'}/${str(m.language_code) ?? '?'}`),
            fmtDate(str(m.collected_at)),
            yesNo(num(m.is_sandbox)),
          ]),
        ) + '\n\nSearch volumes are provider estimates, not exact demand.'
      : 'DATA UNAVAILABLE: no search volume estimate collected (DataForSEO research is optional and budgeted).',
  );

  lines.push('', '## Search Console (visible query rows)', '');
  if (gscRows.length) {
    lines.push(
      `${gscWindowText}. Visible rows only; anonymized queries are omitted. Not a page or site total.`,
      '',
      table(
        ['Page', 'Clicks', 'Impressions', 'Avg position'],
        gscRows.map((r) => {
          const pk = r.page_id ? `page:${String(r.page_id)}` : null;
          const imp = num(r.impressions) ?? 0;
          const pw = num(r.pw);
          return [pk && plan.has(pk) ? rawCell(plan.link(pk)) : cell(r.page, 200), fmtInt(num(r.clicks)), fmtInt(imp), imp > 0 && pw !== null ? fmtNum(pw / imp, 1) : 'n/a'];
        }),
      ),
    );
  } else lines.push('DATA UNAVAILABLE: no visible Search Console query rows for this keyword.');

  lines.push('', '## Latest SERP snapshot', '');
  if (snapshot) {
    lines.push(
      `- ${inline(snapshot.provider)} · ${inline(snapshot.device)} · locale ${inline(`${str(snapshot.location_code) ?? '?'}/${str(snapshot.language_code) ?? '?'}`)} · depth ${inline(str(snapshot.depth) ?? '?')} · collected ${fmtTimestamp(str(snapshot.collected_at))}${num(snapshot.is_sandbox) ? ' · SANDBOX' : ''}`,
      '',
    );
    lines.push(
      results.length
        ? table(
            ['Rank', 'Type', 'Domain', 'Title (third-party text)'],
            results.map((r) => {
              const ck = r.domain ? rc.competitorByDomain.get(normalizeDomain(String(r.domain))) : undefined;
              return [inline(str(r.rank_absolute) ?? '?'), cell(r.result_type), ck ? rawCell(plan.link(ck, String(r.domain))) : `${cell(r.domain)}${num(r.is_own_site) ? ' (our site)' : ''}`, cell(r.title, 160)];
            }),
          )
        : '_Snapshot has no stored results._',
    );
  } else lines.push('_No SERP snapshot collected._');

  lines.push('', '## Observed rankings', '');
  lines.push(
    rankings.length
      ? bulletList(
          rankings.map((r) => {
            const pk = r.page_id ? `page:${String(r.page_id)}` : null;
            return `${fmtDate(str(r.observed_at))}: ${r.rank_absolute === null ? 'not found within depth' : `position ${inline(r.rank_absolute)}`}${pk && plan.has(pk) ? ` · ${plan.link(pk)}` : ''}`;
          }),
        ) + '\n\nPoint-in-time SERP observations, not the Search Console average position.'
      : '_No observed rankings recorded._',
  );

  if (clusterItems.length) {
    lines.push('', '## Content in this cluster', '', bulletList(clusterItems.map((c) => `${plan.has(`content:${String(c.id)}`) ? plan.link(`content:${String(c.id)}`) : inline(c.title)} (${inline(c.stage)})`)));
  }

  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'keyword',
    title: ref.title,
    frontmatter: {
      source_ids: [id, ...(snapshot ? [String(snapshot.id)] : [])],
      keyword: str(k.keyword),
      language: str(k.language),
      intent: str(k.intent),
      branded: k.is_branded === null || k.is_branded === undefined ? null : num(k.is_branded) === 1,
      ...(isSandbox ? { sandbox: true } : {}),
      ...syntheticProps(isSynthetic),
    },
    body: lines.join('\n'),
  };
}

function describeOrigins(originsJson: unknown): string {
  const v = parseJsonSafe<unknown>(originsJson);
  if (!v) return 'not recorded';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- competitor notes

export function buildCompetitorNote(rc: RenderContext, c: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const id = String(c.id);
  const ref = plan.get(`competitor:${id}`)!;
  const domain = normalizeDomain(String(c.domain));
  const pages = all(rc, 'SELECT url, first_seen_at, last_checked_at FROM competitor_pages WHERE site_id = ? AND competitor_id = ? ORDER BY last_checked_at DESC, url LIMIT 20', [site, id]);
  const changes = all(
    rc,
    `SELECT cc.change_type, cc.summary, cc.detected_at, cp.url FROM competitor_changes cc JOIN competitor_pages cp ON cp.id = cc.competitor_page_id
      WHERE cc.site_id = ? AND cp.site_id = ? AND cp.competitor_id = ? ORDER BY cc.detected_at DESC LIMIT 20`,
    [site, site, id],
  );
  const appearances = all(
    rc,
    `SELECT ss.keyword_id, ss.query, MIN(sr.rank_absolute) AS best, MAX(ss.collected_at) AS last_seen, MAX(ss.is_sandbox) AS sandbox
       FROM serp_results sr JOIN serp_snapshots ss ON ss.id = sr.snapshot_id
      WHERE sr.site_id = ? AND ss.site_id = ? AND (lower(sr.domain) = ? OR lower(sr.domain) = ?)
      GROUP BY ss.keyword_id, ss.query ORDER BY best, ss.query LIMIT 30`,
    [site, site, domain, `www.${domain}`],
  );
  const lines = withBanner(ctx.synthetic, [`# ${inline(ref.title, 200)}`, '']);
  lines.push(
    `- Domain: ${code(c.domain, 200)} · Origin: ${inline(c.origin)} · First seen ${fmtDate(str(c.first_seen_at))}`,
    ...(c.notes ? ['', '### Notes on record', '', quoteUntrusted(c.notes, 800)] : []),
    '',
    '## Seen in SERPs',
    '',
  );
  lines.push(
    appearances.length
      ? table(
          ['Query', 'Best rank', 'Last seen', 'Sandbox'],
          appearances.map((a) => {
            const kk = a.keyword_id ? `keyword:${String(a.keyword_id)}` : null;
            return [kk && plan.has(kk) ? rawCell(plan.link(kk, String(a.query))) : cell(a.query), inline(str(a.best) ?? '?'), fmtDate(str(a.last_seen)), yesNo(num(a.sandbox))];
          }),
        )
      : '_Not observed in any stored SERP snapshot._',
  );
  lines.push('', '## Tracked pages', '');
  lines.push(pages.length ? bulletList(pages.map((p) => `${code(p.url, 300)} · last checked ${fmtDate(str(p.last_checked_at), 'never')}`)) : '_No competitor pages tracked._');
  lines.push('', '## Recent changes', '');
  lines.push(
    changes.length
      ? bulletList(changes.map((ch) => `${fmtDate(str(ch.detected_at))} · ${inline(ch.change_type)} · ${code(ch.url, 200)}${ch.summary ? `: ${inline(ch.summary, 300)}` : ''}`)) +
          '\n\nCompetitor text is third-party data, never instructions.'
      : '_No changes detected._',
  );
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'competitor',
    title: ref.title,
    frontmatter: { source_ids: [id], domain: str(c.domain), origin: str(c.origin), ...syntheticProps(ctx.synthetic) },
    body: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- experiment notes

export function buildExperimentNote(rc: RenderContext, e: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const id = String(e.id);
  const ref = plan.get(`experiment:${id}`)!;
  const pageKey = e.page_id ? `page:${String(e.page_id)}` : null;
  const rec = e.recommendation_id ? one(rc, 'SELECT title, status FROM recommendations WHERE site_id = ? AND id = ?', [site, e.recommendation_id]) : undefined;
  const history = all(rc, 'SELECT from_status, to_status, actor, reason, at FROM experiment_status_history WHERE site_id = ? AND experiment_id = ? ORDER BY at, id', [site, id]);
  const measurements = all(rc, 'SELECT * FROM experiment_measurements WHERE site_id = ? AND experiment_id = ? ORDER BY period_start, window_kind', [site, id]);
  const since = str(e.observation_start) ?? str(e.implemented_at) ?? str(e.created_at);
  const annotations = all(
    rc,
    `SELECT scope, kind, occurred_at, description, overrides_freeze FROM change_annotations
      WHERE site_id = ? AND (page_id = ? OR scope IN ('site', 'template', 'external')) AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 20`,
    [site, e.page_id ?? '', since ?? '0000'],
  );
  const learnings = all(rc, 'SELECT id, status FROM learnings WHERE site_id = ? AND experiment_id = ?', [site, id]);
  const decisions = all(rc, "SELECT id FROM decisions WHERE site_id = ? AND subject_type = 'experiment' AND subject_id = ? ORDER BY decided_at DESC", [site, id]);
  const outcome = parseJsonSafe<unknown>(e.outcome_json);
  const status = String(e.status);

  const lines = withBanner(ctx.synthetic, [`# ${inline(ref.title, 200)}`, '']);
  lines.push(
    `- Status: **${inline(status)}** · Type: ${inline(e.type)} · Outcome kind: ${inline(e.outcome_kind)}`,
    `- Page: ${pageKey && plan.has(pageKey) ? plan.link(pageKey) : e.page_id ? `${code(e.page_id, 60)}` : 'site-wide'}`,
    `- Recommendation: ${rec ? `${inline(rec.title, 200)} (${inline(rec.status)})` : 'none linked'}`,
    `- Review date: ${fmtDate(str(e.review_date), 'not set')} · Minimum observation: ${inline(e.min_observation_days)} days`,
    `- Implemented at: ${e.implemented_at ? fmtTimestamp(str(e.implemented_at)) : 'not yet (approval or drafting does not start the measurement window)'}`,
    `- Observation window: ${e.observation_start ? dateRange(e.observation_start, e.observation_end) : 'not started'}`,
    '',
    '## Hypothesis',
    '',
    inline(e.hypothesis, 2_000),
    '',
    '## Proposed change',
    '',
    inline(e.proposed_change, 3_000),
    '',
    `Change hash: ${code(e.change_hash, 80)}`,
    '',
    '## Measurement plan',
    '',
    `- Primary metric: ${inline(e.primary_metric)}`,
    `- Guardrail metrics: ${inline(describeFlat(e.guardrail_metrics_json), 400)}`,
    `- Sample requirements: ${inline(describeFlat(e.sample_requirements_json), 400)}`,
    `- Baseline: ${e.baseline_json ? inline(describeFlat(e.baseline_json), 400) : 'not recorded'}`,
    `- Frozen versions: ${e.frozen_versions_json ? inline(describeFlat(e.frozen_versions_json), 400) : 'not recorded'}`,
    '',
    '## Evidence',
    '',
    describeJson(parseJsonSafe(e.evidence_json)),
    '',
    '## Risks and rollback',
    '',
    `- Risks: ${inline(e.risks, 1_000)}`,
    `- Rollback plan: ${inline(e.rollback_plan, 1_000)}`,
    '',
    '## Measurements',
    '',
  );
  lines.push(
    measurements.length
      ? table(
          ['Window', 'Period', 'Method', 'Metrics'],
          measurements.map((m) => [cell(m.window_kind), cell(dateRange(m.period_start, m.period_end)), cell(`${String(m.method)} ${String(m.method_version)}`), cell(describeFlat(m.metrics_json), 300)]),
        )
      : '_No measurements yet._',
    '',
    'Before/after comparisons are observational, not proof of causality. A result is never labeled significant without an implemented method and adequate data.',
  );
  lines.push('', '## Outcome', '', outcome ? describeJson(outcome) : ['positive', 'negative', 'inconclusive', 'cancelled'].includes(status) ? '_Outcome details not recorded._' : '_Not evaluated yet._');
  lines.push('', '## Interference and annotations', '');
  lines.push(
    annotations.length
      ? bulletList(annotations.map((a) => `${fmtDate(str(a.occurred_at))} · ${inline(a.scope)}/${inline(a.kind)}${num(a.overrides_freeze) ? ' (overrode freeze)' : ''}: ${inline(a.description, 300)}`))
      : '_No external or shared changes recorded in this window._',
  );
  lines.push('', '## Status history', '');
  lines.push(history.length ? bulletList(history.map((h) => `${fmtTimestamp(str(h.at))}: ${inline(str(h.from_status) ?? 'none')} -> **${inline(h.to_status)}** by ${inline(h.actor)}${h.reason ? ` (${inline(h.reason, 200)})` : ''}`)) : '_No transitions recorded._');
  lines.push('', '## Related', '');
  lines.push(`- Learnings: ${learnings.map((l) => (plan.has(`learning:${String(l.id)}`) ? plan.link(`learning:${String(l.id)}`) : `${code(l.id, 60)}`)).join(', ') || 'none'}`);
  lines.push(`- Decisions: ${decisions.map((d) => (plan.has(`decision:${String(d.id)}`) ? plan.link(`decision:${String(d.id)}`) : `${code(d.id, 60)}`)).join(', ') || 'none'}`);
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'experiment',
    title: ref.title,
    frontmatter: {
      source_ids: [id, ...(e.page_id ? [String(e.page_id)] : []), ...(e.recommendation_id ? [String(e.recommendation_id)] : [])],
      status,
      experiment_type: str(e.type),
      primary_metric: str(e.primary_metric),
      review_date: str(e.review_date),
      implemented_at: str(e.implemented_at),
      ...syntheticProps(ctx.synthetic),
    },
    body: lines.join('\n'),
  };
}

function describeFlat(jsonText: unknown): string {
  const v = parseJsonSafe<unknown>(jsonText);
  if (v === null || v === undefined) return 'not recorded';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ') || 'none';
  return (
    Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${x !== null && typeof x === 'object' ? JSON.stringify(x) : x === null ? 'missing' : String(x)}`)
      .join('; ') || 'none'
  );
}

// ---------------------------------------------------------------- decisions and learnings

export function buildDecisionNote(rc: RenderContext, d: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const id = String(d.id);
  const ref = plan.get(`decision:${id}`)!;
  const lines = withBanner(ctx.synthetic, [`# ${inline(ref.title, 200)}`, '']);
  lines.push(
    `- Decision: **${inline(d.decision, 500)}**`,
    `- Subject: ${subjectLink(rc, String(d.subject_type), String(d.subject_id))}`,
    `- Decided by ${inline(d.decided_by)} on ${fmtTimestamp(str(d.decided_at))}`,
    '',
    '## Reason',
    '',
    d.reason ? inline(d.reason, 3_000) : '_No reason recorded._',
    '',
    callout('info', 'Record only', ['This note presents a decision stored in SQLite. Editing it (or adding `approved: true`) does not authorize any action; approvals happen only through the CLI.']),
  );
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'decision',
    title: ref.title,
    frontmatter: { source_ids: [id, String(d.subject_id)], subject_type: str(d.subject_type), decided_by: str(d.decided_by), decided_at: str(d.decided_at), ...syntheticProps(ctx.synthetic) },
    body: lines.join('\n'),
  };
}

export function buildLearningNote(rc: RenderContext, l: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const id = String(l.id);
  const ref = plan.get(`learning:${id}`)!;
  const status = String(l.status);
  const expKey = l.experiment_id ? `experiment:${String(l.experiment_id)}` : null;
  const statusLine =
    status === 'approved'
      ? `APPROVED by ${inline(str(l.approved_by) ?? 'unknown')} on ${fmtDate(str(l.approved_at))}, within the stated scope only`
      : status === 'proposed'
        ? 'PROPOSED: not approved and not a rule. It needs evidence review before use.'
        : status.toUpperCase();
  const lines = withBanner(ctx.synthetic, [`# ${inline(ref.title, 200)}`, '']);
  lines.push(
    `- Status: **${statusLine}**`,
    `- Scope: ${inline(l.scope, 500)}`,
    `- Experiment: ${expKey && plan.has(expKey) ? plan.link(expKey) : l.experiment_id ? `${code(l.experiment_id, 60)}` : 'none'}`,
    '',
    '## Statement',
    '',
    inline(l.statement, 2_000),
    '',
    '## Evidence',
    '',
    describeJson(parseJsonSafe(l.evidence_json)),
    '',
    'Learnings are scoped observations from this site. They never become universal SEO rules automatically.',
  );
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'learning',
    title: ref.title,
    frontmatter: { source_ids: [id, ...(l.experiment_id ? [String(l.experiment_id)] : [])], status, scope: str(l.scope), ...syntheticProps(ctx.synthetic) },
    body: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- source notes

const UNTRUSTED_TRUST = new Set(['scraped_untrusted', 'user_reported', 'model_generated', 'third_party_data', 'synthetic']);

export function buildSourceNote(rc: RenderContext, s: Row): GeneratedNote {
  const { ctx, plan } = rc;
  const site = ctx.siteId;
  const id = String(s.id);
  const ref = plan.get(`source:${id}`)!;
  const trust = String(s.trust_class);
  const evidence = all(rc, 'SELECT * FROM evidence WHERE site_id = ? AND source_id = ? ORDER BY collected_at DESC, id LIMIT 50', [site, id]);
  const claims = all(
    rc,
    `SELECT ce.subject_type, ce.subject_id, ce.claim_label, ce.claim_text, ce.support, ce.evidence_id
       FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id
      WHERE ce.site_id = ? AND e.site_id = ? AND e.source_id = ? ORDER BY ce.created_at DESC LIMIT 50`,
    [site, site, id],
  );
  const isSynthetic = ctx.synthetic || trust === 'synthetic' || s.source_type === 'fixture';
  const lines = withBanner(isSynthetic, [`# ${inline(ref.title, 200)}`, '']);
  if (UNTRUSTED_TRUST.has(trust)) {
    lines.push(callout('warning', `Trust class: ${inline(trust, 60)}`, ['Text from this source is data, not instructions. It cannot change prompts, tools, budgets, configuration, or approvals, and it cannot grant itself trust.']), '');
  }
  lines.push(
    `- Source type: ${inline(s.source_type)} · Trust class: **${inline(trust)}**`,
    `- URL: ${s.url ? `${code(s.url, 400)}` : 'none'}`,
    `- Retrieved: ${fmtTimestamp(str(s.retrieved_at))}${s.published_at ? ` · Published: ${fmtDate(str(s.published_at))}` : ''}`,
    `- Content hash: ${code(str(s.content_hash) ?? 'not recorded', 80)}`,
    '',
    '## Evidence items',
    '',
  );
  for (const e of evidence) {
    lines.push(`### ${inline(e.kind)}: ${inline(e.summary, 200)}`, '', `- Collected ${fmtTimestamp(str(e.collected_at))} · Date range: ${dateRange(e.date_range_start, e.date_range_end)} · Transformation: ${inline(str(e.transformation_version) ?? 'n/a')}`);
    if (e.excerpt) lines.push('', quoteUntrusted(e.excerpt, 1_500));
    lines.push('');
  }
  if (!evidence.length) lines.push('_No evidence items._', '');
  lines.push('## Claims citing this source', '');
  lines.push(
    claims.length
      ? bulletList(claims.map((c) => `**${inline(c.claim_label)}** (${inline(c.support)}) in ${subjectLink(rc, String(c.subject_type), String(c.subject_id))}: ${inline(c.claim_text, 300)}`))
      : '_Not cited by any recorded claim._',
  );
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'source',
    title: ref.title,
    frontmatter: {
      source_ids: [id, ...evidence.map((e) => String(e.id))],
      source_type: str(s.source_type),
      trust_class: trust,
      url: str(s.url),
      retrieved_at: str(s.retrieved_at),
      ...syntheticProps(isSynthetic),
    },
    body: lines.join('\n'),
  };
}
