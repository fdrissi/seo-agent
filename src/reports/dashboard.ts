import type { AppContext } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import { formatUsd } from '../core/money.js';
import type { Measured } from '../core/measured.js';
import { addDays } from '../core/time.js';
import { FEATURE_KEYS } from '../config/site-schema.js';
import type { IntegrationStatus } from '../integrations/types.js';
import { bulletList, callout, cell, code, fmtDate, fmtTimestamp, inline, rawCell, syntheticBanner, table } from '../obsidian/markdown.js';
import type { GeneratedNote } from '../obsidian/types.js';
import { redactString } from '../security/redact.js';
import { createEnv } from './env.js';
import { renderLink, type LinkResolver, type LinkTarget } from './links.js';
import { fmtInt, fmtPct, fmtPos } from './metrics.js';
import { SYNTHETIC_WATERMARK, type Ga4ChannelTotals, type GscTotals, type ReportPeriod } from './model.js';
import { latestCompleteDate, reportTimeZoneInfo } from './period.js';
import { bestOpportunity, contentQueue, latestPrimaryRecommendation, pendingApprovals } from './queries.js';
import { experimentsSection, freshnessSection, ga4TotalsFor, gscTotalsFor, primaryEventTrackingUnverified } from './sections-common.js';
import { listReports, reportNotePath } from './storage.js';

/**
 * The ONE dashboard builder ('00 Dashboard/Dashboard.md'). Both the pipeline
 * report stage and `vault render` (src/obsidian/dashboard.ts delegates here)
 * produce the same note from the same database, so the dashboard's "current
 * performance" never depends on which command ran last.
 *
 * Period rule: the last `windowDays` COMPLETE days, ending at the latest
 * complete date (reports/period.ts); incomplete recent days are never shown
 * as current performance.
 *
 * Plain Markdown that works without Obsidian or any community plugin; every
 * figure comes from SQLite. Untrusted text is escaped with the vault
 * helpers. The body carries no render timestamp (the vault writer records
 * `generated_at`), so an unchanged database renders an unchanged note. An
 * optional Dataview block is appended as an extra.
 */

export interface DashboardInput {
  /** Integration statuses; null when not checked (the dashboard says so). */
  statuses: IntegrationStatus[] | null;
  /** Caveat shown under the integration table (for example "offline checks only"). */
  statusNote?: string | null;
  /** Wikilink resolver (vault writes); standard Markdown when absent. */
  linkResolver?: LinkResolver;
  /** Days of complete data in the "current performance" window. Default 28. */
  windowDays?: number;
  topN?: number;
  /**
   * Vault path of the generated note with this note id, or null when there is
   * none. Used only with a link resolver. Default: the vault_notes table (notes
   * written by the latest render); `vault render` passes its plan.
   */
  notePathFor?: (noteId: string) => string | null;
  /** Where the note is written when the vault plan keeps another path. Default DASHBOARD_REL_PATH and `dashboard-<site>`. */
  target?: { relPath: string; noteId: string };
}

export const DASHBOARD_REL_PATH = '00 Dashboard/Dashboard.md';

function show(m: Measured<number> | undefined, fmt: (n: number) => string): string {
  if (!m) return 'DATA UNAVAILABLE';
  if (m.status === 'observed') return fmt(m.value);
  if (m.status === 'incomplete') return m.partialValue !== undefined ? `${fmt(m.partialValue)} (incomplete)` : `incomplete (${m.reason})`;
  return `DATA UNAVAILABLE (${m.reason})`;
}

function partialOf<T>(m: Measured<T>): { value: T; incomplete: boolean } | null {
  if (m.status === 'observed') return { value: m.value, incomplete: false };
  if (m.status === 'incomplete' && m.partialValue !== undefined) return { value: m.partialValue, incomplete: true };
  return null;
}

/** Period used by the dashboard: the last `windowDays` complete days (shared by every caller). */
export function dashboardPeriod(ctx: AppContext, windowDays = 28): ReportPeriod {
  const days = Math.max(7, Math.min(90, windowDays));
  const latest = latestCompleteDate(ctx);
  const tz = reportTimeZoneInfo(ctx);
  return {
    start: addDays(latest.date, -(days - 1)),
    end: latest.date,
    days,
    timeZone: tz.timeZone,
    timeZoneSource: tz.source,
    label: `Last ${days} complete days`,
    comparison: null,
    latestCompleteDate: latest.fromData ? latest.date : null,
    latestCompleteBasis: latest.basis,
    explicit: false,
  };
}

function defaultNotePathFor(ctx: AppContext): (noteId: string) => string | null {
  return (noteId) => ctx.db.get<{ rel_path: string }>('SELECT rel_path FROM vault_notes WHERE site_id = ? AND note_id = ?', [ctx.siteId, noteId])?.rel_path ?? null;
}

export function buildDashboard(ctx: AppContext, input: DashboardInput): GeneratedNote {
  const period = dashboardPeriod(ctx, input.windowDays ?? 28);
  const topN = input.topN ?? 5;
  const site = ctx.siteId;
  const env = createEnv(ctx, 'weekly', period, { statuses: input.statuses, topN });
  const resolver = input.linkResolver;
  const notePathFor = resolver ? (input.notePathFor ?? defaultNotePathFor(ctx)) : () => null;
  const link = (t: LinkTarget) => renderLink(t.notePath !== undefined || !resolver ? t : { ...t, notePath: notePathFor(t.id) }, resolver);
  /** Link to a generated vault note by id, or null when the note does not exist in this vault. */
  const noteLink = (noteId: string, label: string): string | null => {
    const p = resolver ? notePathFor(noteId) : null;
    return p ? renderLink({ kind: 'vault_note', id: noteId, label, notePath: p }, resolver) : null;
  };

  const out: string[] = [`# Dashboard: ${inline(ctx.config.site.businessName, 200)}`, ''];
  out.push(`Site ${code(site)} · ${code(ctx.config.site.url, 300)} · rendered from SQLite (the \`generated_at\` property records the render time)`, '');
  out.push(callout('info', 'How to read this dashboard', ['SQLite is the source of truth; these notes present it. Human notes live in 01 Business. Editing Markdown never approves an action.']), '');
  const bodyStart = 0;

  // Current performance (last complete days only)
  const perfRows: string[][] = [];
  const unavailableLines: string[] = [];
  let gscTzNote = '';
  if (env.gsc.property) {
    const g = gscTotalsFor(env, env.gsc.property, env.gsc.searchType, period.start, period.end);
    const p = partialOf<GscTotals>(g);
    if (p) {
      const t = p.value;
      const suffix = p.incomplete ? ' (incomplete)' : '';
      perfRows.push(['Search Console clicks', `${fmtInt(t.clicks)}${suffix}`], ['Search Console impressions', `${fmtInt(t.impressions)}${suffix}`], ['CTR (clicks / impressions)', fmtPct(t.ctr)], ['Average position (impression-weighted)', fmtPos(t.position)]);
      gscTzNote = t.dateTz ?? '';
    } else unavailableLines.push(`Search Console property totals: DATA UNAVAILABLE (${inline(g.status === 'observed' ? '' : g.reason, 300)})`);
  } else unavailableLines.push('Search Console property totals: DATA UNAVAILABLE (no property configured or ingested)');
  const views: Array<['google_organic' | 'all_organic', string]> = [
    ['google_organic', 'GA4 Google organic sessions'],
    ['all_organic', 'GA4 all organic sessions (separate view)'],
  ];
  for (const [view, label] of views) {
    const m = ga4TotalsFor(env, view, period.start, period.end);
    const p = partialOf<Ga4ChannelTotals>(m);
    if (!p) {
      unavailableLines.push(`${label}: DATA UNAVAILABLE (${inline(m.status === 'observed' ? '' : m.reason, 300)})`);
      continue;
    }
    perfRows.push([label, `${fmtInt(p.value.sessions)}${p.incomplete ? ' (incomplete)' : ''}`]);
    if (view === 'google_organic') {
      const ev = env.primaryEvent ?? 'not configured';
      const raw = p.value.primarySessionRateUnverified;
      const rate = p.value.primarySessionRate.status !== 'observed' && raw ? `raw ${raw.raw} as reported (RATE SCALE UNVERIFIED: 0-1 or 0-100 not established)` : show(p.value.primarySessionRate, (n) => fmtPct(n));
      const caveat = primaryEventTrackingUnverified(env) ? ' (tracking not yet verified by the owner)' : '';
      // A verified rate whose scale rests on an owner assertion says whose (D3-03).
      const a = p.value.primarySessionRate.status === 'observed' ? p.value.rateScaleAssertion : null;
      const scaleNote = a ? ` (scale ${a.scale === 'fraction' ? '0-1' : '0-100'} per owner assertion ${a.confirmationId} by ${inline(a.actor, 60)} on ${a.confirmedAt.slice(0, 10)})` : '';
      perfRows.push([`Primary event "${inline(ev, 100)}" session rate (Google organic)`, cell(`${rate}${caveat}${scaleNote}`, 400)]);
    }
  }
  out.push(`## Current performance (${period.start} to ${period.end})`, '');
  if (perfRows.length) out.push(table(['Metric', 'Value'], perfRows), '');
  if (unavailableLines.length) out.push(bulletList(unavailableLines), '');
  const tzText = period.timeZoneSource === 'scheduler_fallback' ? `the scheduler zone ${period.timeZone} (the business time zone is not configured)` : period.timeZone;
  out.push(
    `_${period.label}: the period ends at the latest complete date (${inline(period.latestCompleteBasis, 300)}); dates follow ${inline(tzText, 200)}. Google organic and all organic are separate views and are never added.${gscTzNote ? ` Search Console days follow ${inline(gscTzNote, 60)}.` : ''}_`,
    '',
  );

  // Freshness
  freshnessSection(env);
  const entries = env.data.freshness ?? [];
  const synByDataset = new Map(
    ctx.db.all<{ source: string; dataset: string; syn: number | null; date_end: string | null }>('SELECT source, dataset, MAX(is_synthetic) AS syn, MAX(date_end) AS date_end FROM ingestion_batches WHERE site_id = ? GROUP BY source, dataset', [site]).map((r) => [`${r.source}|${r.dataset}`, r]),
  );
  const crawlSyn = ctx.db.get<{ is_synthetic: number }>("SELECT is_synthetic FROM crawls WHERE site_id = ? AND kind = 'own_site' ORDER BY started_at DESC LIMIT 1", [site]);
  const freshRows: string[][] = [];
  for (const e of entries) {
    const isCrawl = e.source === 'crawl';
    const batch = synByDataset.get(`${e.source}|${e.dataset}`);
    // Expected Search Console / GA4 datasets are always listed ("never synced" is a finding); other sources only once they have run.
    if (!e.lastAttemptAt && !batch && !(e.source === 'gsc' || e.source === 'ga4')) continue;
    const syn = isCrawl ? crawlSyn?.is_synthetic : batch?.syn;
    freshRows.push([
      cell(isCrawl ? 'crawl / own site' : `${e.source} / ${e.dataset}`),
      cell(e.lastStatus ?? (e.lastAttemptAt ? 'recorded' : 'never synced')),
      e.latestDataDate ? fmtDate(e.latestDataDate) : batch?.date_end ? fmtDate(batch.date_end) : '-',
      e.lastAttemptAt ? fmtTimestamp(e.lastAttemptAt) : 'never',
      syn === 1 ? 'yes' : syn === 0 ? 'no' : '-',
      e.lastSuccessfulSyncAt ? fmtTimestamp(e.lastSuccessfulSyncAt) : 'never',
      e.firstIncompleteDate ? fmtDate(e.firstIncompleteDate) : '-',
      cell(`${e.coverageWarnings.slice(0, 2).join('; ')}${e.truncated ? `${e.coverageWarnings.length ? '; ' : ''}truncated` : ''}`, 200),
    ]);
  }
  out.push('## Data freshness', '');
  out.push(
    freshRows.length
      ? table(['Dataset', 'Last status', 'Data through', 'Last run', 'Synthetic', 'Last successful sync', 'First incomplete date', 'Coverage warnings'], freshRows)
      : 'DATA UNAVAILABLE: nothing has been ingested or crawled yet. Run `npm run cli -- baseline` after configuring access.',
    '',
  );

  // Best opportunity
  out.push('## Best opportunity', '');
  const rec = latestPrimaryRecommendation(ctx.db, site, { notAfter: env.generatedAt });
  const opp = bestOpportunity(ctx.db, site);
  if (rec) {
    out.push(
      `- **RECOMMENDATION** ${link({ kind: 'recommendation', id: rec.id, label: rec.title })} (${inline(rec.kind)}, ${inline(rec.action_type)}, status **${inline(rec.status)}**)${rec.page_url ? ` on ${link({ kind: 'page', id: rec.page_id ?? rec.page_url, label: rec.page_url, url: rec.page_url })}` : ''}${rec.query ? ` · Query: "${inline(rec.query, 200)}"` : ''}`,
      `- Hypothesis: ${rec.hypothesis ? inline(rec.hypothesis, 600) : 'not recorded'}`,
      `- Success criteria: ${rec.success_criteria ? inline(rec.success_criteria, 400) : 'not recorded'} · Review date: ${fmtDate(rec.review_date, 'not set')}`,
    );
  }
  if (opp) {
    out.push(
      `- **INFERRED** Top shortlisted opportunity: ${inline(opp.route)} (${inline(opp.kind)})${opp.page_url ? ` on ${link({ kind: 'page', id: opp.page_id ?? opp.page_url, label: opp.page_url, url: opp.page_url })}` : ''}${opp.query ? `, query "${inline(opp.query, 200)}"` : ''}; score ${opp.score === null ? 'n/a' : opp.score.toFixed(2)} (status ${inline(opp.status)}).`,
    );
  }
  if (!rec && !opp) out.push('- **RECOMMENDATION** Wait: no evidence-backed opportunity or recommendation is recorded yet. "Leave unchanged" and "collect more evidence" are valid outcomes.');
  out.push('');

  // Active experiments
  experimentsSection(env);
  const exps = env.data.experiments ?? [];
  out.push('## Active experiments', '');
  if (exps.length) {
    out.push(
      table(
        ['Experiment', 'Page', 'Status', 'Start', 'Days (min)', 'Enough evidence', 'Review date'],
        exps.map((s) => [
          rawCell(link({ kind: 'experiment', id: s.id, label: `Experiment ${s.id}` })),
          cell(s.pageUrl ?? 'site-wide', 200),
          cell(s.status),
          cell(s.observationStart ?? 'not started'),
          s.daysObserved === null ? 'n/a' : `${s.daysObserved} (${s.minObservationDays})`,
          s.enoughEvidence ? 'yes' : 'no',
          fmtDate(s.reviewDate, 'not set'),
        ]),
      ),
      '',
    );
  } else out.push('_No active experiments (approved, awaiting implementation, or observing)._', '');

  // Pending approvals
  const pend = pendingApprovals(ctx.db, site, env.generatedAt, topN);
  out.push('## Pending approvals', '');
  if (pend.rows.length) {
    out.push(
      `${pend.total} pending.`,
      '',
      table(['ID', 'Action', 'Target', 'Summary', 'Expires'], pend.rows.map((a) => [cell(a.id, 60), cell(a.action_type), cell(a.target, 120), cell(a.summary, 200), fmtDate(a.expires_at)])),
      '',
      'Decide with `npm run cli -- approvals list` / `approvals approve <id>`. Editing Markdown (for example `approved: true`) authorizes nothing.',
      '',
    );
  } else out.push('_No pending approvals._', '');

  // Content queue
  const cq = contentQueue(ctx.db, site, topN);
  out.push('## Content queue', '');
  if (cq.items.length) {
    out.push(`Stages: ${Object.entries(cq.stages).map(([s, n]) => `${inline(s)} ${n}`).join(', ')}`, '');
    out.push(
      table(
        ['Title', 'Stage', 'Draft status', 'Unresolved facts', 'Review', 'Published'],
        cq.items.map((i) => [rawCell(link({ kind: 'content_item', id: i.id, label: i.title })), cell(i.stage), cell(i.draft_status ?? ''), i.unresolved_facts === null ? '' : String(i.unresolved_facts), cell(i.review_verdict ?? ''), i.published_at ? fmtDate(i.published_at) : '']),
      ),
      '',
    );
    if (cq.total > cq.items.length) out.push(`_Showing ${cq.items.length} of ${cq.total} items._`, '');
  } else out.push('_No content items in the pipeline._', '');
  const farm = noteLink(`content-farm-${site}`, 'Content farm pipeline');
  if (farm) out.push(`Full pipeline: ${farm}`, '');

  // Integration status
  out.push('## Integration status', '');
  if (input.statuses && input.statuses.length) {
    out.push(
      table(
        ['Integration', 'State', 'Detail', 'Next step', 'Checked'],
        // Offline checks show the date only, so an unchanged status does not rewrite the dashboard on every render.
        input.statuses.map((s) => [cell(s.id), cell(s.state), cell(s.detail, 200), cell(s.nextStep ?? '-', 200), s.networkChecked ? fmtTimestamp(s.checkedAt) : `${fmtDate(s.checkedAt)} (no network check)`]),
      ),
    );
    // Say when no status was verified over the network (a caller-supplied caveat takes precedence).
    const statusNote = input.statusNote ?? (input.statuses.every((s) => !s.networkChecked) ? 'Offline checks only: no network request verified these statuses (configuration and stored credentials only). Run `npm run cli -- doctor` for verified status.' : null);
    if (statusNote) out.push('', inline(statusNote, 400));
    out.push('');
  } else {
    const features = ctx.settings.features;
    out.push(
      input.statuses === null ? 'Live integration status was not collected during this render. Run `npm run cli -- doctor` for verified status.' : 'No integration statuses were supplied for this render. Run `npm run cli -- doctor` for verified status.',
      '',
      `Configured feature flags (not a connectivity check): ${FEATURE_KEYS.filter((k) => features[k]).map((k) => `\`${k}\``).join(', ') || 'none'}`,
      '',
    );
  }

  // Spend
  out.push('## Spend', '');
  try {
    const r = ctx.budgets.report(site, ctx.clock.now());
    const synthetic = r.synthetic || ctx.synthetic;
    // Actual spend is split into provider-reported and computed-from-usage amounts (spec 25:
    // an app-computed figure is never presented as a provider charge); synthetic amounts are labeled.
    const rows = r.providers.map((p) => {
      const b = r.costBasis.find((x) => x.provider === p.provider);
      const reported = b ? b.reportedMicros : p.actualMicros;
      const computed = b?.computedMicros ?? 0;
      const syn = synthetic ? p.committedMicros > 0 || (b?.syntheticCount ?? 0) > 0 : (b?.syntheticCount ?? 0) > 0;
      const synLabel = !syn ? '' : synthetic ? 'SYNTHETIC (demo; no real charge)' : `SYNTHETIC ${formatUsd(b!.syntheticMicros)} (${b!.syntheticCount} fixture/sandbox reservation(s); no real charge)`;
      return [cell(p.provider), formatUsd(reported), formatUsd(computed), formatUsd(p.reservedMicros), formatUsd(p.estimatedMicros), p.unknownCount ? `${p.unknownCount} (amount unknown)` : 'none', formatUsd(p.limitMicros), formatUsd(p.remainingMicros), synLabel || 'none'];
    });
    out.push(
      ...(synthetic ? [`**SYNTHETIC DEMO DATA: no real charges.** Every amount below comes from synthetic demo fixtures.`, ''] : []),
      `Month ${inline(r.periodMonth)} · week ${inline(r.periodWeek)} (${inline(r.timeZone)}). Budgets are ceilings, not price quotes; unknown charges are never shown as $0. Actual spend = provider-reported + computed; computed amounts are computed from usage at list price, not provider-reported, and still count toward the limits.`,
      '',
      table(['Provider', 'Provider-reported', 'Computed (usage x list price)', 'Reserved', 'Estimated-only', 'Unknown charges', 'Limit', 'Remaining', 'Synthetic'], rows),
      '',
      `Combined: ${formatUsd(r.combined.committedMicros)} committed of ${formatUsd(r.combined.limitMicros)} (remaining ${formatUsd(r.combined.remainingMicros)})${synthetic ? ' [SYNTHETIC]' : ''}.`,
      ...r.notes.map((n) => `- ${inline(n, 400)}`),
      '',
    );
  } catch (err) {
    out.push(`DATA UNAVAILABLE: spend report failed (${inline(errorMessage(err), 300)}).`, '');
  }

  // Latest reports
  const reports = listReports(ctx.db, site, { limit: 6 });
  out.push('## Latest reports', '');
  if (reports.length) {
    for (const r of reports) {
      const kind = r.kind as 'baseline' | 'weekly' | 'monthly';
      out.push(`- ${link({ kind: 'report', id: r.id, label: `${kind} ${r.period_start ?? '?'} to ${r.period_end ?? '?'}`, notePath: reportNotePath(kind, r.period_end, r.id) })} (generated ${inline(r.generated_at)}${r.is_synthetic ? ', SYNTHETIC' : ''})`);
    }
    out.push('');
  } else out.push('_No reports generated yet._', '');

  // Vault and system
  out.push('## Vault and system', '');
  const conflicts = ctx.db.all<{ rel_path: string; conflict_path: string; conflict_detected_at: string | null }>(
    'SELECT rel_path, conflict_path, conflict_detected_at FROM vault_notes WHERE site_id = ? AND conflict_path IS NOT NULL ORDER BY conflict_detected_at DESC LIMIT 20',
    [site],
  );
  out.push('### Open vault conflicts', '');
  out.push(
    conflicts.length
      ? `${bulletList(conflicts.map((c) => `${code(c.rel_path, 200)} · proposed version ${code(c.conflict_path, 200)} · ${fmtTimestamp(c.conflict_detected_at)}`))}\n\nResolve with \`npm run cli -- vault resolve "<note path>" --use-generated\` or \`--detach\`, then \`vault render\`.`
      : '_No open conflicts._',
    '',
  );
  const index = noteLink(`vault-index-${site}`, 'Vault index');
  out.push(
    ...(index ? [`- Index of generated notes: ${index}`] : []),
    `- System logs (append-only, one note per day in ${inline(reportTimeZoneInfo(ctx).timeZone)}): \`14 System Logs/\``,
    '- Decisions and learnings: `12 Decisions/` and `13 Learnings/`.',
    '',
  );

  // Optional Dataview extra
  out.push(
    '## Optional: Dataview',
    '',
    '_Requires the Dataview community plugin. Everything above works without it._',
    '',
    '```dataview',
    'TABLE report_kind AS "Kind", period_start AS "Start", period_end AS "End", confidence AS "Confidence"',
    'FROM "07 Reports"',
    'WHERE type = "report"',
    'SORT generated_at DESC',
    'LIMIT 10',
    '```',
    '',
  );

  const isSynthetic = env.synthetic.size > 0;
  if (isSynthetic) {
    out.splice(bodyStart, 0, syntheticBanner(), '');
    out.push(`> **${SYNTHETIC_WATERMARK}**`, '');
  }
  out.push('_Static summary generated from SQLite; see the latest weekly report for labeled claims and evidence._');
  const body = redactString(out.join('\n').replace(/\n{3,}/g, '\n\n')) + '\n';
  return {
    relPath: input.target?.relPath ?? DASHBOARD_REL_PATH,
    noteId: input.target?.noteId ?? `dashboard-${site}`,
    kind: 'dashboard',
    title: `Dashboard: ${ctx.config.site.businessName}`,
    frontmatter: {
      type: 'dashboard',
      site,
      source_ids: [],
      rendered_from: 'sqlite',
      cssclasses: ['seo-agent-dashboard'],
      period_start: period.start,
      period_end: period.end,
      period_rule: `last ${period.days} complete days`,
      is_synthetic: isSynthetic,
      tags: ['seo-agent/dashboard'],
      ...(isSynthetic ? { watermark: SYNTHETIC_WATERMARK } : {}),
    },
    body,
  };
}
