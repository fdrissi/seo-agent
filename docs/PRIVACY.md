# Privacy and data minimization

seo-agent helps you improve a website using aggregated first-party data and
public research. It is not a people-tracking tool. You (the installer) are the
controller of the data your installation collects; the maintainers never
receive any of it (see `docs/DATA_FLOWS.md`).

## Principles

1. **Aggregates, not individuals.** Search Console and GA4 are read as
   aggregated reports (pages, queries, sessions, events, key events). The
   application does not request user-level exports, client IDs, user IDs, or
   raw event streams.
2. **Minimum necessary.** Integrations request only the dimensions and fields
   an analysis needs. Research runs only for shortlisted opportunities.
3. **No personal identifiers to models.** Evidence sent to LLM Gateway is
   redacted; personal identifiers (emails, phone-like numbers, user handles,
   IP addresses, analytics client/user IDs) are masked before sending unless
   you configure an explicit, documented need (see
   [Personal data and language models](#personal-data-and-language-models)).
4. **No secrets in knowledge stores.** Secrets never enter the vault, reports,
   embeddings, logs, or diagnostics. Generated vault notes are redacted
   before they are written: the body, the title, every generated property
   value, and the file name. Credential parameters in URLs (for example
   `token=`, `sig=`, `X-Amz-Signature=`, `access_token` in a fragment) are
   masked up to the next `&`, whitespace, `"`, `#`, `<`, `>`, or a `,` that
   starts another URL, while other query parameters are kept.
5. **User-reported content is evidence, not people.** Reddit and forum content
   is used to understand questions, language, and needs, never to profile
   individuals.

## Personal data and language models

By default, personal identifiers never reach the LLM Gateway or the model
provider behind it. Before a request is sent, seo-agent masks emails
(including percent-encoded ones in URLs and query strings, such as
`name%40example.com`), phone-like numbers, user handles (`u/...`, `@...`),
IPv4 and IPv6 addresses (full, compressed, bracketed, zoned, and
IPv4-mapped forms), and analytics client or user ids in:

- evidence excerpts (crawled pages, competitor and SERP text, Reddit
  excerpts, retrieved notes, imported questions);
- the labels, URLs, and source attributes of the data blocks around them;
- tool results returned to the model;
- the text of chunks sent for embeddings.

Each model call records whether masking was applied and how many values of
each kind were masked. Names written as ordinary words (for example a staff
member named in your own page text) are not detected; keep them out of
business notes if they must not reach a model.

Two site config fields turn masking off for chat and structured-output
requests (evidence, data-block labels, tool results), and both are required:

```yaml
llm:
  allowPersonalData: true                         # default false
  personalDataReason: "Owner-approved: support transcripts are summarized to find product questions"
```

`allowPersonalData: true` without a non-empty `personalDataReason` fails
validation. When both are set, `config validate` shows the reason as a
warning, and each model call records "not masked" with a
pointer to the reason. Only enable it if you have a lawful basis to send
that data to the LLM Gateway and its upstream provider, and check their
retention terms ([DATA_FLOWS.md](DATA_FLOWS.md#llm-gateway-runtime-language-models-and-embeddings)).
Embedding inputs and memory documents are not affected by this setting:
secrets are rejected, and personal identifiers are masked before indexing
and again before any text is sent for embeddings.

## Reddit and other community content

- **Authors are not collected.** The Apify adapter requests an allowlist of
  non-personal post and comment fields; author names, profile links, and user
  profile items are dropped (and the allowlist is enforced again locally).
- In stored text, `u/handles`, `@handles`, email addresses, and phone-like
  numbers are masked; links to user profiles are dropped.
- Deleted/removed items and NSFW posts are dropped.
- Each stored signal keeps only what is needed to verify it later: the source
  link, posting date, collection window, community, engagement counts, and a
  short excerpt, with limitations noted ("engagement is not search volume").
- The application never comments, messages, impersonates users, or creates
  mentions/backlinks.
- Respect the platform's terms and access restrictions; do not use the tool to
  collect data you are not allowed to process.

- Briefs and reports word Reddit posters as community users (collected via
  Apify), never as "customers"; only questions you import yourself with
  `content import` are worded as customer questions.

Synthetic test fixtures include a fake `authorName` field specifically so
tests can verify that normalizers drop it
(`tests/fixtures/security/injection/reddit-dataset.json`).

## Analytics data

- GA4/GSC data is stored at report grain (for example page x date). Thresholding,
  sampling, and `(not set)` rows are recorded as such rather than filled in.
- Consent and tracking limitations are documented as limitations; the tool
  does not attempt to recover data users did not consent to share.
- Never create fake leads or purchases to test tracking in production.

## AI-citation observations (optional)

With `features.aiCitations` enabled, `ai-citations import` stores the AI
answers you captured yourself. The answer text, the cited URLs, and the row
as supplied go to a per-row record in the private raw store
(`<workspace>/data/raw/<site>/ai-citations/`, redacted); SQLite keeps the
engine, query, prompt, location, date, the grounded flag as you provided
it, the cited URLs, and the computed brand-mention and own-site-citation
flags. Nothing is fetched or sent anywhere. An answer can quote personal
data from the web; review a file before importing it.

## Where personal data could still appear

Even with minimization, some content may contain personal data you should be
aware of:

- crawled page text (for example staff names on your own site);
- business notes you write in the vault;
- free-text search queries in Search Console (Google anonymizes rare queries,
  but queries can still contain names);
- raw API responses kept for provenance in `<workspace>/data/raw/`;
- free text you type into audited records: approval and rejection reasons,
  `costs reconcile` evidence, `sync ga4 --confirm-rate-scale --evidence`,
  reviewer and author names (`--as`), and human draft revisions
  (`content revise-manual`); the audit log is append-only, so keep personal
  data out of these fields.

Keep the workspace private (mode 0700), encrypted at rest (full-disk
encryption), and out of shared folders.

## Retention and purge

Version 0.1.0 does **not** delete data automatically. You control retention.

| Data | Location | How to purge |
| --- | --- | --- |
| Raw API responses | `<workspace>/data/raw/` | Delete files older than your retention period (observations keep the reference; the raw file is then reported as unavailable). |
| Cached research | `<workspace>/data/cache/` | Delete the directory; it is rebuilt on demand (may cost money to refetch). |
| Reports, exports | `<workspace>/reports/`, `<workspace>/exports/` | Delete files you no longer need. `data export` writes inside `<workspace>/exports/data` by default; an explicit `--out` is refused inside the vault, `secrets/`, or the application repository outside the workspace (where a file could be committed). |
| Logs | `<workspace>/logs/` | Delete or rotate; logs are redacted but may contain URLs. |
| Diagnostics | `<workspace>/diagnostics/` | Delete after use. |
| Vector index | Qdrant storage (`<workspace>/qdrant/`) | Rebuildable: remove the collection or directory, then `npm run cli -- memory rebuild`. Memory documents support tombstones and purge with deletion propagation (see `docs/modules/memory.md`). |
| Vault notes | `<workspace>/vault/<site-id>/` | Edit or delete notes; generated notes are regenerated from SQLite. |
| Database | `<workspace>/data/seo-agent.sqlite` (mode 0600, with its `-wal`/`-shm` files) | Metrics, research, and audit history are authoritative and append-oriented (the audit log and the GA4 rate-scale confirmations are append-only by design). To remove a whole site's data, delete the workspace (after exporting what you need) or restore a backup from before the data existed. |
| Backups | `<workspace>/backups/` | Backups contain the database, site configs, vault, raw API responses, and reports by default (`backup --no-raw` / `--no-reports` skip the last two); purge old backups too, or deleted data persists in them. |
| Provider-side copies | Apify datasets/runs, DataForSEO task results, LLM provider logs | Governed by each provider's retention; delete them in the provider console if needed. |

To remove everything: stop any scheduled jobs, then delete the workspace
directory and revoke the credentials (Google: remove the app's access or delete
the OAuth client/service account; rotate or delete the other API keys).

## Diagnostics

`npm run cli -- diagnostics export` produces a redacted bundle that replaces
hostnames, URLs, property IDs, emails, and business/event names with keyed
hashes and contains no rows. **Inspect it before sharing**; it is never
uploaded automatically.
