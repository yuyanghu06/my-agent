# Memory

Durable facts the agent has learned about Yuyang and his world. Updated by the agent itself; readable and editable by Yuyang directly. Re-loaded into context whenever the agent session restarts.

## People

_(empty — agent will append entries like "Eric Lin — prefers email over Slack, NYU CS '26, met at Tech@NYU")_

## Preferences

- 2026-05-23 — All durable memories, learned behaviors, and "from now on when X" rules go in this MEMORY.md (git-tracked, syncs across devices via GitHub). Do NOT write to `~/.claude/projects/.../memory/` auto-memory files for this project — those are local-only and won't port between machines. Migrate existing auto-memory entries here when relevant.

- 2026-05-09 — **Work TODO routing.** When Yuyang says he needs a task done (work-related), append it to the **Work TODO** Apple Note (`x-coredata://342B8E4D-3013-434A-91EA-1BF239F34B6D/ICNote/p450`) under the appropriate section (top list, Tech / Product, or Caleb). Don't ask. Engineering items → Tech / Product subsection; otherwise top list.

- 2026-05-10 — **Daily Work TODO note.** Each work morning Yuyang brainstorms his TODO list with the agent. Create a **new** Apple Note titled `M/D Work TODO List` (e.g. `5/11 Work TODO List`, no leading zeros, US-style) in the same folder as the master Work TODO note. Use HTML body via osascript so formatting renders. Master Work TODO (p450) remains the backlog sink; the daily note is the plan drawn from it. Human-triggered each morning — no cron.

- 2026-05-09 — **Apple Notes formatting.** The apple-notes MCP collapses HTML/newlines and ignores `title`. For any formatted note (headers, bullets, bold) write via AppleScript: `tell application "Notes" / set body of targetNote to "<div><h1>...</h1></div><ul><li>...</li></ul>"`. Run with `osascript /tmp/script.applescript`. Use `&amp;` for `&`. Use the MCP only for plaintext appends where formatting doesn't matter.

- **Linear default state = Todo.** Every `mcp__linear__save_issue` that creates a new issue should include `state: "Todo"` unless user asks for Backlog/other, or context makes clear it's long-horizon. Don't leave state unset (falls back to Backlog). Don't touch state when updating existing issues unless asked.

- **No em dashes / sound human.** Never use em dashes (—) in deliverables (emails, SMS, IG captions, partnership outreach, etc.). Use commas, periods, parentheses, line breaks. Avoid AI-tells: no "hope this finds you well", "just wanted to reach out", "thrilled to", "exciting opportunity"; no over-hedging; contractions preferred; match Yuyang's casual texting tone. Applies to deliverables only — em dashes are fine in chat with Yuyang.

- **Partnership / BD outreach — phone first.** For partnership outreach (temp agencies, gig platforms, similar) the primary contact column is phone or booking URL. Email is fallback only; flag email-only targets so Yuyang can decide.

- 2026-05-19 — **Weekly Invoice workflow.** "Add X to invoice" → append line item to Apple Note "Weekly Invoice" (`x-coredata://342B8E4D-3013-434A-91EA-1BF239F34B6D/ICNote/p467`) and update running total. Don't ask. On "finalize":
  1. Read Weekly Invoice note.
  2. Duplicate canonical template INVOICE 2026-002 (`1CBV7i-6o0-5A7OdvaHM3cOIGddRTuw1h2CFr9EYsrmU`, personal1 Drive). Always copy 2026-002, not a chained copy. Name next sequential (latest as of 2026-05-19 is 2026-003 `1XLqESXPnvQuKemL40h_ufCvDanFh4JPKCT6REm1YNFU` → next is 2026-004).
  3. Use `findAndReplace` (preserves table styling). Don't use `replaceDocumentWithMarkdown`. Pass literal characters, not HTML-escaped.
  4. Line items table has 3 rows; no API to insert rows. Stack multiple values inside a single cell using real `\n` newlines via `findAndReplace` — description and amount columns line up row-for-row.
  5. After doc write succeeds, wipe Weekly Invoice note back to empty template (line-items + Total: $0.00).

- **Craigslist listings tracker.** When Yuyang pastes a Craigslist listing (URL, title, or screenshot), append a row to `~/Documents/MicroAGI/craigslist_listings.csv` without asking. Columns: Type of Listing, Listing Name Style, Link. Infer type ("gig", "job", "etc/misc") and style (headline pattern, e.g. "POV / curious / direct ask"). Leave unclear fields blank. Append-only.

- **IG post brainstorming → Apple Note.** All brainstorming, architecture notes, decisions, design changes for SHI-121 "Programmatic Instagram / Reel Content Generation" go to Apple Note **"Programmatic IG Post Generation — Brainstorm"**. Don't ask. Each topic gets one continuous section — merge new content into existing sections in place, don't append dated sections at the end. Read current body first via osascript so unrelated content is preserved. Use HTML formatting via osascript.

## Ongoing context

- 2026-05-13 — **Post-Generator workflow (IG job posts):** cd `~/Documents/microagi/internal_tooling/Post-Generator`, run `claude`, then `/post {job JSON}`. Returns (1) IG caption code block, (2) Figma deep-link to a new page on "Daily Output" named `YYYY-MM-DD — <title>` with master template duplicated + filled, (3) fill summary. Asset picker matches `assets/library/manifest.json` by category/keyword overlap; no match = text-only. New assets: drop in `assets/raw/`, run `bash scripts/process-asset.sh raw/foo.png assets/library/foo.png`, upload to Figma, append to manifest. Full recipe in Post-Generator's CLAUDE.md.

- **MicroAGI internal tooling layout.** `~/Documents/MicroAGI/internal_tooling/` is the canonical home for all infra work. Three sub-projects:
  - `usa-microps/` — Next.js webapp, hosts ALL backend keys (Supabase, GHL, Google, Calendly). Also backend for iOS app. Default destination for new middleware/webhooks.
  - `fieldagi/` — Swift/SwiftUI iOS app for field operators. No keys; talks to usa-microps API.
  - `shift-landing-usa/` — public marketing/applicant site (joinshift.us). Walled off; only seam is shared GHL contact pool.
  Always read each project's `CLAUDE.md` (and `usa-microps/docs/`) before writing code. Never create top-level folders under `~/Documents/MicroAGI/` for new tools — integrate into existing repos.

- **Shift recruiting — channels already tried and ruled out:** dscout, Prolific (registration friction), Reddit r/Brooklyn + NYC subs (rules too restrictive), Patch (no volume), community Facebook groups (gatekeeping), physical flyering (blocked on manpower — candidate for outsourcing). Skip these when brainstorming. Push toward self-serve / non-gatekept / trust-network channels (WeChat, churches, gig platforms with reputation systems, university job boards, third-party panel recruiters).

- **Shift — platforms already integrated.** Jobget and any Jobget-owned subsidiaries are already on Shift (Monica owns the relationship via Harry). Exclude from temp-agency / gig-platform outreach lists for Shift B2C recruiting (e.g. SHI-82). Put in a "skip — already integrated" section.

- **Personal AI Productivity OS — north star architecture.**
  - **Brain (Mac Mini, always-on):** persistent Claude Code daemon, all MCP servers connected globally, Unix socket comms, Tailscale-reachable, processes transcripts/extracts tasks/compiles nightly digests.
  - **MCP servers at daemon level:** Google (Calendar/Gmail/Drive) ×4 accounts via local proxies on ports 47301–47304 (yh5525@nyu.edu, sincerepuppet16@gmail.com, yuyhu1245@gmail.com, yuyang@micro-agi.com); Apple Calendar + Notes (unified); Linear.
  - **Interface (laptop):** Raycast spotlight UI, talks to daemon over socket.
  - **Capture (Plaud Note + iOS app):** Plaud records w/ diarization; iOS app (in dev) is edge node — BT receive, offline cache, stream to Mac Mini when online; APNs push from Mac Mini for digests.
  - **Future:** Meta glasses for ambient audio overlay; other capture/automation TBD.
  - **Principle:** phone = edge cache + notification; Mac Mini = always-on brain; Claude = reasoning layer. Local-first, private, MCP-driven. Favor choices that fit this when planning features/infra/hardware.

## Decisions and commitments

_(empty)_
