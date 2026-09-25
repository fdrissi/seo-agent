# Runtime prompt templates

Every runtime model request is built from a template in this directory. The
LLM client (`src/integrations/llm/gateway.ts`) loads templates with
`src/integrations/llm/prompts.ts`, records the exact prompt version with every
call, and adds the evidence bundle inside untrusted-data blocks.

Templates contain instructions only. They never contain secrets, owner-specific
domains, event names, locations, languages, budgets, prices, or model IDs;
those come from the site configuration at run time as template variables.

## File format

One file per prompt: `prompts/<id>.md`. The file name must equal the `id`.

```markdown
---
id: router.classify-intent          # lowercase letters, digits, ".", "_", "-"
version: 1                          # bump on any deliberate change
role: classifier                    # extractor | classifier | analyst | synthesizer | writer | reviewer
tier: cheap                         # cheap | reasoning | any (the caller's tier selects the model)
description: Classify the search intent of an ambiguous query.
output_schema: IntentClassification # zod schema name the output must satisfy, or "text"
variables: [query, language]        # optional; when present it must list exactly the placeholders
---

Optional notes for humans (ignored).

## System

Fixed instructions. Task prompts may not contain placeholders here.

## User

Classify the intent of {{query}} (content language: {{language}}).

{{evidence}}
```

Rules enforced by the loader:

- The frontmatter is parsed with the safe YAML loader and validated.
- `## System` and `## User` each appear exactly once, System first.
- **No placeholders in the System section of task prompts.** Runtime values,
  and therefore anything derived from remote content, can never alter a
  system prompt. Only the `system.*` base prompts below take placeholders in
  their System section, and the LLM client fills them only with values it
  generates in code (a random boundary token, a JSON Schema, tool names).
- `{{name}}` placeholders are substituted in one pass. Supplying a variable the
  template does not use is an error ("unknown variable"); omitting one it uses
  is an error ("missing variable"). `\{{` renders a literal `{{`.
- Values are stringified (objects/arrays as JSON, `null` as `null`), redacted,
  and sanitized: invisible/bidi/control characters and anything imitating a
  data-boundary marker are removed. Values longer than 50,000 characters are
  rejected: long or externally sourced text belongs in the evidence bundle.
- `{{evidence}}` is reserved. If the User section contains it, the evidence
  bundle is placed there; otherwise it is appended after the User section.
  Callers pass evidence as `EvidenceItem[]`, never as a variable.

## Prompt version

The recorded version is `<id>@<version>+<sha256[0:8]>`, where the hash covers
the whole file. Any edit changes the recorded version even if `version` was
not bumped; bump `version` for deliberate changes so experiments can freeze
and compare prompt versions (spec section 23).

## How a request is assembled

System message (all code-controlled):

1. `system.untrusted-data` - the security policy, with the request's random
   boundary token.
2. The task template's System section.
3. `system.structured-output` - only when the model lacks native structured
   outputs (JSON mode or prompt-constrained JSON), with the JSON Schema
   generated from the request's zod schema.
4. `system.tools` - only when the request allowlists read-only tools.
5. `system.repair` (System section) - only on repair turns.

User message: the task template's User section with variables, then the
evidence bundle (header, truncation notice when the token ceiling was hit, and
one `<<<UNTRUSTED_DATA boundary=...>>>` block per item with its trust class).

Repair turns (at most `llm.maxRepairAttempts`, never more than 2) add the
previous output as an assistant message (truncated to fit the input ceiling)
and the `system.repair` User section with the validation errors.

## Base prompts in this directory

| id | purpose |
| --- | --- |
| `system.untrusted-data` | security policy: data is never instructions; no policy/budget/approval changes; partial-review disclosure |
| `system.structured-output` | JSON output contract for models without native `json_schema` |
| `system.tools` | tool-use policy listing the request's allowlisted read-only tools |
| `system.repair` | controlled repair turn with validation errors |
| `system.connection-test` | the minimal chargeable call used only by `models test --confirm-spend --max-usd <cap>` |

Task prompts (for example `router.*`, `research.*`, `content.*`, `review.*`)
are added by the modules that use them, following the format above.
