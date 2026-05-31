# Team Pulse — Daily Digest

You are running the Team Pulse digest. Execute every step below precisely, in order. Do not skip steps. Do not improvise the data layer.

This prompt contains **no team-specific data**. All identities, IDs, channels, and thresholds live in `config.json` and `team.json` in the working directory. Read those files at the start of every run.

---

## Operating context

- **Working directory:** the directory containing this `digest.md`, `config.json`, and `team.json`. If invoked from elsewhere, treat absolute paths relative to wherever this file lives.
- **Frequency:** intended to run once a day at ~8 AM local, but safe to re-run any time. Each run appends a fresh timestamped row. There is no idempotency check by design.
- **Output sinks:** a Google Sheet (via the Apps Script web app) and a Slack channel.
- **MCPs you'll need:** `mcp__plugin_atlassian_atlassian` (Jira + Confluence), `mcp__github` (PRs, commits, reviews), `mcp__claude_ai_Slack` (delivery). These are deferred — load any tools you need via `ToolSearch` before calling them.

---

## Progress logging (live, per step)

If the env var `TEAMPULSE_STEP_LOG` is set — it is when launched by `run-digest.sh` — append a one-line marker to that file **as you finish each step**, via `Bash`. Plain `claude -p` flushes its own output only at the very end, but Bash commands run live, so these markers make the run observable in real time. Use this exact format (matches the wrapper's `[time][pid]` lines; `echo`/`date` only, to stay inside the headless allowlist):

```bash
echo "[$(date '+%H:%M:%S')][${TEAMPULSE_RUN_PID:-$$}] ✓ Step N — <terse result>" >> "$TEAMPULSE_STEP_LOG"
```

Emit one after each step:
- `Step 0 — configs loaded ({N} teammates)`
- `Step 0.5 — Atlassian preflight OK`  *(or `needs re-auth → aborting`)*
- `Step 1 — gathered Jira + GitHub`  *(append `· Confluence 403` if it soft-failed)*
- `Step 2 — signals computed`
- `Step 3–4 — per-person + team narratives synthesized`
- `Step 5 — row POSTed (BEFORE={N})`
- `Step 6 — verified row {M}`  *(or `verify FAILED`)*
- `Step 7 — delivered {N} cards to Google Chat`  *(or `Slack fallback`)*
- `Step 8 — done`

If `TEAMPULSE_STEP_LOG` is unset (a manual in-session run), **skip this entirely** — no extra noise.

---

## Step 0 — load configs

Use the `Read` tool to load:
1. `./config.json`
2. `./team.json`

Throughout this prompt:
- `cfg.X` refers to a field from `config.json` (e.g. `cfg.sheet_id`, `cfg.thresholds.jira_idle_working_days`)
- `t.X` refers to a field from a teammate object in `team.json` (e.g. `t.name`, `t.github_login`, `t.jira_account_id`)

**Abort condition:** if either file contains any string starting with `<FILL IN`, send a one-line Slack message to `cfg.slack_channel` saying `Team Pulse aborted: config not populated` and stop. Do not continue.

---

## Step 0.5 — pre-flight checks (fail fast)

Before starting Step 1, verify the MCPs you'll need are actually usable. The Atlassian MCP in particular hides its query tools behind OAuth and only exposes `authenticate` / `complete_authentication` until the user has authenticated.

Use `ToolSearch` with query `+atlassian` to list available Atlassian tools. **If the only Atlassian tools available are `authenticate` and `complete_authentication`** (i.e. no `searchJiraIssuesUsingJql`, `getJiraIssue`, or `searchConfluenceUsingCql`):

1. Call `mcp__plugin_atlassian_atlassian__authenticate` to get the authorization URL.
2. Send a Slack message to `cfg.slack_channel`:
   ```
   Team Pulse aborted: Atlassian MCP needs authentication.
   Please open this URL and authorize, then re-run: <auth_url>
   ```
3. Stop. Do not proceed to Step 1 with partial data.

This pre-flight prevents partial digests where Jira/Confluence signals are silently absent. A clear "blocked, please re-auth" message is more useful than a digest with half the data missing.

---

## Step 1 — gather raw data per teammate

For each teammate `t` in `team.json`, collect the following.

### Jira (via Atlassian MCP)

- **Open tickets**, JQL: `project = ${cfg.jira_project_key} AND assignee = "${t.jira_account_id}" AND statusCategory != Done ORDER BY updated DESC`
- **Recent activity**, JQL: `project = ${cfg.jira_project_key} AND assignee = "${t.jira_account_id}" AND updated >= -1d`
- **Blocked tickets**, JQL: `(labels = blocked OR status = Blocked) AND project = ${cfg.jira_project_key} AND assignee = "${t.jira_account_id}"`

**Performance — control output size.** Always pass `fields=["summary","status","updated","labels","priority"]` and `responseContentFormat="markdown"` to `searchJiraIssuesUsingJql`. The default response includes ADF-rendered descriptions and bloats payloads to ~100-200KB for 25 issues; with these parameters it drops to ~5KB.

**Idle-time computation.** Do **not** fetch changelogs for every open ticket — that's a per-ticket API call and infeasible at scale. Use `updated` as a proxy for "last status change": treat a ticket as idle when `now - updated > cfg.thresholds.jira_idle_working_days`. Only fetch the changelog with `getJiraIssue` if you specifically need to confirm the *current* status's age (rare; mostly for explaining why a ticket is flagged).

**Link metadata.** When you record a ticket in your gathered data, also capture its **link URL**: `${cfg.atlassian_base_url}/browse/${ticket_id}` (e.g. `https://your-org.atlassian.net/browse/PROJ-1234`). When you record a PR, capture its link URL: `https://github.com/${cfg.github_org}/${repo}/pull/${pr_number}`. These URLs are used in Step 3 to wrap each identifier as a clickable markdown link.

Filter out comments authored by automation/bot accounts.

### GitHub (via GitHub MCP)

For `t.github_login` within `cfg.github_org`:

- Commits authored in last 24h (exclude pure merge commits)
- PRs opened, merged, or closed in last 24h
- All currently open PRs (with state, age in hours, last activity timestamp, review decision)
- Draft PRs older than `cfg.thresholds.stalled_draft_pr_days`
- Reviews this person submitted on teammates' PRs in last 24h and last 7d
- PRs awaiting review *from* this person (incoming review-requested)

Exclude bot accounts. Known bots to filter: Dependabot, GitHub Actions, `copilot-pull-request-reviewer[bot]`. Generally: any author whose login contains `[bot]` or has a `User.type == "Bot"` flag.

### Confluence (via Atlassian MCP)

CQL: `lastModified > -1d AND contributor = "${t.jira_account_id}" AND type = page`

Skip template pages and personal-space pages.

**Soft-fail.** If the first CQL call returns 403 ("Current user not permitted to use Confluence"), set `confluence_edits_7d = "unavailable"` for **all** teammates and skip Confluence for the rest of this run. Do not retry — the user's Atlassian account either has a Confluence seat or doesn't; one 403 means all subsequent calls will also 403. Log a one-line note and move on; do not abort the digest.

---

## Step 2 — compute signals (deterministic, no prose)

This step applies the threshold rules from `cfg.thresholds` to the raw data. It is **rule-based**, not interpretive. Do not paraphrase or estimate. For each teammate `t`, build a `signals` object with these four buckets:

### Work-in-progress
- `active_tickets`: list of `{id, title, status, days_since_update}` filtered to **only statuses in `cfg.in_progress_statuses`** (i.e. tickets actively needing attention — typically `In Progress`, `In Review`, `Code Review`). Excludes `To Do`, `Delivered`, `QA Signoff`, etc. — those count as queue depth, not active load.
- `queued`: of the open tickets **not** in `cfg.in_progress_statuses`, bucket each by `cfg.queued_status_groups` and count — `queued.not_started`, `queued.in_qa`, `queued.delivered`, plus `queued.other` for any open non-active status not named in a group. Most of the backlog is typically `delivered` (work finished but never advanced to a Done status) — surface it **de-emphasized**, not as headline load. Counts only; don't enumerate.
- `in_flight_prs`: list of `{repo, number, title, state, age_hours, review_decision}`

### Output
- `prs_merged_24h`, `prs_merged_7d`
- `tickets_closed_24h`, `tickets_closed_7d`
- `commits_24h`
- `confluence_edits_7d`

### Engagement (last 7 days unless noted)
- `reviews_given_24h`, `reviews_given_7d`
- `prs_awaiting_their_review` (current count, with ages)

### Concerns (emit only when the rule fires)
| Concern | Severity | Rule |
|---|---|---|
| `jira_idle` | blocker | any active ticket has `days_since_update > cfg.thresholds.jira_idle_working_days` |
| `pr_no_reviews` | blocker | any open non-draft PR has 0 human reviews and `age_hours > cfg.thresholds.pr_no_reviews_hours` |
| `pr_author_unresponsive` | blocker | any PR has reviewer feedback and no author push/comment for `> cfg.thresholds.pr_author_unresponsive_hours` |
| `overloaded` | blocker | `len(active_tickets) >= cfg.thresholds.overloaded_in_progress_count` (**active**, not queued — see Step 2 work-in-progress definitions) |
| `explicit_block` | blocker | any ticket has the `Blocked` label or status |
| `silent` | risk | 0 commits AND 0 PR activity AND 0 Jira transitions AND 0 comments in the last working day. **Suppressed on Saturday and Sunday runs** — weekend silence is expected and is not a real signal. |
| `underloaded` | risk | `len(active_tickets) <= cfg.thresholds.underloaded_max_in_flight` AND `prs_merged_7d <= cfg.thresholds.underloaded_max_shipped_7d` |
| `stalled_pr` | risk | any draft PR older than `cfg.thresholds.stalled_draft_pr_days` |
| `bottleneck` | risk | `prs_awaiting_their_review` has ≥ 2 PRs older than 24h |

---

## Step 3 — synthesize the per-teammate narrative

Now turn each teammate's `signals` into a markdown briefing using the **extended markdown syntax** the Apps Script parser understands:

| Syntax | Effect |
|---|---|
| `**bold**` | Bold |
| `*italic*` | Italic — **only `*`, never `_`**; single underscore is left as-is to avoid mangling identifiers like `pr_no_reviews` |
| `__underline__` | Underline |
| `~~strike~~` | Strikethrough |
| `[red]...[/red]` | Red — also `green`, `blue`, `gray` |
| `[big]...[/big]` | 14pt font |
| `[text](url)` | Hyperlink — clickable in the cell. Use for ticket IDs and PR identifiers. |

Use this exact structure for each teammate, in this order — **verdict first, then evidence, then the so-what** (bottom-line-up-front). **Do not include the teammate's name** — the sheet column header already shows it.

```
[big]{status_icon}[/big]
{verdict_line}

**🔴 Needs attention ({count})**   ← omit this whole block if no active ticket is idle/stalled
  • [{ticket_id}]({cfg.atlassian_base_url}/browse/{ticket_id}) {short_title} — *{status}* [gray]· {days_since_update}d idle[/gray]
  • ...                          (ordered oldest-idle first)
**🟢 In flight ({count})**         ← active tickets that are NOT idle; omit block if none
  • [{ticket_id}]({cfg.atlassian_base_url}/browse/{ticket_id}) {short_title} — *{status}* [gray]· {days_since_update}d[/gray]
  • ...

**🔀 PRs ({open_count}):** {pr_summary_line}
**📊 7d:** [green]**{prs_merged_7d}** merged[/green] · **{reviews_given_7d}** reviews · **{tickets_closed_7d}** closed · [gray]{confluence_edits_7d} docs[/gray]   **📤 24h:** [gray]{one-line activity summary}[/gray]

*{2-3 sentence interpretation + the recommended move — NOT a re-list of the counts above; wrap any ticket/PR identifiers as links.}*
```

**The pieces:**
- **`{verdict_line}`** — the bottom line, read first. If any concern fired: `[red]**{primary concern}**[/red] [gray]— {load context}[/gray] [red]· {other fired signals, compact}[/red]`. If clear: `[green]✓ On track[/green] [gray]— {load context}[/gray]`.
- **`{load context}`** — the honest load split (never a single "queued" total, which is ~80% done-but-unclosed): `{active} active · {queued.not_started} to-do · {queued.in_qa} in QA · {queued.delivered} delivered (awaiting close)`. Always show `active`; omit a 0 group; keep `delivered` de-emphasized — it's finished work awaiting close, not pending load. Example verdict: `[red]**Overloaded**[/red] [gray]— 7 active · 6 in QA · 87 delivered (awaiting close)[/gray] [red]· 9 PRs unreviewed · 4 idle >4d[/red]`.
- **Ticket buckets** — split `signals.active_tickets` by the idle rule (`days_since_update > cfg.thresholds.jira_idle_working_days`): idle/stalled → **🔴 Needs attention** (oldest first); the rest → **🟢 In flight**. Each row is a neutral **`•`** bullet — title in default colour, age in gray; severity reads from the bucket, not the marker. Omit an empty bucket entirely (a clear person shows only 🟢). Keep `{short_title}` to the human-readable subject — trim long raw Jira summaries (cards wrap long titles onto multiple lines; the sheet shows them in full).
- **`{pr_summary_line}`** — one line: `[red]{X} of {N} awaiting first review[/red] [gray]· oldest[/gray] [{repo}#{n}](url) [gray]{age}[/gray]`, plus a short note of duplicates/supersedes when relevant. If PRs are healthy, say so plainly in gray.
- **Stat strip** — `📊 7d` and `📤 24h` share one line; merged count green, other counts bold, secondary detail gray.

Note: when composing the **Slack fallback** (Step 7c-B) you DO need the name — prepend `**{t.name}** {status_icon}` to each section there.

**Colour grammar — apply everywhere (sheet *and* cards). Keep it calm: severity rides on a leading status dot, not on coloured text, so a list never becomes a wall of red:**
- **Status dots are for section headers only** (🔴 Needs attention / 🟢 In flight). Individual rows use a neutral **`•`** bullet — no per-row colour; severity reads from the section + the gray status label.
- `[red]` **text — reserved for the verdict line only** (the primary concern + the compact "other signals" tail). Don't paint row titles red.
- `[green]` = shipped / positive (merged count, `✓ On track`).
- `[gray]` = secondary / timing (statuses, ages, last-update, "docs n/a", the `delivered (awaiting close)` count).
- Row titles stay **default colour** (readable). Bold = section labels + key numbers. Italic = status names + the closing narrative. Links = ticket/PR identifiers.

`status_icon` (highest-severity concern present): `🚩` if any blocker fired · `⚠️` else if any risk fired · `✓` otherwise.

**Narrative writing rules** (non-negotiable):
- **Describe, don't judge.** "Quiet yesterday — worth a check-in" ✅. "Underperforming" ❌. The audit conclusion is the SM's, not the tool's.
- **Interpretation + a move, not a re-list.** The verdict and detail lines already carry the counts; the narrative adds *why it matters* and *the suggested next action* (e.g. "a review-swap Monday drains the queue before it grows"). Never just restate "9 PRs unreviewed".
- **2-3 sentences max.** If a person is fine, one sentence — don't pad.

---

## Step 4 — synthesize the team-level header and closing narrative

**Team header** (placed at the very top of the digest, before any per-person section). Use the same extended-markdown syntax:

```
[big]**Team Pulse**[/big] · [gray]{TS}[/gray]

🚩 **Attention:** [red]{names with primary blocker}[/red]   *(or [gray]no blockers today[/gray])*
🔁 **Bottleneck:** {one-line description of any cross-person blockage; omit line entirely if none}
✅ **Shipped 24h:** **{N}** PRs merged · **{M}** tickets closed
📉 **Velocity:** *{trend observation comparing this week's output to last; omit line if no obvious trend}*
🤫 **Quiet:** [gray]{names of teammates with `silent` concern}[/gray]   *(omit line if none, or skip on weekends)*
```

**Team closing narrative** (placed after all per-person sections, 3-4 lines, descriptive):

```
*{team-wide observation in 2-4 sentences}*
```

---

## Step 5 — assemble the row and persist to the sheet

**First, capture the current row count** (used in Step 6 for verification):

```bash
BEFORE=$(curl -sL -G "${cfg.apps_script.url}" \
  --data-urlencode "secret=${cfg.apps_script.secret}" \
  --data-urlencode "column=A" | jq -r '.last_row')
```

Build the timestamp in **UTC ISO 8601** format. Reason: Google Sheets auto-coerces date-like strings to typed Date cells stored internally in UTC; using ISO format ensures the value round-trips byte-for-byte when read back via the API.

```bash
TS=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
```

Build the row in **the exact order of `team.json`** (which matches the sheet's column order):

```
[ "{TS}", "{markdown briefing for team[0]}", "{markdown briefing for team[1]}", ... ]
```

Construct the JSON body in a temp file (avoids shell quoting hell with multi-line markdown content):

```bash
cat > /tmp/teampulse-row.json <<JSON
{
  "secret": "${cfg.apps_script.secret}",
  "row": [ "${TS}", "...team[0] markdown...", "...team[1] markdown..." ]
}
JSON
```

POST it via `Bash` + curl:

```bash
curl -sL -X POST "${cfg.apps_script.url}" \
  -H "Content-Type: application/json" \
  --data @/tmp/teampulse-row.json
```

**The POST succeeds synchronously on the first hop, but the response curl reports is non-deterministic.** Apps Script returns a 302 to a `script.googleusercontent.com` sandbox URL; curl's `-L` follows the redirect and may receive either a "Page not found" HTML body or an HTTP 4xx (commonly 405). **Both are normal. Ignore curl's response entirely.** The Step 6 row-count delta is the only valid success signal. Do **not** retry the POST — retrying would write a duplicate row.

---

## Step 6 — verify the row landed

The verification is **count-based, not string-match-based**, because Google Sheets' date coercion mutates the timestamp on storage (sending `2026-05-03T11:18:15Z` → reading back the same value, but sending `2026-05-03 16:48:15` → reading back `2026-05-03T11:18:15.000Z`). Counting rows is robust to any such coercion.

```bash
AFTER=$(curl -sL -G "${cfg.apps_script.url}" \
  --data-urlencode "secret=${cfg.apps_script.secret}" \
  --data-urlencode "column=A" | jq -r '.last_row')
```

Confirm `AFTER == BEFORE + 1` (where `BEFORE` was captured at the start of Step 5). If not, send a Slack alert (`Team Pulse: write to sheet failed for run at ${TS}`) and **do not proceed to step 7**.

---

## Step 7 — deliver the digest (Google Chat cards, or Slack fallback)

The Sheet stores extended-markdown that the Apps Script renders as RichText. Chat needs its own rendering, and the two sinks differ:

- **`cfg.gchat_webhook_url` set (non-empty) → Google Chat `cardsV2` cards**, built + posted by the committed **`render_cards.py`** (7a → 7b). You assemble a *content JSON*; the script does **all** the formatting (markdown→HTML, card layout, threaded POST).
- **empty / absent → Slack `mrkdwn` text**, the original fallback (7c), converted inline with `to_chat`.

You already have everything from earlier steps: the per-teammate `signals` (Step 2), each teammate's verdict + narrative (Step 3), the team Attention / Bottleneck / Shipped lines + closing (Step 4). Text fields keep the same `[red]/[green]/[gray]` tags and `[text](url)` links as the sheet.

> **Why a script:** hand-building the cards inline produced a *different* formatting bug every run (escaped `<font>` tags; half-converted `[red]`). `render_cards.py` owns the deterministic conversion + layout so it can't drift. **Do not hand-convert markdown or hand-build cards in this step** — only produce the content JSON.

### 7a. Write the content JSON (Google Chat path)

Write `/tmp/teampulse-cards.json` (via `Write` or `python3`). The full schema is in `render_cards.py`'s docstring. All *text* fields use the sheet's extended-markdown; each row is `{text, label, url}` — `text` bolds the id, `label` is the plain gray sub-line, `url` makes the row tappable. Build the buckets from `signals.active_tickets` split by the idle rule (`days_since_update > cfg.thresholds.jira_idle_working_days`, oldest-idle first), PRs from `in_flight_prs` (unreviewed-first), and the load split from `signals.queued`. `TS` is from Step 5:

```json
{
  "thread_key": "teampulse-{TS}",
  "header":  {"attention": "[red]{names with a blocker}[/red]   (or [gray]no blockers today[/gray])",
              "bottleneck": "{one line, or null}",
              "shipped":    "[green]**{N}** merged · **{M}** closed[/green] [gray]({note})[/gray]"},
  "closing": "{team narrative, 2-4 sentences}",
  "teammates": [
    {
      "name": "{t.name}", "icon": "{🚩 | ⚠️ | ✓}",
      "github_login": "{t.github_login}", "jira_account_id": "{t.jira_account_id}",
      "subtitle": "{active} active · {queued.not_started} to-do · {queued.in_qa} in QA · {prs_merged_7d} merged (7d)",
      "verdict":  "[red]**{primary concern}** · {other fired signals}[/red] [gray]— {load context}[/gray]",
      "needs_attention": [ {"text": "**{id}** {short title}", "label": "{status} · {days}d idle", "url": "{cfg.atlassian_base_url}/browse/{id}"} ],
      "in_flight":       [ {"text": "**{id}** {short title}", "label": "{status} · {days}d",      "url": "{cfg.atlassian_base_url}/browse/{id}"} ],
      "prs":             [ {"text": "**{repo}#{n}** {short title}", "label": "{state} · {age}h · {review or 'no review'}", "url": "https://github.com/{cfg.github_org}/{repo}/pull/{n}"} ],
      "activity":  ["**7d** — [green]**{prs_merged_7d}** merged[/green] · **{reviews_given_7d}** reviews · **{tickets_closed_7d}** closed · [gray]{confluence} docs[/gray]",
                    "**24h** — [gray]{one-line activity summary}[/gray]"],
      "narrative": "{the Step-3 interpretive paragraph}"
    }
  ]
}
```

Notes: omit an empty `needs_attention` / `in_flight` / `prs` array — the script skips that bucket (a clear person shows only 🟢). The `delivered` count belongs in the verdict's gray load context, not the subtitle. For a clear teammate, use `"icon": "✓"` and `"verdict": "[green]✓ On track[/green] [gray]— {load}[/gray]"`.

### 7b. Render + post (Google Chat path)

```bash
python3 render_cards.py /tmp/teampulse-cards.json
```

`render_cards.py` reads `config.json` for the webhook + Jira/GitHub/sheet, then builds the header card + one card per teammate (verdict → counted, collapsible **🔴 Needs attention** / **🟢 In flight** / **🔀 Pull requests** → **📊 Activity** → narrative + **Open PRs**/**Jira** buttons) + a closing card, and POSTs them threaded. It prints one line per card and a final `N/N cards posted to thread …`, exiting non-zero if any failed. **Success = `N/N`, exit 0.** Don't also post to Slack; the Step-5 sheet row is already saved, so a delivery failure is non-fatal (see Error handling).

### 7c. Slack fallback (no `gchat_webhook_url`)

Convert each section with `to_chat` (extended-markdown → `mrkdwn`), then send one message via `mcp__claude_ai_Slack__slack_send_message`.

```python
import re
def to_chat(s):
    s = re.sub(r'\[/?(red|green|blue|gray|big)\]', '', s)        # strip colour/size BEFORE links
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<\2|\1>', s)        # [text](url) → <url|text>
    s = re.sub(r'__([^\n]+?)__', r'\1', s)                       # no underline
    s = re.sub(r'\*\*([^\n]+?)\*\*', r'⟦B⟧\1⟦/B⟧', s)            # bold via placeholder
    s = re.sub(r'\*([^\n*]+?)\*', r'_\1_', s)                    # italic *x* → _x_
    s = s.replace('⟦B⟧', '*').replace('⟦/B⟧', '*')
    s = re.sub(r'~~([^\n]+?)~~', r'~\1~', s)                     # strike
    return s
```

Compose: team header, `---`, each per-person section (prepend `**{t.name}** {status_icon}`), `---`, closing narrative; convert each with `to_chat`; send to `cfg.slack_channel`.

---

## Step 8 — final report

Print a one-line summary to your output:

```
Digest written: row {sheet_row_count} at {TS}, sent to Slack channel {cfg.slack_channel}.
```

---

## Error handling

- **MCP call failures:** retry once with a 2-second wait. If still failing, abort and send `Team Pulse aborted: {step} failed — {error}` to Slack. Do not write a partial row.
- **Empty signals for a teammate:** their per-person section says `> No detectable activity in last 24h.` Do not crash.
- **Sheet write failure (Step 6 verification fails):** alert via Slack but do not retry the POST. The next scheduled run will write the next row.
- **Slack send failure:** the row is already in the sheet — log the Slack error to stderr but treat the run as successful.

---

## Notes for future maintenance

- When the team grows from 2 → 8: add entries to `team.json` *and* add columns to the Google Sheet header row, in the same order. The prompt builds rows by iterating `team.json`, so column order in the sheet must match.
- Threshold tuning happens in `config.json.thresholds` — never edit the rules in this file.
- The narrative tone (descriptive vs. judgmental) is the audit-mode contract. If you want triage-mode (only surface flagged people), that's a separate prompt, not a parameter on this one.
