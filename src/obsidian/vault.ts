/**
 * Conventional entry point for dependency wiring (for example the content
 * pipeline's dynamic lookup): `createVaultWriter(ctx)` returns the
 * file-backed `VaultWriter` for the context's site vault.
 */
export { createVaultWriter, FileVaultWriter } from './writer.js';
export type { VaultWriter } from './types.js';
