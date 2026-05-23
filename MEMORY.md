# Memory

Durable facts the agent has learned about Yuyang and his world. Updated by the agent itself; readable and editable by Yuyang directly. Re-loaded into context whenever the agent session restarts.

## People

_(empty — agent will append entries like "Eric Lin — prefers email over Slack, NYU CS '26, met at Tech@NYU")_

## Preferences

_(empty)_

## Ongoing context

- 2026-05-13 — Post-Generator workflow (IG job posts): cd `~/Documents/microagi/internal_tooling/Post-Generator`, run `claude`, then `/post {job JSON}`. Returns (1) IG caption code block, (2) Figma deep-link to a new page on "Daily Output" named `YYYY-MM-DD — <title>` with master template duplicated + filled, (3) fill summary. Asset picker matches `assets/library/manifest.json` by category/keyword overlap; no match = text-only. New assets: drop in `assets/raw/`, run `bash scripts/process-asset.sh raw/foo.png assets/library/foo.png`, upload to Figma, append to manifest. Full recipe in Post-Generator's CLAUDE.md.

## Decisions and commitments

_(empty)_
