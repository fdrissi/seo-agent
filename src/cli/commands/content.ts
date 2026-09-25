import { readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { AppError, ERROR_CODE_VALUES, errorMessage, IntegrationDisabledError, type ErrorCode } from '../../core/errors.js';
import { formatMeasured } from '../../core/measured.js';
import { formatUsd } from '../../core/money.js';
import { DEFAULT_LOCK_NAME, getSiteLock } from '../../jobs/locks.js';
import { renderAll, type RenderSummary } from '../../obsidian/notes.js';
import { runBatchDrafts } from '../../content/batch.js';
import { runLowDataBootstrap, type BootstrapPage } from '../../content/bootstrap.js';
import { assertBriefable, createBrief } from '../../content/brief.js';
import { resolveContentDeps, type ContentDeps, type DependencyStatus } from '../../content/deps.js';
import { assertDraftReady, checkDraftPreconditions, DraftRefusedError } from '../../content/draft.js';
import { importManualQuestions } from '../../content/import.js';
import { registerContentJobHandlers, runContentBatchJob, runContentProductionJob, runContentResearchJob, type ContentJobRun } from '../../content/jobs.js';
import { contentItemNote } from '../../content/notes.js';
import { checkPublicationGate, markHumanReviewed, measurePublishedContent, type PublicationGateResult } from '../../content/publication.js';
import { aiReviewStatusLabel } from '../../content/quality.js';
import { MAX_HUMAN_BODY_CHARS, reviewRefusal, reviseDraftManually, reviewWithRevisions, storedReviewResult } from '../../content/review.js';
import { discoverSignals } from '../../content/signals.js';
import { contentStageAllowances } from '../../content/stages.js';
import { getBrief, getDraft, getItem, latestBrief, latestDraft, listItems, listSignals } from '../../content/store.js';
import { catalogAttributeSchema, CONTENT_STAGES, factResolutionsFileSchema, type BriefGateResult, type BriefRecord, type ContentBrief, type ContentStage, type FactResolutionInput, type QualityReviewResult } from '../../content/types.js';
import type { ApprovalRecord } from '../../approvals/types.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

/**
 * `content` commands: discover, import, list, show, brief, draft, batch,
 * review, bootstrap, mark-reviewed, revise-manual, publish-check, measure.
 *
 * Model calls spend money: they only happen with an explicit `--use-model`
 * flag, and the per-run LLM cap is shown. Drafting additionally requires
 * `--mode DRAFT` and a human draft approval bound to the brief hash.
 *
 * `brief`, `draft`, `review`, and `batch` run through the SAME durable path
 * as `content produce`: a content job on the job runner (checkpointed stages,
 * per-stage LLM allowances enforced by the workflow engine, resumable with
 * `jobs resume <job-id>`). Only --dry-run previews run in-process, and they
 * never spend or write.
 */

const programmaticSchema = z.object({
  templateId: z.string().min(1).nullable().default(null),
  differentiatingData: z.array(z.object({ field: z.string().min(1), value: z.string().min(1), evidenceIds: z.array(z.string()) })).default([]),
});

/** Read a human-edited Markdown body (exact text; size-limited). */
function readBodyFile(file: string): string {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new AppError('NOT_FOUND', `File not found: ${file}`);
  }
  // Characters never exceed UTF-8 bytes x 1; a file over 4 bytes per allowed character is certainly too long.
  if (size > MAX_HUMAN_BODY_CHARS * 4) throw new AppError('VALIDATION_FAILED', `${file} is ${size} bytes; the edited body may have at most ${MAX_HUMAN_BODY_CHARS} characters.`);
  return readFileSync(file, 'utf8');
}

/**
 * `content revise-manual` changes content state; like the commands in
 * MUTATING_COMMANDS it never runs alongside a job that could write a draft of
 * the same site (the site lease, or the content jobs' "content" lock).
 */
function refuseWhileJobHoldsContentLocks(ctx: AppContext, command: string): void {
  for (const name of [DEFAULT_LOCK_NAME, 'content']) {
    const lock = getSiteLock(ctx.db, ctx.siteId, name);
    if (!lock || !lock.jobId || Date.parse(lock.expiresAt) <= ctx.clock.now().getTime()) continue;
    throw new AppError('LOCKED', `Site ${ctx.siteId}: lock "${name}" is held by job ${lock.jobId} (held by ${lock.owner}, lease until ${lock.expiresAt}). "${command}" writes a draft version, so it never runs alongside a job that may write drafts. Nothing was done.`, {
      hint: `Wait for job ${lock.jobId} to finish (\`npm run cli -- jobs show ${lock.jobId}\`), or cancel it with \`jobs cancel ${lock.jobId}\`, then retry. --dry-run previews still work meanwhile.`,
      details: { command, siteId: ctx.siteId, lockName: name, jobId: lock.jobId, owner: lock.owner, expiresAt: lock.expiresAt },
    });
  }
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new AppError('NOT_FOUND', `File not found: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AppError('VALIDATION_FAILED', `${file}: invalid JSON (${(err as Error).message})`);
  }
}

/**
 * The per-run LLM cap is enforced by the LLM gateway's budget reservation on
 * every call; every content command that can spend runs as a durable job, so
 * the workflow engine also enforces the per-stage allowances.
 */
function capLine(ctx: AppContext, opts: { engine?: boolean } = {}): string {
  const a = contentStageAllowances(ctx.settings);
  const allowances = `classify ${formatUsd(a.classify)}, cluster ${formatUsd(a.cluster)}, brief ${formatUsd(a.brief)}, draft ${formatUsd(a.draft)}, review ${formatUsd(a.review)}`;
  return `LLM spend cap: ${formatUsd(ctx.settings.budgets.llmGateway.perRun)} per run (llmGateway.perRunUsd, enforced by budget reservation on every call). ${
    opts.engine === false ? `Dry run: nothing is spent.` : `Per-stage allowances enforced by the workflow engine: ${allowances}.`
  }`;
}

/** Every ErrorCode (built from src/core/errors.ts, so a new code such as OFFLINE is never reported as INTERNAL). */
const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>(ERROR_CODE_VALUES);

/** Workflow-engine failure codes that are policy refusals, not internal errors. */
const POLICY_FAILURE_CODES: ReadonlySet<string> = new Set(['EVIDENCE_INSUFFICIENT', 'BLOCKED', 'MODE_NOT_PERMITTED', 'INVALID_TRANSITION']);

/**
 * The ErrorCode a failed content job surfaces: the stage's own code when it is
 * an ErrorCode (OFFLINE included), POLICY_DENIED for the workflow engine's
 * policy stops, INTERNAL otherwise.
 */
export function contentJobErrorCode(raw: string): ErrorCode {
  if (ERROR_CODES.has(raw)) return raw as ErrorCode;
  return POLICY_FAILURE_CODES.has(raw) ? 'POLICY_DENIED' : 'INTERNAL';
}

/** Throw an AppError for a content job that did not complete (keeps the stage's error code; names the job for resume). */
function throwIfJobFailed(run: ContentJobRun): void {
  if (run.outcome === 'succeeded' || run.outcome === 'waiting') return;
  const raw = run.failure?.code ?? (run.outcome === 'locked' ? 'LOCKED' : run.outcome === 'cancelled' ? 'CANCELLED' : 'INTERNAL');
  const code = contentJobErrorCode(raw);
  const message = run.failure ? `${run.failure.message} (content job ${run.jobId})` : `Content job ${run.jobId}: ${run.outcome}${run.note ? ` (${run.note})` : ''}`;
  throw new AppError(code, message, { details: { jobId: run.jobId, outcome: run.outcome, stages: run.stages }, hint: run.outcome === 'locked' ? 'Another content job is running; retry when it finishes.' : `Inspect with \`jobs show ${run.jobId}\`; after fixing the cause resume with \`jobs resume ${run.jobId}\`.` });
}

function depLines(status: DependencyStatus[]): string[] {
  return status.map((s) => `  ${s.name}: ${s.wired ? 'wired' : 'NOT WIRED'} (${s.detail})`);
}

async function withContext<T>(cli: CliRuntime, g: GlobalOptions, fn: (ctx: AppContext, deps: ContentDeps, status: DependencyStatus[]) => Promise<T>): Promise<T> {
  const ctx = cli.context(g);
  try {
    const { deps, status } = await resolveContentDeps(ctx);
    return await fn(ctx, deps, status);
  } finally {
    ctx.db.close();
  }
}

/** What a content command did with the vault notes (shown as "Notes: ..."; `--json` field `notes`). */
export interface ContentNotesResult {
  written: boolean;
  detail: string;
  /** Vault paths of the content notes this render wrote or checked. */
  paths: string[];
  /** Notes that could not be built or written (the command's own result is unaffected). */
  errors?: string[];
}

/**
 * The vault has ONE writer for content notes: the vault renderer. After a
 * content command changes records, the content notes (opportunities, briefs,
 * drafts, and the content-farm pipeline) are rendered through `renderAll` with
 * `only: ['content']`, the same path as `vault render` and the content
 * queue's `queue_notes` stage, so the vault never holds a second, parallel set
 * of notes for the same records. Human text outside the generated markers is
 * preserved and edited notes get conflict artifacts (VaultWriter). A failed
 * render is reported, never shown as written.
 */
function renderContentNotes(ctx: AppContext, deps: ContentDeps): ContentNotesResult {
  if (ctx.dryRun) return { written: false, detail: 'dry run: notes not written', paths: [] };
  if (!deps.vault) return { written: false, detail: 'vault writer not wired: notes not written', paths: [] };
  let s: RenderSummary;
  try {
    s = renderAll(ctx, deps.vault, { only: ['content'] });
  } catch (err) {
    return { written: false, detail: `content notes not written: ${errorMessage(err)} (the records are stored; run \`npm run cli -- vault render --only content\` after fixing the cause)`, paths: [] };
  }
  if (s.status !== 'rendered') return { written: false, detail: s.detail, paths: [] };
  const errors = s.errors.map((e) => `${e.relPath ?? e.key}: ${e.error}`);
  return {
    written: true,
    detail: `content notes rendered (same as \`vault render --only content\`): ${s.detail}${s.counts.conflict ? '; human edits preserved (see the conflict artifacts)' : ''}`,
    paths: s.outcomes.map((o) => o.relPath),
    ...(errors.length ? { errors } : {}),
  };
}

function modelFlag(ctx: AppContext, useModel: boolean | undefined, opts: { engine?: boolean } = {}): { useModel: boolean; note: string } {
  if (useModel) return { useModel: true, note: `Model calls allowed (--use-model). ${capLine(ctx, opts)}` };
  return { useModel: false, note: `Deterministic only: no model calls (pass --use-model to allow LLM spend; ${formatUsd(ctx.settings.budgets.llmGateway.perRun)} per-run cap).` };
}

function pageLine(label: string, p: BootstrapPage): string {
  if (p.status === 'already_in_progress') return `${label} item ${p.itemId}: already in progress (${p.stage}); left unchanged.`;
  if (p.status === 'held_by_experiment') return `${label} item ${p.itemId}: not briefed. ${p.reason}`;
  const errors = p.brief.gate.issues.filter((i) => i.severity === 'error').map((i) => i.code);
  return `${label} brief: item ${p.itemId}${p.brief.reused ? ' (reused, inputs unchanged)' : ''}, gate ${p.brief.gate.passed ? 'passed' : `FAILED: ${errors.join(', ')}`}`;
}

function renderReview(r: QualityReviewResult): string[] {
  const lines = [`Verdict: ${r.verdict.toUpperCase()}${r.revisionLimitReached ? ' (automated revision limit reached)' : ''} (revision round ${r.revisionRound})`];
  for (const x of r.reasons.slice(0, 25)) lines.push(`  - [${x.consequence}] ${x.code}: ${x.message}`);
  if (r.reasons.length > 25) lines.push(`  ... ${r.reasons.length - 25} more (use --json)`);
  lines.push(`AI review: ${aiReviewStatusLabel(r.aiReview)} (${r.aiReview.reason}). ${r.aiReview.disclaimer}`);
  lines.push('Human review is required before publication; this verdict does not authorize publishing.');
  return lines;
}

/**
 * What `export draft` (approvals slice, src/approvals/export.ts) enforces by
 * itself, and what only this content-side check reports. Keep in sync with
 * exportSubject / draftProposal / assertDraftHumanAccepted.
 */
export const EXPORT_ENFORCES =
  'Run this check before exporting. `export draft` itself enforces: EXECUTE mode; a named human\'s recorded acceptance of this exact body (`content mark-reviewed`; automated verdicts never count); an exportable draft status (review_passed, approved, exported, published); zero recorded unresolved facts; a valid approval bound to this exact proposal (change hash, and source revision when bound; one-time); and a target recheck just before writing. It does NOT check that this is the latest draft of its item, and it labels but does not refuse synthetic data: those blockers are reported here.';

/**
 * What an ALLOWED publish-check rests on: the recorded human acceptance of this
 * exact body (who and when) and the human approval of this exact proposal.
 */
function allowedLines(x: Pick<PublicationGateResult, 'humanReview' | 'approval' | 'binding'>): string[] {
  const hr = x.humanReview;
  const accepted = hr?.accepted
    ? `  - Body accepted by ${hr.reviewer ?? 'a named reviewer (name not recorded)'} at ${hr.reviewedAt ?? 'an unrecorded time'} (\`content mark-reviewed\`, review ${hr.reviewId ?? 'n/a'}, body hash ${hr.bodyHash.slice(0, 12)}).`
    : '  - Human acceptance of this body: not recorded.';
  const a = x.approval?.approval;
  const approved = a
    ? `  - ${a.actionType} approval ${a.id} of this exact proposal${a.approver ? ` approved by ${a.approver}` : ''}${a.decidedAt ? ` at ${a.decidedAt}` : ''}${x.approval?.ok ? '' : ' (bound to a source revision; `export draft` verifies it)'}.`
    : `  - ${x.binding?.actionType ?? 'Publication'} approval of this exact proposal: valid.`;
  return [accepted, approved];
}

export function register(program: Command, cli: CliRuntime): void {
  // Durable content job types, so `jobs resume <id>` can continue an interrupted content workflow.
  registerContentJobHandlers();
  const content = program.command('content').description('Content farming pipeline: research-to-value discovery, briefs, gated drafts, quality review (nothing is published automatically)');

  content
    .command('discover')
    .description('DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND -> CHECK EXISTING -> PRIORITIZE')
    .option('--gsc-days <n>', 'Search Console lookback in days', (v) => Number.parseInt(v, 10), 28)
    .option('--max-queries <n>', 'maximum Search Console queries to collect', (v) => Number.parseInt(v, 10), 200)
    .option('--use-model', 'allow the cheap model for ambiguous intent (spends money; shows the cap)')
    .option('--semantic', 'also use embeddings for clustering (requires --use-model, features.embeddings)')
    .action(
      cli.action(async (opts: { gscDays: number; maxQueries: number; useModel?: boolean; semantic?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps, depStatus) => {
          if (!ctx.settings.features.contentDiscovery) throw new IntegrationDisabledError('contentDiscovery', 'set features.contentDiscovery: true in the site config to run the content discovery queue');
          const m = modelFlag(ctx, opts.useModel, { engine: true });
          if (opts.semantic && !m.useModel) throw new AppError('POLICY_DENIED', '--semantic uses paid embeddings: pass --use-model as well.');
          if (ctx.dryRun) {
            const preview = await discoverSignals(ctx, deps.memory, { gscDays: opts.gscDays, maxGscQueries: opts.maxQueries, preview: true });
            const { signals: _s, ...rest } = preview;
            void _s;
            const result = { dryRun: true, ...rest, model: 'no model calls in dry run', dependencies: depStatus };
            cli.print(g, result, (r) => ['DRY RUN: nothing written, no model calls.', ...r.sourceStatus.map((s: { origin: string; status: string; detail: string }) => `  ${s.origin}: ${s.status}: ${s.detail}`), `Would collect: ${JSON.stringify(r.countsByOrigin)}`, `Excluded: ${JSON.stringify(r.excluded)}`].join('\n'));
            return;
          }
          // Durable job: checkpointed stages (resume with `jobs resume <job-id>`), per-stage LLM allowances enforced.
          const run = await runContentResearchJob(ctx, { gscDays: opts.gscDays, maxGscQueries: opts.maxQueries, useModel: m.useModel, semantic: !!opts.semantic });
          const notes = renderContentNotes(ctx, deps);
          const ranked = (run.outputs.prioritize as { ranked?: Array<{ itemId: string; title: string; decision: string; score: number | null; selectable: boolean }> } | undefined)?.ranked ?? [];
          const status = run.workflowStatus === 'succeeded' ? 'completed' : run.workflowStatus === 'stopped' ? 'stopped' : 'failed';
          const stop = run.stoppedBy ? { stage: run.stoppedBy.stage, stop: true, status: run.stoppedBy.status, reason: run.stoppedBy.reason } : null;
          const result = { status, jobId: run.jobId, jobOutcome: run.outcome, note: run.note, stop, failure: run.failure, stages: run.stages, outputs: run.outputs, ranked: ranked.slice(0, 20), model: m.note, notes, dependencies: depStatus };
          cli.print(g, result, (r) =>
            [
              `Content research (job ${r.jobId}): ${r.status}${r.stop ? ` at ${r.stop.stage} (${r.stop.status}: ${r.stop.reason})` : ''}${r.failure ? ` at ${r.failure.stage} (${r.failure.code}: ${r.failure.message})` : ''}${r.note ? ` [${r.note}]` : ''}`,
              ...r.stages.map((s: { stage: string; status: string; resumedFromCheckpoint: boolean; error?: { message: string } }) => `  ${s.stage}: ${s.status}${s.resumedFromCheckpoint ? ' (from checkpoint)' : ''}${s.error ? ` (${s.error.message})` : ''}`),
              '',
              'Top items (one item in production at a time by default):',
              ...(r.ranked.length ? r.ranked.map((x: { itemId: string; title: string; decision: string; score: number | null; selectable: boolean }) => `  ${x.itemId}  ${x.selectable ? '*' : ' '} ${String(x.score ?? '').padEnd(5)} ${x.decision.padEnd(16)} ${x.title}`) : ['  (none)']),
              '',
              r.model,
              `Notes: ${r.notes.detail}`,
              'Dependencies:',
              ...depLines(r.dependencies),
              '',
              r.status === 'failed' ? `Resume after fixing the cause: npm run cli -- jobs resume ${r.jobId}` : 'Next: npm run cli -- content brief <item-id>',
            ].join('\n'),
          );
          if (status === 'failed') process.exitCode = 1;
        });
      }),
    );

  content
    .command('import <file>')
    .description('Import manually supplied customer questions (CSV with a text/question column, or JSON)')
    .option('--format <format>', 'csv | json (default: by file extension)')
    .action(
      cli.action(async (file: string, opts: { format?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx) => {
          if (opts.format && opts.format !== 'csv' && opts.format !== 'json') throw new AppError('VALIDATION_FAILED', '--format must be csv or json');
          const r = importManualQuestions(ctx, file, { ...(opts.format ? { format: opts.format as 'csv' | 'json' } : {}), preview: ctx.dryRun });
          const result = { ...r, signals: r.signals.map((s) => ({ id: s.id, text: s.text, type: s.signalType })) };
          cli.print(g, result, (x) =>
            [
              `${x.preview ? 'DRY RUN: ' : ''}${x.accepted} of ${x.rowsRead} row(s) ${x.preview ? 'valid' : 'imported'} from ${x.file} (${x.format}).`,
              x.redactions ? `Removed ${x.redactions} email/phone value(s) before storage.` : '',
              x.instructionLikeRows.length ? `Rows with instruction-like text (stored as data, never followed): ${x.instructionLikeRows.join(', ')}.` : '',
              x.ignoredColumns?.length ? `Ignored columns (not recognized, not stored): ${x.ignoredColumns.join(', ')}.` : '',
              ...x.rejected.map((e: { row: number; errors: string[] }) => `  row ${e.row}: ${e.errors.join('; ')}`),
              x.preview ? '' : 'Next: npm run cli -- content discover',
            ]
              .filter(Boolean)
              .join('\n'),
          );
          if (r.rejected.length && !r.accepted) process.exitCode = 1;
        });
      }),
    );

  content
    .command('list')
    .description('List content items by priority')
    .option('--stage <stage>', `filter by stage (${CONTENT_STAGES.join(', ')})`)
    .option('--limit <n>', 'maximum rows', (v) => Number.parseInt(v, 10), 50)
    .action(
      cli.action(async (opts: { stage?: string; limit: number }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx) => {
          if (opts.stage && !(CONTENT_STAGES as readonly string[]).includes(opts.stage)) throw new AppError('VALIDATION_FAILED', `Unknown stage "${opts.stage}"`);
          const items = listItems(ctx.db, ctx.siteId, { ...(opts.stage ? { stages: [opts.stage as ContentStage] } : {}), limit: opts.limit });
          const rows = items.map((i) => ({ id: i.id, title: i.title, stage: i.stage, decision: i.decision, intent: i.intent, score: i.priorityScore, synthetic: i.isSynthetic, decisionReason: i.decisionReason }));
          cli.print(g, rows, (rs: typeof rows) => (rs.length ? rs.map((r) => `${r.id}  ${r.stage.padEnd(16)} ${(r.decision ?? '').padEnd(16)} ${String(r.score ?? '').padEnd(5)} ${r.title}${r.synthetic ? ' [SYNTHETIC]' : ''}`).join('\n') : 'No content items. Run `content discover` (or `content import <file>` first).'));
        });
      }),
    );

  content
    .command('show <item-id>')
    .description('Show a content item with its rationale, demand evidence, signals, brief, and draft status')
    .action(
      cli.action(async (itemId: string, _o: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx) => {
          const item = getItem(ctx.db, ctx.siteId, itemId);
          if (!item) throw new AppError('NOT_FOUND', `Content item ${itemId} not found`);
          const signals = listSignals(ctx.db, ctx.siteId, { itemId });
          const brief = latestBrief(ctx.db, ctx.siteId, itemId);
          const draft = latestDraft(ctx.db, ctx.siteId, itemId);
          const note = contentItemNote(item, signals, { brief, draft });
          cli.print(g, { item, signals, brief: brief ? { id: brief.id, version: brief.version, status: brief.status, gate: brief.gate } : null, draft: draft ? { id: draft.id, version: draft.version, status: draft.status, unresolvedFacts: draft.unresolvedFacts } : null }, () => note.body);
        });
      }),
    );

  content
    .command('brief <item-id>')
    .description('Build the brief and run the deterministic brief gate; on pass, request the draft approval bound to the brief hash')
    .option('--use-model', 'allow the reasoning model to synthesize the brief (spends money; shows the cap)')
    .option('--no-approval-request', 'do not create the pending draft approval request')
    .option('--catalog <file>', 'JSON array of catalog attributes [{name, value, source: catalog|owner|image|model, validated}] for product/category pages')
    .option('--programmatic <file>', 'JSON {templateId, differentiatingData: [{field, value, evidenceIds}]} for a programmatic page (requires real distinct data)')
    .option('--force', 'build a new brief version even when the inputs are unchanged (the draft approval must then be requested again)')
    .action(
      cli.action(async (itemId: string, opts: { useModel?: boolean; approvalRequest?: boolean; catalog?: string; programmatic?: string; force?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps, status) => {
          const m = modelFlag(ctx, opts.useModel);
          const catalogAttributes = opts.catalog ? z.array(catalogAttributeSchema).max(200).parse(readJsonFile(opts.catalog)) : undefined;
          const programmatic = opts.programmatic ? { isProgrammatic: true, ...programmaticSchema.parse(readJsonFile(opts.programmatic)) } : undefined;
          const briefOpts = { requestApproval: opts.approvalRequest !== false, force: !!opts.force, ...(catalogAttributes ? { catalogAttributes } : {}), ...(programmatic ? { programmatic } : {}) };
          let r: { record: BriefRecord | null; brief: ContentBrief; gate: BriefGateResult; contentHash: string; reused: boolean; approvalRequest: ApprovalRecord | null; approvalStatus: string | null; modelStatus: string };
          let jobId: string | null = null;
          if (ctx.dryRun) {
            // Preview only: no writes, no model call.
            r = await createBrief(ctx, deps, itemId, { useModel: m.useModel, ...briefOpts });
          } else {
            // Durable path (same as `content produce`): a brief-only content job with checkpoints and the brief stage allowance.
            assertBriefable(ctx, itemId);
            const run = await runContentProductionJob(ctx, { itemId, useModel: m.useModel, stages: ['brief'], brief: briefOpts });
            throwIfJobFailed(run);
            jobId = run.jobId;
            const out = run.outputs.brief as { briefId: string | null; reused: boolean; approvalStatus: string | null; modelStatus: string; contentHash: string } | undefined;
            const record = out?.briefId ? getBrief(ctx.db, ctx.siteId, out.briefId) : null;
            if (!out || !record || !record.gate) throw new AppError('INTERNAL', `Content job ${run.jobId} finished without a stored brief.`, { details: { jobId: run.jobId, outcome: run.outcome } });
            let approvalRequest: ApprovalRecord | null = null;
            if (deps.approvals) {
              const c = deps.approvals.check({ siteId: ctx.siteId, actionType: 'draft_generation', subjectType: 'content_brief', subjectId: record.id, artifactHash: record.contentHash });
              approvalRequest = c.ok ? c.approval : (c.approval ?? null);
            }
            r = { record, brief: record.brief, gate: record.gate, contentHash: record.contentHash, reused: out.reused, approvalRequest, approvalStatus: out.approvalStatus, modelStatus: out.modelStatus };
          }
          const notes: ContentNotesResult = r.record && !ctx.dryRun ? renderContentNotes(ctx, deps) : { written: false, detail: 'dry run: not persisted', paths: [] };
          const result = { dryRun: ctx.dryRun, jobId, briefId: r.record?.id ?? null, version: r.record?.version ?? null, reused: r.reused, status: r.record?.status ?? (r.gate.passed ? 'gate_passed (preview)' : 'gate_failed (preview)'), contentHash: r.contentHash, gate: r.gate, approvalRequest: r.approvalRequest, approvalStatus: r.approvalStatus, modelStatus: r.modelStatus, model: m.note, notes, dependencies: status, brief: r.brief };
          cli.print(g, result, (x) =>
            [
              `${x.dryRun ? 'DRY RUN: ' : ''}Brief ${x.briefId ?? '(preview)'} v${x.version ?? '-'}${x.reused ? ' (REUSED: inputs unchanged; pass --force to rebuild)' : ''}: gate ${x.gate.passed ? 'PASSED' : 'FAILED'}${x.jobId ? ` (content job ${x.jobId})` : ''}`,
              ...x.gate.issues.map((i: { severity: string; code: string; message: string }) => `  - ${i.severity}: ${i.code}: ${i.message}`),
              `Brief hash: ${x.contentHash}`,
              `Synthesis: ${x.modelStatus}`,
              x.model,
              x.approvalStatus === 'approved'
                ? `Draft approval ${x.approvalRequest?.id ?? ''} is approved for this brief hash. Next: npm run cli -- content draft ${itemId} --mode DRAFT --use-model`
                : x.approvalStatus === 'already_executed'
                  ? `The draft approval ${x.approvalRequest?.id ?? ''} for this brief was already used for a draft. Review that draft, or rebuild the brief (--force) and request a new approval.`
                  : x.approvalStatus === 'rejected'
                    ? `A human rejected drafting this brief (${x.approvalRequest?.id ?? ''}); it is not re-requested. Change the brief (--force) first.`
                    : x.approvalRequest
                    ? `Draft approval ${x.approvalStatus === 'requested' ? 'requested' : 'pending'}: ${x.approvalRequest.id} (${x.approvalRequest.status}). A human approves with: npm run cli -- approvals approve ${x.approvalRequest.id}`
                    : x.gate.passed
                      ? deps.approvals
                        ? 'Draft approval request not created.'
                        : 'Approval service not wired: draft approval cannot be requested yet.'
                      : 'Fix the gate issues, then re-run `content brief`.',
              `Notes: ${x.notes.detail}`,
            ].join('\n'),
          );
          if (!r.gate.passed) process.exitCode = 1;
        });
      }),
    );

  content
    .command('draft <item-id>')
    .description('Generate a draft package (requires --mode DRAFT, a gate-passed brief, a draft approval bound to its hash, and --use-model); runs quality gates with at most 2 automated revisions')
    .option('--use-model', 'required: allow the reasoning model (spends money; shows the cap)')
    .action(
      cli.action(async (itemId: string, opts: { useModel?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps, status) => {
          if (ctx.dryRun) {
            const pre = checkDraftPreconditions(ctx, deps, itemId);
            cli.print(g, { dryRun: true, wouldRun: pre.ok && !!opts.useModel, checks: pre.checks, capacity: pre.capacity, cap: capLine(ctx), dependencies: status }, (r) =>
              [`DRY RUN: draft ${r.wouldRun ? 'WOULD run' : 'would NOT run'} (no model call, no writes).`, ...r.checks.map((c: { id: string; ok: boolean; detail: string }) => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`), opts.useModel ? '' : '  FAIL spend: pass --use-model to allow the paid draft call.', r.cap].filter(Boolean).join('\n'),
            );
            return;
          }
          if (!opts.useModel) throw new AppError('POLICY_DENIED', `Drafting calls the reasoning model and spends money: re-run with --use-model. ${capLine(ctx)}`);
          try {
            // Refusals (mode, gate, approval, capacity) are raised before any job exists, exactly as before.
            assertDraftReady(ctx, deps, itemId);
            // Durable path (same as `content produce`): draft -> quality_review as a checkpointed content job.
            const run = await runContentProductionJob(ctx, { itemId, useModel: true, stages: ['draft', 'quality_review'], review: { revise: true } });
            throwIfJobFailed(run);
            const d = run.outputs.draft as { draftId: string | null; approvalConsumed: string | null; modelReview: { reason: string; callId: string | null } | null } | undefined;
            if (!d?.draftId) {
              // The writer's output needs human review: no draft, approval not used, job waiting.
              const needs = { jobId: run.jobId, jobOutcome: run.outcome, draftId: null, needsReview: d?.modelReview ?? null, stop: run.stoppedBy, cap: capLine(ctx) };
              cli.print(g, needs, (x) => [`No draft: ${x.stop?.reason ?? 'the draft step produced no draft'}`, `Content job ${x.jobId} (${x.jobOutcome}).`, x.cap].join('\n'));
              process.exitCode = 1;
              return;
            }
            const rv = run.outputs.quality_review as { finalDraftId: string | null; revisions: number; modelReview: { reason: string } | null } | undefined;
            const finalDraft = getDraft(ctx.db, ctx.siteId, rv?.finalDraftId ?? d.draftId)!;
            const finalReview = storedReviewResult(ctx, finalDraft.id);
            if (!finalReview) throw new AppError('INTERNAL', `Content job ${run.jobId} finished without a stored quality review for draft ${finalDraft.id}.`, { details: { jobId: run.jobId } });
            const notes = renderContentNotes(ctx, deps);
            const result = { jobId: run.jobId, jobOutcome: run.outcome, draftId: finalDraft.id, version: finalDraft.version, status: finalDraft.status, briefId: finalDraft.briefId, briefHash: finalDraft.briefHash, unresolvedFacts: finalDraft.unresolvedFacts, revisionsUsed: rv?.revisions ?? 0, approvalConsumed: d.approvalConsumed, review: finalReview, revisionNeedsReview: rv?.modelReview ?? null, publicationBlockers: finalDraft.pkg.publicationBlockers, cap: capLine(ctx), notes };
            cli.print(g, result, (x) =>
              [
                `Draft ${x.draftId} v${x.version} (${x.status}); brief ${x.briefId} hash ${x.briefHash.slice(0, 16)}; revisions used ${x.revisionsUsed}; approval consumed ${x.approvalConsumed ?? 'n/a'}; content job ${x.jobId}.`,
                x.revisionNeedsReview ? `A revision's model output needs human review: ${x.revisionNeedsReview.reason}` : '',
                `Unresolved facts: ${x.unresolvedFacts}`,
                ...renderReview(x.review),
                'Publication blockers:',
                ...x.publicationBlockers.map((b: string) => `  - ${b}`),
                x.cap,
                `Notes: ${x.notes.detail}`,
              ]
                .filter(Boolean)
                .join('\n'),
            );
          } catch (err) {
            if (err instanceof DraftRefusedError && !g.json) {
              cli.io.err('Draft refused. Preconditions:');
              for (const c of err.preconditions.checks) cli.io.err(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
            }
            throw err;
          }
        });
      }),
    );

  content
    .command('batch <item-ids...>')
    .description('BOUNDED PARALLEL batch drafts (max 3 workers). A first batch_expansion approval drafts a pilot of up to 3 and STOPS; after a human accepts every pilot draft (mark-reviewed), a second approval expands to the rest. Requires content.batchEnabled, content.pilotApproved, --mode DRAFT, and --use-model')
    .option('--workers <n>', 'concurrent drafts (1-3)', (v) => Number.parseInt(v, 10), 3)
    .option('--use-model', 'required: allow model spend (shows the cap)')
    .action(
      cli.action(async (itemIds: string[], opts: { workers: number; useModel?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps) => {
          if (!opts.useModel && !ctx.dryRun) throw new AppError('POLICY_DENIED', `Batch drafting spends money: re-run with --use-model. ${capLine(ctx)}`);
          let r: Awaited<ReturnType<typeof runBatchDrafts>>;
          let jobId: string | null = null;
          if (ctx.dryRun) r = await runBatchDrafts(ctx, deps, { itemIds, workers: opts.workers }); // preview: never generates
          else {
            // Durable path: the whole batch phase is one checkpointed paid stage (never blindly re-run after an interruption).
            const run = await runContentBatchJob(ctx, { itemIds, workers: Math.max(1, Math.min(3, opts.workers || 3)) });
            throwIfJobFailed(run);
            jobId = run.jobId;
            const out = run.outputs.batch as Awaited<ReturnType<typeof runBatchDrafts>> | undefined;
            if (!out) throw new AppError('INTERNAL', `Content batch job ${run.jobId} finished without a result.`, { details: { jobId: run.jobId, outcome: run.outcome } });
            r = out;
          }
          cli.print(g, { ...r, jobId, cap: capLine(ctx, { engine: !ctx.dryRun }) }, (x) =>
            [`Batch ${x.batchKey}${x.phase ? ` (${x.phase})` : ''}: ${x.status}. ${x.reason}${x.jobId ? ` (content job ${x.jobId})` : ''}`, ...x.items.map((i: { itemId: string; status: string; verdict?: string; error?: string; phase: string; draftId?: string }) => `  ${i.itemId} [${i.phase}] ${i.status}${i.draftId ? ` draft=${i.draftId}` : ''}${i.verdict ? ` verdict=${i.verdict}` : ''}${i.error ? ` (${i.error})` : ''}`), x.cap].join('\n'),
          );
          if (r.status === 'refused' || r.status === 'halted_after_pilot') process.exitCode = 1;
        });
      }),
    );

  content
    .command('review <draft-id>')
    .description('Run deterministic quality gates (+ bounded AI review with --use-model); --revise allows automated revision loops (max 2, needs --mode DRAFT)')
    .option('--use-model', 'allow the reasoning model for AI review/revisions (spends money; shows the cap)')
    .option('--revise', 'run automated revisions while the verdict is needs_revision (max 2 total)')
    .action(
      cli.action(async (draftId: string, opts: { useModel?: boolean; revise?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps) => {
          const m = modelFlag(ctx, opts.useModel);
          if (opts.revise && !m.useModel) throw new AppError('POLICY_DENIED', `Revisions call the model: add --use-model. ${capLine(ctx)}`);
          const draft = getDraft(ctx.db, ctx.siteId, draftId);
          if (!draft) throw new AppError('NOT_FOUND', `Draft ${draftId} not found`);
          // Superseded, rejected, exported, or published drafts are only previewed (--dry-run); a review never changes their state.
          const refusal = reviewRefusal(ctx, draft);
          if (refusal && !ctx.dryRun) throw new AppError('CONFLICT', refusal, { hint: `Preview the checks without changing state: npm run cli -- content review ${draftId} --dry-run` });
          let final: QualityReviewResult;
          let finalDraftId = draftId;
          let revisions = 0;
          let jobId: string | null = null;
          let revisionNeedsReview: { reason: string } | null = null;
          if (ctx.dryRun) {
            // Preview only: nothing persisted, no model call.
            const r = await reviewWithRevisions(ctx, deps, draftId, { useModel: m.useModel, revise: !!opts.revise, preview: true });
            final = r.reviews[r.reviews.length - 1]!;
          } else {
            // Durable path (same as `content produce`): a review-only content job with the review stage allowance.
            const run = await runContentProductionJob(ctx, { draftId, useModel: m.useModel, stages: ['quality_review'], review: { useModel: m.useModel, revise: !!opts.revise } });
            throwIfJobFailed(run);
            jobId = run.jobId;
            const out = run.outputs.quality_review as { finalDraftId: string | null; revisions: number; modelReview: { reason: string } | null } | undefined;
            finalDraftId = out?.finalDraftId ?? draftId;
            revisions = out?.revisions ?? 0;
            revisionNeedsReview = out?.modelReview ?? null;
            const stored = storedReviewResult(ctx, finalDraftId);
            if (!stored) throw new AppError('INTERNAL', `Content job ${run.jobId} finished without a stored quality review for draft ${finalDraftId}.`, { details: { jobId: run.jobId } });
            final = stored;
          }
          const finalDraft = getDraft(ctx.db, ctx.siteId, finalDraftId)!;
          const notes = renderContentNotes(ctx, deps);
          cli.print(g, { dryRun: ctx.dryRun, jobId, draftId: finalDraft.id, status: finalDraft.status, revisions, review: final, revisionNeedsReview, model: m.note, notes }, (x) =>
            [
              `${x.dryRun ? 'DRY RUN: ' : ''}Draft ${x.draftId} (${x.status}); automated revisions this run: ${x.revisions}${x.jobId ? ` (content job ${x.jobId})` : ''}`,
              ...renderReview(x.review),
              x.revisionNeedsReview ? `A revision's model output needs human review: ${x.revisionNeedsReview.reason}` : '',
              x.model,
              `Notes: ${x.notes.detail}`,
            ]
              .filter(Boolean)
              .join('\n'),
          );
        });
      }),
    );

  content
    .command('bootstrap')
    .description('Low-data bootstrap: offer-page brief + one supporting-page brief + measurement/technical readiness checks')
    .option('--force', 'run even when the site is not low-data')
    .option('--use-model', 'allow the reasoning model for brief synthesis (spends money; shows the cap)')
    .action(
      cli.action(async (opts: { force?: boolean; useModel?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps) => {
          const m = modelFlag(ctx, opts.useModel);
          const r = await runLowDataBootstrap(ctx, deps, { force: !!opts.force, useModel: m.useModel });
          cli.print(g, { ...r, model: m.note }, (x) =>
            [
              `Low-data: ${x.lowData.status === 'unknown' ? 'UNKNOWN' : x.lowData.isLowData ? 'YES' : 'no'} (${x.lowData.reason})`,
              x.skipped ? `Skipped: ${x.skipped}` : '',
              '',
              'Readiness checks:',
              ...x.readiness.map((c: { status: string; area: string; id: string; detail: string; nextStep: string | null }) => `  ${c.status.toUpperCase().padEnd(7)} ${c.area}/${c.id}: ${c.detail}${c.nextStep ? ` Next: ${c.nextStep}` : ''}`),
              '',
              x.offerPage ? pageLine('Offer-page', x.offerPage) : '',
              x.supportingPage.itemId ? pageLine('Supporting-page', x.supportingPage as BootstrapPage) : `Supporting page: none (${(x.supportingPage as { reason: string }).reason})`,
              '',
              x.conversionHistory,
              x.model,
            ]
              .filter((l) => l !== null)
              .join('\n'),
          );
        });
      }),
    );

  content
    .command('mark-reviewed <draft-id>')
    .description('Record that a named human reviewed and accepts this exact draft body (needs --as and --confirm <body-hash-prefix>); publication still needs an approval')
    .requiredOption('--as <name>', 'reviewer name (recorded in the audit log)')
    .requiredOption('--confirm <hash-prefix>', 'first 8+ characters of the draft body hash you reviewed')
    .option('--note <text>', 'review note')
    .action(
      cli.action(async (draftId: string, opts: { as: string; confirm: string; note?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps) => {
          const r = markHumanReviewed(ctx, draftId, { reviewer: opts.as, confirmHashPrefix: opts.confirm, ...(opts.note ? { note: opts.note } : {}) });
          const notes = renderContentNotes(ctx, deps);
          cli.print(g, { ...r, notes }, (x) => [`Draft ${x.draftId} accepted by ${x.reviewer} (status ${x.status}).`, `Next: npm run cli -- approvals request draft ${x.draftId}   (then approvals approve, then export draft ${x.draftId} --mode EXECUTE)`, `Notes: ${x.notes.detail}`].join('\n'));
        });
      }),
    );

  content
    .command('revise-manual <draft-id>')
    .description('Record a human-edited body as a new draft version (needs --mode DRAFT; no model call): [[UNVERIFIED: ...]] markers are recounted, the deterministic quality gates re-run, and every removed marker needs a resolution with a source (--resolutions)')
    .requiredOption('--body-file <file>', 'Markdown file with the complete edited body (stored exactly as written)')
    .requiredOption('--as <name>', 'author name (recorded on the draft version and in the audit log)')
    .option('--resolutions <file>', 'JSON array, one entry per removed marker: [{"marker", "action": "confirmed"|"removed", "source", "statement"?, "note"?}]')
    .option('--note <text>', 'revision note')
    .action(
      cli.action(async (draftId: string, opts: { bodyFile: string; as: string; resolutions?: string; note?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps) => {
          if (!ctx.dryRun) refuseWhileJobHoldsContentLocks(ctx, 'content revise-manual');
          const body = readBodyFile(opts.bodyFile);
          let resolutions: FactResolutionInput[] = [];
          if (opts.resolutions) {
            const parsed = factResolutionsFileSchema.safeParse(readJsonFile(opts.resolutions));
            if (!parsed.success) {
              const errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
              throw new AppError('VALIDATION_FAILED', `${opts.resolutions}: invalid fact resolutions; expected a JSON array of {"marker", "action": "confirmed"|"removed", "source", "statement"?, "note"?}.`, { details: { errors } });
            }
            resolutions = parsed.data;
          }
          const r = reviseDraftManually(ctx, draftId, { body, reviewer: opts.as, resolutions, ...(opts.note ? { note: opts.note } : {}) });
          const notes: ContentNotesResult = r.draft ? renderContentNotes(ctx, deps) : { written: false, detail: 'dry run: nothing stored, notes not written', paths: [] };
          const result = {
            dryRun: r.preview,
            previousDraftId: r.previousDraftId,
            draftId: r.draft?.id ?? null,
            version: r.draft?.version ?? null,
            status: r.draft?.status ?? null,
            bodyHash: r.bodyHash,
            author: r.reviewer,
            markersBefore: r.markersBefore.length,
            markersAfter: r.markersAfter.length,
            removedMarkers: r.removedMarkers,
            addedMarkers: r.addedMarkers,
            resolutions: r.resolutions,
            unresolvedFacts: r.pkg.unresolvedFacts,
            review: r.review,
            warnings: r.warnings,
            notes,
          };
          cli.print(g, result, (x) =>
            [
              x.dryRun
                ? `DRY RUN: human revision of draft ${x.previousDraftId} is valid; nothing was stored.`
                : `Draft ${x.draftId} v${x.version} (${x.status}) recorded: human revision by ${x.author} of draft ${x.previousDraftId}; body hash ${x.bodyHash.slice(0, 16)}.`,
              `Unresolved facts: ${x.markersBefore} before, ${x.markersAfter} after${x.addedMarkers.length ? ` (${x.addedMarkers.length} added)` : ''}.`,
              ...x.resolutions.map((f: { action: string; statement: string; source: string; sourceKind: string }) => `  - ${f.action}: "${f.statement}" (source: ${f.source}; ${f.sourceKind})`),
              ...x.warnings.map((w: string) => `  warning: ${w}`),
              ...renderReview(x.review),
              x.dryRun
                ? `Record it: re-run without --dry-run and with --mode DRAFT.`
                : x.status === 'rejected'
                  ? 'The quality gate rejected this version (a reject verdict is final); the item is rejected.'
                  : x.review.reasons.some((q: { consequence: string }) => q.consequence === 'revise' || q.consequence === 'reject')
                    ? `Next: fix the findings above in another human revision (\`content revise-manual ${x.draftId} ...\`), or reject the item.`
                    : x.markersAfter > 0
                      ? `Publication stays blocked until every [[UNVERIFIED: ...]] marker is resolved: edit again with \`content revise-manual ${x.draftId} ...\`.`
                      : `Next: read the draft, then npm run cli -- content mark-reviewed ${x.draftId} --as "<name>" --confirm ${x.bodyHash.slice(0, 12)}`,
              `Notes: ${x.notes.detail}`,
            ]
              .filter(Boolean)
              .join('\n'),
          );
          if (r.review.verdict === 'reject') process.exitCode = 1;
        });
      }),
    );

  content
    .command('publish-check <draft-id>')
    .description('Show content-side publication blockers for a draft (human review, unresolved facts, synthetic data, verdict, approval, EXECUTE mode)')
    .action(
      cli.action(async (draftId: string, _o: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx, deps) => {
          const gate = checkPublicationGate(ctx, deps, draftId);
          cli.print(g, gate, (x) =>
            [
              `Publication ${x.allowed ? 'ALLOWED' : 'BLOCKED'} for draft ${x.draftId}:`,
              ...(x.allowed ? allowedLines(x) : []),
              ...x.blockers.map((b: string) => `  - ${b}`),
              ...x.notes.map((n: string) => `  note: ${n}`),
              x.binding ? `Approval binding: ${x.binding.actionType} on ${x.binding.targetUrl ?? 'target'} (change hash ${x.binding.artifactHash.slice(0, 16)}, from the approvals workflow).` : '',
              x.note,
              `Approval workflow: npm run cli -- approvals request draft ${x.draftId}; npm run cli -- approvals approve <id>; npm run cli -- export draft ${x.draftId} --mode EXECUTE (manual export; nothing is auto-published).`,
              EXPORT_ENFORCES,
            ]
              .filter(Boolean)
              .join('\n'),
          );
          if (!gate.allowed) process.exitCode = 1;
        });
      }),
    );

  content
    .command('measure')
    .description('Move published items to measuring and report observational Search Console metrics since the recorded implementation date')
    .action(
      cli.action(async (_o: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        await withContext(cli, g, async (ctx) => {
          if (ctx.dryRun) throw new AppError('POLICY_DENIED', 'measure updates item stages; run without --dry-run');
          const rows = measurePublishedContent(ctx);
          cli.print(g, rows, (rs: typeof rows) =>
            rs.length
              ? rs.map((r) => `${r.itemId} ${r.url} since ${r.window.start}: clicks ${formatMeasured(r.clicks)}, impressions ${formatMeasured(r.impressions)}. ${r.note}`).join('\n')
              : 'No recorded publications for content drafts. After a human publishes an approved draft, record it: `npm run cli -- experiments mark-implemented <draft-id> --subject-type draft --at <when it went live, ISO-8601 with zone> --revision <CMS/source revision> --url <live URL>`.',
          );
        });
      }),
    );

}
