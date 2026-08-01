# Team Pulse — Go-Live Checklist

> **Historical record** of the first activation on the pilot Mac — kept for the
> decisions and gotchas it captures. To set up on a **new machine**, use
> **[`SETUP.md`](SETUP.md)** instead; for day-to-day ops, [`RUNBOOK.md`](RUNBOOK.md).

Getting the digest running **unattended** (no open Claude Code session). Work top
to bottom. Detailed ops live in [`RUNBOOK.md`](RUNBOOK.md); this is the action list.

**Legend:**  👤 = you do it · 🤖 = Claude does it (but is blocked until you unblock) · ✅ = already done

---

## ✅ Already done (🤖)

- [x] `logs/` folder + per-day logging via [`run-digest.sh`](run-digest.sh) (tested)
- [x] LaunchAgent [`com.chronus.teampulse.plist`](com.chronus.teampulse.plist) — PATH-corrected for nvm/Homebrew, validated
- [x] [`RUNBOOK.md`](RUNBOOK.md) and [`README.md`](README.md)
- [x] Today's digest posted (sheet row + Slack) — confirms the pipeline works

---

## 🔴 What I need from YOU right now (these unblock everything)

### 1. 👤 Create `.claude/settings.json`
I'm **blocked** from writing this myself — it widens my own startup permissions, so
the safety classifier requires *you* to author it. Paste exactly:

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "ToolSearch",
      "Bash(curl *)",
      "Bash(jq *)",
      "Bash(python3 *)",
      "Bash(date *)",
      "Bash(cat *)",
      "Bash(echo *)",
      "Bash(mkdir *)",
      "Bash(wc *)",
      "Bash(head *)",
      "mcp__plugin_atlassian_atlassian__getAccessibleAtlassianResources",
      "mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql",
      "mcp__plugin_atlassian_atlassian__getJiraIssue",
      "mcp__plugin_atlassian_atlassian__searchConfluenceUsingCql",
      "mcp__github__search_pull_requests",
      "mcp__github__search_commits",
      "mcp__github__search_issues",
      "mcp__github__pull_request_read",
      "mcp__claude_ai_Slack__slack_send_message"
    ]
  }
}
```
- [x] 👤 Done — file created ✅ (validated: 25 allow rules)
- *If the watched test run (below) stalls on a bash prompt, change every `Bash(... *)` line to a single `"Bash"` (allow-all-bash). Your call — it runs one fixed, read-only prompt.*

### 2. 👤 Get me the Google Chat webhook URL
So I can migrate delivery off the Slack connector (makes headless delivery a plain `curl`).
1. Google Chat → create/open a **Space** for the digest
2. **Space settings → Apps & integrations → Webhooks → Add webhook** → name it "Team Pulse"
3. Copy the URL → either paste it into [`config.json`](config.json) as `"gchat_webhook_url": "…"`, **or** hand it to me here.
- [x] 👤 Webhook created + URL shared ✅ — added to `config.json` and live-tested (parent + threaded reply posted OK)

---

## 👤 Your setup steps (in order)

- [x] **1. Create `settings.json`** ✅
- [x] **2. Activate the LaunchAgent:** ✅ registered (`runs = 1`)
  ```bash
  cp /Users/vishwam/projects/teamPulse/com.chronus.teampulse.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chronus.teampulse.plist
  sudo pmset repeat wake MTWRF 12:03:00
  ```
- [x] **3. Watched test run** ✅ `RUN FINISHED OK`, sheet row 3, Google Chat threaded delivery confirmed headless:
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.chronus.teampulse
  tail -f /Users/vishwam/projects/teamPulse/logs/$(date '+%Y-%m-%d').log
  ```
- [x] **4. launchd green** ✅

---

## 🤖 What I'll do once you unblock me

- [x] **Rewrite `digest.md` Step 7 → Google Chat** ✅ done & webhook live-tested — graceful Slack fallback kept. **Delivery now goes to Google Chat from the next run on.**
- [x] **Old cron retired** ✅ — `01e22275` had already expired (7-day limit); `scheduled_tasks.json` is empty, so no double-digest risk.
- [ ] Walk through activation / troubleshoot the first run, on request.

---

## ✅ Verification gate (before trusting it unattended)

From the watched test run, confirm **all** of:
- [x] Log ends with `✅ RUN FINISHED OK`
- [x] A new row appeared in the sheet (row 3)
- [x] The digest posted to the standup channel (Google Chat, threaded)
- [ ] *(If everything worked except delivery → that's the cue to prioritize the Gchat migration, §2.)*

---

## 🔭 Later / optional

- [ ] If the laptop isn't reliably awake at 12:05, move the same `run-digest.sh` to an always-on box (Pi / mini / VPS) via `cron` — no code change.
- [ ] Expand the team 2 → 8: add entries to [`team.json`](team.json) **and** matching sheet columns, same order (see [`CLAUDE.md`](CLAUDE.md)).
