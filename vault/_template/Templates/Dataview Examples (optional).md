---
id: "dataview-examples"
type: human_reference
owner: human
tags:
  - seo-agent/optional
---
# Dataview examples (optional)

These snippets need the Dataview community plugin. The vault does not depend on
it: the generated dashboard, index, and pipeline notes are static Markdown that
work without any plugin. Without Dataview the blocks below show as code.

They use Dataview's query language only. Keep Dataview's JavaScript queries
(`dataviewjs` blocks and inline `$=` queries) disabled unless you need them:
generated notes contain third-party text. seo-agent escapes that text so it can
never form a query or a code block, but JavaScript queries you write yourself
run with full access to the vault.

Active experiments by review date:

```dataview
TABLE status, review_date AS "Review", implemented_at AS "Implemented"
FROM "06 Experiments"
WHERE type = "experiment" AND contains(list("approved", "awaiting_implementation", "observing"), status)
SORT review_date ASC
```

Content items by stage:

```dataview
TABLE stage, decision, priority_score AS "Priority"
FROM "10 Content Opportunities"
WHERE type = "content_opportunity"
SORT priority_score DESC
```

Protected pages:

```dataview
LIST url
FROM "02 Website/Pages"
WHERE type = "page" AND protected = true
```
