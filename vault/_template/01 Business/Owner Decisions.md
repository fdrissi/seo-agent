---
id: owner-decisions
type: owner_decisions
site: "{{site_id}}"
owner: human
tags:
  - seo-agent/business
---
# Owner Decisions

<!--
Human-maintained. Standing decisions that research and recommendations should
respect, for example "we do not target competitor brand queries".

FORMAT (checked by `npm run cli -- vault import-business`)
- Put every decision in the "## Decisions" list below, one bullet each:
    - YYYY-MM-DD: decision text
  The date must be a real calendar date. After the date use ":" (or "-").
  A bullet may continue on the next line if that line is indented by two or
  more spaces. Other headings in this note are ignored, and plain text under
  "## Decisions" is an error. Each decision can be up to 1,000 characters.
- The date is recorded as the decision date (00:00 UTC that day).

SUBJECTS (what a decision is about; found anywhere in the decision text)
- A full URL (http:// or https://) whose host is exactly one of the site's
  site.allowedHostnames. It is normalized. If the page is known (or known
  through an established URL alias), the subject is that page; otherwise it
  is the normalized URL. Punctuation at the end of the URL is dropped, so
  "https://<own-site>/page: reason" refers to https://<own-site>/page.
  URLs on any other host (a competitor, or a host variant that is not in
  site.allowedHostnames) are ignored.
- A page id such as page_01J... or an opportunity id such as opp_01J...,
  as shown by the CLI and in generated notes. It counts only if that page or
  opportunity exists for this site.
- If a decision names several subjects, each subject gets its own decision
  record.
- Search queries and keywords are NOT subjects. A decision that names only a
  query (for example "do not target <competitor> brand queries") and no URL,
  page_ id, or opp_ id applies to the whole site. It is kept as knowledge but
  never excludes a specific candidate.

WHICH DECISIONS EXCLUDE A CANDIDATE
A decision keeps its subject (page, URL, or opportunity) out of weekly
recommendations only if its text STARTS with one of these words: reject,
rejected, declined, deny, denied, dismiss, dismissed, defer, deferred, skip,
skipped, no action (also no_action and no-action), won't or wont (so also
won't do and wont_do), or not now (also not_now and not-now). Case does not
matter. Write "declined", not "decline": "decline" followed by more text is
not recognized. Example:
    - 2026-09-01: reject https://<own-site>/pricing: we keep the current copy
    - 2026-09-01: defer opp_01J...: revisit after the relaunch
If one of these words appears later in the sentence, it does not count, so
"approved: investigate the traffic decline" is not a rejection.

HOW LONG A DECISION APPLIES
Once imported (see IMPORT below), a decision in this note applies whatever
its age (the date in the bullet does not make it expire) until you delete
the bullet. A deleted bullet is withdrawn on the next
`npm run cli -- vault import-business --apply`, and from then on it no
longer excludes anything. Only decisions recorded from approvals or
rejections (for example `npm run cli -- approvals reject <id>`) use the
180-day window: the weekly recommendation step considers those from the
last 180 days.

IMPORT
`npm run cli -- vault import-business` validates this note and shows the
result. `npm run cli -- vault import-business --apply` records a version and
syncs the decisions into the database. Importing the same content again
changes nothing. A bullet you delete is withdrawn (with an audit record) on
the next --apply.

These decisions are recorded as knowledge (with version history). They never
authorize a production change. Approvals happen only through
`npm run cli -- approvals approve <id>`.
-->

## Decisions

