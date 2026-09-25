import { z } from 'zod';

/**
 * Apify API v2 response shapes used by this integration.
 *
 * Only fields recorded as verified in docs/integration-contracts.md section 7
 * are relied on. Every response is untrusted remote data: shapes are parsed
 * leniently (unknown fields pass through) and every field we use is optional
 * unless the contract lists it as required.
 */

/** ActorJobStatus values (docs/integration-contracts.md: AP13). */
export const APIFY_RUN_STATUSES = ['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED'] as const;
export type ApifyRunStatus = (typeof APIFY_RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
export const TRANSITIONAL_RUN_STATUSES: ReadonlySet<string> = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);

export function isTerminalStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_RUN_STATUSES.has(status);
}

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

export const runOptionsSchema = z.looseObject({
  build: nullableString,
  timeoutSecs: nullableNumber,
  memoryMbytes: nullableNumber,
  diskMbytes: nullableNumber,
  maxItems: nullableNumber,
  maxTotalChargeUsd: nullableNumber,
});

export const runStatsSchema = z.looseObject({
  inputBodyLen: nullableNumber,
  restartCount: nullableNumber,
  durationMillis: nullableNumber,
  runTimeSecs: nullableNumber,
});

/** `Run` (AP8). Required per the docs: id, actId, status, ... (we require only id + status). */
export const apifyRunSchema = z.looseObject({
  id: z.string().min(1),
  actId: nullableString,
  status: z.string().min(1),
  startedAt: nullableString,
  finishedAt: nullableString,
  statusMessage: nullableString,
  isStatusMessageTerminal: z.boolean().nullable().optional(),
  exitCode: nullableNumber,
  buildId: nullableString,
  buildNumber: nullableString,
  defaultDatasetId: nullableString,
  defaultKeyValueStoreId: nullableString,
  options: runOptionsSchema.nullable().optional(),
  stats: runStatsSchema.nullable().optional(),
  meta: z.looseObject({ origin: nullableString }).nullable().optional(),
  usageTotalUsd: nullableNumber,
  chargedEventCounts: z.record(z.string(), z.number()).nullable().optional(),
});
export type ApifyRun = z.infer<typeof apifyRunSchema>;

/** `RunShort` from the list-runs endpoint (AP8). */
export const apifyRunShortSchema = z.looseObject({
  id: z.string().min(1),
  actId: nullableString,
  status: z.string().min(1),
  startedAt: nullableString,
  finishedAt: nullableString,
  buildId: nullableString,
  buildNumber: nullableString,
  meta: z.looseObject({ origin: nullableString }).nullable().optional(),
  usageTotalUsd: nullableNumber,
  defaultDatasetId: nullableString,
  defaultKeyValueStoreId: nullableString,
});
export type ApifyRunShort = z.infer<typeof apifyRunShortSchema>;

export const taggedBuildSchema = z.looseObject({
  buildId: nullableString,
  buildNumber: nullableString,
  buildNumberInt: nullableNumber,
  finishedAt: nullableString,
});

/** Actor object (AP1, LIVE). */
export const apifyActorSchema = z.looseObject({
  id: z.string().min(1),
  userId: nullableString,
  name: nullableString,
  username: nullableString,
  title: nullableString,
  isPublic: z.boolean().nullable().optional(),
  isDeprecated: z.boolean().nullable().optional(),
  notice: nullableString,
  modifiedAt: nullableString,
  taggedBuilds: z.record(z.string(), taggedBuildSchema.nullable()).nullable().optional(),
  versions: z.array(z.unknown()).nullable().optional(),
  defaultRunOptions: z.record(z.string(), z.unknown()).nullable().optional(),
  pricingInfos: z.array(z.unknown()).nullable().optional(),
});
export type ApifyActor = z.infer<typeof apifyActorSchema>;

/** Build object (AP5, LIVE). `inputSchema` is a JSON string (or null). */
export const apifyBuildSchema = z.looseObject({
  id: z.string().min(1),
  actId: nullableString,
  status: nullableString,
  buildNumber: nullableString,
  startedAt: nullableString,
  finishedAt: nullableString,
  inputSchema: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable().optional(),
  actorDefinition: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Build README (Markdown) per the Build schema (AP8). Untrusted documentation text: only hashed, never stored or followed. */
  readme: z.unknown().optional(),
});
export type ApifyBuild = z.infer<typeof apifyBuildSchema>;

/**
 * Build list item. NOTE: the builds-list endpoint shape is NOT recorded in
 * docs/integration-contracts.md; it is parsed defensively and only used as an
 * optional fallback to resolve a pinned build number to a build id.
 */
export const apifyBuildShortSchema = z.looseObject({
  id: z.string().min(1),
  status: nullableString,
  buildNumber: nullableString,
  startedAt: nullableString,
  finishedAt: nullableString,
});
export type ApifyBuildShort = z.infer<typeof apifyBuildShortSchema>;

export interface PaginatedList<T> {
  total: number | null;
  offset: number;
  limit: number | null;
  count: number;
  items: T[];
}

export interface DatasetPage {
  items: unknown[];
  /** From X-Apify-Pagination-Total; null when the header is absent. */
  total: number | null;
  offset: number;
  limit: number;
  count: number;
}

export interface RunStartOptions {
  /** Build number (e.g. "0.0.513") or tag. The adapter only passes pinned build numbers. */
  build: string;
  timeoutSecs: number;
  memoryMbytes: number;
  /** Only effective for pay-per-result actors (AP8); sent as an extra bound anyway. */
  maxItems?: number | null;
  /** Provider-side charge cap in USD (AP8: caps charges for all pricing models). */
  maxTotalChargeUsd: string;
  /** 0..60 seconds. */
  waitForFinish?: number;
}
