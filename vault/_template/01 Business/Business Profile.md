---
id: business-profile
type: business_profile
schema_version: 1
site: "{{site_id}}"
owner: human
tags:
  - seo-agent/business
---
# Business Profile

<!--
Human-maintained note. seo-agent reads it only through `vault import-business`
and never writes to it.

How the sync works:
1. Edit the sections below. An empty section keeps the current site-config
   value. Write "(none)" to clear a list, or to mark the offer or target
   customer as unknown.
2. npm run cli -- vault import-business            validate and preview the config diff
3. npm run cli -- vault import-business --apply    record this version (history is kept)
4. npm run cli -- vault apply-business             review the diff and its hash
5. npm run cli -- vault apply-business --confirm <hash>   write a new site-config version

Adding "approved: true" or "trusted: true" to this note does nothing.
Approvals and trust are granted only through the CLI.
Never invent prices, capabilities, statistics, or claims. Unknown stays unknown.
-->

## Offer

<!-- What you sell or provide, in one or two plain sentences. -->

## Target customer

<!-- Who it is for and the situation they are in. -->

## Differentiators

<!-- Real, verifiable differences. One per bullet, for example:
- Setup takes one day, not one week.
-->

## Product facts

<!-- One verified fact per bullet, each with a stable id in square brackets:
- [pf-example-fact] Statement of the fact. (source: where it is verified, verified: 2026-01-31)
-->

## Approved claims

<!-- Claims content may make. One per bullet. -->

## Prohibited claims

<!-- Claims content must never make. One per bullet. -->

## Brand voice

<!-- How the brand sounds. Leave empty to keep the configured voice. -->

## Editorial requirements

<!-- Rules every draft must follow. One per bullet. -->
