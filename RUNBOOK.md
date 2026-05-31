# Team Pulse — Automation Runbook

How the daily digest runs unattended (no open Claude Code session needed) and
how to operate it.

## What runs, and how

```
launchd (macOS, always-on)
  └─ 12:05 IST daily ─▶ run-digest.sh
                          └─ claude -p "Read digest.md and execute its instructions exactly."
                               └─ the full 9-step digest (Jira + GitHub → sheet row + Google Chat cards)
```

- **Brain:** still Claude Code — full agentic loop, MCP calls, verification. Nothing about the digest logic changed.
- **Trigger:** a launchd **LaunchAgent** (`com.chronus.teampulse`) replaces the in-REPL `CronCreate` job. It needs no open session and never expires.
- **Delivery:** Google Chat — threaded `cardsV2` cards (header + one per teammate + closing) posted via `curl` to the webhook in `config.json` (`gchat_webhook_url`). Slack text is the fallback if that key is unset.

## Files

| File | Role |
|---|---|
| `run-digest.sh` | Wrapper launchd executes. Runs `claude -p`, writes the per-day log. |
| `com.chronus.teampulse.plist` | LaunchAgent definition (canonical copy; gets copied to `~/Library/LaunchAgents/`). |
| `logs/YYYY-MM-DD.log` | **One file per day.** Each run appends a timestamped block (re-runs stack). |
| `logs/launchd.log` | launchd-level catch-all for failures before the wrapper can log. |
| `.claude/settings.json` | Permission allowlist so the headless run never blocks on a prompt. |

## One-time activation

```bash
# 1. Make the wrapper executable
chmod +x /Users/vishwam/projects/teamPulse/run-digest.sh

# 2. Install the LaunchAgent (copy the project's canonical plist)
cp /Users/vishwam/projects/teamPulse/com.chronus.teampulse.plist ~/Library/LaunchAgents/

# 3. Register it with launchd (modern syntax)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chronus.teampulse.plist
#    (older macOS fallback:  launchctl load -w ~/Library/LaunchAgents/com.chronus.teampulse.plist)

# 4. Wake the Mac at 12:03 on weekdays so it's awake for the 12:05 fire.
#    NOTE: scheduled wake is unreliable with the lid CLOSED on battery — keep
#    the lid open / plugged in around noon for reliability.
sudo pmset repeat wake MTWRF 12:03:00
```

## Test it (⚠️ posts a REAL digest)

```bash
launchctl kickstart -k gui/$(id -u)/com.chronus.teampulse
# then watch today's log:
tail -f /Users/vishwam/projects/teamPulse/logs/$(date '+%Y-%m-%d').log
```

This fires the job immediately and produces a real sheet row + Google Chat post.
For a no-post smoke test of just the plumbing, run `zsh -n run-digest.sh`
(syntax check) instead.

## Reading the logs

```bash
ls -lt /Users/vishwam/projects/teamPulse/logs/        # newest day first
cat    /Users/vishwam/projects/teamPulse/logs/$(date '+%Y-%m-%d').log
```

Every line is formatted **`[HH:MM:SS][PID] <detail>`** — the time it was emitted
(the date is in the filename) and the run's process id. The agent's own
stdout/stderr is streamed through the same prefix. Note: plain `claude -p` emits
its result in a burst near the **end** of the run (it doesn't stream intermediate
progress), so those lines share ~one timestamp. For a streamed, per-tool trace
with real phase-by-phase timing, uncomment `--verbose` in `run-digest.sh`.

Each run block ends with `✅ RUN FINISHED OK` or `❌ RUN FAILED (exit N)`.
A failed run still records *why* (the agent's error output is captured), and
the digest itself also posts a failure alert to the standup channel.

## Status / stop / restart

```bash
launchctl print    gui/$(id -u)/com.chronus.teampulse     # state, last exit code, next run
launchctl bootout  gui/$(id -u)/com.chronus.teampulse     # stop & unregister
pmset -g sched                                            # confirm the 12:03 wake is set
```

## Old CronCreate job — retired ✅

The original in-REPL cron `01e22275` is gone (it had already hit its 7-day
auto-expiry; `.claude/scheduled_tasks.json` is empty), so there's no double-digest
risk. If you ever re-create one with `CronCreate`, delete it once launchd is live
(`CronList` then `CronDelete <id>` from a Claude Code session) — never run both.

## Troubleshooting

- **No run at noon / `node: command not found` in `logs/launchd.log`** → the `PATH`
  in the plist is stale (e.g. nvm Node was upgraded). Update the nvm path in the
  plist, `bootout` then `bootstrap` again.
- **Nothing fired and Mac was closed/off** → launchd runs a missed calendar job
  *once* on next wake/login, but possibly *after* standup. Keep the Mac awake at noon.
- **Ran but didn't post to Chat** → check the per-card `[HTTP …]` lines logged in
  Step 7. A non-200 means the webhook URL/token in `config.json` is wrong or revoked
  — re-create the Space webhook and update `gchat_webhook_url`. (If that key is
  empty, delivery silently falls back to the Slack path.)
- **Atlassian auth lapsed** → Step 0.5 detects it and posts a re-auth alert; run
  `mcp__plugin_atlassian_atlassian__authenticate` once interactively to recover.

## Notes

- **Google Chat delivery is live** — `digest.md` Step 7 builds `cardsV2` cards and
  posts them threaded via `curl` to `gchat_webhook_url`; the Slack MCP is now only
  the fallback. Card layout and colours are defined in Step 7 (`to_card_html`).
- **Pending tidy-up:** the abort/alert messages in Steps 0 / 0.5 / Error-handling
  still post to the Slack channel; routing them to the Chat webhook too would put
  failures in the same place as the digest.
