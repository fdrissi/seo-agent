import { AppError, PolicyDeniedError } from '../core/errors.js';
import { modeAtLeast, RUNTIME_MODES, type RuntimeMode } from '../core/modes.js';
import type { ApprovalActionType, ApprovalCheck } from './types.js';

/**
 * Runtime-mode policy, enforced in code.
 *
 *   ANALYZE (default)  authorized, budgeted first-party reads; local reports/records.
 *   RESEARCH           ANALYZE + budgeted external research requests.
 *   DRAFT              RESEARCH + local review artifacts, each only after the
 *                      configured approval (e.g. `draft_generation`).
 *   EXECUTE            DRAFT + production-bound actions. EVERY production action
 *                      additionally needs a valid human approval bound to the
 *                      exact proposal (site, action type, target, artifact hash,
 *                      source revision, unexpired, not yet executed).
 *
 * The inputs to a decision are only (a) the runtime mode, which comes from the
 * CLI `--mode` flag, and (b) an ApprovalCheck produced by the approval service
 * from SQLite. No free text is accepted: LLM output, Markdown frontmatter such
 * as `approved: true`, or scraped content can never influence a decision. An
 * LLM instruction is not an access-control mechanism.
 */

export type PolicyCategory = 'read' | 'research' | 'local_write' | 'draft' | 'production';

export interface PolicyRule {
  category: PolicyCategory;
  minMode: RuntimeMode;
  /** Approval action type that must be valid for this action (null = none required). */
  approval: ApprovalActionType | null;
  description: string;
}

/** Production action types: always EXECUTE mode plus a valid approval for the exact proposal. */
export const PRODUCTION_ACTION_TYPES = [
  'publish_content',
  'update_page',
  'title_meta_change',
  'redirect',
  'merge_pages',
  'delete_page',
  'canonical_change',
  'robots_change',
  'analytics_change',
] as const satisfies readonly ApprovalActionType[];
export type ProductionActionType = (typeof PRODUCTION_ACTION_TYPES)[number];

export function isProductionActionType(t: string): t is ProductionActionType {
  return (PRODUCTION_ACTION_TYPES as readonly string[]).includes(t);
}

const production = (t: ProductionActionType, description: string): PolicyRule => ({ category: 'production', minMode: 'EXECUTE', approval: t, description });

export const POLICY_RULES = {
  read_data: { category: 'read', minMode: 'ANALYZE', approval: null, description: 'Read local data (SQLite, vault, reports).' },
  budgeted_read: { category: 'read', minMode: 'ANALYZE', approval: null, description: 'Authorized, budgeted first-party read requests (GSC, GA4, own-site crawl).' },
  write_local_report: { category: 'local_write', minMode: 'ANALYZE', approval: null, description: 'Write local report/research files and records.' },
  record_evaluation: { category: 'local_write', minMode: 'ANALYZE', approval: null, description: 'Record an experiment evaluation.' },
  record_annotation: { category: 'local_write', minMode: 'ANALYZE', approval: null, description: 'Record an external/site change annotation.' },
  record_implementation: { category: 'local_write', minMode: 'ANALYZE', approval: null, description: 'Record that a human implemented an approved change (mark-implemented).' },
  propose_experiment: { category: 'local_write', minMode: 'ANALYZE', approval: null, description: 'Record an experiment proposal (does not change production).' },
  request_approval: { category: 'local_write', minMode: 'ANALYZE', approval: null, description: 'Create a pending approval request (grants nothing).' },
  export_record: { category: 'local_write', minMode: 'ANALYZE', approval: null, description: 'Export a non-production record (e.g. a no-action recommendation) for review.' },
  external_research: { category: 'research', minMode: 'RESEARCH', approval: null, description: 'Budgeted external research requests (DataForSEO, Apify, competitor crawl).' },
  generate_draft: { category: 'draft', minMode: 'DRAFT', approval: 'draft_generation', description: 'Create a local draft review artifact after the configured draft approval.' },
  batch_drafts: { category: 'draft', minMode: 'DRAFT', approval: 'batch_expansion', description: 'Batch draft expansion after an approved pilot.' },
  publish_content: production('publish_content', 'Publish new content (v1: manual export package for a human to deploy).'),
  update_page: production('update_page', 'Change an existing page.'),
  title_meta_change: production('title_meta_change', 'Change a title or meta description.'),
  redirect: production('redirect', 'Create or change a redirect.'),
  merge_pages: production('merge_pages', 'Merge pages.'),
  delete_page: production('delete_page', 'Delete a page.'),
  canonical_change: production('canonical_change', 'Change a canonical directive.'),
  robots_change: production('robots_change', 'Change robots directives or robots.txt.'),
  analytics_change: production('analytics_change', 'Change analytics/measurement configuration.'),
} as const satisfies Record<string, PolicyRule>;

export type PolicyAction = keyof typeof POLICY_RULES;

export interface PolicyDecision {
  allowed: boolean;
  action: PolicyAction;
  mode: RuntimeMode;
  rule: PolicyRule;
  /** Machine-readable reason when denied. */
  reason?: 'mode_insufficient' | 'approval_required' | 'approval_invalid' | 'approval_action_mismatch';
  message: string;
  approvalId?: string;
}

export function policyRule(action: PolicyAction): PolicyRule {
  const rule = (POLICY_RULES as Record<string, PolicyRule>)[action];
  if (!rule) throw new PolicyDeniedError(`Unknown policy action "${String(action)}" is denied by default.`, { action });
  return rule;
}

export function isProductionAction(action: PolicyAction): boolean {
  return policyRule(action).category === 'production';
}

/**
 * Evaluate the policy without throwing. `approval` must come from the approval
 * service (`ApprovalGate.check`) for the exact proposal being acted on.
 */
export function evaluatePolicy(mode: RuntimeMode, action: PolicyAction, opts: { approval?: ApprovalCheck } = {}): PolicyDecision {
  if (!(RUNTIME_MODES as readonly string[]).includes(mode)) {
    return { allowed: false, action, mode, rule: policyRule(action), reason: 'mode_insufficient', message: `Unknown runtime mode "${String(mode)}" is denied.` };
  }
  const rule = policyRule(action);
  if (!modeAtLeast(mode, rule.minMode)) {
    return {
      allowed: false,
      action,
      mode,
      rule,
      reason: 'mode_insufficient',
      message: `"${action}" requires --mode ${rule.minMode} (current mode: ${mode}).${rule.category === 'production' ? ' Production actions also require a valid human approval for the exact proposal.' : ''}`,
    };
  }
  if (rule.approval) {
    const check = opts.approval;
    if (!check) {
      return { allowed: false, action, mode, rule, reason: 'approval_required', message: `"${action}" requires a valid "${rule.approval}" approval for the exact proposal.` };
    }
    if (!check.ok) {
      return {
        allowed: false,
        action,
        mode,
        rule,
        reason: check.reason === 'none' ? 'approval_required' : 'approval_invalid',
        message: `"${action}" is not authorized: approval check failed (${check.reason}).`,
        ...(check.approval ? { approvalId: check.approval.id } : {}),
      };
    }
    if (check.approval.actionType !== rule.approval || check.approval.status !== 'approved') {
      return {
        allowed: false,
        action,
        mode,
        rule,
        reason: 'approval_action_mismatch',
        message: `Approval ${check.approval.id} authorizes "${check.approval.actionType}" (${check.approval.status}), not "${rule.approval}".`,
        approvalId: check.approval.id,
      };
    }
    return { allowed: true, action, mode, rule, message: `Allowed in ${mode} with approval ${check.approval.id}.`, approvalId: check.approval.id };
  }
  return { allowed: true, action, mode, rule, message: `Allowed in ${mode}.` };
}

/** Throw unless the action is allowed. Returns the decision for auditing. */
export function assertAllowed(mode: RuntimeMode, action: PolicyAction, opts: { approval?: ApprovalCheck } = {}): PolicyDecision {
  const d = evaluatePolicy(mode, action, opts);
  if (d.allowed) return d;
  if (d.reason === 'mode_insufficient') {
    throw new PolicyDeniedError(d.message, { action, mode, requiredMode: d.rule.minMode });
  }
  throw new AppError(d.reason === 'approval_required' ? 'APPROVAL_REQUIRED' : 'APPROVAL_INVALID', d.message, {
    details: { action, mode, requiredApproval: d.rule.approval, ...(d.approvalId ? { approvalId: d.approvalId } : {}) },
    hint: 'Request an approval with `approvals request <subject-type> <id>` and have a human approve it with `approvals approve <id> --as <name> --confirm <hash-prefix>`.',
  });
}

/** Map a production approval action type to its policy action. */
export function policyActionForApproval(t: ApprovalActionType): PolicyAction {
  if (isProductionActionType(t)) return t;
  if (t === 'draft_generation') return 'generate_draft';
  if (t === 'batch_expansion') return 'batch_drafts';
  throw new PolicyDeniedError(`Approval action "${t}" has no production policy action.`, { actionType: t });
}
