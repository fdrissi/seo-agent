# Pipeline fixtures (SYNTHETIC)

Everything here is synthetic, written for the offline demo and the pipeline
integration tests. No real site content and no third-party scraped data.

- `site/`: a small synthetic website served by `fixtureSiteTransport` (see
  `src/crawler/transport.ts`) for demo-profile crawls. Page paths match the
  synthetic Google fixtures in `tests/fixtures/google` (`/`, `/pricing`,
  `/blog/how-to-choose-a-widget`, ...). Links are relative, so the site works
  under any reserved host (`www.example.com`, `www.example.test`). Every crawl
  of it is stored with `is_synthetic = 1` and `render_mode = 'fixture'`.
- `competitors/`: synthetic competitor pages served by a fixture transport in
  tests (reserved `*.example` domains produced by the synthetic DataForSEO
  SERP transport). One of them contains a fake prompt-injection line that must
  be treated as data.
