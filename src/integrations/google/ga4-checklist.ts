import type { SiteConfig } from '../../config/site-schema.js';
import { unusedPrimaryEvents, unusedPrimaryEventsReason, type Ga4MetricPlan } from './ga4-metadata.js';

/**
 * Manual conversion-verification checklist for the owner. Verification is a
 * human activity: this tool never submits forms, creates leads or purchases,
 * or changes GA4 configuration (creating/marking events stays a human action).
 */
export function ga4ConversionChecklist(config: SiteConfig, plan?: Ga4MetricPlan | null): string {
  const primary = config.conversions.primaryEvents;
  const secondary = config.conversions.secondaryEvents;
  const property = config.google.ga4PropertyId ?? '(not configured)';
  const lines: string[] = [];
  lines.push(`GA4 conversion verification checklist (property ${property})`);
  lines.push('');
  lines.push('This is a manual checklist. seo-agent never submits forms, creates test leads or purchases, or edits GA4 settings.');
  lines.push('');
  if (!primary.length) {
    lines.push('[ ] Configure the primary conversion event(s) in the site config (conversions.primaryEvents) with their exact GA4 event names and business meaning.');
  }
  const unused = unusedPrimaryEvents(primary.map((e) => e.name));
  if (unused.length) {
    lines.push(`LIMITATION: ${unusedPrimaryEventsReason(primary[0]!.name, unused)}`);
    lines.push('');
  }
  for (const e of primary) {
    const listed = plan?.keyEventListed[e.name];
    const verifiedAt = (e as { verifiedAt?: string | null }).verifiedAt ?? null;
    const verificationNote = (e as { verificationNote?: string | null }).verificationNote ?? null;
    lines.push(`Primary event "${e.name}" (${e.meaning})`);
    lines.push(
      verifiedAt
        ? `  Recorded owner verification: ${verifiedAt}${verificationNote ? ` (${verificationNote})` : ''}. Re-verify after tracking, form, or consent changes.`
        : '  Recorded owner verification: NONE. Reports caveat this event\'s metrics as "tracking not yet verified by the owner" until it is recorded.',
    );
    lines.push(`  [ ] In GA4 Admin > Events (Key events), confirm "${e.name}" exists with this exact, case-sensitive name and is marked as a key event.${listed === false ? ' (getMetadata does not currently list a per-event key-event metric for it.)' : ''}`);
    lines.push('      Marking an event as a key event affects reports from that point on; it does not change historical data.');
    lines.push(`  [ ] Confirm the event fires once per completed ${e.kind === 'other' ? 'conversion' : e.kind}, on completion (for example after a successful submission), not on page load or button click alone.`);
    lines.push('  [ ] Verify the firing in GA4 DebugView using a staging/preview environment or debug mode, not by creating fake production records.');
    lines.push('      If a production check is unavoidable, agree it in advance with whoever owns the downstream system, label it clearly, and remove it there afterwards.');
    lines.push('  [ ] Check consent-mode behaviour: with analytics consent denied, the event may be modelled or missing; document what your consent setup does.');
    lines.push(`  [ ] Compare the GA4 count for "${e.name}" with the system of record (CRM, order system, booking tool) for the same dates in the GA4 property time zone. Expect some difference; record it rather than forcing agreement.`);
    if (e.value) lines.push(`  [ ] Confirm the configured value (${e.value.amount} ${e.value.currency}) matches what the business actually earns per ${e.kind}.`);
    lines.push(`  [ ] After at least one real conversion, run \`npm run cli -- sync ga4\` and confirm sessionKeyEventRate:${e.name} is available (no "unavailable" limitation).`);
    if (e.name === primary[0]!.name) {
      lines.push(`  [ ] If the sync reports the key-event rate scale as UNDETERMINED, compare one stored sessionKeyEventRate:${e.name} value (\`npm run cli -- analyze page <url>\` or \`data export\`) with the same page, date, and channel in the GA4 interface, then record the scale:`);
      lines.push('      `npm run cli -- sync ga4 --confirm-rate-scale fraction --evidence "<what you compared>" --as "<your name>"` when GA4 shows 2.5% for a stored 0.025, or `--confirm-rate-scale percent` when the stored value is 2.5. The confirmation is audited and re-marks stored rates.');
    }
    lines.push('');
  }
  if (secondary.length) {
    lines.push('Secondary events');
    for (const e of secondary) lines.push(`  [ ] "${e.name}" (${e.meaning}): confirm it fires once per real occurrence and whether it is intended to be a key event.`);
    lines.push('');
  }
  lines.push('Reporting checks');
  lines.push('  [ ] Confirm organic landing pages are not dominated by "(not set)" (missing session_start or page_view events, or consent misconfiguration).');
  lines.push('  [ ] If revenue is reported, confirm the GA4 currency and that refunds are handled as expected; revenue stays in the source currency.');
  lines.push('  [ ] Record the verification date and outcome for each primary event: run `npm run cli -- setup --update --only conversions`, or edit the site config (config/sites/<site-id>.yaml) and set conversions.primaryEvents[].verifiedAt (YYYY-MM-DD) and verificationNote (how it was verified, e.g. "test submission seen in GA4 DebugView").');
  lines.push('      Until verified, treat conversion metrics as unverified: reports add a data-quality item and caveat primary-event metrics as "tracking not yet verified by the owner".');
  // The unused-primary-event limitation is already stated at the top (it comes from the config, not from GA4 metadata).
  const metadataLimitations = (plan?.limitations ?? []).filter((l) => !(unused.length && l.reason === unusedPrimaryEventsReason(primary[0]!.name, unused)));
  if (metadataLimitations.length) {
    lines.push('');
    lines.push('Current metric limitations reported by GA4 metadata');
    for (const l of metadataLimitations) lines.push(`  - ${l.metric}: ${l.reason}`);
  }
  return lines.join('\n');
}
