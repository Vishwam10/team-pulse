# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**Pilot active.** A macOS **launchd** LaunchAgent (`com.chronus.teampulse`, daily 12:05 PM IST → `run-digest.sh` → `claude -p`) runs the digest ~25 minutes before the user's 12:30 PM scrum standup (headroom for the run) — with no Claude Code session open. This replaced the original in-REPL `CronCreate` job `01e22275` (now retired: it required an open REPL and auto-expired after 7 days). The 3-day pilot validates with 2 teammates (Vishwam + Kedar) in `team.json` before expanding to 8. See `README.md` for the overview and `RUNBOOK.md` for operating the automation.

The observable signals each day: the **Google Chat** digest (a threaded set of cards in the Space) and a new row appended to the Google Sheet ("Vishwam - tracker"); each run also writes `logs/YYYY-MM-DD.log`. Read these to evaluate narrative quality, signal accuracy, and delivery reliability.

To run manually (e.g., after re-auth, or to test changes): in Claude Code from this directory, ask *"Read digest.md and execute its instructions exactly."*

## Architecture

Approach A from `design.md` is in effect: one prompt (`./digest.md`) does everything via MCPs and curl. No build system, no `package.json`, no `.venv` — the "executable" is a markdown prompt. Approaches B and C from `design.md` remain explicitly rejected; do not scaffold conventional build systems.

### What's changed from design.md

| Decision | Original | Current |
|---|---|---|
| Sheet write path | `mcp__claude_ai_Google_Drive` | **Apps Script web app** with RichTextValue support (Drive MCP is read-only for existing files) |
| State / delta cache | `~/.team-pulse/state.db` (SQLite) | **Dropped** — the sheet *is* the database |
| Prompt location | `~/.claude/team-pulse/digest.md` | `./digest.md` (project folder) |
| Idempotency | Same-day re-runs idempotent | **Dropped** — multiple runs/day allowed, each appends a new row |
| Date column | `YYYY-MM-DD` text | Typed Date, displayed via Apps Script `setNumberFormat('dd mmm yyyy, hh:mm AM/PM')` |
| Output framing | Triage (only flagged people surfaced) | **Audit/briefing** (every teammate, every run, comparable across days) |
| Cell formatting | Plain text | **RichTextValue** — bold, italic, underline, strike, color, font size, hyperlinks |
| Schedule time | 8:00 AM | 12:05 PM IST (ahead of the 12:30 standup, headroom for the run) |
| Scheduler | `CronCreate` (in-REPL) | **launchd LaunchAgent** `com.chronus.teampulse` → `run-digest.sh` → `claude -p` (no open session needed); old cron retired |
| Delivery sink | Slack channel | **Google Chat `cardsV2`** — threaded cards (header + one per teammate + closing) via webhook curl. Slack text kept as automatic fallback when `gchat_webhook_url` is unset |

### Persistence via Apps Script web app

The bound Apps Script in the sheet exposes `doPost` (append row with rich formatting) and `doGet` (read column) endpoints, secret-gated. Source lives in `apps-script.gs`; deployed as a web app inside the sheet. Runs as the user's Google identity — no service account, no GCP project, no token management.

Column 1 (date) is set as a typed Date with a display format. Columns 2..N parse extended-markdown into RichTextValues for inline formatting and links.

**Curl gotcha (do not retry on apparent failure):** Apps Script returns a 302 redirect; curl follows it and may receive either a "Page not found" HTML body or HTTP 4xx (commonly 405). Both are normal. The row lands on the first hop. Step 6 of the prompt verifies via row-count delta — never retry the POST.

**Re-deploy gotcha:** Apps Script's UI silently lets you create new deployments (each with a new URL) instead of updating the existing one. The only path that updates the live URL referenced by `config.json` is **Manage deployments → pencil icon on the deployment whose URL ends in `H_BhLw/exec` → Version: New version → Deploy**. "New deployment" creates a fresh URL and the live one keeps serving stale code.

### Extended-markdown formatting

The Apps Script parser handles a markdown subset for cells in columns B+ (never column A):

| Syntax | Effect |
|---|---|
| `**bold**` | Bold |
| `*italic*` | Italic — **only `*`, never `_`** (single underscore would mangle `pr_no_reviews` etc.) |
| `__underline__` | Underline (double underscore) |
| `~~strike~~` | Strikethrough |
| `[red]...[/red]` | Red text — also `green`, `blue`, `gray` |
| `[big]...[/big]` | 14pt font |
| `[text](url)` | Hyperlink, clickable in cell |

Chat sinks need their own rendering, so Step 7 of `digest.md` converts this subset per sink. **Colour/size strip runs before the link rule** — otherwise `[gray](3h)` is mis-read as a `[text](url)` link:
- **Google Chat (primary):** the committed **`render_cards.py`** owns the conversion (`to_card_html` → the card HTML subset `<b> <i> <u> <s> <font color> <a href> <br>`) **and** the `cardsV2` build + threaded POST. The agent only emits a content JSON and runs the script, so the formatting can't drift run-to-run (hand-building it inline kept producing escaped/half-converted tags).
- **Slack (fallback):** `to_chat` → `mrkdwn` (`*bold*`, `_italic_`, `<url|text>`); colour dropped.

### Two-phase prompt

`digest.md` is structured as:
- **Phase 1 (deterministic):** MCP calls + threshold rules from `config.json` → structured `signals` object per teammate. No prose.
- **Phase 2 (LLM):** signals → team header + per-person briefing.

If counts or dates ever look wrong, suspect Phase 1 logic before LLM hallucination.

## Code Layout

```
design.md          Original spec — source of truth for "why"
README.md          Project overview, architecture diagram, services table
CLAUDE.md          This file
config.json        Sheet ID, Slack channel, Google Chat webhook, Apps Script URL+secret, atlassian_base_url, thresholds, in_progress_statuses, queued_status_groups
team.json          Identity map: {name, github_login, jira_account_id} per teammate
config.example.json  Committed placeholder template — copy to config.json and fill in (real config.json is git-ignored)
team.example.json    Committed placeholder template — copy to team.json and fill in (real team.json is git-ignored)
apps-script.gs     Source of the deployed Apps Script (paste into Extensions → Apps Script in the sheet)
digest.md          The prompt — the executable
render_cards.py    Deterministic Google Chat card renderer + poster (digest Step 7 writes a content JSON, then runs this)
run-digest.sh      Wrapper launchd runs: invokes claude -p, writes the per-day log
com.chronus.teampulse.plist   launchd LaunchAgent (12:05 IST); canonical copy, deployed to ~/Library/LaunchAgents/
RUNBOOK.md         How to activate & operate the automation
SETUP-CHECKLIST.md Go-live checklist (settings.json, launchd, webhook)
logs/              Per-day run logs (YYYY-MM-DD.log; git-ignored, contains names) + example-run.log.txt (committed, sanitized sample of one run)
.claude/settings.json   Permission allowlist so the headless run never blocks on a prompt
.gitignore         Keeps config.json, team.json, and *.log out of git (the .example.json files are the committed stand-ins)
```

No `~/.claude/team-pulse/`, no `~/.team-pulse/`, no SQLite. Everything lives in this directory.

## Hard rules

- **No PII in `digest.md`.** Names, emails, GitHub logins, account IDs, channel IDs, project keys all live in `config.json` / `team.json`. The prompt is a generic template — do not hardcode identifiers.
- **Sheet column order = `team.json` array order.** When growing the team: add a `team.json` entry *and* add a sheet column header in the same position.
- **`apps_script.url` + `apps_script.secret` and `gchat_webhook_url` are credentials.** Treat like passwords (the Chat webhook URL embeds a `key` + `token`). `config.json` and `team.json` are git-ignored — never commit the real files; the `.example.json` templates are the committed stand-ins.
- **Threshold tuning is in `config.json.thresholds`; status names in `config.json.in_progress_statuses` (active) and `config.json.queued_status_groups` (the not-started / in-QA / delivered split).** Never edit these in the prompt.
- **Narrative tone is descriptive, not judgmental.** "Quiet yesterday — worth a check-in" ✅. "Underperforming" ❌. The audit conclusion is the SM's, not the tool's.
- **Apps Script re-deploys MUST update the existing deployment** (Manage deployments → pencil → New version), never "New deployment". Otherwise the live URL serves stale code.

## MVP Boundaries (resist scope creep)

In v1: five blocker signals (`jira_idle`, `pr_no_reviews`, `pr_author_unresponsive`, `overloaded`, `explicit_block`), four risk signals (`silent`, `underloaded`, `stalled_pr`, `bottleneck`), positive output signals, hyperlinks for ticket IDs and PR identifiers.

**Not** in v1: Slack message scraping, Calendar, web dashboard, trend detection (cross-day), per-person thresholds, sprint-aware filtering, automatic re-auth.

## LLM Choice

Synthesis happens **in-band** — whichever Claude model runs `digest.md` does the synthesis as part of the same execution. No separate `messages.create` call. The scheduled run **pins** the model + reasoning via `run-digest.sh` flags — `--model claude-sonnet-4-6 --effort medium` — chosen because Sonnet 4.6 is much faster than the default Opus 4.8 while keeping the judgment the pilot relies on (running on the Opus default made model-generation ~75% of a 16–35 min run). `config.json.llm` documents this. Manual in-session runs use whatever model you've selected.

## Pilot Before Scale

The launchd LaunchAgent runs the 2-person digest at 12:05 PM IST daily (see `RUNBOOK.md`). **Hard gate before expanding to 8:** validate over 3 mornings on identity mapping accuracy, signal honesty (false-positive rate stays low enough that trust holds), narrative usefulness (saves ≥30s per teammate during prep), and delivery reliability (does it actually land before 12:30?).

When ready to expand: add 6 entries to `team.json` in the order they should appear as sheet columns, add 6 column headers to the sheet, no other code change.

## Privacy Posture (solo tool)

Single-user tool. Sheet is owned by the user; the Apps Script runs as the user's identity. The data sources by construction exclude DMs, private channels, and personal calendars — preserve that boundary when extending.

## Risks still in play

1. **Scheduler reliability (resolved → new dependency)** — moved off in-REPL `CronCreate` (needed an open session, no catch-up of missed runs, 7-day expiry) to a **launchd LaunchAgent** that fires headlessly and never expires. New dependency: the Mac must be awake at 12:05 (a `pmset repeat wake` is set; scheduled wake is unreliable lid-closed on battery). If laptop availability becomes the failure mode, the same `run-digest.sh` moves to an always-on box unchanged. Runs take ~15–35 min (heavy JQL pagination; longer if it falls back to `gh`), so it fires at **12:05** to land before the 12:30 standup — though a slow run can still spill past it. See `RUNBOOK.md`.
2. **~~Cron 7-day auto-expiry~~ (resolved)** — was the `CronCreate` limit; launchd has no expiry. Job `01e22275` already expired and is retired.
3. **Atlassian re-authentication** — OAuth tokens persist but can be invalidated by Chronus IT policy or token revocation. Step 0.5 of `digest.md` detects this (only `authenticate` / `complete_authentication` tools visible) and posts an alert. User runs `mcp__plugin_atlassian_atlassian__authenticate` manually to recover. *(Note: the abort/alert paths in Steps 0/0.5/Error-handling still post to the Slack channel even though the digest output now goes to Google Chat — a pending tidy-up to route alerts to the Chat webhook too.)*
4. **Confluence access** — User's Atlassian account has no Confluence seat (returns 403). `confluence_edits_7d` is permanently `unavailable`; Step 1 soft-fails. If a Confluence seat is added later, behavior auto-recovers.
5. **JQL response size** — Open-ticket queries can exceed the MCP's 25K-token result cap for users with many in-flight tickets. Agent reads from the saved-file fallback via `jq`. If this becomes routine, add pagination (`maxResults: 25`) in Step 1.
6. **Narrative drift / quality** — First runs of the new schedule calibrate; budget 2-3 prompt revisions in the first week.
