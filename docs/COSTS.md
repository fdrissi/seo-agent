# Costs and paid-service requirements

seo-agent is free to run in the **Demo** profile and can run the **Core**
profile without paid research services. Several optional integrations charge
money. This page states honestly what can cost money and how the application
limits spending.

> **Budgets are ceilings, not quotes.** The example per-site budgets
> (LLM Gateway $5/month, DataForSEO $1/week and $10/month, Apify $10/month,
> combined variable API ceiling $25/month) are configurable **spending limits**.
> They are not verified prices, not a promise that your workload fits, and not
> a guarantee of your total cost. Deposits, minimum top-ups, subscriptions,
> fees, taxes, and infrastructure are **not** included in these budgets.

Prices below are from `docs/integration-contracts.md`, checked against primary
sources on **2026-09-24**. Prices change: verify them on each provider's
pricing page before enabling paid use, and prefer the provider-reported
`cost` fields over any number here.

## Which services cost money

| Service | Needed for | Billing model (as documented 2026-09-24) | Funding / minimums to check |
| --- | --- | --- | --- |
| **LLM Gateway** | AI analysis, drafting, embeddings (optional in Core, used in Full) | Prepaid credits; per-token model prices from the gateway catalog; the gateway reports `usage.cost` for chat calls; embeddings cost is computed from tokens x catalog price (not reported in the response) | Top-ups carry a 5% platform fee and a 1.5% international card fee (LG25). Model prices vary by model; the catalog is the source. |
| **DataForSEO** | Selective SERP and keyword-volume research (Full) | Pay-as-you-go per task. Examples: Google Organic SERP per 10 results: Standard $0.0006, Priority $0.0012, Live $0.002; Google Ads search volume per task (up to 1000 keywords): Standard $0.06, Live $0.09 | **Minimum payment $50** (DF3); $1 free credit on signup (DF37). Backlinks, Labs, and AI-visibility endpoints are disabled by default. |
| **Apify** | Reddit research via Actor `9sHOY9RzPYGjmTHo8` (Full) | Pay-per-event: about $0.02 per Actor start plus about $0.002 per saved result on the free tier (lower on paid tiers); optional AI add-ons cost extra and are disabled | Plan tiers and platform usage apply; the "per GB of memory" wording of the start event is unverified. Check your Apify plan. |
| **Google APIs** (Search Console, GA4 Data, URL Inspection, PageSpeed Insights, CrUX) | Core measurement | No pricing page was found for Search Console or GA4 Data API; they are quota-limited. CrUX is documented as free (quota 150 queries/min, increases cannot be bought). PageSpeed needs an API key; keyless calls were rejected. | A Google Cloud project is required. Check whether your organization's Google Cloud billing policies apply. |
| **Qdrant** | Vector memory (Full) | Self-hosted via Docker Compose: no license fee | Your machine or server resources. A hosted Qdrant service would be a separate paid choice (not required). |
| **Obsidian** | Optional viewer for the vault | The vault works without Obsidian | Obsidian's own licensing/sync pricing if you choose to use it. |

## Costs that are not in any budget

- DataForSEO minimum payment, LLM Gateway top-up fees, Apify subscriptions.
- Infrastructure: the machine or server, disk for the workspace and backups,
  Docker, electricity, bandwidth, domain/TLS if you expose anything.
- Taxes (VAT/sales tax) and currency conversion or card fees.
- One-time costs (setup time, Google Cloud project configuration).
- Your own time reviewing recommendations and approvals.

## How spending is controlled

- **Budget ceilings per site, per service, per run, and per shared account**
  in the site configuration (`budgets.*`). No automatic top-ups, upgrades,
  subscriptions, or budget increases.
- **Before every paid request:** reuse valid cached data, check the endpoint
  price basis, estimate a conservative upper bound, atomically reserve it,
  submit with strict provider-side limits (for example Apify
  `maxTotalChargeUsd`), then reconcile the provider-reported usage and release
  the rest.
- **Unknown cost is never $0.** If a price cannot be established, the request
  needs approval or is skipped; unreconciled charges stay reserved.
- **No blind retries of paid POSTs.** A timeout marks the submission ambiguous
  and it is reconciled against provider history. When a provider never
  reports the charge (an ambiguous LLM Gateway call, a DataForSEO task, or an
  Apify run found later without a cost), a named human settles it from the
  provider's billing or usage page:
  `npm run cli -- costs reconcile <reservation-id> --actual-usd <amount> --evidence "<what the history shows>" --by "<your name>"`.
  `--not-charged` records $0, and only as that explicit statement. The
  reconciliation is audited; `costs --unresolved` lists each open item with
  the command that settles it.
- **Embedding costs are reported honestly.** A failed or refused embedding
  call that may have been billed makes the run's cost unknown, never $0, and
  a billed response that is later refused (for example for a dimension
  mismatch) keeps its reported cost.
- **Baseline runs no paid DataForSEO or Apify requests** by default, and shows
  a cost plan before optional LLM/embedding work.
- **Caps are printed before a paid run starts.** `--mode RESEARCH weekly`
  and `monthly` print the per-run caps and the remaining DataForSEO, Apify,
  LLM, and combined budgets first. `apify research` prints its plan (runs,
  communities, per-run caps, plan hash) and starts only with `--mode RESEARCH`,
  `--confirm-spend`, and a total `--max-usd`. The optional LLM classifier for
  Apify signals (`--classify-with-llm --llm-max-usd <cap>`) is a separate,
  budget-reserved cost; without it, the free heuristics are used.
- **DataForSEO's live queue needs a reason.** `research.dataforseo.queue: live`
  costs more than standard queued tasks; `config validate` warns until
  `research.dataforseo.liveQueueJustification` records why it is needed.
- **`doctor` never spends money** unless you pass an explicit flag, which shows
  the cap.
- `npm run cli -- costs` reports actual, estimated, reserved, and unknown
  amounts separately against each limit. An amount the provider reported is
  shown apart from one computed from usage at list price (for example LLM
  embeddings, whose responses carry no cost): both count toward every limit,
  but only the first is a charge the provider stated. The dashboard,
  `data export costs` (`amount_basis`), and the reports' spend notes keep the
  same distinction, and so do the pipeline run summary and the vault system
  log (`$R provider-reported, $C computed from usage, $X reserved, $E
  estimated-only`, never a bare "actual"). Unknown LLM charges are counted in
  the budget month of the business time zone, like the reservations
  themselves.
- **Synthetic spending is labeled.** Sandbox and fixture requests are free
  but still take a verified-$0 reservation, reconciled at $0 and flagged
  synthetic; that $0 is a fixed zero, never counted as "computed from usage
  at list price". Synthetic (demo, fixture, sandbox) reservations never use
  up a shared account cap (`budgets.accountMonthlyUsd`), which counts real
  reservations only. The run summary tags a provider with synthetic amounts
  `[SYNTHETIC: no real charges]`. In a demo workspace `costs` prints
  "SYNTHETIC DEMO DATA: no real charges" (and `"synthetic": true` with
  `--json`).
- **An exhausted budget never blocks a pipeline.** Stages whose paid work is
  optional (the routing intent hook, the content queue's model steps, the
  baseline summary) run without it and say so; the report is still
  produced. `cost_plan` checks what is left of the month and the combined
  ceiling, not only the per-run cap.
- **Budget exceptions do not raise limits yet.** `approvals
  request-budget-exception` records and checks an exception, but the budget
  service does not read it, and every surface that shows or approves one
  says so.

Also set **provider-side limits** where available (LLM Gateway key usage
limits, DataForSEO account cost limit, Apify run max charge). Provider billing
can be delayed, so polling cannot guarantee zero overshoot; provider-side caps
are the backstop.

## Rough orders of magnitude (illustrative, not quotes)

At the 2026-09-24 prices above, three standard-queue SERP tasks (10 results
each) cost about $0.0018 and one standard search-volume task about $0.06; an
Apify run storing 100 results costs about $0.22 on the free tier. These
examples ignore minimum payments, fees, taxes, and price changes. Your real
costs depend on your configuration, models, volumes, and provider plans.
