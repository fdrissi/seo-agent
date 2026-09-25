import { buildDashboard } from '../reports/dashboard.js';
import { wikiLinkResolver } from '../reports/links.js';
import { bulletList, inline, syntheticBanner } from './markdown.js';
import type { RenderContext } from './render-context.js';
import type { GeneratedNote } from './types.js';
import { formatWikilink } from './wikilinks.js';

/**
 * Static dashboard (00 Dashboard/Dashboard.md) for `vault render`.
 *
 * There is ONE dashboard builder: this delegates to reports/dashboard.ts
 * `buildDashboard`, which the pipeline report stage also uses, so both paths
 * write the same note from the same database (same "last complete days"
 * period rule, same sections). Links point at notes of this render's plan
 * (or existing notes), exactly as the pipeline links through VaultWriter.link.
 */
export function buildDashboardNote(rc: RenderContext): GeneratedNote {
  const { ctx, plan } = rc;
  const ref = plan.get('dashboard')!;
  const planned = plan.all();
  const byNoteId = new Map(planned.map((r) => [r.noteId, r.relPath]));
  const plannedPaths = new Set(planned.map((r) => r.relPath.toLowerCase()));
  // Same contract as VaultWriter.link: the target must be planned in this render or exist on disk (renderLink falls back otherwise).
  const link = (toRelPath: string, alias?: string): string => {
    const rel = /\.md$/i.test(toRelPath) ? toRelPath : `${toRelPath}.md`;
    if (!plannedPaths.has(rel.toLowerCase()) && !plan.fileExists(rel)) throw new Error(`Wikilink target is neither planned nor on disk: ${rel}`);
    return formatWikilink(rel, alias);
  };
  return buildDashboard(ctx, {
    statuses: rc.integrationStatuses,
    statusNote: rc.integrationStatusNote,
    windowDays: rc.windowDays,
    linkResolver: wikiLinkResolver({ link, notePath: () => null }),
    notePathFor: (noteId) => byNoteId.get(noteId) ?? null,
    target: { relPath: ref.relPath, noteId: ref.noteId },
  });
}

/** Index of every generated note in this render, grouped by kind (plugin-free navigation). */
export function buildIndexNote(rc: RenderContext): GeneratedNote {
  const { plan, ctx } = rc;
  const ref = plan.get('index')!;
  const groups = new Map<string, Array<{ key: string; title: string; relPath: string }>>();
  for (const r of plan.all()) {
    if (r.key === 'index') continue;
    const list = groups.get(r.kind) ?? [];
    list.push({ key: r.key, title: r.title, relPath: r.relPath });
    groups.set(r.kind, list);
  }
  const labels: Record<string, string> = {
    dashboard: 'Dashboard',
    page: 'Website pages',
    keyword: 'Keywords',
    competitor: 'Competitors',
    brief: 'Content briefs',
    draft: 'Content drafts',
    experiment: 'Experiments',
    source: 'Research sources',
    ai_search_index: 'AI search',
    content_opportunity: 'Content opportunities',
    content_farm_index: 'Content farm',
    decision: 'Decisions',
    learning: 'Learnings',
  };
  const lines: string[] = ctx.synthetic ? [syntheticBanner(), ''] : [];
  lines.push('# Vault index', '', 'Every note generated in the latest render, grouped by type. Human notes (01 Business, your own notes) are not listed.', '');
  for (const [kind, list] of [...groups.entries()].sort(([a], [b]) => (labels[a] ?? a).localeCompare(labels[b] ?? b))) {
    lines.push(`## ${inline(labels[kind] ?? kind)} (${list.length})`, '');
    lines.push(bulletList(list.sort((a, b) => a.relPath.localeCompare(b.relPath)).map((i) => plan.link(i.key))));
    lines.push('');
  }
  if (!groups.size) lines.push('_No generated notes yet._');
  const stale = rc.staleNotes ?? [];
  if (stale.length) {
    lines.push(
      '',
      `## Stale notes (${stale.length})`,
      '',
      'The record behind each of these notes no longer exists (for example keywords merged by a migration or a withdrawn owner decision), or the note is a duplicate that an earlier version of the `content` commands wrote next to the current note. They are marked `status: stale`, are no longer updated, and are never deleted by seo-agent.',
      '',
      bulletList(
        stale
          .slice()
          .sort((a, b) => a.relPath.localeCompare(b.relPath))
          .map((x) => `${formatWikilink(x.relPath, x.title)}${x.supersededBy ? ` (duplicate of ${formatWikilink(x.supersededBy)})` : x.supersededBy === null ? ' (legacy duplicate content note)' : ''}${x.status === 'conflict' ? ' (not marked: the generated content was edited; see the conflict artifact)' : ''}`),
      ),
    );
  }
  return {
    relPath: ref.relPath,
    noteId: ref.noteId,
    kind: 'vault_index',
    title: ref.title,
    frontmatter: { source_ids: [], notes: plan.all().length - 1 },
    body: lines.join('\n'),
  };
}
