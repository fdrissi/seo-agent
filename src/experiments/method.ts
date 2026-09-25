/**
 * Measurement method identity, frozen on every experiment at proposal time.
 * Bump EVALUATION_METHOD_VERSION on any deliberate change to windowing,
 * aggregation, thresholds logic, or interference rules; evaluations record the
 * version they used and flag a mismatch with the frozen version.
 */
export const EVALUATION_METHOD = 'observational_before_after_did';
/**
 * History:
 * - '1': initial method.
 * - '2': GA4 windows treat a page without a landing row on a collected day
 *   whose report(s) said rows may be left out ("(other)" bucketing,
 *   thresholding, sampling) or hit the row limit as unknown, not zero: the
 *   window is incomplete and the conversion comparisons and GA4 guardrails
 *   are not judged; a window with no row and such days has unknown totals.
 * - '3': GA4 windows with collected days whose landing values are estimates
 *   (every covering report sampled or bucketed into "(other)", or a current
 *   row of the page from such a report), even when the page has a row every
 *   day, are incomplete (`estimateDates`): the conversion comparisons and
 *   GA4 guardrails are not judged and the evaluation carries a GA4 data
 *   caveat naming sampling or "(other)".
 */
export const EVALUATION_METHOD_VERSION = '3';

/** No significance test is implemented; this statement is recorded on every evaluation. */
export const SIGNIFICANCE = {
  tested: false,
  method: null,
  statement:
    'No significance test is implemented. This is an observational before/after comparison with weekday-matched windows of equal length and, where available, unchanged comparison pages (difference-in-differences style). It is not proof of causality and no result is labeled statistically significant.',
} as const;
