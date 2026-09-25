// Type declarations for scripts/write-build-info.mjs (plain Node ESM, used by tests).
export interface BuildInfoStamp {
  schema: 1;
  name: string;
  version: string;
  builtAt: string;
  gitRevision: string | null;
  gitDirty: boolean | null;
  srcHash: string;
  srcFiles: number;
  migrations: string[] | null;
}
export const BUILD_INFO_FILE: string;
export const BUILD_INFO_SCHEMA: 1;
export function hashSourceTree(srcDir: string): { hash: string; files: number } | null;
export function listMigrationFiles(dir: string): string[] | null;
export function gitState(root: string): { revision: string | null; dirty: boolean | null };
export function staleOutputs(root: string, distDir?: string): string[];
export function createBuildInfo(root: string, opts?: { now?: Date; git?: boolean }): BuildInfoStamp;
export function verifyBuildInfo(
  root: string,
  opts?: { distDir?: string },
): { state: 'fresh' | 'stale' | 'unstamped' | 'not_built'; info: BuildInfoStamp | null; reasons: string[] };
export function writeBuildInfo(root: string, opts?: { now?: Date; git?: boolean; checkOutputs?: boolean }): { file: string; info: BuildInfoStamp };
