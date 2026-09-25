# LLM Gateway integration and runtime prompts

Module: `src/integrations/llm/` (plus `src/security/untrusted.ts`,
`src/security/tools.ts`, `prompts/`, `src/cli/commands/models.ts`,
`migrations/0150_llm_gateway.sql`).

Spec sections: 9 (LLM Gateway), 4 (roles and stage schemas), 25 (LLM costs),
26 (prompt injection, allowlisted tools), 31 (tests), 33 (documentation
verification).

> Status: implemented and tested offline against a SYNTHETIC fake gateway
> shaped like the verified contract. It has **not** been tested live: no
> credentials were used and no paid call was made. See "Access and next steps".

## What it provides

| Export | File | Purpose |
| --- | --- | --- |
| `createLlmClient(ctx, { fetch? , ... })` | `gateway.ts` | Live `LlmClient` for the OpenAI-compatible LLM Gateway: structured outputs, text, embeddings, allowlisted tools |
| `createFixtureLlmClient(handlers, opts?)` | `fixture-client.ts` | Deterministic SYNTHETIC `LlmClient` for demo/tests (zero network) |
| `discoverModels(ctx, opts?)` | `models.ts` | Free `GET /v1/models`, parsed capabilities cached in SQLite with retrieval time |
| `checkConfiguredModels(ctx, catalog)` / `findModel` | `models.ts` | Verify CHEAP/REASONING/EMBEDDING model ids before use; never substitute |
| `getKeyInfo(ctx)` | `models.ts` | Free `GET /v1/key` key usage/limit pre-flight |
| `llmStatus(ctx, { network })` | `status.ts` | Honest `IntegrationStatus`; the network check is free (models + key only) |
| `PromptRegistry`, `renderPrompt` | `prompts.ts` | Versioned prompt templates (`prompts/<id>.md`) |
| `renderEvidenceBundle`, `describeReviewCoverage` | `src/security/untrusted.ts` | Untrusted-data blocks, token ceilings, truncation records |
| `ToolRegistry`, `createDefaultToolRegistry` | `src/security/tools.ts` | Allowlisted, typed, read-only, site-scoped runtime tools |
| `models list/check/test` | `src/cli/commands/models.ts` | CLI |

Everything is re-exported from `src/integrations/llm/index.ts`.

`LlmClient.unavailable` (optional, `LlmUnavailable { status, reason,
nextStep }`) is set only by a placeholder client that refuses every call, such
as the app's `DisabledLlmClient` (`src/app/services.ts`: `--offline`,
`features.llm` off, no key or model). Callers report that reason instead of
guessing a configuration problem from `isConfigured()`: memory embeddings say
"Network access is disabled (--offline)" and "Run without --offline" rather
than "missing key or model". Working clients omit it.

## Request flow (chat)

```
structured()/text()
  -> site check (request siteId must equal ctx.siteId)
  -> load + render prompt template (unknown/missing variables throw; nothing spent)
  -> preflight: feature flag, offline, LLM_GATEWAY_API_KEY, model id for the tier
  -> discoverModels (cached, free) -> findModel (invalid/deactivated/auto -> invalid_model)
  -> token ceilings: max_tokens = min(request, llm.maxOutputTokens{Cheap,Reasoning}, model max_output)
                     input ceiling = min(llm.maxInputTokens, context_length - max_tokens - reasoning allowance)
  -> system message (code only): system.untrusted-data (+ task System) (+ system.structured-output) (+ system.tools)
  -> user message: task User section + evidence bundle (untrusted blocks, truncation notice),
     placed literally at {{evidence}} (split/join, never String.replace), then re-checked against the ceiling
  -> capability-driven body (params.ts)
  -> upper bound (pricing.ts) -> [explicit per-request cap]
     -> unknown price? verified one-time paid_request approval (see "Unknown prices") or skip
  -> budgets.reserve('llm_gateway', runId)
  -> requests.prepare(paid) -> POST /chat/completions (client timeout ~10 min + 10 s, NO automatic retry)
  -> reconcile: usage.cost (gateway_reported) | tokens x verified price (computed_from_usage) | unknown (null)
  -> llm_calls row (one per HTTP request; call_group_id groups attempts)
  -> tool calls offered this round? execute allowlisted read-only tools, append results as data
     (cut to the per-result budget BEFORE wrapping, TruncationInfo recorded), next round (budgeted)
     tool calls NOT executed (none allowlisted, tools not offered, rounds exhausted)? each one is
     logged and audited as llm.tool_rejected; structured mode repairs only if the content is invalid
  -> validate with zod -> ok | repair (<= llm.maxRepairAttempts, hard max 2, each budgeted) | needs_review
```

`runId` for budget caps is `req.runId` when set, otherwise `ctx.runId`.

## Verified contract usage (docs/integration-contracts.md section 1)

Only verified endpoints and fields are used:

- Base URL from `settings.llmBaseUrl` (`LLM_GATEWAY_BASE_URL`, default `https://api.llmgateway.io/v1`); `Authorization: Bearer <LLM_GATEWAY_API_KEY>` [LG1, LG6].
- `GET /v1/models` (authenticated when a key exists; filtered by the key's IAM/project) [LG6, LG15]. Parsed fields: `id`, `aliases`, `architecture.output_modalities` (embedding detection: `"embedding"` modality, never `supported_parameters`), `context_length`, `max_output`, `supported_parameters`, `json_output`, `structured_outputs`, `free`, `deprecated_at`, `deactivated_at`, `stability`, `pricing.{prompt, completion, request, internal_reasoning, input_cache_read}`, `providers[].{providerId, tools, parallelToolCalls, reasoning, reasoning_efforts, max_output, streaming, pricing}`. Objects are parsed loosely (unknown fields tolerated [LG24]); entries without an `id` are skipped and counted, never guessed.
- `GET /v1/key` -> `{data:{label, usage, limit, devPlan}}` for a free key-budget pre-flight [LG6].
- `POST /v1/chat/completions` with `model`, `messages`, `max_tokens` (always sent: every request has a token ceiling), and only when supported: `temperature`, `reasoning_effort` or (never both) `reasoning: {effort?, max_tokens}` (only for providers listed in the `reasoningMaxTokensProviders` option), `response_format` (`json_schema` only when `structured_outputs: true`; `json_object` only when `json_output: true`) [LG6, LG9, LG10], `tools` (OpenAI function format) [LG6, LG27], `plugins: [{id: "response-healing"}]` (opt-in) [LG17].
- Response: `choices[0].message.{content, tool_calls, reasoning_details}`, `finish_reason`, `usage.{prompt_tokens, completion_tokens, reasoning_tokens, completion_tokens_details.reasoning_tokens, prompt_tokens_details.cached_tokens, cost}`, `metadata.{request_id, used_model, used_provider, cached}` [LG6, LG11].
- `POST /v1/embeddings` with `model`, `input[]`, `encoding_format: "float"`, and `dimensions` only on an explicit shortening request (`embeddingRequestDimensions` client option), because the contract says `dimensions` works only on models that support shortening; `models.embeddingDimensions` is used only to verify returned vectors. Response `data[]` sorted by `index` (float arrays or base64 float32 decoded) [LG2, LG6].
- Capability checks use the **authenticated** model list when a key exists [LG15]: a cached snapshot retrieved without a key (the unfiltered public catalogue) is treated as stale and refetched with the key, and is never used as a stale fallback while a key is configured.
- Client timeouts: paid POSTs wait `DEFAULT_PAID_REQUEST_TIMEOUT_MS` (610 s), a little above the gateway's documented 10-minute non-streaming limit [LG18], so the client does not abort a request the gateway is still processing and billing. `llm.requestTimeoutMs` applies to the free GET calls (its config maximum is 600 s, so it cannot express the recommended value); `paidRequestTimeoutMs` / `timeoutMs` client options override.
- Error envelope `{error:{message,type,param,code}}`, HTTP status authoritative; status mapping in `http.ts` follows [LG12, LG13, LG14].

### Capability rules (conservative)

A plain model id may be routed to any of its provider mappings with fallback
[LG16], so a capability flag is true only when **every** mapping supports it,
`max_output` is the **minimum**, and prices are the **maximum** across mappings
(a mapping without its own price falls back to the top-level price; any unknown
applicable price makes the price unknown). A `provider/model` pin uses only that
mapping. `auto` is rejected (capabilities and price cannot be verified in
advance). Deactivated models are rejected; scheduled deactivation and
deprecation produce warnings. A configured id missing from a cached catalog
triggers one forced refresh before `invalid_model` is reported. Similar listed
ids are shown for humans and are **never** substituted.

Parameters are sent only when verified: `temperature` requires
`supported_parameters` to list it (unknown -> not sent); `reasoning_effort`
requires every mapping to support reasoning and accept the value; tools require
every mapping to support tools (otherwise they are omitted and the omission is
recorded in `llm_calls.params_json.modelWarnings`). Every omission is recorded
in `params_json.omitted` with its reason.

Defaults (code options, not owner-specific): temperature 0 for the cheap tier
only when supported; no reasoning effort unless configured through
`createLlmClient(ctx, { reasoningEffort })`.

### Unverified items and how they are handled

| Unverified (contract section 1) | Handling |
| --- | --- |
| Unit of `/v1/models` pricing strings (USD per token inferred) | Treated as USD/token; every price basis records the verbatim string and retrieval time; `llm.pricingOverrides` can supply verified prices. When both exist the higher price is used for upper bounds. |
| Embedding cost in responses | Computed from `usage.prompt_tokens x pricing.prompt`; `usage.cost` is used if it ever appears; otherwise unknown (never $0). |
| Whether `max_tokens` bounds hidden reasoning tokens | Upper bound adds a reasoning allowance (default = max output tokens; `reasoningTokenAllowance` option) for any model with a reasoning-capable mapping. `reasoning.max_tokens` is sent with that allowance only for provider ids listed in `reasoningMaxTokensProviders` (the contract documents it for Anthropic/Google thinking models; whether it caps billed tokens is unverified, so the default list is empty). Otherwise the price basis says the allowance is an **ASSUMPTION** that nothing enforces; with `unboundedReasoning: 'require_approval'` such estimates count as no safe bound (skip unless an unknown-price approval is verified). |
| Whether top-level `usage.reasoning_tokens` is inside `completion_tokens` | When only the top-level field is reported it is added to computed cost (over-count rather than under-count); `completion_tokens_details.reasoning_tokens` is assumed included (OpenAI convention). Gateway-reported `usage.cost` is preferred whenever present. |
| Tool calling (no docs page; OpenAPI + SDK examples only) | Implemented per the OpenAPI schema; `parallel_tool_calls` and `tool_choice` are never sent. |
| Unlisted params (`seed`, `stop`, `max_completion_tokens`, `stream_options`, ...) | Never sent. Streaming is not used. |
| Billing of failed requests | See the table below; ambiguous cases stay reserved (unresolved) until reconciled. |
| Embedding batch size cap | Not documented: configurable `embedBatchSize` (default 64); each batch is separately budgeted. |
| Embedding dimensions per model | Not in the catalog: returned vectors are checked against `models.embeddingDimensions` (and any explicit `embeddingRequestDimensions`); mismatches are rejected (never mixed). `dimensions` is sent only on an explicit shortening request. |
| Spend-cap 429 / 402 bodies | Mapped by status only. |

## Budgets and cost records

Before every HTTP request (initial, tool round, repair, embeddings batch):

1. Estimate a conservative upper bound: `input_estimate x input_price + max_tokens x output_price + reasoning_allowance x max(reasoning_price, output_price) + request_fee`. The input estimate is `ceil(ascii_chars/3) + non_ascii_code_points` over the serialized request body (deliberately higher than real tokenizers).
2. No verified price (catalog or `llm.pricingOverrides`) -> `budget_unknown_price`, nothing sent, unless a verified one-time approval covers exactly this request (next section). An approval id alone authorizes nothing.
3. `ctx.budgets.reserve({provider: 'llm_gateway', runId, ...})`; `BUDGET_EXCEEDED` -> `budget_exceeded`, nothing sent; an `llm.skipped` audit event is written.
4. `ctx.requests.prepare` (paid) -> `attachRequest` -> `markSubmitted` -> POST.
5. Reconcile: `usage.cost` -> `gateway_reported` (`llm_calls.cost_status = actual`); otherwise tokens x verified price -> `computed_from_usage` (`cost_status = estimated`); otherwise `null` -> reservation stays `unresolved`, ledger `unknown`. Missing usage is never $0.

### Unknown prices: approve one exact request or skip

Spec section 25: if a safe bound cannot be established, require approval or
skip. The client (`authorizeUnknownPrice` in `gateway.ts`) enforces:

- An `ApprovalGate` must be injected (`createLlmClient(ctx, { approvals })`);
  without it every unknown-price request is skipped, whatever id is passed.
- The caller must propose a maximum charge (`unknownPriceMaxChargeMicros`).
  That amount is what is reserved against the run/site/service/account caps;
  without it the request is skipped. There is no $0 reservation.
- Binding (same format as `paid_request` approvals from
  `src/approvals/budget-approvals.ts`): site, `actionType: paid_request`,
  `subjectType: provider_request`, `subjectId` = `approvalRequestHash()` of
  the exact request body (the random boundary token is replaced by a fixed
  placeholder so a re-run of the same logical request hashes identically),
  and `artifactHash` over provider `llm_gateway`, endpoint
  (`chat.completions` / `embeddings`), request hash, and maximum charge.
- With a maximum but no approval id, a pending approval is requested and the
  failure carries `approvalId`, `approvalRequestHash`, and the next step
  (approve it, then re-run the same request with `unknownPriceApprovalId`).
- With an approval id, `gate.check` must return exactly that approval for
  this binding; it is consumed (`gate.consume`) after the reservation
  succeeds, so it covers **one HTTP request**. Unknown-price chat calls
  therefore get no repair attempts and no tool rounds; unknown-price
  embeddings that need more than one batch are refused before anything is
  sent. Refusals are audited (`llm.unknown_price_approval_refused`,
  `llm.skipped`).

Failure billing interpretation (never retried automatically):

| Outcome | Request log | Reservation | Status |
| --- | --- | --- | --- |
| Connection refused / DNS / TLS / offline (never delivered) | failed | released | provider_error |
| Client timeout or caller abort after submission | ambiguous | **unresolved** | provider_error, `ambiguous: true` |
| 400 / 401 / 402 / 403 / 404 / 410 / 413 / 429 / 529 (rejected before inference) | failed | released | mapped (see `http.ts`) |
| 408 / 499 / 504 / other 5xx (outcome not guaranteed) | ambiguous | **unresolved** | provider_error, `ambiguous: true` |
| 2xx with unparseable body | succeeded | unresolved (unknown cost) | provider_error |

Ambiguous results carry a next step: check the LLM Gateway usage log for the
time window, then reconcile via `costs --unresolved`. Provider-side caps: set a
recurring spend limit on the gateway key (`GET /v1/key` shows it; `models check`
and `llmStatus` report when none is set). Application checks cannot guarantee
zero overshoot when billing lags.

`llm_calls` (one row per HTTP request) records: trace id, call group, attempt,
role, tier, prompt id and version, requested and returned model, parameters
sent and omitted (with the estimate and price basis), max tokens, usage,
cost/cost status, schema name, validation status, repair attempt number,
truncation (flag + JSON), evidence bundle hash, provider request id,
reservation id, run id, HTTP status, error, and `is_synthetic`.

## Prompts

See `prompts/README.md` for the template format. Key properties:

- Version string `<id>@<version>+<sha256(file)[0:8]>`; base prompt versions used for a request are recorded in `params_json.systemPrompts`.
- Task prompts may not use placeholders in `## System`; only `system.*` base prompts can, and only the client fills them (boundary token, schema, tool names).
- Unknown and missing variables are errors; `evidence` is reserved; values are redacted and sanitized and substituted in one pass.
- Frontmatter YAML is parsed strictly (any YAML warning such as an unresolved `!!js/function` tag is an error).
- The requested `schemaName` must match the template's `output_schema` (unless `text`).

## Untrusted content and injection defense

- Evidence is rendered only in the user message, inside `<<<UNTRUSTED_DATA boundary=<random> id=... trust=... truncated=...>>>` blocks with a trust-class label and closing markers carrying the same random boundary (fresh per request).
- Before wrapping: redaction (registered secrets and credential shapes), NFC normalization, removal of every default-ignorable invisible character (zero-width and bidi controls, variation selectors, Hangul fillers, the Arabic letter mark, the grapheme joiner, and the Unicode tag characters U+E0000-U+E007F), control characters, chat-template special tokens, the boundary token itself, and anything imitating a marker (`<<<`/`>>>` sequences are neutralized). Attribute values (label, url, ids) are sanitized too, so a label cannot forge `trust="owner_approved"`.
- Personal identifiers (emails, including percent-encoded ones such as `jane%40example.com` in page URLs; phone-like numbers; user handles; IPv4 and IPv6 addresses; analytics client/user ids) are masked in evidence, data-block attributes, and tool results before sending (`sanitizeModelData`), unless the site config sets `llm.allowPersonalData: true` with a non-empty `llm.personalDataReason`. Each call records whether masking applied and the counts per kind. Embedding inputs are always masked, whatever the setting.
- The system prompt, tool list, budgets, config, permissions, and approvals are built from code only; tests prove that injected competitor-page text leaves the system message and tool list byte-identical.
- Heuristic injection signals (ignore-instructions, role reassignment, approval spoofing, budget/policy change, secret exfiltration, boundary spoofing) are logged and audited (`llm.injection_signals`) but never used as a security boundary. Template variables are scanned with the same detector (`variableInjectionSignals`; strings as is, objects as JSON): hits are logged and audited under `variableSignals` in the same event, so a caller that puts externally sourced text into a variable by mistake is visible.
- Text typed by searchers is untrusted data, not an instruction. `analysis.serp-synthesis` (v4) receives the analysed search query (a Search Console query in the weekly `compare` stage) only as evidence item `query` (`user_reported`, or `synthetic` for demo data), never as a template variable. The optional executive summary sends a report claim that embeds query or title text (any claim with a quote character, and every `action.*` recommendation claim) as `user_reported` rather than `first_party_measurement` ("computed by code"), and says so in its data-block label (`summaryClaimTrustClass` in src/reports/llm-summary.ts).
- Token ceilings: the evidence budget is what remains of `min(llm.maxInputTokens, model context - output - reasoning allowance)` after the prompt, schema, tools, and repair/tool reserves. Items are prioritized in the given order; small items stay whole, large items share the remainder fairly, and items that cannot keep 32 tokens are omitted from the end. Tool results are cut to their per-result share of the remaining input budget **before** being wrapped (so the closing marker always survives), marked `truncated="yes"`, and end with a note telling the model how much it saw; the tool's own `maxResultChars` cut is treated the same way. Every truncation/omission (evidence items and `tool:<name>:<call id>` results) is a `TruncationInfo`, is disclosed to the model in a TRUNCATION NOTICE ("do not describe these items as fully reviewed"), is returned in results, and is stored in `llm_calls.truncation_json`. `describeReviewCoverage()` produces the partial-review statement for reports. If no evidence item fits, the request is refused (`unsupported`).
- Output truncation is surfaced too: a text response that ended with `finish_reason: "length"` is returned flagged `outputTruncated` with a truncation entry recorded on the call, and the optional executive summary states how many of the report's claims the model was given ("N of M claims") and never presents a cut-off summary as complete.

## Runtime tools

`src/security/tools.ts` registers tools in code only. Registration refuses:
names with dangerous segments (shell/exec/sql/secret/env/config/budget/approval/
permission/write/delete/update/fetch/http/file/...), tools not marked
`readOnly: true` and `siteScoped: true`, non-object argument schemas, and
argument keys such as `site_id`, `sql`, `command`, `path`, `token`. Handlers get
a frozen context whose `siteId` comes from the calling code and a read-only
query helper that accepts a single `SELECT`/`WITH` statement bound to the site
id. Per request, only the tools listed in `req.tools` are offered; any other
call (unknown or registered-but-not-allowlisted) is rejected, returned to the
model as an error, logged, and audited (`llm.tool_rejected`). Tool calls the
client does not execute at all (no tools allowlisted, tools not offered
because the model lacks verified tool support or the price is unknown, or
`maxToolRounds` exhausted) are also logged and audited as `llm.tool_rejected`
with that reason, in both structured and text mode; the response content is
still validated (structured) or returned (text), and a text response that
contains only tool calls is `needs_review`. Tool results are
size-limited, redacted, and wrapped as untrusted data blocks. Tool rounds are
bounded (`maxToolRounds`, default 3) and each round is a separately budgeted
request. Built-in tools: `get_site_profile` (public business profile from the
validated config) and `get_evidence` (one evidence row of the current site).

## Fixture client (demo/tests)

`createFixtureLlmClient(handlers, { ctx?, prompts?, embeddingDimensions? })`:
`synthetic = true`; outputs only from handlers keyed by prompt id and validated
with the request schema; no handler or invalid output -> `needs_review` (never
invented); hash-based L2-normalized pseudo-embeddings (`synthetic-hash-embedding-v1`,
default 64 dims) that carry no semantic meaning; zero network; cost exactly $0
because no provider is called; with `ctx`, `llm_calls` rows are written with
`is_synthetic = 1`.

## CLI

- `npm run cli -- models list [--refresh] [--embedding|--chat] [--filter <text>] [--json]` - free catalog listing with capability flags (`y` all mappings, `-` not supported, `?` not reported) and conservative prices.
- `npm run cli -- models check [--refresh] [--json]` - configured models: exists / invalid_model / wrong_kind / unknown_price, capabilities, price source, key usage and limit. Free. Exit code 2 when a problem is found.
- `npm run cli -- models test --confirm-spend --max-usd <cap> [--tier cheap|reasoning|embedding] [--max-output-tokens 16]` - the only chargeable check. Both flags are mandatory; the client refuses (before reserving) any request whose upper bound is unknown or above the cap; the request is still budget-reserved and recorded. `--dry-run` previews (it performs only the free catalog request).

## Configuration

| Setting | Where | Notes |
| --- | --- | --- |
| `LLM_GATEWAY_API_KEY` | env or `<workspace>/secrets/secrets.env` | secret; never in site config or vault |
| `LLM_GATEWAY_BASE_URL` | env | default `https://api.llmgateway.io/v1`; must be `https://` (plain `http://` only to a loopback proxy, embedded credentials refused), otherwise nothing is sent |
| `CHEAP_MODEL`, `REASONING_MODEL`, `EMBEDDING_MODEL` | env, or `models.cheap/reasoning/embedding` | no defaults; never guessed |
| `models.embeddingDimensions` | site config | enforced on responses when set (verification only; never sent as `dimensions`) |
| `llm.maxOutputTokensCheap` / `llm.maxOutputTokensReasoning` | site config | per-tier token ceilings |
| `llm.maxInputTokens` | site config | per-request input ceiling (evidence truncation) |
| `llm.maxRepairAttempts` | site config | 0..2 |
| `llm.requestTimeoutMs` | site config | client timeout for the free GET calls; paid POSTs wait 610 s (above the gateway's 10-minute limit) unless the `paidRequestTimeoutMs` client option is set; a timeout after submission is an ambiguous submission |
| `llm.pricingOverrides[modelId]` | site config | verified prices when the catalog has none |
| `llm.allowPersonalData`, `llm.personalDataReason` | site config | default `false`; `true` requires a reason, which `config validate` repeats as a warning ([PRIVACY.md](../PRIVACY.md#personal-data-and-language-models)) |
| `budgets.llmGateway.{monthlyUsd, perRunUsd}` | site config | enforced by `BudgetService` |
| `features.llm`, `features.embeddings` | site config / profile | off -> `disabled` |

## Data sent externally

When enabled and configured, requests go to the LLM Gateway, which routes them
to upstream model providers:

- Prompt text from `prompts/*.md` with site-config values (business name, offer, languages and similar non-secret fields).
- Evidence excerpts chosen by the calling module: first-party metrics computed by code, crawled page text, competitor/SERP excerpts, research snippets, retrieved vault notes. Secrets are redacted first, and personal identifiers are masked unless `llm.allowPersonalData` is set with a reason.
- Texts to embed (memory chunks) when embeddings are enabled; secrets redacted and personal identifiers always masked.
- Model-listing and key-usage requests (no content).

Nothing is sent in demo/offline mode (the fixture client is used).

## Schema (migration 0150)

- `llm_model_catalog_snapshots` (grain: one row per successful catalog retrieval per site and base URL; the latest 30 are kept).
- `llm_model_capabilities` (unique key `(snapshot_id, model_id)`; NULL capability = not reported).
- Additive `llm_calls` columns: `call_group_id`, `attempt`, `status`, `response_format`, `reservation_id`, `run_id`, `http_status`, `error_json`, `is_synthetic`.

## Limitations

- Not live-tested: all tests use a synthetic fake gateway. Response shapes, cost fields, and error bodies follow the documented contract only.
- Token estimates are heuristic (no tokenizer); they over-estimate for typical text, so evidence may be truncated earlier than strictly necessary.
- No streaming; long generations rely on the non-streaming 10-minute gateway timeout; the client waits slightly longer (610 s) on paid POSTs.
- Foundation limits worked around locally: `llm.requestTimeoutMs` has a config maximum of 600 s (below the recommended "a little above 10 minutes"), so the paid-request timeout is a client option (`paidRequestTimeoutMs`) rather than a site-config field; `reasoningMaxTokensProviders`, `unboundedReasoning`, and `embeddingRequestDimensions` are client options too until the site schema gains fields for them.
- Unknown-price approvals need the approval gate wired into `createLlmClient(ctx, { approvals })` at integration time; until then every unknown-price request is skipped.
- `llmStatus` reports `unreachable` (not `ready`) whenever the live model listing failed and a cached catalog was used; the detail lists what the cache says but claims no live verification.
- Prompt caching parameters, `service_tier`, routing preferences, web search, and `X-No-Fallback` are not used.
- Injection-signal detection is heuristic and only for auditing; the defense is structural (data blocks + code-built system prompts + allowlisted read-only tools + schema validation).
- `reasoning_effort` defaults to unset; per-tier values are a client option, not yet a site-config field.

## Access and next steps (owner)

1. Create a dedicated LLM Gateway project and API key (https://docs.llmgateway.io/learn/api-keys); set a recurring spend limit on the key as a provider-side cap.
2. Put `LLM_GATEWAY_API_KEY=...` in `<workspace>/secrets/secrets.env` (mode 0600) or inject it from a password manager. Never paste it into chat.
3. `npm run cli -- models list` (free) and choose verified model ids; set `CHEAP_MODEL`, `REASONING_MODEL`, `EMBEDDING_MODEL` (and `models.embeddingDimensions` to the model's documented output size so responses are verified; shortening is a separate, explicit option).
4. `npm run cli -- models check` (free): every configured model must be `OK`. For `unknown_price`, verify the price and set `llm.pricingOverrides`.
5. Optionally `npm run cli -- models test --confirm-spend --max-usd 0.01` for one capped live call (and `--tier embedding` to verify embedding access; Dev plans return 403 for embeddings).
6. After any ambiguous result, check the gateway usage log and reconcile with `npm run cli -- costs --unresolved`.

## Tests

- Unit: `tests/unit/llm/` - untrusted-content rendering and truncation, tool policy, prompt parsing/rendering, base prompts, pricing, catalog parsing and capabilities, parameter builder, error mapping, fixture client.
- Integration (DB-backed, fake gateway): `tests/integration/llm/` - structured success, repair within 2 attempts then `needs_review`, invalid model ids, capability-dependent params, tool allowlist rejection, tool calls rejected and audited outside tool rounds (structured and text), tool-result truncation recorded with the closing marker intact, prompt injection, literal evidence placement (`$` replacement patterns), truncation, missing usage -> unknown cost, reservation and reconciliation, budget exceeded, parallel reservations, unknown price skip / made-up approval ids rejected / bound single-use approvals reserving the approved maximum (in-memory gate and the approvals service), reasoning bounds (assumption label, `reasoning.max_tokens`, require-approval mode), paid-request timeout, timeout -> unresolved reservation, 5xx/429 handling, embeddings (dimensions verification vs. explicit shortening), discovery cache/staleness/authenticated refetch, `llmStatus` (including cached-catalog fallback -> `unreachable`), cost plans (per-request fees), CLI commands.

Run: `npx vitest run tests/unit/llm tests/integration/llm`.
