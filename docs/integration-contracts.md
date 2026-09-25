# Integration Contracts

These contracts were checked against their sources on **2026-09-24**. Every source listed below was retrieved on that date.

- **Pricing, quotas, rate limits, model catalogs and API versions change.** Recheck them against the linked sources before any paid use.
- **"Verified"** means the behavior was read in primary documentation on 2026-09-24. Items marked **LIVE** were seen in an unauthenticated public response on that date. "Verified" does **not** mean tested live with credentials. No credentials were used for any integration and no paid calls were made.
- Items under "Unverified / to recheck with credentials" are open questions, conflicts between docs, or inferences. They need an authenticated call or a closer read before anything relies on them.
- **SECONDARY** sources are not primary documentation. They are never cited as verified behavior.
- Each bullet cites its source by ID. The ID links to the URL listed in that section's Sources table.
- This document contains no secrets. Env var names such as `LLM_GATEWAY_API_KEY` are placeholders.

Contents:

1. LLM Gateway (OpenAI-compatible)
2. Google Search Console API
3. Google Analytics 4 Data API v1beta
4. Google OAuth 2.0 and google-auth-library
5. PageSpeed Insights v5, Chrome UX Report API, Google Search guidance (including the structured-data feature requirements used by the content quality gate)
6. DataForSEO API v3
7. Apify API v2 and the Reddit Scraper Actor
8. Qdrant, Obsidian Markdown, Node.js / node:sqlite
9. Research gaps

---

## 1. LLM Gateway (OpenAI-compatible)

Base URL `https://api.llmgateway.io/v1`.

### Sources

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| LG1 | https://docs.llmgateway.io/quick-start | 2026-09-24 | yes | WebFetch plus raw `.mdx` |
| LG2 | https://docs.llmgateway.io/features/embeddings | 2026-09-24 | yes | WebFetch plus raw `.mdx` |
| LG3 | https://docs.llmgateway.io/learn/api-keys | 2026-09-24 | yes | WebFetch plus raw `.mdx` |
| LG4 | https://docs.llmgateway.io/llms.txt | 2026-09-24 | yes | Official index of all docs pages |
| LG5 | https://docs.llmgateway.io/llms-full.txt | 2026-09-24 | yes | Full docs dump (~900KB), searched with grep |
| LG6 | https://llmgateway.io/openapi.json | 2026-09-24 | yes | OpenAPI 3.0.0 (145,723 bytes), byte-identical to LG7. Main schema source |
| LG7 | https://api.llmgateway.io/openapi.json | 2026-09-24 | yes | Canonical spec location named in `info.description` |
| LG8 | https://api.llmgateway.io/v1/models | 2026-09-24 | yes | LIVE unauthenticated GET: HTTP 200, 294 models. No RateLimit headers when unauthenticated |
| LG9 | https://docs.llmgateway.io/learn/structured-outputs | 2026-09-24 | yes | Raw `.mdx` |
| LG10 | https://docs.llmgateway.io/features/reasoning | 2026-09-24 | yes | Raw `.mdx` |
| LG11 | https://docs.llmgateway.io/features/cost-breakdown | 2026-09-24 | yes | Raw `.mdx` |
| LG12 | https://docs.llmgateway.io/resources/error-handling | 2026-09-24 | yes | Raw `.mdx` |
| LG13 | https://docs.llmgateway.io/resources/rate-limits | 2026-09-24 | yes | Raw `.mdx` |
| LG14 | https://docs.llmgateway.io/features/api-keys | 2026-09-24 | yes | Raw `.mdx` |
| LG15 | https://docs.llmgateway.io/features/models-directory | 2026-09-24 | yes | Read via llms-full.txt |
| LG16 | https://docs.llmgateway.io/features/routing | 2026-09-24 | yes | Raw `.mdx`. Also covers `x-session-id` and `metadata.routing` |
| LG17 | https://docs.llmgateway.io/features/response-healing | 2026-09-24 | yes | Raw `.mdx` |
| LG18 | https://docs.llmgateway.io/features/timeouts | 2026-09-24 | yes | Raw `.mdx` |
| LG19 | https://docs.llmgateway.io/features/source | 2026-09-24 | yes | Raw `.mdx` |
| LG20 | https://docs.llmgateway.io/features/metadata | 2026-09-24 | yes | Custom `X-LLMGateway-*` metadata headers |
| LG21 | https://docs.llmgateway.io/learn/models | 2026-09-24 | yes | Dashboard directory, lifecycle statuses (deprecated/scheduled/deactivated), custom model ids |
| LG22 | https://docs.llmgateway.io/learn/preferences | 2026-09-24 | yes | Project mode, caching, archive (keys of an archived project go inactive) |
| LG23 | https://docs.llmgateway.io/features/caching/gateway-caching | 2026-09-24 | yes | Response caching is opt-in per project, default TTL 60s |
| LG24 | https://docs.llmgateway.io/resources/api-versioning | 2026-09-24 | yes | Raw `.mdx` |
| LG25 | https://docs.llmgateway.io/learn/billing | 2026-09-24 | yes | Prepaid credits, 5% platform fee on top-ups, 1.5% international card fee |
| LG26 | https://docs.llmgateway.io/features/master-keys | 2026-09-24 | yes | Custom-model catalog prices are USD-per-token strings |
| LG27 | https://docs.llmgateway.io/developers/ai-sdk | 2026-09-24 | yes | Read via llms-full.txt. Tool-calling example via the AI SDK provider |
| LG28 | https://llmgateway.io/guides/mcp | 2026-09-24 | yes | Read via llms-full.txt. MCP auth accepts `Authorization: Bearer` or `x-api-key` |

[LG1]: https://docs.llmgateway.io/quick-start
[LG2]: https://docs.llmgateway.io/features/embeddings
[LG3]: https://docs.llmgateway.io/learn/api-keys
[LG6]: https://llmgateway.io/openapi.json
[LG8]: https://api.llmgateway.io/v1/models
[LG9]: https://docs.llmgateway.io/learn/structured-outputs
[LG10]: https://docs.llmgateway.io/features/reasoning
[LG11]: https://docs.llmgateway.io/features/cost-breakdown
[LG12]: https://docs.llmgateway.io/resources/error-handling
[LG13]: https://docs.llmgateway.io/resources/rate-limits
[LG14]: https://docs.llmgateway.io/features/api-keys
[LG15]: https://docs.llmgateway.io/features/models-directory
[LG16]: https://docs.llmgateway.io/features/routing
[LG17]: https://docs.llmgateway.io/features/response-healing
[LG18]: https://docs.llmgateway.io/features/timeouts
[LG19]: https://docs.llmgateway.io/features/source
[LG24]: https://docs.llmgateway.io/resources/api-versioning
[LG26]: https://docs.llmgateway.io/features/master-keys

### Verified behavior

**Transport and auth**

- The base URL is `https://api.llmgateway.io/v1`, for example `POST https://api.llmgateway.io/v1/chat/completions`. OpenAI SDKs work with `baseURL: 'https://api.llmgateway.io/v1'`. ([LG1])
- Send the key as `Authorization: Bearer <key>`. The OpenAPI `info` block also says "(or `x-api-key`)". The security scheme is `bearerAuth` (http, scheme bearer). The docs show key format `llmgtwy_XXXXXXXXXXXXXXXX` and env var `LLM_GATEWAY_API_KEY`. ([LG6])
- `GET /v1/models` also accepts `x-api-key`. With no auth header it returns the public catalogue. Invalid, inactive or expired credentials return 401. ([LG15])
- Paths in the OpenAPI spec:
  - `GET /`
  - Chat and messages: `POST /v1/chat/completions`, `POST /v1/messages`
  - Embeddings and text: `POST /v1/embeddings`, `POST /v1/moderations`, `POST /v1/ocr`, `POST /v1/rerank`, `POST /v1/systemone`
  - Account and catalogue: `GET /v1/key`, `GET /v1/models`
  - Images: `POST /v1/images/generations`, `POST /v1/images/edits`
  - Audio and realtime: `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `POST /v1/realtime/client_secrets`
  - Video: `POST /v1/videos`, `GET /v1/videos/{video_id}`, `GET /v1/videos/logs/{log_id}/content`, `GET /v1/videos/{video_id}/content`

  ([LG6])
- The version is in the path (`/v1`). New fields can be added at any time, so clients should tolerate unknown fields. Deprecated endpoints send `Deprecation` and `Link` headers. They also send `Sunset` once a retirement date is set. ([LG24])

**Model catalogue (`GET /v1/models`)**

- **Auth.** None is required (`security: [{}, {bearerAuth}]`). With a key, the list is filtered by compliance policy, IAM rules and project access.
- **Query params** (all strings):
  - `include_restricted`
  - `include_deactivated`
  - `exclude_deprecated`
  - `no_training`
  - `mapped`: `true` returns one entry per provider mapping. The id is `provider/model-id`, and the entry carries that mapping's pricing, context length and capabilities.

  ([LG6])
- The response is `{data: Model[]}`. ([LG6])
  - **Required fields:** `id`, `name`, `display_name`, `family`, `architecture`, `top_provider`, `providers`, `pricing`, `json_output`, `structured_outputs`.
  - **All fields:**
    - `id`, `name`, `display_name`, `aliases[]`, `created` (number), `description`, `family`
    - `architecture{input_modalities[], output_modalities[], tokenizer}`, `top_provider{is_moderated}`, `providers[]`, `pricing{...}`
    - `context_length` (number), `max_output` (number), `per_request_limits` (map of strings), `supported_parameters` (string[])
    - `json_output`, `structured_outputs`, `free` (all boolean)
    - `deprecated_at`, `deactivated_at` (strings)
    - `stability`: `stable`, `beta`, `unstable` or `experimental`
- `pricing` object: ([LG6])
  - `prompt` and `completion` are required strings.
  - Optional strings: `image`, `input_audio`, `input_audio_cache_read`, `output_audio`, `request`, `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, `web_search`, `internal_reasoning`, `ocr_page`, `input_audio_hour`.
  - `per_second` and `per_image` are maps of strings.
- `providers[]` entries: ([LG6])
  - **Required:** `providerId`, `externalId`, `pricing`, `streaming` (boolean or `'only'`), `vision`, `cancellation`, `tools`, `parallelToolCalls`, `reasoning`.
  - **Optional:**
    - `realtime`
    - `reasoning_efforts`: a subset of none/minimal/low/medium/high/xhigh/max, in ascending order
    - `reasoning_modes`: standard or pro
    - `min_cacheable_tokens`
    - `max_output`: a larger `max_tokens` is rejected with HTTP 400
    - `stability`, `supportedVideoSizes`, `supportsVideoAudio`, `supportsVideoWithoutAudio`
- **LIVE:** the public response had 294 entries. Prices are decimal strings in exponent notation. ([LG8])
  - `gpt-4o-mini`: `pricing.prompt` `'0.15e-6'`, `completion` `'0.6e-6'`, `context_length` 128000, `max_output` 16384.
  - `text-embedding-3-small`: `prompt` `'0.02e-6'`, `context_length` 8192.
- **LIVE:** 13 models list `embedding` in `architecture.output_modalities`: ([LG8])
  - With price and context: text-embedding-3-small ($0.02/M, ctx 8192), text-embedding-3-large ($0.13/M, 8192), text-embedding-ada-002 ($0.10/M, 8192), gemini-embedding-001 ($0.15/M, 2048), gemini-embedding-2 ($0.20/M, 8192), text-embedding-005 ($0.025/M, 2048).
  - Also listed: text-embedding-004, text-multilingual-embedding-002, qwen3-embedding-0.6b, qwen3-embedding-8b, bge-m3, kinfra-text-embedding-0.6b, kinfra-text-embedding-4b.
  - Embedding entries still list chat params (temperature, tools and so on) in `supported_parameters`. That field cannot tell you whether a model is an embedding model.
- The documented catalog convention is per-token prices as strings, in USD per token, in e-6 notation. The custom-model example is `inputPrice` `"3.0e-6"`. ([LG26])

**Chat completions**

- Request fields: ([LG6])
  - **Required:** `model`, `messages`.
  - **Sampling:** `temperature`, `max_tokens`, `top_p`, `frequency_penalty`, `presence_penalty`, `n`.
  - **Output:** `response_format`, `stream` (default false).
  - **Prompt caching:** `prompt_cache_key`, `prompt_cache_retention`, `prompt_cache_options`.
  - **Tools:** `tools`, `tool_choice`.
  - **Reasoning:** `reasoning_effort`, `reasoning{effort,max_tokens,context,mode}`, `effort`, `verbosity`, `no_reasoning`.
  - **Routing:** `service_tier` (auto/default/flex/priority), `routing` (auto/price/throughput/latency), `free_models_only`.
  - **Other:** `user`, `web_search` (boolean), `plugins` (`[{id:'response-healing'}]`), `image_config`, `sensitive_word_check`.
- `response_format` takes one of three forms. ([LG6])
  - `{type:'text'}`
  - `{type:'json_object'}`
  - `{type:'json_schema', json_schema:{name, description?, schema, strict?: boolean}}`, where `name` and `schema` (an object) are required.
- `json_output` means soft JSON: `{type:'json_object'}` nudges the model, but no schema is guaranteed. `structured_outputs` means the upstream provider enforces `json_schema` natively. The gateway never emulates schema enforcement. A model without native support rejects `json_schema` with `400 does not support JSON schema output mode`. ([LG9])
- Tools: ([LG6])
  - A `tools[]` item is one of:
    - `{type:'function', function:{name, description?, parameters?}}`, with `name` required. Optional `defer_loading` and `cache_control` are Anthropic-only.
    - `{type:'tool_search', ...}`
    - `{type:'web_search', ...}`
  - `tool_choice` is `'auto'`, `'none'`, `'required'`, `{type:'function', function:{name}}` or `{type:'web_search'}`.
  - Messages accept role `tool` with `tool_call_id`.
  - Assistant messages carry `tool_calls[{id, type:'function', function:{name, arguments (string)}}]`.
- Reasoning input: ([LG10])
  - The `reasoning_effort` enum is none/minimal/low/medium/high/xhigh/max. `reasoning.effort` is the alternative. You cannot send both.
  - `reasoning.max_tokens` overrides effort on Anthropic and Google thinking models.
  - The gateway never downgrades an effort tier. An unsupported value causes a provider error.
  - The values each mapping accepts are in `providers[].reasoning_efforts`.
- Reasoning errors: ([LG10])
  - `reasoning_effort` on a non-reasoning model returns type `invalid_request_error`, code `model_not_supported` ("Model gpt-4o does not support reasoning...").
  - `verbosity` on a model that does not support it returns 400 `model_not_supported`.
  - `reasoning.mode` is accepted only where `reasoning_modes` lists it. Otherwise the request fails with 400.
- Reasoning output: ([LG10])
  - Text is in `choices[].message.reasoning` (string, nullable). When streaming it is in `delta.reasoning`.
  - `reasoning_details[]` carries encrypted reasoning or thought signatures. In multi-turn tool use it must be sent back unchanged.
  - Token counts: `usage.reasoning_tokens` and `usage.completion_tokens_details.reasoning_tokens`.
- Response shape: ([LG6])
  - **Top level** (all required): `id`, `object`, `created`, `model`, `choices[{index, message{role, content (nullable), reasoning?, tool_calls?, images?}, finish_reason}]`, `usage`, `metadata`.
  - **`usage`:**
    - `prompt_tokens`, `completion_tokens`, `total_tokens` (required)
    - `reasoning_tokens`
    - `prompt_tokens_details{cached_tokens (required), cache_write_tokens, cache_creation_tokens, cache_creation, audio_tokens, video_tokens}`
    - `completion_tokens_details{reasoning_tokens, image_tokens, audio_tokens}`
    - `cost` (number, nullable), `cost_details{...}`, `info`
- Costs are in USD. ([LG11])
  - `usage.cost` is the total inference cost.
  - `usage.cost_details` always has `upstream_inference_cost`, `upstream_inference_prompt_cost` and `upstream_inference_completions_cost` (required in the schema).
  - It may also have these nullable fields: `total_cost`, `input_cost`, `output_cost`, `cached_input_cost`, `cache_write_input_cost`, `request_cost`, `web_search_cost`, `image_input_cost`, `image_output_cost`, `audio_input_cost`, `data_storage_cost`.
  - When streaming, cost comes in the final usage chunk, before `data: [DONE]`.
- `metadata` fields: ([LG6])
  - **Required:** `request_id`, `requested_model`, `requested_provider` (nullable), `used_model`, `used_provider`, `underlying_used_model`.
  - **Optional:**
    - `used_region`, `log_id`, `organization_id`, `project_id`, `discount`
    - `cached`: true when the response was replayed from the gateway cache
    - `routing[]` entries: `{provider, model, region?, status_code, error_type, succeeded, credentialSource ('byok' or 'platform'), apiKeyHash?, providerKeyId?, providerKeyLabel?, logId?}`
- Routing: ([LG16])
  - A plain id such as `gpt-4o` goes to the best provider, with automatic retry and fallback (up to 2 retries by default).
  - A `provider/model` id such as `openai/gpt-4o` pins the provider and disables fallback. `X-No-Fallback: true` also disables fallback.
  - `model: 'auto'` turns on auto routing.
- Response Healing is enabled with `"plugins": [{"id": "response-healing"}]`. It works only when `response_format` is `json_object` or `json_schema`. ([LG17])
- Hard timeouts: streaming 20 min, non-streaming 10 min, end-to-end 25 min. A timeout returns 504 `timeout_error`. ([LG18])
- The optional `X-Source` header gives a domain for attribution. After normalization it may contain only letters, digits, hyphens, dots and slashes. Any other value fails the whole request with 400. Custom metadata headers use the `X-LLMGateway-` prefix. ([LG19])

**Embeddings**

- `POST /v1/embeddings` request: ([LG6])
  - `input` (required): a string, string[], integer[] or integer[][]. It must not exceed the model's max input tokens (8192 for OpenAI text-embedding-3 and ada-002).
  - `model` (required).
  - `encoding_format`: `float` or `base64`.
  - `dimensions`: integer > 0. Only for models that support shortening, such as text-embedding-3-*, gemini-embedding-* and qwen3-embedding-8b.
  - `user`.
- Response: `{object:'list', data:[{object:'embedding', embedding: number[] or base64 string, index: integer}], model, usage:{prompt_tokens, total_tokens}}`. The schema has no cost field for embeddings. ([LG6])
- Documented models: ([LG2])
  - OpenAI: text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002.
  - Google AI Studio: gemini-embedding-2 (recommended), gemini-embedding-001 (legacy).
  - Google Vertex: gemini-embedding-001, text-embedding-005.
  - Embeddings are billed for input tokens only.

**Keys, limits, errors**

- Keys belong to a project. ([LG3])
  - Each key can have an all-time spend limit, a recurring limit and a TTL, all optional. The recurring window runs from 1 hour to 12 months, in hour/day/week/month units.
  - IAM rules can allow or deny models, providers and pricing. IP CIDR rules are Enterprise only.
  - Each plan caps the number of active keys.
- `GET /v1/key` needs bearer auth. It returns `{data:{...}}` with these fields: ([LG6])
  - `label`
  - `usage`: USD string, the total this key has accrued
  - `limit`: USD string, nullable
  - `devPlan`: `none`, `lite`, `pro` or `max`
  - `devPlanCreditsUsed`, `devPlanCreditsLimit`, `devPlanCreditsRemaining`, `devPlanPremiumWeeklyLimit`, `devPlanPremiumCreditsUsed`, `devPlanPremiumWeekResetsAt` (nullable)
  - It does not include billing details or the key token.
- A key that reaches its usage limit gets 401, code `invalid_api_key`, with the example message `Unauthorized: LLMGateway API key reached its usage limit.`. An IAM violation gets 403 `permission_denied`. ([LG14])
- Errors use the envelope `{error:{message, type, param (nullable), code (nullable)}}`. The HTTP status is authoritative. ([LG12])
  - Status to type/code (gateway-raised):

    | Status | type / code |
    |---|---|
    | 400 | `invalid_request_error` |
    | 401 | `invalid_request_error` / `invalid_api_key` |
    | 402 | `invalid_request_error` / `billing_error` |
    | 403 | `permission_denied` |
    | 404 | `not_found` |
    | 408 | `timeout_error` / `timeout` |
    | 410 | archived or blocked project/org |
    | 413 | `request_too_large` |
    | 415 | `unsupported_media_type` |
    | 429 | `rate_limit_error` / `rate_limit_exceeded` |
    | 499 | `request_cancelled` |
    | 504 | `timeout_error` / `timeout` |
    | 529 | `overloaded` / `overloaded` |
    | other 5xx | `api_error` |

  - Validation codes include `invalid_json`, `model_not_found` and `unsupported_parameter_combination`.
- Upstream failures: ([LG12])
  - If every upstream provider fails, the gateway returns 500 (`upstream_error` or `gateway_error`) or 502 (`upstream_error`/`all_providers_failed`).
  - Connection failures return 502 `upstream_error`/`fetch_failed`. Upstream timeouts return 504.
  - An error after a stream has started arrives as an SSE `error` event with the same envelope. The HTTP status stays 200.
- Limits: ([LG13])
  - **RPM:** default per-org limits, counted separately per endpoint over a rolling 60 s window: chat 600, embeddings 1200, models 1200, key 1200.
  - **PAYG trust tiers 0 to 4:** RPM multiplier 1x/2x/4x/10x/20x and concurrency 100/200/400/1000/2000.
  - **Spend caps (daily/monthly):** $25/$250 at tier 0, up to $15,000/$200,000 at tier 4. Hitting a spend cap returns 429.
  - **Dev plans:** embeddings return 403.
- Rate-limit headers: ([LG13])
  - `RateLimit-Policy`, e.g. `"requests";q=600;w=60`
  - `RateLimit`, e.g. `"requests";r=599;t=60`
  - `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (delay in seconds)
  - Legacy `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix timestamp)
  - 429 and 529 responses carry `Retry-After` in seconds.
  - Upstream provider rate-limit headers are never forwarded.

### Implementation contract

**Transport**

- Send `Authorization: Bearer ${LLM_GATEWAY_API_KEY}` and `Content-Type: application/json` to `https://api.llmgateway.io/v1`. `x-api-key` is also accepted, but every doc example uses Bearer. The official `openai` npm SDK works with `baseURL: "https://api.llmgateway.io/v1"`.
- Optional headers:
  - `X-Source: <domain>`: validate it or leave it out, because a malformed value fails the request with 400.
  - `X-LLMGateway-<Name>: <value>` for metadata.
  - `X-No-Fallback: true` to turn off fallback.
  - `x-session-id` for sticky routing.
- Tolerate unknown response fields. The API adds fields without changing the version.

**Model discovery: `GET /v1/models`**

- Use the authenticated call for capability checks. The unauthenticated call returns the whole public catalogue, unfiltered.
- Query flags are strings. `mapped="true"` gives one entry per `provider/model`.
- Parse these fields:
  - `id`, `name`, `context_length?`, `max_output?`, `json_output`, `structured_outputs`, `supported_parameters?`, `deprecated_at?`, `deactivated_at?`, `free?`, `stability?`.
  - `providers[].tools`, `.reasoning`, `.vision`, `.streaming` (boolean or `"only"`), `providers[].reasoning_efforts?` (the exact accepted `reasoning_effort` values), `providers[].max_output?`.
- A model is an embedding model when `architecture.output_modalities` includes `"embedding"`. Do not use `supported_parameters` for this.
- `pricing.prompt` and `pricing.completion` are **strings** such as `"0.15e-6"`. Parse them with `Number()`, which handles exponent notation. Treat them as USD per token (the documented catalog convention, but see the unverified notes). Also read `input_cache_read`, `request` (a flat per-request fee) and `web_search`.
- Zod-style shape: prices are `z.string()`, `context_length` is `z.number().optional()`, `streaming` is `z.union([z.boolean(), z.literal("only")])`. Use `.passthrough()` on objects.
- Check `deactivated_at`. Do not pick models that are already deactivated or deactivate soon. Live data has real dates, e.g. `gemini-2.5-flash` `deactivated_at` `2026-10-16`.

**Chat: `POST /v1/chat/completions`**

- Model id:
  - A plain id (e.g. `gpt-4o-mini`) gets smart routing with fallback.
  - `provider/model` pins the provider, with no fallback.
  - `auto` lets the gateway choose.
- Structured output:
  - Strict: `response_format: { type: "json_schema", json_schema: { name, schema, strict?: true, description? } }`. Use it only when `structured_outputs: true`. Otherwise the call fails with `400 ... does not support JSON schema output mode`. There is no emulation and no downgrade.
  - Soft: `{ type: "json_object" }`, when `json_output: true`.
  - Always validate client-side. `plugins: [{ id: "response-healing" }]` can repair malformed JSON.
- Tools use the OpenAI format.
  - Read `choices[0].message.tool_calls[{id,type:"function",function:{name,arguments:string}}]`.
  - Reply with `{role:"tool", tool_call_id, content}`.
  - For reasoning models, send the assistant message back unchanged, including `reasoning_details`.
- Reasoning:
  - Send either `reasoning_effort` or `reasoning: { effort, max_tokens?, mode? }`, never both.
  - Send it only when `providers[].reasoning` is true and the value is in `reasoning_efforts`. Otherwise the call fails with 400 `model_not_supported`.
  - Read the output from `message.reasoning` (nullable) and `usage.reasoning_tokens` / `usage.completion_tokens_details.reasoning_tokens`.
- `max_tokens` is the documented field, not `max_completion_tokens`. A value above the mapping's `max_output` is rejected with 400.
- Usage and cost come in the body only. No header carries cost.
  - Record `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`, `usage.cost` (USD, nullable), `usage.cost_details.*` (nullable numbers) and `prompt_tokens_details.cached_tokens`.
  - When streaming, these come in the final chunk before `data: [DONE]`.
  - Also record `metadata.request_id`, `metadata.used_model`, `metadata.used_provider` and `metadata.cached`.

**Embeddings: `POST /v1/embeddings`**

- Request: `{ model: string, input: string | string[] | number[] | number[][], encoding_format?: "float"|"base64", dimensions?: int>0, user?: string }`.
  - `dimensions` works only on models that support shortening.
  - Each input must fit the model's max input tokens: 8192 for OpenAI text-embedding-3 and ada-002. The live `context_length` is 2048 for gemini-embedding-001 and text-embedding-005.
- Response: sort `data` by `index`.
- Cost: there is no cost field. Compute it as `prompt_tokens * Number(pricing.prompt)`, using the price from `/v1/models`.
- Model choice:
  - Suggested default: `text-embedding-3-small` ($0.02 per 1M tokens, 8192 ctx).
  - Documented: `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`, `gemini-embedding-2` (recommended), `gemini-embedding-001`, `text-embedding-005`.
- Embeddings return 403 on Dev (DevPass) plans.

**Key budget: `GET /v1/key`**

- Returns `{ data: { label, usage: "<USD string>", limit: "<USD string>" | null, devPlan, ... } }`.
- Use it for a pre-flight or periodic budget check: `Number(limit) - Number(usage)`.

**Errors and retries**

The body is `{ error: { message, type, param: string|null, code: string|null } }`. Trust the HTTP status.

| Status | type / code | Action |
|---|---|---|
| 400 | validation | Do not retry |
| 401 | `invalid_api_key` | Bad or expired key, **or** the key hit its all-time or recurring spend limit. If `message` contains "usage limit", report a budget error. Do not retry |
| 402 | `billing_error` | Out of credits. Do not retry |
| 403 | `permission_denied` | IAM, compliance or plan. Do not retry |
| 404 | `not_found` / `model_not_found` | Unknown model |
| 408, 504 | `timeout_error` | Retryable |
| 410 | none | Project archived or org blocked. Fatal |
| 413 | `request_too_large` | Request too large |
| 429 | `rate_limit_error` | RPM, concurrency or daily/monthly spend cap. Wait `Retry-After` seconds, then back off exponentially with jitter. A spend cap will not clear quickly |
| 500, 502 | `upstream_error` / `gateway_error` / `all_providers_failed` / `fetch_failed` | Retry with backoff |
| 529 | `overloaded` | Retry after `Retry-After` (usually 1 s) |

- Mid-stream errors arrive as an SSE `error` event with the same envelope while the status stays 200.
- Read `RateLimit-Remaining` and `RateLimit-Reset`. They appear only on authenticated responses that passed an RPM check.
- Defaults to plan for: chat 600 RPM, embeddings 1200, models 1200, key 1200, and a tier-0 PAYG concurrency of 100.
- Set the client timeout a little above the gateway timeouts: 10 min for non-streaming, 20 min for streaming.

### Unverified / to recheck with credentials

- **Embedding cost in responses.** The OpenAPI embeddings schema has only `usage.prompt_tokens` and `usage.total_tokens`. The cost-breakdown page says "API responses include cost fields" but shows only chat examples. Treat embedding cost as unknown and compute it from `pricing.prompt` × `prompt_tokens`.
- **Unit of `/v1/models` pricing strings.** The OpenAPI schema does not state it. USD per token is inferred from the documented catalog convention (master-keys, custom-providers) and from live values: `'0.02e-6'` for text-embedding-3-small matches $0.02/M.
- **Tool calling.** There is no dedicated docs page. The contract comes from the OpenAPI schema and SDK examples (developers/ai-sdk, migrations/litellm). `parallel_tool_calls` is not in the OpenAPI request schema, but it appears in `supported_parameters` for 8 live models, so its behavior is unverified. `providers[].parallelToolCalls` is a capability flag.
- **Unlisted request params.** `seed`, `stop`, `stream_options`, `max_completion_tokens`, `logprobs` and `parallel_tool_calls` are not in the OpenAPI chat request schema, though some models list them in `supported_parameters`. Whether the gateway forwards them is unverified. It is also unverified whether `stream_options.include_usage` is needed; quick-start says the final stream chunk carries usage without it.
- **Response headers.** The OpenAPI spec defines no header carrying cost or request id. Cost is only in `usage.cost` and the request id only in `metadata.request_id`. An `x-trace-id` header was seen on the unauthenticated `/v1/models` response but is not documented.
- **Embedding batch size.** No per-request cap on the number of items in the `input` array is documented. Only the per-input token limit is.
- **Embedding dimensions.** Output dimensions per model are not listed in the docs or in `/v1/models`.
- **Telling 401 causes apart.** "Key usage limit reached" and "invalid key" both use code `invalid_api_key`. The only documented distinction is the example message `Unauthorized: LLMGateway API key reached its usage limit.`.
- **Bodies for spend-cap 429 and PAYG 402.** The exact bodies for an org daily/monthly spend-cap 429 and for a 402 `billing_error` when PAYG credits run out are not documented. Only the status codes are.

---

## 2. Google Search Console API (read-only)

Covers Search Analytics query, Sites list and URL Inspection (`index.inspect`).

### Sources

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| GSC1 | https://developers.google.com/webmaster-tools/v1/searchanalytics/query | 2026-09-24 | yes | Primary reference. Page last updated 2026-08-11. WebFetch plus raw HTML |
| GSC2 | https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data | 2026-09-24 | yes | "Getting your performance data". Last updated 2025-08-28 |
| GSC3 | https://developers.google.com/webmaster-tools/limits | 2026-09-24 | yes | Usage limits. Last updated 2025-08-28 |
| GSC4 | https://developers.google.com/webmaster-tools/v1/sites/list | 2026-09-24 | yes | |
| GSC5 | https://developers.google.com/webmaster-tools/v1/sites | 2026-09-24 | yes | |
| GSC6 | https://developers.google.com/webmaster-tools/v1/api_reference_index | 2026-09-24 | yes | |
| GSC7 | https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect | 2026-09-24 | yes | |
| GSC8 | https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult | 2026-09-24 | yes | |
| GSC9 | https://searchconsole.googleapis.com/$discovery/rest?version=v1 | 2026-09-24 | yes | LIVE public discovery doc, revision 20260923 |
| GSC10 | https://www.googleapis.com/discovery/v1/apis?name=searchconsole | 2026-09-24 | yes | Discovery directory |
| GSC11 | https://www.googleapis.com/discovery/v1/apis/webmasters/v3/rest | 2026-09-24 | yes | Response was not valid JSON (legacy discovery doc retired) |
| GSC12 | https://developers.google.com/webmaster-tools/v1/how-tos/authorizing | 2026-09-24 | yes | |
| GSC13 | https://developers.google.com/identity/protocols/oauth2/scopes | 2026-09-24 | yes | Section "Google Search Console API, v1" |
| GSC14 | https://developers.google.com/webmaster-tools/v1/errors | 2026-09-24 | yes | |
| GSC15 | https://developers.google.com/webmaster-tools/v1/how-tos/performance | 2026-09-24 | yes | |
| GSC16 | https://developers.google.com/webmaster-tools/v1/searchanalytics | 2026-09-24 | yes | Resource page: only top rows are guaranteed |
| GSC17 | https://developers.google.com/webmaster-tools/about | 2026-09-24 | yes | |
| GSC18 | https://developers.google.com/search/blog/2025/04/san-hourly-data | 2026-09-24 | yes | Official blog, 2025-04-09 |
| GSC19 | https://developers.google.com/search/blog/2022/10/performance-data-deep-dive | 2026-09-24 | yes | Official blog |
| GSC20 | https://developers.google.com/search/blog/2020/12/search-console-api-updates | 2026-09-24 | yes | Official blog |
| GSC21 | https://developers.google.com/search/blog/2024/12/recent-data-search-console | 2026-09-24 | yes | Context only (24-hour UI view) |
| GSC22 | https://support.google.com/webmasters/answer/34592?hl=en | 2026-09-24 | yes | WebFetch summary |
| GSC23 | https://support.google.com/webmasters/answer/96568?hl=en | 2026-09-24 | yes | WebFetch summary |
| GSC24 | https://support.google.com/webmasters/answer/7576553?hl=en | 2026-09-24 | yes | WebFetch summary. Does not state the 16-month retention |
| GSC25 | https://support.google.com/webmasters/answer/17011259?hl=en | 2026-09-24 | yes | WebFetch summary |
| GSC26 | https://support.google.com/analytics/answer/10737381?hl=en | 2026-09-24 | yes | WebFetch summary |
| GSC27 | https://github.com/AKzar1el/mcp-gsc/pull/129 | 2026-09-24 | yes | SECONDARY (third-party PR). Used only as a hint on metadata casing |

[GSC1]: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
[GSC2]: https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data
[GSC3]: https://developers.google.com/webmaster-tools/limits
[GSC4]: https://developers.google.com/webmaster-tools/v1/sites/list
[GSC5]: https://developers.google.com/webmaster-tools/v1/sites
[GSC6]: https://developers.google.com/webmaster-tools/v1/api_reference_index
[GSC7]: https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
[GSC8]: https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult
[GSC9]: https://searchconsole.googleapis.com/$discovery/rest?version=v1
[GSC10]: https://www.googleapis.com/discovery/v1/apis?name=searchconsole
[GSC12]: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
[GSC13]: https://developers.google.com/identity/protocols/oauth2/scopes
[GSC14]: https://developers.google.com/webmaster-tools/v1/errors
[GSC15]: https://developers.google.com/webmaster-tools/v1/how-tos/performance
[GSC17]: https://developers.google.com/webmaster-tools/about
[GSC18]: https://developers.google.com/search/blog/2025/04/san-hourly-data
[GSC19]: https://developers.google.com/search/blog/2022/10/performance-data-deep-dive
[GSC20]: https://developers.google.com/search/blog/2020/12/search-console-api-updates
[GSC22]: https://support.google.com/webmasters/answer/34592?hl=en
[GSC23]: https://support.google.com/webmasters/answer/96568?hl=en
[GSC26]: https://support.google.com/analytics/answer/10737381?hl=en

### Verified behavior

**Hosts and discovery**

- The HTML reference documents `POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`. Its example URL-encodes siteUrl: `.../sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query`. ([GSC1])
- The reference index says Search Analytics, Sitemaps and Sites URIs are relative to `https://www.googleapis.com/webmasters/v3`, and URL Inspection URIs are relative to `https://searchconsole.googleapis.com/v1`. ([GSC6])
- The current discovery doc (`searchconsole` v1, revision 20260923) has rootUrl/baseUrl `https://searchconsole.googleapis.com/` and servicePath `''`. So `searchconsole.googleapis.com` also serves the `webmasters/v3` paths. ([GSC9]) Its method paths:

  | Method | HTTP | Path |
  |---|---|---|
  | `searchanalytics.query` | POST | `webmasters/v3/sites/{siteUrl}/searchAnalytics/query` |
  | `sites.list` | GET | `webmasters/v3/sites` |
  | `sites.get` | GET | `webmasters/v3/sites/{siteUrl}` |
  | `sitemaps.list` | GET | `webmasters/v3/sites/{siteUrl}/sitemaps` |
  | `urlInspection.index.inspect` | POST | `v1/urlInspection/index:inspect` |
- The discovery directory lists `searchconsole:v1` (`preferred: true`, discoveryRestUrl `https://searchconsole.googleapis.com/$discovery/rest?version=v1`). A lookup for `name=webmasters` returns no items. ([GSC10])
- In 2020 Google moved the discovery doc from `https://www.googleapis.com/discovery/v1/apis/webmasters/v3/rest` to `https://searchconsole.googleapis.com/$discovery/rest`. ([GSC20])
  - The name changed from webmasters to searchconsole, and the version from v3 to v1.
  - The announcement said "We'll drop the support in the Webmasters discovery document".
  - Client libraries changed from `build('webmasters','v3')` to `build('searchconsole','v1')`.

**Auth and access**

- OAuth 2.0 is the only supported protocol ("No other authorization protocols are supported"). "All requests to the Google Search Console API must be authorized by an authenticated user." ([GSC12])
  - `https://www.googleapis.com/auth/webmasters` is read/write.
  - `https://www.googleapis.com/auth/webmasters.readonly` is read-only.
- In the OAuth scopes list: ([GSC13])
  - `webmasters.readonly`: "View Search Console data for your verified sites".
  - `webmasters`: "View and manage Search Console data for your verified sites".
- `searchAnalytics.query` requires at least one of those two scopes. ([GSC1])
- "You must have appropriate access (owner, full, read) to any Google Search Console account that you wish to access using the API." ([GSC17])

**Properties and sites**

- `siteUrl` examples: `http://www.example.com/` for a URL-prefix property, `sc-domain:example.com` for a Domain property. ([GSC1])
- A Domain property includes all subdomains (m, www, and so on) and multiple protocols (http, https, ftp). A URL-prefix property includes only URLs with that prefix, including the protocol. ([GSC22])
- `sites.list` is `GET https://www.googleapis.com/webmasters/v3/sites` with no body and scope `webmasters.readonly` or `webmasters`. The response is `{ "siteEntry": [ sites Resource ] }`. ([GSC4])
- A sites resource is `{siteUrl, permissionLevel}`. `permissionLevel` is `siteFullUser`, `siteOwner`, `siteRestrictedUser` or `siteUnverifiedUser`. ([GSC5])
- The discovery enum is `SITE_PERMISSION_LEVEL_UNSPECIFIED`, `SITE_OWNER`, `SITE_FULL_USER`, `SITE_RESTRICTED_USER`, `SITE_UNVERIFIED_USER`. `SITE_UNVERIFIED_USER` is described as "Unverified user has no access to site's data." ([GSC9])

**searchAnalytics.query request**

- Body fields: ([GSC1])
  - `startDate`: required, YYYY-MM-DD, PT, inclusive.
  - `endDate`: required, inclusive, must be >= `startDate`.
  - `dimensions[]`.
  - `searchType`: "Deprecated, use type instead".
  - `type`.
  - `dimensionFilterGroups[]`: each has `groupType` and `filters[]` of `{dimension, operator, expression}`.
  - `aggregationType`, `rowLimit`, `startRow`, `dataState`.
- `dimensions[]`: ([GSC1])
  - Results are grouped in the order you list the dimensions.
  - Allowed values are any filter dimension plus `date` and `hour`.
  - With no dimensions, everything is combined into one row.
  - There is no limit on the number of dimensions, but you cannot group by the same one twice.
- The discovery enum for dimensions is DATE, QUERY, PAGE, COUNTRY, DEVICE, SEARCH_APPEARANCE, HOUR. ([GSC9])
  - HOUR keys use `YYYY-MM-DDThh:mm:ss[+|-]hh:mm` in PT (UTC-7:00/8:00). Data is available for up to 10 days. It requires `dataState` HOURLY_ALL.
  - DATE keys use `YYYY-MM-DD` in PT.
- `type` values: ([GSC1])
  - `discover`: Discover results.
  - `googleNews`: news.google.com and the Google News app. Excludes the Search "News" tab.
  - `news`: the Search "News" tab.
  - `image`: the Search "Image" tab.
  - `video`: video search results.
  - `web`: the default. The combined "All" tab, without Discover or Google News.
- The discovery enum for `type`/`searchType` is WEB, IMAGE, VIDEO, NEWS, DISCOVER, GOOGLE_NEWS. Both fields exist in the request schema. ([GSC9])
- Filter dimensions: ([GSC1])
  - `country`: ISO 3166-1 alpha-3.
  - `device`: DESKTOP, MOBILE or TABLET.
  - `page`: URI string.
  - `query`: query string.
  - `searchAppearance`: to list the available values, run a query grouped by searchAppearance.
  - You can filter on a dimension you are not grouping by.
- Operators: ([GSC1])
  - `contains`: contains or equals, not case-sensitive.
  - `equals`: the default. Exact, and case-sensitive for page and query.
  - `notContains`.
  - `notEquals`: case-sensitive for page and query.
  - `includingRegex` and `excludingRegex`: RE2 syntax.
  - The `filters[]` description says "Max length 4096 characters."
- `groupType` accepts only `and`. OR within a group is "not yet supported". A row is returned only if all filter groups match. ([GSC1])
- `aggregationType`: ([GSC1])
  - `auto`: the default, lets the service decide.
  - `byPage`: aggregates by canonical URI.
  - `byProperty`: not supported for `type=discover` or `googleNews`. Not allowed if you group or filter by page.
  - `byNewsShowcasePanel`: needs the NEWS_SHOWCASE searchAppearance filter and `type` discover or googleNews. Not allowed with a page group or page filter, or with a filter on another searchAppearance.
  - Any value other than `auto` is either echoed in the response or rejected with an error.
- `rowLimit` is 1 to 25,000, default 1,000. `startRow` is a zero-based, non-negative index, default 0. If it is past the last result, the response succeeds with zero rows. ([GSC1])
- `dataState` values (case-insensitive): ([GSC1])
  - `all`: includes fresh data.
  - `final`, or omitted: finalized data only.
  - `hourly_all`: hourly breakdown, including partial data. Use it when grouping by HOUR.
- The discovery enum is DATA_STATE_UNSPECIFIED ("should not be used"), FINAL, ALL, and HOURLY_ALL ("Required when grouping by HOUR"). ([GSC9])

**Response**

- Shape: `{ rows: [{ keys: string[], clicks, impressions, ctr, position }], responseAggregationType, metadata }`. ([GSC1])
  - Metrics are doubles. `ctr` ranges from 0 to 1.0 inclusive.
  - `keys` follow the order of the request's dimensions.
  - `responseAggregationType` is `auto`, `byPage` or `byProperty`.
- The HTML reference names two metadata fields. All dates and times are in America/Los_Angeles. ([GSC1])
  - `first_incomplete_date` (YYYY-MM-DD): present only when `dataState` is all, data is grouped by date, and the range has incomplete points.
  - `first_incomplete_hour` (`YYYY-MM-DDThh:mm:ss[+|-]hh:mm`): present only when `dataState` is hourly_all, data is grouped by hour, and the range has incomplete points.
- The discovery Metadata schema declares these in camelCase: `firstIncompleteDate` and `firstIncompleteHour`. Its `responseAggregationType` enum is AUTO, BY_PROPERTY, BY_PAGE, BY_NEWS_SHOWCASE_PANEL. ([GSC9])
- Rows are sorted by clicks, descending. When grouped by date they are sorted by date, oldest first. Ties are in arbitrary order. Days with no data are omitted. ([GSC1])
- "The API is bounded by internal limitations of Search Console and does not guarantee to return all data rows but rather top ones." ([GSC1])

**Completeness, pagination, freshness**

- To paginate, re-run the same query and raise `startRow` by 25,000 each time until a response has 0 rows. The guide's pseudocode uses `maxRows = 25000`. ([GSC2])
- The method returns at most 50K rows per day per search type, sorted by clicks. Google recommends querying one day at a time. "Data is typically available after 2-3 days". ([GSC2])
- Grouping by page and/or query may drop some data. Leave those dimensions out for accurate counts. ([GSC2])
- `searchAppearance` cannot be combined with other dimensions. ([GSC2])
  - Step 1: group by `searchAppearance` alone.
  - Step 2: filter on one value (operator `equals`) and add the other dimensions.
  - Example values: INSTANT_APP, AMP_BLUE_LINK.
- Anonymized queries are "those that aren't issued by more than a few dozen users over a two-to-three month period". ([GSC19])
  - They are always left out of table rows, including API rows.
  - They are counted in chart totals, unless you filter by query.
  - "The anonymized queries are omitted whenever a filter is applied".
- The export limit is "50,000 rows per day per site per search type, which may not be reached in all cases". ([GSC19])
  - `rowLimit` goes up to 25,000, and `startRow` fetches rows 25,001 to 50,000.
  - Requests without query or URL dimensions (for example countries, devices, Search Appearances) return all the data.
  - The UI export maximum is 1,000 rows.
- The API returns up to 10 days of hourly data. The sample request is `{"startDate":"2025-04-07","endDate":"2025-04-07","dataState":"HOURLY_ALL","dimensions":["HOUR"]}`. Sample keys look like `"2025-04-07T00:00:00-07:00"`, and the sample response has `"responseAggregationType": "byProperty"`. ([GSC18])
- "Search Console keeps data for the last 16 months." ([GSC26])
- The Performance report labels daily data by California local time. Some queries that are very rare, or that contain personal or sensitive information, may not be tracked. Data is normally available in 2-3 days. ([GSC23])

**URL Inspection**

- `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`, with scope `webmasters` or `webmasters.readonly`. The response is `{ inspectionResult: UrlInspectionResult }`. ([GSC7])
  - `inspectionUrl`: required. A fully qualified URL under the `siteUrl` property.
  - `siteUrl`: required. A URL-prefix property must include the trailing `/`.
  - `languageCode`: optional, IETF BCP-47, default `en-US`.
  - Only the status of the version in Google's index is available. You cannot test a live URL.
- Result schema: ([GSC8])
  - `UrlInspectionResult`: `{ inspectionResultLink, indexStatusResult, ampResult (absent if not AMP), mobileUsabilityResult (deprecated), richResultsResult (absent if none) }`.
  - `IndexStatusInspectionResult`: `{ sitemap[], referringUrls[], verdict, coverageState (string), robotsTxtState, indexingState, lastCrawlTime (RFC3339 UTC), pageFetchState, googleCanonical, userCanonical, crawledAs }`.
- Enums: ([GSC8])
  - **Verdict:** VERDICT_UNSPECIFIED, PASS, PARTIAL (reserved, no longer used), FAIL, NEUTRAL.
  - **RobotsTxtState:** ROBOTS_TXT_STATE_UNSPECIFIED, ALLOWED, DISALLOWED.
  - **IndexingState:** INDEXING_STATE_UNSPECIFIED, INDEXING_ALLOWED, BLOCKED_BY_META_TAG, BLOCKED_BY_HTTP_HEADER, BLOCKED_BY_ROBOTS_TXT (reserved, no longer used).
  - **PageFetchState:** PAGE_FETCH_STATE_UNSPECIFIED, SUCCESSFUL, SOFT_404, BLOCKED_ROBOTS_TXT, NOT_FOUND, ACCESS_DENIED, SERVER_ERROR, REDIRECT_ERROR, ACCESS_FORBIDDEN, BLOCKED_4XX, INTERNAL_CRAWL_ERROR, INVALID_URL.
  - **CrawlingUserAgent:** CRAWLING_USER_AGENT_UNSPECIFIED, DESKTOP, MOBILE.
  - **Severity:** SEVERITY_UNSPECIFIED, WARNING, ERROR.
  - **RichResultsInspectionResult:** `{ detectedItems[]: { richResultType, items[]: { name, issues[]: { issueMessage, severity } } }, verdict }`.

**Quotas**

| Scope | Search Analytics | URL Inspection | Other resources (e.g. `sites.list`) |
|---|---|---|---|
| Per site | 1,200 QPM | 600 QPM, 2,000 QPD | none listed |
| Per user | 1,200 QPM | none listed | 20 QPS, 200 QPM |
| Per project | 40,000 QPM, 30,000,000 QPD | 15,000 QPM, 10,000,000 QPD | 100,000,000 QPD |

([GSC3])

- Search Analytics also has a load quota. ([GSC3])
  - Short-term load is measured in 10-minute chunks. If you exceed it, wait 15 minutes and retry.
  - Long-term load is measured in 1-day chunks.
  - Every quota-exceeded event returns the same "quota exceeded" error.
  - Grouping or filtering by page or query is expensive, and page AND query together is the most expensive. Load also grows with the date range.

**Errors and misc**

- Standard error JSON: `{ "error": { "errors": [ { "domain", "reason", "message", "locationType", "location" } ], "code": <int>, "message": string } }`. ([GSC14]) Reasons by status:
  - 403: `quotaExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `insufficientPermissions`, `accessNotConfigured`, `forbidden`.
  - 429: `rateLimitExceeded`.
  - 401: `unauthorized`, `authError`, `expired`, `required`.
- Global parameters in the discovery doc: `access_token`, `fields`, `prettyPrint`, `oauth_token`, `uploadType`, `upload_protocol`, `alt`, `$.xgafv`, `quotaUser`, `callback`, `key`. ([GSC9])
- For gzip, set `Accept-Encoding: gzip` and include `gzip` in the User-Agent. The `fields` parameter returns partial responses. ([GSC15])

### Implementation contract

**Hosts**

- Search Analytics, Sites and Sitemaps use the path `/webmasters/v3/...` on either documented host:
  - `https://www.googleapis.com/webmasters/v3`: used by the HTML reference pages, current as of 2026-08-11.
  - `https://searchconsole.googleapis.com/webmasters/v3`: from the discovery doc (`preferred: true`). The official client libraries use this host.
- Default to `https://searchconsole.googleapis.com`. Make the host configurable (`GSC_BASE_URL`) so it can fall back to `https://www.googleapis.com`.
- URL Inspection has only one host: `https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`.

**Auth**

- Use OAuth 2.0 only and send `Authorization: Bearer <access_token>`. API keys cannot read user data.
- Request only `https://www.googleapis.com/auth/webmasters.readonly`. It covers searchanalytics.query, sites.list/get, sitemaps.list/get and urlInspection.index.inspect. Never request `.../auth/webmasters`.
- The user needs owner, full or restricted access to the property (the about page says "owner, full, read"). Drop sites whose `permissionLevel` is `siteUnverifiedUser` / `SITE_UNVERIFIED_USER`.

**siteUrl formats**

- URL-prefix: `https://www.example.com/`. It includes the protocol and covers only that protocol, host and path prefix. URL Inspection requires the trailing `/`.
- Domain: `sc-domain:example.com`. It covers all subdomains and protocols.
- In path params, encode with `encodeURIComponent(siteUrl)`. In the URL Inspection JSON body, send `siteUrl` unencoded.
- Take the exact `siteUrl` strings from `sites.list` rather than building them.

**sites.list**

`GET {base}/webmasters/v3/sites`, no body:

```ts
interface SitesListResponse { siteEntry?: { siteUrl: string; permissionLevel: string }[] }
```

Normalize `permissionLevel` case-insensitively with underscores removed, since the HTML docs use `siteOwner` and the discovery doc uses `SITE_OWNER`. Treat a missing `siteEntry` as `[]`.

**searchAnalytics.query**

`POST {base}/webmasters/v3/sites/{encodeURIComponent(siteUrl)}/searchAnalytics/query`

```ts
type Dimension = 'query'|'page'|'country'|'device'|'searchAppearance'|'date'|'hour';
type SearchType = 'web'|'image'|'video'|'news'|'discover'|'googleNews'; // send as `type`; `searchType` is deprecated
type Operator = 'equals'|'notEquals'|'contains'|'notContains'|'includingRegex'|'excludingRegex'; // RE2
interface QueryRequest {
  startDate: string;              // required, YYYY-MM-DD, Pacific time, inclusive
  endDate: string;                // required, >= startDate, inclusive
  dimensions?: Dimension[];       // no duplicates; order = order of row.keys
  type?: SearchType;              // default 'web'
  dimensionFilterGroups?: { groupType?: 'and'; filters: { dimension: 'query'|'page'|'country'|'device'|'searchAppearance'; operator?: Operator; expression: string }[] }[];
  aggregationType?: 'auto'|'byPage'|'byProperty'|'byNewsShowcasePanel'; // default 'auto'
  rowLimit?: number;              // 1..25000, default 1000
  startRow?: number;              // >=0, default 0
  dataState?: 'final'|'all'|'hourly_all'; // default final; case-insensitive
}
interface QueryResponse {
  rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
  responseAggregationType?: string; // 'byProperty' | 'byPage' | 'auto' (discovery: BY_PROPERTY ...)
  metadata?: { first_incomplete_date?: string; first_incomplete_hour?: string; firstIncompleteDate?: string; firstIncompleteHour?: string };
}
```

Validate these rules client-side before sending:

- `country` is ISO 3166-1 alpha-3 (e.g. `usa`, `FRA`). `device` is `DESKTOP`, `MOBILE` or `TABLET`.
- `groupType` supports only `and`. For OR, use `includingRegex` with `a|b`, or run several queries.
- A filter expression can be at most 4096 characters. `equals` and `notEquals` are case-sensitive for page and query; `contains` is not.
- The `hour` dimension requires `dataState: 'hourly_all'`, and only about 10 days of hourly data exist.
- `aggregationType: 'byProperty'` is invalid when you group or filter by page, and for `type` discover or googleNews.
- `byNewsShowcasePanel` requires a searchAppearance filter `NEWS_SHOWCASE` and `type` discover or googleNews. It cannot be used with a page group or filter, or with a filter on another searchAppearance.
- An invalid non-`auto` aggregation type returns an error. The API never silently changes it.
- `searchAppearance` must be queried alone first. Then filter `searchAppearance equals <VALUE>` and add the other dimensions.

Parsing:

- **Metadata casing.** Read `m.first_incomplete_date ?? m.firstIncompleteDate`, and the same for the hour field. Metadata appears only with `dataState: 'all'` plus a `date` dimension, or `hourly_all` plus an `hour` dimension. Data at or after that date or hour may still change. Times are in America/Los_Angeles.
- **Enum casing.** Send the documented lowercase or camelCase values (`web`, `byPage`, `country`). Official samples also use uppercase (`HOURLY_ALL`, `HOUR`). Compare response enums case-insensitively (`byProperty` == `BY_PROPERTY`).
- **Sorting.** Rows are sorted by clicks descending, or by date ascending when `date` is a dimension. Days with no data are omitted, so fill in zeros yourself.
- **Metric types.** Metrics are doubles. Cast `clicks` and `impressions` to integers only after aggregating. `ctr` is between 0 and 1. `position` is an average, so weight it by impressions when combining rows.

Pagination and completeness:

```
rowLimit = 25000; startRow = 0;
loop: resp = query({...req, rowLimit, startRow}); rows = resp.rows ?? [];
      if rows.length === 0 break; emit rows; startRow += 25000;
```

- There is a hard ceiling of about 50,000 rows per day, per site, per search type (sorted by clicks) whenever query or page dimensions are involved. Queries without query or page dimensions (country, device, searchAppearance, date) return all the data.
- For maximum coverage, query one day at a time (`startDate == endDate`) and loop over each `type` separately.
- Grouping by page and/or query may drop data. For accurate totals, query without those dimensions.

Anonymized queries:

- They are never returned as rows. They count in totals only when no dimensions or filters are used, and any filter drops them entirely.
- As a result, the sum of query rows is less than the property total, and include/exclude filter pairs do not add up to the total.
- Report the gap (total from a no-dimension query minus the sum of query rows) as "anonymized/unattributed". Label it an estimate, since row limits also contribute to it.

Freshness: final data usually lands after 2-3 days, on Pacific day boundaries. `dataState: 'all'` adds fresh or partial data. Retention is 16 months.

**URL Inspection**

`POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`

```ts
interface InspectRequest { inspectionUrl: string; siteUrl: string; languageCode?: string /* default en-US */ }
interface InspectResponse { inspectionResult: {
  inspectionResultLink?: string;
  indexStatusResult?: { sitemap?: string[]; referringUrls?: string[]; verdict?: 'VERDICT_UNSPECIFIED'|'PASS'|'PARTIAL'|'FAIL'|'NEUTRAL'; coverageState?: string;
    robotsTxtState?: 'ROBOTS_TXT_STATE_UNSPECIFIED'|'ALLOWED'|'DISALLOWED';
    indexingState?: 'INDEXING_STATE_UNSPECIFIED'|'INDEXING_ALLOWED'|'BLOCKED_BY_META_TAG'|'BLOCKED_BY_HTTP_HEADER'|'BLOCKED_BY_ROBOTS_TXT';
    lastCrawlTime?: string /* RFC3339 */; pageFetchState?: 'PAGE_FETCH_STATE_UNSPECIFIED'|'SUCCESSFUL'|'SOFT_404'|'BLOCKED_ROBOTS_TXT'|'NOT_FOUND'|'ACCESS_DENIED'|'SERVER_ERROR'|'REDIRECT_ERROR'|'ACCESS_FORBIDDEN'|'BLOCKED_4XX'|'INTERNAL_CRAWL_ERROR'|'INVALID_URL';
    googleCanonical?: string; userCanonical?: string; crawledAs?: 'CRAWLING_USER_AGENT_UNSPECIFIED'|'DESKTOP'|'MOBILE' };
  ampResult?: {...}; mobileUsabilityResult?: {...} /* deprecated */;
  richResultsResult?: { verdict?: string; detectedItems?: { richResultType: string; items?: { name: string; issues?: { issueMessage: string; severity: 'WARNING'|'ERROR'|'SEVERITY_UNSPECIFIED' }[] }[] }[] };
} }
```

- The result reflects only the version in Google's index. There is no live test.
- Verdict mapping: `PASS` = Valid, `FAIL` = Error/Invalid, `NEUTRAL` = Excluded. `PARTIAL` is no longer used.
- Type every field as optional. Many are absent when they don't apply, e.g. `googleCanonical` on a page that isn't indexed.

**Quotas**

Enforce these client-side with token buckets:

- Search Analytics:
  - 1,200 QPM per site and 1,200 QPM per user.
  - 40,000 QPM and 30,000,000 QPD per project.
  - Load quota: a 10-minute short-term window and a 1-day long-term window.
- URL Inspection: 600 QPM and 2,000 QPD per site; 15,000 QPM and 10,000,000 QPD per project. Budget batch inspections per property per day.
- Other resources: 20 QPS and 200 QPM per user; 100,000,000 QPD per project.

**Errors**

- Parse `{ error: { code, message, errors?: [{ domain, reason, message, locationType?, location? }], status? } }`. This accepts both the legacy shape and the google.rpc shape.
- Retry with exponential backoff and jitter on:
  - 429.
  - 403 with reason `rateLimitExceeded`, `userRateLimitExceeded` or `quotaExceeded`, or a message containing "quota exceeded".
  - 500 `internalError` and 503 `backendError`.
- A Search Analytics "quota exceeded" needs a wait of at least 15 min. If it comes back after a single query in a 10-min window, treat it as the daily long-term quota and stop for the day.
- Do not retry:
  - 401 (`authError`, `expired`): refresh the token once, then fail.
  - 403 `insufficientPermissions` or `forbidden`: no access to the property.
  - 403 `accessNotConfigured`: the API is not enabled on the project.
  - 400 `invalidParameter` / `badRequest`, e.g. an invalid aggregationType combination.

**Misc**

- Send `Accept-Encoding: gzip`. The optional `fields=` parameter gives partial responses. `quotaUser` is supported.

### Unverified / to recheck with credentials

- **Metadata casing on the wire.** The HTML reference (updated 2026-08-11) uses snake_case. The discovery doc (revision 20260923) uses camelCase. A SECONDARY third-party PR (GSC27) says the wire format is camelCase. No authenticated call was made, so the adapter must accept both.
- **Hosts.** No test confirmed that `www.googleapis.com/webmasters/v3` and `searchconsole.googleapis.com/webmasters/v3` behave identically in routing, errors and deprecation timeline. No deprecation date was found for the `www.googleapis.com` host.
- **Load-quota errors.** The HTTP status (403 or 429) and the `errors[].reason` for Search Analytics load-quota exhaustion are undocumented. Only the message "quota exceeded" is documented.
- **Error shape.** It is unconfirmed whether `searchconsole.googleapis.com` returns the legacy `{error:{errors:[...],code,message}}` shape or the google.rpc `{error:{code,message,status,details}}` shape.
- **Empty results.** It is unconfirmed whether `rows` is omitted or returned as an empty array when there are no results. No example of an empty response is documented.
- **Enum case-sensitivity.** `dataState` is documented as case-insensitive. The discovery ApiDimensionFilter description says values and dimension names are not case-sensitive. The case rules for `type` and `aggregationType` are not stated.
- **Filter case-sensitivity conflict.** The HTML reference says `equals`/`notEquals` are case-sensitive for page and query. The discovery description says filters are not case-sensitive. Treat the HTML as authoritative.
- **Time zone conflict.** The HTML reference says "PT time (UTC - 7:00/8:00)". Discovery's `startDate`/`endDate` say "PST (UTC - 8:00)". The metadata docs say America/Los_Angeles.
- **Date range.** The API docs state no maximum date range per request and no earliest queryable date. The only source is the 16-month retention statement in Analytics Help.
- **searchAppearance values.** The full list is undocumented; the docs say to discover it by grouping. The fetched pages name only INSTANT_APP, AMP_BLUE_LINK and NEWS_SHOWCASE.
- **Filter counts.** There is no documented maximum for filters per group or for number of groups, beyond "Max length 4096 characters" on `filters[]`.
- **Scope classification.** Whether `webmasters.readonly` is a sensitive or restricted scope for OAuth verification was not checked.
- **Pricing.** No pricing page was found or checked. The docs describe quotas only.
- **URL Inspection per-site quota.** Unconfirmed whether it counts per property (sc-domain vs URL-prefix) or per hostname. The docs say only "calls querying the same site".
- **`byNewsShowcasePanel` in responses.** The HTML response enum lists only auto/byPage/byProperty, but discovery also lists BY_NEWS_SHOWCASE_PANEL.

---

## 3. Google Analytics 4 Data API v1beta (read-only)

Covers runReport, getMetadata and checkCompatibility.

### Sources

Most pages were retrieved with a raw unauthenticated GET of the public doc HTML, plus WebFetch for some. The content is the same official pages.

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| GA1 | https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart | 2026-09-24 | yes | Last updated 2026-09-18 |
| GA2 | https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart?account_type=service | 2026-09-24 | yes | Service-account variant |
| GA3 | https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema | 2026-09-24 | yes | Last updated 2026-09-18 |
| GA4 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport | 2026-09-24 | yes | Last updated 2026-04-23 |
| GA5 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/RunReportResponse | 2026-09-24 | yes | |
| GA6 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData | 2026-09-24 | yes | Last updated 2026-09-14 |
| GA7 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/getMetadata | 2026-09-24 | yes | |
| GA8 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/DimensionMetadata | 2026-09-24 | yes | |
| GA9 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricMetadata | 2026-09-24 | yes | |
| GA10 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/checkCompatibility | 2026-09-24 | yes | |
| GA11 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression | 2026-09-24 | yes | |
| GA12 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricAggregation | 2026-09-24 | yes | |
| GA13 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/PropertyQuota | 2026-09-24 | yes | |
| GA14 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/Dimension | 2026-09-24 | yes | |
| GA15 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/Metric | 2026-09-24 | yes | |
| GA16 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/DateRange | 2026-09-24 | yes | |
| GA17 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/Row | 2026-09-24 | yes | |
| GA18 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricHeader | 2026-09-24 | yes | |
| GA19 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/DimensionHeader | 2026-09-24 | yes | |
| GA20 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricType | 2026-09-24 | yes | |
| GA21 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/OrderBy | 2026-09-24 | yes | |
| GA22 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/batchRunReports | 2026-09-24 | yes | |
| GA23 | https://developers.google.com/analytics/devguides/reporting/data/v1/quotas | 2026-09-24 | yes | Last updated 2026-09-18 |
| GA24 | https://developers.google.com/analytics/devguides/reporting/data/v1/basics | 2026-09-24 | yes | Last updated 2026-09-18 |
| GA25 | https://developers.google.com/analytics/devguides/reporting/data/v1/advanced | 2026-09-24 | yes | |
| GA26 | https://developers.google.com/analytics/devguides/reporting/data/v1/changelog | 2026-09-24 | yes | Last updated 2026-09-18 |
| GA27 | https://developers.google.com/analytics/devguides/reporting/data/v1/errors | 2026-09-24 | yes | |
| GA28 | https://developers.google.com/analytics/devguides/reporting/data/v1/property-id | 2026-09-24 | yes | |
| GA29 | https://developers.google.com/analytics/devguides/reporting/data/v1 | 2026-09-24 | yes | Overview |
| GA30 | https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta | 2026-09-24 | yes | LIVE public discovery doc, revision 20260922 |
| GA31 | https://support.google.com/analytics/answer/11080067?hl=en | 2026-09-24 | yes | Traffic-source dimension scopes |
| GA32 | https://support.google.com/analytics/answer/13504892?hl=en | 2026-09-24 | yes | What "(not set)" means |
| GA33 | https://support.google.com/analytics/answer/13331684?hl=en | 2026-09-24 | yes | WebFetch summary only. Row limits not given |
| GA34 | https://support.google.com/analytics/answer/13331292 | 2026-09-24 | yes | Returned the data-sampling article, not the "(other)" row details |

[GA1]: https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart
[GA2]: https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart?account_type=service
[GA3]: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema
[GA4]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
[GA5]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/RunReportResponse
[GA6]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData
[GA7]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/getMetadata
[GA8]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/DimensionMetadata
[GA9]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricMetadata
[GA10]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/checkCompatibility
[GA11]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression
[GA12]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricAggregation
[GA13]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/PropertyQuota
[GA15]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/Metric
[GA16]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/DateRange
[GA17]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/Row
[GA20]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricType
[GA21]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/OrderBy
[GA23]: https://developers.google.com/analytics/devguides/reporting/data/v1/quotas
[GA24]: https://developers.google.com/analytics/devguides/reporting/data/v1/basics
[GA25]: https://developers.google.com/analytics/devguides/reporting/data/v1/advanced
[GA26]: https://developers.google.com/analytics/devguides/reporting/data/v1/changelog
[GA27]: https://developers.google.com/analytics/devguides/reporting/data/v1/errors
[GA28]: https://developers.google.com/analytics/devguides/reporting/data/v1/property-id
[GA29]: https://developers.google.com/analytics/devguides/reporting/data/v1
[GA30]: https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta
[GA31]: https://support.google.com/analytics/answer/11080067?hl=en
[GA32]: https://support.google.com/analytics/answer/13504892?hl=en
[GA33]: https://support.google.com/analytics/answer/13331684?hl=en

### Verified behavior

**Endpoints and auth**

- runReport is `POST https://analyticsdata.googleapis.com/v1beta/{property=properties/*}:runReport`, e.g. `properties/1234`. The property goes in the URL path, not the body. ([GA4])
- runReport, getMetadata and checkCompatibility each require `https://www.googleapis.com/auth/analytics.readonly` or `https://www.googleapis.com/auth/analytics`. ([GA4])
- The discovery doc describes the scopes as `analytics.readonly` "See and download your Google Analytics data" and `analytics` "View and manage your Google Analytics data". rootUrl is `https://analyticsdata.googleapis.com/`, revision 20260922. ([GA30])
- v1beta methods in the discovery doc: ([GA30])
  - `runReport`, `batchRunReports` (up to 5 requests per batch), `checkCompatibility`, `runPivotReport`, `batchRunPivotReports`, `runRealtimeReport`.
  - `getMetadata`: `GET v1beta/properties/{propertiesId}/metadata`.
  - `audienceExports.get/list/create/query`.
- Quickstart: ([GA1])
  - The ADC command requests scopes `https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.readonly`.
  - The REST curl sample sends `Authorization: Bearer <token>`, `x-goog-user-project: ${PROJECT_ID}` and `Content-Type: application/json`.
  - It says to grant the user account access to a GA property in the GA UI.
  - Sample body: `{"dateRanges":[{"startDate":"2025-01-01","endDate":"2025-02-01"}],"dimensions":[{"name":"country"}],"metrics":[{"name":"activeUsers"}]}`.
- The service-account quickstart says: "In the Google Analytics UI, grant the service account access to a Google Analytics property." It uses the same scopes. ([GA2])
- The property ID must be a numeric GA4 ID, written `properties/GA_PROPERTY_ID`. Universal Analytics (`UA-`) properties are not supported. ([GA28])
- Beta channel: "No breaking changes are expected in this channel." ([GA29])

**runReport request**

- Top-level body fields, in exact case: ([GA4])
  - Report shape: `dimensions[]` (Dimension), `metrics[]` (Metric), `dateRanges[]` (DateRange).
  - Filters: `dimensionFilter` and `metricFilter` (both FilterExpression).
  - Paging: `offset` and `limit`, both int64 sent as strings.
  - Output: `metricAggregations[]`, `orderBys[]`, `currencyCode`, `keepEmptyRows` (boolean), `returnPropertyQuota` (boolean).
  - Other: `cohortSpec`, `comparisons[]` (optional).
- `limit` defaults to 10,000 rows. "The API returns a maximum of 250,000 rows per request, no matter how many you ask for." `limit` must be positive. The API can return fewer rows than `limit`, e.g. fewer than 300 values for country. ([GA4])
- `offset` is the row count of the start row, and the first row is row 0. For paging, the first request omits `offset` or sends 0. The next request sets `offset` to the previous `limit`. ([GA4])
- `keepEmptyRows`: if false or unset, rows where every metric is 0 are dropped. If true, they are returned unless a filter removes them. Only recorded data can appear; for example, there is no `purchase` row with `eventCount` 0 if `purchase` was never logged. ([GA4])
- `returnPropertyQuota` returns the property's current quota state in `PropertyQuota`. ([GA4])
- `dimensionFilter` cannot use metrics. `metricFilter` runs after rows are aggregated, like a SQL HAVING clause, and cannot use dimensions. ([GA4])
- `metricAggregations` values appear in rows whose `dimensionValues` are set to `"RESERVED_(MetricAggregation)"`. The enum is METRIC_AGGREGATION_UNSPECIFIED, TOTAL (SUM), MINIMUM, MAXIMUM, COUNT. ([GA12])
- Dimensions are optional, and a request can use up to nine. A request must include at least one metric. ([GA24])
- Pagination guide: ([GA24])
  - By default a report holds only the first 10,000 rows. `"limit": 250000` raises that to 250,000.
  - Beyond 250,000 rows, send more requests with `offset`. For example, `rowCount` 572345 needs offsets 0, 250000 and 500000.
  - There is no page token. The Data API's pagination "differs from the common pagination design pattern of other Google APIs".
- `FilterExpression` is exactly one of: ([GA11])
  - `andGroup{expressions[]}` or `orGroup{expressions[]}`
  - `notExpression` (a FilterExpression)
  - `filter`: `{fieldName, ...}` plus exactly one of:
    - `stringFilter{matchType,value,caseSensitive}`
    - `inListFilter{values[],caseSensitive}`
    - `numericFilter{operation,value{int64Value|doubleValue}}`
    - `betweenFilter{fromValue,toValue}`
    - `emptyFilter{}`
  - `matchType` is EXACT, BEGINS_WITH, ENDS_WITH, CONTAINS, FULL_REGEXP or PARTIAL_REGEXP.
  - `emptyFilter` matches empty values such as `"(not set)"` and `""`.
- `DateRange` is `{startDate, endDate, name}`. ([GA16])
  - Dates are inclusive YYYY-MM-DD. `NdaysAgo`, `yesterday` and `today` also work, in the property's reporting time zone.
  - Unnamed ranges are named `date_range_0`, `date_range_1`, and so on.
- `OrderBy` is `{desc: boolean}` plus exactly one of `metric{metricName}`, `dimension{dimensionName, orderType}` or `pivot`. `orderType` is ALPHANUMERIC, CASE_INSENSITIVE_ALPHANUMERIC or NUMERIC. ([GA21])
- `Metric` is `{name, expression, invisible}` and `Dimension` is `{name, dimensionExpression}`. Custom names used with expressions must match `^[a-zA-Z0-9_]$`. ([GA15])

**Response**

- RunReportResponse fields: `dimensionHeaders[]`, `metricHeaders[]`, `rows[]`, `totals[]`, `maximums[]`, `minimums[]`, `rowCount` (integer), `metadata`, `propertyQuota` and `kind`. `kind` is always `"analyticsData#runReport"`. ([GA5])
- `rowCount` is the total rows in the result, independent of `limit`, `offset` and how many rows came back. For example, 175 total rows with limit 50 returns `rowCount` 175 and 50 rows. Discovery types it as int32. ([GA5])
- A row is `{"dimensionValues":[{"value":string}],"metricValues":[{"value":string}]}`. Metric values are strings; their type is in `MetricHeader.type`. Column order is the same in the request, the headers and the rows. ([GA17])
- `MetricHeader` is `{name, type}` and `DimensionHeader` is `{name}`. The MetricType enum: METRIC_TYPE_UNSPECIFIED, TYPE_INTEGER, TYPE_FLOAT, TYPE_SECONDS, TYPE_MILLISECONDS, TYPE_MINUTES, TYPE_HOURS, TYPE_STANDARD, TYPE_CURRENCY, TYPE_FEET, TYPE_MILES, TYPE_METERS, TYPE_KILOMETERS. ([GA20])
- `ResponseMetaData` fields: `dataLossFromOtherRow`, `samplingMetadatas[]`, `dataTruncationReasons[]`, `schemaRestrictionResponse`, `currencyCode`, `timeZone`, `emptyReason` and `subjectToThresholding`. ([GA6])
  - `dataLossFromOtherRow`: true means some dimension combinations were rolled into an "(other)" row, which can happen in high-cardinality reports. It reflects the underlying aggregate table, whatever the report's filters and limits.
  - `samplingMetadatas`: present only when the report is sampled, with one entry per date range in request order. Each entry is `{samplesReadCount: string(int64), samplingSpaceSize: string(int64)}`. Percentage sampled = samplesReadCount / samplingSpaceSize.
  - `subjectToThresholding`: true means the report returns only data that meets minimum aggregation thresholds. It can be true even when no data is actually missing.
  - `currencyCode`: echoes the request's `currencyCode` if one was sent, otherwise the property currency (ISO 4217).
  - `timeZone`: the property's current IANA time zone, e.g. `"America/New_York"`.
  - `emptyReason`: free text, no documented enum.
  - `schemaRestrictionResponse`: `{activeMetricRestrictions:[{metricName, restrictedMetricTypes: [RESTRICTED_METRIC_TYPE_UNSPECIFIED|COST_DATA|REVENUE_DATA]}]}`. Populated only when the user's custom role blocks access, e.g. REVENUE_DATA for `purchaseRevenue`.
  - `DataTruncationReason`: `{dataTruncationDateRanges:[{startDate,endDate}], dataTruncationType, dataTruncationMessage, dataTruncationDate (YYYY-MM-DD)}`. Types include DATA_TRUNCATION_TYPE_DATE_RANGE, DATA_TRUNCATION_TYPE_PROPERTY (data read from before the retention date), DATA_TRUNCATION_TYPE_GOOGLE_ADS, DATA_TRUNCATION_TYPE_CONVERSIONS and others.
- `dataTruncationReasons` was added to v1beta and v1alpha on 2026-09-14. ([GA26])
- `PropertyQuota` fields are each a `QuotaStatus {consumed: integer, remaining: integer}`: `tokensPerDay`, `tokensPerHour`, `concurrentRequests`, `serverErrorsPerProjectPerHour`, `potentiallyThresholdedRequestsPerHour`, `tokensPerProjectPerHour`. ([GA13])

**Metadata and compatibility**

- getMetadata is `GET https://analyticsdata.googleapis.com/v1beta/{name=properties/*/metadata}`, e.g. `properties/1234/metadata`, with an empty body. ([GA7])
  - Property ID `0` returns dimensions and metrics common to all properties, without custom ones.
  - Response: `{name, dimensions[DimensionMetadata], metrics[MetricMetadata], comparisons[{apiName,uiName,description}]}`.
- `DimensionMetadata` is `{apiName, uiName, description, deprecatedApiNames[], customDefinition, category}`. ([GA8])
- `MetricMetadata` is `{apiName, uiName, description, deprecatedApiNames[], type, expression, customDefinition, blockedReasons[], category}`. `blockedReasons` values: BLOCKED_REASON_UNSPECIFIED, NO_REVENUE_METRICS, NO_COST_METRICS. For a blocked metric, requests still succeed but the report shows only zeros, and metric filters on it fail. ([GA9])
- checkCompatibility is `POST https://analyticsdata.googleapis.com/v1beta/{property=properties/*}:checkCompatibility`. ([GA10])
  - Body: `{dimensions[], metrics[], dimensionFilter, metricFilter, compatibilityFilter}`. `compatibilityFilter` is COMPATIBILITY_UNSPECIFIED, COMPATIBLE or INCOMPATIBLE.
  - Response: `{dimensionCompatibilities:[{dimensionMetadata, compatibility}], metricCompatibilities:[{metricMetadata, compatibility}]}`.
  - It checks Core report compatibility. The call itself fails if the request's own dimensions and metrics are incompatible.

**Quotas and errors**

- Core quotas, standard vs Analytics 360: ([GA23])

  | Quota | Standard | 360 |
  |---|---|---|
  | Tokens per property per day | 200,000 | 2,000,000 |
  | Tokens per property per hour | 40,000 | 400,000 |
  | Tokens per project per property per hour | 14,000 | 140,000 |
  | Concurrent requests per property | 10 | 50 |
  | Server errors per project per property per hour | 10 | 50 |
- The Core category covers runReport, runPivotReport, batchRunReports, batchRunPivotReports, runAccessReport, getMetadata, checkCompatibility and createAudienceExports. ([GA23])
  - "Most requests will charge 10 or fewer tokens".
  - Daily quotas refresh at midnight PST. Hourly quotas refresh within an hour.
  - The limit is 120 potentially thresholded requests per hour. The dimensions that can trigger thresholding are `userAgeBracket`, `userGender`, `brandingInterest`, `audienceId` and `audienceName`.
  - Server errors (500/503) count only when they occur.
- Token cost grows with the number of rows, dimensions and metrics, filter complexity, date range length, data cardinality (e.g. `pagePath` or custom dimensions) and the property's event volume. Google recommends measuring cost with `"returnPropertyQuota": true`. ([GA23])
- Since 2024-06-28 there is "a limit of 10,000 API server errors allowed per project, per property, within a 15-minute window". This counts any response code other than 500 or 200, including incompatible dimension/metric combinations and auth errors. Calls are blocked until the 15-minute window ends. ([GA26])
- The error body is `{"error":{"code":403,"message":"...","status":"PERMISSION_DENIED"}}`. ([GA27])
  - Common errors: 400 INVALID_ARGUMENT, 401 UNAUTHENTICATED, 403 PERMISSION_DENIED, 429 RESOURCE_EXHAUSTED (quota), 500 INTERNAL, 503 UNAVAILABLE.
  - Retry 500 and 503 with exponential backoff and a retry limit, so you don't use up the server-error quota.

**Dimension and metric names**

- Dimension API names (case-sensitive): `sessionDefaultChannelGroup`, `sessionSource`, `sessionMedium`, `sessionSourceMedium`, `landingPage`, `landingPagePlusQueryString`, `hostName`, `eventName`, `date`, `deviceCategory`, `country`. ([GA3])
- Dimension descriptions: ([GA3])
  - `sessionDefaultChannelGroup` is "based primarily on source and medium". It is an enumeration that includes Direct, Organic Search, Paid Social, Organic Social, Email, Affiliates, Referral, Paid Search, Video and Display.
  - `sessionSource`: "The source that initiated a session on your website or app."
  - `sessionMedium`: "The medium that initiated a session on your website or app."
  - `sessionSourceMedium`: "The combined values of the dimensions sessionSource and sessionMedium."
  - `landingPage`: "The page path associated with the first pageview in a session." `landingPagePlusQueryString` is the same with the query string included.
  - `hostName` includes the subdomain and domain, e.g. `www.example.com`.
  - `eventName`: "The name of the event."
  - `date`: formatted `YYYYMMDD`.
  - `deviceCategory`: "Desktop, Tablet, or Mobile."
  - `country`: the country the user activity came from.
- The 2023-02-21 changelog added `landingPagePlusQueryString`. It also said `landingPage` "will be updated to not return a query string on May 14, 2023." ([GA26])
- Metric API names (case-sensitive): `sessions`, `engagedSessions`, `keyEvents`, `sessionKeyEventRate`, `eventCount`, `totalUsers`, `activeUsers`, `totalRevenue`, `purchaseRevenue`. `userKeyEventRate` also exists. ([GA3])
- Metric descriptions: ([GA3])
  - `sessions` counts sessions that began (`session_start`).
  - `engagedSessions` counts sessions that lasted longer than 10 seconds, had a key event, or had 2 or more screen views.
  - `eventCount`: "The count of events."
  - `keyEvents` is the count of key events. Marking an event as a key event affects reports from that point on and does not change historical data.
  - `sessionKeyEventRate`: "The percentage of sessions in which any key event was triggered."
  - `totalUsers` counts distinct users who logged at least one event. `activeUsers` counts distinct users who visited.
  - `totalRevenue` = purchase + subscription + ad revenue, minus refunded transaction revenue.
  - `purchaseRevenue` = purchase revenue minus refunds. It counts `purchase`, `ecommerce_purchase`, `in_app_purchase`, `app_store_subscription_convert` and `app_store_subscription_renew`, and the amount is set by the `value` parameter.
- Per-key-event metrics are `sessionKeyEventRate:event_name` and `userKeyEventRate:event_name`. The Metadata method lists them. Requesting the rate for an event that is not a key event fails. ([GA3])
- The advanced guide's example metadata entry is `{"apiName": "sessionKeyEventRate:add_to_cart", "uiName": "Session key event rate for add_to_cart"}`, requested as `"metrics": [{ "name": "sessionKeyEventRate:add_to_cart" }]`. ([GA25])
- The 2024-05-06 changelog renamed conversion metrics. getMetadata lists the old names in `deprecatedApiNames`. ([GA26])

  | Old name | New name |
  |---|---|
  | `conversions` | `keyEvents` |
  | `sessionConversionRate` | `sessionKeyEventRate` |
  | `userConversionRate` | `userKeyEventRate` |
  | `isConversionEvent` | `isKeyEvent` |
  | `advertiserAdCostPerConversion` | `advertiserAdCostPerKeyEvent` |
  | `purchaserConversionRate` | `purchaserRate` |
  | `firstTimePurchaserConversionRate` | `firstTimePurchaserRate` |
- Custom definition syntax: `customEvent:parameter_name` (event-scoped), `customUser:parameter_name` and `customItem:parameter_name`. Custom metric variants are `customEvent:`, `averageCustomEvent:` and `countCustomEvent:`. A request fails if the custom definition is not registered. ([GA3])
- The unprefixed `source`, `medium` and `defaultChannelGroup` are described as attributed to the key event (e.g. `source`: "The source attributed to the key event."). `firstUserSource` and `firstUserDefaultChannelGroup` describe what first acquired the user. ([GA3])

**Attribution and "(not set)"**

- Dimension scopes: ([GA31])
  - **User-scoped** dimensions start with "First user".
  - **Session-scoped** dimensions start with "Session" and get new values each time the user returns.
  - **Event-scoped** dimensions have no prefix (Source, Medium). They "help you attribute credit for a key event".
  - "The source and medium for non-key events are '(not set)'."
- Attribution models: ([GA31])
  - User-scoped and session-scoped dimensions use the paid-and-organic last-click model. Changing the property's attribution model does not affect them.
  - Event-scoped dimensions use the model you select, which is data-driven by default.
- The help page's example tables pair Session medium with Engagement rate, Event count, Key events and Total revenue (the Traffic acquisition report). ([GA31])
- "(not set) is a placeholder name that Analytics uses when it hasn't received any information for a dimension." ([GA32])
- Known causes of "(not set)": ([GA32])
  - Session source/medium is "(not set)" when the `session_start` event is missing. That traffic then shows as Unassigned in the default channel group.
  - Landing page is "(not set)" when a session has no `page_view` event.
  - Sessions with the `srsltid` parameter but no google.com referrer can show "(not set)" and "are not classified as organic".
  - A consent-mode misconfiguration can drop `session_start` and cause "(not set)".
- The "(other)" row "appears in a report, exploration, or Data API response when the number of rows in a table exceeds the table's row limit". It is associated with high-cardinality dimensions such as page path. This comes from a WebFetch summary. ([GA33])

### Implementation contract

**Transport and auth**

- Base URL `https://analyticsdata.googleapis.com/v1beta/`. Send `Authorization: Bearer <access_token>` and `Content-Type: application/json`.
- With user ADC credentials, also send `x-goog-user-project: <gcp project id>`, as the quickstart curl sample does.
- Request only `https://www.googleapis.com/auth/analytics.readonly`. It is enough for runReport, getMetadata and checkCompatibility. Do not request `.../auth/analytics`.
- The service account or user must be granted access to the GA4 property in the GA UI (Property access management).
- The property path segment is `properties/{numericId}`. Validate the ID against `^\d+$` and reject `UA-` IDs.

**Endpoints**

1. `POST v1beta/properties/{id}:runReport`
2. `GET v1beta/properties/{id}/metadata`. Use `properties/0/metadata` for metadata common to all properties (no custom definitions).
3. `POST v1beta/properties/{id}:checkCompatibility`
   - Body: `{dimensions, metrics, dimensionFilter?, metricFilter?, compatibilityFilter?: 'COMPATIBLE'|'INCOMPATIBLE'}`.
   - It fails if the combination you pass is itself incompatible.

**Request type**

```ts
type RunReportRequest = {
  dateRanges: { startDate: string; endDate: string; name?: string }[]; // YYYY-MM-DD | NdaysAgo | yesterday | today
  dimensions?: { name: string }[];            // max 9
  metrics: { name: string; expression?: string; invisible?: boolean }[]; // >=1
  dimensionFilter?: FilterExpression; metricFilter?: FilterExpression;
  offset?: string; limit?: string;            // int64 encoded as strings; limit default 10000, max 250000, must be >0
  metricAggregations?: ('TOTAL'|'MINIMUM'|'MAXIMUM'|'COUNT')[];
  orderBys?: { desc?: boolean; metric?: { metricName: string }; dimension?: { dimensionName: string; orderType?: 'ALPHANUMERIC'|'CASE_INSENSITIVE_ALPHANUMERIC'|'NUMERIC' } }[];
  currencyCode?: string; keepEmptyRows?: boolean; returnPropertyQuota?: boolean;
};
type FilterExpression = { andGroup?: { expressions: FilterExpression[] }; orGroup?: { expressions: FilterExpression[] }; notExpression?: FilterExpression;
  filter?: { fieldName: string; stringFilter?: { matchType: 'EXACT'|'BEGINS_WITH'|'ENDS_WITH'|'CONTAINS'|'FULL_REGEXP'|'PARTIAL_REGEXP'; value: string; caseSensitive?: boolean };
    inListFilter?: { values: string[]; caseSensitive?: boolean }; numericFilter?: { operation: 'EQUAL'|'LESS_THAN'|'LESS_THAN_OR_EQUAL'|'GREATER_THAN'|'GREATER_THAN_OR_EQUAL'; value: { int64Value?: string; doubleValue?: number } };
    betweenFilter?: { fromValue: NumericValue; toValue: NumericValue }; emptyFilter?: {} } };
```

- Set exactly one key per `FilterExpression` and per `Filter`.
- Use dimension names only in `dimensionFilter` and metric names only in `metricFilter`.

**Response type**

```ts
type RunReportResponse = { dimensionHeaders?: {name:string}[]; metricHeaders?: {name:string; type: string}[];
  rows?: Row[]; totals?: Row[]; maximums?: Row[]; minimums?: Row[]; rowCount?: number; kind?: 'analyticsData#runReport';
  metadata?: { dataLossFromOtherRow?: boolean; samplingMetadatas?: {samplesReadCount:string; samplingSpaceSize:string}[];
    dataTruncationReasons?: { dataTruncationDateRanges?: {startDate:string; endDate:string}[]; dataTruncationType?: string; dataTruncationMessage?: string; dataTruncationDate?: string }[];
    schemaRestrictionResponse?: { activeMetricRestrictions?: { metricName: string; restrictedMetricTypes: ('COST_DATA'|'REVENUE_DATA')[] }[] };
    currencyCode?: string; timeZone?: string; emptyReason?: string; subjectToThresholding?: boolean };
  propertyQuota?: Record<'tokensPerDay'|'tokensPerHour'|'concurrentRequests'|'serverErrorsPerProjectPerHour'|'potentiallyThresholdedRequestsPerHour'|'tokensPerProjectPerHour', {consumed:number; remaining:number}>; };
type Row = { dimensionValues: {value: string}[]; metricValues: {value: string}[] };
```

- Treat every array and `rowCount` as optional, defaulting to `[]` and `0`. The docs don't say when empty fields are omitted, so parse defensively.
- Metric values are always strings. Convert them using `metricHeaders[i].type`: `TYPE_INTEGER` to an integer; `TYPE_FLOAT`, `TYPE_CURRENCY`, `TYPE_SECONDS` and the other units to a float.
- Map columns by index. Header order equals row order.
- `date` values are `YYYYMMDD`. Parse them explicitly and interpret them in `metadata.timeZone`.
- Currency metrics (`totalRevenue`, `purchaseRevenue`) are in `metadata.currencyCode`.

**Pagination**

- Send `limit` and `offset` as strings. `limit` can go up to 250000; something like 10000 to 100000 keeps token cost in check.
- Raise `offset` by the number of rows received. Stop when `offset >= rowCount` or a page comes back empty.
- There is no page token. Keep all other parameters identical across pages.

**Data-quality flags to surface to the agent**

- `subjectToThresholding`: some rows may be withheld.
- `dataLossFromOtherRow`: rows were bucketed into "(other)". This is common with `landingPagePlusQueryString`; prefer `landingPage` or shorter date ranges.
- `samplingMetadatas`: present only when the report is sampled. Ratio = samplesReadCount / samplingSpaceSize, one entry per date range in order.
- `dataTruncationReasons`: new on 2026-09-14.
- `schemaRestrictionResponse.activeMetricRestrictions`: revenue or cost is hidden by the user's role.
- `emptyReason`: free text.
- getMetadata `blockedReasons` (`NO_REVENUE_METRICS` / `NO_COST_METRICS`): a blocked metric returns zeros, not an error.

**Names to use**

- Metrics: `sessions`, `engagedSessions`, `keyEvents` (not the deprecated `conversions`), `sessionKeyEventRate` (not `sessionConversionRate`), `eventCount`, `totalUsers`, `activeUsers`, `totalRevenue`, `purchaseRevenue`.
- Per-event rate: `sessionKeyEventRate:<event_name>` and `userKeyEventRate:<event_name>`. The request fails if the event isn't registered as a key event, so check getMetadata first.
- A per-event key-event **count** (`keyEvents:<event_name>`) is not documented.
  - Look for it at runtime in getMetadata metrics (`apiName.startsWith('keyEvents:')`).
  - If it isn't there, use `keyEvents` with `eventName` as a dimension, or with dimensionFilter `{filter:{fieldName:'eventName', stringFilter:{matchType:'EXACT', value}}}`.
  - Confirm the combination with checkCompatibility.
- Map legacy names to current ones using getMetadata `deprecatedApiNames`.
- Dimensions:
  - `sessionDefaultChannelGroup`: filter organic traffic with EXACT `Organic Search`.
  - `sessionSource`, `sessionMedium`, `sessionSourceMedium`.
  - `landingPage` (path only; no query string since 2023-05-14) and `landingPagePlusQueryString`.
  - `hostName`, `eventName`, `date`, `country`.
  - `deviceCategory`: compare case-insensitively.

**Attribution**

- Default SEO and traffic reports to session-scoped (`session*`) dimensions with session metrics. These use last-click attribution (paid and organic channels) and are not affected by the property's attribution model.
- The unprefixed `source`, `medium` and `defaultChannelGroup` are event-scoped key-event attribution. They use the property's model (data-driven by default) and are "(not set)" for non-key events. Don't mix them with `sessions`.
- `firstUser*` dimensions describe user acquisition.

**"(not set)"**

- Keep "(not set)" as a real bucket and label it in output.
- To exclude it, use `notExpression` with `emptyFilter` on that field. `emptyFilter` matches both "(not set)" and "".

**Quotas and retries (standard property, Core)**

- Budget: 200k tokens per day, 40k per hour, 14k per project per property per hour, 10 concurrent requests. Most requests cost 10 tokens or fewer.
- Send `returnPropertyQuota: true` and throttle on `remaining`. Keep concurrency at 10 or fewer per property.
- Errors come as `{error:{code,message,status}}`:
  - 429 `RESOURCE_EXHAUSTED`: back off until the hourly or daily reset. The daily reset is at midnight PST.
  - 500/503: exponential backoff with a small retry cap. Only 10 server errors per project per property per hour are allowed.
  - 400 `INVALID_ARGUMENT` (e.g. incompatible dimensions/metrics, or an unregistered key event), 401 and 403: do not retry. They also count toward the limit of 10,000 client errors per 15 minutes.
- `batchRunReports` allows up to 5 sub-requests.

### Unverified / to recheck with credentials

- **`keyEvents:<event_name>`** (e.g. `keyEvents:purchase`) is not documented as an API name on the api-schema page, the advanced guide or the changelog. The 2024-05-06 changelog mentions "key event metrics for one key event", but links only to the key-event rate section. Detect it at runtime; do not hardcode it.
- **Maximum metrics per request.** Not stated. Only "up to nine dimensions" is documented.
- **Maximum `dateRanges` per request.** Not stated.
- **`emptyReason` values.** Free text; no enum is documented.
- **Empty reports.** It is not documented whether `rows`, `rowCount` or `totals` are omitted when a report is empty.
- **`deviceCategory` casing.** The docs say "Desktop, Tablet, or Mobile", but the casing in responses was not checked.
- **`sessionDefaultChannelGroup` values.** The API doc lists 10. "Unassigned" is confirmed only by the "(not set)" help page. Others (e.g. Organic Shopping, Organic Video, Cross-network, Paid Shopping, Paid Video, Paid Other, SMS, Mobile Push Notifications, Audio) were not verified.
- **`sessionKeyEventRate` scale.** The description says "percentage" but, unlike engagementRate and bounceRate, has no note that it is returned as a fraction. Unknown whether it is 0-1 or 0-100.
- **Compatibility of `keyEvents`/`totalRevenue`** with session-scoped dimensions (`sessionSourceMedium`, `landingPage`) and with `eventName` is not stated in the API docs. The help pages show these pairings only in UI reports. Check with checkCompatibility.
- **TOTAL row label.** The literal dimension value for `metricAggregations` TOTAL rows was never shown. `RESERVED_TOTAL` is inferred from the documented `RESERVED_(MetricAggregation)` pattern.
- **"(other)" row limits.** The table row limits for standard vs 360 properties were not available. The help article fetched only as a summary without the numbers.
- **Token cost of getMetadata and checkCompatibility.** Not documented. They are only listed as Core-quota methods.
- **Doc inconsistencies.**
  - The quotas page summary says "three request quota categories", but the body lists four: Core, Realtime, Funnel, Chat.
  - The basics page summary says "at least one dimension", but the body says dimensions are optional.

---

## 4. Google OAuth 2.0 and google-auth-library

Desktop flow (loopback + PKCE) and service accounts via google-auth-library (npm 11.x), used for Search Console and GA4 access.

### Sources

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| OA1 | https://developers.google.com/identity/protocols/oauth2/native-app | 2026-09-24 | yes | Primary desktop-flow doc. Does not mention `access_type` or `prompt` |
| OA2 | https://developers.google.com/identity/protocols/oauth2 | 2026-09-24 | yes | "Refresh token expiration" section, quoted verbatim |
| OA3 | https://developers.google.com/identity/protocols/oauth2/web-server | 2026-09-24 | yes | Definitions of `access_type`, `prompt`, `include_granted_scopes`, `state`, `login_hint` |
| OA4 | https://developers.google.com/identity/protocols/oauth2/resources/oob-migration | 2026-09-24 | yes | |
| OA5 | https://support.google.com/cloud/answer/15544987?hl=en | 2026-09-24 | yes | Google Auth Platform navigation |
| OA6 | https://support.google.com/cloud/answer/15549945?hl=en | 2026-09-24 | yes | Audience page |
| OA7 | https://support.google.com/cloud/answer/15549049?hl=en | 2026-09-24 | yes | Branding page |
| OA8 | https://support.google.com/webmasters/answer/7687615?hl=en | 2026-09-24 | yes | Search Console permissions. Service accounts not mentioned |
| OA9 | https://developers.google.com/search/apis/indexing-api/v3/prereqs | 2026-09-24 | yes | The only official page found that adds a service account to Search Console |
| OA10 | https://developers.google.com/webmaster-tools/v1/prereqs | 2026-09-24 | yes | No service-account guidance |
| OA11 | https://developers.google.com/webmaster-tools/v1/how-tos/authorizing | 2026-09-24 | yes | |
| OA12 | https://developers.google.com/webmaster-tools/v1/sites | 2026-09-24 | yes | |
| OA13 | https://developers.google.com/webmaster-tools/v1/searchanalytics/query | 2026-09-24 | yes | No minimum permission level stated |
| OA14 | https://support.google.com/analytics/answer/9305788?hl=en | 2026-09-24 | yes | GA4 add users. Service accounts not mentioned |
| OA15 | https://support.google.com/analytics/answer/9305587?hl=en | 2026-09-24 | yes | GA4 roles |
| OA16 | https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-client-libraries | 2026-09-24 | yes | Uses ADC with a user account. One WebFetch summary claimed service-account steps; a recheck found none, so the summary is treated as unreliable |
| OA17 | https://developers.google.com/analytics/devguides/config/admin/v1/quickstart | 2026-09-24 | yes | "grant your user account access". Results conflicted on whether a service-account tab exists |
| OA18 | https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart | 2026-09-24 | yes | Mentions "using a service account" but gives no steps for granting access |
| OA19 | https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport | 2026-09-24 | yes | |
| OA20 | https://github.com/googleapis/google-auth-library-nodejs | 2026-09-24 | yes | Raw README read with curl; GitHub API reports `archived=true` |
| OA21 | https://registry.npmjs.org/google-auth-library/latest | 2026-09-24 | yes | Read with curl |
| OA22 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/README.md | 2026-09-24 | yes | Current 11.x README |
| OA23 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/src/auth/oauth2client.ts | 2026-09-24 | yes | Authoritative OAuth2Client source |
| OA24 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/src/auth/googleauth.ts | 2026-09-24 | yes | |
| OA25 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/src/auth/authclient.ts | 2026-09-24 | yes | |
| OA26 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/samples/oauth2-codeVerifier.js | 2026-09-24 | yes | Official PKCE sample |
| OA27 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/samples/keyfile.js | 2026-09-24 | yes | Official keyFile sample |
| OA28 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/CHANGELOG.md | 2026-09-24 | yes | 11.1.0 released 2026-09-15 per the changelog |
| OA29 | https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/src/index.ts | 2026-09-24 | yes | Exports include CodeChallengeMethod, OAuth2Client, GoogleAuth, JWT, UserRefreshClient, ExternalAccountClient |

[OA1]: https://developers.google.com/identity/protocols/oauth2/native-app
[OA2]: https://developers.google.com/identity/protocols/oauth2
[OA3]: https://developers.google.com/identity/protocols/oauth2/web-server
[OA4]: https://developers.google.com/identity/protocols/oauth2/resources/oob-migration
[OA5]: https://support.google.com/cloud/answer/15544987?hl=en
[OA6]: https://support.google.com/cloud/answer/15549945?hl=en
[OA7]: https://support.google.com/cloud/answer/15549049?hl=en
[OA8]: https://support.google.com/webmasters/answer/7687615?hl=en
[OA9]: https://developers.google.com/search/apis/indexing-api/v3/prereqs
[OA11]: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
[OA12]: https://developers.google.com/webmaster-tools/v1/sites
[OA13]: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
[OA14]: https://support.google.com/analytics/answer/9305788?hl=en
[OA15]: https://support.google.com/analytics/answer/9305587?hl=en
[OA19]: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
[OA20]: https://github.com/googleapis/google-auth-library-nodejs
[OA21]: https://registry.npmjs.org/google-auth-library/latest
[OA22]: https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/README.md
[OA23]: https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/src/auth/oauth2client.ts
[OA24]: https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/src/auth/googleauth.ts
[OA25]: https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/src/auth/authclient.ts
[OA26]: https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/samples/oauth2-codeVerifier.js
[OA27]: https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/samples/keyfile.js
[OA28]: https://raw.githubusercontent.com/googleapis/google-cloud-node/main/core/packages/google-auth-library-nodejs/CHANGELOG.md

### Verified behavior

**Desktop loopback flow (Google docs)**

- The redirect URI is `http://127.0.0.1:port` or `http://[::1]:port`. The app should look up the loopback IP address, start an HTTP listener on a random free port, and put that port in the URI. ([OA1])
- `localhost` also works in place of the loopback IP, but "this configuration may cause issues with client firewalls." The loopback option is recommended for macOS, Linux and Windows desktop apps (not Universal Windows Platform). ([OA1])
- "The loopback IP address redirect option is DEPRECATED for Android, Chrome app and iOS OAuth client types." Desktop app clients are not affected. ([OA1])
- After the redirect, the app "should respond by displaying an HTML page that instructs the user to close the browser and return to your app." ([OA1])
- To create a client: go to the Clients page (https://console.developers.google.com/auth/clients), click Create client, and set the application type to "Desktop app". ([OA1])
- The manual copy/paste (OOB) option "is no longer supported". Custom URI schemes are "no longer supported on Android and Chrome apps". ([OA1])
- OOB timeline: ([OA4])
  - 2022-02-28: new OAuth usage of OOB blocked.
  - 2022-10-03: deprecated for clients created before that date.
  - 2023-01-31: blocked for all existing clients, including exempted ones.
  - OOB `redirect_uri` values are `urn:ietf:wg:oauth:2.0:oob`, `urn:ietf:wg:oauth:2.0:oob:auto` and `oob`. Desktop clients should move to the loopback flow.
- PKCE: ([OA1])
  - `code_verifier` is a high-entropy random string of 43 to 128 characters from `[A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"`.
  - S256 is recommended. The `code_challenge` is the Base64URL (no padding) encoded SHA256 hash of the verifier.
  - "The only supported values for this parameter are S256 or plain."
- The authorization endpoint is `https://accounts.google.com/o/oauth2/v2/auth`. ([OA1])
  - Required: `client_id`, `redirect_uri` (must exactly match an authorized redirect URI), `response_type=code`, `scope` (space-delimited).
  - Recommended: `code_challenge`, `code_challenge_method`, `state`.
  - Optional: `login_hint`.
- The native-app doc does not list `access_type` or `prompt`. It says "Incremental authorization is not supported for installed apps or devices." ([OA1])
- `state` is any string the app uses to keep state between the request and the response. It is recommended, and can be used for "sending nonces, and mitigating cross-site request forgery." ([OA3])
- `access_type` and `prompt`: ([OA3])
  - `access_type` is `online` (the default) or `offline`. With `offline`, Google returns a refresh token and an access token the first time the app exchanges a code.
  - `prompt` is "a space-delimited, case-sensitive list" of `none`, `consent` and `select_account`. Without it, "the user will be prompted only the first time your project requests access."
- A refresh token is returned only on the first authorization. `prompt=consent` forces Google to return it again. ([OA3])
- Token exchange is `POST https://oauth2.googleapis.com/token`. ([OA1])
  - Parameters: `client_id`, `client_secret` ("Optional"), `code`, `code_verifier`, `grant_type=authorization_code`, `redirect_uri`.
  - Response: `access_token`, `expires_in`, `id_token` (only with identity scopes), `refresh_token`, `refresh_token_expires_in` ("only set when the user grants time-based access"), `scope` (space-delimited), `token_type` (always `Bearer`).
- Refresh is `POST https://oauth2.googleapis.com/token` with `client_id`, `grant_type=refresh_token`, `refresh_token` and optional `client_secret`. ([OA1])
- Revocation is `POST https://oauth2.googleapis.com/revoke?token={token}` with `Content-type:application/x-www-form-urlencoded`. ([OA1])
  - Success returns 200. Failure returns 400 with an error code.
  - Revoking an access token that has a matching refresh token revokes the refresh token too.

**Refresh-token lifetime**

- A refresh token can expire when: ([OA2])
  - the user revoked access;
  - it was not used for six months;
  - the user changed their password and the token has Gmail scopes;
  - the account exceeded the maximum number of granted (live) refresh tokens;
  - time-based access expired;
  - an admin set the requested services to Restricted (error `admin_policy_enforced`);
  - for GCP APIs, the admin-set session length was exceeded.
- A project with an External user type and publishing status "Testing" gets refresh tokens that expire in 7 days. The exception is when the only scopes requested are a subset of name, email address and user profile (`userinfo.email`, `userinfo.profile`, `openid` or their OpenID Connect equivalents). ([OA2])
- There is "a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID". When a new token is created past that limit, the oldest one is invalidated without warning. This limit does not apply to service accounts. ([OA2])

**Google Auth Platform console**

- Sections: Overview ("GET STARTED"), Branding, Audience, Clients, Data Access (manage OAuth scopes) and Verification Center. ([OA5])
- Audience: ([OA6])
  - "External" is open to any Google Account user.
  - "Internal" is for projects in a Google Cloud Organization and limits authorization to org members.
  - "Testing" status limits the app to "up to 100 test users listed in the OAuth consent screen".
  - "In production" makes it available to any Google Account.
- "Authorizations by a test user will expire seven days from the time of consent." If the client requested offline access and got a refresh token, that token also expires. Apps that show the unverified app screen are capped at 100 new users in total. ([OA6])
- Branding (Google Auth Platform > Branding, https://console.developers.google.com/auth/branding) covers app name, user support email, app logo, app domain (homepage, privacy policy, terms of service), authorized domains and developer contact information. ([OA7])

**Granting access to Search Console and GA4**

- Search Console roles: ([OA8])
  - Owner (verified or delegated): full control.
  - Full user: "Has view rights to all data and can take some actions."
  - Restricted user: "Has simple view rights on most data."
  - Associate: cannot access Search Console directly.
  - To add a user: property > Settings > Users and permissions > Add user > enter the Google Account email > choose the permission > save.
  - Users "must have a valid Google Account". "An email group cannot be added as a user." A property can have at most 100 non-owners.
- The only official doc that adds a service account to Search Console is the Indexing API guide. It adds the service account as a delegated owner: in Verified owners, click "Add an owner" and enter the service account email. The email is in the JSON key's `client_email` field, or in the "Service account ID" column in the Cloud console. ([OA9])
- Search Console scopes: `https://www.googleapis.com/auth/webmasters` ("Read/write access") and `https://www.googleapis.com/auth/webmasters.readonly` ("Read-only access"). ([OA11])
- The Sites resource is `{siteUrl, permissionLevel}`. `permissionLevel` is `siteOwner`, `siteFullUser`, `siteRestrictedUser` or `siteUnverifiedUser`. ([OA12])
- `searchanalytics.query` is `POST https://www.googleapis.com/webmasters/v3/sites/siteUrl/searchAnalytics/query` with scope `webmasters.readonly` or `webmasters`. The doc states no minimum permission level. ([OA13])
- To add a GA4 user: ([OA14])
  - In Admin, under Account or Property, click Access Management. In the permissions list, click + and then Add users.
  - Enter the email, optionally tick "Notify new users by email", choose permissions and click Add.
  - You need the Administrator role at account or property level. Users must have Google-account email addresses.
- The GA4 Viewer role "Can see settings and data; can change which data appears in reports (e.g., add comparisons, add a secondary dimension)." Data restrictions: No Cost Metrics, No Revenue Metrics. ([OA15])
- GA4 runReport is `POST https://analyticsdata.googleapis.com/v1beta/{property=properties/*}:runReport` with scope `analytics.readonly` or `analytics`. ([OA19])

**google-auth-library 11.x**

- Package and repo:
  - npm `latest` is 11.1.0 (published 2026-09-16). It requires Node >= 22 and lives in the `googleapis/google-cloud-node` monorepo at `core/packages/google-auth-library-nodejs`. The `legacy-18` dist-tag is 10.9.1. ([OA21])
  - The old repo `googleapis/google-auth-library-nodejs` is archived; its README says "THIS REPOSITORY IS DEPRECATED". It points to `google-cloud-node-core`, which is also archived and stuck at 10.6.2. The live 11.x source is in `googleapis/google-cloud-node`. ([OA20])
  - 11.0.0 (2026-07-29) has one breaking change: "minimum Node version of 22". ([OA28])
- OAuth2Client constructor: ([OA23])
  - It takes `OAuth2ClientOptions {clientId, clientSecret, redirectUri, endpoints?, issuers?, clientAuthentication?}`.
  - It also accepts the snake_case aliases `client_id`, `client_secret` and `redirect_uris[]`, plus the `AuthClientOptions` fields (`credentials`, `eagerRefreshThresholdMillis`, `forceRefreshOnFailure`, `transporterOptions`, ...).
  - The positional `(clientId, clientSecret, redirectUri)` form is `@deprecated`.
  - Default endpoints: `oauth2AuthBaseUrl` `https://accounts.google.com/o/oauth2/v2/auth`, `oauth2TokenUrl` `https://oauth2.googleapis.com/token`, `oauth2RevokeUrl` `https://oauth2.googleapis.com/revoke`.
  - `clientAuthentication` defaults to `ClientSecretPost`.
- `GenerateAuthUrlOpts`: ([OA23])
  - Fields: `access_type`, `hd`, `response_type`, `client_id`, `redirect_uri`, `scope` (string[] or string; arrays are joined with spaces), `state`, `include_granted_scopes`, `login_hint`, `prompt`, `code_challenge_method` (CodeChallengeMethod), `code_challenge`, plus an index signature for extra query params.
  - `generateAuthUrl` throws "If a code_challenge_method is provided, code_challenge must be included."
  - It defaults `response_type` to `'code'` and fills `client_id` and `redirect_uri` from the constructor.
  - It does not generate or validate `state`.
- PKCE helpers: ([OA23])
  - `CodeChallengeMethod` is `{Plain = 'plain', S256 = 'S256'}`, exported from the package root.
  - `generateCodeVerifierAsync(): Promise<{codeVerifier: string; codeChallenge?: string}>` makes a 128-char verifier (96 random bytes, base64 with character substitutions). The challenge is base64url SHA-256 with no padding. It must be paired with S256.
  - The old `generateCodeVerifier()` throws "generateCodeVerifier is removed, please use generateCodeVerifierAsync instead."
- `getToken(code)` or `getToken({code, codeVerifier?, client_id?, redirect_uri?})` returns `Promise<{tokens: Credentials; res}>`. ([OA23])
  - Note the camelCase `codeVerifier` next to snake_case `redirect_uri` and `client_id`.
  - It POSTs form-urlencoded `client_id`, `code_verifier`, `code`, `grant_type=authorization_code`, `redirect_uri` and `client_secret` (with ClientSecretPost).
  - It converts `expires_in` into `expiry_date` (epoch ms), removes `expires_in`, then emits `'tokens'`.
- The `Credentials` type has `refresh_token?`, `expiry_date?` (ms), `access_token?`, `token_type?`, `id_token?` and `scope?`. It has no `refresh_token_expires_in` field, although the raw response object is passed through at runtime. ([OA23])
- The `'tokens'` event is typed `on(event: 'tokens', listener: (tokens: Credentials) => void)`. On refresh it fires before the library copies the existing `refresh_token` onto the new credentials, so the payload usually lacks `refresh_token`. ([OA25])
- Revocation methods: ([OA23])
  - `revokeToken(token)` POSTs to `oauth2RevokeUrl?token=<token>` and returns `{success: boolean}` data.
  - `revokeCredentials()` revokes `this.credentials.access_token` and clears the credentials. It throws "No access token to revoke." if there is none.
  - `getRevokeTokenURL(token)` returns a URL.
- `request<T>(opts)` adds the Authorization header. On a 401 or 403 it refreshes once and replays the request, but only if a `refresh_token` exists and either `expiry_date` is missing or `forceRefreshOnFailure` is set. `AuthClient.fetch<T>(...)` also exists; the README uses `client.fetch(url)`. ([OA23])
- On an `invalid_grant` refresh error whose `error_description` matches `/ReAuth/i`, the GaxiosError message becomes the JSON response body. A 403 or 404 during a metadata refresh gets the prefix "Could not refresh access token: ". ([OA23])
- `GoogleAuthOptions`: ([OA24])
  - Fields: `apiKey?`, `authClient?`, `keyFilename?` (@deprecated), `keyFile?` (@deprecated), `credentials?` (@deprecated), `clientOptions?`, `scopes?`, `projectId?`, `universeDomain?`.
  - The deprecation text cites the security risk of unvalidated credential configurations.
  - `keyFile` and `keyFilename` are aliases.
  - `getClient()` returns `Promise<AnyAuthClient>`.
- Official keyfile sample: `new GoogleAuth({keyFile, scopes: 'https://www.googleapis.com/auth/cloud-platform'}); const client = await auth.getClient(); const res = await client.fetch(url)`. ([OA27])
- Official PKCE sample: `generateCodeVerifierAsync()` → `generateAuthUrl({access_type: 'offline', scope, code_challenge_method: 'S256', code_challenge})` → `getToken({code, codeVerifier})` → `setCredentials(r.tokens)` → `request({url})`. ([OA26])
- The README says: ([OA22])
  - You MUST set `access_type: 'offline'` to get a refresh token.
  - The refresh token is returned only on first consent, and `prompt: 'consent'` forces it.
  - Use `client.on('tokens', ...)` to persist the refresh token.
  - It shows the JWT client: `new JWT({email: keys.client_email, key: keys.private_key, scopes})`.
- Workload Identity Federation works through ADC and `ExternalAccountClient.fromJSON(jsonConfig)`. ([OA22])
  - Supported sources: AWS, Azure, OIDC, X.509, executable-sourced credentials, and custom suppliers such as `AwsSecurityCredentialsSupplier`.
  - The README recommends it "for non-Google Cloud environments as it avoids the need to download, manage and store service account private keys".
  - With ADC external identities in Node, the service account needs `roles/browser` and the Cloud Resource Manager API, unless `projectId` is passed explicitly.

### Implementation contract

**Package**

- Use `google-auth-library@^11`, which needs **Node >= 22**. The only breaking change in 11.0.0 was the Node minimum.
- Point doc links at `googleapis/google-cloud-node` → `core/packages/google-auth-library-nodejs`. The old `googleapis/google-auth-library-nodejs` repo is archived.
- Imports: `import { OAuth2Client, GoogleAuth, JWT, CodeChallengeMethod, type Credentials, type GenerateAuthUrlOpts, type GetTokenOptions } from 'google-auth-library';`

**Desktop (installed app) flow: loopback + PKCE + state**

1. **Console (Google Auth Platform).**
   - Branding: app name, support email, developer contact.
   - Audience: External. Add the operator as a test user (up to 100 in Testing).
   - Clients → Create client → **Desktop app**.
   - Data Access: add `https://www.googleapis.com/auth/webmasters.readonly` and `https://www.googleapis.com/auth/analytics.readonly`.
   - Warn users: an External app in Testing gets refresh tokens that expire after **7 days**. These scopes are not covered by the name/email/profile exception. To avoid this, publish to "In production" (verification may be required) or use an Internal app in a Workspace org.
2. **Local listener.** `http.createServer(...).listen(0, '127.0.0.1')`, read `server.address().port`, and set ``redirectUri = `http://127.0.0.1:${port}` ``. Prefer `127.0.0.1` over `localhost`, since Google warns about firewalls. `http://[::1]:port` is also documented.
3. **Client.** `const client = new OAuth2Client({ clientId, clientSecret, redirectUri });` Use the options-object form; the positional form is deprecated.
4. **PKCE.** `const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();` Always pair it with S256.
5. **state.** The library does not generate or check it. Create it with `crypto.randomBytes(32).toString('base64url')`. Compare it to the callback's `state` with a constant-time compare, and reject on mismatch.
6. **Auth URL.**

   ```ts
   const url = client.generateAuthUrl({
     access_type: 'offline',        // from web-server doc + README; not listed in native-app doc
     prompt: 'consent',             // forces refresh_token re-issue
     scope: [SC_SCOPE, GA_SCOPE],   // array → joined with spaces
     state,
     code_challenge_method: CodeChallengeMethod.S256, // TS: typed as enum; the string literal 'S256' does not type-check
     code_challenge: codeChallenge!,
   });
   ```

   - Don't rely on `include_granted_scopes`: incremental authorization is not supported for installed apps.
   - `generateAuthUrl` mutates the opts object (it sets `response_type`, `client_id` and `redirect_uri`).
7. **Callback.** Parse `code`, `state` and `error` (e.g. `access_denied`). Reply with an HTML page telling the user to close the tab, then close the server.
8. **Exchange.** `const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });`
   - `codeVerifier` is camelCase and `redirect_uri` is snake_case.
   - `redirect_uri` must match the auth URL exactly.
   - `tokens.expiry_date` is epoch ms; `expires_in` has been removed.
   - `tokens.refresh_token` is present only on first consent, or when `prompt=consent` is sent.
   - `refresh_token_expires_in`, if Google sends it, is on the raw object but not in the `Credentials` type.
9. **Persist.** Call `client.setCredentials(tokens)` and store `refresh_token` securely (e.g. in the OS keychain). Register `client.on('tokens', t => save({ ...stored, ...t, refresh_token: t.refresh_token ?? stored.refresh_token }))`, because the refresh-path event usually lacks `refresh_token`.
10. **Calls.** `await client.request<T>({ url, method: 'POST', data })` returns a `GaxiosResponse<T>`; read `.data`. `client.fetch(url, init)` also works.
    - The library refreshes automatically when `expiry_date` is near (`eagerRefreshThresholdMillis`).
    - It retries once after a 401/403 only when `expiry_date` is missing or `forceRefreshOnFailure: true`.
11. **Re-auth required.** A GaxiosError with `message === 'invalid_grant'` or `response.data.error === 'invalid_grant'` on refresh means the user must re-authorize. Possible causes:
    - the 7-day Testing expiry;
    - the user revoked access;
    - the token went unused for 6 months;
    - more than 100 refresh tokens per account per client (the oldest is invalidated silently);
    - time-based access expired;
    - `admin_policy_enforced`;
    - the GCP session-length limit.
12. **Disconnect.** `await client.revokeToken(refreshToken)` POSTs to `https://oauth2.googleapis.com/revoke?token=...` and returns `{success}`. 200 means OK and 400 carries an error. Revoking an access token also revokes its paired refresh token. `client.revokeCredentials()` revokes only the current `access_token` and clears state.
13. **Never use OOB.** `urn:ietf:wg:oauth:2.0:oob` has been blocked for all clients since 2023-01-31.

**Service account (no domain-wide delegation)**

- **Loading the key.** `GoogleAuth({ keyFile | keyFilename | credentials })` still works but is `@deprecated`, because the credential config is not validated.
  - Safer path: read the JSON yourself and check `type === 'service_account'` and that `client_email` and `private_key` are present.
  - Then use `new JWT({ email: j.client_email, key: j.private_key, scopes: [SC_SCOPE, GA_SCOPE] })`, or `new GoogleAuth({ authClient: jwt })`.
  - ADC via `GOOGLE_APPLICATION_CREDENTIALS` with `new GoogleAuth({ scopes })` is also supported.
  - Service accounts have no refresh token, so skip the `on('tokens')` refresh-token logic.
- **Search Console access.**
  - Add the service account email (`client_email`) under Settings → Users and permissions → Add user, as Full or Restricted.
    - This is not explicitly documented for service accounts. Google's only explicit service-account doc (Indexing API) uses delegated owner via Verified owner → Add an owner.
    - Restricted should be enough for Search Analytics reads, but that is not officially stated.
    - Groups are not allowed, and a property can have at most 100 non-owners.
  - Verify access with `GET https://www.googleapis.com/webmasters/v3/sites` and check `permissionLevel`.
  - Search Analytics: `POST https://www.googleapis.com/webmasters/v3/sites/{encodeURIComponent(siteUrl)}/searchAnalytics/query`, with `siteUrl` like `sc-domain:example.com` or `https://example.com/`.
- **GA4 access.**
  - Admin → (Property) Access Management → **+** → Add users → service account email → role **Viewer** → Add. The person granting access needs Administrator.
  - Data API: `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport` with `analytics.readonly`.
- **APIs to enable** in the service account's Cloud project: the Google Analytics Data API, and the Search Console API for GSC.
- **Workload Identity Federation** is supported via an ADC `external_account` config or `ExternalAccountClient.fromJSON(cfg)`. It is recommended for non-GCP hosts because it avoids service-account keys. Pass `projectId` explicitly to avoid needing `roles/browser` and the Cloud Resource Manager API. Treat it as an advanced option; the service account email is still what gets added in GSC and GA4.

**Error mapping**

| Condition | Adapter error | Action |
|---|---|---|
| `invalid_grant` | `AuthExpired` | Prompt for re-consent. Mention the 7-day Testing rule if the app is External + Testing |
| HTTP 403 from GSC or GA | `PermissionDenied` | Tell the user to add the service account or user email with the right role |
| HTTP 400 on revoke | none | Log it and treat the token as already revoked |

### Unverified / to recheck with credentials

- **Service account as Full/Restricted user in Search Console.** The help page only says users "must have a valid Google Account". The only official service-account instruction (Indexing API prereqs) adds it as a delegated owner. Adding it as a user is common practice, but no official page confirms it.
- **Official steps for granting a service account the GA4 Viewer role.** The generic Access Management > + > Add users flow is verified. However, the current Data API and Admin API quickstarts say "grant your user account access". One WebFetch summary claimed service-account steps existed and a recheck contradicted it.
- **GA4 UI label.** The fetched help page says "Access Management", not "Property access management".
- **Loopback port/path registration for Desktop clients.** The doc says to use a random free port with the form `http://127.0.0.1:port` and no path. It does not say whether a path such as `/oauth2callback` is accepted, or that no registration is needed.
- **Token exchange without `client_secret`.** The doc marks `client_secret` "Optional", but the library sends it whenever it is set. No doc text was found saying the installed-app secret is "not treated as a secret".
- **Downloaded Desktop client JSON.** The top-level key (`installed` vs `web`) was not checked. The library README example uses `keys.web`.
- **`invalid_grant` wording.** The exact `error_description` for expired or revoked tokens (e.g. "Token has been expired or revoked.") was not seen on a fetched page.
- **`access_type=offline` and `prompt=consent` for Desktop clients.** The native-app doc omits both. They are defined in the web-server doc and recommended by the library README. Sending them is expected to be harmless, but no doc says so for installed apps.
- **Scope classification.** Whether `webmasters.readonly` and `analytics.readonly` are "sensitive" scopes that need verification before "In production" was not checked (the Data Access page was not fetched).
- **Google Auth Platform "Settings" section.** Not confirmed. Only Overview, Branding, Audience, Clients, Data Access and Verification Center were confirmed.
- **Clients help article.** The dedicated Google Cloud help article on managing OAuth clients was not fetched.

---

## 5. PageSpeed Insights v5, Chrome UX Report API, Google Search guidance

Covers PSI `runPagespeed`, CrUX `records:queryRecord` and `queryHistoryRecord`, and Google Search guidance on AI features, robots preview controls and spam policies.

### Sources

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| PS1 | https://developers.google.com/speed/docs/insights/v5/about | 2026-09-24 | yes | Last updated 2024-10-21 |
| PS2 | https://developers.google.com/speed/docs/insights/v5/get-started | 2026-09-24 | yes | Last updated 2025-08-28 |
| PS3 | https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed | 2026-09-24 | yes | REST reference. Last updated 2024-09-03 |
| PS4 | https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed | 2026-09-24 | yes | Older-style reference. Last updated 2025-10-27 |
| PS5 | https://developers.google.com/speed/docs/insights/v5/reference | 2026-09-24 | yes | Reference index |
| PS6 | https://developers.google.com/speed/docs/insights/faq | 2026-09-24 | yes | No quota info found |
| PS7 | https://pagespeedonline.googleapis.com/$discovery/rest?version=v5 | 2026-09-24 | yes | LIVE public discovery doc, revision 20260904 |
| PS8 | https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://developer.chrome.com/&strategy=MOBILE&fields=id,loadingExperience,originLoadingExperience,analysisUTCTimestamp,version | 2026-09-24 | yes | LIVE keyless GET returned 429. Used only to observe the error shape |
| PS9 | https://developer.chrome.com/docs/crux/api | 2026-09-24 | yes | Last updated 2025-02-11 |
| PS10 | https://developer.chrome.com/docs/crux/guides/crux-api | 2026-09-24 | yes | Last updated 2020-06-25 |
| PS11 | https://developer.chrome.com/docs/crux/history-api | 2026-09-24 | yes | Last updated Apr 11, 2025 |
| PS12 | https://chromeuxreport.googleapis.com/$discovery/rest?version=v1 | 2026-09-24 | yes | LIVE discovery doc, revision 20260922. Its metric allowed-values text is stale |
| PS13 | https://developer.chrome.com/docs/crux/reference/rest/v1/records/queryRecord | 2026-09-24 | yes | Returned a noindex stub with no usable content |
| PS14 | https://developers.google.com/search/docs/appearance/ai-features | 2026-09-24 | yes | Last updated 2025-12-10 |
| PS15 | https://developers.google.com/search/docs/essentials/spam-policies | 2026-09-24 | yes | Last updated 2026-08-28 |
| PS16 | https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag | 2026-09-24 | yes | Last updated 2026-03-24 |
| PS17 | https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers | 2026-09-24 | yes | Last updated 2026-07-14 |
| PS18 | https://github.com/GoogleChromeLabs/AutoWebPerf/blob/master/src/gatherers/psi.js | 2026-09-24 | yes | SECONDARY (Google Chrome Labs code, not docs) |

[PS1]: https://developers.google.com/speed/docs/insights/v5/about
[PS2]: https://developers.google.com/speed/docs/insights/v5/get-started
[PS3]: https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed
[PS4]: https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed
[PS7]: https://pagespeedonline.googleapis.com/$discovery/rest?version=v5
[PS8]: https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://developer.chrome.com/&strategy=MOBILE&fields=id,loadingExperience,originLoadingExperience,analysisUTCTimestamp,version
[PS9]: https://developer.chrome.com/docs/crux/api
[PS10]: https://developer.chrome.com/docs/crux/guides/crux-api
[PS11]: https://developer.chrome.com/docs/crux/history-api
[PS14]: https://developers.google.com/search/docs/appearance/ai-features
[PS15]: https://developers.google.com/search/docs/essentials/spam-policies
[PS16]: https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
[PS17]: https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers

### Verified behavior

**PSI request**

- runPagespeed is `GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed` with an empty body. ([PS3])
- `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` is also documented. The curl and JS samples use it, and the reference index says URIs are relative to `https://www.googleapis.com/pagespeedonline/v5`. ([PS2])
- Query params: ([PS3])
  - `url` (required).
  - `category`: if none is given, "only Performance category will be run".
  - `locale`.
  - `strategy`: "desktop is the default".
  - `utm_campaign`, `utm_source`, `captchaToken`.
- The REST page's enums: ([PS3])
  - Strategy: STRATEGY_UNSPECIFIED, DESKTOP, MOBILE.
  - Category: CATEGORY_UNSPECIFIED, ACCESSIBILITY, BEST_PRACTICES, PERFORMANCE, SEO.
- The older reference lists lowercase values: category `accessibility`, `best-practices`, `performance`, `seo`; strategy `desktop`, `mobile`. ([PS4])
- The discovery doc (revision 20260904) marks `category` as `repeated: true`. ([PS7])
  - Its enum: CATEGORY_UNSPECIFIED, ACCESSIBILITY, BEST_PRACTICES, PERFORMANCE, PWA, SEO, AGENTIC_BROWSING.
  - PWA is enumDeprecated ("deprecated in Lighthouse's 12.0 release").
  - AGENTIC_BROWSING is described as "a website's ability to be rendered by an agentic browsing system".
- Discovery param patterns: `url` must match `(?i)(url:|origin:)?http(s)?://.*` and `locale` must match `[a-zA-Z]+((_|-)[a-zA-Z]+)?`. Standard params include `key`, `fields` (partial response), `prettyPrint` and `alt`. ([PS7])
- To use an API key, append `key=yourAPIKey`. The page says the API "can be used with or without an API key, although a key is recommended for frequent, automated queries". ([PS2])
- **LIVE:** a keyless GET on 2026-09-24 returned HTTP 429 with `error.status` `RESOURCE_EXHAUSTED`, `errors[0].reason` `rateLimitExceeded`, a message about the "Queries per day" limit of `pagespeedonline.googleapis.com`, and `details[ErrorInfo].metadata.quota_limit_value` `"0"`. In practice keyless calls fail. ([PS8])
- Official notice: "We plan to discontinue including real-world data from the Chrome User Experience Report in this API. We recommend the CrUX API (guide) or the CrUX History API (guide) instead." ([PS2])

**PSI response**

- Top-level fields: ([PS3])
  - `kind`, `captchaResult`, `analysisUTCTimestamp`, `lighthouseResult`, `version {major, minor}`.
  - `id`: the canonical final URL after any redirects.
  - `loadingExperience`: metrics of end users' page loading experience.
  - `originLoadingExperience`: aggregated metrics for the origin.
- `PagespeedApiLoadingExperienceV5` is `{ id, metrics: map<string, UserPageLoadMetricV5>, overall_category, initial_url, origin_fallback }`. Note the snake_case fields. ([PS3])
  - `id`: the URL, pattern or origin the metrics apply to.
  - `initial_url`: the requested URL, which may differ from `id`.
  - `origin_fallback`: true if the result is an origin fallback from a page.
- `UserPageLoadMetricV5` has `metricId`, `distributions` (Bucket[]; "Proportions should sum up to 1"), `percentile` (int32), `median` (int32), `category` and `formFactor`. A Bucket is `{min, max, proportion}`, covering min <= x < max. ([PS7])
- `metrics.(key).category` and `overall_category` values are `"AVERAGE"`, `"FAST"`, `"NONE"`, `"SLOW"`. ([PS4])
- Metric keys in the official docs: `FIRST_CONTENTFUL_PAINT_MS` and `FIRST_INPUT_DELAY_MS` (sample JSON), and `INTERACTION_TO_NEXT_PAINT` (JS sample: `json.loadingExperience.metrics.INTERACTION_TO_NEXT_PAINT?.category`). In the sample, the last bucket has `min` but no `max`. ([PS2])
- `LighthouseResultV5` fields: ([PS3])
  - `fetchTime`, `requestedUrl`, `finalUrl`, `lighthouseVersion`, `i18n`, `userAgent`.
  - `audits` (map), `categoryGroups`, `stackPacks`, `categories`.
  - `environment {networkUserAgent, hostUserAgent, benchmarkIndex}`, `timing {total}`.
  - `runWarnings`: "Will always output to at least []".
  - `runtimeError {code, message}`: if present, the problem may be serious enough that the result should be discarded.
  - `configSettings {onlyCategories, emulatedFormFactor (deprecated), locale, channel, formFactor}`.
- Discovery adds `finalDisplayedUrl`, `mainDocumentUrl`, `fullPageScreenshot` and `entities` (LhrEntity[]: `name`, `origins`, `homepage`, `isFirstParty`, `isUnrecognized`, `category`). ([PS7])
- Category keys are `performance`, `accessibility`, `best-practices`, `seo`, plus `pwa` (deprecated) and `agentic-browsing` in discovery. ([PS7])
  - `LighthouseCategoryV5` = `{id, title, description, manualDescription, auditRefs[{id, weight, group}], score (can be null), categoryScoreDisplayMode}`.
  - `categoryScoreDisplayMode` is CATEGORY_SCORE_DISPLAY_MODE_UNSPECIFIED, GAUGE or FRACTION.
- `LighthouseAuditResultV5` has `id`, `title`, `description`, `score` ("can be null"), `scoreDisplayMode`, `displayValue`, `numericValue` (double), `numericUnit`, `details` (freeform), `warnings`, `errorMessage`, `explanation` and `metricSavings {FCP, LCP, CLS, INP, TBT}`. ([PS7])
- More enums: ([PS4])
  - `scoreDisplayMode`: SCORE_DISPLAY_MODE_UNSPECIFIED, binary, error, informative, manual, not_applicable, numeric.
  - `captchaResult`: CAPTCHA_BLOCKING, CAPTCHA_MATCHED, CAPTCHA_NEEDED, CAPTCHA_NOT_NEEDED, CAPTCHA_UNMATCHED.
- The sample JS reads audits `first-contentful-paint`, `speed-index`, `largest-contentful-paint`, `total-blocking-time` and `interactive` via `.displayValue`. The sample `categories.performance.score` is 0.96, so scores are on a 0-1 scale. ([PS2])

**Field-data semantics and thresholds**

- Thresholds: ([PS1])

  | Metric | Good | Needs improvement | Poor |
  |---|---|---|---|
  | FCP | [0, 1800 ms] | (1800, 3000] | > 3000 |
  | LCP | [0, 2500 ms] | (2500, 4000] | > 4000 |
  | CLS | [0, 0.1] | (0.1, 0.25] | > 0.25 |
  | INP | [0, 200 ms] | (200, 500] | > 500 |
  | TTFB (experimental) | [0, 800 ms] | (800, 1800] | > 1800 |
- PSI reports the 75th percentile over the previous 28-day collection period. ([PS1])
  - If a page lacks data, PSI falls back to the origin. If the origin also lacks data, no real-user data is shown.
  - Field data updates daily.
- Core Web Vitals assessment: ([PS1])
  - It passes if the p75 of INP, LCP and CLS are all Good.
  - If INP has insufficient data, it passes when LCP and CLS are both Good.
  - If LCP or CLS lacks data, the page or origin cannot be assessed.
- Lighthouse category score bands: 90 and above is good, 50-89 needs improvement, below 50 is poor. Lab mobile emulates a Moto G4 on a mobile network; desktop uses a wired connection. ([PS1])

**CrUX API**

- The endpoint is `POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=API_KEY` with a JSON body (`Content-Type: application/json`). ([PS9])
- Body fields: ([PS9])
  - Exactly one of `origin` or `url` (union `url_pattern`).
  - `formFactor?`: `DESKTOP`, `PHONE` or `TABLET`. Without it, data is aggregated over all form factors.
  - `metrics?`: string[]. Without it, all available metrics are returned.
- Every request needs a Google Cloud API key set up for the Chrome UX Report API: "All API requests must provide a value for the key parameter". ([PS10])
- Metric names: ([PS9])
  - `cumulative_layout_shift`: a 2-decimal double encoded as a string.
  - `first_contentful_paint`, `interaction_to_next_paint`, `largest_contentful_paint`, `experimental_time_to_first_byte`, `round_trip_time`: int ms, a 3-bin histogram plus p75.
  - `form_factors`, `navigation_types`, `largest_contentful_paint_resource_type`: fractions.
  - `largest_contentful_paint_image_time_to_first_byte`, `_resource_load_delay`, `_resource_load_duration`, `_element_render_delay`: p75 only.
  - `experimental_ad_count`, `experimental_ad_density`, `experimental_ad_cpu`, `experimental_ad_kilobytes`: p75 only.
- `form_factors` is reported only when the request has no `formFactor`. The ad metrics are reported only for pages included in ad metrics. ([PS9])
- Response: `{ record: { key: { formFactor?, origin | url }, metrics: { <name>: { histogram?: [{start, end?, density}], percentiles?: { p75 }, fractions?: {label: number} } }, collectionPeriod: { firstDate: {year, month, day}, lastDate: {year, month, day} } }, urlNormalizationDetails?: { originalUrl, normalizedUrl } }`. ([PS9])
  - A bin without `end` runs from `start` to +inf.
  - Densities and fractions are rounded to 4 decimals.
  - For CLS, bin `start`/`end` and `p75` are strings. For ms metrics they are ints.
- The no-data error is `{"error":{"code":404,"message":"chrome ux report data not found","status":"NOT_FOUND"}}`. ([PS10])
  - Causes: the origin is not the publicly navigable version (wrong protocol or www), there are too few samples, or the page is not publicly indexable.
  - Finer queries (URL plus formFactor, especially TABLET) hit "not found" more often.
- The API may normalize URLs (e.g. strip a `#fragment`) and then includes `urlNormalizationDetails`. Redirects are not followed. ([PS10])
- Data is a rolling 28-day aggregate, updated daily around 04:00 UTC on a best-effort basis with no SLA, about 2 days behind. `collectionPeriod` always spans 28 days. ([PS9])
- The rate limit is 150 queries per minute per Google Cloud project. The API is free, and quota increases cannot be bought. ([PS9])
- The History API (`POST .../v1/records:queryHistoryRecord`) shares the same 150 qpm limit. ([PS11])
  - `collectionPeriodCount` is 1-40 (default 25), with weekly periods updated on Mondays.
  - The response uses `histogramTimeseries`/`densities[]` and `percentilesTimeseries.p75s[]`.
  - Ineligible periods return `"NaN"` densities and `null` p75s.

**Google Search guidance**

- AI features: "There are no additional requirements to appear in AI Overviews or AI Mode, nor other special optimizations necessary." To be a supporting link, a page must be indexed and eligible to show in Search with a snippet. "There are no additional technical requirements." ([PS14])
- "You don't need to create new machine readable files, AI text files, or markup to appear in these features. There's also no special schema.org structured data that you need to add." ([PS14])
- The SEO basics the page lists: ([PS14])
  - Allow crawling in robots.txt and in any CDN or hosting setup.
  - Internal links.
  - Good page experience.
  - Important content in text form.
  - Quality images and video.
  - Structured data that matches the visible text.
  - Up-to-date Merchant Center and Business Profile info.
- AI Overviews and AI Mode traffic is counted in the Search Console Performance report under the "Web" search type. ([PS14])
  - Controls: robots.txt for Googlebot manages crawling. `nosnippet`, `data-nosnippet`, `max-snippet` or `noindex` limit what is shown.
  - Google-Extended covers AI training and grounding in other Google systems.
- Snippet controls: ([PS16])
  - `nosnippet` applies to web search, Google Images, Discover, AI Overviews and AI Mode. It "will also prevent the content from being used as a direct input for AI Overviews and AI Mode".
  - `max-snippet:[number]` also limits direct input to AI Overviews and AI Mode.
  - When rules conflict, the more restrictive one wins.
  - `data-nosnippet` works on `span`, `div` and `section` elements.
- "Google-Extended does not impact a site's inclusion in Google Search nor is it used as a ranking signal in Google Search." It is a robots.txt token only, with no separate HTTP user agent. ([PS17])
- Spam policies: ([PS15])
  - The spam definition now includes "attempting to manipulate generative AI responses in Google Search".
  - Policies: Cloaking, Doorway abuse, Expired domain abuse, Hacked content, Hidden text and link abuse, Keyword stuffing, Link spam, Machine-generated traffic, Malicious practices (including back button hijacking), Misleading functionality, Scaled content abuse, Scraping, Site reputation policy, Sneaky redirects, Thin affiliation, User-generated spam.
  - Also covered: Legal removals, Personal information removals, Policy circumvention, Scam and fraud.
- Scaled content abuse is "many pages are generated for the primary purpose of manipulating search rankings and not helping users ... no matter how it's created". ([PS15])
  - Examples: using generative AI or similar tools to make many pages without adding value; scraping or auto-transforming content (synonymizing, translating); stitching content together without adding value; multiple sites that hide the scale; keyword pages that make little sense.
  - "If you're hosting such content on your site, exclude it from Search."
- The section is now titled "Site reputation policy" (no longer "site reputation abuse"). ([PS15])
  - It covers third-party content published on a host site "mainly because of that host's already-established ranking signals". Third-party content alone does not violate it.
  - Enforcement: outside the EEA, a possible manual action. Inside the EEA, pages may be treated as separate from the main domain, with no manual action.
- Machine-generated traffic: "sending automated queries to Google. This includes scraping results for rank-checking purposes or other types of automated access to Google Search conducted without express permission". It violates the spam policies and the Google ToS. ([PS15])
- Link spam carve-out: paid or sponsored links are fine when qualified with `rel="nofollow"` or `rel="sponsored"`. Expired domain abuse and thin affiliation are separate policies. Good affiliate pages add original reviews, testing, comparisons and similar value. ([PS15])

### Implementation contract

**PSI adapter (lab data; field data for now)**

- **Request.** `GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed`. `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` is also documented.
- **Params.**
  - `url`: required, http/https.
  - `strategy`: `MOBILE` or `DESKTOP`. The default is desktop, so always send it.
  - `category`: repeat the param for each one, e.g. `category=PERFORMANCE&category=SEO&category=ACCESSIBILITY&category=BEST_PRACTICES`.
  - `locale`, `key`.
  - Optional `fields=` to shrink the response.
- **Key.** Send `key` on every request. The docs call it optional, but a keyless call returned 429 `RESOURCE_EXHAUSTED` (`quota_limit_value "0"`). Keep the key server-side or in env.
- **Timeouts.** Lighthouse runs are slow. Use a generous timeout (60 s or more) and retry with backoff on 429 and 5xx.
- **Errors.** The standard Google API shape: `{ error: { code: number, message: string, status: string, errors?: [{ message, domain, reason }], details?: [{ '@type': string, reason?, metadata? }] } }`.
- **Types.**

  ```ts
  interface PsiResponse { kind?: string; captchaResult?: string; id: string; loadingExperience?: LoadingExperience; originLoadingExperience?: LoadingExperience; analysisUTCTimestamp: string; lighthouseResult: LighthouseResult; version?: { major: string|number; minor: string|number } }
  interface LoadingExperience { id?: string; metrics?: Record<string, { percentile?: number; distributions?: { min?: number; max?: number; proportion: number }[]; category?: 'FAST'|'AVERAGE'|'SLOW'|'NONE'|string; metricId?: string; median?: number; formFactor?: string }>; overall_category?: string; initial_url?: string; origin_fallback?: boolean }
  ```

- **Field data.**
  - `loadingExperience` is page-level. If `origin_fallback === true`, it actually holds origin data.
  - `originLoadingExperience` is origin-level.
  - Treat missing `metrics` as "no field data".
- **Metric keys.** Index them defensively as `Record<string, …>`.
  - The official docs confirm only `FIRST_CONTENTFUL_PAINT_MS` and `INTERACTION_TO_NEXT_PAINT`.
  - `LARGEST_CONTENTFUL_PAINT_MS` and `CUMULATIVE_LAYOUT_SHIFT_SCORE` come only from Chrome Labs code.
  - `EXPERIMENTAL_TIME_TO_FIRST_BYTE` is unverified.
  - PSI's CLS is likely scaled x100 (unverified), so prefer CrUX API values for CLS.
- **Lab data.**
  - `lighthouseResult.categories['performance'|'seo'|'accessibility'|'best-practices'].score` is 0-1 or null. Multiply by 100 to display; the bands are ≥90, 50-89, <50.
  - Audits: read `lighthouseResult.audits[id].{score, scoreDisplayMode, numericValue, numericUnit, displayValue, details, metricSavings}`.
  - If `lighthouseResult.runtimeError` is present, discard or flag the result.
  - Check `runWarnings`. Confirm mobile/desktop via `configSettings.formFactor`.
- **Deprecation.** Google plans to remove CrUX data from PSI. Build field data on the CrUX API and treat PSI `loadingExperience` as an optional fallback.

**CrUX adapter (the main source of field data)**

- **Request.** `POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=KEY` with `Content-Type: application/json`.
- **Body.** `{ origin } | { url }` (exactly one), optional `formFactor: 'PHONE'|'DESKTOP'|'TABLET'` (omit for all devices), optional `metrics: string[]`.
- **Metrics to request.**
  - Recommended: `largest_contentful_paint`, `interaction_to_next_paint`, `cumulative_layout_shift`, `first_contentful_paint`, `experimental_time_to_first_byte`.
  - Optional: `round_trip_time`, `navigation_types`, `largest_contentful_paint_resource_type` and the `largest_contentful_paint_image_*` LCP subparts.
  - `form_factors` comes back only when `formFactor` is omitted.
- **Response.** `{ record: { key: { formFactor?, origin? | url? }, metrics: Record<string, { histogram?: { start: number|string; end?: number|string; density: number }[]; percentiles?: { p75: number|string }; fractions?: Record<string, number> }>, collectionPeriod: { firstDate: {year,month,day}, lastDate: {year,month,day} } }, urlNormalizationDetails?: { originalUrl, normalizedUrl } }`.
  - `metrics` is a map, even though one docs example shows an array.
  - Parse CLS `p75`, `start` and `end` with `Number()`.
  - A bin with no `end` means +inf.
- **Fallback.**
  1. Query `{url, formFactor}`.
  2. On 404 `NOT_FOUND` (`'chrome ux report data not found'`), try `{origin, formFactor}`, then drop `formFactor`.
  3. Record which level answered (url or origin).
  - Treat 404 as "insufficient data", not a failure.
  - Normalize the origin to its publicly navigable form (scheme + host, no path), since the wrong www or protocol causes 404s.
- **Rating** (PSI thresholds): values at or below the first number are good, at or below the second need improvement, above it are poor.
  - LCP ≤2500 / ≤4000 ms.
  - INP ≤200 / ≤500 ms.
  - CLS ≤0.1 / ≤0.25.
  - FCP ≤1800 / ≤3000 ms.
  - TTFB ≤800 / ≤1800 ms.
- **CWV pass/fail.** Pass if all three p75s are good. If INP is missing, use LCP and CLS only. If LCP or CLS is missing, report "not assessable".
- **Rate limit.** 150 queries/min per GCP project, shared with the History API. Throttle client-side, e.g. a token bucket at about 2 req/s.
- **Caching.** Data refreshes daily around 04:00 UTC, so cache results per day.
- **History (optional).** `POST .../v1/records:queryHistoryRecord` with `collectionPeriodCount` 1-40 (default 25). Handle `"NaN"` densities and `null` p75s.

**Search guidance for the agent's rules and prompts**

- **AI features.**
  - Never recommend "AI optimization" files, llms.txt-style AI text files or special schema. Google says none are needed for AI Overviews or AI Mode.
  - Eligibility is simply: indexed, snippet-eligible, and standard SEO fundamentals.
- **Snippet controls.**
  - Flag `nosnippet` and `max-snippet:0` as blocking AI Overview/AI Mode use, as well as snippets.
  - Flag `noindex` as blocking entirely.
  - `data-nosnippet` is valid only on `span`, `div` and `section`.
- **Google-Extended** does not affect Search inclusion or ranking.
- **Reporting.** AI feature traffic is inside Search Console Performance "Web". There is no separate report.
- **Spam guardrails for content generation.**
  - Do not mass-generate pages without added value; scaled content abuse applies "no matter how it's created".
  - No doorway city or region pages.
  - No keyword stuffing, hidden text or unqualified paid links. Paid links need `rel="sponsored"` or `rel="nofollow"`.
  - Check third-party or hosted content against the "Site reputation policy", and use that current section name.
- **Agent behavior.** Do NOT scrape Google SERPs for rank checking. It is explicitly "machine-generated traffic" and violates the Google ToS. Use the Search Console API or licensed data providers instead.

### Unverified / to recheck with credentials

- **PSI field metric keys.** `LARGEST_CONTENTFUL_PAINT_MS` and `CUMULATIVE_LAYOUT_SHIFT_SCORE` are not in the official PSI docs. They appear only in SECONDARY GoogleChromeLabs/AutoWebPerf code and its test fixture. `EXPERIMENTAL_TIME_TO_FIRST_BYTE` was not found in any Google-owned source. Official docs name only `FIRST_CONTENTFUL_PAINT_MS`, `FIRST_INPUT_DELAY_MS` (legacy) and `INTERACTION_TO_NEXT_PAINT`.
- **PSI CLS scaling.** The AutoWebPerf fixture shows `CUMULATIVE_LAYOUT_SHIFT_SCORE` percentile and buckets as CLS x 100 (e.g. percentile 3 = 0.03; buckets 0-10, 10-25, 25+). This is not officially documented.
- **PSI `percentile` meaning.** The discovery doc says "For v5, this field contains pc90". The About page says PSI reports the 75th percentile. Unresolved.
- **PSI with no CrUX data.** The response when neither page nor origin has data is undocumented. For example, `loadingExperience` might be omitted or contain only `initial_url`.
- **PSI quota numbers.** Keyed queries per day and per 100 seconds are not on any fetched page. Only the keyless 429 (`quota_limit_value "0"`) was observed.
- **Enum casing.** Not tested whether both uppercase (`MOBILE`, `SEO`) and lowercase (`mobile`, `seo`) values are accepted at runtime. Each form appears in a different official reference.
- **AGENTIC_BROWSING.** The category and its `agentic-browsing` key are only in the discovery doc (revision 20260904). Their behavior and audits are undocumented.
- **`origin:` prefix.** The PSI `url` pattern allows it, but its meaning is not described in the human-readable docs.
- **CrUX discovery-only fields.** The `effectiveConnectionType` request field and the `ALL_FORM_FACTORS` formFactor appear only in the discovery doc. The discovery metric allowed-values text is stale: it lists `first_input_delay` and `experimental_interaction_to_next_paint`.
- **CrUX error shapes.** Errors other than 404 NOT_FOUND (e.g. 400 invalid argument, 403 bad or missing key, 429) are not documented on the fetched pages.
- **CrUX queryRecord reference page** returned a noindex stub.
- **PSI Lighthouse audit ids.** `cumulative-layout-shift` is not confirmed in the PSI docs, and neither is whether `interactive` is still present.

### Structured-data feature requirements (content quality gate)

Spec section 17 allows structured data only when it accurately describes
visible content **and** meets current feature requirements, and it forbids
assuming that FAQs qualify for a rich result. The content quality gate
(`structured_data` check in `src/content/quality.ts`) and the draft prompt
read the same versioned table, `src/content/structured-data-requirements.ts`
(version `sd-requirements@2026-09-24`). The table below mirrors it; the code
is authoritative.

| Type | Rich result | Required properties | Verified | Source (developers.google.com/search/docs/appearance/...) |
| --- | --- | --- | --- | --- |
| `Article` | eligible | none | 2026-09-24 | structured-data/article |
| `BlogPosting` | eligible | none | unverified | structured-data/article |
| `NewsArticle` | eligible | none | unverified | structured-data/article |
| `FAQPage` | deprecated | none | 2026-09-24 | the former FAQPage page redirects to developers.google.com/search/updates |
| `HowTo` | deprecated | none | 2026-09-24 | structured-data/how-to |
| `Product` | eligible | `name`, and `review` or `aggregateRating` or `offers` | 2026-09-24 | structured-data/product-snippet |
| `SoftwareApplication` | eligible | `name`, `offers.price`, and `aggregateRating` or `review` | 2026-09-24 | structured-data/software-app |
| `LocalBusiness` | eligible | `name`, `address` | 2026-09-24 | structured-data/local-business |
| `Organization` | eligible | none | 2026-09-24 | structured-data/organization |
| `BreadcrumbList` | eligible | `itemListElement`; each element needs `position`, `name`, and `item` (`item` not on the last one) | 2026-09-24 | structured-data/breadcrumb |
| `ItemList` | restricted | `itemListElement` | unverified | structured-data/carousel |
| `WebPage` | none | none | 2026-09-24 | structured-data/search-gallery (not listed) |
| `Service` | none | none | 2026-09-24 | structured-data/search-gallery (not listed) |

- **Rich result** values: `eligible` means Google documents a Search feature
  for the type; eligibility is never a guarantee. `deprecated` means Google
  no longer shows that rich result. `restricted` means it is shown only in
  narrow combinations. `none` means no Search rich-result feature exists for
  the type.
- **Verified** is the date recorded in the code for a check of the source
  page (the code notes "automated fetch during development"). This check was
  not repeated for this document. `unverified` entries were transcribed
  without re-checking the page. Re-verify every entry before relying on it,
  and bump the table version when Google changes a feature.
- **Gate behavior.** A type outside the table is refused. An `eligible` type
  that lacks a required property fails the check. `deprecated` and
  `restricted` types raise a warning that needs human review, and `none`
  types raise a plain warning, so FAQ or HowTo markup is never presented as a
  rich-result opportunity. Independently of the table, review or rating
  markup without real review evidence fails, every text value must be
  visible on the page, prices must come from verified owner product facts,
  and a proposal for new content never carries `datePublished` or
  `dateModified` (a human sets real dates at publication). On an update,
  dates must be valid, `dateModified` cannot precede `datePublished`, and a
  human confirms that `dateModified` reflects a substantive change.

---

## 6. DataForSEO API v3

### Sources

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| DF1 | https://docs.dataforseo.com/v3/auth/ | 2026-09-24 | yes | WebFetch plus raw GET |
| DF2 | https://docs.dataforseo.com/v3/ | 2026-09-24 | yes | WebFetch plus raw GET. Nav used to enumerate endpoint families |
| DF3 | https://dataforseo.com/pricing | 2026-09-24 | yes | |
| DF4 | https://docs.dataforseo.com/v3/serp/google/organic/task_post/ | 2026-09-24 | yes | |
| DF5 | https://docs.dataforseo.com/v3/serp/google/organic/tasks_ready/ | 2026-09-24 | yes | |
| DF6 | https://docs.dataforseo.com/v3/serp/google/organic/task_get/regular/ | 2026-09-24 | yes | |
| DF7 | https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/ | 2026-09-24 | yes | |
| DF8 | https://docs.dataforseo.com/v3/serp/google/organic/live/regular/ | 2026-09-24 | yes | |
| DF9 | https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/ | 2026-09-24 | yes | |
| DF10 | https://docs.dataforseo.com/v3/serp/google/organic/overview/ | 2026-09-24 | yes | |
| DF11 | https://docs.dataforseo.com/v3/serp/google/locations/ | 2026-09-24 | yes | |
| DF12 | https://docs.dataforseo.com/v3/serp/google/languages/ | 2026-09-24 | yes | |
| DF13 | https://docs.dataforseo.com/v3/appendix/errors/ | 2026-09-24 | yes | |
| DF14 | https://docs.dataforseo.com/v3/appendix/sandbox/ | 2026-09-24 | yes | |
| DF15 | https://docs.dataforseo.com/v3/appendix/user_data/ | 2026-09-24 | yes | |
| DF16 | https://docs.dataforseo.com/v3/keywords_data/google_ads/overview/ | 2026-09-24 | yes | Google Ads API is the source. 12 req/min on Live, 2000 calls/min overall |
| DF17 | https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/task_post/ | 2026-09-24 | yes | |
| DF18 | https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/ | 2026-09-24 | yes | |
| DF19 | https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/task_get/ | 2026-09-24 | yes | |
| DF20 | https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/tasks_ready/ | 2026-09-24 | yes | |
| DF21 | https://docs.dataforseo.com/v3/keywords_data/google_ads/locations/ | 2026-09-24 | yes | |
| DF22 | https://docs.dataforseo.com/v3/keywords_data/google_ads/languages/ | 2026-09-24 | yes | |
| DF23 | https://docs.dataforseo.com/v3/backlinks/overview/ | 2026-09-24 | yes | |
| DF24 | https://docs.dataforseo.com/v3/dataforseo_labs/overview/ | 2026-09-24 | yes | |
| DF25 | https://docs.dataforseo.com/v3/ai_optimization/overview/ | 2026-09-24 | yes | |
| DF26 | https://docs.dataforseo.com/v3/ai_optimization/llm_mentions/overview/ | 2026-09-24 | yes | Live only, 2000 calls/min, 30 simultaneous |
| DF27 | https://docs.dataforseo.com/v3/ai_optimization/llm_mentions/search_mentions/live/ | 2026-09-24 | yes | Confirms the API path matches the docs path |
| DF28 | https://docs.dataforseo.com/v3/backlinks/summary/live/ | 2026-09-24 | yes | Confirms `https://api.dataforseo.com/v3/backlinks/summary/live` |
| DF29 | https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/ | 2026-09-24 | yes | Confirms the API path |
| DF30 | https://dataforseo.com/pricing/google-serp/google-organic-serp-api | 2026-09-24 | yes | |
| DF31 | https://dataforseo.com/pricing/keywords-data/google-ads | 2026-09-24 | yes | |
| DF32 | https://dataforseo.com/pricing/backlinks/backlinks | 2026-09-24 | yes | |
| DF33 | https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api | 2026-09-24 | yes | |
| DF34 | https://dataforseo.com/pricing/ai-optimization/llm-mentions | 2026-09-24 | yes | JS calculator. The static figures are inconsistent (see Unverified) |
| DF35 | https://dataforseo.com/update/pricing-update-in-dataforseo-apis | 2026-09-24 | yes | |
| DF36 | https://dataforseo.com/apis/keyword-data-api | 2026-09-24 | yes | |
| DF37 | https://dataforseo.com/help-center/how-does-your-free-unlimited-trial-work | 2026-09-24 | yes | |
| DF38 | https://dataforseo.com/help-center/how-long-do-you-keep-results | 2026-09-24 | yes | |
| DF39 | https://dataforseo.com/help-center/completed-tasks | 2026-09-24 | yes | How Tasks Ready works, and how it interacts with postback/pingback |
| DF40 | https://dataforseo.com/help-center/dataforseo-sandbox-best-practices | 2026-09-24 | yes | Sandbox host-swap example |
| DF41 | https://api.dataforseo.com/v3/appendix/errors | 2026-09-24 | yes | LIVE unauthenticated GET: HTTP 401, WWW-Authenticate Basic, body with `status_code` 40100 |
| DF42 | https://sandbox.dataforseo.com/v3/serp/google/languages | 2026-09-24 | yes | LIVE unauthenticated GET: HTTP 401 / 40100 |

[DF1]: https://docs.dataforseo.com/v3/auth/
[DF2]: https://docs.dataforseo.com/v3/
[DF3]: https://dataforseo.com/pricing
[DF4]: https://docs.dataforseo.com/v3/serp/google/organic/task_post/
[DF5]: https://docs.dataforseo.com/v3/serp/google/organic/tasks_ready/
[DF6]: https://docs.dataforseo.com/v3/serp/google/organic/task_get/regular/
[DF7]: https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/
[DF9]: https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
[DF10]: https://docs.dataforseo.com/v3/serp/google/organic/overview/
[DF11]: https://docs.dataforseo.com/v3/serp/google/locations/
[DF13]: https://docs.dataforseo.com/v3/appendix/errors/
[DF14]: https://docs.dataforseo.com/v3/appendix/sandbox/
[DF15]: https://docs.dataforseo.com/v3/appendix/user_data/
[DF17]: https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/task_post/
[DF18]: https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/
[DF19]: https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/task_get/
[DF23]: https://docs.dataforseo.com/v3/backlinks/overview/
[DF24]: https://docs.dataforseo.com/v3/dataforseo_labs/overview/
[DF25]: https://docs.dataforseo.com/v3/ai_optimization/overview/
[DF30]: https://dataforseo.com/pricing/google-serp/google-organic-serp-api
[DF31]: https://dataforseo.com/pricing/keywords-data/google-ads
[DF32]: https://dataforseo.com/pricing/backlinks/backlinks
[DF33]: https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
[DF35]: https://dataforseo.com/update/pricing-update-in-dataforseo-apis
[DF36]: https://dataforseo.com/apis/keyword-data-api
[DF37]: https://dataforseo.com/help-center/how-does-your-free-unlimited-trial-work
[DF38]: https://dataforseo.com/help-center/how-long-do-you-keep-results
[DF42]: https://sandbox.dataforseo.com/v3/serp/google/languages

### Verified behavior

**Auth, hosts, sandbox**

- Auth is HTTP Basic only: `Authorization: Basic base64(login:password)`. Credentials cannot go in URL parameters, and there is no separate auth call. ([DF1])
- The API login and password come from the dashboard's API Access tab (https://app.dataforseo.com/api-access). The API password is auto-generated and differs from the account password. ([DF1])
- The base URL is `https://api.dataforseo.com/v3/`. Code samples use host `https://api.dataforseo.com/` plus path `/v3/...`. ([DF2])
- The sandbox is `https://sandbox.dataforseo.com/v3/$path`. ([DF14])
  - Only the hostname changes; the POST data stays the same.
  - It is free for any registered user and returns generic dummy data in the same structure.
  - It supports `pingback_url`/`postback_url` and Live endpoints.
  - It has the same rate limits as production: 2000 calls per minute, at most 100 tasks per POST, and 1 task per live call.
- The sandbox dummy id `https://sandbox.dataforseo.com/v3/serp/google/organic/task_get/advanced/00000000-0000-0000-0000-000000000000` returns every SERP feature. A regular variant also exists. "You won't be charged for using Sandbox endpoints." ([DF7])
- **LIVE:** the sandbox also requires Basic auth. An unauthenticated GET returned HTTP 401, `WWW-Authenticate: Basic realm="DataForSEO REST API"`, and a body with no `version` key: `{"status_code":40100,"status_message":"You are not Authorized to Access this Resource. ...","time":"0 sec.","cost":0,"tasks_count":0,"tasks_error":0,"tasks":[]}`. ([DF42])

**SERP: Standard (task) flow**

- task_post is `POST https://api.dataforseo.com/v3/serp/google/organic/task_post`. ([DF4])
  - The body is a JSON array of task objects, UTF-8.
  - Limits: up to 2000 API calls per minute and at most 100 tasks per POST. Tasks beyond 100 return error 40006.
  - You are charged only when the task is set.
- task_post fields: ([DF4])
  - **`keyword`:** required, up to 700 chars. Send `%` as `%25` and `+` as `%2B`. Search operators such as `site:` and `intitle:` multiply the charge by 5.
  - **Location (one required):** `location_code` (e.g. 2840), `location_name` (e.g. `London,England,United Kingdom`) or `location_coordinate` (`lat,lng,radius`).
  - **Language (one required):** `language_code` (e.g. `en`) or `language_name` (e.g. `English`).
  - **`depth`:** default 10, max 700. Billed per SERP of 10 results.
  - **`device`:** `desktop` (default) or `mobile`.
  - **`os`:** desktop takes `windows` (default) or `macos`; mobile takes `android` (default) or `ios`.
  - **`priority`:** 1 (normal, default) or 2 (high, extra charge).
  - **`tag`:** max 255 chars, echoed back in `data`.
  - **`postback_url`:** results are POSTed gzip-compressed. Supports `$id` and `$tag` placeholders. Requires `postback_data`: `regular`, `advanced` or `html`.
  - **`pingback_url`:** a GET notification. Supports `$id`/`$tag`.
  - **Also:** `se_domain`, `url`, `max_crawl_pages` (max 100), `stop_crawl_on_match`, `target_search_mode`, `find_targets_in`, `ignore_targets_in`, `search_param`, `remove_from_url`, `group_organic_results`, `calculate_rectangles`, `browser_screen_width`/`height`/`resolution_ratio`, `people_also_ask_click_depth` (1-4), `load_async_ai_overview`, `expand_ai_overview`.
- For postback and pingback, if your server doesn't respond within 10 seconds the connection is dropped and the task moves to the Tasks Ready list. ([DF4])
- Response envelope: ([DF4])
  - **Top level:** `version`, `status_code`, `status_message`, `time` (e.g. `'0.0818 sec.'`), `cost` (float, USD), `tasks_count`, `tasks_error`, `tasks[]`.
  - **Each task:** `id` (UUID), `status_code` (10000-60000), `status_message`, `time`, `cost`, `result_count`, `path[]`, `data` (echoes the request params plus `api`/`function`/`se`/`se_type`) and `result` (array; null for task_post).
  - In the task_post example, the top level is 20000 "Ok." and the task is 20100 "Task Created."
- Tasks Ready is `GET https://api.dataforseo.com/v3/serp/google/organic/tasks_ready`. `/v3/serp/$se/tasks_ready` and `/v3/serp/tasks_ready` also exist. ([DF5])
  - It is free and limited to 20 calls per minute.
  - It returns up to 1000 tasks completed in the past three days. Tasks already collected, or not collected within 3 days, are excluded.
  - Tasks with a `postback_url` appear only if delivery failed (non-2xx).
  - Result items: `id`, `se`, `se_type`, `date_posted`, `tag`, `endpoint_regular`, `endpoint_advanced`, `endpoint_html` (e.g. `/v3/serp/google/organic/task_get/regular/<id>`).
- Task GET Regular is `GET https://api.dataforseo.com/v3/serp/google/organic/task_get/regular/$id`. ([DF6])
  - Results can be fetched free for 30 days; only posting is charged.
  - Result fields: `keyword`, `type`, `se_domain`, `location_code`, `language_code`, `check_url`, `datetime`, `spell`, `refinement_chips`, `item_types`, `se_results_count`, `pages_count`, `items_count`, `items[]`.
  - Regular items are only of types `organic`, `paid` and `featured_snippet`. Their fields: `type`, `rank_group`, `rank_absolute`, `page`, `domain`, `title`, `description`, `url`, `breadcrumb`.
- Task GET Advanced is `GET https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/$id`, retrievable for 30 days. ([DF7])
  - It returns every SERP element type.
  - Organic items add fields such as `position`, `xpath`, `website_name`, `pre_snippet`, `extended_snippet`, `images`, `amp_version`, `rating`, `price`, `highlighted`, `links`, `about_this_result`.
  - Deprecated: `is_image`, `is_video`, `is_featured_snippet`, `is_malicious` and `is_web_story` (replaced by the `checks` array), and `faq` (always null).

**SERP: Live and cost**

- Live is `POST https://api.dataforseo.com/v3/serp/google/organic/live/regular` or `.../live/advanced`. ([DF9])
  - Exactly one task per call, up to 2000 calls per minute, charged per request.
  - `depth` max is 200 on Live (vs 700 on task_post).
  - The Live pages document no `priority`, `postback_url`, `postback_data` or `pingback_url` fields.
- Paid extras: ([DF9])
  - `calculate_rectangles` and `load_async_ai_overview` each cost an extra $0.002 on Live Advanced, and an extra $0.0006 on Standard task_post.
  - `people_also_ask_click_depth` costs $0.00015 per click.
- Cost formula: `cost = B * C * K * (D/default value)`. ([DF10])
  - B is the base price for the method and priority.
  - C = 2 if `calculate_rectangles` or `load_async_ai_overview` is true.
  - K = 5 if the keyword has search operators.
  - D is the depth, rounded up.
- Google Organic pricing per SERP (10 results): ([DF30])
  - Standard Queue: $0.0006 ($0.6 per 1K). Normal priority, about 5 min on average, 45 min target.
  - Priority Queue: $0.0012 ($1.2 per 1K). Up to about 1 min.
  - Live Mode: $0.002 ($2 per 1K). Up to about 6 s.
  - `calculate_rectangles` and `load_async_ai_overview` each add one base price. Operators multiply by 5. Depth and `max_crawl_pages` multiply per 10 results.
- The minimum payment is $50. Pricing is pay-as-you-go. ([DF3])
- Registration gives a free $1 credit for testing. Creating multiple trial accounts violates the ToS. ([DF37])

**Google Ads search volume**

- task_post is `POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/task_post`. ([DF17])
  - Limits: 2000 calls/min, 100 tasks per POST, up to 1000 keywords per task.
  - You pay per task, whatever the keyword count. Historical data covers 4 years.
- Task fields: ([DF17])
  - `keywords`: required array, max 1000. Each keyword max 80 chars and 10 words; they are lowercased.
  - `location_name` / `location_code` / `location_coordinate`: optional; worldwide if omitted.
  - `language_name` / `language_code`: optional.
  - `search_partners`: bool, default false.
  - `date_from` / `date_to`: `yyyy-mm-dd`, default the last 12 months.
  - `include_adult_keywords`: bool.
  - `sort_by`: `relevance`, `search_volume`, `competition_index`, `low_top_of_page_bid` or `high_top_of_page_bid`.
  - `postback_url`, `pingback_url`, `tag` (max 255).
- Live is `POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live`, one task per call. Google Ads Live endpoints are limited to 12 requests per minute per account. ([DF18])
  - Result fields: `keyword`, `spell`, `location_code`, `language_code`, `search_partners`.
  - `competition` (HIGH/MEDIUM/LOW), `competition_index` (0-100), `search_volume`.
  - `low_top_of_page_bid`, `high_top_of_page_bid`, `cpc`.
  - `monthly_searches[{year,month,search_volume}]`.
- Retrieval: `GET .../google_ads/search_volume/task_get/$id` (free, within 30 days) and `GET .../google_ads/search_volume/tasks_ready` (20 calls/min, 1000 tasks, 3 days). ([DF19])
- Google Ads pricing: Standard Queue $0.06 per task (1-3 h turnaround); Live Mode $0.09 per task (up to about 7 s). Each task holds up to 1000 keywords. ([DF31])
- No Google Ads account is needed. DataForSEO uses the Google Ads API as its source, and you access it with DataForSEO credentials. ([DF36])

**Lookups, errors, limits, retention**

- Location and language lookups are free GETs. ([DF11])
  - Endpoints: `/v3/serp/google/locations` (optionally `/$country` with an ISO code such as `us`), `/v3/serp/google/languages`, `/v3/keywords_data/google_ads/locations[/$country]`, `/v3/keywords_data/google_ads/languages`.
  - Location results: `location_code`, `location_name`, `location_code_parent`, `country_iso_code`, `location_type`.
  - Language results: `language_name`, `language_code` (ISO 639-1).
- "DataForSEO API servers always return the 200 HTTP response code", except for 401 Unauthorized, 402 Payment Required, 404 Not Found and 500 Internal Server Error. Other errors appear in `status_code`/`status_message`, both at the top level and per task. ([DF13])
- Internal status codes: ([DF13])

  | Group | Codes |
  |---|---|
  | Success / pending | 20000 Ok; 20100 Task Created; 40601 Task Handed (received, not yet queued); 40602 Task In Queue |
  | Request errors | 40000 only one task at a time; 40006 no more than 100 tasks; 40501 Invalid Field; 40502 POST Data Is Empty; 40503 POST Data Is Invalid; 40505 old location data; 40506 Unknown Fields |
  | Account / billing / rate | 40100 not authorized; 40104 account verification required; 40200 Payment Required; 40201 account paused; 40202 rate limit exceeded (2000/min); 40203 cost limit exceeded; 40204 access denied (subscription); 40205/40206 duplicate task limit per hour/day; 40207 IP not whitelisted; 40209 too many simultaneous queries (limit 30); 40210 insufficient funds |
  | Task / result errors | 40101 Internal SE Server Error; 40102 No Search Results; 40103 task execution failed, resubmit; 40105 task deleted; 40106 partial results (missing pages not charged); 40400 Not Found; 40401 Task Not Found; 40402 Invalid Path; 40403 Results Expired (task older than a month) |
  | Server / upstream | 50000 Internal Error; 50100 Not Implemented; 50301 3rd party (e.g. Google Ads) unavailable; 50303 update in progress; 50401 live task timed out after 120 s |
- Endpoint responses include `X-RateLimit-Limit` (per-minute ceiling for the endpoint) and `X-RateLimit-Remaining`. ([DF2])
- Storage per the docs index: Standard results 30 days, Live not stored, HTML 7 days. A footnote adds that SERP API JSON results are kept 30 days for both Standard and Live. ([DF2])
- Help Center on storage: ([DF38])
  - Standard results are kept 30 days and can be fetched again.
  - Live results are not stored; you get them once.
  - Standard HTML SERP results are kept 7 days.
  - SERP data is captured when the task is set, not when it is collected.
- Responses can be requested as XML by appending `.xml`, or as HTML with `.html` where supported (e.g. `/v3/serp/google/organic/task_get/html/<id>.html`). The official clients use gzip (`Content-Encoding: gzip`). ([DF2])
- `GET https://api.dataforseo.com/v3/appendix/user_data` is free. Its result includes `login`, `timezone`, `rates`, `money{total, balance, limits, statistics}`, `price`, `backlinks_subscription_expiry_date` and `llm_mentions_subscription_expiry_date`. ([DF15])

**Other API families (not in scope by default)**

- **Backlinks API**: Live method only, 2000 calls/min, 30 simultaneous requests. ([DF23])
  - Live endpoints under `/v3/backlinks/`: `summary`, `history`, `backlinks`, `anchors`, `domain_pages`, `domain_pages_summary`, `referring_domains`, `referring_networks`, `competitors`, `domain_intersection`, `page_intersection`, `timeseries_summary`, `timeseries_new_lost_summary`.
  - Bulk live endpoints: `bulk_ranks`, `bulk_backlinks`, `bulk_spam_score`, `bulk_referring_domains`, `bulk_new_lost_backlinks`, `bulk_new_lost_referring_domains`, `bulk_pages_summary`.
  - Also `index` and `filters`.
  - Example: `https://api.dataforseo.com/v3/backlinks/summary/live`.
- **DataForSEO Labs API**: Live method only, 2000 calls/min, 30 simultaneous requests. ([DF24])
  - Under `/v3/dataforseo_labs/`: `google/*`, `amazon/*`, `apple/*`, `google_play` (app endpoints under `google/*`), plus `categories_list`, `filters`, `locations_and_languages` and `status`.
  - Example: `https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live`.
- **AI Optimization API**, under `/v3/ai_optimization/`. ([DF25])
  - **LLM Responses:** `chat_gpt`, `claude`, `gemini` and `perplexity` under `llm_responses`, each with task_post/tasks_ready/task_get/live/models. Perplexity has live/models only.
  - **LLM Scraper:** `chat_gpt` and `gemini` under `llm_scraper`.
  - **AI Keyword Data:** `ai_keyword_data/keywords_search_volume/live` and `locations_and_languages`. Live only.
  - **LLM Mentions:** `llm_mentions/*/live`, including `search_mentions`, `target_metrics`, `target_metrics_lite`, `multi_target_metrics`, `historical`, `timeseries_delta`, `timeseries_new_lost`, `top_mentioned_brands(_lite)`, `top_mentioned_brand_categories(_lite)`, `top_mentioned_domains(_lite)`, `top_mentioned_pages(_lite)`, plus `filters` and `locations_and_languages`. Live only.
- AI-related SERP endpoints: `/v3/serp/google/ai_mode/*` (task_post, tasks_ready, task_get/advanced, task_get/html, live/advanced, live/html, languages) and `/v3/serp/ai_summary`. ([DF2])
- July 1, 2026 price update: ([DF35])
  - Prices rose about 20% for Backlinks, Labs, Keywords Data (most endpoints), On-Page, Domain Analytics, Content Analysis and others. The SERP API is not listed.
  - The $100 monthly commitment for the Backlinks API and the LLM Mentions API was removed. Both are now pay-as-you-go.
- Backlinks pricing: $0.024 per request plus $0.000036 per row, up to 1000 rows per request ($0.06 for 1000 rows). ([DF32])
- Labs Google pricing: ([DF33])
  - Most endpoints: $0.012 per task plus $0.00012 per item.
  - Historical Rank: $0.12 per task plus $0.0012 per item.
  - Historical SERPs: $0.00012 per SERP.
  - `include_clickstream_data=true` doubles the cost.

### Implementation contract

**Transport**

- Hosts: production `https://api.dataforseo.com/v3`, sandbox `https://sandbox.dataforseo.com/v3`. Paths are the same on both. The sandbox is free, returns dummy data and **still needs Basic auth**.
- Send `Authorization: Basic ${base64(login + ':' + password)}` on every call. Use the API login and password from app.dataforseo.com/api-access, not the account password. Never put credentials in the URL.
- Send `Content-Type: application/json`. Accepting gzip is optional.
- POST bodies are always a JSON **array** of task objects, even for a single task.
  - Standard `task_post`: max 100 tasks. Extra tasks come back with per-task 40006.
  - `live/*`: exactly 1 task. More returns 40000.

**Response envelope**

```ts
interface DfsTask<R> {
  id: string; status_code: number; status_message: string; time: string; cost: number;
  result_count: number; path: string[]; data: Record<string, unknown>; result: R[] | null;
}
interface DfsEnvelope<R> {
  version?: string; status_code: number; status_message: string; time: string; cost: number;
  tasks_count: number; tasks_error: number; tasks: DfsTask<R>[];
}
```

**Error handling (errors arrive inside HTTP 200)**

1. **Check the HTTP status.**
   - 401: bad credentials. The body is still an envelope with `status_code` 40100 and `tasks: []`.
   - 402: payment. 404: bad endpoint. 500: server error.
   - Parse the JSON body whenever you can.
2. **Check the top-level `status_code`.** Anything other than 20000 fails the whole request. Map codes to typed errors:
   - 40100: auth
   - 40104: account not verified
   - 40200 / 40210: no funds
   - 40202: rate limit (back off)
   - 40203: cost limit
   - 40204: access denied / subscription
   - 40207: IP not whitelisted
   - 40209: more than 30 concurrent requests
   - 50xxx: retry with backoff
3. **Check each task's `status_code`.**
   - 20000: result ready. 20100: task created.
   - 40601 / 40602: pending; poll again later.
   - 40106: partial results. Keep the data; missing pages are not charged.
   - 40102: no search results. Treat as an empty result, not a failure.
   - 40401: task not found.
   - 40403: results expired (older than 30 days).
   - 40501 / 40503 / 40506: invalid payload. Do not retry.
   - 40101 / 40103: resubmit.
4. Use `tasks_error` for a quick count of failed tasks.

**Endpoints to implement (all under `/v3`)**

| Purpose | Method and path | Notes |
|---|---|---|
| SERP locations | GET `serp/google/locations` or `serp/google/locations/{iso}` | Free |
| SERP languages | GET `serp/google/languages` | Free |
| Standard SERP: post | POST `serp/google/organic/task_post` | Up to 100 tasks |
| Standard SERP: ready | GET `serp/google/organic/tasks_ready` | 20/min, up to 1000 ids, 3-day window. Gives `endpoint_regular`, `endpoint_advanced`, `endpoint_html` |
| Standard SERP: get | GET `serp/google/organic/task_get/regular/{id}` or `.../task_get/advanced/{id}` | Free re-fetch within 30 days |
| Live SERP | POST `serp/google/organic/live/regular` or `.../live/advanced` | `depth` ≤ 200 |
| Keyword volume, Standard | POST `keywords_data/google_ads/search_volume/task_post`; GET `.../tasks_ready`; GET `.../task_get/{id}` | |
| Keyword volume, Live | POST `keywords_data/google_ads/search_volume/live` | Enforce **12 req/min per account** client-side |
| Keywords Data lookups | GET `keywords_data/google_ads/locations[/{iso}]`, `keywords_data/google_ads/languages` | Free |
| Balance / spend | GET `appendix/user_data` | Free. Read `money.balance` for budget guards |

**SERP request fields**

- Required:
  - `keyword` (≤700 chars; encode `%` as `%25` and `+` as `%2B`; operators like `site:` cost ×5).
  - One of `location_code` (e.g. 2840), `location_name` or `location_coordinate`.
  - One of `language_code` (e.g. `'en'`) or `language_name`.
- Optional:
  - `depth`: default 10; max 700 Standard, 200 Live; billed per 10 results.
  - `device`: `'desktop'` or `'mobile'`.
  - `os`: windows/macos on desktop, android/ios on mobile.
  - `priority`: 1 or 2, task_post only.
  - `tag`: ≤255 chars, echoed in `data`.
  - `postback_url`: needs `postback_data` = `'regular'`, `'advanced'` or `'html'`. Results are POSTed gzip-compressed, with `$id`/`$tag` placeholders. Your server must respond within 10 s.
  - `pingback_url`: a GET notification with the same placeholders.
  - `se_domain`.
- Do not send `priority`, `postback_*` or `pingback_url` to Live endpoints. The Live docs don't list them, and unknown fields cause 40506.
- Keep the paid extras off by default: `calculate_rectangles`, `load_async_ai_overview`, `people_also_ask_click_depth`, `max_crawl_pages`.

**Keyword volume request fields**

- Request:
  - `keywords[]`: required, ≤1000 per task, each ≤80 chars and ≤10 words. They are lowercased.
  - Location: `location_code`, `location_name` or `location_coordinate`. Optional; worldwide if omitted.
  - Language: `language_code` or `language_name`.
  - `search_partners` (bool), `date_from`/`date_to` (`'yyyy-mm-dd'`), `include_adult_keywords` (bool), `sort_by`.
  - `tag`, `postback_url`, `pingback_url`.
- Result fields: `keyword`, `spell`, `location_code`, `language_code`, `search_partners`, `competition`, `competition_index`, `search_volume`, `low_top_of_page_bid`, `high_top_of_page_bid`, `cpc`, `monthly_searches[{year, month, search_volume}]`.
- No Google Ads account is needed.

**Rate and concurrency limits**

- 2000 calls/min in general (40202 when exceeded).
- At most 30 simultaneous requests (40209 when exceeded).
- `tasks_ready`: 20/min.
- Google Ads Live: 12/min.
- Read `X-RateLimit-Limit` and `X-RateLimit-Remaining` when present.

**Retention**

- Standard results can be fetched again for 30 days (40403 after that). HTML results: 7 days.
- Treat Live results as fetch-once and save them locally.
- SERP data is captured when the task is posted, not when it is collected.

**Cost model** (as of 2026-09-24; the `cost` fields hold the actual amounts)

- SERP Google Organic, per 10-result SERP: Standard $0.0006, Priority $0.0012, Live $0.002.
- Google Ads `search_volume`, per task of up to 1000 keywords: Standard $0.06, Live $0.09.
- Account: minimum top-up $50, and $1 free credit on signup.
- Budget checks: estimate the cost before sending, then reconcile against `envelope.cost`.

**Disabled by default (gate with a path-prefix allowlist)**

- Disable:
  - `backlinks/*`: Live only, $0.024 per request + $0.000036 per row. May still return 40204.
  - `dataforseo_labs/*`: Live only, $0.012 per task + $0.00012 per item.
  - `ai_optimization/*`: includes `llm_mentions/*`, `llm_responses` and `llm_scraper` (chat_gpt/claude/gemini/perplexity), and `ai_keyword_data/*`.
  - `serp/google/ai_mode/*` and `serp/ai_summary`.
- Suggested allowlist: `serp/google/organic/`, `serp/google/locations`, `serp/google/languages`, `keywords_data/google_ads/search_volume/`, `keywords_data/google_ads/locations`, `keywords_data/google_ads/languages`, `appendix/user_data`, `appendix/errors`.

**Testing**

- Point the adapter at the sandbox host.
- `serp/google/organic/task_get/advanced/00000000-0000-0000-0000-000000000000` returns fixtures that cover every SERP item type.

### Unverified / to recheck with credentials

- **task_get on an unfinished id.** Which code is returned, and with what HTTP status, is not documented. 40601 "Task Handed" and 40602 "Task In Queue" both exist; treat either as "pending, retry later".
- **Paid extras on Priority tasks.** The extra cost of `calculate_rectangles` and `load_async_ai_overview` on `priority=2` tasks is not stated. "Add one base price" implies $0.0012.
- **LLM Mentions pricing.** The static HTML shows "Price per request $0.1" and "Price per row $0.001", but the calculator total beside them is "$0.05". Confirm in the dashboard.
- **Live SERP storage.** Sources conflict: the docs index footnote says SERP JSON is kept 30 days for Standard and Live, but the Help Center says Live results are not stored. Assume Live results cannot be re-fetched.
- **40204 after the commitment removal.** The errors page still describes 40204 as "access to Backlinks API is limited by a minimal commitment", and `user_data` still has `*_subscription_expiry_date` fields. The 2026-07-01 update removed the $100/month commitment, but accounts may still get 40204.
- **Sandbox path for Keywords Data.** The sandbox appendix uses the legacy path `keywords_data/google/search_volume/...`, not `keywords_data/google_ads/search_volume/...`. The host-swap rule should apply to `google_ads` paths too, but no example shows it.
- **Example costs in the docs.** The JSON examples are stale compared with current pricing (0.0015 per task_post task, 0.003 per live SERP, 0.075 per Google Ads live call). Read the `cost` field instead of hard-coding.
- **`X-RateLimit-*` values.** Not observed. The unauthenticated 401 responses did not include these headers.
- **Top-level `version`.** It may not always be present; the observed 401 body had no `version` key.
- **SLA and free-tier limits.** The pricing overview gives no free-tier per-call limits and no SLA. Turnaround times are averages only (Standard about 5 min with a 45 min target, Priority about 1 min, Live about 6 s).
- **Google Ads data freshness.** Described only as: Google updates keyword data mid-month, and `/v3/keywords_data/google_ads/status` reports it. The status endpoint's fields (beyond `actual_data` being referenced) were not fetched.

---

## 7. Apify API v2 and the Reddit Scraper Actor

The Actor is `9sHOY9RzPYGjmTHo8` (`harshmaur/reddit-scraper`, "Reddit Scraper - Posts, Comments, Search & Subreddits"). It was checked on 2026-09-24 against the live default build `BJc4n5WSuKuvJyzQo` (0.0.513).

Tags in this section: **LIVE** = observed in an unauthenticated api.apify.com response. **DOCS** = official Apify docs or `docs.apify.com/api/openapi.json`. **LISTING** = the apify.com store page.

### Sources

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| AP1 | https://api.apify.com/v2/acts/9sHOY9RzPYGjmTHo8 | 2026-09-24 | yes | LIVE unauthenticated curl GET: 200, full Actor object (7 `pricingInfos` records). `x-ratelimit-limit: 60` |
| AP2 | https://api.apify.com/v2/actors/9sHOY9RzPYGjmTHo8 | 2026-09-24 | yes | LIVE. Canonical prefix; same 200 body (14612 bytes) as AP1 |
| AP3 | https://api.apify.com/v2/acts/9sHOY9RzPYGjmTHo8/builds/default | 2026-09-24 | yes | LIVE unauthenticated 200. Default build, with `inputSchema`, `readme`, `actorDefinition` |
| AP4 | https://api.apify.com/v2/acts/harshmaur~reddit-scraper/builds/default | 2026-09-24 | yes | LIVE unauthenticated 200 using the tilde name; same body |
| AP5 | https://api.apify.com/v2/actor-builds/BJc4n5WSuKuvJyzQo | 2026-09-24 | yes | LIVE unauthenticated 200. Build 0.0.513, SUCCEEDED, 43 input properties, 161 dataset fields |
| AP6 | https://api.apify.com/v2/actor-builds/BJc4n5WSuKuvJyzQo/openapi.json | 2026-09-24 | yes | LIVE unauthenticated 200. OpenAPI 3.0.1 |
| AP7 | https://api.apify.com/v2/acts/9sHOY9RzPYGjmTHo8/runs | 2026-09-24 | yes | LIVE unauthenticated GET: 401 `token-not-provided` |
| AP8 | https://docs.apify.com/api/openapi.json | 2026-09-24 | yes | DOCS. Official API spec (`info.version` `v2-2026-09-24T114302Z`) |
| AP9 | https://docs.apify.com/api/v2/actor-get | 2026-09-24 | yes | DOCS (WebFetch summary) |
| AP10 | https://docs.apify.com/api/v2/actors-runs-post | 2026-09-24 | yes | DOCS (WebFetch plus the raw `.md`) |
| AP11 | https://docs.apify.com/api/v2 | 2026-09-24 | yes | DOCS (WebFetch summary) |
| AP12 | https://docs.apify.com/api/v2/dataset-items-get | 2026-09-24 | yes | DOCS (WebFetch summary) |
| AP13 | https://docs.apify.com/platform/actors/running/runs-and-builds | 2026-09-24 | yes | DOCS (WebFetch summary) |
| AP14 | https://apify.com/harshmaur/reddit-scraper | 2026-09-24 | yes | LISTING (WebFetch plus raw HTML) |
| AP15 | https://apify.com/harshmaur/reddit-scraper/input-schema | 2026-09-24 | yes | LISTING. The WebFetch summary gave wrong defaults. The raw embedded JSON is authoritative |
| AP16 | https://docs.apify.com/api/v2/actor-run-get | 2026-09-24 | yes | Only HTTP 200 confirmed; page not read. Facts taken from AP8 |
| AP17 | https://docs.apify.com/api/v2/actors-runs-get | 2026-09-24 | yes | Only HTTP 200 confirmed; page not read. Facts taken from AP8 |
| AP18 | https://docs.apify.com/api/v2/actor-build-default-get | 2026-09-24 | yes | Only HTTP 200 confirmed; page not read. Facts taken from AP8 |
| AP19 | https://docs.apify.com/api/v2/actor-build-openapi-json-get | 2026-09-24 | yes | Only HTTP 200 confirmed; page not read. Facts taken from AP8 |
| AP20 | https://docs.apify.com/platform/integrations/webhooks/ad-hoc-webhooks | 2026-09-24 | yes | Only HTTP 200 confirmed; page not read. Webhook shape taken from AP8 |
| AP21 | https://docs.apify.com/api/v2/actors-run-sync-get-dataset-items-post | 2026-09-24 | **no** | Guessed URL returned 404. Sync endpoint facts taken from AP8 |

[AP1]: https://api.apify.com/v2/acts/9sHOY9RzPYGjmTHo8
[AP5]: https://api.apify.com/v2/actor-builds/BJc4n5WSuKuvJyzQo
[AP6]: https://api.apify.com/v2/actor-builds/BJc4n5WSuKuvJyzQo/openapi.json
[AP7]: https://api.apify.com/v2/acts/9sHOY9RzPYGjmTHo8/runs
[AP8]: https://docs.apify.com/api/openapi.json
[AP12]: https://docs.apify.com/api/v2/dataset-items-get
[AP13]: https://docs.apify.com/platform/actors/running/runs-and-builds
[AP14]: https://apify.com/harshmaur/reddit-scraper
[AP15]: https://apify.com/harshmaur/reddit-scraper/input-schema

### Verified behavior

**Actor object (LIVE)**

- `GET https://api.apify.com/v2/acts/9sHOY9RzPYGjmTHo8` returned 200 with no token. ([AP1])
  - Identity: `id` `9sHOY9RzPYGjmTHo8`, `userId` `maRACyummjDfTFF7e`, `username` `harshmaur`, `name` `reddit-scraper`, `title` "Reddit Scraper - Posts, Comments, Search & Subreddits".
  - Flags: `isPublic` true, `isDeprecated` false, `notice` `NONE`, `actorPermissionLevel` `LIMITED_PERMISSIONS`, `isSourceCodeHidden` true, `hasNoDataset` false, `standbyUrl` null.
  - `categories`: `SOCIAL_MEDIA`, `LEAD_GENERATION`, `AI`. `modifiedAt` `2026-09-24T07:29:32.130Z`.
- Builds and versions: ([AP1])
  - `taggedBuilds.latest` = `{buildId:'BJc4n5WSuKuvJyzQo', finishedAt:'2026-09-24T07:29:32.130Z', buildNumberInt:513, buildNumber:'0.0.513'}`.
  - `versions` = `[{versionNumber:'0.0', sourceType:'GIT_REPO', buildTag:'latest'}]`.
  - `stats.totalBuilds` = 513.
- `defaultRunOptions` = `{build:'latest', timeoutSecs:12780, memoryMbytes:512, maxItems:null, maxTotalChargeUsd:0}`. ([AP1])
- Usage stats: ([AP1])
  - `totalRuns` 847182, `totalUsers` 14155, `totalUsers30Days` 3746.
  - `actorReviewCount` 17, `actorReviewRating` ≈4.949, `bookmarkCount` 66.
  - `publicActorRunStats30Days` = `{ABORTED:1139, FAILED:1291, SUCCEEDED:160872, 'TIMED-OUT':360, TOTAL:163662}`.
- `exampleRunInput` is a placeholder (`{"helloWorld": 123}`). Don't use it as an input example. ([AP1])
- Pricing: ([AP1])
  - `pricingInfos` holds 7 historical records, all `PAY_PER_EVENT`.
  - The latest record starts `2026-08-10T14:51:28.574Z`, with `apifyMarginPercentage` 0.2 and `minimalMaxTotalChargeUsd` null.
  - It defines 4 events:

    | Event key | Title | Price (USD) | Notes |
    |---|---|---|---|
    | `init` | "Actor Start" | 0.02 | One-time. Description: "Cost on starting actor per GB of memory" |
    | `result` | "Result Saved" | FREE 0.002, BRONZE 0.0018, SILVER 0.0016, GOLD/PLATINUM/DIAMOND 0.0015 | Primary event. Charged when a post or comment is saved to the dataset |
    | `analyzed_item` | "AI analyzed result" | 0.0005 | Only with AI analysis on, only for results successfully analyzed, once per result even if both analysis options are on. Bot/moderator boilerplate is never charged |
    | `custom_label` | "AI custom label evaluation" | 0.0001 | Once per custom label per analyzed result (3 labels × 1,000 results = 3,000 evaluations) |
- LISTING pricing text: ([AP14])
  - "From $2 per 1,000 results", or "From $1.50 per 1,000 results on eligible plans ($2.00 without plan discounts)".
  - "Actor start: $0.02 per run". "Result stored: $0.002 each".
  - Example: a run that stores 1,000 items costs $0.02 + $2.00 = $2.02. You pay for items stored, not for the `maxPostsCount` you set.
- The MCP server URL is `https://mcp.apify.com/?tools=harshmaur/reddit-scraper`. The README's n8n example uses `POST https://api.apify.com/v2/acts/harshmaur~reddit-scraper/run-sync-get-dataset-items?token=...` and warns about the 300-second sync timeout. ([AP14])

**Default build (LIVE)**

- Build `BJc4n5WSuKuvJyzQo`: status `SUCCEEDED`, `buildNumber` `0.0.513`, `gitBranchName` `main`, `startedAt` `2026-09-24T07:29:14.388Z`. ([AP5])
  - These all returned 200 without a token: `GET /v2/acts/9sHOY9RzPYGjmTHo8/builds/default`, `GET /v2/acts/harshmaur~reddit-scraper/builds/default` and `GET /v2/actor-builds/BJc4n5WSuKuvJyzQo`.
  - `data.inputSchema` is a JSON **string**, so it must be `JSON.parse`d.
- `actorDefinition` memory: `minMemoryMbytes` 256, `maxMemoryMbytes` 2048. ([AP5])
  - `defaultMemoryMbytes` is the expression `get(input, 'startUrls.length', 0) > 0 ? (get(input, 'fastMode', true) ? 512 : 2048) : 512`.
  - So memory is 2048 MB only when `startUrls` is non-empty and `fastMode` is false. Otherwise it is 512 MB.
- `actorDefinition.output` has 3 entries. The dataset has one view, `overview` (title "Results"). ([AP5])
  - `results` = `{{links.apiDefaultDatasetUrl}}/items?view=overview`.
  - `runSummaryMap` = `{{links.apiDefaultKeyValueStoreUrl}}/records/RUN-MAP.html`.
  - `runSummaryJson` = `{{links.apiDefaultKeyValueStoreUrl}}/records/RUN-SUMMARY`.
- `GET /v2/actor-builds/BJc4n5WSuKuvJyzQo/openapi.json` returned 200 without a token. ([AP6])
  - OpenAPI 3.0.1, servers `[{url:'https://api.apify.com/v2'}]`.
  - Operations: `POST /acts/harshmaur~reddit-scraper/run-sync-get-dataset-items`, `.../runs` and `.../run-sync`.
  - Each operation declares a required `token` query param.
  - The request body references `components.schemas.inputSchema`. The runs response references `runsResponseSchema`.
- `inputSchema`: title "Input schema for Reddit Scraper Pro", type object, `schemaVersion` 1, **no** `required` array, 43 properties. ([AP5])
  - There is no proxy field (no `proxyConfiguration`). The README says "IP rotation is handled inside the actor, so none of the examples need a proxy field."
  - There is no webhook input field.
- Search keyword inputs: ([AP5])
  - `searchTerms`: stringList, default `[]`. Free Apify plans search only the first 40 keywords per run; paid plans have no limit.
  - `searchPosts` (default true), `searchComments` (default false), `searchCommunities` (default false).
  - `withinCommunity`: default `''`. Accepts `developers`, `r/developers` or a full subreddit URL.
  - `searchSort`: `''`, `relevance`, `hot`, `top`, `new` or `comments`; default `new`.
  - `searchTime`: `all`, `hour`, `day`, `week`, `month` or `year`; default `all`.
  - Sort, time and community apply only to `searchTerms`, not to `startUrls`.
- URL inputs: ([AP5])
  - `startUrls`: `{url}[]`, default `[]`. Accepts post, comment permalink, user profile, subreddit and search-page URLs.
  - `fastMode`: default true. Applies only to search-page `startUrls`; turning it off needs 2048 MB.
  - `subredditUrls`: stringList, default `[]`. Takes subreddit names or community links for a deep "Full Subreddit Scrape". Post links placed here are skipped.
- Filters: ([AP5])
  - `postedAfter`, `postedBefore`, `commentedAfter`, `commentedBefore`: YYYY-MM-DD in UTC, no default. `postedBefore` runs through 23:59:59 UTC.
  - Setting `postedAfter` makes results come newest-first and ignores `searchTime`.
  - `onlyWithFlair`: default false.
- Options and limits: ([AP5])
  - `crawlCommentsPerPost`: default false.
  - `includeNSFW`: default false.
  - `maxPostsCount`: default 50, min 0, max 50000. Titled "Max posts (total across all inputs)".
  - `maxCommentsCount`: default 400, min 0. The per-keyword cap for comment search only.
  - `maxCommentsPerPost`: default 200, min 0.
  - `maxCommunitiesCount`: default 2, min 0.
- The listing input-schema page embeds defaultBuild `BJc4n5WSuKuvJyzQo` (buildNumberInt 513). Its JSON confirms `maxPostsCount` 50 (max 50000), `maxCommentsCount` 400, `maxCommentsPerPost` 200, and the `searchSort` enum with default `new`. This matches the API. ([AP15])
- AI add-ons: ([AP5])
  - `aiAnalysis` (default false) adds `sentimentLabel`, `sentimentScore`, `intent`, `emotion`, `entities`, `relevanceScore` (search results only) and `contentCategory` (posts only). It is billed as `analyzed_item`.
  - Flag inputs, all boolean and default false: `wantsHelp`, `isOwner`, `isVendor`, `hasPain`, `mentionsPrice`, `featureRequest`, `willingToPay`, `painPoint`, `competitor`. Each ticked flag adds `aiFlags.<name>` and is billed as one `custom_label` per result. Ticking any flag also turns on `aiAnalysis`.
  - `customLabels`: object, default `{}`, up to 5 entries of `{label_name: instruction}`.
  - All AI add-ons need a paid Apify plan. On free plans they are ignored and not charged.
- MCP delivery inputs: ([AP5])
  - `mcpConnector` (resourceType `mcpConnector`), `mcpTarget`, `mcpTool`, `mcpArguments` (object), `mcpServerUrl`.
  - `mcpServerToken`: secret (`isSecret`).
  - `mcpMode`: `perPost` or `summary`; default `perPost`.
  - `mcpComments`: `ignore`, `bundle` or `separate`; default `ignore`.
  - `mcpCommentsPerPost`: 1-50, default 5.
  - `mcpMessage`: default `**{{title}}**\n{{postUrl}}`.
  - `mcpMaxItems`: 1-1000, default 50.
- Dataset schema: 161 nullable properties, with discriminator `dataType` = `post`, `comment`, `community` or `user_profile`. ([AP5])
  - **Posts:** `id` (a `t3_` fullname), `parsedId`, `postUrl`, `title`, `body`, `bodyHtml`, `authorName`, `communityName` (with `r/` prefix), `parsedCommunityName`, `upVotes`, `score`, `upvoteRatio`, `commentsCount`, `createdAt`, `crawledAt`, `searchTerm`, `flair`, `contentUrl`, `domain`, `over18`, `postType`, `mediaType`, `ageHours`, `scorePerHour`, `commentsPerHour`, `engagementTotal`, `isHighEngagement`.
  - **Comments:** `id` (bare, no `t1_`), `url`, `postId`, `parsedPostId`, `parentId`, `parentKind`, `depth`, `commentUpVotes`, `commentCreatedAt`, `subredditName` (no prefix).
  - **Communities:** include `name` and `membersCount`.
  - **AI fields:** `sentimentLabel`, `sentimentScore`, `intent`, `emotion`, `entities`, `relevanceScore`, `contentCategory`, `customLabels`, `aiFlags`.
- The README's output contract: ([AP5])
  - A run can mix item shapes, so split on `dataType`, and deduplicate on `dataType` + `id`.
  - Every timestamp is an ISO-8601 UTC string.
  - Fields marked "only present…" (e.g. `searchTerm`) are absent, not null.
  - Field counts: post 75, comment 41, community 38, user_profile 29.
- The README describes the `RUN-SUMMARY` key-value store record at `/v2/key-value-stores/{runDefaultKeyValueStoreId}/records/RUN-SUMMARY`. ([AP5])
  - Fields: `generatedAt`, `runtimeSeconds`, `itemsTotal`, `items[{type, label, count}]`, `requested{searchTerms, startUrls, subreddits}`, `skippedTotal`, `skipped[{reason, label, count}]`, `requests{finished, failed, retries}`, `inputWarnings[]`, `emptyReason`.
  - Skip reasons: `date_window_unreached`, `banned`, `not_found`, `private`, `suspended`, `mcp_failed`. Skipped targets are not charged.
  - A run with no usable target finishes `SUCCEEDED` with zero items and no result charge.
- Reddit serves at most about 1,000 items per listing or search, so the `max*` inputs are ceilings, not guarantees. Setting one to 0 turns that item type off. The README also says "maxPostsCount: 10 stores at most 10 posts (per searchTerms keyword)", which conflicts with the input title "Max posts (total across all inputs)". ([AP5])

**Apify platform API (DOCS unless marked)**

- The canonical Actor prefix is `/v2/actors/`. "The /v2/acts/ prefix is deprecated but still fully functional, and such endpoint routes to the same handler as its /v2/actors/... counterpart." The servers URL is `https://api.apify.com`. ([AP8])
- Auth: ([AP8])
  - Two schemes: `httpBearer` (`Authorization: Bearer <token>`, recommended) and `apiKey` (query param `token`, less secure).
  - Auth is required for private resources and for named IDs (`username~name`).
  - It is optional for public Actors and resources, such as builds of public Actors.
- Run Actor is `POST /v2/actors/{actorId}/runs` (operationId `actors_runs_post`). ([AP8])
  - The body is the Actor INPUT. Its Content-Type is passed through (usually `application/json`).
  - Query params:
    - `timeout` (seconds), `memory` (MB, a power of 2, min 128)
    - `maxItems`, `maxTotalChargeUsd`
    - `restartOnError` (boolean)
    - `build` (a tag or build number)
    - `waitForFinish` (default 0, max 60)
    - `webhooks` (a Base64-encoded JSON array of WebhookRepresentation)
    - `forcePermissionLevel` (`LIMITED_PERMISSIONS` or `FULL_PERMISSIONS`)
  - Returns 201 with a `Location` header and body `{data: Run}`.
- `maxItems` "Only works for pay-per-result Actors"; it caps charged dataset items, not output. `maxTotalChargeUsd` caps "the total amount charged for all pricing models". This Actor is PAY_PER_EVENT, so `maxTotalChargeUsd` is the cap that matters. ([AP8])
- `Run` schema: ([AP8])
  - **Required:** `id`, `actId`, `userId`, `startedAt`, `status`, `meta`, `stats`, `options`, `buildId`, `defaultKeyValueStoreId`, `defaultDatasetId`, `defaultRequestQueueId`.
  - **Other fields:**
    - Run info: `actorTaskId`, `finishedAt`, `statusMessage`, `isStatusMessageTerminal`, `exitCode`, `buildNumber`, `gitBranchName`, `metamorphs`.
    - Billing: `pricingInfo`, `chargedEventCounts` (event name → integer), `usage`, `usageTotalUsd` (number or null), `usageUsd`, `platformUsageBillingModel`.
    - Access, storage, container: `generalAccess`, `storageIds`, `containerUrl`, `isContainerServerReady`.
- Run sub-objects: ([AP8])
  - `RunOptions`: `build`, `timeoutSecs`, `memoryMbytes`, `diskMbytes`, `maxItems` (integer or null), `maxTotalChargeUsd` (number or null).
  - `RunStats`: includes `inputBodyLen`, `restartCount`, `resurrectCount`, `memAvgBytes`, `memMaxBytes`, `cpuAvgUsage`, `netRxBytes`, `netTxBytes`, `durationMillis`, `runTimeSecs`, `computeUnits`.
  - `RunMeta`: `origin` (DEVELOPMENT, WEB, API, SCHEDULER, TEST, WEBHOOK, ACTOR, CLI, CI, STANDBY or MCP), `clientIp`, `userAgent`, `scheduleId`, `scheduledAt`.
- `ActorJobStatus` values by lifecycle stage: ([AP13])
  - Initial: `READY`.
  - Transitional: `RUNNING`, `TIMING-OUT`, `ABORTING`.
  - Terminal: `SUCCEEDED`, `FAILED`, `TIMED-OUT`, `ABORTED`.
- Apify keeps your ten most recent runs indefinitely. Older runs and their default storages (key-value store, dataset, request queue) are deleted after your plan's retention period. ([AP13])
- Get run is `GET /v2/actor-runs/{runId}?waitForFinish=<0..60>` and returns `{data: Run}`. ([AP8])
  - No token is needed, because the hard-to-guess run ID acts as authentication. Without a token, `usageUsd` and `usageTotalUsd` are hidden.
  - The first response after completion can still show preliminary stats, costs and event counts. For stable figures, wait about 10 seconds and call again.
- `chargedEventCounts` is "A map of charged event types to their counts", keyed by the Actor's pay-per-event event ids. For run non-owners, `usageTotalUsd` is "only available for Pay-Per-Event Actors (event costs only). Requires authentication token to access." ([AP8])
- List runs is `GET /v2/actors/{actorId}/runs`. ([AP8])
  - Params: `offset` (default 0); `limit` (default and max 1000); `desc` (sorts by `startedAt`, ascending by default); `status` (one value or comma-separated); `startedAfter` / `startedBefore` (ISO 8601 UTC, inclusive).
  - Response: `{data: {total, offset, limit, desc, count, items: RunShort[]}}`, plus `X-Apify-Pagination-Offset/Limit/Count/Total/Desc` headers.
  - `RunShort` fields: `id`, `actId`, `userId`, `actorTaskId`, `status`, `startedAt`, `finishedAt`, `buildId`, `buildNumber`, `buildNumberInt`, `meta`, `usageTotalUsd`, `defaultKeyValueStoreId`, `defaultDatasetId`, `defaultRequestQueueId`.
- **LIVE:** `GET https://api.apify.com/v2/acts/9sHOY9RzPYGjmTHo8/runs` without a token returned 401 `{"error":{"type":"token-not-provided","message":"Authentication token was not provided"}}`. ([AP7])
- Dataset items is `GET /v2/datasets/{datasetId}/items`. The body is the raw item array, with no `{data}` wrapper. ([AP8])
  - Main params: `format` (json/jsonl/csv/html/xlsx/xml/rss, default json); `clean` (shortcut for `skipHidden=true` + `skipEmpty=true`); `offset` (default 0); `limit` (no limit by default); `desc`; `view`.
  - Field selection: `fields`, `outputFields`, `omit`, `unwind`, `flatten`, `simplified`, `skipHidden`, `skipEmpty`, `skipFailedPages`.
  - Format options: `attachment`, `delimiter`, `bom`, `xmlRoot`, `xmlRow`, `skipHeaderRow`, `feedTitle`, `feedDescription`, `signature`.
  - Pagination headers: `X-Apify-Pagination-Offset`, `-Limit`, `-Count`, `-Total`, `-Desc`.
  - "No limit exists to how many items can be returned in one response."
- With `clean` or `skipEmpty`, a page can hold fewer items than `limit`. CSV, XLSX and HTML output is limited to 2000 columns. ([AP12])
- Sync run is `POST /v2/actors/{actorId}/run-sync-get-dataset-items`. It takes the run params (`timeout`, `memory`, `maxItems`, `maxTotalChargeUsd`, `restartOnError`, `build`, `webhooks`) plus all dataset-items params. A run longer than 300 seconds returns 408 `run-timeout-exceeded`. ([AP8])
- Errors are `{error: {type, message}}`. Documented examples: ([AP8])
  - 400 `invalid-input`, 401 `invalid-token`, 402 `x402-payment-required`, 403 `insufficient-permissions`, 404 `record-not-found`, 405 `method-not-allowed`.
  - 408 `run-timeout-exceeded`, 413 `request-too-large` (example limit 9437184 bytes), 415 `unsupported-content-encoding`, 429 `rate-limit-exceeded`.
- Rate limits: ([AP8])
  - Global: 250,000 requests per minute, per user when authenticated and per IP otherwise.
  - Per resource: 60 requests/second by default; 400/s for Run Actor and push items; 200/s for key-value store record CRUD.
  - Every endpoint returns its limit in `X-RateLimit-Limit`. On 429, use exponential backoff and double the delay on each retry.
- Each paginated endpoint enforces a maximum `limit`, which "could change in future so you should never rely on a specific value". Items come in insertion order by default; `desc=1` reverses it. ([AP8])
- `WebhookRepresentation`, used by the `webhooks` param: ([AP8])
  - Required: `eventTypes`, `requestUrl`.
  - Optional: `payloadTemplate`, `headersTemplate`, `shouldInterpolateStrings`, `idempotencyKey`, `ignoreSslErrors`, `doNotRetry`.
  - Event types include `ACTOR.RUN.CREATED`, `ACTOR.RUN.SUCCEEDED`, `ACTOR.RUN.FAILED`, `ACTOR.RUN.ABORTED`, `ACTOR.RUN.TIMED_OUT`, `ACTOR.RUN.RESURRECTED` and `TEST`.
  - Webhook events use an underscore (`TIMED_OUT`), while run status uses a hyphen (`TIMED-OUT`).
- Pricing schemas: ([AP8])
  - `ActorChargeEvent` has `eventTitle`, `eventDescription`, `eventPriceUsd`, `eventTieredPricingUsd`, `isPrimaryEvent` and `isOneTimeEvent`. `eventPriceUsd` (flat) and `eventTieredPricingUsd` are mutually exclusive.
  - `TieredPricingPerEvent` is keyed by tier (FREE, BRONZE, SILVER, GOLD, PLATINUM, DIAMOND) with `{tieredEventPriceUsd}` values. "The actual price applied is resolved from the user's tier".
  - `CommonActorPricingInfo.startedAt` means "Since when is this pricing info record effective".
- Builds: `GET /v2/actors/{actorId}/builds/default`, `GET /v2/actor-builds/{buildId}` and `GET /v2/actor-builds/{buildId}/openapi.json` need no token (without one, `usageUsd`/`usageTotalUsd` are hidden). The Build schema includes `inputSchema` (string or null), `readme`, `actorDefinition`, `buildNumber` and `status`. ([AP8])
- `POST /v2/actors/{actorId}/validate-input` checks a payload against the build's input schema. It returns 200 `{valid: true}` if valid and 400 if not. ([AP8])

### Implementation contract

**Summary**

- The Actor is **PAY_PER_EVENT**. The `maxItems` run param does not affect its cost, so:
  - Always cap spend with `maxTotalChargeUsd`.
  - Always set the input caps (`maxPostsCount` and the other `max*` fields).
- The live build was published on 2026-09-24 and is the 513th build. For reproducible behavior, pin `build=0.0.513`, or check the input schema at startup.

**Config**

- `APIFY_BASE = "https://api.apify.com"`.
- `ACTOR_ID = "9sHOY9RzPYGjmTHo8"`. `harshmaur~reddit-scraper` also works, but named IDs require auth.
- Use the canonical `/v2/actors/...` prefix. `/v2/acts/...` is deprecated but still routes to the same handler.
- Send `Authorization: Bearer ${APIFY_TOKEN}` on every call. Never use `?token=`, because it ends up in logs. Send `Content-Type: application/json` on POST.

**1. Start a run (async)**

`POST /v2/actors/9sHOY9RzPYGjmTHo8/runs?maxTotalChargeUsd=<usd>&timeout=<secs>&memory=512&waitForFinish=0`

- The body is the Actor input JSON (see below).
- The response is `201 { data: Run }`. Read `id`, `status`, `defaultDatasetId`, `defaultKeyValueStoreId`, `buildNumber` and `options{build,timeoutSecs,memoryMbytes,diskMbytes,maxItems,maxTotalChargeUsd}`.
- Optional query params:
  - `build`: `latest` or a number like `0.0.513`.
  - `restartOnError`.
  - `waitForFinish`: 0-60.
  - `webhooks`: base64 of `[{eventTypes:["ACTOR.RUN.SUCCEEDED","ACTOR.RUN.FAILED","ACTOR.RUN.TIMED_OUT","ACTOR.RUN.ABORTED"], requestUrl, payloadTemplate?, headersTemplate?, idempotencyKey?, ignoreSslErrors?, doNotRetry?}]`.
- Defaults when params are omitted (LIVE): `timeoutSecs` 12780, `memoryMbytes` 512 (the Actor allows 256-2048), `build` `latest`. It needs 2048 MB only when `startUrls` contains search pages and `fastMode` is false.
- Cost estimate at current LIVE pricing (FREE tier):
  - Formula: `0.02 + 0.002*N (+0.0005*N if AI) (+0.0001*N*labels)`.
  - `init` $0.02 is charged once per run. The "per GB of memory" wording is unverified.
  - `result` is $0.002, or the tiered price on paid tiers.
  - Set `maxTotalChargeUsd` a little above your budget.
  - AI add-ons are silently ignored on free Apify plans.

**2. Poll**

`GET /v2/actor-runs/{runId}?waitForFinish=60` returns `{data: Run}`. Loop until the status is terminal.

```ts
type RunStatus = 'READY'|'RUNNING'|'SUCCEEDED'|'FAILED'|'TIMING-OUT'|'TIMED-OUT'|'ABORTING'|'ABORTED'
```

- Terminal: `SUCCEEDED`, `FAILED`, `TIMED-OUT`, `ABORTED`.
- After a terminal status, wait about 10 s and GET again to get stable `usageTotalUsd`, `chargedEventCounts` and `stats`.
  - `chargedEventCounts` is a `Record<string, number>`. Expected keys are `init`, `result`, `analyzed_item` and `custom_label`.
  - `usageTotalUsd` and `usageUsd` are hidden unless you send the token.

**3. Fetch results**

`GET /v2/datasets/{defaultDatasetId}/items?format=json&clean=1&offset=<o>&limit=<l>[&fields=a,b,c][&desc=1]`

- The body is a bare JSON array.
- Paginate with the `X-Apify-Pagination-Total/-Offset/-Limit/-Count/-Desc` headers, which are exposed via CORS. Loop until `offset >= total`, e.g. with `limit=1000`.
- With `clean`, a page can be shorter than `limit`, so advance `offset` by `limit`, not by `count`.
- Don't use `view=overview` when you need every field. The view shows only a subset.

**4. Run diagnostics (optional)**

`GET /v2/key-value-stores/{defaultKeyValueStoreId}/records/RUN-SUMMARY`

- Shape: `{generatedAt, runtimeSeconds, itemsTotal, items[{type,label,count}], requested{searchTerms,startUrls,subreddits}, skippedTotal, skipped[{reason,label,count}], requests{finished,failed,retries}, inputWarnings[], emptyReason}`.
- Pass unknown skip reasons through as-is.

**5. List past runs (token required)**

`GET /v2/actors/9sHOY9RzPYGjmTHo8/runs?desc=1&limit=<≤1000>&offset=0&status=SUCCEEDED[,FAILED]&startedAfter=<ISO>&startedBefore=<ISO>`

Returns `{data:{total,offset,limit,desc,count,items: RunShort[]}}`.

**6. Sync shortcut (small jobs only)**

`POST /v2/actors/{id}/run-sync-get-dataset-items?maxTotalChargeUsd=..&format=json&clean=1` returns the items array directly. Runs longer than 300 s return `408 run-timeout-exceeded`, so prefer the async flow.

**7. Schema drift check (no token needed)**

- `GET /v2/actors/9sHOY9RzPYGjmTHo8`:
  - `data.pricingInfos` is a history array. Use the entry with the latest `startedAt` that is ≤ now.
  - `data.taggedBuilds.latest.{buildId,buildNumber,buildNumberInt}`.
- `GET /v2/actors/9sHOY9RzPYGjmTHo8/builds/default`:
  - `JSON.parse(data.inputSchema)`.
  - `data.actorDefinition.storages.dataset.fields.properties` lists the 161 output fields.
- `POST /v2/actors/{id}/validate-input` returns `200 {valid:true}` or `400`.

**Errors and retries**

- The error shape is `{error:{type,message}}`.
- Retry `429 rate-limit-exceeded` and 5xx with exponential backoff: wait a random D to 2D ms, then double D.
- Do not retry: 400 `invalid-input`, 401 `invalid-token`/`token-not-provided`, 402 `x402-payment-required`, 403 `insufficient-permissions`, 404 `record-not-found`, 413 `request-too-large`.
- The per-resource limit is 60 req/s by default. `X-RateLimit-Limit` was 60 on GET actor.
- When retrying a run POST that registers webhooks, set `idempotencyKey` on the webhooks.

**Input type** (all 43 fields optional; there is no `required` array)

```ts
interface RedditScraperInput {
  // Search keywords
  searchTerms?: string[];            // default []; free plans: first 40 keywords only
  searchPosts?: boolean;             // true
  searchComments?: boolean;          // false
  searchCommunities?: boolean;       // false
  withinCommunity?: string;          // '' ; 'name' | 'r/name' | full URL
  searchSort?: ''|'relevance'|'hot'|'top'|'new'|'comments'; // 'new'
  searchTime?: 'all'|'hour'|'day'|'week'|'month'|'year';    // 'all'
  // Direct URLs
  startUrls?: {url: string}[];       // default []; post/comment/profile/subreddit/search URLs
  fastMode?: boolean;                // true (search-page startUrls only; false needs 2048MB)
  // Full subreddit scrape
  subredditUrls?: string[];          // default []; names or community links
  // Filters (YYYY-MM-DD, UTC)
  postedAfter?: string;              // forces newest-first and ignores searchTime
  postedBefore?: string;             // inclusive through 23:59:59 UTC
  commentedAfter?: string;
  commentedBefore?: string;
  onlyWithFlair?: boolean;           // false
  // Options & limits
  crawlCommentsPerPost?: boolean;    // false
  includeNSFW?: boolean;             // false
  maxPostsCount?: number;            // 50, min 0, max 50000 (global vs per-keyword is ambiguous)
  maxCommentsCount?: number;         // 400, min 0 (per keyword, comment search only)
  maxCommentsPerPost?: number;       // 200, min 0
  maxCommunitiesCount?: number;      // 2, min 0
  // AI add-ons (paid plans only)
  aiAnalysis?: boolean;              // false
  wantsHelp?: boolean; isOwner?: boolean; isVendor?: boolean; hasPain?: boolean;
  mentionsPrice?: boolean; featureRequest?: boolean; willingToPay?: boolean;
  painPoint?: boolean; competitor?: boolean;  // all default false
  customLabels?: Record<string,string>;      // default {}, up to 5
  // MCP delivery (optional; leave unset for scrape-only)
  mcpConnector?: string;
  mcpMode?: 'perPost'|'summary';             // 'perPost'
  mcpTarget?: string;
  mcpComments?: 'ignore'|'bundle'|'separate'; // 'ignore'
  mcpCommentsPerPost?: number;               // 5 (1..50)
  mcpMessage?: string;                       // '**{{title}}**\n{{postUrl}}'
  mcpTool?: string;
  mcpArguments?: Record<string,unknown>;
  mcpMaxItems?: number;                      // 50 (1..1000)
  mcpServerUrl?: string;
  mcpServerToken?: string;                   // secret
}
```

- The input has no proxy field and no webhook field. For webhooks, use the run's `webhooks` query param.
- Example input for SEO research: `{"searchTerms":["best crm for startups"],"searchPosts":true,"searchComments":false,"searchSort":"top","searchTime":"month","maxPostsCount":50,"crawlCommentsPerPost":true,"maxCommentsPerPost":20,"includeNSFW":false}`.

**Output items** (discriminated union on `dataType`)

- General rules:
  - Treat every field as nullable or absent. "Only present…" fields (e.g. `searchTerm`) are absent, not null.
  - Deduplicate on `${dataType}:${id}`.
  - Post `id` is `t3_…`; comment `id` is bare. Post `communityName` has the `r/` prefix; comment `subredditName` does not.
  - All timestamps are ISO-8601 UTC strings.
- `post`: `id, parsedId, postUrl, title, body, bodyHtml, authorName, communityName, parsedCommunityName, communityId, upVotes, score, upvoteRatio, commentsCount, createdAt, crawledAt, searchTerm?, flair, contentUrl, domain, outboundUrlHost, over18, postType (string), mediaType, images, ageHours, scorePerHour, commentsPerHour, engagementTotal, commentToScoreRatio, isHighEngagement, titleLength, bodyLength, wordCount, subredditSubscribers, removedByCategory, isRobotIndexable`, and more.
- `comment`: `id, url, postId, parsedPostId, parentId, parsedParentId, parentKind ('post'|'comment'), depth, body, bodyHtml, authorName, authorFullname, subredditName, score, commentUpVotes, commentCreatedAt, crawledAt, postTitle?, postCommentsCount?, isSubmitter, controversiality, searchTerm?`.
- `community`: `id, parsedId, name, title, description, publicDescription, membersCount, onlineUsersCount, createdAt, subredditType, nsfw, rules[], url, searchTerm?`.
- `user_profile`: `id, username, totalKarma, linkKarma, commentKarma, createdAt, profileUrl`, and more.
- AI fields (when enabled):
  - `sentimentLabel`: `'positive'|'negative'|'neutral'|'mixed'|'uncertain'`.
  - `sentimentScore`: -1 to 1.
  - `intent`: `question|seeking_recommendation|complaint|praise|purchase_intent|comparison|announcement|self_promotion|discussion|none`.
  - `emotion`, `entities: string[]`.
  - `relevanceScore`: 0 to 1, search results only.
  - `contentCategory`: posts only.
  - `customLabels: Record<string, unknown>`.
  - `aiFlags: {wantsHelp?, isOwner?, isVendor?, hasPain?, mentionsPrice?, featureRequest?, willingToPay?: boolean; painPoint?, competitor?: string|null}`.
- Reddit serves at most about 1,000 items per listing or search, so results often fall short of the `max*` caps. When a run comes back short, check RUN-SUMMARY `emptyReason` and `skipped`.

### Unverified / to recheck with credentials

- **`init` charge vs memory.** The live event description says "Cost on starting actor per GB of memory", but the listing says "$0.02 per run". At the default 512 MB it could be $0.01, $0.02 or something else. Not verified without a paid run.
- **`maxPostsCount` scope.** The input title says "Max posts (total across all inputs)", but the README says "per searchTerms keyword". Assume output could reach `maxPostsCount` × number of `searchTerms`, and cap spend with `maxTotalChargeUsd`.
- **`postType` values.** The dataset schema says `'text' | 'self' | 'link' | 'image' | 'hosted:video' | 'rich:video'`. The README says `self`, `link`, `image`, `video` or `gallery`. Type it as string.
- **Dataset items auth.** Whether `GET /v2/datasets/{datasetId}/items` needs a token for a run's default dataset is not stated verbatim. The OpenAPI operation inherits the global security schemes, and a WebFetch summary said "Required". The README says RUN-SUMMARY can be fetched without auth for a public run. Always send the Bearer token.
- **Runs list for non-owners.** Untested: `GET /v2/actors/9sHOY9RzPYGjmTHo8/runs` with a non-owner token presumably returns only the caller's own runs.
- **No run was executed** (no token, no spending). Real Run values, `chargedEventCounts` keys (inferred from the pricing event keys), dataset item contents and RUN-SUMMARY contents were not observed.
- **Current pricing record.** No field in `pricingInfos` marks the one in force. The inference is the latest `startedAt` ≤ now (`2026-08-10T14:51:28.574Z`).
- **Tier mapping.** How Apify plans map to the FREE, BRONZE, SILVER, GOLD, PLATINUM and DIAMOND tiers was not verified.
- **`defaultRunOptions.maxTotalChargeUsd`.** It is 0 live, but this field is not in the docs' DefaultRunOptions schema, and whether 0 means "no cap" is unconfirmed. Always pass an explicit value.
- **Review rating.** The API shows ≈4.949 from 17 reviews; the listing HTML shows "Rating 4.5 ( 40 )". Unresolved.
- **`mcpConnector`.** How the input works, and how to pass a connector reference via the API, was not verified. A scrape-only adapter doesn't need it.
- **`searchSort` `''`** (enumTitle "None"): behavior not verified.
- **Bearer vs `token` on build routes.** The build's openapi.json marks the `token` query param as required. The platform docs say the Bearer header is equivalent and recommended. Bearer auth on these routes was not tested.
- **Sync endpoint doc page.** `docs.apify.com/api/v2/actors-run-sync-get-dataset-items-post` returned 404 (guessed URL). Its facts come from `docs.apify.com/api/openapi.json`.
- **Input-schema WebFetch summary.** It reported wrong defaults (10) for `maxPostsCount`, `maxCommentsCount` and `maxCommentsPerPost`. The raw embedded JSON and the live build API give 50/400/200. Treat WebFetch summaries of that page as unreliable.

---

## 8. Qdrant, Obsidian Markdown, Node.js / node:sqlite

Covers Qdrant self-hosted via Docker, Obsidian Markdown conventions, and Node.js LTS and `node:sqlite` status, as of 2026-09-24.

### Sources

| ID | URL | Retrieved | Fetched | Note |
|---|---|---|---|---|
| QN1 | https://qdrant.tech/documentation/quickstart/ | 2026-09-24 | yes | SDK examples only, no REST JSON |
| QN2 | https://hub.docker.com/v2/repositories/qdrant/qdrant/tags?page_size=40&ordering=last_updated | 2026-09-24 | yes | LIVE public Docker Hub tags API |
| QN3 | https://github.com/qdrant/qdrant/releases/latest | 2026-09-24 | yes | Resolves to v1.19.1. The summarizer's 2024 date is wrong |
| QN4 | https://github.com/qdrant/qdrant/releases/tag/v1.19.0 | 2026-09-24 | yes | |
| QN5 | https://github.com/qdrant/qdrant/pull/9982 | 2026-09-24 | yes | |
| QN6 | https://qdrant.tech/documentation/security/ | 2026-09-24 | yes | Redirect target of /documentation/guides/security/ |
| QN7 | https://qdrant.tech/documentation/installation/ | 2026-09-24 | yes | Redirect target of /guides/installation/ |
| QN8 | https://qdrant.tech/documentation/ops-monitoring/monitoring/ | 2026-09-24 | yes | Also covers `/metrics` and `/telemetry` |
| QN9 | https://qdrant.tech/documentation/ops-configuration/configuration/ | 2026-09-24 | yes | Used instead of QN45 |
| QN10 | https://api.qdrant.tech/api-reference | 2026-09-24 | yes | Landing page; points to llms.txt |
| QN11 | https://api.qdrant.tech/llms.txt | 2026-09-24 | yes | Version index only |
| QN12 | https://api.qdrant.tech/v-1-19-x/llms.txt | 2026-09-24 | yes | v1.19 reference index |
| QN13 | https://api.qdrant.tech/api-reference/collections/create-collection.md | 2026-09-24 | yes | |
| QN14 | https://api.qdrant.tech/api-reference/collections/get-collection.md | 2026-09-24 | yes | |
| QN15 | https://api.qdrant.tech/api-reference/collections/collection-exists.md | 2026-09-24 | yes | |
| QN16 | https://api.qdrant.tech/api-reference/indexes/create-field-index.md | 2026-09-24 | yes | |
| QN17 | https://api.qdrant.tech/api-reference/points/upsert-points.md | 2026-09-24 | yes | |
| QN18 | https://api.qdrant.tech/api-reference/points/delete-points.md | 2026-09-24 | yes | |
| QN19 | https://api.qdrant.tech/api-reference/points/scroll-points.md | 2026-09-24 | yes | |
| QN20 | https://api.qdrant.tech/api-reference/search/query-points.md | 2026-09-24 | yes | |
| QN21 | https://api.qdrant.tech/api-reference/search/points.md | 2026-09-24 | yes | 404. The legacy search page is gone from the v1.19 reference |
| QN22 | https://api.qdrant.tech/api-reference/search/search-points.md | 2026-09-24 | yes | 404 |
| QN23 | https://api.qdrant.tech/api-reference/service/healthz.md | 2026-09-24 | yes | |
| QN24 | https://api.qdrant.tech/api-reference/service/livez.md | 2026-09-24 | yes | |
| QN25 | https://api.qdrant.tech/api-reference/service/readyz.md | 2026-09-24 | yes | |
| QN26 | https://api.qdrant.tech/api-reference/service/root.md | 2026-09-24 | yes | |
| QN27 | https://qdrant.tech/documentation/concepts/filtering/ | 2026-09-24 | yes | |
| QN28 | https://qdrant.tech/documentation/manage-data/points/ | 2026-09-24 | yes | |
| QN29 | https://qdrant.tech/documentation/search/search/ | 2026-09-24 | yes | |
| QN30 | https://qdrant.tech/documentation/concepts/indexing/ | 2026-09-24 | yes | |
| QN31 | https://obsidian.md/help/links | 2026-09-24 | yes | help.obsidian.md/links now 301-redirects here |
| QN32 | https://obsidian.md/help/settings | 2026-09-24 | yes | |
| QN33 | https://obsidian.md/help/properties | 2026-09-24 | yes | |
| QN34 | https://obsidian.md/help/tags | 2026-09-24 | yes | |
| QN35 | https://obsidian.md/help/aliases | 2026-09-24 | yes | |
| QN36 | https://obsidian.md/help/data-storage | 2026-09-24 | yes | |
| QN37 | https://obsidian.md/help/plugins | 2026-09-24 | yes | |
| QN38 | https://blacksmithgu.github.io/obsidian-dataview/ | 2026-09-24 | yes | Dataview's own docs |
| QN39 | https://nodejs.org/en/about/previous-releases | 2026-09-24 | yes | |
| QN40 | https://raw.githubusercontent.com/nodejs/Release/main/schedule.json | 2026-09-24 | yes | |
| QN41 | https://nodejs.org/api/sqlite.html | 2026-09-24 | yes | v26.10.0 docs |
| QN42 | https://nodejs.org/docs/latest-v24.x/api/sqlite.html | 2026-09-24 | yes | v24.21.0 docs |
| QN43 | https://nodejs.org/docs/latest-v22.x/api/sqlite.html | 2026-09-24 | yes | v22.23.3 docs |
| QN44 | https://raw.githubusercontent.com/nodejs/node/v24.x/deps/sqlite/sqlite.gyp | 2026-09-24 | yes | Build config of the bundled SQLite |
| QN45 | https://qdrant.tech/documentation/guides/configuration/ | 2026-09-24 | **no** | Redirected; QN9 used instead |
| QN46 | https://forum.obsidian.md/t/new-link-format-differences-and-use-cases/5413 | 2026-09-24 | **no** | Seen in WebSearch only. Community forum, not relied on |

[QN1]: https://qdrant.tech/documentation/quickstart/
[QN2]: https://hub.docker.com/v2/repositories/qdrant/qdrant/tags?page_size=40&ordering=last_updated
[QN3]: https://github.com/qdrant/qdrant/releases/latest
[QN4]: https://github.com/qdrant/qdrant/releases/tag/v1.19.0
[QN5]: https://github.com/qdrant/qdrant/pull/9982
[QN6]: https://qdrant.tech/documentation/security/
[QN7]: https://qdrant.tech/documentation/installation/
[QN8]: https://qdrant.tech/documentation/ops-monitoring/monitoring/
[QN9]: https://qdrant.tech/documentation/ops-configuration/configuration/
[QN12]: https://api.qdrant.tech/v-1-19-x/llms.txt
[QN13]: https://api.qdrant.tech/api-reference/collections/create-collection.md
[QN14]: https://api.qdrant.tech/api-reference/collections/get-collection.md
[QN15]: https://api.qdrant.tech/api-reference/collections/collection-exists.md
[QN16]: https://api.qdrant.tech/api-reference/indexes/create-field-index.md
[QN17]: https://api.qdrant.tech/api-reference/points/upsert-points.md
[QN18]: https://api.qdrant.tech/api-reference/points/delete-points.md
[QN19]: https://api.qdrant.tech/api-reference/points/scroll-points.md
[QN20]: https://api.qdrant.tech/api-reference/search/query-points.md
[QN23]: https://api.qdrant.tech/api-reference/service/healthz.md
[QN24]: https://api.qdrant.tech/api-reference/service/livez.md
[QN25]: https://api.qdrant.tech/api-reference/service/readyz.md
[QN26]: https://api.qdrant.tech/api-reference/service/root.md
[QN27]: https://qdrant.tech/documentation/concepts/filtering/
[QN28]: https://qdrant.tech/documentation/manage-data/points/
[QN29]: https://qdrant.tech/documentation/search/search/
[QN30]: https://qdrant.tech/documentation/concepts/indexing/
[QN31]: https://obsidian.md/help/links
[QN32]: https://obsidian.md/help/settings
[QN33]: https://obsidian.md/help/properties
[QN34]: https://obsidian.md/help/tags
[QN35]: https://obsidian.md/help/aliases
[QN36]: https://obsidian.md/help/data-storage
[QN37]: https://obsidian.md/help/plugins
[QN38]: https://blacksmithgu.github.io/obsidian-dataview/
[QN39]: https://nodejs.org/en/about/previous-releases
[QN40]: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
[QN41]: https://nodejs.org/api/sqlite.html
[QN42]: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
[QN43]: https://nodejs.org/docs/latest-v22.x/api/sqlite.html
[QN44]: https://raw.githubusercontent.com/nodejs/node/v24.x/deps/sqlite/sqlite.gyp

### Verified behavior

**Qdrant: deployment and security**

- Quickstart: `docker pull qdrant/qdrant` and `docker run -p 6333:6333 -p 6334:6334 -v "$(pwd)/qdrant_storage:/qdrant/storage:z" qdrant/qdrant`. REST is at `localhost:6333`, the Web UI at `localhost:6333/dashboard`, gRPC at `localhost:6334`. ([QN1])
- "By default, Qdrant starts with no encryption or authentication. This means anyone with network access to your machine can access your Qdrant container instance." ([QN1])
- The newest stable Docker tag is `v1.19.1`, updated 2026-09-03. `latest`, `v1.19` and `v1` were updated at the same time. `v1.19.0` was updated 2026-08-04. `-unprivileged` variants exist, e.g. `v1.19.1-unprivileged`. ([QN2])
- GitHub's latest Qdrant release is v1.19.1. ([QN3])
- Ports: 6333 HTTP, 6334 gRPC, 6335 distributed. ([QN7])
  - The container data path is `/qdrant/storage`.
  - A custom config can be mounted at `/qdrant/config/production.yaml` or passed with `--config-path`.
  - Storage must be block-level with a POSIX-compatible filesystem. NFS and object storage such as S3 are not supported. Docker/WSL mounts on Windows have filesystem problems that can cause data loss.
- Config via environment variables: ([QN9])
  - Prefix `QDRANT__`, with double underscores for nesting, e.g. `QDRANT__LOG_LEVEL=INFO` and `QDRANT__SERVICE__API_KEY=<MY_SECRET_KEY>`. Env vars override config files.
  - Defaults: `http_port` 6333, `grpc_port` 6334, `host` 0.0.0.0, `storage_path` ./storage, `snapshots_path` ./snapshots, `max_request_size_mb` 32, `enable_cors` true.
- API keys: ([QN6])
  - Admin key: `service.api_key` / `QDRANT__SERVICE__API_KEY`. Read-only key: `service.read_only_api_key` / `QDRANT__SERVICE__READ_ONLY_API_KEY`. Both can be set together.
  - Clients authenticate with `api-key: <key>` or `Authorization: Bearer <token>`.
- TLS and JWT: ([QN6])
  - TLS: `service.enable_tls: true` plus `tls.cert` and `tls.key` (env `QDRANT__SERVICE__ENABLE_TLS=true`). "Sending an api-key over an unencrypted channel is insecure."
  - JWT RBAC: `service.jwt_rbac: true` (`QDRANT__SERVICE__JWT_RBAC=true`), used together with `api_key`.
- `/healthz`, `/livez`, `/readyz` and `/version` skip authentication. Self-hosted open-source deployments are "not secure by default and are not production-ready". Bind to 127.0.0.1 or a private interface, e.g. `docker run -p 127.0.0.1:6333:6333 qdrant/qdrant` or `QDRANT__SERVICE__HOST=127.0.0.1`. ([QN6])
- `/healthz`, `/livez` and `/readyz` are on port 6333 and return 200 once Qdrant is started and ready. "Regardless of whether an API key is configured, the endpoints are always accessible." ([QN8])
- Health bodies:
  - `GET /healthz` returns plain text "healthz check passed". ([QN23])
  - `GET /livez` returns "healthz check passed". ([QN24])
  - `GET /readyz` "Checks the instance to see when it can start accepting traffic."; example body "all shards are ready". ([QN25])
  - `GET /` returns `title`, `version` and `commit` (nullable). ([QN26])

**Qdrant: REST API (v1.19)**

- **Create collection:** `PUT /collections/{collection_name}`, optional `timeout` query param. ([QN13])
  - `vectors` (VectorParams):
    - Required: `size` (uint64) and `distance` (`Cosine`, `Euclid`, `Dot` or `Manhattan`).
    - Optional: `hnsw_config`, `quantization_config`, `on_disk`, `datatype`, `multivector_config`.
  - Other top-level fields include `sparse_vectors`, `hnsw_config`, `optimizers_config`, `quantization_config`, `strict_mode_config` and `metadata`. `on_disk_payload` is deprecated.
  - Response: `{usage, time, status:'ok', result:true}`. Auth header: `api-key`.
- **Get collection:** `GET /collections/{collection_name}`. `result` contains `status` (`green`/`yellow`/`grey`/`red`), `optimizer_status`, `segments_count`, `points_count` (nullable), `indexed_vectors_count` (nullable), `config.params.vectors`, `payload_schema` and optional `warnings`. ([QN14])
- **Collection exists:** `GET /collections/{collection_name}/exists` returns `result: {exists: boolean}`. ([QN15])
- **Create payload index:** `PUT /collections/{collection_name}/index`, query params `wait` (bool) and `ordering` (`weak`/`medium`/`strong`). Body `field_name` (required) and `field_schema`. `result` is `{status:'acknowledged', operation_id}`. ([QN16])
- **Payload index types** (example body `{"field_name": "name_of_the_field_to_index", "field_schema": "keyword"}`): ([QN30])
  - `keyword`, `integer`, `float`, `bool`, `geo`, `datetime`, `text`, `uuid`.
  - Text indexes accept `tokenizer` (word, whitespace, prefix, multilingual), `min_token_len`, `max_token_len`, `lowercase`, `stemmer`, `stopwords` and `phrase_matching`.
  - "Payload indexes should be created before ingesting data."
- **Upsert:** `PUT /collections/{collection_name}/points`, query params `wait`, `ordering` and `timeout`. ([QN17])
  - Body is either `PointsList {points:[PointStruct], shard_key?, update_filter?, update_mode?}` or `PointsBatch {batch:{ids, vectors, payloads?}}`.
  - `PointStruct` is `{id (required), vector (required), payload?}`. `id` is an unsigned 64-bit integer or a UUID string.
  - `result` is `{status: 'acknowledged'|'completed'|'wait_timeout', operation_id?}`.
- **Point IDs:** 64-bit unsigned integers or UUID strings. Simple (e.g. `936DA01F9ABD4d9d80C702AF85C822A8`), hyphenated and URN UUID forms are accepted. ([QN28])
  - Re-uploading a point with the same id overwrites it (upsert is idempotent).
  - Example: `{"points":[{"id":1,"payload":{"color":"red"},"vector":[0.9,0.1,0.1]}]}`.
  - Scroll returns `next_page_offset`, which is null on the last page.
- **Delete:** `POST /collections/{collection_name}/points/delete`, query params `wait`, `ordering` and `timeout`. Body is `{"points":[ids], shard_key?}` or `{"filter":{...}, shard_key?}`. `result` is `{status, operation_id}`. ([QN18])
- **Scroll:** `POST /collections/{collection_name}/points/scroll`. ([QN19])
  - Body: `shard_key`, `offset`, `limit` (default 10), `filter`, `with_payload` (default true), `with_vector`, `order_by`.
  - `result` is `{points:[Record{id, payload?, vector?, shard_key?, order_value?}], next_page_offset}`.
- **Query:** `POST /collections/{collection_name}/points/query`, query params `consistency` and `timeout`. ([QN20])
  - Body: `shard_key`, `prefetch`, `query`, `using`, `filter`, `params`, `score_threshold`, `limit` (default 10), `offset` (default 0), `with_vector` (default false), `with_payload` (default false), `lookup_from`.
  - `result` is `{points:[ScoredPoint{id, version, score, payload?, vector?, shard_key?, order_value?}]}`.
- **Query API usage:** example body `{"query": [0.2, 0.1, 0.9, 0.7], "filter": {...}, "limit": 3}`. ([QN29])
  - `params` accepts `hnsw_ef`, `exact` and `indexed_only`.
  - `with_payload` accepts true/false, an array of field names, or `{"exclude": [...]}`.
  - The Query API has been the single interface for search since v1.10.0.
- **Filters:** `{"filter":{"must":[...],"should":[...],"must_not":[...]}}`. The schema also has `min_should`. ([QN27]) Condition forms:
  - `{"key":"city","match":{"value":"London"}}`, plus match `{"any":[..]}`, `{"except":[..]}` and `{"text":"good cheap"}`.
  - `{"key":"price","range":{"gte":100.0,"lte":450.0}}`. Datetime ranges use RFC3339 strings.
  - `{"has_id":[..]}`, `{"is_empty":{"key":..}}`, `{"is_null":{"key":..}}`.
  - Nested keys such as `"country.cities[].population"`, and `{"nested":{"key":..,"filter":{..}}}`.
- The v1.19 reference lists these Search endpoints only: Query points, Query points in batch, Query point groups, Distance matrix pairs, Distance matrix offsets. There is no `/points/search` page. ([QN12])
- The v1.19.0 changelog says: "#9982 - Remove deprecated search endpoints from OpenAPI, deprecate them in gRPC". ([QN4])
- PR #9982 removed these paths from OpenAPI: `POST /points/search`, `/points/search/batch`, `/points/search/groups`, `/points/recommend`, `/points/recommend/batch`, `/points/recommend/groups`, `/points/discover`, `/points/discover/batch`. The actix handlers are still registered, so the routes still work at runtime. ([QN5])

**Obsidian**

- Links: ([QN31])
  - Obsidian supports Wikilinks (`[[Three laws of motion]]`) and Markdown links (`[Three laws of motion](Three%20laws%20of%20motion.md)`). It creates Wikilinks by default.
  - Folder paths use forward slashes: `[[Projects/Three laws of motion]]`.
  - Headings: `[[About Obsidian#Links are first-class citizens]]`, nested `[[Note#H1#H2]]`, same note `[[#Heading]]`.
  - Blocks: `[[2023-01-01#^37066d]]`. Custom block IDs such as `^quote-of-the-day` may use only Latin letters, numbers and dashes.
  - Display text: `[[Example|Custom name]]`.
  - Markdown links must encode spaces as `%20`. The characters `# | ^ : %% [[ ]]` can break links.
- The "New link format" setting has three options: ([QN32])
  - "Shortest path when possible": the shortest unique path.
  - "Relative path to file": a path relative to the current file.
  - "Absolute path in vault": the full path from the vault root.
  - "Use [[Wikilinks]]" makes Obsidian generate Wikilinks. Turning it off generates Markdown links.
- Properties: ([QN33])
  - Stored as YAML at the top of the file, between `---` lines.
  - Types: Text, List, Number, Checkbox, Date, Date & time, Tags.
  - The default properties `tags`, `aliases` and `cssclasses` are Lists. `tag`, `alias` and `cssclass` were deprecated in 1.4 and removed in 1.9.
  - Internal links in text properties must be quoted, e.g. `link: "[[Episode IV]]"`.
  - A property's type applies across the whole vault.
  - JSON frontmatter is read but saved back as YAML. The UI does not support nested properties.
- Frontmatter tags are a YAML list without `#` (`tags:\n  - recipe`). ([QN34])
  - Allowed characters: letters, numbers, `_`, `-`, `/` (for nesting) and Unicode.
  - A tag needs at least one non-numeric character and cannot contain spaces.
  - Tags are case-insensitive.
- Aliases go in the frontmatter `aliases:` list. Linking through an alias produces `[[Artificial Intelligence|AI]]`. ([QN35])
- "Obsidian stores your notes as Markdown-formatted plain text files in a vault. A vault is a folder on your local file system, including any subfolders." Other editors can change the files, and Obsidian picks up external changes. Per-vault settings live in `.obsidian` at the vault root. ([QN36])
- The core plugins include Bases, Properties view, Canvas, Templates and others. Dataview is not a core plugin. Core plugins are built and supported by the Obsidian team; community plugins come from the Community plugin store. ([QN37])
- Dataview is a community plugin, "a live index and query engine over your personal knowledge base". It reads YAML frontmatter and inline fields (`[key:: value]`, `(key:: value)`). ([QN38])

**Node.js and node:sqlite**

- Release table: v26 is Current (first released 2026-05-05). v24 "Krypton" and v22 "Jod" are LTS. v25 and v20 are EOL. From Node 27 the cycle becomes annual and every major becomes LTS. "Production applications should only use Active LTS or Maintenance LTS releases." ([QN39])
- Official schedule: ([QN40])

  | Version | Start | LTS | Maintenance | End |
  |---|---|---|---|---|
  | v22 | | 2024-10-29 | 2025-10-21 | 2027-04-30 |
  | v24 | | 2025-10-28 | 2026-10-20 | 2028-04-30 |
  | v26 | 2026-05-05 | 2026-10-28 | 2027-10-20 | 2029-04-30 |

  - v20 ended 2026-04-30 and v25 ended 2026-06-01.
  - So on 2026-09-24, v24 is Active LTS, v22 is Maintenance LTS and v26 is Current.
- Node v24.21.0 docs: ([QN42])
  - `node:sqlite` is "Stability: 1.2 - Release candidate" since v24.15.0.
  - It has not needed `--experimental-sqlite` since v22.13.0/v23.4.0.
  - It is available only under the `node:` scheme. Classes include `DatabaseSync` and `StatementSync`.
- `new DatabaseSync(path[, options])` in v24: ([QN42])
  - Options (defaults in parentheses): `open` (true), `readOnly` (false), `enableForeignKeyConstraints` (true), `enableDoubleQuotedStringLiterals` (false), `allowExtension` (false), `timeout` (0 ms), `readBigInts`, `returnArrays`, `allowBareNamedParameters` (true), `allowUnknownNamedParameters` (false), `defensive` (true), `limits`.
  - Methods: `exec`, `prepare`, `close`, `open`, `function`, `aggregate`, `loadExtension`, `enableLoadExtension`, `serialize`, `deserialize`, `createSession`, `applyChangeset`, `createTagStore`, `location`, `setAuthorizer`.
  - `StatementSync` has `all`, `get`, `iterate` and `run`. `run` returns `{changes, lastInsertRowid}`.
- `sqlite.backup(sourceDb, path[, options])` was added in v23.8.0. Since v23.10.0 `path` can also be a Buffer or URL. ([QN42])
  - Options: `source` (default `'main'`), `target` (default `'main'`), `rate` (pages per step, default 100), and a `progress` callback that receives `{totalPages, remainingPages}`.
  - It returns a Promise of the total pages backed up. An existing file at `path` is overwritten.
- Node v22.23.3 docs: `node:sqlite` is "Stability: 1.1 - Active development". `backup()` was added in v22.16.0. ([QN43])
- Node v26.10.0 docs: `node:sqlite` is "Stability: 1.2 - Release candidate" since v25.7.0. `backup()` is listed as added in v23.8.0 and v22.16.0. ([QN41])
- On the v24.x branch the bundled SQLite is compiled with `SQLITE_ENABLE_FTS5`, `SQLITE_ENABLE_FTS3`, `SQLITE_ENABLE_FTS3_PARENTHESIS`, `SQLITE_ENABLE_MATH_FUNCTIONS`, `SQLITE_ENABLE_SESSION`, `SQLITE_ENABLE_RTREE`, `SQLITE_ENABLE_GEOPOLY`, `SQLITE_ENABLE_DBSTAT_VTAB`, `SQLITE_ENABLE_COLUMN_METADATA`, `SQLITE_ENABLE_PERCENTILE`, `SQLITE_ENABLE_PREUPDATE_HOOK`, `SQLITE_ENABLE_RBU` and `SQLITE_DEFAULT_MEMSTATUS=0`. The `node:sqlite` API docs do not mention FTS5. ([QN44])

### Implementation contract

**Qdrant adapter (REST over fetch, v1.19.x)**

Docker: pin `qdrant/qdrant:v1.19.1`, which is also tagged `v1.19`, `v1` and `latest`. A rootless variant is `v1.19.1-unprivileged`. Example compose:

```
image: qdrant/qdrant:v1.19.1
ports: ["127.0.0.1:6333:6333", "127.0.0.1:6334:6334"]
volumes: ["./qdrant_storage:/qdrant/storage"]   # POSIX block storage only, no NFS or S3
environment:
  QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY}
  QDRANT__SERVICE__READ_ONLY_API_KEY: ${QDRANT_READ_ONLY_API_KEY}
```

- Snapshots go to `./snapshots` relative to Qdrant's working directory. Mount `/qdrant/snapshots` only if you need them persisted; that exact container path was not verified.
- For any deployment beyond localhost, enable TLS (`QDRANT__SERVICE__ENABLE_TLS=true`, `QDRANT__TLS__CERT`, `QDRANT__TLS__KEY`) or put a TLS reverse proxy in front. Self-hosted Qdrant is "not secure by default".
- Auth: send `api-key: <key>` on every request (`Authorization: Bearer <key>` also works). Use the read-only key on read-only code paths.
- Health checks never need auth:
  - `GET /healthz`, `/livez` and `/readyz` return plain text. Do not JSON-parse them.
  - `GET /` returns `{title, version, commit}`. Use it to check the server is 1.19.x.
- Responses use the envelope `{ usage?, time: number, status: "ok", result: T }`. Writes return `result: { operation_id?: number, status: "acknowledged" | "completed" | "wait_timeout" }`. Treat `wait_timeout` as a soft failure you can retry.

Endpoints (URL-encode `{collection_name}`):

1. **Exists:** `GET /collections/{collection_name}/exists` → `result.exists`.
2. **Create:** `PUT /collections/{collection_name}` with `{ "vectors": { "size": <int>, "distance": "Cosine" | "Euclid" | "Dot" | "Manhattan" } }`.
   - The distance enum is case-sensitive.
   - For named vectors, `vectors` is a map of name → VectorParams, and you query with `using`.
   - Returns `result: true`.
3. **Info:** `GET /collections/{collection_name}` → `status`, `points_count`, `indexed_vectors_count`, `config.params.vectors`, `payload_schema`. Use it to check that the stored size and distance match the embedding model.
4. **Payload index:** `PUT /collections/{collection_name}/index?wait=true` with `{ "field_name": "site", "field_schema": "keyword" }`.
   - `field_schema` is one of `keyword | integer | float | bool | geo | datetime | text | uuid`.
   - Create payload indexes before ingesting data.
5. **Upsert:** `PUT /collections/{collection_name}/points?wait=true` with `{ "points": [ { "id": <uint64 | UUID string>, "vector": number[], "payload": {...} } ] }`.
   - IDs must be unsigned integers or UUIDs. Derive a deterministic UUID (e.g. a v5 UUID of the URL or chunk key) and keep the original key in the payload.
   - Upserting the same id overwrites the point.
   - Send in batches and keep each request under the default 32 MB `max_request_size_mb`.
6. **Search:** `POST /collections/{collection_name}/points/query` with `{ "query": number[], "filter"?: Filter, "limit"?: 10, "offset"?: 0, "with_payload": true, "with_vector"?: false, "score_threshold"?: number, "params"?: { "hnsw_ef"?: n, "exact"?: bool }, "using"?: "<vector name>" }`.
   - Returns `result.points: [{ id, version, score, payload?, vector? }]`.
   - `with_payload` defaults to **false** on this endpoint, so always set it.
   - Do not build on `/points/search`. It was removed from OpenAPI in v1.19 and is deprecated, although it still works at runtime.
7. **Delete:** `POST /collections/{collection_name}/points/delete?wait=true` with `{ "points": [ids] }` or `{ "filter": Filter }`.
8. **Scroll:** `POST /collections/{collection_name}/points/scroll` with `{ "filter"?, "limit"?: 10, "offset"?: <id>, "with_payload"?: true, "with_vector"?: false }`.
   - Returns `result: { points, next_page_offset: id | null }`.
   - Loop, passing `next_page_offset` as `offset`, until it is null.

```ts
type Filter = { must?: Condition[]; should?: Condition[]; must_not?: Condition[]; min_should?: unknown };
type Condition =
  | { key: string; match: { value: string | number | boolean } | { any: (string | number)[] } | { except: (string | number)[] } | { text: string } }
  | { key: string; range: { gt?: number | string; gte?: number | string; lt?: number | string; lte?: number | string } }
  | { has_id: (number | string)[] }
  | { is_empty: { key: string } }
  | { is_null: { key: string } }
  | { nested: { key: string; filter: Filter } }
  | Filter;
```

- Nested payload keys use dots and `[]`, e.g. `"meta.tags[]"`.
- Error bodies are unverified. On a non-2xx response, report the HTTP status and the raw body text.

**Obsidian export conventions**

- The vault is a folder of plain `.md` files. Write files directly; Obsidian picks up external changes. Never write into `.obsidian/`.
- Frontmatter (YAML between `---` lines):
  - Use `tags`, `aliases` and `cssclasses` as YAML lists. Do not use the removed `tag`, `alias` or `cssclass`.
  - Write tags without `#`. Each needs at least one non-numeric character and no spaces. Use `/` for nesting, e.g. `seo/keyword`.
  - Quote links inside properties: `source: "[[Some Note]]"`.
  - Keep each property's type consistent across the vault. Avoid nested objects.
  - Available types: Text, List, Number, Checkbox, Date, Date & time.
- Links:
  - Use paths from the vault root (matching "Absolute path in vault"), e.g. `[[seo/keywords/best running shoes|best running shoes]]`.
  - Headings: `[[Note#Heading]]`.
  - Blocks: `[[Note#^block-id]]`. The ID uses only letters, numbers and dashes, and `^id` goes at the end of the line.
  - Keep `# | ^ : %% [[ ]]` out of filenames and link targets. Sanitize titles.
  - Markdown links (`[text](path%20with%20spaces.md)`) also work but need `%20` encoding.
- Dataview is a community plugin, not a core one. Treat Dataview blocks and `key:: value` inline fields as optional extras. The core **Bases** plugin is the built-in way to build views from properties.

**Node.js runtime**

- Release status on 2026-09-24:
  - Active LTS: Node 24 "Krypton". It moves to maintenance on 2026-10-20 and reaches EOL on 2028-04-30.
  - Maintenance LTS: Node 22 "Jod", EOL 2027-04-30.
  - Current: Node 26, which becomes LTS on 2026-10-28.
  - Node 20 has been EOL since 2026-04-30.
- Suggested `package.json` engines: `">=24.15.0"`, where `node:sqlite` became Release Candidate (Stability 1.2). Alternatively `">=22.16.0"`, where it is still Stability 1.1 (Active development).
- `node:sqlite`:
  - It needs no flag (none since 22.13.0).
  - Import it with the `node:` prefix: `import { DatabaseSync, backup } from 'node:sqlite'`.
  - The API is synchronous: `db.exec(sql)`, `db.prepare(sql)` → `.all/.get/.run/.iterate`. `run()` returns `{changes, lastInsertRowid}`.
  - `backup(sourceDb, path, { rate?, progress? })` returns a `Promise<number>` of pages copied.
- FTS5: the bundled SQLite is compiled with `SQLITE_ENABLE_FTS5`, but the API docs don't promise it. At startup, try `CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x)` inside a try/catch. If it fails (e.g. a distro build of Node linked against a system SQLite), fall back to LIKE search.

### Unverified / to recheck with credentials

- **Qdrant error responses.** The error shape (e.g. `{"status":{"error":"..."},"time":...}`) and the statuses for a missing collection (404) or bad request (400) were not shown on the fetched pages. Parse errors defensively.
- **`/metrics` and `/telemetry` auth.** Whether they need the API key when one is set is not stated.
- **Health endpoint auth conflict.** The API reference pages for `/healthz`, `/livez` and `/readyz` show a generic "api-key header (required)" block. The security and monitoring guides say these endpoints are always reachable without auth. The guides were trusted.
- **`/readyz` when not ready.** The exact status while shards are not ready (presumably 503) is not documented.
- **Release dates.** The GitHub release pages were summarized with a 2024 date, which is a summarizer error. The actual dates (v1.19.0 on 2026-08-04, v1.19.1 on 2026-09-03) come from Docker Hub tag timestamps.
- **REST examples.** The quickstart has only SDK code. REST bodies were checked against the api.qdrant.tech reference and the concepts pages.
- **Parameterized index schemas.** The full list (e.g. `{"type":"keyword","is_tenant":true}`) and the shape of the text-index params object were only mentioned in passing, not checked field by field.
- **Obsidian link details.** Help URLs now 301 from help.obsidian.md to obsidian.md/help. Not checked: whether "Absolute path in vault" links get a leading `/`, and whether `.md` is added to wikilinks.
- **FTS5 on `--shared-sqlite` builds.** Not checked for Node builds that link a system SQLite (e.g. some Linux distro packages). Only the bundled build flags were checked. Detect FTS5 at runtime.
- **When v24 options arrived.** The v24 minor that added the newer `DatabaseSync` options (`defensive`, `limits`, boolean/ArrayBuffer binding, marked v24.21.0+ in the docs) and `createTagStore` is unknown. Only the latest v24 docs were read.
- **ExperimentalWarning.** Whether `node:sqlite` prints one at runtime during the v24 release-candidate phase is not stated.
- **Exact patch versions.** Beyond the doc headers (v24.21.0, v22.23.3, v26.10.0), the current patch versions were not confirmed. The release table's last-updated dates were v24 2026-09-07, v22 2026-09-23 and v26 2026-09-21.

---

## 9. Research gaps

Sources that could not be fetched, or were fetched without usable primary content. No credentials were used anywhere. Every authenticated behavior (response bodies, headers, charges) is therefore still unverified; see each section's "Unverified" list.

**LLM Gateway**

- All 28 sources were fetched.
- No docs page covers tool calling. The contract comes from the OpenAPI schema and the AI SDK example.

**Google Search Console**

- `https://www.googleapis.com/discovery/v1/apis/webmasters/v3/rest` returned invalid JSON (the legacy discovery doc is retired). The `searchconsole` v1 discovery doc was used instead.
- Help Center pages 34592, 96568, 7576553, 17011259 and Analytics Help 10737381 were read only as WebFetch summaries, not verbatim.
- `github.com/AKzar1el/mcp-gsc/pull/129` is SECONDARY and was used only as a hint.
- No pricing page was found. The OAuth verification class of `webmasters.readonly` was not checked.

**Google Analytics 4**

- `support.google.com/analytics/answer/13331684` was a WebFetch summary only; the "(other)" row limits were missing.
- `support.google.com/analytics/answer/13331292` returned the data-sampling article instead of the "(other)" row details.

**Google OAuth**

- `quickstart-client-libraries` produced conflicting WebFetch summaries: one claimed service-account steps, a recheck found none.
- `config/admin/v1/quickstart` gave conflicting results on whether a service-account tab exists.
- The Google Auth Platform Data Access page and the Clients help article were not fetched.

**PageSpeed Insights and CrUX**

- `developer.chrome.com/docs/crux/reference/rest/v1/records/queryRecord` returned a noindex stub. The CrUX API page and the discovery doc were used instead.
- The PSI FAQ had no quota info.
- The keyless `runPagespeed` call returned 429, so no successful live PSI response was seen.

**DataForSEO**

- `dataforseo.com/pricing/ai-optimization/llm-mentions` is a JS calculator, and its static figures are inconsistent.
- `X-RateLimit-*` headers could not be seen on unauthenticated 401 responses.
- The `keywords_data/google_ads/status` endpoint details were not fetched.

**Apify**

- `docs.apify.com/api/v2/actors-run-sync-get-dataset-items-post` returned 404 (fetched: no). `docs.apify.com/api/openapi.json` was used instead.
- `actor-run-get`, `actors-runs-get`, `actor-build-default-get`, `actor-build-openapi-json-get` and `ad-hoc-webhooks` returned HTTP 200 but were not read. Their facts come from `openapi.json`.
- The list-runs endpoint returns 401 without a token.
- The input-schema page's WebFetch summary gave wrong defaults. It was corrected from the raw embedded JSON and the live build API.

**Qdrant, Obsidian, Node**

- `qdrant.tech/documentation/guides/configuration/` redirected (fetched: no). `/documentation/ops-configuration/configuration/` was used instead.
- `forum.obsidian.md/t/new-link-format-differences-and-use-cases/5413` was not fetched and not relied on.
- `api.qdrant.tech/api-reference/search/points.md` and `search/search-points.md` returned 404.
- The GitHub release page summaries gave wrong (2024) dates. The dates here come from Docker Hub.
- The Qdrant quickstart has no REST JSON examples.
