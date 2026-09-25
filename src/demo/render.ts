import type { DemoResult, DemoStep } from './run.js';

/**
 * Human walkthrough of a demo run. Everything it prints comes from the
 * SYNTHETIC demo workspace and says so: a banner at the top and bottom, and a
 * SYNTHETIC tag on every step.
 */

export const DEMO_BANNER = 'SYNTHETIC DEMO DATA: fictional business on reserved example domains; no real measurements, no real network requests.';

const STATUS_TEXT: Record<DemoStep['status'], string> = {
  ok: 'ok',
  degraded: 'degraded',
  failed: 'FAILED',
  skipped: 'skipped',
};

function labelled(title: string): string {
  return `${title} [SYNTHETIC]`;
}

export function renderDemoStep(step: DemoStep, index: number): string {
  const lines = [`${String(index).padStart(2)}. [${STATUS_TEXT[step.status]}] ${labelled(step.title)}`];
  for (const l of step.lines) lines.push(`      ${l}`);
  for (const a of step.artifacts) lines.push(`      -> ${a.label}: ${a.path}`);
  if (step.error?.hint) lines.push(`      Next step: ${step.error.hint}`);
  return lines.join('\n');
}

export function renderDemoSummary(r: DemoResult): string {
  const out: string[] = [];
  out.push('seo-agent offline demo', `== ${DEMO_BANNER} ==`, '');
  out.push(`Demo workspace: ${r.workspace.root} (kind "${r.workspace.kind}", isolated; never mixed into live reporting)${r.workspace.refreshed ? ' - previous demo refreshed' : ''}`);
  out.push(`Fictional site: ${r.site.businessName} (${r.site.url})`);
  out.push(`Synthetic timeline: ${r.timeline.start} -> ${r.timeline.end}. ${r.timeline.note}`);
  out.push('');
  r.steps.forEach((s, i) => {
    out.push(renderDemoStep(s, i + 1), '');
  });
  const where: Array<[string, string | null]> = [
    ['Vault (plain Markdown; open the folder in Obsidian if you like)', r.paths.vault ?? null],
    ['Dashboard', r.paths.dashboard ?? null],
    ['Baseline report', r.paths.baselineReport ?? null],
    ['Weekly report', r.paths.weeklyReport ?? null],
    ['Draft note', r.paths.draft ?? null],
    ['Manual export package', r.paths.exportPackage ?? null],
    ['Demo database', r.paths.database ?? null],
  ];
  out.push('Where to look (all SYNTHETIC):');
  for (const [label, p] of where) if (p) out.push(`  ${label}: ${p}`);
  out.push('', 'Explore the demo workspace with the normal CLI (it only reads/writes the demo directory):');
  for (const c of r.nextCommands) out.push(`  ${c}`);
  out.push('');
  out.push(`External network requests: ${r.network.externalRequests}. In-process fixture answers: ${r.network.dataforseoFixtureRequests} synthetic DataForSEO, ${r.network.competitorFixtureRequests} synthetic competitor page(s).`);
  const failed = r.steps.filter((s) => s.status === 'failed');
  const degraded = r.steps.filter((s) => s.status === 'degraded');
  out.push(
    failed.length
      ? `Result: the demo did NOT complete: ${failed.map((s) => s.id).join(', ')} failed (see above).`
      : `Result: demo completed (${r.steps.length} steps${degraded.length ? `, degraded: ${degraded.map((s) => s.id).join(', ')}` : ''}).`,
  );
  out.push('Next: set up your own workspace with `npm run cli -- init` and `npm run setup` (see docs/DEMO.md, "After the demo").');
  out.push(`== ${DEMO_BANNER} ==`);
  return out.join('\n');
}
