/**
 * Public surface of the Obsidian-compatible vault layer (see docs/modules/obsidian.md).
 * Integration code should import from here rather than from individual files.
 */
export * from './types.js';
export { createVaultWriter, FileVaultWriter, CORE_GENERATED_KEYS, type VaultWriteOutcome, type ResolveResult, type VaultNoteRow } from './writer.js';
export { renderAll, buildNotes, planRender, pageDisplayName, RENDER_KINDS, FOLDERS, type RenderKind, type RenderOptions, type RenderSummary } from './notes.js';
export { DEFAULT_RENDER_LIMITS, type RenderLimits } from './render-context.js';
export { STALE_STATUS, STALE_BANNER_TITLE, SUPERSEDED_BANNER_TITLE, type StaleNoteOutcome } from './stale.js';
export { initSiteVault, type VaultInitResult } from './template.js';
export { checkVault, legacyContentNoteType, LEGACY_CONTENT_NOTE_TYPES, type VaultCheckReport, type VaultCheckIssue, type VaultIssueCode } from './check.js';
export {
  applyBusinessProfile,
  importBusinessNotes,
  listBusinessNoteVersions,
  parseBusinessNote,
  scanBusinessNotes,
  diffBusinessProfile,
  businessNoteTrustClass,
  BUSINESS_FOLDER,
  BUSINESS_NOTE_TYPES,
  type BusinessImportResult,
  type ApplyBusinessResult,
  type ParsedBusinessNote,
  type BusinessNoteVersionView,
} from './business-sync.js';
export { parseNote, parseYamlStrict, generatedContentHash, serializeFrontmatter } from './frontmatter.js';
export { formatWikilink, extractWikilinks, noteFileName, notePath } from './wikilinks.js';
export { validateVaultRelPath, atomicWriteFile } from './fs-safe.js';
export { registerIntegrationStatusProvider, collectDashboardStatuses, vaultIntegrationStatus, type IntegrationStatusProvider } from './status.js';
