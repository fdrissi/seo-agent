# Google fixtures (SYNTHETIC)

Everything in this directory is synthetic test data. None of it was recorded
from a real Search Console or GA4 property, and none of it describes a real
website. Domains use the reserved `example.com`, `example.net`, and
`example.test` names.

- `gsc/sites.json`: synthetic `sites.list` response (permission levels).
- `gsc/dataset.json`: definitions the fixture provider uses to generate
  deterministic `searchAnalytics.query` responses for any date range
  (fresh vs final data, partial recent days that later change, anonymized
  query share, byProperty vs byPage totals).
- `gsc/inspections.json`: synthetic URL Inspection (indexed-state) results.
- `ga4/metadata.json`: synthetic `getMetadata` response that lists
  per-event metrics for the key event `generate_lead`.
- `ga4/metadata-no-primary.json`: synthetic metadata WITHOUT per-event
  metrics and with revenue metrics blocked (`NO_REVENUE_METRICS`), for the
  "primary-event rate unavailable" path.
- `ga4/dataset.json`: definitions for deterministic `runReport` responses,
  including a `(not set)` landing page, thresholding metadata, non-additive
  users, and property quota.
- `oauth/*.json`: synthetic OAuth client files (fake IDs and secrets that
  are not valid anywhere).

Small hand-written responses in the documented shapes (pagination,
revisions, missing days, error bodies) live inline in
`tests/integration/google/*.test.ts`. Service-account keys used by tests are
generated at runtime and never committed.

Every JSON file carries `"_synthetic": true`; the fixture provider refuses
files without it.
