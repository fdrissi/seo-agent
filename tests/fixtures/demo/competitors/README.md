# Demo competitor pages (SYNTHETIC)

Served in-process by the demo's fixture transport (`src/demo/fixtures.ts`) for the
reserved `competitor-N.example` hosts that the synthetic DataForSEO SERP fixture
returns. No network is used.

- `competitor-1.example`: `article.html` (contains a fake prompt-injection line that
  must be handled as untrusted data).
- `competitor-2.example`: robots.txt disallows everything, so the page is recorded as
  blocked (robots) and never fetched.
- `competitor-3.example`: answers HTTP 401 with `login.html`, recorded as a login
  barrier and never bypassed.
- `competitor-4.example`: answers HTTP 403 (access denied).
- every other host/path: 404.
