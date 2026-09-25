import type { AppContext } from '../app/context.js';
import type { TrustClass } from '../core/modes.js';
import { OUTPUT_TRUNCATION_ID, type EvidenceItem, type LlmClient, type ModelTier, type TruncationInfo } from '../integrations/llm/types.js';
import { claim, type Claim, type LlmSummaryInfo, type ReportKind, type ReportPeriod } from './model.js';

/**
 * Optional LLM executive summary hook. Reports are complete and deterministic
 * without it. When enabled, the model receives only the report's own computed
 * claims as evidence (no raw datasets, no secrets), its output is labeled as
 * model-generated INFERRED text, and the computed claims stay authoritative.
 * A claim that embeds search-query or title text is sent as `user_reported`
 * (untrusted), not as a code-computed measurement.
 * Budget reservation and call logging are the LlmClient's responsibility.
 *
 * Coverage is stated, never implied (spec section 9: record truncation and do
 * not describe a truncated source as fully reviewed): the summary says how
 * many of the report's claims the model was given ("N of M"), how many of
 * those were cut or omitted to fit the input ceiling, and whether the model's
 * own output was cut off at the output token limit. A cut-off summary is
 * labeled incomplete.
 */

export const EXECUTIVE_SUMMARY_PROMPT_ID = 'reports.executive-summary';

/** Most claims offered to the model (in report order); the rest are stated as not given. */
export const EXECUTIVE_SUMMARY_MAX_CLAIMS = 40;

export interface SummaryCoverage {
  totalClaims: number;
  /** Claims offered to the model (after the EXECUTIVE_SUMMARY_MAX_CLAIMS cap). */
  offered: number;
  /** Offered claims the model saw at least partly. */
  given: number;
  truncated: string[];
  omitted: string[];
  outputTruncated: boolean;
  /** One sentence for the report ("N of M claims given to the model ..."). */
  statement: string;
}

/**
 * Quote characters report claims use around interpolated text (search queries,
 * recommendation/draft titles, event names). Any quote character marks the
 * whole claim: text inside a query can itself contain quotes, so the quoted
 * part cannot be cut out reliably.
 */
const EMBEDDED_TEXT_QUOTES = /["\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A]/;

/**
 * Whether a claim's text (or reason) embeds text that came from outside code:
 * a Search Console query typed by searchers, or a recommendation, content, or
 * page title derived from queries and crawled pages. Recommendation claims
 * (`action.*`) embed recommendation titles and proposed changes, sometimes
 * unquoted, so they always count.
 */
export function claimEmbedsExternalText(c: Pick<Claim, 'id' | 'text' | 'reason'>): boolean {
  if (c.id === 'action' || c.id.startsWith('action.')) return true;
  return EMBEDDED_TEXT_QUOTES.test(c.text) || (c.reason !== undefined && EMBEDDED_TEXT_QUOTES.test(c.reason));
}

/**
 * Trust class of one report claim sent to the model. Only a claim built purely
 * from code-computed values is a `first_party_measurement` ("numbers are
 * authoritative"); a claim embedding query or title text is `user_reported`
 * (untrusted, unverified), so searcher-typed text is never presented as
 * computed by code. Synthetic data stays `synthetic`.
 */
export function summaryClaimTrustClass(c: Pick<Claim, 'id' | 'text' | 'reason' | 'synthetic'>, synthetic: boolean): TrustClass {
  if (synthetic || c.synthetic) return 'synthetic';
  return claimEmbedsExternalText(c) ? 'user_reported' : 'first_party_measurement';
}

/** Describe which claims the model saw, from the offered ids and the client's truncation records. */
export function describeSummaryCoverage(totalClaims: number, offeredIds: string[], truncation: TruncationInfo[], outputTruncated: boolean): SummaryCoverage {
  const offered = new Set(offeredIds);
  const omitted = truncation.filter((t) => offered.has(t.evidenceId) && t.keptTokens === 0).map((t) => t.evidenceId);
  const truncated = truncation.filter((t) => offered.has(t.evidenceId) && t.keptTokens > 0).map((t) => t.evidenceId);
  const given = offeredIds.length - omitted.length;
  const parts = [`${given} of ${totalClaims} claims of this report given to the model`];
  if (offeredIds.length < totalClaims) parts.push(`${totalClaims - offeredIds.length} not offered (limit ${EXECUTIVE_SUMMARY_MAX_CLAIMS})`);
  if (omitted.length) parts.push(`${omitted.length} omitted to fit the input limit`);
  if (truncated.length) parts.push(`${truncated.length} truncated to fit the input limit`);
  const partial = given < totalClaims || truncated.length > 0;
  let statement = `${parts.join('; ')}${partial ? '; the summary covers only part of the report' : ''}.`;
  if (outputTruncated) statement += ' The model output was cut off at the output token limit: this summary is INCOMPLETE.';
  return { totalClaims, offered: offeredIds.length, given, truncated, omitted, outputTruncated, statement };
}

export async function llmExecutiveSummary(
  ctx: AppContext,
  opts: { client: LlmClient; tier?: ModelTier; maxOutputTokens?: number },
  input: { kind: ReportKind; period: ReportPeriod; claims: Claim[]; synthetic: boolean },
): Promise<{ info: LlmSummaryInfo; claim: Claim | null }> {
  const tier = opts.tier ?? 'cheap';
  if (ctx.dryRun) return { info: { status: 'skipped', detail: 'dry-run: no model call made' }, claim: null };
  if (!opts.client.isConfigured(tier)) return { info: { status: 'skipped', detail: `no ${tier} model/credentials configured` }, claim: null };
  const offeredClaims = input.claims.slice(0, EXECUTIVE_SUMMARY_MAX_CLAIMS);
  const evidence: EvidenceItem[] = offeredClaims.map((c) => ({
    id: c.id,
    label: claimEmbedsExternalText(c) ? `${c.label} (embeds search-query or title text from outside code: untrusted data)` : c.label,
    text: c.label === 'DATA_UNAVAILABLE' ? `${c.text} Reason: ${c.reason ?? ''}` : c.text,
    trustClass: summaryClaimTrustClass(c, input.synthetic),
    ...(c.sourceIds[0] ? { sourceId: c.sourceIds[0] } : {}),
  }));
  let res;
  try {
    res = await opts.client.text({
      siteId: ctx.siteId,
      runId: ctx.runId,
      role: 'synthesizer',
      tier,
      promptId: EXECUTIVE_SUMMARY_PROMPT_ID,
      variables: {
        report_kind: input.kind,
        period_start: input.period.start,
        period_end: input.period.end,
        synthetic: input.synthetic,
        claims_given: offeredClaims.length,
        claims_total: input.claims.length,
      },
      evidence,
      maxOutputTokens: opts.maxOutputTokens ?? 400,
    });
  } catch (err) {
    return { info: { status: 'failed', detail: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }, claim: null };
  }
  if (!res.ok) return { info: { status: 'failed', detail: `${res.status}: ${res.reason}` }, claim: null };
  const text = res.text.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!text) return { info: { status: 'failed', detail: 'empty model output' }, claim: null };
  const outputTruncated = res.outputTruncated === true || res.truncation.some((t) => t.evidenceId === OUTPUT_TRUNCATION_ID);
  const coverage = describeSummaryCoverage(
    input.claims.length,
    offeredClaims.map((c) => c.id),
    res.truncation,
    outputTruncated,
  );
  const shown = outputTruncated ? `${text} [cut off: the model reached its output token limit; the summary is incomplete]` : text;
  return {
    info: {
      status: 'generated',
      detail: `model-generated summary; computed claims are authoritative. ${coverage.statement}`,
      model: res.model,
      promptVersion: res.promptVersion,
      costMicros: res.costMicros,
    },
    claim: claim(
      'INFERRED',
      'summary.llm',
      `Model-generated ${outputTruncated ? 'INCOMPLETE ' : ''}summary (${res.model}, prompt ${res.promptVersion}; may contain errors, the computed claims in this report are authoritative; ${coverage.statement}): ${shown}`,
      {
        sourceIds: [`llm_calls:${res.callId}`, ...offeredClaims.slice(0, 10).map((c) => `claim:${c.id}`)],
        retrievedAt: [ctx.clock.now().toISOString()],
        // Nothing checks that the model's sentences are supported by the claims it
        // was given, so its output is context only, never verified support.
        evidence: [{ kind: 'report', label: `${coverage.given} of ${coverage.totalClaims} claims of this report given to the model (not verified against its output)`, ref: 'section:executive_summary', supportsClaim: false }],
        evidenceStatus: 'context_only',
        synthetic: input.synthetic || undefined,
      },
    ),
  };
}
