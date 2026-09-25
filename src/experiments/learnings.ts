import type { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { hashObject } from '../core/hash.js';
import { newId } from '../core/ids.js';
import { recordAudit } from '../database/audit.js';
import { parseJson, type Db } from '../database/db.js';
import type { ApprovalGate, ApprovalRecord } from '../approvals/types.js';

/**
 * Learnings are PROPOSED with evidence and an explicit, bounded scope. They
 * stay `proposed` until a human approves a `learning_promotion` approval via
 * the CLI. Nothing here turns a result into a universal SEO rule: universal
 * scopes are refused, and approval promotes only the stated scope.
 */

export interface LearningRecord {
  id: string;
  siteId: string;
  statement: string;
  scope: string;
  evidence: unknown;
  experimentId: string | null;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LearningRow {
  id: string;
  site_id: string;
  statement: string;
  scope: string;
  evidence_json: string;
  experiment_id: string | null;
  status: LearningRecord['status'];
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: LearningRow): LearningRecord => ({
  id: r.id,
  siteId: r.site_id,
  statement: r.statement,
  scope: r.scope,
  evidence: parseJson(r.evidence_json, null),
  experimentId: r.experiment_id,
  status: r.status,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const UNIVERSAL_SCOPE = /^\s*(\*|(all|any|every|everything|everywhere|universal|global|always|general|seo in general)\b)|\b(all|every|any) (sites|websites|domains)\b/i;

export function validateLearningScope(scope: string): string {
  const s = (scope ?? '').trim();
  if (!s) throw new AppError('VALIDATION_FAILED', 'A learning needs an explicit scope (for example "site:<id>; page type: article; change: title rewrite").');
  if (UNIVERSAL_SCOPE.test(s)) {
    throw new AppError('VALIDATION_FAILED', `Scope "${s}" is universal. Learnings are observational and must stay scoped to where they were observed.`);
  }
  return s;
}

export function learningHash(l: { statement: string; scope: string; evidence: unknown }): string {
  return hashObject({ statement: l.statement.trim(), scope: l.scope.trim(), evidence: l.evidence });
}

export function getLearning(db: Db, siteId: string, id: string): LearningRecord {
  const r = db.get<LearningRow>('SELECT * FROM learnings WHERE site_id = ? AND id = ?', [siteId, id]);
  if (!r) throw new AppError('NOT_FOUND', `Learning ${id} not found for site ${siteId}.`);
  return toRecord(r);
}

export function listLearnings(db: Db, siteId: string, status?: LearningRecord['status']): LearningRecord[] {
  return (
    status
      ? db.all<LearningRow>('SELECT * FROM learnings WHERE site_id = ? AND status = ? ORDER BY created_at DESC', [siteId, status])
      : db.all<LearningRow>('SELECT * FROM learnings WHERE site_id = ? ORDER BY created_at DESC', [siteId])
  ).map(toRecord);
}

export function proposeLearning(
  db: Db,
  clock: Clock,
  gate: ApprovalGate,
  input: { siteId: string; statement: string; scope: string; evidence: unknown; experimentId?: string | null; requestedBy: string },
): { learning: LearningRecord; approval: ApprovalRecord } {
  const statement = (input.statement ?? '').trim();
  if (!statement) throw new AppError('VALIDATION_FAILED', 'A learning needs a statement.');
  const scope = validateLearningScope(input.scope);
  const ev = input.evidence;
  const empty = ev === null || ev === undefined || (Array.isArray(ev) && ev.length === 0) || (typeof ev === 'object' && !Array.isArray(ev) && Object.keys(ev as object).length === 0);
  if (empty) throw new AppError('VALIDATION_FAILED', 'A learning needs supporting evidence (for example experiment evaluation ids and measured values).');
  const now = clock.now().toISOString();
  const id = newId('lrn');
  const summary = learningEvidenceSummary(ev);
  const statementFlags = summary ? checkStatementAgainstEffect(statement, summary) : [];
  return db.transaction(() => {
    db.run(
      `INSERT INTO learnings (id, site_id, statement, scope, evidence_json, experiment_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
      [id, input.siteId, statement, scope, JSON.stringify(ev), input.experimentId ?? null, now, now],
    );
    recordAudit(db, {
      siteId: input.siteId,
      actor: input.requestedBy,
      eventType: 'learning.proposed',
      subjectType: 'learning',
      subjectId: id,
      details: { scope, experimentId: input.experimentId ?? null, ...(statementFlags.length ? { statementFlags } : {}) },
      at: clock.now(),
    });
    const approval = gate.request({
      siteId: input.siteId,
      actionType: 'learning_promotion',
      target: `learning:${id}`,
      subjectType: 'learning',
      subjectId: id,
      artifactHash: learningHash({ statement, scope, evidence: ev }),
      summary: `Promote learning (scope: ${scope}): ${statement}`.slice(0, 500),
      payload: learningApprovalPayload({ statement, scope, experimentId: input.experimentId ?? null, evidence: ev }),
      requestedBy: input.requestedBy,
    });
    return { learning: getLearning(db, input.siteId, id), approval };
  });
}

// ------------------------------------------------------------------ evidence rules (A7-05)

/** What the approver sees about the measured result behind a learning. */
export interface LearningEvidenceSummary {
  evaluationId: string | null;
  /** Evaluation result: positive | negative | inconclusive | collecting | data_unavailable. */
  result: string | null;
  concluded: boolean | null;
  metric: string | null;
  verdict: string | null;
  /** Direction-adjusted relative effect (positive = better), e.g. 0.12 = +12%. */
  effect: number | null;
  /** Direction-adjusted relative change of the treated page alone. */
  treatedChange: number | null;
  comparisonPages: number | null;
  windows: { baseline: string | null; observation: string | null; source: string | null } | null;
  isSynthetic: boolean;
}

const UNUSABLE_VERDICTS = new Set(['insufficient_data', 'data_unavailable']);

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function windowSpan(w: unknown): { baseline: string | null; observation: string | null } | null {
  if (!w || typeof w !== 'object') return null;
  const win = w as { ok?: unknown; windows?: { baseline?: { start?: unknown; end?: unknown }; observation?: { start?: unknown; end?: unknown } } };
  if (win.ok !== true || !win.windows) return null;
  const span = (x: { start?: unknown; end?: unknown } | undefined) => (x && typeof x.start === 'string' && typeof x.end === 'string' ? `${x.start}..${x.end}` : null);
  return { baseline: span(win.windows.baseline), observation: span(win.windows.observation) };
}

/** Extract the measured result from learning evidence (the evaluation-based shapes used by the CLI and the evaluator). */
export function learningEvidenceSummary(evidence: unknown): LearningEvidenceSummary | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const e = evidence as Record<string, unknown>;
  const primary = (e.primary ?? null) as Record<string, unknown> | null;
  const treated = (x: unknown) => (x && typeof x === 'object' ? num((x as { improvement?: unknown }).improvement) : null);
  const pages = (x: unknown) => (x && typeof x === 'object' ? num((x as { pages?: unknown }).pages) : null);
  const metric = typeof e.metric === 'string' ? e.metric : primary && typeof primary.metric === 'string' ? primary.metric : null;
  if (!metric && typeof e.evaluationResult !== 'string' && typeof e.result !== 'string') return null;
  const windows = (e.windows ?? null) as Record<string, unknown> | null;
  const source = typeof e.windowSource === 'string' ? e.windowSource : metric && /session|key|revenue|engaged/i.test(metric) ? 'ga4' : 'gsc';
  const span = windows ? windowSpan(windows[source]) : null;
  return {
    evaluationId: typeof e.evaluationId === 'string' ? e.evaluationId : null,
    result: typeof e.evaluationResult === 'string' ? e.evaluationResult : typeof e.result === 'string' ? e.result : null,
    concluded: typeof e.concluded === 'boolean' ? e.concluded : null,
    metric,
    verdict: primary && typeof primary.verdict === 'string' ? primary.verdict : typeof e.verdict === 'string' ? e.verdict : null,
    effect: num(e.effect) ?? (primary ? num(primary.effect) : null),
    treatedChange: treated(e.treated) ?? (primary ? treated(primary.treated) : null),
    comparisonPages: pages(e.control) ?? (primary ? pages(primary.control) : null),
    windows: span ? { ...span, source } : null,
    isSynthetic: e.isSynthetic === true,
  };
}

const UP = /\b(increase[sd]?|increasing|improve[sd]?|improving|improvement|rais(e|es|ed|ing)|rise[sn]?|rose|gain(s|ed)?|grow(s|n|th)?|grew|boost(s|ed)?|lift(s|ed)?|higher|more|better|up)\b/i;
const DOWN = /\b(decrease[sd]?|decreasing|declin(e|es|ed|ing)|drop(s|ped)?|fall(s|en)?|fell|lower(ed)?|less|fewer|worse|worsen(ed|s)?|reduc(e|es|ed|tion)|loss|lost|hurt(s)?|down|deteriorat(e|ed|ion))\b/i;
const CAUSAL = /\b(caus(e|es|ed|ing)|prove[sn]?|proof|guarantee[sd]?|always|significant(ly)?)\b/i;

/**
 * Flags where a free-text learning statement does not match the recorded
 * effect: a claimed direction opposite to the measured one, a claimed size
 * far from it, a directional claim about "no meaningful change", or causal /
 * significance language (the method is observational and untested).
 */
export function checkStatementAgainstEffect(statement: string, s: LearningEvidenceSummary): string[] {
  const flags: string[] = [];
  const text = statement.toLowerCase();
  const effect = s.effect;
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const ups = UP.test(text);
  const downs = DOWN.test(text);
  // Average position improves when it goes down; only better/worse words are unambiguous for it.
  const positionMetric = s.metric === 'position';
  const claimsUp = positionMetric ? /\b(improve[sd]?|improving|improvement|better)\b/i.test(text) : ups && !downs;
  const claimsDown = positionMetric ? /\b(worse|worsen(ed|s)?|deteriorat(e|ed|ion))\b/i.test(text) : downs && !ups;
  if (effect === null) {
    if (claimsUp || claimsDown) flags.push('The statement claims a direction, but no effect was measured for the primary metric.');
  } else {
    if (claimsUp && effect < 0) flags.push(`The statement claims an increase/improvement, but the recorded effect is ${pct(effect)} (worse).`);
    if (claimsDown && effect > 0) flags.push(`The statement claims a decrease/deterioration, but the recorded effect is ${pct(effect)} (better).`);
    if (s.verdict === 'no_meaningful_change' && (claimsUp || claimsDown)) flags.push(`The statement claims a directional change, but the verdict was no meaningful change (effect ${pct(effect)}, within the threshold).`);
    const sizes = [...statement.matchAll(/([+-]?\d+(?:\.\d+)?)\s*%/g)].map((m) => Math.abs(Number(m[1])) / 100).filter((v) => Number.isFinite(v));
    const candidates = [Math.abs(effect), ...(s.treatedChange !== null ? [Math.abs(s.treatedChange)] : [])];
    for (const claimed of sizes) {
      const close = candidates.some((actual) => Math.abs(claimed - actual) <= Math.max(0.05, 0.5 * actual));
      if (!close) flags.push(`The statement claims ${(claimed * 100).toFixed(1)}%, but the recorded effect is ${pct(effect)}${s.treatedChange !== null ? ` (treated page alone ${pct(s.treatedChange)})` : ''}.`);
    }
  }
  // Disclaimers ("not proof of causality", "no significance test") are not claims.
  const claims = text.replace(/\b(not|no|never|without)\s+(?:[\p{L}-]+\s+){0,3}(proof|prove[sn]?|caus\w*|significan\w*|guarantee\w*)/giu, ' ');
  if (CAUSAL.test(claims)) flags.push('The statement uses causal or significance language; the evaluation is observational and no significance test is implemented.');
  return flags;
}

/** The approval payload of a learning promotion: statement, scope, the measured result, and statement flags. */
export function learningApprovalPayload(l: { statement: string; scope: string; experimentId: string | null; evidence: unknown }): Record<string, unknown> {
  const summary = learningEvidenceSummary(l.evidence);
  return {
    statement: l.statement,
    scope: l.scope,
    experimentId: l.experimentId,
    evidenceSummary: summary,
    statementFlags: summary ? checkStatementAgainstEffect(l.statement, summary) : ['The evidence carries no measured result (evaluation result, effect, windows); review it before approving.'],
  };
}

/**
 * Evidence for a learning proposed from an experiment (CLI propose-learning).
 * Requires a CONCLUDED evaluation (the one that set the experiment's outcome)
 * whose primary verdict(s) measured something: an insufficient_data or
 * data_unavailable primary verdict is not a result a learning can rest on.
 */
export function learningEvidenceFromExperiment(db: Db, siteId: string, experimentId: string): { evidence: Record<string, unknown>; summary: LearningEvidenceSummary } {
  const exp = db.get<{ id: string; status: string; primary_metric: string; outcome_kind: string }>('SELECT id, status, primary_metric, outcome_kind FROM experiments WHERE site_id = ? AND id = ?', [siteId, experimentId]);
  if (!exp) throw new AppError('NOT_FOUND', `Experiment ${experimentId} not found for site ${siteId}.`);
  const row = db.get<{ id: string; result: string; concluded: number; windows_json: string | null; seo_json: string | null; conversion_json: string | null; is_synthetic: number }>(
    'SELECT id, result, concluded, windows_json, seo_json, conversion_json, is_synthetic FROM experiment_evaluations WHERE site_id = ? AND experiment_id = ? AND concluded = 1 ORDER BY sequence DESC LIMIT 1',
    [siteId, experimentId],
  );
  if (!row) {
    throw new AppError('VALIDATION_FAILED', `Experiment ${experimentId} (${exp.status}) has no concluded evaluation; a learning needs a concluded, measured result.`, {
      hint: 'Wait until `experiments review` concludes the experiment. A "collecting" evaluation is not evidence.',
    });
  }
  type Assessment = { kind?: string; primary?: { metric?: string; verdict?: string; effect?: number | null; treated?: unknown; control?: unknown } };
  const assessments = [parseJson<Assessment | null>(row.seo_json, null), parseJson<Assessment | null>(row.conversion_json, null)].filter((a): a is Assessment => !!a?.primary);
  const usable = assessments.filter((a) => !UNUSABLE_VERDICTS.has(String(a.primary!.verdict)));
  if (!usable.length) {
    throw new AppError('VALIDATION_FAILED', `Experiment ${experimentId} concluded ${row.result} without a measured primary result (${assessments.map((a) => `${a.kind}: ${a.primary!.verdict}`).join(', ') || 'no assessment'}); a learning cannot rest on insufficient or unavailable data.`, {
      hint: 'Record the inconclusive outcome as it is; do not promote it to a learning.',
    });
  }
  const primaryMetric = exp.primary_metric;
  const main = usable.find((a) => a.primary!.metric === primaryMetric) ?? usable[0]!;
  const p = main.primary!;
  const evidence: Record<string, unknown> = {
    experimentId,
    experimentStatus: exp.status,
    evaluationId: row.id,
    evaluationResult: row.result,
    concluded: true,
    metric: p.metric ?? null,
    verdict: p.verdict ?? null,
    effect: typeof p.effect === 'number' ? p.effect : null,
    treated: p.treated ?? null,
    control: p.control ?? null,
    windowSource: main.kind === 'conversion' ? 'ga4' : 'gsc',
    windows: parseJson(row.windows_json, null),
    seo: parseJson(row.seo_json, null),
    conversion: parseJson(row.conversion_json, null),
    isSynthetic: row.is_synthetic === 1,
  };
  return { evidence, summary: learningEvidenceSummary(evidence)! };
}

/** Apply an approval decision to a learning (called after a CLI decision). */
export function applyLearningDecision(db: Db, clock: Clock, approval: ApprovalRecord): string | null {
  if (approval.subjectType !== 'learning') return null;
  const l = db.get<LearningRow>('SELECT * FROM learnings WHERE site_id = ? AND id = ?', [approval.siteId, approval.subjectId]);
  if (!l || l.status !== 'proposed') return null;
  const current = learningHash({ statement: l.statement, scope: l.scope, evidence: parseJson(l.evidence_json, null) });
  if (current !== approval.artifactHash) return `Learning ${l.id} changed since the approval was requested; status left as proposed.`;
  const now = clock.now().toISOString();
  if (approval.status === 'approved') {
    db.run(`UPDATE learnings SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'`, [approval.approver, now, now, l.id]);
    return `Learning ${l.id} approved (scope: ${l.scope}).`;
  }
  if (approval.status === 'rejected') {
    db.run(`UPDATE learnings SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'proposed'`, [now, l.id]);
    return `Learning ${l.id} rejected.`;
  }
  return null;
}
