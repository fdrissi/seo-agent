# Module: AI-citation monitoring (optional)

Source:

- `src/aeo/matching.ts`: in-code brand-mention and own-site-citation classification.
- `src/aeo/import.ts`: the manual-import adapter (`importAiCitations`).
- `src/aeo/summary.ts`: `aiCitationSummary(ctx, period)`, `listAiCitationChecks(ctx, period, opts)`.
- `src/aeo/status.ts`: `aiCitationStatus(ctx)`, the honest enabled/disabled status.
- `src/cli/commands/ai-citations.ts`: `ai-citations status`, `ai-citations import`, `ai-citations list`.
- Schema: `ai_citation_checks` (`migrations/0005_research.sql`, grain in
  `migrations/0200_metric_grains.sql`, import provenance columns in
  `migrations/0300_ai_citation_manual_import.sql`).
- Tests: `tests/unit/aeo/`, `tests/integration/aeo/`; fixtures: `tests/fixtures/aeo/` (SYNTHETIC).

Spec coverage: section 17 (optional, separately budgeted AI-citation
monitoring; Bing and other visibility tools only through verified APIs or
explicit manual import). The heuristic on-page AEO assessment is a different
feature (`crawl aeo`, `src/crawler`).

## What exists and what does not

| Collector | Status |
| --- | --- |
| Manual import (`ai-citations import <file.csv\|file.json>`) | Implemented and tested offline. Available only while `features.aiCitations` is true. |
| Any API-based AI-answer engine | **Not implemented.** No verified, accessible API is configured for this application, so there is no collector and no endpoint is invented because a dashboard exists. |
| Bing Webmaster Tools and other visibility tools | Supported **only** through an explicit manual export that the owner maps to the import columns below. The application never contacts these tools. |

The DataForSEO allowlist (`src/integrations/dataforseo/endpoints.ts`) contains
an AI Optimization entry gated by `features.dataforseoAiVisibility` with
pricing marked unverified. This module does not call it, and nothing maps its
output into `ai_citation_checks`.

No generic "visibility import" exists. Visibility tools usually export
aggregates (for example citations per page over a period). Those have a
different grain than one observed answer, and storing them as observations
would misstate what was measured. Import individual observed answers instead.

## Feature flag and money

- `features.aiCitations` is `false` in every profile (`src/config/profiles.ts`)
  and stays off until the owner sets it in the site config.
- While it is off, `ai-citations status` reports `disabled` (AI visibility is
  DATA_UNAVAILABLE, not zero). `ai-citations import` and `ai-citations list`
  refuse with `INTEGRATION_DISABLED` (exit code 3). `aiCitationSummary`
  returns `status: 'disabled'` with every measure `unavailable`.
- Manual import makes no network request and spends nothing, so it uses no
  budget. No paid AI-citation collector exists, so no AI-citation budget is
  used. A future API collector must go through budget reservation and the
  provider-request log like every other paid call. It must have its own
  budget line, never "unknown cost = $0".

## Import format

CSV (a header row; leading `#` comment lines are skipped) or JSON (an array of
objects, or `{ "checks": [...] }` / `{ "rows": [...] }`). Header names are
case-insensitive; `_`, `-`, `.` count as spaces.

| Column | Required | Meaning |
| --- | --- | --- |
| `engine` | yes | The AI search product the answer came from (stored lower-case). |
| `query` | yes | The search query or question. |
| `prompt` | no | The exact prompt, when it differs from the query. |
| `location` | no | Where the check was made (free text, e.g. a country). |
| `date` | yes | `YYYY-MM-DD`, or an ISO timestamp with `Z` or a UTC offset. A timestamp without a zone is refused. |
| `timezone` | no | IANA zone for a date without a time. Default: `--timezone`, else the site's business time zone. |
| `grounded` | yes | `yes`/`no`: whether the answer used live search retrieval, **as provided**. It cannot be verified afterwards, so it is never guessed. |
| `response` | no | The answer text. Stored in the private raw store, not in SQLite. |
| `cited_urls` | no | The URLs the answer actually cited: separated by spaces or `\|`, or a JSON array. `none` (or `[]`) means it cited nothing. Blank means not recorded. |
| `source` | no | Tool or person that captured the observation (default `--source`). |

Common header variants are accepted (for example `answer` for `response`,
`citations` or `sources` for `cited_urls`, `checked_at` or `timestamp` for
`date`, `tool` for `source`; the full list is `ALIASES` in `src/aeo/import.ts`).
Columns named `brand_mentioned`, `own_site_cited`, `mentioned`, or `cited`
are ignored with a warning. Those values are always computed in code. Other
unknown columns are ignored and listed.

Validation is all-or-nothing unless `--skip-invalid`: missing or invalid
`grounded`, a missing engine/query/date, a date in the future, a non-http(s)
or credential-bearing cited URL, and duplicate rows in one file are rejected,
with the file line of each rejected row. Limits: 20 MB, 5,000 rows, and
100,000 characters of response text per row.

Label test data: JSON `"_synthetic": true`, a leading `# ... SYNTHETIC ...`
CSV comment, or `--synthetic` (the demo profile always labels rows
synthetic). Owner files are stored with `is_synthetic = 0`.

## What is stored

One row per observation in `ai_citation_checks`, `method = 'manual_import'`:

- `engine`, `query`, `prompt`, `location`, `is_grounded` (as provided),
  `source_label`.
- `checked_at`: the stated instant. A date without a time is stored at
  12:00 in its zone, with `checked_at_precision = 'day'`, `checked_date`, and
  `checked_date_tz`, so the date survives conversion to report time zones
  and the unknown time of day is explicit.
- `response_ref`: a per-row raw record in `data/raw/<site>/ai-citations/`
  (private workspace, redacted) holding the response text, the cited URLs,
  the classification details, and the row as supplied. `response_sha256`
  is the hash of the response text.
- `cited_urls_json`: `NULL` = not recorded, `[]` = cited nothing, otherwise
  the URLs as cited (tracking parameters kept, duplicates removed).
- `brand_mentioned`, `own_site_cited`: computed (below). `NULL` = unknown.
- `transformation_version` (`ai-citations-manual-import@1+ai-citation-matching@1`),
  `collected_at`, `is_synthetic`.

Control characters (ESC, BEL, C1 controls, carriage returns, and the like)
are replaced with spaces in every stored text field (engine, query, prompt,
location, source label, and the response text in the raw record; newlines
and tabs are kept), and the import warns how many rows contained
them. The row exactly as supplied is kept in the raw record for provenance
(`tests/integration/aeo/import-control-chars.test.ts`).

Each import writes one `ai_citations.imported` audit event (file name,
SHA-256, counts). Re-importing an identical observation changes nothing. A
row whose grain key (engine, query, prompt, location, method, checked_at) is
already stored with a different grounded flag, response, or cited URLs is
reported as a conflict (exit code 2). The stored row is kept, never
overwritten.

## Classification rules (in code, `src/aeo/matching.ts`)

- **Brand mention** comes from the response text only. It is true when the
  site's business name, a `brand.aliases` entry, or an allowed hostname
  appears as a whole word (case-insensitive, Unicode-aware; "Qwertleish"
  does not match "Qwertle"). A URL written in the text counts as a mention,
  not a citation. With no response text, the mention is unknown (`NULL`).
- **Own-site citation** comes from the cited URLs only. It is true when a
  cited URL's hostname is exactly one of `site.allowedHostnames`. www and
  non-www are never merged, and subdomains are not assumed. With no
  recorded cited URLs, the citation is unknown (`NULL`).
- All terms come from the site config; nothing owner-specific is hardcoded.

## Summary semantics (`aiCitationSummary`)

- A brand mention is not a citation: mentions, own-site citations,
  "mentioned but not cited", and "cited but not mentioned" are separate
  numbers.
- A citation is not a click, and a click is not a conversion: `clicks` and
  `conversions` are always `unavailable`. No stored source measures them for
  AI answers.
- An ungrounded model response is never a live search measurement: rows
  with `is_grounded = 0` are counted only as `ungroundedExcluded` and
  contribute to no other number. With only ungrounded rows, every
  visibility measure is `unavailable`.
- Unknown is not "no": when some grounded rows lack response text or cited
  URLs, the measure is `incomplete` with the partial counts and the reason.
- No observations in the period gives `status: 'no_data'`, never zero.
  Manually imported observations are owner-supplied samples, not a complete
  or representative measurement of AI search visibility.
- Periods are calendar dates in an IANA zone (default: the business time
  zone): `{ start, end, timeZone? }`, `'YYYY-MM'`, or
  `'YYYY-MM-DD..YYYY-MM-DD'`. Day-precision rows are filtered by their stated
  date. All SQL is parameterized and scoped by `site_id`.

- `mentionCitationKnown` is the number of grounded rows that record both
  the response text and the cited URLs. "Mentioned but not cited" and "cited
  but not mentioned" are counted over those rows only.

The monthly report's optional AI-visibility section
(`src/reports/sections-monthly.ts`) is built from `aiCitationSummary` for the
report period, so the report and `ai-citations list` agree:

- It counts grounded rows only; ungrounded responses appear as an excluded
  count.
- The `ai.citations` claim lists "own site cited in N, not cited in M" and,
  when grounded rows have no recorded cited URLs, "citation unknown in K".
  The claim is then marked `INCOMPLETE` (text and `reason`): the cited count
  is a lower bound, and unknown is never folded into "not cited". Rows without
  response text are handled the same way ("mention unknown in K").
- `ai.mentioned_not_cited` is counted only over rows with both the response
  text and recorded cited URLs. When there are none it is DATA_UNAVAILABLE.
- A per-engine table shows grounded checks, mentions, citations, and the
  unknown counts. Clicks and conversions are always DATA_UNAVAILABLE.
- With `features.aiCitations` off the section is DATA_UNAVAILABLE
  ("disabled"), even when rows exist, as in the summary.
- The monthly `ai_visibility` stage output reports `checksInPeriod: null`
  (not measured) when the feature is off or the report period is not known,
  never a measured 0; with the feature on and a known period it counts the
  recorded observations (0 when none, with a DATA_UNAVAILABLE note naming
  `ai-citations import`) (`tests/integration/pipelines/pipelines-more.test.ts`).
- `tests/integration/aeo/monthly-report.test.ts` covers rows with a NULL
  `own_site_cited`.

## Commands

```sh
npm run cli -- ai-citations status
npm run cli -- ai-citations import observations.csv [--timezone Europe/Tallinn] [--source "manual check"] [--skip-invalid] [--synthetic]
npm run cli -- --dry-run ai-citations import observations.csv   # validate and classify; writes nothing
npm run cli -- ai-citations list [--from YYYY-MM-DD --to YYYY-MM-DD | --month YYYY-MM] [--engine <name>] [--grounded-only] [--limit 50]
```

`ai-citations list` defaults to the 90 days ending today in the business time
zone and always prints the summary for the whole period. `--json` works on
all three commands. `ai-citations import` refuses with `LOCKED` while a job
holds the site lock. The command checks this itself; `--dry-run` previews
still work.

## Limitations

- Observations are only as good as the owner's capture: the application
  cannot verify that an answer was grounded, complete, or representative.
- AI answers vary by user, time, location, and personalization. One
  observation is one sample, never a ranking.
- CSV row numbers in errors are file lines when no quoted field spans
  several lines.
