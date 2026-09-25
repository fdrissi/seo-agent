# Demo fixtures (SYNTHETIC)

Everything here is synthetic and describes fictional businesses on reserved
example domains (`example.com`, `*.example`, `*.example.test`). Nothing was
recorded from a real website, search engine, analytics property, or community.

- `site.yaml`: the demo site configuration (profile `demo`) that `npm run demo`
  copies into its isolated demo workspace.
- `competitors/`: synthetic competitor pages served in-process to the demo's
  competitor crawler (article with a fake injection line, robots.txt block,
  login barrier, access denial). See `competitors/README.md`.
- `apify/dataset.json`: synthetic Reddit-like dataset items (no authors, no
  real posts) ingested with `ingestSyntheticDataset` (flagged `is_synthetic = 1`).
- `budget-prices.json`: SYNTHETIC per-request prices (not any provider's real
  prices) that the demo's budget step uses to exercise the real
  reserve -> reconcile path with a lowered per-run cap. Nothing is sent or charged.
- `empty-site/`: brand-new synthetic sites for the honest-status end-to-end
  tests: `google/` (Google fixture datasets with no rows at all), `google-small/`
  (a handful of daily impressions, below the low-data threshold), and a
  two-page `site/`. They check the LOW_DATA bootstrap and that no metric is
  invented.

The own-site pages and the Google Search Console / GA4 fixtures the demo
ingests are the shared synthetic fixtures in `tests/fixtures/pipelines/site`
and `tests/fixtures/google` (the same ones every demo-profile command uses).
