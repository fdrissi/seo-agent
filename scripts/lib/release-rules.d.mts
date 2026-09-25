// Type declarations for scripts/lib/release-rules.mjs (plain Node ESM, used by tests).
export const FORBIDDEN_RELEASE_PATHS: Array<{ id: string; reason: string; test: (p: string) => boolean }>;
export function forbiddenReasons(p: string): Array<{ id: string; reason: string }>;
export const PUBLIC_SOURCE_DIRS: string[];
export const MUST_IGNORE: Array<{ path: string; critical: boolean }>;
export const MUST_NOT_IGNORE: string[];
export interface DockerignoreRule {
  pattern: string;
  negate: boolean;
  re: RegExp;
}
export function parseDockerignore(text: string): DockerignoreRule[];
export function dockerIncluded(rules: DockerignoreRule[], p: string): boolean;
export const DOCKER_MUST_EXCLUDE: string[];
export const DOCKER_MUST_INCLUDE: string[];
export const DOCKER_RUNTIME_FIXTURES: string[];
export function runtimeStageCopySources(dockerfileText: string): string[];
export function copySourceCovers(src: string, dir: string): boolean;
export function fixtureIsLabeled(relPath: string, content: string | null, readmeLabel: (dir: string) => boolean, fixturesRoot?: string): boolean;
export function isReservedHostname(host: string): boolean;
export const PUBLIC_SERVICE_HOSTS: RegExp[];
export interface DockerfileInstruction {
  instruction: string;
  args: string;
  line: number;
}
export function dockerfileInstructions(text: string): DockerfileInstruction[];
export function parseCopyArgs(args: string): { from: string | null; sources: string[]; dest: string } | null;
export function dockerfileStages(text: string): Array<{ index: number; name: string | null; image: string; instructions: DockerfileInstruction[] }>;
export interface DockerBuildStage {
  index: number;
  name: string | null;
  runLine: number;
  copies: Array<{ from: string | null; sources: string[]; dest: string; line: number }>;
  sources: string[];
}
export function dockerBuildStage(text: string): DockerBuildStage | null;
export function buildScriptInputs(script: string | null | undefined): string[];
export const BUILD_STAMP_SCRIPT: string;
export const BUILD_STAMP_INPUTS: string[];
export function copySourceCoversPath(src: string, p: string): boolean;
export function dockerBuildInputProblems(opts: {
  dockerfileText: string;
  dockerignoreRules: DockerignoreRule[];
  buildScript: string | null | undefined;
  listFiles: (p: string) => string[];
}): { stage: DockerBuildStage | null; required: string[]; problems: string[] };
