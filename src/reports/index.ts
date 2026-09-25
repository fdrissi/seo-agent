/**
 * Reports module: baseline/weekly/monthly Markdown + JSON reports with
 * labeled claims, append-only storage, and the static dashboard note.
 * See docs/modules/reports.md.
 */
export { buildBaselineReport, buildMonthlyReport, buildReportOfKind, buildWeeklyReport, type BuiltReport, type InternalLinksReportInput, type ReportBuildInput } from './build.js';
export { buildDashboard, dashboardPeriod, DASHBOARD_REL_PATH, type DashboardInput } from './dashboard.js';
export { metricDefinitions } from './definitions.js';
export { defaultLinkResolver, escapeMd, renderLink, wikiLinkResolver, type LinkResolver, type LinkTarget } from './links.js';
export { EXECUTIVE_SUMMARY_PROMPT_ID } from './llm-summary.js';
export * from './model.js';
export { latestCompleteDate, reportTimeZone, reportTimeZoneInfo, resolvePeriod, type PeriodOverride } from './period.js';
export { renderClaim, renderJson, renderMarkdown, renderSection, renderTable, reportTitle } from './render.js';
export { getReport, latestReport, listReports, persistReport, readReportFile, reportFileCandidates, reportNotePath, resolveReportFile, toVaultNote, vaultFolderFor, type ReportRow, type StoredReport } from './storage.js';
