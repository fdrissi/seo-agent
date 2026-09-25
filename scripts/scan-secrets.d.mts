// Type declarations for scripts/scan-secrets.mjs (plain Node ESM, used by tests).
import type { CompiledAllowlist, SecretFinding } from './lib/secret-rules.mjs';
export interface GitInfo {
  isRepo: boolean;
  gitAvailable: boolean;
  commitCount: number;
  topLevel: string | null;
  shallow: boolean;
}
export interface HistoryScanResult {
  status: 'scanned' | 'no-commits' | 'not-a-git-repository' | 'git-not-available';
  commits: number;
  expectedCommits: number;
  complete: boolean;
  shallow: boolean;
  warnings: string[];
  skipped: { binaryFiles: number; oversizedFiles: number };
  findings: SecretFinding[];
}
export interface ScanReport {
  tool: string;
  root: string;
  git: { isRepository: boolean; gitAvailable: boolean; commits: number };
  allowlistFile: string | null;
  tree: { mode: 'git' | 'walk'; candidates: number; scanned: number; skipped: Record<string, number> } | null;
  history: {
    status: HistoryScanResult['status'];
    commitsScanned: number;
    commitsReachable: number;
    complete: boolean;
    shallow: boolean;
    skipped: { binaryFiles: number; oversizedFiles: number };
    includeUnreachable: boolean;
  } | null;
  findings: SecretFinding[];
  allowlisted: SecretFinding[];
  warnings: string[];
  historyIncomplete: boolean;
  status: 'clean' | 'findings' | 'incomplete';
  ok: boolean;
  remediation: string[];
}
export interface ScanOptions {
  root?: string;
  tree?: boolean;
  history?: boolean;
  allowlist?: string | null;
  includeUnreachable?: boolean;
  maxBytes?: number;
  allowIncompleteHistory?: boolean;
}
export function gitInfo(root: string): GitInfo;
export function listTreeFiles(root: string, info?: GitInfo): { mode: 'git' | 'walk'; files: string[] };
export function unquoteGitPath(p: string): string;
export function parseDiffHeaderPath(rest: string, prefix: string): string | null;
export function parseDiffGitLine(line: string): string | null;
export function scanHistory(root: string, allowlist: CompiledAllowlist, opts?: { info?: GitInfo; includeUnreachable?: boolean; maxBytes?: number }): Promise<HistoryScanResult>;
export function loadAllowlist(file: string | null | undefined): CompiledAllowlist;
export function scanRepository(opts?: ScanOptions): Promise<ScanReport>;
export function renderReport(report: ScanReport, opts?: { showAllowlisted?: boolean }): string;
