# Synthetic business-note fixtures

SYNTHETIC test data for `src/obsidian/business-sync.ts`. Not a real business,
not real owner decisions, and not real customer questions. Used by
tests/integration/obsidian/business-sync.test.ts.

Every file in this directory is SYNTHETIC:

| File | What it is |
| --- | --- |
| `profile.valid.md` | SYNTHETIC well-formed business profile of a fictional clinic-scheduling product (reserved `example.test` domain) |
| `profile.invalid.md` | SYNTHETIC malformed business profile (bad lists, duplicate ids, invalid dates) |
| `profile.spoofed.md` | SYNTHETIC profile whose frontmatter tries to approve itself (`approved`/`trusted` flags must authorize nothing) |
| `profile.unsafe-yaml.md` | SYNTHETIC profile with unsafe YAML tags that must be rejected |
| `decisions.valid.md` | SYNTHETIC owner-decisions note |
| `questions.valid.md` | SYNTHETIC customer-questions note |

The `.md` fixtures deliberately start with YAML frontmatter (the parser under
test requires it), so they carry no header comment; this README is their label.
Add any new fixture here to the table and keep it synthetic.
