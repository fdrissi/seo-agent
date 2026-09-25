# Security fixtures (SYNTHETIC)

Everything in this directory is fabricated for tests. It contains no real
website, person, brand, analytics data, or credential. Hosts are reserved
names (`*.example`, `*.test`, `*.invalid`).

## `injection/`

Prompt-injection payloads generated from `src/security/injection-fixtures.ts`:

| File | Use it to test |
| --- | --- |
| `competitor-page.html` | crawler/extractor and competitor-analysis prompts (hidden elements, HTML comments, meta tags, JSON-LD, scripts, unsafe link schemes, chat-template tokens, bidi, Unicode tag smuggling, variation-selector "emoji" smuggling) |
| `reddit-dataset.json` | Apify/Reddit normalization and content-signal extraction (includes a synthetic `authorName` that normalizers must drop) |
| `serp-response.json` | SERP adapter/analysis (injections inside API text fields) |
| `vault-note-fake-approval.md` | vault sync and approval spoofing (`approved: true` in frontmatter authorizes nothing) |
| `fixtures.json` | every fixture with id, channel, vectors, canary, forbidden effects, and expected handling (including invisible fillers such as Hangul fillers and U+061C, and fullwidth/homoglyph instructions that detection folds with NFKC and a confusable skeleton) |

Each payload embeds a unique canary (`SEOAGENT-CANARY-...`). The canary may
appear inside a delimited untrusted-data block, but never in a system prompt,
tool call, approval, budget/config change, outbound request, or published
artifact. Use `findCanaryLeaks()` from the library to assert that.

Do not edit these files by hand. Regenerate after changing the library:

```sh
UPDATE_SECURITY_FIXTURES=1 npx vitest run tests/unit/security/injection-fixtures.test.ts
```

## Secret-scan tests

Secret-shaped values used by `tests/*/security/*secret*` are generated at test
runtime (random, never committed), so this directory never contains anything
the secret scanner would flag.
