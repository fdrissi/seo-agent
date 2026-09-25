// Type declarations for scripts/release-check.mjs (plain Node ESM, used by tests).
export interface ReleaseItem {
  status: 'pass' | 'fail' | 'warn' | 'info';
  id: string;
  title: string;
  details: string[];
  moreDetails: number;
}
export interface ReleaseReport {
  tool: string;
  root: string;
  readOnly: true;
  published: false;
  items: ReleaseItem[];
  manualSteps: string[];
  failures: number;
  warnings: number;
  strict: boolean;
  ok: boolean;
}
export const MANUAL_STEPS: string[];
export function runReleaseCheck(opts?: { root?: string; strict?: boolean; packList?: string | null; skipNpmPack?: boolean; history?: boolean; skipLicenses?: boolean }): Promise<ReleaseReport>;
export function renderReleaseReport(r: ReleaseReport): string;
