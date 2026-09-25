# ADR 0007: Approvals are bound to the exact artifact hash and revision

- Status: Accepted
- Date: 2026-09-24

## Context

Production actions (publishing, redirects, merges, deletions, canonical,
robots, or analytics changes) require explicit human approval. An approval
must authorize exactly the proposal the human reviewed, not a later edited
version, not another page, and not twice. Markdown notes are editable by
anyone with file access and by generated content, so a note saying
`approved: true` cannot be an authorization. Policy must live in code, not in
LLM instructions (spec section 24).

## Decision

- An approval (`src/approvals/service.ts`, `ApprovalGate`) is bound to: site,
  action type, target, subject, artifact hash, source revision (when given),
  requester, approver, expiry (default 168 hours, maximum 720), and a
  one-time execution state.
- The artifact hash is `computeArtifactHash` over a versioned canonical form
  of the action type, target, and exact change (`ARTIFACT_HASH_VERSION`).
  Any change to the proposal changes the hash and invalidates the approval.
- Approving requires a named human who types the first 8+ characters of the
  hash shown by `approvals show`. The name is asserted, not authenticated:
  obvious automation and account names (and a service-account
  operating-system user as the default) are refused (`src/approvals/approver.ts`).
- Execution rechecks the live target first (SSRF-safe fetcher), refuses a
  changed source revision, consumes the approval exactly once (atomic even
  across processes), and records everything in the append-only audit log.
- Runtime modes are enforced by `assertAllowed` in `src/approvals/policy.ts`:
  ANALYZE and RESEARCH never execute production actions; EXECUTE additionally
  needs a valid bound approval. The policy takes no free text.
- Frontmatter properties such as `approved`, `trusted`, or `trust_class` in
  vault notes are ignored and reported.
- The same binding pattern covers draft generation (bound to the brief hash),
  batch expansion, paid requests with unknown prices (bound to the request
  hash and maximum charge), and learning promotion.

## Consequences

- Editing a draft or change after approval forces a new approval: safe, but
  pages with dynamic main content can trigger needless re-approvals.
- The tool cannot read a site's real source revision; the human supplies it,
  and approving an unbound production change needs an explicit, recorded
  acknowledgment.
- Approvals are auditable and cannot be replayed.

## Alternatives considered

- A boolean "approved" flag on the proposal: replayable and spoofable.
- Approval by an LLM reviewer: not an access-control mechanism (spec 24).
- Signatures with owner keys: stronger identity, but key management is out of
  scope for a single-owner local tool; the audit log plus file permissions
  are the v1 boundary.

## References

- `src/approvals/service.ts`, `src/approvals/artifact.ts`, `src/approvals/policy.ts`, `src/approvals/target-check.ts`
- `tests/unit/approvals/service.test.ts`, `tests/unit/approvals/policy.test.ts`, `tests/integration/approvals/export.test.ts`, `tests/integration/approvals/concurrent-consume.test.ts`, `tests/integration/obsidian/writer.test.ts`
- `docs/modules/experiments-approvals.md`, `docs/SECURITY_MODEL.md` section 4
