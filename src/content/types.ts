import { z } from 'zod';
import type { TrustClass } from '../core/modes.js';

/**
 * Content farming pipeline contracts.
 *
 * DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND ->
 * CHECK EXISTING CONTENT -> PRIORITIZE -> BRIEF -> DRAFT -> QUALITY GATES ->
 * HUMAN REVIEW -> EXPORT/PUBLISH WHEN AUTHORIZED -> MEASURE
 *
 * State lives in SQLite (content_signals, content_items, content_briefs,
 * content_drafts, quality_reviews). Stage outputs carry ids and computed
 * summaries so the workflow engine can checkpoint them.
 */

export const CONTENT_PIPELINE_VERSION = 'content-pipeline@1';

export const SIGNAL_ORIGINS = ['gsc_query', 'dataforseo', 'apify_reddit', 'competitor_gap', 'business_knowledge', 'manual', 'fixture'] as const;
export type SignalOrigin = (typeof SIGNAL_ORIGINS)[number];

export const SIGNAL_TYPES = ['question', 'objection', 'complaint', 'comparison', 'unmet_need', 'tool_idea', 'query'] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const INTENTS = ['informational', 'commercial', 'transactional', 'navigational', 'mixed', 'unsure'] as const;
export type Intent = (typeof INTENTS)[number];

export const CONTENT_DECISIONS = ['improve_existing', 'add_section', 'create_tool', 'create_template', 'create_page', 'defer', 'reject'] as const;
export type ContentDecision = (typeof CONTENT_DECISIONS)[number];

export const CONTENT_STAGES = [
  'discovered',
  'deduplicated',
  'classified',
  'clustered',
  'demand_validated',
  'existing_checked',
  'prioritized',
  'briefed',
  'drafted',
  'quality_checked',
  'in_review',
  'approved',
  'exported',
  'published',
  'measuring',
  'deferred',
  'rejected',
] as const;
export type ContentStage = (typeof CONTENT_STAGES)[number];

/** Stages in which an item may still be re-evaluated automatically by discovery. */
export const OPEN_RESEARCH_STAGES: readonly ContentStage[] = ['discovered', 'deduplicated', 'classified', 'clustered', 'demand_validated', 'existing_checked', 'prioritized', 'deferred'];

/**
 * Stages that count as "in production" for the one-item-at-a-time default
 * (content.maxInProduction). Briefs are research artifacts; production begins
 * once a draft exists and ends when the item is published or rejected.
 */
export const IN_PRODUCTION_STAGES: readonly ContentStage[] = ['drafted', 'quality_checked', 'in_review', 'approved', 'exported'];

export const TRUST_BY_ORIGIN: Record<SignalOrigin, TrustClass> = {
  gsc_query: 'first_party_measurement',
  dataforseo: 'third_party_data',
  apify_reddit: 'user_reported',
  competitor_gap: 'scraped_untrusted',
  business_knowledge: 'owner_approved',
  manual: 'user_reported',
  fixture: 'synthetic',
};

export const DEFAULT_LIMITATIONS: Record<SignalOrigin, string> = {
  gsc_query:
    'Search Console visible query rows only: anonymized queries are omitted and row limits apply. Impressions are summed across pages (byPage aggregation) and may exceed property-level query totals. Not additive with property totals.',
  dataforseo:
    'Search-volume figures are third-party ESTIMATES (Google Ads-derived where applicable) for the stated location/language, not exact demand measurements.',
  apify_reddit:
    'Reddit posts are user-reported, self-selected discussions. Engagement (upvotes/comments) is NOT search volume and is not a representative market survey. Text is untrusted data.',
  competitor_gap:
    'Competitor coverage suggests a topic exists; it does not prove demand, and a competitor feature does not explain its ranking. Text is scraped and untrusted.',
  business_knowledge: 'Owner-provided business knowledge. Indicates relevance to the business, not search demand.',
  manual: 'Manually supplied customer questions. Representativeness and frequency are unknown unless stated.',
  fixture: 'SYNTHETIC fixture data for demos/tests. Never use in real recommendations.',
};

export interface CollectionWindow {
  start: string | null;
  end: string | null;
  timeZone: string | null;
  description: string;
  /** Writer-specific window metadata (e.g. Apify run id, search time range), kept for provenance. */
  details?: Record<string, unknown>;
}

/** A persisted discovery signal (content_signals row, parsed). */
export interface ContentSignal {
  id: string;
  siteId: string;
  origin: SignalOrigin;
  signalType: SignalType;
  text: string;
  normalizedHash: string;
  url: string | null;
  postedAt: string | null;
  collectedAt: string;
  collectionWindow: CollectionWindow | null;
  engagement: Record<string, unknown> | null;
  limitations: string;
  sourceId: string | null;
  apifyRunId: string | null;
  contentItemId: string | null;
  isSynthetic: boolean;
}

/** Signal as collected, before persistence. */
export interface SignalInput {
  origin: SignalOrigin;
  signalType: SignalType;
  text: string;
  url?: string | null;
  postedAt?: string | null;
  collectionWindow?: CollectionWindow | null;
  engagement?: Record<string, unknown> | null;
  limitations?: string;
  sourceId?: string | null;
  apifyRunId?: string | null;
  isSynthetic?: boolean;
}

// ---------------------------------------------------------------------------
// Stage schemas (zod) shared by stages, CLI JSON output, and checkpoints.
// ---------------------------------------------------------------------------

export const collectionWindowSchema = z.object({
  start: z.string().nullable(),
  end: z.string().nullable(),
  timeZone: z.string().nullable(),
  description: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const originCountsSchema = z.record(z.string(), z.number().int().min(0));

export const discoverOutputSchema = z.object({
  signalIds: z.array(z.string()),
  unassignedSignalIds: z.array(z.string()),
  countsByOrigin: originCountsSchema,
  newOrUpdated: z.number().int().min(0),
  excluded: z.object({
    sandboxKeywordMetrics: z.number().int().min(0),
    sandboxSerpSnapshots: z.number().int().min(0),
    quarantinedApifySignals: z.number().int().min(0),
    syntheticSignals: z.number().int().min(0),
  }),
  sourceStatus: z.array(z.object({ origin: z.string(), status: z.enum(['collected', 'empty', 'unavailable', 'disabled', 'skipped']), detail: z.string() })),
  window: collectionWindowSchema.nullable(),
});
export type DiscoverOutput = z.infer<typeof discoverOutputSchema>;

export const candidateSchema = z.object({
  key: z.string(),
  text: z.string(),
  signalIds: z.array(z.string()).min(1),
  origins: z.array(z.string()),
  signalTypes: z.array(z.string()),
  nearDuplicates: z.array(z.object({ signalId: z.string(), similarity: z.number(), method: z.string() })),
  isSynthetic: z.boolean(),
  /** Existing item this candidate's signals already belong to (anchors). */
  existingItemId: z.string().nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const dedupeOutputSchema = z.object({
  candidates: z.array(candidateSchema),
  exactDuplicatesMerged: z.number().int().min(0),
  nearDuplicatesMerged: z.number().int().min(0),
  method: z.string(),
});
export type DedupeOutput = z.infer<typeof dedupeOutputSchema>;

export const classificationSchema = z.object({
  key: z.string(),
  intent: z.enum(INTENTS),
  source: z.enum(['rule', 'model', 'fallback']),
  confidence: z.enum(['high', 'medium', 'low']),
  matchedRules: z.array(z.string()),
  formatHints: z.array(z.enum(['tool', 'template', 'comparison', 'checklist', 'guide'])),
  rationale: z.string(),
});
export type Classification = z.infer<typeof classificationSchema>;

export const classifyOutputSchema = z.object({
  candidates: z.array(candidateSchema),
  classifications: z.array(classificationSchema),
  ambiguousCount: z.number().int().min(0),
  modelCalls: z.number().int().min(0),
  modelStatus: z.string(),
  promptVersion: z.string().nullable(),
});
export type ClassifyOutput = z.infer<typeof classifyOutputSchema>;

export const clusterSchema = z.object({
  clusterId: z.string(),
  itemId: z.string(),
  label: z.string(),
  intent: z.enum(INTENTS),
  memberKeys: z.array(z.string()),
  memberTexts: z.array(z.string()),
  signalIds: z.array(z.string()),
  methods: z.array(z.string()),
  explanation: z.array(z.string()),
  uncertainty: z.string(),
  attachedToExisting: z.boolean(),
});
export type ClusterResult = z.infer<typeof clusterSchema>;

export const clusterOutputSchema = z.object({
  clusters: z.array(clusterSchema),
  itemIds: z.array(z.string()),
  newItems: z.number().int().min(0),
  attachedToExisting: z.number().int().min(0),
  method: z.string(),
  threshold: z.number(),
  semanticStatus: z.string(),
  serpOverlapStatus: z.string(),
});
export type ClusterOutput = z.infer<typeof clusterOutputSchema>;

export const itemIdsSchema = z.object({ itemIds: z.array(z.string()) });

export const demandOutputSchema = z.object({
  itemIds: z.array(z.string()),
  validated: z.number().int().min(0),
  weak: z.number().int().min(0),
  unvalidated: z.number().int().min(0),
});
export type DemandOutput = z.infer<typeof demandOutputSchema>;

export const existingOutputSchema = z.object({
  itemIds: z.array(z.string()),
  decisions: z.record(z.string(), z.number().int().min(0)),
  existingCheckStatus: z.enum(['complete', 'partial', 'unavailable']),
});
export type ExistingOutput = z.infer<typeof existingOutputSchema>;

export const prioritizeOutputSchema = z.object({
  ranked: z.array(z.object({ itemId: z.string(), title: z.string(), decision: z.string(), score: z.number().nullable(), selectable: z.boolean(), segment: z.enum(['non_branded', 'branded']).optional() })),
  capacity: z.object({ maxInProduction: z.number().int(), inProduction: z.number().int(), available: z.number().int(), batchEnabled: z.boolean(), pilotApproved: z.boolean() }),
  topItemId: z.string().nullable(),
  scoringVersion: z.string(),
});
export type PrioritizeOutput = z.infer<typeof prioritizeOutputSchema>;

// ---------------------------------------------------------------------------
// Demand / overlap / scoring structures stored in content_items JSON columns.
// ---------------------------------------------------------------------------

/** Measured value: missing is never 0. */
export type MeasuredNumber = { status: 'observed'; value: number } | { status: 'missing' | 'unavailable'; reason: string };

export interface DemandEvidence {
  status: 'validated' | 'weak' | 'unvalidated';
  statusReason: string;
  window: CollectionWindow | null;
  gsc: { impressions: MeasuredNumber; clicks: MeasuredNumber; weightedPosition: MeasuredNumber; queries: number; label: string };
  searchVolumeEstimate: { max: MeasuredNumber; keywords: Array<{ keyword: string; volume: number | null; provider: string; locationCode: number | null; languageCode: string | null; collectedAt: string }>; label: string };
  community: { threads: number; totalUpvotes: MeasuredNumber; totalComments: MeasuredNumber; label: string };
  manualQuestions: number;
  competitorGaps: number;
  businessKnowledge: number;
  origins: Record<string, number>;
  signalCount: number;
  examples: Array<{ signalId: string; origin: string; text: string; url: string | null }>;
  limitations: string[];
  sandboxExcluded: number;
  /**
   * Whether each countable source was actually collected in the discovery run
   * that computed this evidence (from discover's sourceStatus). A count of 0
   * is only an observation when its source was collected; otherwise it is
   * DATA_UNAVAILABLE.
   */
  sourceCollection?: Record<string, { status: 'collected' | 'empty' | 'unavailable' | 'disabled' | 'skipped'; detail: string }>;
}

export interface PageOverlap {
  pageId: string;
  url: string;
  pageType: string | null;
  gscImpressions: number | null;
  gscClicks: number | null;
  gscPosition: number | null;
  lexicalSimilarity: number;
  headingMatches: string[];
  score: number;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface OverlapResult {
  status: 'complete' | 'partial' | 'unavailable';
  statusReason: string;
  pages: PageOverlap[];
  cannibalization: { risk: 'high' | 'medium' | 'low' | 'unknown'; explanation: string };
  uncertainty: string;
}

export interface ScoreComponents {
  relevance: number;
  demand: number;
  demandAdjusted: number;
  intentValue: number;
  originalValue: number;
  effort: number;
  riskPenalty: number;
  confidence: number;
  weights: Record<string, number>;
  formula: string;
  limitations: string[];
}

/** demand_json: demand evidence plus classification, decision inputs, and scoring. */
export type ItemDemand = DemandEvidence & {
  scoring?: ScoreComponents & { score: number };
  classification?: { intents: string[]; sources: string[]; rationale: string[] };
  formatHints?: string[];
  relationStrength?: 'strong' | 'weak' | 'none' | 'unknown';
  originalValueAvailable?: boolean;
  /** Branded cluster (names the site's own brand): ranked in a separate, lower-priority segment. */
  branded?: boolean;
  /** Set on items created/selected by the low-data bootstrap. */
  bootstrap?: 'offer_page' | 'supporting_page';
};

/** Parsed content_items row. */
export interface ContentItem {
  id: string;
  siteId: string;
  title: string;
  primaryQuestion: string | null;
  stage: ContentStage;
  decision: ContentDecision | null;
  decisionReason: string | null;
  intent: Intent | null;
  clusterId: string | null;
  targetPageId: string | null;
  whyExists: string | null;
  whoBenefits: string | null;
  businessRelation: string | null;
  originalValue: string | null;
  readerNextStep: string | null;
  demand: ItemDemand | null;
  overlap: OverlapResult | null;
  priorityScore: number | null;
  isSynthetic: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export const PAGE_TYPES = ['article', 'guide', 'faq_section', 'comparison', 'tool', 'template', 'offer', 'category', 'product', 'landing', 'other'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const evidenceSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['signal', 'metric', 'product_fact', 'approved_claim', 'page', 'memory', 'catalog_attribute']),
  origin: z.string(),
  label: z.string(),
  excerpt: z.string(),
  url: z.string().nullable(),
  collectedAt: z.string().nullable(),
  trustClass: z.string(),
  window: collectionWindowSchema.nullable(),
  limitations: z.string(),
  isSynthetic: z.boolean(),
  isSandbox: z.boolean(),
});
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const catalogAttributeSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  source: z.enum(['catalog', 'owner', 'image', 'model']),
  validated: z.boolean(),
});
export type CatalogAttribute = z.infer<typeof catalogAttributeSchema>;

export const briefSchema = z.object({
  schemaVersion: z.literal(1),
  contentItemId: z.string(),
  siteId: z.string(),
  language: z.string(),
  audience: z.string(),
  primaryQuestion: z.string(),
  queryCluster: z.object({ clusterId: z.string().nullable(), label: z.string(), queries: z.array(z.string()), signalCount: z.number().int(), origins: z.array(z.string()) }),
  intent: z.enum(INTENTS),
  decision: z.enum(CONTENT_DECISIONS),
  proposedUrl: z.string().nullable(),
  targetPageUrl: z.string().nullable(),
  pageType: z.enum(PAGE_TYPES),
  existingPageOverlap: z.object({
    status: z.string(),
    pages: z.array(z.object({ url: z.string(), confidence: z.string(), score: z.number(), evidence: z.array(z.string()) })),
    cannibalizationRisk: z.string(),
    uncertainty: z.string(),
  }),
  businessPurpose: z.string(),
  researchFindings: z.array(z.object({ finding: z.string(), evidenceIds: z.array(z.string()), label: z.enum(['OBSERVED', 'INFERRED', 'HYPOTHESIS', 'DATA_UNAVAILABLE']) })),
  evidenceSources: z.array(evidenceSourceSchema),
  uniqueContribution: z.string(),
  /**
   * Evidence ids backing the unique contribution: owner product facts, approved claims/differentiators,
   * owner-approved business notes, or validated catalog attributes. Search impressions and customer
   * questions are demand evidence, not original value. Optional for briefs stored before brief-gate@2.
   */
  uniqueContributionEvidenceIds: z.array(z.string()).optional(),
  outline: z.array(z.object({ heading: z.string(), purpose: z.string(), answers: z.array(z.string()), evidenceIds: z.array(z.string()) })),
  usefulExamples: z.array(z.object({ description: z.string(), evidenceIds: z.array(z.string()), needsOwnerInput: z.boolean() })),
  internalLinks: z.array(z.object({ targetUrl: z.string(), anchorSuggestion: z.string(), reason: z.string(), verified: z.boolean() })),
  cta: z.object({ text: z.string(), targetUrl: z.string().nullable(), conversionEvent: z.string().nullable(), rationale: z.string() }),
  unresolvedQuestions: z.array(z.object({ question: z.string(), whyItMatters: z.string(), blocking: z.boolean() })),
  productFactIds: z.array(z.string()),
  catalogAttributes: z.array(catalogAttributeSchema),
  programmatic: z.object({ isProgrammatic: z.boolean(), templateId: z.string().nullable(), differentiatingData: z.array(z.object({ field: z.string(), value: z.string(), evidenceIds: z.array(z.string()) })) }),
  demandSummary: z.array(z.object({ metric: z.string(), value: z.string(), label: z.string() })),
  rationale: z.object({ whyExists: z.string(), whoBenefits: z.string(), businessRelation: z.string(), originalValue: z.string(), readerNextStep: z.string() }),
  generatedBy: z.object({ synthesized: z.boolean(), promptVersion: z.string().nullable(), model: z.string().nullable(), note: z.string() }),
  isSynthetic: z.boolean(),
  bootstrap: z.enum(['offer_page', 'supporting_page']).nullable(),
});
export type ContentBrief = z.infer<typeof briefSchema>;

export interface GateIssue {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface BriefGateResult {
  passed: boolean;
  issues: GateIssue[];
  checkedAt: string;
  gateVersion: string;
  /** Hash of the brief's inputs (deterministic assembly + synthesis request); an unchanged brief is reused. */
  inputsHash?: string;
}

export interface BriefRecord {
  id: string;
  siteId: string;
  contentItemId: string;
  version: number;
  status: 'draft' | 'gate_passed' | 'gate_failed' | 'approved' | 'superseded';
  brief: ContentBrief;
  contentHash: string;
  gate: BriefGateResult | null;
  vaultPath: string | null;
  promptVersion: string | null;
  modelId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Draft package
// ---------------------------------------------------------------------------

export const structuredDataProposalSchema = z.object({
  type: z.string().min(1),
  jsonLd: z.record(z.string(), z.unknown()),
  visibleContentBasis: z.string(),
});

export const draftModelOutputSchema = z.object({
  titleOptions: z.array(z.string().min(1)).min(1).max(5),
  metaDescription: z.string().min(1),
  slugSuggestion: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  internalLinkSuggestions: z.array(z.object({ targetUrl: z.string(), anchor: z.string(), placement: z.string() })),
  structuredDataProposal: structuredDataProposalSchema.nullable(),
  sourceLedger: z.array(z.object({ claim: z.string(), evidenceIds: z.array(z.string()), factIds: z.array(z.string()) })),
  factCheckNotes: z.array(z.object({ statement: z.string(), status: z.enum(['verified', 'unverified', 'needs_owner_input']), evidenceIds: z.array(z.string()), note: z.string() })),
});
export type DraftModelOutput = z.infer<typeof draftModelOutputSchema>;

export interface DraftPackage {
  schemaVersion: 1;
  contentItemId: string;
  briefId: string;
  briefVersion: number;
  briefHash: string;
  language: string;
  body: string;
  titleOptions: string[];
  metaDescription: string;
  slugSuggestion: string;
  internalLinkSuggestions: Array<{ targetUrl: string; anchor: string; placement: string; verified: boolean }>;
  structuredDataProposal: { type: string; jsonLd: Record<string, unknown>; visibleContentBasis: string; note: string } | null;
  sourceLedger: Array<{ claim: string; evidenceIds: string[]; factIds: string[]; status: 'supported' | 'unknown_reference' }>;
  factCheckNotes: FactCheckNote[];
  unresolvedFacts: string[];
  publicationBlockers: string[];
  generatedBy: { promptVersion: string; model: string; callId: string; costMicros: number | null; synthetic: boolean; truncatedEvidence: string[] };
  revisionRound: number;
  /** What authorized generation: the item's draft_generation approval or an approved batch. */
  authorization: DraftAuthorization;
  disclaimer: string;
  isSynthetic: boolean;
  /**
   * Set when a named human wrote this version (`content revise-manual`): the
   * body is the human's text, not model output. Automated revisions never
   * rewrite a human-authored version.
   */
  humanRevision?: HumanRevision;
}

/**
 * A fact-check note. `status: 'verified'` alone is the writer model's claim:
 * code keeps it only when a cited product fact or trusted evidence item states
 * the statement (see `factNoteSupport`); otherwise the note is downgraded to
 * `unverified` (`downgraded`) and the statement is marked `[[UNVERIFIED: ...]]`.
 * A note confirmed by a named human carries `humanResolution`.
 */
export interface FactCheckNote {
  statement: string;
  status: 'verified' | 'unverified' | 'needs_owner_input';
  evidenceIds: string[];
  note: string;
  /** Code changed the model's "verified" to "unverified" (no resolvable evidence states it). */
  downgraded?: { from: 'verified'; reason: string };
  /** A named human confirmed the statement with a source (`content revise-manual --resolutions`). */
  humanResolution?: HumanFactResolution;
}

export const FACT_RESOLUTION_ACTIONS = ['confirmed', 'removed'] as const;
export type FactResolutionAction = (typeof FACT_RESOLUTION_ACTIONS)[number];

/** Where a human resolution's source points: a configured product fact, another owner statement, a brief evidence id, or text the human supplied (URL, document, owner confirmation). */
export type FactResolutionSourceKind = 'product_fact' | 'owner_statement' | 'brief_evidence' | 'human_supplied';

/** One resolution entry as a human supplies it (`--resolutions <file.json>`). */
export const factResolutionInputSchema = z.object({
  /** The marker text (`[[UNVERIFIED: <marker>]]`) or the fact-check statement being resolved. */
  marker: z.string().trim().min(1),
  /** confirmed: the statement stays in the body as a fact; removed: it was deleted from the body. */
  action: z.enum(FACT_RESOLUTION_ACTIONS),
  /** Required: where the fact was confirmed (product fact id, evidence id, URL, document, owner confirmation) or the basis for removing it. */
  source: z.string().trim().min(1),
  /** The confirmed wording as it appears in the new body (defaults to the marker text). */
  statement: z.string().trim().min(1).optional(),
  note: z.string().optional(),
});
export type FactResolutionInput = z.infer<typeof factResolutionInputSchema>;
export const factResolutionsFileSchema = z.array(factResolutionInputSchema).max(500);

/** A recorded human resolution of one unresolved fact. */
export interface HumanFactResolution {
  marker: string;
  action: FactResolutionAction;
  /** The statement as it appears in the new body (confirmed) or the statement that was removed. */
  statement: string;
  source: string;
  sourceKind: FactResolutionSourceKind;
  note: string | null;
  reviewer: string;
  at: string;
}

/** Provenance of a human-authored draft version. */
export interface HumanRevision {
  reviewer: string;
  at: string;
  previousDraftId: string;
  previousVersion: number;
  previousBodyHash: string;
  note: string | null;
  /** One entry per resolved fact (every removed marker has one). */
  resolutions: HumanFactResolution[];
  markersBefore: string[];
  markersAfter: string[];
  /** Markers the human added in this version. */
  addedMarkers: string[];
}

export type DraftAuthorization =
  | { kind: 'item'; approvalId: string; briefId: string; briefHash: string }
  | { kind: 'batch'; approvalId: string; batchKey: string; artifactHash: string };

export type DraftStatus = 'draft' | 'needs_revision' | 'needs_human_review' | 'rejected' | 'review_passed' | 'approved' | 'exported' | 'published' | 'superseded';

export interface DraftRecord {
  id: string;
  siteId: string;
  contentItemId: string;
  briefId: string;
  briefVersion: number;
  briefHash: string;
  version: number;
  status: DraftStatus;
  pkg: DraftPackage;
  bodyHash: string;
  unresolvedFacts: number;
  revisionRound: number;
  vaultPath: string | null;
  promptVersion: string | null;
  modelId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Quality review
// ---------------------------------------------------------------------------

export const VERDICTS = ['pass', 'needs_revision', 'needs_human_review', 'reject'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What a failed check leads to: reject outright, automated revision, or human review. */
export type CheckConsequence = 'reject' | 'revise' | 'human';

export interface QualityFinding {
  level: 'fail' | 'warn';
  /** fail findings: reject/revise/human. warn findings: human (needs a reviewer) or info (heuristic note only). */
  consequence: CheckConsequence | 'info';
  detail: string;
  evidenceRefs: string[];
  fix: string;
}

export interface QualityCheck {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'not_applicable' | 'not_checked';
  /** Most severe consequence among findings (for display). */
  consequence: CheckConsequence | 'info';
  message: string;
  findings: QualityFinding[];
}

export interface QualityReason {
  code: string;
  message: string;
  consequence: CheckConsequence;
  evidenceRefs: string[];
  fix: string;
}

export const aiReviewOutputSchema = z.object({
  verdict: z.enum(VERDICTS),
  issues: z.array(
    z.object({
      category: z.enum(['accuracy', 'unsupported_claim', 'coverage', 'intent', 'duplication', 'voice', 'structure', 'privacy', 'other']),
      severity: z.enum(['critical', 'major', 'minor']),
      quote: z.string().max(400),
      explanation: z.string(),
      suggestedFix: z.string(),
    }),
  ),
  coverageGaps: z.array(z.string()),
  summary: z.string(),
});
export type AiReviewOutput = z.infer<typeof aiReviewOutputSchema>;

export interface AiReviewRecord {
  status: 'completed' | 'unavailable' | 'skipped';
  reason: string;
  output: AiReviewOutput | null;
  droppedIssues: number;
  promptVersion: string | null;
  model: string | null;
  costMicros: number | null;
  disclaimer: string;
  /**
   * True when the gateway truncated part of the review context (the draft body, the brief, or evidence):
   * the reviewer did not see everything, so the review is partial and never counts as a full review.
   */
  partialReview?: boolean;
  /** Truncation records reported by the gateway for this review call. */
  truncation?: Array<{ evidenceId: string; originalTokens: number; keptTokens: number; note: string }>;
  /**
   * Every part of the review input the reviewer did NOT see in full, stated plainly: gateway
   * truncation (with kept/original token estimates), evidence sources not sent at all (review
   * bound), and a model output cut at the output token limit. Empty/absent for a full review.
   */
  notReviewed?: Array<{ id: string; label: string; detail: string }>;
  /**
   * The model's own verdict when the review was partial. A partial review's verdict is forced
   * to `needs_human_review` in `output.verdict`, because the model judged content it did not
   * fully see.
   */
  modelVerdict?: Verdict;
}

export interface QualityReviewResult {
  reviewId: string | null;
  subjectType: 'brief' | 'draft';
  subjectId: string;
  verdict: Verdict;
  checks: QualityCheck[];
  aiReview: AiReviewRecord;
  reasons: QualityReason[];
  revisionRound: number;
  revisionLimitReached: boolean;
  humanReviewRequiredForPublication: true;
}
