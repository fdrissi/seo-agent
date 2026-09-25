import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { formatUsd, toMicros } from '../../core/money.js';
import { resolveApprover, ownerActor } from '../../approvals/approver.js';
import { requestBudgetException } from '../../approvals/budget-approvals.js';
import { applyDecisionEffects } from '../../approvals/effects.js';
import { approvalCaveats, forTerminal, hasUnsafeTerminalChars, isDemoSite, SYNTHETIC_DEMO_BANNER } from '../../approvals/display.js';
import { defaultTargetChecker } from '../../approvals/export.js';
import { isProductionActionType } from '../../approvals/policy.js';
import { requestApprovalForSubject } from '../../approvals/requests.js';
import { APPROVAL_STATUSES, ApprovalService, MIN_CONFIRM_PREFIX_LENGTH, type ApprovalDetail } from '../../approvals/service.js';
import type { ApprovalStatus } from '../../approvals/types.js';
import { BUDGET_PROVIDERS, type BudgetProvider } from '../../budgets/types.js';
import type { CliRuntime } from '../runtime.js';

/**
 * Approval commands. Approvals are decided ONLY here, by a named human
 * (--as <name>, default: the OS user unless it is a service account) who
 * types the artifact-hash prefix shown by `approvals show`. Nothing in the
 * vault, model output, or scraped content can create or decide an approval.
 * The name is asserted, not authenticated: obvious automation and account
 * names are refused (src/approvals/approver.ts), nothing more.
 *
 * Review surface: `approvals show` and `approvals approve` print the FULL
 * exact change (never truncated) and the hash; `approve` prints it even when
 * --confirm is given. Other commands never print the confirmation prefix, so
 * typing it means the approver looked at the review output. All text is
 * rendered terminal-safe (control, ANSI, and bidi characters become visible
 * markers).
 */

function renderRow(a: ApprovalDetail): string {
  return forTerminal(`${a.id}  ${a.status.padEnd(11)} ${a.actionType.padEnd(18)} ${`${a.subjectType}:${a.subjectId}`.padEnd(40)} expires ${a.expiresAt}`);
}

function indent(text: string, pad: string): string[] {
  return forTerminal(text)
    .split('\n')
    .map((l) => `${pad}${l}`);
}

function pct(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : 'n/a';
}

/** The measured result behind a learning promotion (result, effect, windows) and any statement flags. */
function renderLearningEvidence(payload: Record<string, unknown>): string[] {
  const s = (payload.evidenceSummary ?? null) as Record<string, unknown> | null;
  const lines = ['Measured evidence:'];
  if (!s) lines.push('  NONE RECORDED: this learning carries no evaluation result, effect, or windows. Do not approve it without evidence.');
  else {
    const w = (s.windows ?? null) as { baseline?: string | null; observation?: string | null; source?: string | null } | null;
    lines.push(
      `  evaluation:  ${forTerminal(String(s.evaluationId ?? 'n/a'))} result ${forTerminal(String(s.result ?? 'n/a'))}${s.concluded === true ? ' (concluded)' : s.concluded === false ? ' (NOT concluded)' : ''}${s.isSynthetic ? ' [SYNTHETIC]' : ''}`,
      `  primary:     ${forTerminal(String(s.metric ?? 'n/a'))} verdict ${forTerminal(String(s.verdict ?? 'n/a'))}; effect ${pct(s.effect)} (treated page alone ${pct(s.treatedChange)}${typeof s.comparisonPages === 'number' ? `, ${s.comparisonPages} comparison page(s)` : ', no comparison pages'})`,
      `  windows:     ${w ? `${w.source ?? ''} baseline ${w.baseline ?? 'n/a'} vs observation ${w.observation ?? 'n/a'}` : 'n/a'}`,
      '  Observational before/after comparison; not proof of causality, no significance test.',
    );
  }
  const flags = Array.isArray(payload.statementFlags) ? payload.statementFlags.filter((f): f is string => typeof f === 'string') : [];
  if (flags.length) lines.push('Statement flags (the statement does not match the recorded effect):', ...flags.map((f) => `  - ${forTerminal(f)}`));
  return lines;
}

export function renderApproval(a: ApprovalDetail, history: Array<{ at: string; actor: string; eventType: string }> = []): string {
  const unbound = a.sourceRevision === null && isProductionActionType(a.actionType);
  const lines = [
    `Approval ${a.id} [${a.status}]`,
    `  action:           ${a.actionType}`,
    `  target:           ${forTerminal(a.target)}`,
    `  subject:          ${forTerminal(`${a.subjectType} ${a.subjectId}`)}`,
    `  artifact hash:    ${a.artifactHash}`,
    `  confirm prefix:   ${a.hashPrefix}`,
    `  source revision:  ${a.sourceRevision ? forTerminal(a.sourceRevision) : unbound ? 'NOT BOUND: a later site change will not invalidate this approval (approving needs --accept-unbound-revision)' : '(not bound)'}`,
    `  requested:        ${a.requestedAt} by ${forTerminal(a.requestedBy)}`,
    `  expires:          ${a.expiresAt}`,
    a.approver ? `  decided:          ${a.decidedAt} by ${forTerminal(a.approver)}${a.decisionNote ? ` (${forTerminal(a.decisionNote)})` : ''}` : null,
    a.executedAt ? `  executed:         ${a.executedAt} (one-time; cannot be reused)` : null,
    a.invalidatedReason ? `  invalidated:      ${forTerminal(a.invalidatedReason)}` : null,
    '',
    'Summary:',
    ...indent(a.summary, '  '),
    ...approvalCaveats(a).flatMap((c) => ['', `NOTE: ${c}`]),
  ].filter((l): l is string => l !== null);
  const payload = a.payload ?? {};
  let unsafe = hasUnsafeTerminalChars(a.summary);
  if (payload.change && typeof payload.change === 'object') {
    lines.push('', 'Exact change (complete):');
    for (const [k, v] of Object.entries(payload.change as Record<string, unknown>)) {
      const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      unsafe = unsafe || hasUnsafeTerminalChars(text);
      if (text.includes('\n')) lines.push(`  ${k}:`, ...indent(text, '    | '));
      else lines.push(`  ${k}: ${forTerminal(text)}`);
    }
  }
  if (a.actionType === 'learning_promotion') lines.push('', ...renderLearningEvidence(payload));
  if (unsafe) lines.push('', 'WARNING: the text contains control, escape, or invisible characters, shown above as [U+XXXX] markers. They are part of the exact proposal.');
  if (history.length) {
    lines.push('', 'History:');
    for (const h of history) lines.push(`  ${h.at}  ${h.eventType}  ${forTerminal(h.actor)}`);
  }
  return lines.join('\n');
}

export function register(program: Command, cli: CliRuntime): void {
  const cmd = program.command('approvals').description('Human approvals bound to exact proposals (list, show, request, approve, reject)');

  cmd
    .command('list')
    .description('List approvals (default: pending and approved)')
    .option('--status <status...>', `filter by status (${APPROVAL_STATUSES.join(', ')})`)
    .option('--all', 'include every status')
    .option('--subject <type:id>', 'only approvals for one subject, e.g. experiment:exp_123')
    .action(
      cli.action(async (opts: { status?: string[]; all?: boolean; subject?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          for (const s of opts.status ?? []) if (!APPROVAL_STATUSES.includes(s as ApprovalStatus)) throw new AppError('VALIDATION_FAILED', `Unknown status "${s}".`);
          const statuses = opts.all ? undefined : ((opts.status as ApprovalStatus[] | undefined) ?? ['pending', 'approved']);
          const [subjectType, ...rest] = (opts.subject ?? '').split(':');
          const list = gate.list(ctx.siteId, {
            ...(statuses ? { statuses } : {}),
            ...(opts.subject ? { subjectType: subjectType!, subjectId: rest.join(':') } : {}),
          });
          const demo = isDemoSite(ctx);
          cli.print(g, { siteId: ctx.siteId, synthetic: demo, ...(demo ? { banner: SYNTHETIC_DEMO_BANNER } : {}), approvals: list }, (r) =>
            [demo ? SYNTHETIC_DEMO_BANNER : null, r.approvals.length ? r.approvals.map(renderRow).join('\n') : 'No approvals match.'].filter((l): l is string => l !== null).join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('show <id>')
    .description('Show an approval: binding, exact change, hash, and history')
    .action(
      cli.action(async (id: string, _o: unknown, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const detail = gate.detail(ctx.siteId, id);
          const history = gate.history(ctx.siteId, id);
          cli.print(g, { approval: detail, history, caveats: approvalCaveats(detail) }, (r) => renderApproval(r.approval, r.history));
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('request <subject-type> <id>')
    .description('Request approval for the exact current proposal of a draft, recommendation, experiment, or learning (grants nothing by itself)')
    .option('--revision <rev>', 'source revision the proposal was reviewed against (bound into the approval)')
    .option('--ttl-hours <n>', 'expiry in hours (default 168, max 720)', (v) => Number(v))
    .option('--as <name>', 'who is requesting (default: OS user unless it is a service account; recorded as asserted, not authenticated)')
    .action(
      cli.action(async (subjectType: string, id: string, opts: { revision?: string; ttlHours?: number; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const who = resolveApprover(opts.as);
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          if (g.dryRun) {
            cli.print(g, { dryRun: true, subjectType, id, note: 'No approval request was created.' }, () => `Dry run: would request approval for ${subjectType} ${id}.`);
            return;
          }
          const r = await requestApprovalForSubject(
            ctx,
            gate,
            { subjectType, subjectId: id, requestedBy: ownerActor(who), sourceRevision: opts.revision ?? null, ...(opts.ttlHours ? { ttlHours: opts.ttlHours } : {}) },
            subjectType === 'learning' ? {} : { targetChecker: defaultTargetChecker(ctx) },
          );
          cli.print(g, r, (x) =>
            [
              forTerminal(`Approval ${x.approval.id} is ${x.approval.status} for ${x.approval.actionType} on ${x.approval.target}.`),
              ...x.warnings.map((w: string) => forTerminal(`Warning: ${w}`)),
              '',
              `Review:  npm run cli -- approvals show ${x.approval.id}   (prints the exact change and the confirmation prefix)`,
              `Approve: npm run cli -- approvals approve ${x.approval.id} --as "<your name>" --confirm <prefix from approvals show>`,
            ].join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('approve <id>')
    .description('Approve a pending request as a named human; requires typing the artifact-hash prefix shown by `approvals show`')
    .option('--as <name>', 'your name (default: OS user unless it is a service account such as node or runner); recorded as asserted, not authenticated; obvious automation or account names are refused')
    .option('--confirm <hash-prefix>', `first ${MIN_CONFIRM_PREFIX_LENGTH}+ characters of the artifact hash, typed to confirm you reviewed this exact proposal`)
    .option('--note <text>', 'optional decision note')
    .option('--accept-unbound-revision', 'approve a production change that is not bound to a source revision (recorded)')
    .action(
      cli.action(async (id: string, opts: { as?: string; confirm?: string; note?: string; acceptUnboundRevision?: boolean }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const approver = resolveApprover(opts.as);
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const detail = gate.detail(ctx.siteId, id);
          // Always show what is being approved, also when --confirm was typed.
          if (!g.json) cli.io.out(`${renderApproval(detail)}\n`);
          if (!opts.confirm) {
            throw new AppError('VALIDATION_FAILED', `Not approved: confirmation required for approval ${id}.`, {
              details: { approvalId: id, artifactHash: detail.artifactHash, status: detail.status },
              hint: `Review the exact change above, then run: approvals approve ${id} --as "${approver}" --confirm <at least ${MIN_CONFIRM_PREFIX_LENGTH} characters of the artifact hash shown above>`,
            });
          }
          if (g.dryRun) {
            cli.print(g, { dryRun: true, approval: detail, caveats: approvalCaveats(detail) }, () =>
              [forTerminal(`Dry run: ${approver} would approve ${id} (${detail.actionType} on ${detail.target}). Nothing was changed.`), ...approvalCaveats(detail).map((c) => `NOTE: ${c}`)].join('\n'),
            );
            return;
          }
          const rec = gate.approve(ctx.siteId, id, { approver, confirmHashPrefix: opts.confirm, note: opts.note ?? null, acknowledgeUnboundRevision: !!opts.acceptUnboundRevision });
          const effects = applyDecisionEffects(ctx.db, ctx.clock, rec, ownerActor(approver));
          const approved = gate.detail(ctx.siteId, id);
          cli.print(g, { approval: approved, effects, caveats: approvalCaveats(approved) }, (r) =>
            [
              forTerminal(`Approved ${r.approval.id} by ${r.approval.approver}: ${r.approval.actionType} on ${r.approval.target}.`),
              ...r.caveats.map((c: string) => `NOTE: ${c}`),
              forTerminal(
                `Bound to artifact ${r.approval.artifactHash}${r.approval.sourceRevision ? ` at revision ${r.approval.sourceRevision}` : isProductionActionType(r.approval.actionType) ? ' (NOT bound to a source revision; accepted explicitly)' : ''}; one-time; expires ${r.approval.expiresAt}.`,
              ),
              ...r.effects.map((e: string) => forTerminal(e)),
              isProductionActionType(r.approval.actionType)
                ? `Nothing was changed in production. The export runs only with --mode EXECUTE and rechecks the target first: npm run cli -- export ${r.approval.subjectType} ${r.approval.subjectId} --mode EXECUTE`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('reject <id>')
    .description('Reject a pending request as a named human')
    .requiredOption('--reason <text>', 'why the proposal is rejected (recorded)')
    .option('--as <name>', 'your name (default: OS user unless it is a service account such as node or runner); recorded as asserted, not authenticated; obvious automation or account names are refused')
    .action(
      cli.action(async (id: string, opts: { reason: string; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const approver = resolveApprover(opts.as);
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          if (g.dryRun) {
            const d = gate.detail(ctx.siteId, id);
            cli.print(g, { dryRun: true, approval: d }, () => `Dry run: ${approver} would reject ${id}. Nothing was changed.`);
            return;
          }
          const rec = gate.reject(ctx.siteId, id, { approver, reason: opts.reason });
          const effects = applyDecisionEffects(ctx.db, ctx.clock, rec, ownerActor(approver));
          cli.print(g, { approval: gate.detail(ctx.siteId, id), effects }, (r) => [`Rejected ${r.approval.id} by ${r.approval.approver}: ${opts.reason}`, ...r.effects].map((l: string) => forTerminal(l)).join('\n'));
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('request-budget-exception')
    .description('Request a one-time, bounded exception to a configured budget cap (decided with `approvals approve`)')
    .requiredOption('--provider <provider>', `${BUDGET_PROVIDERS.join(', ')} or combined`)
    .requiredOption('--period <key>', 'budget period: YYYY-MM (month) or YYYY-Www (ISO week)')
    .requiredOption('--amount-usd <amount>', 'extra amount above the cap, decimal USD (e.g. "2.50")')
    .requiredOption('--reason <text>', 'why the exception is needed')
    .option('--as <name>', 'who is requesting (default: OS user unless it is a service account; recorded as asserted, not authenticated)')
    .action(
      cli.action(async (opts: { provider: string; period: string; amountUsd: string; reason: string; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          if (opts.provider !== 'combined' && !BUDGET_PROVIDERS.includes(opts.provider as BudgetProvider)) throw new AppError('VALIDATION_FAILED', `Unknown provider "${opts.provider}".`);
          const who = resolveApprover(opts.as);
          const extra = toMicros(opts.amountUsd);
          if (g.dryRun) {
            cli.print(g, { dryRun: true }, () => `Dry run: would request a +${formatUsd(extra)} exception for ${opts.provider} in ${opts.period}.`);
            return;
          }
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const a = requestBudgetException(gate, { siteId: ctx.siteId, provider: opts.provider as BudgetProvider | 'combined', period: opts.period, extraMicros: extra, reason: opts.reason, requestedBy: ownerActor(who) });
          const d = gate.detail(ctx.siteId, a.id);
          cli.print(g, { approval: d, caveats: approvalCaveats(d) }, (r) =>
            [
              forTerminal(`Budget exception request ${r.approval.id} is ${r.approval.status}: ${r.approval.summary}`),
              `Review: npm run cli -- approvals show ${r.approval.id}; approve: npm run cli -- approvals approve ${r.approval.id} --as "<your name>" --confirm <prefix from approvals show>`,
              ...r.caveats.map((c: string) => `NOTE: ${c}`),
            ].join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );
}
