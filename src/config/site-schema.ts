import { z } from 'zod';
import { isValidTimeZone } from '../core/time.js';
import { toMicros } from '../core/money.js';

/**
 * Validated per-site configuration. Business configuration only: secrets are
 * stored separately (see src/config/secrets.ts). Unknown business facts stay
 * `null`/empty rather than being invented.
 *
 * Every field has a description; `npm run cli -- config schema` prints them and
 * docs/CONFIGURATION.md is generated from the same source
 * (`describeSiteConfigFields()`; a test fails when the document drifts).
 */

export const SITE_CONFIG_SCHEMA_VERSION = 1;

const DECIMAL_RE = /^\d+(\.\d{1,6})?$/;
const DECIMAL_MESSAGE = 'Use a non-negative decimal amount with at most 6 fractional digits, e.g. "5.00"';
/**
 * Sanity ceiling for configured amounts (one billion). Far above any real
 * budget or conversion value, and low enough that sums of several amounts in
 * integer micros stay exact (below Number.MAX_SAFE_INTEGER).
 */
export const MAX_DECIMAL_AMOUNT = '1000000000';
const MAX_AMOUNT_MICROS = toMicros(MAX_DECIMAL_AMOUNT);

/**
 * Non-negative decimal amount kept as an exact string. YAML numbers (`5`,
 * `0.5`) are accepted and converted to their decimal string; negative values,
 * exponents, more than 6 fractional digits, and amounts above
 * MAX_DECIMAL_AMOUNT are rejected with the field path.
 */
const decimalAmount = () =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
    .pipe(
      z
        .string()
        .regex(DECIMAL_RE, DECIMAL_MESSAGE)
        .refine((v) => {
          try {
            return toMicros(v) <= MAX_AMOUNT_MICROS;
          } catch {
            return false;
          }
        }, `Amount must be at most ${MAX_DECIMAL_AMOUNT}`),
    );

const usd = decimalAmount().describe('Decimal USD amount as a string, e.g. "5.00". Stored internally as integer micro-USD.');

const timeZone = z.string().refine(isValidTimeZone, 'Must be a valid IANA time zone such as "Europe/Tallinn"');

const siteId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Site ID must be lowercase letters, digits, and hyphens (2-63 chars)');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date as YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Use a real calendar date as YYYY-MM-DD');

/**
 * Router rule identifiers accepted by `router.ruleOrder`. Kept inline (the
 * config layer does not import src/router); the router validates that it
 * knows every identifier it is given.
 */
export const ROUTER_RULE_IDS = [
  'invalid_data',
  'technical_blocker',
  'experiment_active',
  'healthy',
  'ranking',
  'ctr',
  'conversion',
  'decline',
  'content',
  'indexing_unknown',
  'low_data',
  'irrelevant',
] as const;
export type RouterRuleId = (typeof ROUTER_RULE_IDS)[number];

const eventDef = z.object({
  name: z.string().min(1).describe('Exact GA4 event name, e.g. "generate_lead". Case-sensitive.'),
  meaning: z.string().min(1).describe('What this event means for the business, e.g. "Demo request form submitted".'),
  kind: z.enum(['purchase', 'lead', 'signup', 'booking', 'subscription', 'other']).default('other').describe('Business outcome category of the event.'),
  value: z
    .object({
      amount: decimalAmount().describe('Configured value per conversion as a decimal string, e.g. "120.00".'),
      currency: z.string().length(3).describe('ISO 4217 currency code of the configured value, e.g. "EUR".'),
    })
    .nullable()
    .default(null)
    .describe('Configured business value per conversion when known. Leave null when unknown; never guessed.'),
  verifiedAt: isoDate
    .nullable()
    .default(null)
    .describe('When the owner last verified that this event fires for the stated business outcome (YYYY-MM-DD). Null when never verified.'),
  verificationNote: z.string().nullable().default(null).describe('How the event was verified (e.g. "test submission seen in GA4 DebugView"). Null when not recorded.'),
});

const productFact = z.object({
  id: z.string().min(1).describe('Stable identifier used to cite this fact from briefs and drafts.'),
  statement: z.string().min(1).describe('The verified product fact, stated plainly.'),
  source: z.string().nullable().default(null).describe('Where this fact is verified (URL, document, or "owner").'),
  verifiedAt: z.string().nullable().default(null).describe('When the fact was last verified (YYYY-MM-DD). Null when never verified.'),
});

const searchLocation = z.object({
  name: z.string().nullable().default(null).describe('Human label, e.g. "Estonia".'),
  locationCode: z.number().int().nullable().default(null).describe('Provider location code (resolved during setup; never guessed).'),
  languageCode: z.string().min(2).describe('Language code for research requests, e.g. "et" or "en".'),
});

export const FEATURE_KEYS = [
  'gsc',
  'ga4',
  'crawl',
  'playwright',
  'pagespeed',
  'urlInspection',
  'llm',
  'embeddings',
  'qdrant',
  'obsidian',
  'dataforseo',
  'apify',
  'contentDiscovery',
  'aiCitations',
  'dataforseoBacklinks',
  'dataforseoLabsExports',
  'dataforseoAiVisibility',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** What each feature flag enables (used for schema descriptions and docs). */
export const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  gsc: 'Google Search Console ingestion (read-only).',
  ga4: 'Google Analytics 4 Data API ingestion (read-only).',
  crawl: 'Direct HTTP crawl of the own site (robots.txt respected, SSRF-safe).',
  playwright: 'Optional browser rendering when direct HTML is insufficient (requires Playwright to be installed).',
  pagespeed: 'PageSpeed Insights (lab) and CrUX (field) performance checks.',
  urlInspection: 'Search Console URL Inspection for a bounded number of URLs per run.',
  llm: 'LLM Gateway analysis. Effective only when a model connection is configured.',
  embeddings: 'Embedding calls for vector memory (billed against the LLM Gateway budget).',
  qdrant: 'Qdrant vector index (rebuildable; full-text fallback when disabled or down).',
  obsidian: 'Obsidian-compatible Markdown vault output (works without launching Obsidian).',
  dataforseo: 'DataForSEO research requests (budgeted; mode set in research.dataforseo.mode).',
  apify: 'Apify content-research actor runs (budgeted; pinned build required).',
  contentDiscovery: 'Content discovery/research queue (never drafts or publishes automatically).',
  aiCitations: 'Optional AI-search citation checks. Off in every profile until explicitly enabled.',
  dataforseoBacklinks: 'Paid DataForSEO backlinks add-on. Off until explicitly approved.',
  dataforseoLabsExports: 'Paid DataForSEO Labs exports. Off until explicitly approved.',
  dataforseoAiVisibility: 'Paid DataForSEO AI-visibility add-on. Off until explicitly approved.',
};

const featureFlags = z
  .object(
    Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean().optional().describe(FEATURE_DESCRIPTIONS[k])])) as Record<FeatureKey, z.ZodOptional<z.ZodBoolean>>,
  )
  .describe('Explicit feature flags. Unset flags inherit from the setup profile. Integrations also require credentials.');

export const siteConfigSchema = z.object({
  schemaVersion: z.literal(SITE_CONFIG_SCHEMA_VERSION).default(SITE_CONFIG_SCHEMA_VERSION).describe('Site configuration format version. Currently 1.'),
  profile: z.enum(['demo', 'core', 'full']).default('core').describe('Setup profile: demo (fixtures only), core (Google + crawl + SQLite + Markdown), full (all integrations).'),
  site: z
    .object({
      id: siteId.describe('Stable site identifier used in every database row, job, budget, and vector.'),
      businessName: z.string().min(1).describe('Business or brand name shown in reports.'),
      url: z
        .url({ protocol: /^https?$/, error: 'Use an absolute http(s) URL, e.g. "https://www.example.com/"' })
        .describe('Canonical site URL including scheme, e.g. "https://www.example.com/".'),
      allowedHostnames: z.array(z.string().min(1)).min(1).describe('Hostnames treated as this site. www/non-www are NOT merged automatically.'),
      urlAliases: z
        .array(
          z.object({
            alias: z.string().min(1).describe('Alias URL (as reported by a data source).'),
            canonical: z.string().min(1).describe('Canonical URL the alias is equivalent to.'),
            evidence: z.string().nullable().default(null).describe('Evidence establishing the equivalence (redirect, canonical tag, owner statement).'),
          }),
        )
        .default([])
        .describe('Known URL aliases with the evidence establishing equivalence.'),
      pageTypes: z
        .array(
          z.object({
            match: z
              .string()
              .min(1)
              .describe('URL-path glob matched against the normalized path; "*" is a wildcard, e.g. "/products/*". First matching rule wins.'),
            type: z.string().min(1).describe('Page type assigned to matching pages, e.g. "product", "offer", "category", "tool", "article".'),
          }),
        )
        .default([])
        .describe('Owner-declared page types by URL path (first matching rule wins). Empty by default.'),
    })
    .describe('Website identity. Required.'),
  business: z
    .object({
      offer: z.string().nullable().default(null).describe('What the business sells or offers. Null when not yet provided.'),
      targetCustomer: z.string().nullable().default(null).describe('Who the offer is for. Null when not yet provided.'),
      differentiators: z.array(z.string()).default([]).describe('Real, verifiable differentiators. Never invented.'),
      productFacts: z.array(productFact).default([]).describe('Verified product facts that drafts may cite.'),
      approvedClaims: z.array(z.string()).default([]).describe('Marketing claims the owner has approved for use.'),
      prohibitedClaims: z.array(z.string()).default([]).describe('Claims that must never appear in drafts or recommendations.'),
    })
    .prefault({})
    .describe('Business facts used for relevance and drafting. Unknown facts stay null/empty.'),
  market: z
    .object({
      countries: z.array(z.string().min(2).max(3)).default([]).describe('Target countries (ISO 3166-1 alpha-2 or alpha-3).'),
      languages: z.array(z.string().min(2)).default([]).describe('Content/target languages (BCP 47).'),
      searchLocations: z.array(searchLocation).default([]).describe('Search locations used for external research requests.'),
      devices: z.array(z.enum(['desktop', 'mobile', 'tablet'])).default(['desktop', 'mobile']).describe('Devices considered for research and reporting.'),
    })
    .prefault({})
    .describe('Target market. Never inferred from the scheduler time zone.'),
  reporting: z
    .object({
      currency: z.string().length(3).nullable().default(null).describe('Reporting currency (ISO 4217). Unknown stays null.'),
      businessTimezone: timeZone.nullable().default(null).describe('Business timezone for reports. Not inferred from the scheduler timezone.'),
    })
    .prefault({})
    .describe('Reporting preferences. The business time zone (or the scheduler zone when null) also defines budget periods.'),
  scheduler: z
    .object({
      timezone: timeZone.default('Europe/Tallinn').describe("Scheduler timezone. Does NOT imply the website's target market."),
      weekly: z
        .object({
          enabled: z.boolean().default(false).describe('Run the weekly job on schedule (installation is opt-in).'),
          cron: z.string().default('0 7 * * 1').describe('Cron expression evaluated in scheduler.timezone.'),
        })
        .prefault({})
        .describe('Weekly job schedule.'),
      monthly: z
        .object({
          enabled: z.boolean().default(false).describe('Run the monthly job on schedule (installation is opt-in).'),
          cron: z.string().default('0 8 2 * *').describe('Cron expression evaluated in scheduler.timezone.'),
        })
        .prefault({})
        .describe('Monthly job schedule.'),
    })
    .prefault({})
    .describe('Local/server scheduling preferences. IANA time zones only; DST is handled by the scheduler.'),
  google: z
    .object({
      searchConsoleProperty: z
        .string()
        .regex(/^(sc-domain:[a-z0-9.-]+|https?:\/\/.+\/)$/i, 'Use an exact property: "sc-domain:example.com" or a URL-prefix ending in "/"')
        .nullable()
        .default(null)
        .describe('Exact Search Console property, discovered via `auth status`; never constructed by guessing.'),
      ga4PropertyId: z.string().regex(/^\d+$/, 'Numeric GA4 property ID').nullable().default(null).describe('Numeric GA4 property ID (not the "G-" measurement ID).'),
      gsc: z
        .object({
          initialHistoryDays: z.number().int().min(1).max(486).default(90).describe('Days of history fetched on the first sync.'),
          refreshRecentDays: z.number().int().min(1).max(30).default(10).describe('Recent days re-fetched on each sync to capture revisions.'),
          searchTypes: z
            .array(z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']))
            .default(['web'])
            .describe('Search types synced. Each is a separate dataset.'),
          pageQueryTopPages: z.number().int().min(1).max(500).default(50).describe('Targeted page/query detail is fetched only for this many top pages.'),
          urlInspectionMaxPerRun: z.number().int().min(0).max(200).default(20).describe('Maximum URL Inspection requests per run.'),
        })
        .prefault({})
        .describe('Search Console ingestion limits.'),
      ga4: z
        .object({
          initialHistoryDays: z.number().int().min(1).max(730).default(90).describe('Days of history fetched on the first sync.'),
          refreshRecentDays: z.number().int().min(1).max(30).default(4).describe('Recent days re-fetched on each sync to capture revisions.'),
        })
        .prefault({})
        .describe('GA4 ingestion limits.'),
    })
    .prefault({})
    .describe('Google data sources. Credentials live in the secret store, never here.'),
  conversions: z
    .object({
      primaryEvents: z.array(eventDef).default([]).describe('Primary conversion events (the business outcomes that count).'),
      secondaryEvents: z.array(eventDef).default([]).describe('Secondary events reported separately, never mixed into primary conversions.'),
    })
    .prefault({})
    .describe('Conversion definitions. Event names are exact and case-sensitive.'),
  brand: z
    .object({ aliases: z.array(z.string().min(1)).default([]).describe('Brand spellings used to classify branded queries.') })
    .prefault({})
    .describe('Branded-query classification.'),
  crawl: z
    .object({
      protectedPaths: z.array(z.string()).default([]).describe('Paths that must never be proposed for deletion, redirect, or noindex without explicit owner review.'),
      excludedPaths: z.array(z.string()).default([]).describe('Paths the crawler skips.'),
      maxPages: z.number().int().min(1).max(10_000).default(200).describe('Maximum pages fetched per own-site crawl.'),
      maxDepth: z.number().int().min(0).max(20).default(6).describe('Maximum link depth from the start URL.'),
      maxSitemapUrls: z.number().int().min(1).max(100_000).default(5_000).describe('Maximum URLs read from sitemaps.'),
      maxSitemapFiles: z.number().int().min(1).max(500).default(20).describe('Maximum sitemap files fetched (including indexes).'),
      requestDelayMs: z.number().int().min(0).max(60_000).default(1_000).describe('Delay between requests to the same host, in milliseconds.'),
      perHostConcurrency: z.number().int().min(1).max(8).default(2).describe('Concurrent requests per host.'),
      timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000).describe('Per-request timeout in milliseconds.'),
      maxBytes: z.number().int().min(10_000).max(50_000_000).default(5_000_000).describe('Maximum response body size in bytes.'),
      maxRedirects: z.number().int().min(0).max(10).default(5).describe('Maximum redirects followed (each hop is re-validated for SSRF).'),
      userAgent: z.string().default('seo-agent/0.1 (+self-hosted; respects robots.txt)').describe('User-Agent sent by the crawler.'),
      competitorPagesPerQuery: z.number().int().min(0).max(10).default(5).describe('Competitor pages crawled per shortlisted query.'),
      competitorPagesPerQueryMax: z.number().int().min(0).max(10).default(10).describe('Hard ceiling for competitorPagesPerQuery.'),
    })
    .prefault({})
    .describe('Crawler limits. The crawler is bounded and never fetches private network addresses.'),
  research: z
    .object({
      approvedDomains: z.array(z.string()).default([]).describe('Domains approved for research crawling beyond SERP competitors.'),
      competitors: z
        .array(
          z.object({
            domain: z.string().min(1).describe('Competitor domain, e.g. "competitor.example".'),
            name: z.string().nullable().default(null).describe('Optional display name.'),
          }),
        )
        .default([])
        .describe('Known competitors.'),
      seedTopics: z.array(z.string()).default([]).describe('Seed topics for content discovery.'),
      subreddits: z.array(z.string()).default([]).describe('Optional relevant subreddits for community research.'),
      seriousQueriesPerRun: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(3)
        .describe('Shortlisted queries that may receive paid SERP research per run. The spec asks for 3-5; values above 5 are accepted (hard maximum 10) but produce a warning.'),
      dataforseo: z
        .object({
          mode: z.enum(['disabled', 'sandbox', 'live']).default('disabled').describe('"sandbox" returns synthetic data that is never used in recommendations.'),
          queue: z.enum(['standard', 'live']).default('standard').describe('Prefer standard queued tasks; live only when latency justifies the cost.'),
          liveQueueJustification: z
            .string()
            .nullable()
            .default(null)
            .describe('Why the more expensive live queue is needed (recorded with the decision). Null when not given; queue "live" without a justification produces a warning.'),
          serpDepth: z.number().int().min(10).max(100).default(10).describe('SERP results requested per query (billing may depend on depth).'),
          cacheDays: z
            .object({
              serp: z.number().int().min(0).default(7).describe('Days a SERP snapshot is reused before a paid refresh.'),
              keywordVolume: z.number().int().min(0).default(30).describe('Days keyword volume data is reused.'),
              competitor: z
                .number()
                .int()
                .min(0)
                .default(14)
                .describe('Days crawled competitor pages and gated competitor-endpoint responses are reused before a refresh. Pages with a recently detected change are refreshed sooner.'),
            })
            .prefault({})
            .describe('Cache lifetimes that avoid repeat paid requests.'),
          pricingOverrides: z
            .record(z.string(), usd)
            .default({})
            .describe('Verified per-task prices by endpoint key (USD). Without a verified price, paid calls require approval.'),
        })
        .prefault({})
        .describe('DataForSEO settings.'),
      apify: z
        .object({
          actorId: z.string().default('9sHOY9RzPYGjmTHo8').describe('Authoritative Actor ID. Do not substitute another actor without approval.'),
          build: z.string().nullable().default(null).describe('Pinned, verified build (tag or number). Null until verified via `apify inspect`.'),
          maxItems: z.number().int().min(1).max(10_000).default(50).describe('Maximum dataset items per run.'),
          maxCommentsPerPost: z.number().int().min(0).max(500).default(10).describe('Maximum comments collected per post.'),
          timeRange: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).default('month').describe('Time range of collected posts.'),
          maxRunSeconds: z.number().int().min(30).max(3_600).default(300).describe('Provider-side run timeout in seconds.'),
          maxTotalChargeUsd: usd.default('1.00').describe('Provider-side maximum total charge per run (USD), where the actor supports it.'),
          memoryMbytes: z.number().int().min(128).max(32_768).default(512).describe('Run memory in MB (affects compute-unit and possibly start charges; 512 matches the actor default per docs/integration-contracts.md).'),
        })
        .prefault({})
        .describe('Apify content-research actor settings.'),
    })
    .prefault({})
    .describe('External research settings. Paid research is budgeted and limited to shortlisted opportunities.'),
  editorial: z
    .object({
      brandVoice: z.string().default('Clear, direct, specific. Plain language. No hype.').describe('Brand voice guidance for drafts.'),
      requirements: z.array(z.string()).default([]).describe('Additional editorial requirements.'),
      avoidEmojis: z.boolean().default(true).describe('Drafts avoid emojis.'),
      avoidEmDashes: z.boolean().default(true).describe('Drafts avoid em dashes.'),
    })
    .prefault({})
    .describe('Editorial rules applied by quality gates.'),
  models: z
    .object({
      cheap: z.string().nullable().default(null).describe('Model ID for extraction/classification. Overridden by CHEAP_MODEL.'),
      reasoning: z.string().nullable().default(null).describe('Model ID for synthesis/prioritization. Overridden by REASONING_MODEL.'),
      embedding: z.string().nullable().default(null).describe('Embedding model ID. Overridden by EMBEDDING_MODEL.'),
      embeddingDimensions: z.number().int().min(8).max(8_192).nullable().default(null).describe('Verified embedding dimensions; discovered on first use when null.'),
    })
    .prefault({})
    .describe('Model IDs. No model is hardcoded; unset means AI features report "not configured".'),
  llm: z
    .object({
      maxOutputTokensCheap: z.number().int().min(64).max(32_000).default(1_500).describe('Output token ceiling for cheap-tier calls (bounds the cost estimate).'),
      maxOutputTokensReasoning: z.number().int().min(256).max(64_000).default(6_000).describe('Output token ceiling for reasoning-tier calls.'),
      maxInputTokens: z.number().int().min(1_000).max(1_000_000).default(24_000).describe('Input token ceiling per call (evidence is truncated with a recorded note).'),
      maxRepairAttempts: z.number().int().min(0).max(2).default(2).describe('Bounded repair attempts for malformed structured output.'),
      requestTimeoutMs: z.number().int().min(5_000).max(900_000).default(120_000).describe('Per-request timeout in milliseconds.'),
      allowPersonalData: z
        .boolean()
        .default(false)
        .describe('Whether evidence sent to the LLM Gateway may include personal data (names, emails, phone numbers, user handles). Default false. Setting it to true requires llm.personalDataReason.'),
      personalDataReason: z
        .string()
        .nullable()
        .default(null)
        .describe('Why personal data may be sent to the LLM Gateway (required when llm.allowPersonalData is true; echoed in warnings).'),
      pricingOverrides: z
        .record(
          z.string(),
          z.object({
            inputPerMillionUsd: usd.describe('Verified USD price per 1M input tokens.'),
            outputPerMillionUsd: usd.describe('Verified USD price per 1M output tokens.'),
          }),
        )
        .default({})
        .describe('Verified per-model prices when the gateway does not report them.'),
    })
    .prefault({})
    .describe('LLM call limits.'),
  memory: z
    .object({
      chunkMinTokens: z.number().int().min(50).default(400).describe('Minimum chunk size in tokens.'),
      chunkTargetTokens: z.number().int().min(100).default(600).describe('Target chunk size in tokens.'),
      chunkMaxTokens: z.number().int().min(100).default(800).describe('Maximum chunk size in tokens.'),
      chunkOverlapTokens: z.number().int().min(0).default(60).describe('Overlap between consecutive chunks in tokens.'),
      contextBudgetTokens: z.number().int().min(500).default(6_000).describe('Token budget for retrieved memory in one prompt.'),
      qdrantCollectionPrefix: z.string().regex(/^[a-z0-9_]+$/).default('seo_agent').describe('Prefix for Qdrant collection names.'),
    })
    .prefault({})
    .describe('Vector memory and retrieval settings.'),
  budgets: z
    .object({
      llmGateway: z
        .object({
          monthlyUsd: usd.default('5.00').describe('Monthly ceiling for LLM Gateway calls, including embeddings.'),
          perRunUsd: usd.default('0.50').describe('Ceiling per run (job) for LLM Gateway calls.'),
        })
        .prefault({})
        .describe('LLM Gateway budget.'),
      dataforseo: z
        .object({
          weeklyUsd: usd.default('1.00').describe('Weekly ceiling (ISO week in the budget time zone).'),
          monthlyUsd: usd.default('10.00').describe('Monthly ceiling.'),
          perRunUsd: usd.default('0.50').describe('Ceiling per run (job).'),
        })
        .prefault({})
        .describe('DataForSEO budget.'),
      apify: z
        .object({
          monthlyUsd: usd.default('10.00').describe('Monthly ceiling for Apify actor runs.'),
          perRunUsd: usd.default('1.00').describe('Ceiling per run (job).'),
        })
        .prefault({})
        .describe('Apify budget.'),
      pagespeed: z
        .object({
          monthlyUsd: usd.default('0.00').describe('Monthly ceiling (PageSpeed Insights is normally free; keep 0 unless a paid quota applies).'),
          perRunUsd: usd.default('0.00').describe('Ceiling per run (job).'),
        })
        .prefault({})
        .describe('PageSpeed budget.'),
      combinedMonthlyUsd: usd.default('25.00').describe('Combined variable API ceiling for this site.'),
      accountMonthlyUsd: z
        .record(z.string(), usd)
        .default({})
        .describe('Shared provider-account ceilings across all sites in this workspace, keyed by provider.'),
    })
    .prefault({})
    .describe('Configured spending ceilings, not price quotes. No automatic top-ups or increases.'),
  features: featureFlags.prefault({}),
  content: z
    .object({
      maxInProduction: z.number().int().min(1).max(50).default(1).describe('Maximum content pieces in production at once.'),
      batchEnabled: z.boolean().default(false).describe('Allow approved batch drafting (bounded parallel).'),
      pilotApproved: z.boolean().default(false).describe('Owner approved the content pilot; required before batch drafting.'),
      maxAutomatedRevisions: z.number().int().min(0).max(2).default(2).describe('Automated revision rounds before a human must review.'),
    })
    .prefault({})
    .describe('Content pipeline limits. Nothing is published automatically.'),
  experiments: z
    .object({
      defaultMinObservationDays: z.number().int().min(7).max(365).default(28).describe('Minimum observation window before evaluating an experiment.'),
      lowTrafficMinObservationDays: z.number().int().min(14).max(365).default(56).describe('Minimum observation window for low-traffic pages.'),
      minImpressionsForEvaluation: z.number().int().min(0).default(500).describe('Impressions required before search outcomes are evaluated.'),
      minSessionsForConversionEvaluation: z.number().int().min(0).default(200).describe('Sessions required before conversion outcomes are evaluated.'),
    })
    .prefault({})
    .describe('Experiment evaluation thresholds.'),
  router: z
    .object({
      rankingPositionMin: z.number().min(1).default(4).describe('Lower bound of the "striking distance" average position band.'),
      rankingPositionMax: z.number().min(1).default(20).describe('Upper bound of the "striking distance" average position band.'),
      minImpressionsForOpportunity: z.number().int().min(0).default(100).describe('Impressions required before a page/query is an opportunity.'),
      lowDataSiteMaxImpressions: z.number().int().min(0).default(500).describe('Sites below this 28-day impression total take the low-data bootstrap route.'),
      declineThresholdPct: z.number().min(1).max(100).default(25).describe('Percent decline that routes a page to the decline review.'),
      healthyCtrRatio: z.number().min(0).max(5).default(0.8).describe('Observed/expected CTR ratio at or above which a page counts as healthy.'),
      commercialPageTypes: z
        .array(z.string().min(1))
        .default(['offer', 'product', 'category', 'tool'])
        .describe('Page types (see site.pageTypes) treated as commercial for conversion routing and scoring.'),
      conversionPoorRatio: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe('A commercial page whose conversion rate is below this share of the site rate routes to conversion review (0-1).'),
      notSetShareMax: z
        .number()
        .min(0)
        .max(1)
        .default(0.2)
        .describe('Maximum share of GA4 sessions with landing page "(not set)" before page-level conversion routing is treated as unreliable (0-1).'),
      requireConversionDefinition: z
        .boolean()
        .default(true)
        .describe('Conversion routes require at least one configured primary conversion event; without one the router reports data unavailable instead.'),
      minClicksForJoinCheck: z
        .number()
        .int()
        .min(0)
        .default(20)
        .describe('Search Console clicks a page needs before a missing GA4 landing-page join is treated as a data problem.'),
      minPreviousConversionsForDecline: z
        .number()
        .int()
        .min(0)
        .default(5)
        .describe('Conversions required in the previous period before a conversion decline is routed.'),
      ruleOrder: z
        .array(z.enum(ROUTER_RULE_IDS))
        .refine((ids) => new Set(ids).size === ids.length, 'List each router rule at most once')
        .nullable()
        .default(null)
        .describe('Optional evaluation order of the router rules (each at most once). Null uses the built-in order.'),
    })
    .prefault({})
    .describe('Deterministic router thresholds.'),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type SiteConfigInput = z.input<typeof siteConfigSchema>;
export type ConversionEvent = z.infer<typeof eventDef>;

/** Parse and validate raw site config (e.g. parsed YAML). Throws a zod error with field paths. */
export function parseSiteConfig(raw: unknown): SiteConfig {
  const cfg = siteConfigSchema.parse(raw);
  // Cross-field checks.
  const issues: Array<{ message: string; path: string[] }> = [];
  if (cfg.memory.chunkMinTokens > cfg.memory.chunkTargetTokens || cfg.memory.chunkTargetTokens > cfg.memory.chunkMaxTokens) {
    issues.push({ path: ['memory'], message: 'require chunkMinTokens <= chunkTargetTokens <= chunkMaxTokens' });
  }
  if (cfg.router.rankingPositionMin > cfg.router.rankingPositionMax) issues.push({ path: ['router'], message: 'rankingPositionMin must be <= rankingPositionMax' });
  if (cfg.crawl.competitorPagesPerQuery > cfg.crawl.competitorPagesPerQueryMax) issues.push({ path: ['crawl'], message: 'competitorPagesPerQuery must be <= competitorPagesPerQueryMax' });
  const b = cfg.budgets;
  const monthlySum = toMicros(b.llmGateway.monthlyUsd) + toMicros(b.dataforseo.monthlyUsd) + toMicros(b.apify.monthlyUsd) + toMicros(b.pagespeed.monthlyUsd);
  if (toMicros(b.combinedMonthlyUsd) <= 0 && monthlySum > 0) issues.push({ path: ['budgets'], message: 'combinedMonthlyUsd is zero while service budgets are positive' });
  if (cfg.llm.allowPersonalData && !(cfg.llm.personalDataReason ?? '').trim()) {
    issues.push({ path: ['llm', 'personalDataReason'], message: 'llm.allowPersonalData is true; state why personal data may be sent to the LLM Gateway' });
  }
  if (issues.length) throw new z.ZodError(issues.map(({ message, path }) => ({ code: 'custom', message, path, input: undefined })));
  return cfg;
}

export function safeParseSiteConfig(raw: unknown): { ok: true; config: SiteConfig } | { ok: false; errors: string[] } {
  try {
    return { ok: true, config: parseSiteConfig(raw) };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, errors: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Introspection helpers (docs, `config validate` warnings)
// ---------------------------------------------------------------------------

interface ZodDefLike {
  type: string;
  innerType?: ZodLike;
  in?: ZodLike;
  out?: ZodLike;
  shape?: Record<string, ZodLike>;
  element?: ZodLike;
  valueType?: ZodLike;
  options?: ZodLike[];
  entries?: Record<string, string>;
  values?: unknown[];
  defaultValue?: unknown;
}
interface ZodLike {
  _zod?: { def?: ZodDefLike };
  description?: string;
}

const WRAPPERS = ['default', 'prefault', 'optional', 'nullable', 'readonly', 'catch', 'nonoptional'];

/** Unwrap default/optional/nullable/pipe wrappers; collect description, default, nullability. */
function inspect(schema: ZodLike): { core: ZodLike; description?: string; defaultValue?: unknown; hasDefault: boolean; nullable: boolean; optional: boolean } {
  let s: ZodLike = schema;
  let description = schema.description;
  let defaultValue: unknown;
  let hasDefault = false;
  let nullable = false;
  let optional = false;
  for (let i = 0; i < 16; i++) {
    const def = s._zod?.def;
    if (!def) break;
    if (WRAPPERS.includes(def.type) && def.innerType) {
      if (def.type === 'default' || def.type === 'prefault') {
        if (!hasDefault) {
          hasDefault = true;
          try {
            defaultValue = typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : def.defaultValue;
          } catch {
            defaultValue = undefined;
          }
        }
      }
      if (def.type === 'nullable') nullable = true;
      if (def.type === 'optional') optional = true;
      s = def.innerType;
    } else if (def.type === 'pipe' && def.out && def.in) {
      // Our pipes are (union -> transform) -> validated string; document the output side.
      description ??= s.description;
      s = def.out;
    } else break;
    description ??= s.description;
  }
  return { core: s, ...(description !== undefined ? { description } : {}), defaultValue, hasDefault, nullable, optional };
}

function typeLabel(core: ZodLike): string {
  const def = core._zod?.def;
  if (!def) return 'unknown';
  switch (def.type) {
    case 'enum':
      return Object.values(def.entries ?? {})
        .map((v) => JSON.stringify(v))
        .join(' | ');
    case 'literal':
      return (def.values ?? []).map((v) => JSON.stringify(v)).join(' | ');
    case 'array': {
      const el = def.element ? inspect(def.element).core : undefined;
      const elDef = el?._zod?.def;
      return elDef?.type === 'object' ? 'list of objects' : `list of ${el ? typeLabel(el) : 'values'}`;
    }
    case 'record':
      return `map of ${def.valueType ? typeLabel(inspect(def.valueType).core) : 'values'}`;
    default:
      return def.type;
  }
}

export interface SiteConfigFieldDoc {
  /** Dotted path; list elements use "[]" (e.g. "conversions.primaryEvents[].name"). */
  path: string;
  type: string;
  required: boolean;
  nullable: boolean;
  /** JSON rendering of the default, or null when there is none. */
  default: string | null;
  description: string;
  /** True for objects/lists of objects that have documented child fields. */
  group: boolean;
}

/** Flatten the schema into documented fields (drives docs/CONFIGURATION.md). */
export function describeSiteConfigFields(): SiteConfigFieldDoc[] {
  const out: SiteConfigFieldDoc[] = [];
  const walk = (schema: ZodLike, at: string) => {
    const info = inspect(schema);
    const def = info.core._zod?.def;
    const isObject = def?.type === 'object';
    const arrayEl = def?.type === 'array' && def.element ? inspect(def.element) : null;
    const isArrayOfObjects = arrayEl?.core._zod?.def?.type === 'object';
    const recordVal = def?.type === 'record' && def.valueType ? inspect(def.valueType) : null;
    const isRecordOfObjects = recordVal?.core._zod?.def?.type === 'object';
    if (at) {
      out.push({
        path: at,
        type: isObject ? 'object' : typeLabel(info.core),
        required: !info.hasDefault && !info.optional,
        nullable: info.nullable,
        default: info.hasDefault && !isObject ? JSON.stringify(info.defaultValue ?? null) : null,
        description: info.description ?? '',
        group: isObject || isArrayOfObjects || isRecordOfObjects,
      });
    }
    if (isObject) for (const [k, child] of Object.entries(def.shape ?? {})) walk(child, at ? `${at}.${k}` : k);
    if (isArrayOfObjects) for (const [k, child] of Object.entries(arrayEl!.core._zod!.def!.shape ?? {})) walk(child, `${at}[].${k}`);
    if (isRecordOfObjects) for (const [k, child] of Object.entries(recordVal!.core._zod!.def!.shape ?? {})) walk(child, `${at}.<key>.${k}`);
  };
  walk(siteConfigSchema as unknown as ZodLike, '');
  return out;
}

/** Keys present in raw config that the schema does not know (typos are otherwise silently dropped). */
function unknownKeys(raw: unknown, schema: ZodLike, at: string, out: string[]): void {
  if (raw === null || typeof raw !== 'object') return;
  const def = inspect(schema).core._zod?.def;
  if (!def) return;
  if (def.type === 'array' && Array.isArray(raw) && def.element) {
    raw.forEach((item, i) => unknownKeys(item, def.element!, `${at}[${i}]`, out));
    return;
  }
  if (def.type === 'record' && def.valueType && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) unknownKeys(v, def.valueType, at ? `${at}.${k}` : k, out);
    return;
  }
  if (def.type !== 'object' || Array.isArray(raw)) return;
  const shape = def.shape ?? {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = at ? `${at}.${k}` : k;
    // Own keys only: "__proto__"/"constructor" must never resolve to Object.prototype members.
    const child = Object.hasOwn(shape, k) ? shape[k] : undefined;
    if (!child) out.push(p);
    else unknownKeys(v, child, p, out);
  }
}

/**
 * Non-fatal configuration warnings: unknown keys (ignored by the parser) and
 * suspicious-but-valid combinations. `raw` is the parsed YAML before
 * validation; `cfg` the validated config.
 */
export function siteConfigWarnings(raw: unknown, cfg: SiteConfig): string[] {
  const warnings: string[] = [];
  const unknown: string[] = [];
  unknownKeys(raw, siteConfigSchema as unknown as ZodLike, '', unknown);
  for (const k of unknown) warnings.push(`${k}: unknown key (ignored). Check the spelling against docs/CONFIGURATION.md.`);

  let host: string | null = null;
  try {
    host = new URL(cfg.site.url).hostname.toLowerCase();
  } catch {
    host = null;
  }
  const allowed = cfg.site.allowedHostnames.map((h) => h.toLowerCase());
  if (host && !allowed.includes(host)) warnings.push(`site.allowedHostnames: does not include the host of site.url (${host}).`);
  for (const h of cfg.site.allowedHostnames) {
    if (/[/:]/.test(h)) warnings.push(`site.allowedHostnames: "${h}" looks like a URL; list bare hostnames such as "www.example.com".`);
  }

  const b = cfg.budgets;
  const pairs: Array<[string, string, string]> = [
    ['llmGateway', b.llmGateway.perRunUsd, b.llmGateway.monthlyUsd],
    ['dataforseo', b.dataforseo.perRunUsd, b.dataforseo.monthlyUsd],
    ['apify', b.apify.perRunUsd, b.apify.monthlyUsd],
    ['pagespeed', b.pagespeed.perRunUsd, b.pagespeed.monthlyUsd],
  ];
  for (const [name, perRun, monthly] of pairs) {
    if (toMicros(perRun) > toMicros(monthly)) warnings.push(`budgets.${name}: perRunUsd (${perRun}) exceeds monthlyUsd (${monthly}); the monthly ceiling still applies.`);
  }
  if (toMicros(b.dataforseo.weeklyUsd) > toMicros(b.dataforseo.monthlyUsd)) {
    warnings.push(`budgets.dataforseo: weeklyUsd (${b.dataforseo.weeklyUsd}) exceeds monthlyUsd (${b.dataforseo.monthlyUsd}); the monthly ceiling still applies.`);
  }
  const monthlySum = toMicros(b.llmGateway.monthlyUsd) + toMicros(b.dataforseo.monthlyUsd) + toMicros(b.apify.monthlyUsd) + toMicros(b.pagespeed.monthlyUsd);
  if (toMicros(b.combinedMonthlyUsd) > monthlySum && monthlySum > 0) {
    warnings.push(`budgets.combinedMonthlyUsd (${b.combinedMonthlyUsd}) exceeds the sum of service monthly ceilings; service ceilings bind first.`);
  }
  for (const [provider, amount] of Object.entries(b.accountMonthlyUsd)) {
    if (!['llm_gateway', 'dataforseo', 'apify', 'pagespeed'].includes(provider)) {
      warnings.push(`budgets.accountMonthlyUsd.${provider}: unknown provider key; use llm_gateway, dataforseo, apify, or pagespeed (value ${amount} is ignored).`);
    }
  }
  if (cfg.experiments.lowTrafficMinObservationDays < cfg.experiments.defaultMinObservationDays) {
    warnings.push('experiments.lowTrafficMinObservationDays is shorter than defaultMinObservationDays; low-traffic pages usually need longer windows.');
  }
  if (cfg.memory.chunkOverlapTokens >= cfg.memory.chunkTargetTokens) {
    warnings.push('memory.chunkOverlapTokens should be smaller than chunkTargetTokens (the chunker clamps it).');
  }
  if (cfg.profile === 'core' && cfg.research.dataforseo.mode === 'live' && cfg.features.dataforseo === undefined) {
    warnings.push('research.dataforseo.mode is "live" but the core profile disables DataForSEO; set features.dataforseo: true to enable it.');
  }
  if (cfg.reporting.businessTimezone === null) {
    warnings.push(
      `reporting.businessTimezone: unknown; reports and budget periods use scheduler.timezone ${cfg.scheduler.timezone}. Next step: npm run cli -- setup --update --only reporting.businessTimezone --site ${cfg.site.id}`,
    );
  }
  if (cfg.research.seriousQueriesPerRun > 5) {
    warnings.push(`research.seriousQueriesPerRun (${cfg.research.seriousQueriesPerRun}) is above the 3-5 the spec recommends; each serious query may receive paid SERP research.`);
  }
  if (cfg.research.dataforseo.queue === 'live' && !(cfg.research.dataforseo.liveQueueJustification ?? '').trim()) {
    warnings.push('research.dataforseo.queue is "live" without research.dataforseo.liveQueueJustification; the live queue costs more than standard queued tasks, so record why it is needed.');
  }
  if (cfg.llm.allowPersonalData) {
    warnings.push(`llm.allowPersonalData is true: personal data may be sent to the LLM Gateway. Stated reason: ${JSON.stringify(cfg.llm.personalDataReason ?? '')}.`);
  }
  return warnings;
}
