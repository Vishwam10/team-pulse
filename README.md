# Team Pulse

A daily, automated **scrum-master briefing**. Shortly before standup it looks
at each teammate's Jira and GitHub activity, decides what's worth attention
(idle tickets, PRs sitting without review, overload, blockers…), writes a
rich-formatted **audit row** to a Google Sheet, and posts a human-readable
**digest** to the team chat — so the SM walks into standup already knowing where
the friction is.

It is deliberately **not** a conventional app. There is no build system, no
`package.json`, no server. The "executable" is a single prompt — [`digest.md`](digest.md) —
that an LLM agent (Claude Code) reads and carries out end to end. See
[`design.md`](design.md) for *why* (this is "Approach A") and [`CLAUDE.md`](CLAUDE.md)
for the operating contract and hard rules.

---

## What it produces, each run

1. **A Google Sheet row** ("audit/briefing" mode): one column per teammate, every
   run, comparable across days — bold/colour/links via rich text.
2. **A Google Chat post**: the same briefing as a threaded set of **cards** — a
   team-summary header card, one colored card per teammate (status icon, sections,
   action buttons), and a closing card — in the standup Space. (Slack text is the
   fallback if no webhook is configured.)
3. **A per-day log file** under [`logs/`](logs/): `logs/YYYY-MM-DD.log`, one file
   per day, each run appended as a timestamped block ending in `✅ RUN FINISHED OK`
   or `❌ RUN FAILED`.

---

## Architecture & data flow

```
  ┌─ SCHEDULE ──────────────┐
  │ launchd  (12:05 IST)     │   ← OS-level cron; no open session needed
  │   └─▶ run-digest.sh      │   ← wrapper: sets PATH, logs the run
  └───────────┬──────────────┘
              │ runs
              ▼
  ┌─ THE BRAIN ───────────────────────────────────────────────┐
  │ claude -p  ──reads──▶  digest.md  (the prompt = the program)│
  │                                                             │
  │  Phase 1 — DETERMINISTIC gather + threshold rules           │
  │  Phase 2 — LLM synthesis (signals → narrative)              │
  └───┬───────────────────────────┬───────────────────┬────────┘
      │ gather (READ-ONLY)         │ persist           │ deliver
      ▼                            ▼                   ▼
  ┌──────────────┐   ┌──────────────────────────┐   ┌─────────────────────────┐
  │ Jira    (MCP)│   │ Apps Script web app       │   │ Google Chat (webhook)   │──▶ standup
  │ GitHub  (MCP)│   │  • doPost → append row    │──▶│  threaded cardsV2 cards │    Space
  │ Confluence MCP   │  • doGet  → read column   │   │  (Slack text = fallback)│
  └──────┬───────┘   └────────────┬──────────────┘   └─────────────────────────┘
         │                        │  ▲                          
         ▼                        ▼  │ row-count verify (doGet)  
   signals per person      Google Sheet  ("…- tracker")         
   → synthesized briefing   (the database + audit trail)        
         │
         └────────────────────────────────────────────────▶ logs/YYYY-MM-DD.log
```

**Two-phase design** (see [`digest.md`](digest.md)): Phase 1 is pure data + the
threshold rules from `config.json` → a structured `signals` object per teammate
(no prose). Phase 2 turns those signals into the briefing. If counts ever look
wrong, suspect Phase 1 before LLM hallucination.

---

## Services it depends on, and what each is for

| Service | Role in Team Pulse | How it's reached |
|---|---|---|
| **Claude Code** (CLI) | The runtime / "brain" — reads `digest.md` and executes all 9 steps, including the synthesis. | `claude -p "…"` |
| **Atlassian Jira** | Primary data source: open tickets, recent activity, blocked tickets → ticket signals (`jira_idle`, `overloaded`, `explicit_block`, queue depth). | Atlassian MCP (read-only JQL) |
| **Atlassian Confluence** | Doc-edit activity (`confluence_edits_7d`). **Currently unavailable** — the account has no Confluence seat, so it returns 403 and the digest soft-fails this field. | Atlassian MCP (CQL) |
| **GitHub** | Primary data source: PRs (open/merged/draft), commits, reviews given & requested → PR/engagement signals (`pr_no_reviews`, `pr_author_unresponsive`, `stalled_pr`, `bottleneck`). | GitHub MCP (read-only) |
| **Google Sheets** | The **database** and the durable audit trail — one timestamped, rich-formatted row per run. (There is no separate DB; the sheet *is* the state.) | via Apps Script (below) |
| **Google Apps Script** | The **bridge** that lets the digest write *formatted* rows to the sheet and verify them. See the dedicated section below. | `curl` → web-app URL |
| **Google Chat** | **Primary delivery** — threaded `cardsV2` cards (header + one per teammate + closing) to the standup Space, built + posted by the deterministic `render_cards.py`. Headless-friendly: an incoming webhook, no interactive connector. | `render_cards.py` → webhook |
| **Slack** | **Fallback delivery** — used only if `gchat_webhook_url` is unset; posts the digest as `mrkdwn` text. | Slack MCP |
| **launchd** (macOS) | Scheduler that fires the digest unattended at 12:05 IST. Replaced the in-REPL Claude Code cron (which needed an open session and expired after 7 days). | LaunchAgent → `run-digest.sh` |

---

## How Apps Script comes into the picture

The obvious way to write to a Google Sheet would be the Google Drive MCP — but
**Drive's MCP is read-only for existing files**, and even if it could write, it
can't produce the **rich formatting** (bold, colour, inline hyperlinks, a typed
Date cell) that makes the briefing scannable. So Team Pulse uses a small
**Apps Script bound to the sheet** as a write bridge:

- It's deployed as a **web app** exposing two secret-gated HTTPS endpoints
  (source in [`apps-script.gs`](apps-script.gs)):
  - **`doPost`** — appends a row. Column 1 is stored as a typed **Date**; columns
    2..N are parsed from an **extended-markdown** subset (`**bold**`, `*italic*`,
    `[red]…[/red]`, `[big]…[/big]`, `[text](url)`, …) into Google Sheets
    **RichTextValues**. Returns `{ok, last_row}`.
  - **`doGet`** — reads a column and returns `last_row`. The digest captures
    `last_row` **before** the POST and again **after**, and confirms it went up by
    exactly 1. This row-count delta is the *only* trusted success signal.
- It **runs as your Google identity** — so there's no service account, no GCP
  project, and no token plumbing to maintain.

**Two gotchas worth knowing** (also in [`CLAUDE.md`](CLAUDE.md)):
- The POST returns a **302 → "Page not found"** (or a 4xx); curl following the
  redirect makes the response look like a failure. **It isn't** — the row lands on
  the first hop. Never retry the POST (it would duplicate the row); trust the
  `doGet` row-count check instead.
- **Re-deploying** must *update the existing deployment* (Manage deployments →
  pencil → New version), never "New deployment" — otherwise the live URL in
  `config.json` keeps serving stale code.

---

## What you need to run it

**Binaries** (already present on the pilot Mac): `claude` (Claude Code CLI),
`node` (via nvm), `jq`, `python3`, `curl`.

**Configuration** (must be populated — the digest aborts on any `<FILL IN…>`):
- [`config.json`](config.json) — sheet ID, Slack channel, **Google Chat webhook**,
  Apps Script URL + secret, Jira project key, GitHub org, Atlassian base URL,
  `in_progress_statuses`, `queued_status_groups`, thresholds. *(Treat the Apps
  Script secret and the Chat webhook URL as credentials.)*
- [`team.json`](team.json) — per-teammate identity map (`name`, `github_login`,
  `jira_account_id`). **Order matters**: it must match the sheet's column order.

**Live authentications:**
- Atlassian MCP (OAuth) and GitHub MCP — read access.
- A **Google Chat incoming webhook** URL in `config.json` (`gchat_webhook_url`) for delivery. (Slack MCP is only needed for the fallback path.)
- The Apps Script web app — deployed and reachable at the URL in `config.json`.

---

## Running it

**Manually** (e.g. to test a change, or after a re-auth) — from a Claude Code
session in this directory:

> "Read digest.md and execute its instructions exactly."

**Headless / one-off:** `claude -p "Read digest.md and execute its instructions exactly."`

**Scheduled (unattended):** via the launchd LaunchAgent. Full activation, testing,
and troubleshooting steps are in **[`RUNBOOK.md`](RUNBOOK.md)**.

---

## Repository layout

| File | Purpose |
|---|---|
| [`digest.md`](digest.md) | **The executable** — the 9-step prompt the agent runs. |
| [`config.json`](config.json) | All IDs, URLs, the Apps Script secret, and thresholds. |
| [`team.json`](team.json) | Teammate identity map (= sheet column order). |
| [`apps-script.gs`](apps-script.gs) | Source of the sheet-bound Apps Script (`doPost`/`doGet`). |
| [`run-digest.sh`](run-digest.sh) | Wrapper launchd runs; writes the per-day log. |
| [`render_cards.py`](render_cards.py) | Deterministic Google Chat card renderer + poster (digest Step 7 calls it). |
| [`com.chronus.teampulse.plist`](com.chronus.teampulse.plist) | LaunchAgent definition (12:05 IST). |
| [`logs/`](logs/) | Per-day run logs (`YYYY-MM-DD.log`) — git-ignored (contain names). See [`example-run.log.txt`](logs/example-run.log.txt) for a sanitized sample of one run. |
| [`CLAUDE.md`](CLAUDE.md) | Operating contract, hard rules, current vs. original design. |
| [`design.md`](design.md) | Original spec / rationale (source of "why"). |
| [`RUNBOOK.md`](RUNBOOK.md) | How to activate & operate the automation. |
| [`SETUP-CHECKLIST.md`](SETUP-CHECKLIST.md) | Go-live checklist (allowlist, launchd, webhook). |
| `.claude/settings.json` | Permission allowlist so the headless run never prompts. |

---

## Status & roadmap

- **Pilot** — running for 2 teammates before expanding to 8. Validation gates
  (identity accuracy, signal honesty, narrative usefulness, delivery reliability)
  are in [`CLAUDE.md`](CLAUDE.md).
- **Scheduler** — ✅ **live on launchd** (`com.chronus.teampulse`, 12:05 IST); the
  old in-REPL cron is retired. See [`RUNBOOK.md`](RUNBOOK.md).
- **Delivery** — ✅ **migrated to Google Chat** threaded `cardsV2` cards via webhook
  `curl`; Slack text remains the automatic fallback.
- **Next** — finish the 3-day pilot, then expand 2 → 8 (add `team.json` entries +
  matching sheet columns, same order). Possible tidy-up: route abort/alert messages
  to the Chat webhook too (they still post to Slack).

> **Hard rule:** no PII in checked-in files. Names, logins, account IDs, channel
> IDs, and the Apps Script secret live only in `config.json` / `team.json`, never
> in `README.md`, `digest.md`, or other committed docs.
