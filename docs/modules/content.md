# Content farming pipeline (research-to-value)

`src/content` turns discovery signals into a small number of evidence-backed,
genuinely useful content items, and produces briefs and draft **review
artifacts** only after a human approves each step. It never publishes.
Spec sections covered: 4 (sequential / bounded parallel / router), 20, 21, 22,
26, and the matching section-31 tests.

```
DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND -> CHECK EXISTING CONTENT
  -> PRIORITIZE -> BRIEF -> DRAFT -> QUALITY GATES -> HUMAN REVIEW
  -> EXPORT/PUBLISH WHEN AUTHORIZED (approvals slice) -> MEASURE
```

All state lives in SQLite (`content_signals`, `content_items`,
`content_briefs`, `content_drafts`, `quality_reviews`, plus `keyword_clusters`,
`sources`, `evidence`, `claim_evidence`, `audit_events`). Generated Markdown
notes present that state. The vault has **one writer** for content notes: the
vault renderer (`renderAll` in `src/obsidian/notes.ts` with `only: ['content']`,
the same path as `vault render` and the content queue's `queue_notes` stage).
`content discover`, `brief`, `draft`, `review`, `revise-manual`, and
`mark-reviewed` render the content notes (opportunities, briefs, drafts, the
content-farm pipeline) through it after they change records, using the injected
`VaultWriter`; without one, or in a dry run, no note is written and the output
says so. So each item has exactly one opportunity note (id `<item id>`), one
brief note (`<item id>.brief`, every version listed inside), one draft note
(`<item id>.draft`), and the site one pipeline note (`11 Content Farm/Pipeline.md`).

## Status

| Feature | Status | Note |
| --- | --- | --- |
| Discovery from GSC, DataForSEO (non-sandbox), Apify signals, competitor gaps, business knowledge, manual CSV/JSON import | implemented-and-tested | Reads other slices' tables; offline fixtures only |
| Dedup (normalized hash + near-duplicate), rule classification, clustering (lexical, optional embeddings, SERP overlap) | implemented-and-tested | Cheap-model classification and embeddings tested with a fixture `LlmClient` |
| Demand validation, existing-content check, decision with preserved reasons, interpretable prioritization | implemented-and-tested | |
| Brief (deterministic assembly + optional `content.brief` synthesis) and deterministic brief gate | implemented-and-tested | Model synthesis tested with fixtures only |
| Draft generation gated by mode, brief gate, approval bound to brief hash, capacity | implemented-and-tested | Real writing quality depends on the configured model (not tested live) |
| Deterministic quality gates + bounded AI review (`content.review`), max 2 automated revisions | implemented-and-tested | AI review tested with fixtures only |
| Human review acceptance (`content mark-reviewed`), publication gate, measurement | implemented-and-tested | Export/publish itself belongs to the approvals slice |
| Human revision (`content revise-manual`): a human-edited body becomes a new draft version; every removed `[[UNVERIFIED: ...]]` marker needs a resolution with a source; deterministic gates re-run; audited | implemented-and-tested | `tests/integration/content/human-revision.test.ts` |
| Fact-check honesty: a writer "verified" note stands only when a cited product fact or trusted evidence states it; otherwise it is downgraded, marked `[[UNVERIFIED: ...]]`, and blocks publication | implemented-and-tested | `tests/unit/content/quality.test.ts`, `tests/integration/content/review-publication.test.ts` |
| Bounded parallel batch drafts: pilot, stop, human review, second approval, expansion | implemented-and-tested | Disabled by default (`content.batchEnabled`, `content.pilotApproved`) |
| Durable workflow runs (checkpoints, `jobs resume`, per-stage LLM allowances) | implemented-and-tested | `content discover` runs as job `content.research`; `content brief`, `content draft`, `content review`, `content batch`, and `content produce` run as content jobs (only `--dry-run` previews run in-process and never spend or write) |
| Honesty rules added by the audit fixes: real original value, examples, and outline required by the brief gate; brand tokens stripped from branded queries; volumes shown as provider estimates; competitor headings used as research prompts, never copied; no business-term overlap deferred for the owner, never auto-rejected; memory evidence re-verified against its original before reuse; writer output that needs review stops the job for a human; structured data checked against a versioned feature-requirement table; real freshness dates only; an evidence reference on every finding; publication measurement scoped to the item's own page and property | implemented-and-tested | `tests/integration/content/evidence-honesty.test.ts`, `tests/integration/content/measurement-scope.test.ts`, `tests/unit/content/quality.test.ts`, `tests/unit/content/writer-failure.test.ts` |
| Low-data bootstrap (offer-page brief, one supporting brief, readiness checks) | implemented-and-tested | |
| One vault writer for content notes: the content commands render through the vault renderer; notes written by earlier versions of the commands (`<title> <id6>.md`, `... brief v<n>.md`, `11 Content Farm/Content Pipeline.md`; ids `content-item-*`, `content-brief-*`, `content-draft-*`, `content-pipeline-*`) are reported by `vault check` (`stale_duplicate`) and marked stale by `vault render` | implemented-and-tested | `tests/integration/content/single-vault-writer.test.ts` |
| Observation freeze: an item whose target page has an `observing` experiment is deferred ("target page under observation until <review date>", never selectable); `content brief` and `content draft` refuse with CONFLICT before a draft approval is requested or a model draft is paid for | implemented-and-tested | `tests/integration/content/observation-freeze.test.ts` |
| Live model calls (classification, brief synthesis, drafts, AI review, embeddings) | implemented-awaiting-credentials | Needs `LLM_GATEWAY_API_KEY`, `CHEAP_MODEL`, `REASONING_MODEL` (and `EMBEDDING_MODEL` for `--semantic`) |

## Files

| File | Responsibility |
| --- | --- |
| `src/content/types.ts` | Zod schemas and types (signals, candidates, clusters, demand, overlap, brief, draft package, quality review) |
| `src/content/text.ts` | Normalization, hashing, tokens/stems, similarity, n-grams, number extraction, instruction-like text detection, `[[UNVERIFIED: ...]]` markers |
| `src/content/store.ts` | Parameterized SQL for all content tables, provenance rows, audit events; normalizes other writers' collection windows |
| `src/content/signals.ts` | DISCOVER |
| `src/content/import.ts` | `content import <file>` (CSV/JSON; personal-data scrubbing; instruction-like text flagged) |
| `src/content/dedup.ts` | DEDUPLICATE |
| `src/content/classify.ts` | CLASSIFY (deterministic rules; cheap model for ambiguous candidates only) |
| `src/content/cluster.ts` | CLUSTER (average-linkage; lexical + optional semantic + SERP overlap) |
| `src/content/demand.ts` | VALIDATE DEMAND |
| `src/content/existing.ts` | CHECK EXISTING CONTENT + decision and rationale |
| `src/content/prioritize.ts` | PRIORITIZE (score formula, production capacity) |
| `src/content/freeze.ts` | Observation freeze: the hold on an item's target page (`pageFreeze` from `src/experiments/freeze.ts`, read-only), the defer reason, and the CONFLICT refusal of brief and draft |
| `src/content/claims.ts` | Claim checks shared by the brief gate and quality gates |
| `src/content/brief.ts` | BRIEF + deterministic brief gate + provenance + draft-approval request |
| `src/content/draft.ts` | DRAFT preconditions, writer call, package assembly, automated revision |
| `src/content/quality.ts` | Deterministic quality gates, bounded AI review, verdict |
| `src/content/review.ts` | Review orchestration, bounded revision loops, and human revisions (`reviseDraftManually`) |
| `src/content/publication.ts` | Human review acceptance, publication gate, measurement |
| `src/content/batch.ts` | BOUNDED PARALLEL batch drafts (pilot first) |
| `src/content/bootstrap.ts` | Low-data bootstrap |
| `src/content/notes.ts` | Readable presentations of items, briefs, drafts, and the pipeline, used as data (`content show`, `runContentResearch`); never written to the vault. Paths and ids are the vault renderer's own |
| `src/content/fact-notes.ts`, `src/content/package-notes.ts` | Line formatters shared with the vault renderer: fact-check notes, internal-link suggestions, the empty structured-data proposal |
| `src/content/stages.ts` | `StageDefinition`s for the workflow engine |
| `src/content/jobs.ts` | Durable job handlers (`content.research`, `content.production`) on the workflow engine; `runContentResearchJob` used by the CLI |
| `src/content/pipeline.ts` | In-process sequential runner for library use/tests (no checkpoints, allowances not enforced) |
| `src/content/deps.ts` | Dependency injection (`LlmClient`, `MemoryRetriever`, `ApprovalGate`, `VaultWriter`, publication `proposals` resolver) |
| `src/cli/commands/content.ts` | CLI |
| `prompts/content.{classify,brief,draft,review}.md` | Runtime prompt templates |

## Dependencies (injected)

The module depends only on contracts: `LlmClient`
(`src/integrations/llm/types.ts`), `MemoryRetriever` (`src/memory/types.ts`),
`ApprovalGate` (`src/approvals/types.ts`), and `VaultWriter`
(`src/obsidian/types.ts`). Every function takes them as parameters
(`ContentDeps`); any of them may be `null`, and the pipeline then degrades with
an honest status (deterministic-only classification and briefs, drafts refused,
no vault notes written).

The CLI resolves them with `resolveContentDeps(ctx)`:
1. a factory registered with `registerContentDepsFactory()` (tests, integration), else
2. conventional factories loaded dynamically and structurally checked:
   `createLlmClient(ctx)` (`src/integrations/llm/index.ts`),
   `createMemoryService(ctx)` **without** an LLM client, so content retrieval is
   full-text only and never spends on embeddings implicitly
   (`src/memory/service.ts`), `new ApprovalService(db)`
   (`src/approvals/service.ts`), `createVaultWriter(ctx)`
   (`src/obsidian/writer.ts`), and the publication `proposals` resolver
   (`resolveProposal` + `proposalArtifactHash` from `src/approvals/subjects.ts`
   and `src/approvals/publisher.ts`). Anything missing is reported as "not wired".

Stage factories also accept a dependency *provider* `(app) => ContentDeps`
(`ContentDepsSource`). The durable job handlers use it so dependencies are
built from each stage's context: the LLM client then reserves budget through
the engine's per-stage guard (enforcing the stage's cost allowance) with the
job id as run id.

## Stages (workflow contract)

`createContentResearchStages(deps, { allowances })` and
`createContentProductionStages(deps, { allowances })` return
`StageDefinition`s with zod input/output schemas, prerequisites, evidence
requirements (with programmatic checks where useful), timeouts, retry
policies, cost allowances, stopping conditions, and next states. They pass the
engine's `validateWorkflow` (the only warning is that `prioritize` lists `brief`,
which lives in the separate item-scoped production workflow).
`validate_demand` declares `optionalPrerequisites: ['discover', 'classify']`
because it reads their outputs (classification per item, sandbox counts, and
per-source collection status); the engine passes only declared predecessors.

**Durable runs.** `content discover` enqueues and runs the research workflow
as job `content.research` (lock `content`, so it never blocks the site's
scheduled pipelines) through the job runner and `src/workflows/engine.ts`:
every stage result is checkpointed, `jobs resume <id>` continues from the last
successful stage, and per-stage allowances are enforced. The item-scoped
production workflow is available as job `content.production`
(`runContentProductionJob`); both types are registered with the default job
registry so `jobs resume` can continue them. `runStagesSequentially` remains
for library use and tests only: it has no checkpoints and does not enforce
allowances (only the gateway's per-run/site budgets apply), and the CLI no
longer uses it. When a content job fails, the CLI keeps the failed stage's
error code (any `ErrorCode`, built from `ERROR_CODE_VALUES` in
`src/core/errors.ts`, so `OFFLINE` stays `OFFLINE`); the workflow engine's
policy stops become `POLICY_DENIED` and anything else `INTERNAL`.

| Stage | Paid | Retry | Stops when | Next |
| --- | --- | --- | --- | --- |
| `discover` | memory retrieval only | none | no signals (`no_action`) | `dedupe` |
| `dedupe` | no | idempotent (2) | no candidates | `classify` |
| `classify` | cheap model, ambiguous only | none | never (unresolved -> `unsure`) | `cluster` |
| `cluster` | embeddings only with `--semantic` | none | no clusters | `validate_demand` |
| `validate_demand` | no | idempotent | never | `check_existing` |
| `check_existing` | no | idempotent | never | `prioritize` |
| `prioritize` | no | idempotent | no selectable item / capacity full | `brief`, `done` |
| `brief` | reasoning model (optional) | none | gate failed (`blocked`); gate passed but no valid `draft_generation` approval for this brief hash (`needs_review`) | `draft` |
| `draft` (`requiredMode: DRAFT`) | reasoning model | none | refused (throws with actionable checks) | `quality_review` |
| `quality_review` | reasoning model (AI review) | none | always stops at human review (`needs_review`) or `blocked` on reject | terminal |

Cost allowances are fractions of the configured per-run LLM budget
(`budgets.llmGateway.perRunUsd`): discover 5%, classify 10%, cluster 10%,
brief 30%, draft 40%, review 20%. The LLM client performs the actual
reservation and reconciliation; content code never computes prices.
Allowances are enforced for durable runs only; direct commands (`content
brief`, `draft`, `review`, `batch`) are bounded by the per-run and site caps,
and the CLI says so when it prints the cap.

The brief stage reuses the latest gate-passed brief when its inputs are
unchanged (see below), so re-running the production workflow after a human
approved the pending request drafts from the same brief id/hash instead of
minting a new version that the approval does not cover.

## Discovery

| Origin | Source table(s) | Trust | Notes |
| --- | --- | --- | --- |
| `gsc_query` | `gsc_page_query_daily_current` (web, `segment_key = ''`, configured property) | first-party | 28-day window ending at the latest stored date; top 200 queries by impressions; per-query top pages kept for the overlap check; branded queries flagged via `brand.aliases` |
| `dataforseo` | `keywords` + latest `keyword_metrics` with `is_sandbox = 0` | third-party estimate | Sandbox rows are counted and excluded; missing volume stays missing |
| `apify_reddit` | `content_signals` written by the Apify adapter | user-reported | Signals from runs that are not `SUCCEEDED` or are quarantined are excluded and counted. The signal holds only the post title and engagement; the post body is read from the raw dataset referenced by the signal's source rows (`sources.raw_ref` + `metadata_json.itemKey`, repeat occurrences via `apify_signal_occurrences`, evidence excerpts as fallback) for the copying check |
| `competitor_gap` | non-sandbox `serp_snapshots`/`serp_results` where known competitors rank and we do not; question headings on competitor crawl results not covered by our titles/headings | scraped, untrusted | Topic only; competitor text is never reused |
| `business_knowledge` | `research.seedTopics`; question sentences in owner-approved, active business notes via `MemoryRetriever` | owner | Rejected/superseded notes are skipped |
| `manual` | `content import <file>` | user-reported | Emails/phone numbers removed before storage; instruction-like text flagged; columns it does not recognize are not stored and are named in the output (`Ignored columns (not recognized, not stored): ...`, `ignoredColumns` in `--json`) |

Every signal records its origin, collection window (other writers' window
formats are normalized, with the original fields kept in `details`),
limitations, and engagement/metrics. Reddit engagement is stored and labeled as
engagement ("not search volume") and is never summed with or substituted for
search volume. Synthetic rows (`is_synthetic = 1`) are excluded outside
demo/synthetic contexts.

Each run reports a status per source (`collected`, `empty` = collected but
nothing eligible, `unavailable` = never collected). The demand evidence keeps
that status: community threads, manual questions, and competitor gaps are
shown as an OBSERVED count only when positive or when the source was
collected; otherwise they are DATA_UNAVAILABLE, never an observed zero.

## Dedup, classification, clustering

- **Exact duplicates:** normalized text hash (case, punctuation, whitespace)
  across origins.
- **Near duplicates:** content-token Jaccard >= 0.8 (both sides with >= 2
  tokens) or identical token sets. All signal ids stay attached as evidence.
- **Intent (ROUTER):** deterministic English rules route clear cases
  (transactional, commercial, navigational, informational, known
  combinations). Ambiguous candidates go to the cheap model in batches of 25,
  as untrusted evidence items only; ids the model invents are ignored. Without
  a model they become `unsure` and are deferred, never force-classified.
- **Clustering:** average-linkage agglomeration over a combined similarity
  (lexical 0.5, semantic 0.3 when embeddings are enabled, SERP URL overlap 0.2
  when non-sandbox snapshots exist). Threshold 0.45; SERP overlap >= 0.4 alone
  links two queries. Incompatible intents and two existing items never merge.
  One content item per cluster, not per keyword. Every cluster records its
  links, methods, and an uncertainty statement: a similarity score is not proof
  of cannibalization.

## Existing content check and decision

Overlap combines (a) the share of the item's visible Search Console
impressions each page already receives (with impression-weighted position) and
(b) term containment in the page's title, headings, meta description, and path
from the latest own-site crawl. Confidence is high/medium/low. Cannibalization
risk is reported with an explanation (multiple pages receiving impressions for
the same query, several strongly overlapping pages) and always with the caveat
that heuristics are not proof.

Decision rules (`content-decision@2`), in order, with the reason preserved in
`decision_reason` and every change recorded as an audit event:

1. navigational/brand query -> `reject`
2. no relation to offer/facts/differentiators/seed topics and no site impressions -> `defer` for an owner decision (relevance is never dismissed automatically)
3. business scope not configured -> `defer`
4. intent unresolved -> `defer`
5. existing-content check impossible (no crawl, no GSC page data) -> `defer`
6. only business knowledge supports it -> `defer`
7. an existing page overlaps strongly -> `improve_existing`
8. an existing page covers the broader topic -> `add_section`
9. calculator/generator request -> `create_tool`; template/checklist -> `create_template`
10. a single weak signal -> `defer`
11. no original contribution available -> `defer`
12. otherwise -> `create_page`

Then the observation freeze (spec 18 EXPERIMENT_ACTIVE, spec 23: one
meaningful change per page at a time): a decision with a target page
(`improve_existing`, `add_section`) whose page has an `observing` experiment
(matched by page id or normalized target URL, the same `pageFreeze` helper as
`export`) becomes `defer` with the reason "Target page under observation until
<review date>: experiment <id> ... Once it concludes, this item would be:
<decision> (<reason>)". The target page is kept, and the next discovery after
the experiment concludes decides again. Queued experiments (proposed,
approved, awaiting implementation) do not defer an item.

Each item also records why it deserves to exist, who benefits (configured
target customer or an explicit "not configured"), the business relation, the
original value available, and the reader's next step (tied to the configured
primary conversion when one exists).

## Prioritization

```
score = 100 x confidence x (0.30 relevance + 0.30 demandAdjusted + 0.15 intent
        + 0.15 originalValue + 0.10 effort) x (1 - riskPenalty)
```

Demand uses log scaling (GSC impressions observed; volume estimates discounted
50%; community threads, manual questions, and competitor gaps capped at 30/30/20%)
and is smoothed by `n/(n+2)` signals so a single signal cannot outrank broad
observed demand. Confidence is 1.0 with first-party data, 0.7 with estimates
only, 0.5 with questions/engagement only. Raw counts stay in `demand_json`.
Scores rank candidates for human review; they are not traffic predictions.

PRIORITIZE checks the freeze again: an item whose target page came under
observation after CHECK EXISTING is deferred there (audited as a
`content.decision` event) and is never selectable.

**Production capacity:** at most `content.maxInProduction` (default 1) items in
`drafted`/`quality_checked`/`in_review`/`approved`/`exported`. Briefs are
research artifacts and do not count.

## Briefs and the brief gate

A brief contains: audience, primary question, query cluster, intent, decision,
proposed URL / target page, page type, existing-page overlap (with
uncertainty), business purpose, research findings (each with evidence ids and a
claim label), evidence sources (signals, computed metrics, product facts,
approved claims, differentiators, our pages, retrieved notes, catalog
attributes), unique contribution, outline, useful examples, internal-link
candidates (verified against the page registry and crawl status), CTA (target
page and conversion event from config), unresolved factual questions, demand
summary, rationale, and generation metadata. Numbers are computed in code; the
optional `content.brief` synthesis may only reference them.

The deterministic gate (`brief-gate@1`) must pass before a brief becomes
`gate_passed`:

- all required fields present; intent resolved; actionable decision; URL present;
- existing-content check available (warning only for the bootstrap offer page);
- at least one evidence-backed finding; every finding cites valid evidence;
  real (non-model) evidence exists; no sandbox evidence;
- no number that is absent from the evidence; no product/business claim that is
  not backed by product facts, approved claims, or differentiators; no
  prohibited claim; no word-count targets;
- programmatic pages need differentiating data with evidence;
- warnings: synthetic evidence, unverified internal links, missing CTA target,
  unvalidated catalog attributes, instruction-like research text, dropped model
  output (unknown evidence ids).

`content brief` (and `createBrief` / `assertBriefable`, so also `content
produce`, dry runs, and the bootstrap) refuses with CONFLICT, before any brief
is built or any draft approval is requested, when the item's target page has
an experiment under observation; the hint names the experiment, its review
date, and `experiments show <id>`. There is no override flag: a critical fix
to a page under observation goes through `export --critical-fix`.

On pass, a `draft_generation` approval is requested for the exact brief hash
(subject `content_brief`). Brief evidence is also written as `sources`,
`evidence`, and `claim_evidence` rows.

**Reuse.** The gate records an inputs hash (the deterministic assembly without
collection timestamps, plus whether synthesis is requested and possible). When
the latest brief is gate-passed and was built from identical inputs,
`createBrief` returns it (`reused: true`, no new version, no model call) with
the state of its draft approval (`approved`, `pending`, `already_executed`, or
a newly `requested` one). `--force` builds a new version.

Research findings: "Customers raise this question" cites only manual imports
and community discussions. Seed topics and business notes appear as a separate
finding ("the owner lists this as a business topic ... not a customer
question").

Numbers in the brief: a finding's numbers must be stated for that claim in the
evidence it cites; numbers in other fields (primary question included) need
claim-level support from owner statements or owner-approved, first-party, or
third-party-measurement evidence (never Reddit, competitor, or scraped text).

## Drafts

`generateDraft` refuses (with every failed check listed) unless:

1. runtime mode is DRAFT or EXECUTE;
2. the latest brief passed its gate and its stored JSON still hashes to the recorded hash;
3. `ApprovalGate.check('draft_generation', 'content_brief', briefId, briefHash)` is valid
   (or an approved batch covers it); a pending request is created when missing;
4. production capacity allows it; a reasoning model is configured; synthetic data only in demo contexts;
5. no experiment is observing the item's target page (check `observation`; refused with CONFLICT, the hint
   names the experiment and its review date; no approval request is created and nothing is paid for).

The approval is consumed (one-time) before the draft is stored. The package
holds body, title options, meta description, slug suggestion, internal-link
suggestions (verified flag), a structured-data proposal (visible content only,
"rich results never guaranteed"), a source ledger, fact-check notes, the
unresolved facts, publication blockers, the approved brief id/version/hash, and
generation metadata. Every unverified statement is marked
`[[UNVERIFIED: ...]]` in the body (inline or in an appendix section), and
image- or model-derived catalog values are wrapped the same way.

**The writer cannot verify its own statements.** A fact-check note's
`verified` status is the model's claim. `resolveFactCheckNotes` keeps it only
when the note cites an id that resolves to a verification source
(`factVerificationSources` in `src/content/claims.ts`) AND those sources
contain at least 50% of the statement's content words and every number in
it. Verification sources are, and are only:

- owner statements: `fact:<id>`, `claim:<n>`, `differentiator:<n>`, `offer`,
  `conversion:<name>`, and validated owner/catalog attributes (non-sandbox,
  trust class `owner_approved`);
- first-party measurements: the brief's computed `metric:*` items with trust
  class `first_party_measurement` (Search Console, GA4), and only for a numeric
  measurement statement (one that states a number the metric states);
- the target page's current text (`target_page_text`, for improve and
  add-section drafts).

Demand signals of every origin (Search Console queries, DataForSEO keywords,
Apify posts, manual imports, seed topics), SERP and retrieved memory items,
own-site overlap pages, and third-party estimates (search volume) never
verify a fact: their text is the searcher's or poster's words, so a note that
merely restates a query or keyword stays unverified. Ids outside the approved
bundle are dropped (a bare configured product-fact id is kept as
`fact:<id>`). Otherwise the note is downgraded to `unverified`
(`downgraded.reason` says why), the statement is marked, and it blocks
publication like any unresolved fact. Reddit posts, imports, competitor text,
the brief itself, and model output never verify a fact. Both draft notes, the
content pipeline's and the `vault render` one (`src/obsidian/notes-content.ts`),
render each fact-check note with the same `factCheckNoteLine`
(`src/content/fact-notes.ts`): a remaining `verified` reads "model-claimed
verified (evidence: <ids>)", a downgraded one gives its reason, and a human
confirmation reads "confirmed by <name> (source: ...)". Neither note ever shows
a bare **verified** or a raw JSON status. A human confirmation without a
reviewer, date, and source is ignored, so the note reads as the model's claim.
The `content.draft_created` and `content.draft_revised` audit events count
the downgraded notes. Both notes also show internal-link suggestions with the
same helper (`internalLinkSuggestionLine`, `src/content/package-notes.ts`):
`- <target URL> ("<anchor>", <placement>)`, marked **UNVERIFIED** unless the
target was verified; the vault note shows the URL as a literal code span (never
escaped as `https\://www\.`, never a live link). A package without a
structured-data proposal reads "_None proposed._", never a `null` code block.

The writer receives the brief, evidence, product facts, and approved claims as
evidence items; config values (brand voice, emoji and em dash rules,
editorial requirements, prohibited claims, language) as template variables.

## Quality gates and review

Deterministic checks (`quality-gates@3`, recorded with each review) run on
every draft, including every batch item:

| Check | Fails when | Consequence |
| --- | --- | --- |
| intent/business relevance | body misses the cluster; no connection to the offer (warning) | revise |
| product-fact consistency | first-party capability/price/superlative clause not backed by facts/claims; prohibited claim; catalog specs not validated; image/model attributes stated as fact | revise |
| unsupported numbers | a percentage, amount, quantity, or large number without a claim-level match (same value, compatible kind and unit, overlapping topic words) in a trusted source (years: human) | revise |
| quotations | quote not found verbatim in a source (Reddit verbatim quotes: human) | revise |
| expertise and promises | invented testing, first-hand experience, credentials, testimonials, guarantees, ranking promises | revise |
| duplication (own site) | >= 30% of 5-word sequences already on one of our pages (15-30%: human) | revise |
| copying sources | shared 8-word passages or light paraphrase (trigram overlap >= 0.5) of Reddit/competitor text; >= 20% copied | revise / reject |
| cannibalization | brief risk or new-page title similar to an existing page | human (uncertain) |
| original contribution | brief has none, or the body ignores it | revise |
| answer coverage | outline section not covered; primary question not answered early | revise |
| internal links | link to an unknown, retired, or non-200 page | revise |
| CTA | brief CTA missing; aggressive CTA on informational intent (human) | revise |
| metadata | missing titles, bad or clashing slug (length heuristics are informational) | revise |
| structured data | type outside the versioned requirement table (`sd-requirements@2026-09-24`, see [integration-contracts.md](../integration-contracts.md#structured-data-feature-requirements-content-quality-gate)); an eligible type without its required properties; invented ratings/reviews; text not visible; unverified price; dates on new content, or invalid or inconsistent dates on an update (deprecated FAQ/HowTo and restricted types: human; types without a rich result: warning) | revise / human |
| brand voice | emojis / em dashes when configured; readability and language heuristics (informational) | revise |
| privacy | emails, phone numbers (dates, date ranges, and numeric ranges excluded), usernames/handles | revise |
| prohibited practices | keyword stuffing, filler, fake "updated" dates on new content; hidden text; instruction-like text reproduced from an untrusted source (reject) or not found in any source (human) | revise / human / reject |
| source ledger | citations outside the approved evidence bundle | revise |
| unresolved facts | markers present (human); unverified note not marked (revise); a `verified` note without cited evidence that states it (the writer's word only, e.g. a draft stored before this rule) (revise); a human confirmation without reviewer or source (human) | human / revise |
| template similarity | >= 60% shared 3-word sequences with a sibling draft (name substitution); programmatic page without its distinct data. Siblings are the latest draft of every other item INCLUDING rejected drafts, plus every draft whose brief uses the same programmatic template | reject |

**Number support (claim level).** Trusted sources for a draft are: owner
statements (product facts, approved claims, differentiators, offer, primary
conversion meanings), validated catalog attributes, programmatic
differentiating data, owner-approved or first-party evidence excerpts
(computed metrics, business notes, the target page's current text) that the
draft's source ledger actually cites, and statements a named human confirmed
with a source in a human revision. Dates, collection windows
(`2026-08-24..2026-09-20`), clock times, record ids, hashes, and URLs are
stripped before extraction, so their digits never support "24%" or "20
minutes". Reddit/competitor text, unrelated own-site pages, and engagement
counts never support a statistic. A mention is supported only by a source
number with the same value, a compatible kind/unit (a percentage by a
percentage, "28 hours" by hours), and at least one shared topic word near the
number. Questions are exempt only when they restate a known discovered
question.

**Product claims.** A sentence is about the business when it uses
"we/our/us", the business name or an alias, a product noun taken from the
owner's facts and offer (their leading noun phrase) or a generic product noun
with a determiner ("the app", "this tool", "the platform"), or starts with
"It"/"They" right after such a sentence. Each clause with a capability/claim
verb must match an owner statement.

**Instruction-like text.** Patterns target imperatives aimed at an
assistant/model/system (e.g. "ignore previous instructions", "SYSTEM:",
"reveal your system prompt", "assistant, raise the budget", "approved: true");
ordinary prose such as "increase the budget for flour" or "change the mode of
your oven" is not matched. A draft is rejected only when it reproduces a span
flagged in an untrusted source of its item (stored `instructionLikeText` flags
or 4-word overlap with a flagged source sentence); other hits go to human
review.

The bounded AI review (`content.review`) runs only with a configured model and
`--use-model`; issues whose quote is not in the draft are dropped. It can only
make a verdict stricter: critical issues -> revise; an AI "reject" or "needs
human review" -> human review; an AI "pass" never overrides a deterministic
failure. Without an AI review the best verdict is `needs_human_review`.

**Which drafts can be reviewed.** A persisted review (which sets the draft
status and the item stage) runs only on the latest draft of an item whose
status is `draft`, `needs_revision`, `needs_human_review`, or `review_passed`,
and whose item is not `approved`, `exported`, `published`, `measuring`, or
`rejected`. A reject verdict is final. Superseded, rejected, exported, and
published drafts can only be previewed (`content review <id> --dry-run`),
which changes nothing. Automated revisions run only on the latest draft with
status `needs_revision`.

Verdict: any reject-level finding -> `reject`; revise-level findings ->
`needs_revision` while the revision round is below
`min(2, content.maxAutomatedRevisions)`, else `needs_human_review`
("revision limit reached"; its fix names `content revise-manual`);
human-level findings or no AI review -> `needs_human_review`; otherwise
`pass`. Revisions reuse the same authorization (verified via
`already_executed` on the same brief hash) and pass the code-computed
findings to the writer as evidence. A human-authored version never goes back
to the writer: its revise-level findings give `needs_human_review`
(`human_revision_findings`), and `reviseDraft` refuses it.

## Human review, publication, measurement

- `content revise-manual <draft-id> --body-file <edited.md> --as <name>
  [--resolutions <file.json>] [--note <text>] --mode DRAFT` is the human
  revision path (for example after the automated revision limit, or to
  resolve `[[UNVERIFIED: ...]]` markers). It stores the edited body exactly as
  written as a NEW draft version of the latest, reviewable draft (the previous
  version is superseded; brief, authorization, and revision round are kept;
  `pkg.humanRevision` records the author, time, previous draft id and body
  hash, the resolutions, and the markers before/after). Markers are recounted
  (`unresolved_facts`). Every marker the edit removed needs one entry in the
  resolutions file, a JSON array of
  `{"marker", "action": "confirmed" | "removed", "source", "statement"?, "note"?}`:
  `confirmed` requires the statement (or the given `statement` wording) to
  appear unmarked in the new body, and the note becomes a human-confirmed
  `verified` note; `removed` requires it to be gone. `source` is required
  (a product-fact id such as `fact:<id>`, an evidence id, a URL, a document,
  or "owner confirmation <date>"); it is classified as `product_fact`,
  `owner_statement`, `brief_evidence`, or `human_supplied`, and a cited id
  whose text does not state the statement is recorded with a warning. A
  model-claimed `verified` note that no evidence backs can be resolved the
  same way. Resolutions for facts that are not unresolved, duplicates, and
  missing resolutions refuse the whole revision (nothing is stored). The
  deterministic gates then re-run on the new version (no model call; the AI
  review is recorded as skipped, so the best verdict is `needs_human_review`),
  and the change is audited (`content.draft_human_revision`, actor
  `owner:<name>`). Product and business claims still have to match
  `business.productFacts`/`approvedClaims` in the site config: a human
  confirmation does not replace the owner's product facts. Requires DRAFT
  mode (a local review artifact; no approval is consumed); `--dry-run`
  validates and shows the gates without storing anything; refused with
  `LOCKED` while a job holds the site or `content` lock.
- `content mark-reviewed <draft-id> --as <name> --confirm <hash-prefix>`
  records a named reviewer's acceptance of the exact body (moves
  `needs_human_review` to `review_passed`). Refused while reject/revise
  findings or unresolved facts remain (the refusal names
  `content revise-manual`).
- **Named humans only.** `markHumanReviewed` and `reviseDraftManually`
  validate the reviewer or author name with the approvals slice's
  `validateApproverName`, for every caller (not only the CLI): names that
  denote automation (`system`, `scheduler`, `claude`, `agent`, `bot`, `llm`,
  ...), names containing such a token, and names with unsupported characters
  are refused with VALIDATION_FAILED, and nothing is recorded.
- `checkPublicationGate` lists content-side blockers: newer draft exists,
  status, body hash integrity, the recorded human acceptance of this exact
  body, latest verdict, unresolved facts, synthetic data, a valid approval
  bound to the approvals workflow's proposal, and EXECUTE mode. A quality
  pass, AI score, or sampling never authorizes publication.
- **Human acceptance, same rule as the export.** The gate reads the human
  acceptance with the approvals slice's own `draftHumanReview` and
  `draftHumanReviewBlocker` (the functions `export draft` uses through
  `assertDraftHumanAccepted`), so `content publish-check` reports ALLOWED
  only when `export draft` would not refuse with `human_review_required`. A
  draft whose latest review is automated (a `pass` included), whose accepted
  body differs from the stored one, or that was re-reviewed automatically
  after the acceptance is BLOCKED, with the next step
  `content mark-reviewed <id> --as "<name>" --confirm <prefix>`. The result
  carries `humanReview` (reviewer, time, review id, body hash), and the
  ALLOWED line names who accepted the body and when, and which approval
  approved the proposal.
- **Binding.** The gate checks exactly what `approvals request draft <id>`
  binds: subject `draft`, `update_page` when the item targets an existing
  page (else `publish_content`), and the canonical change hash
  `proposalArtifactHash(resolveProposal(ctx, 'draft', id))` (action, target
  URL, title, meta, body, slug, links, structured data), obtained through the
  injected `proposals` resolver. Without the resolver, or when the approvals
  workflow cannot build a proposal (e.g. the draft is not `review_passed`),
  the gate reports that honestly as a blocker instead of guessing a hash. An
  approval bound to a source revision is noted; `export draft` verifies the
  revision.
- The content module never creates publication approvals (a request with a
  different hash would invalidate the owner's live approval). Export/publish
  is done by the approvals slice (`approvals request draft <id>`,
  `approvals approve`, `export draft <id> --mode EXECUTE`). `export draft`
  itself enforces: EXECUTE mode; a named human's recorded acceptance of this
  exact body (`assertDraftHumanAccepted`: the latest quality review must be a
  `content mark-reviewed` acceptance of the body's hash, so an automated
  verdict never counts); an exportable draft status (`review_passed`,
  `approved`, `exported`, `published`); zero recorded unresolved facts; a valid
  approval bound to the exact proposal (canonical change hash, and the source
  revision when bound; one-time); and a target recheck just before writing.
  It does not check that the draft is the latest version of its item, and it
  labels but does not refuse synthetic data; `content publish-check` reports
  those (run it first).
- `content measure` moves items with a recorded publication to `measuring` and
  reports Search Console page metrics since the actual implementation date as
  observational data (missing, not zero, when no rows exist).

## Batch drafts (bounded parallel)

`content batch <item-ids...>` requires `content.batchEnabled: true`,
`content.pilotApproved: true`, DRAFT mode, and capacity for every item, and
runs in two human-gated phases:

1. **Pilot.** A `batch_expansion` approval bound to the exact set of brief
   hashes (subject = batch key; requested automatically when missing) drafts a
   pilot of up to 3 items and the run STOPS (`pilot_complete`), or
   `halted_after_pilot` when a pilot item failed or was rejected. Automated
   verdicts never start the expansion.
2. **Expansion.** Only after a named human accepted every pilot draft
   (`content mark-reviewed`) does a re-run request a second `batch_expansion`
   approval (subject `<batch key>:expansion`) bound to the remaining briefs
   AND the reviewed pilot draft ids/body hashes. Once approved, the next run
   drafts the rest (`completed`).

Each approval is one-time. A batch authorization passed to `generateDraft` is
never trusted as given: the approval must exist for exactly its subject and
artifact hash (approved, or already executed by the run that consumed it),
the artifact hash must be the hash of the listed briefs, and the item's
current latest brief id/hash must be in that list (a brief rebuilt after the
approval is not covered). At most 3 concurrent generations (`mapBounded`);
parallelism does not reduce token charges. Cross-item template similarity is
checked on every item.

## Low-data bootstrap

`content bootstrap` applies when the site has no stored Search Console
property data or fewer 28-day impressions than
`router.lowDataSiteMaxImpressions`. It creates (or reuses) an offer-page item
(improve the existing offer page, else create one) and briefs it, selects
exactly one supporting item (the best selectable item, or a relevant item with
original value that was deferred only because demand is not yet measurable) and
briefs it, and reports measurement, technical, and business readiness checks.
It states explicitly that no historical conversion evidence exists and none is
assumed. Re-running it never moves an item backward: an offer or supporting
item that is already drafted, in review, approved, exported, published,
measuring, or rejected is reported as `already_in_progress` and left
unchanged (no new brief, no stage change); an offer or supporting item whose
target page has an experiment under observation is reported as
`held_by_experiment` with the experiment and its review date (no brief, no
approval request); a briefed item keeps its decision
and rationale and its brief is reused when inputs are unchanged; only items in
open research stages are refreshed.

## Prompts

| Prompt | Role / tier | Variables (code-controlled only) |
| --- | --- | --- |
| `content.classify` | classifier / cheap | `allowed_intents`, `candidate_ids`, `site_name`, `languages` |
| `content.brief` | synthesizer / reasoning | business name, target customer, language, decision, intent, page type, URLs, primary signal id, CTA target, primary conversion, allowed evidence ids, product fact ids |
| `content.draft` | writer / reasoning | brand voice, emoji/em dash rules, editorial requirements, prohibited claims, page type, decision, intent, URLs, evidence and fact ids, revision round |
| `content.review` | reviewer / reasoning | language, brand voice, page type, intent, decision, revision round |

No placeholders appear in System sections, and every untrusted text (queries,
Reddit posts, imports, competitor headings, retrieved notes, drafts under
review) travels only as evidence items with its trust class. The templates
parse and render with the prompt loader in `src/integrations/llm/prompts.ts`.

## Verified contract usage

The content module calls no provider API directly.

- **LLM Gateway** (`docs/integration-contracts.md` section 1): only through the
  `LlmClient` contract (`structured`, `embed`). Budgets, token ceilings,
  structured-output modes, repair loops, and cost recording are the client's
  job; the content code sets `maxOutputTokens` from `llm.*` config.
- **Search Console** (section 2): reads stored `gsc_*_current` views. Visible
  query rows omit anonymized queries; byPage rows are summed per query and
  labeled as not additive with property totals.
- **DataForSEO** (section 6): reads stored `keyword_metrics`/`serp_*` rows,
  excluding `is_sandbox = 1`; volumes are labeled as estimates.
- **Apify Reddit actor** (section 7): reads signals stored by the Apify slice;
  engagement fields `upVotes`, `commentsCount`, `score` (dataset schema, AP5)
  are used as engagement only. Post bodies are read from the minimized raw
  dataset the Apify slice stores (`items[].context`, matched by `itemKey`),
  never fetched from Reddit.
- **Google Search guidance** (section 5, PS14/PS15): quality rules implement the
  documented guardrails: scaled content abuse and doorway pages (template
  similarity, programmatic pages need distinct data), keyword stuffing, hidden
  text, structured data must match visible text, no special AI-search markup,
  FAQ rich results not guaranteed.

## Data sent externally

Only when a model is explicitly enabled (`--use-model`, `--semantic`) and
configured, through the LLM Gateway client:

- candidate texts for ambiguous intent (search queries, Reddit post text,
  imported questions after email/phone removal, competitor headings, business
  note questions);
- brief evidence: signal excerpts, computed metrics, product facts, approved
  claims, differentiators, offer, our page titles/headings, retrieved business
  note excerpts;
- for drafts: the brief, that evidence, the current text of the target page
  (improve/add-section), previous draft and quality findings on revisions;
- for AI review: the draft, the brief summary, deterministic findings, and
  evidence excerpts;
- with `--semantic`: candidate texts for embeddings.

No credentials, analytics identifiers, usernames, or raw datasets are sent.
Without `--use-model`, content commands make no external requests.

## Limitations

- Intent rules, stopwords, and stemming are English-oriented; other languages
  fall through to the model (or `unsure`). The fabrication and language
  checks have patterns for English and German (src/content/claims.ts
  CLAIM_PATTERN_SETS); other languages return `not_checked`, and a
  `not_checked` check always forces a human review, so a draft in another
  language never passes the gates on its own.
- All similarity thresholds (dedup 0.8, cluster 0.45, SERP 0.4, duplication 30%,
  copying 8-gram / trigram 0.5, template 60%) are heuristics, documented as such.
- Claim detection is pattern-based: it reduces but cannot eliminate fabricated
  statements; human review remains mandatory. Number support is claim-level
  (value, kind/unit, nearby topic words) but still heuristic: a number used
  with the right words but the wrong meaning can pass, and a legitimate number
  whose evidence the draft does not cite in its ledger fails (by design).
- Product-noun detection uses the leading noun phrase of product facts and the
  offer plus a short generic list; unusual phrasings can still slip through,
  and generic nouns ("the tool") may occasionally flag non-product prose for
  revision.
- Content notes written by earlier versions of the content commands are never
  deleted or moved automatically: `vault render` marks tracked ones stale in
  place and `vault check` reports every one (tracked or not) as a
  `stale_duplicate` until the owner deletes it.
- Edits made in the vault note do not change the stored draft. A human who
  rewrites a draft records the edited body with `content revise-manual`
  (above); editing in the CMS after export publishes text that no approval
  or review covered.
- The fact-check verification rule is lexical (content-word overlap and exact
  numbers): a cited source that uses the same words with a different meaning
  can still back a `verified` note, and a correct statement phrased very
  differently from its source is downgraded (and then resolved by a human).
- The publication gate depends on the approvals slice's proposal resolver; if
  that slice is absent the gate reports the binding as unavailable.
- `export draft` (approvals slice) does not itself check that a draft is the
  latest version of its item; the content side prevents superseded drafts from
  regaining an exportable status (superseded drafts cannot be re-reviewed or
  marked reviewed), and `content publish-check` reports it.
- Competitor-gap discovery depends on SERP snapshots and competitor crawls
  produced by other slices.

## Next steps for credentials and access

1. Configure the model connection (see `docs/ACCESS_SETUP.md`, LLM Gateway):
   put `LLM_GATEWAY_API_KEY` in `<workspace>/secrets/secrets.env`, set
   `CHEAP_MODEL` and `REASONING_MODEL` (and `EMBEDDING_MODEL` for `--semantic`)
   after verifying availability with the models command.
2. Enable the queue: `features.contentDiscovery: true` in the site config.
3. Fill `business.offer`, `targetCustomer`, `productFacts` (with sources),
   `approvedClaims`, `prohibitedClaims`, `research.seedTopics`, and
   `conversions.primaryEvents`.
4. Sync data first: `sync gsc`, `crawl` (free), optional approved DataForSEO /
   Apify research, `content import <file>` for customer questions.
5. Run: `content discover` (durable job; `jobs resume <id>` after an
   interruption) -> `content brief <item>` -> `approvals approve <id>`
   -> `content draft <item> --mode DRAFT --use-model` -> review ->
   (when needed: `content revise-manual <draft> --body-file <edited.md> --as
   <name> --resolutions <file.json> --mode DRAFT`) ->
   `content mark-reviewed` -> `content publish-check <draft>` ->
   `approvals request draft <draft>` -> `approvals approve` ->
   `export draft <draft> --mode EXECUTE`.
