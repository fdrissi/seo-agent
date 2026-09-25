import type { Db } from '../database/db.js';

/**
 * Terminal-safe rendering of approval and experiment text for human review.
 *
 * Summaries and changes can contain model-generated text derived from scraped
 * pages. Printed raw, ANSI escape sequences or C0/C1 control characters could
 * move the cursor, erase lines, or recolor output, and bidi/invisible
 * characters could make the text an approver sees differ from what is
 * approved. Every such character is replaced with a VISIBLE marker
 * (e.g. `[U+001B]`), so nothing is hidden and nothing can rewrite the screen.
 * Newlines and tabs are kept. The stored proposal and the artifact hash are
 * never altered; this only affects what is printed.
 */

// C0 controls except \t and \n, DEL, C1 controls; bidi controls, zero-width and other invisible characters.
const UNSAFE_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function forTerminal(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text).replace(UNSAFE_RE, (ch) => `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`);
}

/** True when `forTerminal` would change the text (worth a visible warning). */
export function hasUnsafeTerminalChars(text: string | null | undefined): boolean {
  if (!text) return false;
  UNSAFE_RE.lastIndex = 0;
  const found = UNSAFE_RE.test(String(text));
  UNSAFE_RE.lastIndex = 0;
  return found;
}

/**
 * Budget exceptions are recorded and checkable (`checkBudgetException`), but
 * BudgetService never reads them, so approving one raises no limit. Every
 * surface that shows or approves one states this (spec 32: no success is
 * reported for a feature that does nothing yet).
 */
export const BUDGET_EXCEPTION_CAVEAT =
  'Budget exceptions do not raise any limit yet: the budget service never reads them, so paid requests are still checked against the configured cap. This approval is recorded and checkable only (see docs/modules/experiments-approvals.md).';

/** Caveats that must accompany an approval whenever it is shown or decided (text and JSON). */
export function approvalCaveats(a: { actionType: string }): string[] {
  return a.actionType === 'budget_exception' ? [BUDGET_EXCEPTION_CAVEAT] : [];
}

/** Banner for listings in a demo site (demo profile, synthetic context, or a site registered with is_demo = 1). */
export const SYNTHETIC_DEMO_BANNER = 'SYNTHETIC DEMO DATA: fictional demo site; these records are not real proposals, approvals, or measurements.';

/** True for a demo site: demo profile, synthetic context, or a site registered as demo (sites.is_demo = 1). */
export function isDemoSite(ctx: { db: Db; siteId: string; synthetic?: boolean; config?: { profile?: string } }): boolean {
  if (ctx.synthetic === true || ctx.config?.profile === 'demo') return true;
  try {
    return ctx.db.get<{ is_demo: number }>('SELECT is_demo FROM sites WHERE id = ?', [ctx.siteId])?.is_demo === 1;
  } catch {
    return false;
  }
}
