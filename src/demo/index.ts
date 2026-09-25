/**
 * Offline demo (spec sections 29 and 31): an isolated demo workspace with
 * SYNTHETIC fixtures only and zero external network access. See docs/DEMO.md.
 */
export { runDemo, collectClaims, DEMO_STEPS, applySyntheticDeployment, DEMO_APPROVER, DEMO_INTERRUPT_STAGE, DEMO_SOURCE_REVISION, DEMO_DEPLOY_REVISION, SYNTHETIC_LABEL, type DemoOptions, type DemoResult, type DemoStep, type DemoStepStatus } from './run.js';
export { renderDemoSummary, renderDemoStep, DEMO_BANNER } from './render.js';
export {
  prepareDemoWorkspace,
  assertDemoDirSafe,
  assertDemoRefreshSafe,
  demoRefreshBlockers,
  defaultDemoDir,
  demoFixturesDir,
  demoSiteConfig,
  demoSiteConfigText,
  isDemoWorkspace,
  DEMO_DIR_NAME,
  DEMO_MARKER_FILE,
  DEMO_SITE_DIR,
  type PreparedDemoWorkspace,
  type DemoMarker,
} from './workspace.js';
export { createDemoEnv, demoCompetitorCrawler, countingSyntheticDataForSeo, demoApifyItems, DEMO_COMPETITOR_HOSTS, type DemoEnv } from './fixtures.js';
