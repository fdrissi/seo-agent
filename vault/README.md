# Vault template

`vault/_template/` is the public, synthetic-free template for a site's
Obsidian-compatible vault. It contains only folder structure, instructions, and
empty human-maintained note templates. It never contains real site data.

Real vaults live in your private workspace, never in this repository:

```
<workspace>/vault/<site-id>/        # default workspace: ~/seo-agent-workspace
```

Create or complete a site vault (existing files are never overwritten):

```
npm run cli -- vault init --site <site-id>
```

Then:

```
npm run cli -- vault render            # generate notes from the SQLite database
npm run cli -- vault check             # broken wikilinks, conflicts, malformed notes
npm run cli -- vault import-business   # validate "01 Business" notes and preview config changes
```

Placeholders filled by `vault init` in notes outside `Templates/`:
`{{site_id}}` and `{{business_name}}`. Files in `Templates/` keep Obsidian's own
core-Templates placeholders (`{{title}}`, `{{date}}`) untouched.

See `docs/modules/obsidian.md` for the ownership model, the conflict workflow,
and the business-note sync.
