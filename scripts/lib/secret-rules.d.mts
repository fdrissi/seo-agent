// Type declarations for scripts/lib/secret-rules.mjs (plain Node ESM, used by tests).
export interface SecretFinding {
  rule: string;
  description: string;
  path: string;
  line: number;
  length: number;
  fingerprint: string;
  allowlisted?: 'fingerprint' | 'marker' | 'path-marker' | 'sequence';
  source?: 'tree' | 'history';
  commits?: number;
  firstSeenCommit?: string;
}
export interface CompiledAllowlist {
  markers: string[];
  isIgnoredPath(p: string): boolean;
  allows(finding: SecretFinding, value: string | null): SecretFinding['allowlisted'] | null;
}
export interface ContentRule {
  id: string;
  description: string;
  regex: RegExp;
  group?: number;
  validate?: (value: string, match: RegExpExecArray) => boolean;
}
export const FINGERPRINT_PREFIX: string;
export function fingerprint(value: string): string;
export function shannonEntropy(value: string): number;
export function looksLikePlaceholder(value: string): boolean;
export function isPlaceholderValue(value: string): boolean;
export function isCodeReference(value: string): boolean;
export const CONTENT_RULES: ContentRule[];
export const FILENAME_RULES: Array<{ id: string; description: string; test: (p: string) => boolean }>;
export function isDotenvPath(p: string): boolean;
export function dotenvValueLine(text: string): { line: number; value: string } | null;
export const DEFAULT_MARKERS: string[];
export function containsMarker(value: string, markers: string[]): boolean;
export function hasSequentialRun(value: string, min?: number): boolean;
export function hasRepeatedRun(value: string, min?: number): boolean;
export function globToRegExp(glob: string): RegExp;
export const RANDOM_TOKEN_RULES: Set<string>;
export const SEQUENCE_MIN_RUN: number;
export function privateKeyMarkerScope(block: string): string;
export function validateAllowlist(raw: unknown): string[];
export function compileAllowlist(raw: unknown): CompiledAllowlist;
export function scanText(text: string, path: string, allowlist: CompiledAllowlist | null, lineOffset?: number, lineMap?: number[] | null): SecretFinding[];
export function scanPathName(path: string, allowlist: CompiledAllowlist | null): SecretFinding[];
export function scanFileContent(path: string, text: string, allowlist: CompiledAllowlist | null, lineMap?: number[] | null): SecretFinding[];
export const REMEDIATION: string[];
