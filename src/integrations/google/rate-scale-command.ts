/**
 * The owner command that establishes the GA4 key-event rate scale, spelled out
 * once for every message that names it: the `sync ga4` result and status
 * line, report next actions and data-quality next steps, and the "rate scale
 * unverified" reason of an unavailable conversion rate (reports, vault, router
 * notes, `analyze page`).
 *
 * `--as "<your name>"` is required (the confirmation is a named human's
 * assertion, C1-13); a command printed without it is refused with
 * VALIDATION_FAILED. `fraction|percent` means "one of": fraction when GA4
 * shows 2.5% for a stored 0.025, percent when the stored value is 2.5.
 *
 * Dependency-free on purpose: `src/seo/metrics.ts` and `src/reports` import it
 * without pulling in the GA4 sync.
 */
export const CONFIRM_RATE_SCALE_COMMAND = 'npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"';
