// Type declarations for scripts/check-licenses.mjs (plain Node ESM, used by tests).
export type LicenseCategory = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown' | 'missing';
export function classifyLicense(expr: unknown): { category: LicenseCategory; expression: string | null; note?: string };
export function licenseExpression(pkg: Record<string, unknown>): string | null;
export function copyrightLines(text: string | null): string[];
export interface CollectedPackage {
  name: string;
  version: string | null;
  path: string;
  scope: 'runtime' | 'runtime-optional' | 'dev' | 'extraneous';
  direct: boolean;
  license: string | null;
  category: LicenseCategory;
  note: string | null;
  repository: string | null;
  licenseFiles: Array<{ name: string; text: string }>;
  noticeFiles: Array<{ name: string; text: string }>;
  copyright: string[];
}
export interface Collected {
  root: string;
  hasLockfile: boolean;
  hasNodeModules: boolean;
  packages: CollectedPackage[];
  notInstalled: Array<{ path: string; version: string | null; license: string | null; scope: string; optional: boolean }>;
}
export interface LicenseProblem {
  severity: 'error' | 'warning' | 'info';
  package: string;
  reason: string;
}
export function collectPackages(root: string): Collected;
export function evaluatePackages(collected: Collected): { problems: LicenseProblem[]; counts: Record<string, number> };
export function renderNotices(collected: Collected): string;
export interface LicenseReport {
  tool: string;
  root: string;
  projectLicense: { packageJson: string | null; licenseFile: boolean; selected: boolean };
  packages: Array<Omit<CollectedPackage, 'licenseFiles' | 'noticeFiles' | 'copyright'> & { licenseFiles: string[]; noticeFiles: string[] }>;
  notInstalledLockEntries: number;
  counts: Record<string, number>;
  problems: LicenseProblem[];
  notices: { file: string; exists: boolean; upToDate: boolean; written: boolean };
  errors: number;
  warnings: number;
  ok: boolean;
}
export function checkLicenses(opts?: { root?: string; write?: boolean; check?: boolean; strict?: boolean; out?: string }): LicenseReport;
export function renderLicenseReport(r: LicenseReport): string;
