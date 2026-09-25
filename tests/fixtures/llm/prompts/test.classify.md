---
id: test.classify
version: 3
role: classifier
tier: cheap
description: SYNTHETIC test prompt that classifies a query's intent from evidence.
output_schema: Classification
variables: [query, language]
---

Test fixture (synthetic). Not a production prompt.

## System

You classify the search intent of one query for a website. Use only the evidence provided.

## User

Query: {{query}}
Content language: {{language}}

Classify the intent as informational, commercial, transactional, or navigational, with a confidence between 0 and 1 and the evidence ids you relied on.
