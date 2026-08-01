# Team Pulse — Fresh Machine Setup

Complete rebuild guide: from a **freshly formatted Mac** to the digest firing
unattended at 12:05 IST. Work top to bottom.

- Day-to-day operations → [`RUNBOOK.md`](RUNBOOK.md)
- Why it's built this way → [`README.md`](README.md) · [`design.md`](design.md)
- Rules Claude must follow → [`CLAUDE.md`](CLAUDE.md)

> **Validated against** (the old machine's working state, 2026-08-02):
> Claude Code `2.1.220` · node `v20.20.1` (nvm) · jq `1.7.1-apple` (`/usr/bin/jq`) ·
> Python `3.14.4` (Homebrew) · git `2.49.0` · macOS arm64.

---

## 0. 🔴 BEFORE YOU WIPE THIS MAC

**Two files are git-ignored and exist nowhere else.** They are not on GitHub and
cannot be regenerated — `team.json` holds teammate identity mappings and
`config.json` holds the Apps Script secret and the Chat webhook token. Lose them
and you rebuild §6b by hand.

```bash
cd /Users/vishwam/projects/teamPulse

mkdir -p ~/teampulse-backup
cp config.json team.json          ~/teampulse-backup/          # ← THE CRITICAL TWO
cp -R logs                        ~/teampulse-backup/logs      # optional: run history
cp ~/.claude/settings.json        ~/teampulse-backup/claude-global-settings.json
cp ~/.claude/CLAUDE.md            ~/teampulse-backup/claude-global-CLAUDE.md

tar -czf ~/teampulse-backup.tar.gz -C ~ teampulse-backup
```

⚠️ **That tarball contains live credentials and teammate PII.** Put it in your
password manager or an encrypted volume — not a public/shared cloud folder. The
most robust option is to *also* paste the contents of `config.json` and
`team.json` into two password-manager secure notes, so a corrupt archive doesn't
cost you the rebuild.

**Verify the backup before you erase:**

```bash
tar -tzf ~/teampulse-backup.tar.gz | grep -E 'config.json|team.json'
```

Also confirm the working tree is pushed, so no code is stranded:

```bash
git status -sb && git log --branches --not --remotes --oneline   # want: clean, no output
```

---

## 1. What survives the format, and what you rebuild

| Lives in the cloud — survives untouched | Machine-local — you rebuild it |
|---|---|
| The Google Sheet ("Vishwam - tracker") and all its rows | Homebrew, nvm + node, python3, gh, jq |
| The bound Apps Script + its **deployment URL** + `SECRET` script property | Claude Code install and login |
| The Google Chat Space and its incoming webhook | Claude Code plugins (Atlassian, GitHub) |
| Jira / GitHub / Google accounts and permissions | Atlassian MCP OAuth (re-auth needed) |
| The git repo (all tracked code + docs, incl. `.claude/settings.json`) | `config.json`, `team.json` (§0 backup) |
| Your claude.ai connectors (account-level, follow your login) | The launchd LaunchAgent + `pmset` wake |

The practical consequence: **you are not re-creating the Google plumbing.** Steps
§8 onward mostly *verify* that the surviving cloud side still answers.

---

## 2. Install the toolchain

```bash
# Xcode command line tools (git, compilers)
xcode-select --install

# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"        # add to ~/.zprofile too

brew install python3 gh git
```

**nvm + node** (node is Claude Code's runtime; install per the
[nvm README](https://github.com/nvm-sh/nvm#installing-and-updating), then):

```bash
nvm install 20            # match the old machine's major version
nvm alias default 20
```

**jq** — macOS ships it at `/usr/bin/jq` (that's what the old machine used). Check
`command -v jq` first; only `brew install jq` if it's missing.

**Verify:**

```bash
for b in node npm jq python3 curl git gh; do printf '%-8s %s\n' "$b" "$(command -v $b || echo MISSING)"; done
```

`python3` only needs the standard library — `render_cards.py` imports nothing
external — so any Python ≥ 3.8 is fine.

---

## 3. Install and authenticate Claude Code

The old machine used the **native installer** (binary at
`~/.local/share/claude/versions/<v>`, symlinked from `~/.local/bin/claude`).
Reproduce that layout, because `run-digest.sh` hardcodes `~/.local/bin/claude`:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

> If that URL has changed, get the current command from the
> [Claude Code setup docs](https://docs.anthropic.com/en/docs/claude-code/setup).
> An npm install (`npm i -g @anthropic-ai/claude-code`) also works, but then
> `CLAUDE_BIN` in `run-digest.sh` must be repointed (§7).

```bash
claude --version                 # expect 2.1.x or newer
claude                           # then log in when prompted; /exit
```

**Also confirm your global rules came back** — `~/.claude/CLAUDE.md` is *outside*
this repo (restore it from the §0 backup). It carries your "no co-author line in
commits" rule and the global Bash allowlist including `Bash(gh*)`, which the
digest's GitHub fallback path relies on.

---

## 4. Install the Claude Code plugins (the MCP data sources)

The digest reads Jira via the **Atlassian** plugin and GitHub via the **GitHub**
plugin. Both come from the official marketplace.

Easiest route — in a Claude Code session, run `/plugin`, then add the marketplace
`anthropics/claude-plugins-official` and install + enable:

| Plugin | Why the digest needs it |
|---|---|
| `atlassian@claude-plugins-official` | Jira JQL queries (Step 1) + Confluence CQL (soft-fails, no seat) |
| `github@claude-plugins-official` | PRs, commits, reviews (Step 1) |

Equivalent CLI form:

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install atlassian@claude-plugins-official
claude plugin install github@claude-plugins-official
```

**Then authenticate Atlassian once, interactively** (OAuth — this is the step that
cannot be automated, and the one that lapses over time):

In a Claude Code session, invoke `mcp__plugin_atlassian_atlassian__authenticate`
and complete the browser flow. Verify:

```
Ask Claude: "Call getAccessibleAtlassianResources and show me the cloud id."
```

If only `authenticate` / `complete_authentication` are visible on the Atlassian
server, you are not authenticated — `digest.md` Step 0.5 detects exactly this and
aborts with an alert rather than producing a half-empty digest.

**GitHub fallback auth** (recommended — see the §7 allowlist note):

```bash
gh auth login
gh auth status
```

Everything else installed on the old machine (superpowers, context7, playwright,
chrome-devtools, pr-review-toolkit, feature-dev) is **not** used by the digest.
Reinstall at leisure.

---

## 5. Clone the repo

```bash
mkdir -p ~/projects && cd ~/projects
git clone git@github.com:Vishwam10/team-pulse.git teamPulse
cd teamPulse
```

⚠️ **Keep the directory name `teamPulse` and the path `~/projects/teamPulse`.**
The repo's absolute path is baked into `run-digest.sh` and the plist. A different
path means editing both (§7).

You'll need an SSH key on the new machine (`ssh-keygen -t ed25519`, add the public
key to GitHub), or clone over HTTPS.

The clone brings back `.claude/settings.json` (the headless permission allowlist)
automatically — it's tracked. You do **not** need to hand-create it this time.

---

## 6. Restore the two secret files

### 6a. From the §0 backup (the happy path)

```bash
cd ~/projects/teamPulse
tar -xzf ~/teampulse-backup.tar.gz -C /tmp
cp /tmp/teampulse-backup/config.json /tmp/teampulse-backup/team.json .
```

### 6b. Rebuild by hand (only if the backup is gone)

```bash
cp config.example.json config.json
cp team.example.json    team.json
```

Then fill in every `<FILL IN …>`. Where each value comes from:

| Key | Where to find it |
|---|---|
| `sheet_id` | The sheet URL: `docs.google.com/spreadsheets/d/`**`<THIS>`**`/edit` |
| `apps_script.url` | Sheet → Extensions → Apps Script → Deploy → **Manage deployments** → the web-app `/exec` URL |
| `apps_script.secret` | Apps Script → **Project Settings → Script Properties → `SECRET`** (must match exactly) |
| `gchat_webhook_url` | Chat Space → Space settings → Apps & integrations → Webhooks → the "Team Pulse" webhook |
| `slack_channel` | Slack channel ID (fallback delivery only — optional) |
| `jira_project_key` · `atlassian_base_url` | Your Jira project key and `https://<org>.atlassian.net` |
| `github_org` | The GitHub org the team's PRs live in |
| `in_progress_statuses` · `queued_status_groups` · `thresholds` · `llm` | Already sensible defaults in the template — leave as-is |

`team.json` is an **array of 4 teammates** (`name`, `github_login`,
`jira_account_id`). Look up account IDs with the Atlassian MCP
(`lookupJiraAccountId`).

> **Hard rule:** the `team.json` array order **must** match the sheet's teammate
> column order. Getting this wrong silently attributes each person's briefing to
> the wrong column. Open the sheet and compare before the first run.

**Verify both files:**

```bash
jq -e . config.json team.json >/dev/null && echo "valid JSON"
grep -c "FILL IN" config.json team.json          # both must be 0
jq -r 'length as $n | "teammates: \($n)"' team.json
```

Confirm they're still ignored by git (they must never be committed):

```bash
git check-ignore -v config.json team.json        # expect both listed
```

---

## 7. Fix the machine-specific paths ⚠️ most common rebuild failure

Three files carry **hardcoded absolute paths**. If your username, project path, or
node version differs from the old machine, launchd fails silently at noon.

```bash
grep -n "/Users/\|\.nvm/versions" run-digest.sh com.chronus.teampulse.plist
```

| File | Hardcoded value | Fix if it differs |
|---|---|---|
| `run-digest.sh` | `PROJECT_DIR="/Users/vishwam/projects/teamPulse"` | Point at the real clone path |
| `run-digest.sh` | `CLAUDE_BIN="/Users/vishwam/.local/bin/claude"` | Use `command -v claude` output |
| `com.chronus.teampulse.plist` | `ProgramArguments`, `WorkingDirectory`, `StandardOutPath`, `StandardErrorPath` | Update all four to the real path |
| `com.chronus.teampulse.plist` | `PATH` includes `.nvm/versions/node/v20.20.1/bin` | Replace with `ls ~/.nvm/versions/node/` output |

The plist's explicit `PATH` is **required** — launchd does not load your shell
profile, so nvm's node and Homebrew's python3 are invisible without it.

**Verify every path in the plist resolves:**

```bash
# every dir on the plist's PATH must exist (silence = all good)
/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:PATH" com.chronus.teampulse.plist \
  | tr ':' '\n' | while read -r d; do [ -d "$d" ] || echo "MISSING DIR: $d"; done

# the wrapper the plist points at must exist and be executable (-rwxr-xr-x)
ls -l "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' com.chronus.teampulse.plist)"
```

### Recommended while you're here: fix the stale MCP allowlist

`.claude/settings.json` allows `mcp__github__*`, but the installed GitHub plugin
exposes its tools as **`mcp__plugin_github_github__*`**. Those rules currently
match nothing, so headless GitHub MCP calls aren't pre-approved and the run leans
on the slower `gh` CLI path instead. Claude is blocked from widening its own
permissions, so **you** paste this — replacing the four `mcp__github__…` lines:

```json
      "mcp__plugin_github_github__search_pull_requests",
      "mcp__plugin_github_github__search_commits",
      "mcp__plugin_github_github__search_issues",
      "mcp__plugin_github_github__pull_request_read",
      "mcp__plugin_github_github__search_repositories",
      "mcp__plugin_github_github__get_me",
      "mcp__plugin_github_github__list_commits",
```

Keep `gh auth login` done regardless — it's the fallback when MCP results blow the
25K-token cap.

---

## 8. Verify the surviving Google plumbing

**Apps Script — read-only check** (safe, changes nothing). Expect
`{"ok":true, ..., "last_row":<N>}`:

```bash
cd ~/projects/teamPulse
curl -sS -L -G "$(jq -r .apps_script.url config.json)" \
  --data-urlencode "secret=$(jq -r .apps_script.secret config.json)" \
  --data-urlencode "column=A" | jq '{ok, last_row}'
```

- `unauthorized` → `apps_script.secret` ≠ the Apps Script `SECRET` script property.
- HTML / login page → the deployment isn't public-executable, or the URL is stale.

If the script needs re-deploying, re-paste [`apps-script.gs`](apps-script.gs) and
use **Manage deployments → pencil icon → Version: New version → Deploy**.
"New deployment" mints a *new URL* while the live one keeps serving stale code.

**Google Chat webhook** — ⚠️ any test **posts a visible message to the team
Space.** Skip this and let the §9 smoke test cover it, or point
`gchat_webhook_url` at a scratch Space first if you want a silent check.

**Sheet columns** — open the sheet and confirm the teammate column headers still
match `team.json`'s order (§6).

---

## 9. Smoke test: one real run

⚠️ **This produces a real sheet row and a real Google Chat post.** There is no
dry-run mode. Do it outside standup hours and tell the team if they'll see it.

Cheapest checks first:

```bash
zsh -n run-digest.sh          # syntax only, no execution
chmod +x run-digest.sh
```

Then the full run, watching live:

```bash
./run-digest.sh &
tail -f logs/$(date '+%Y-%m-%d').log
```

A healthy run walks through these markers (~15–35 min; compare against the
committed [`logs/example-run.log.txt`](logs/example-run.log.txt)):

```
✓ Step 0   — configs loaded (4 teammates)
✓ Step 0.5 — Atlassian preflight OK
✓ Step 1   — gathered Jira + GitHub · Confluence 403     ← 403 is EXPECTED (no seat)
✓ Step 2   — signals computed
✓ Step 3-4 — per-person + team narratives synthesized
✓ Step 5   — row POSTed (BEFORE=N)
✓ Step 6   — verified row N+1
✓ Step 7   — delivered 6 cards to Google Chat
✅ RUN FINISHED OK
```

`Confluence 403` is normal and permanent — the account has no Confluence seat, and
Step 1 soft-fails that field by design.

---

## 10. Install the scheduler

```bash
cd ~/projects/teamPulse
chmod +x run-digest.sh
cp com.chronus.teampulse.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chronus.teampulse.plist

# Wake the Mac at 12:03 so it's up for the 12:05 fire
sudo pmset repeat wake MTWRFSU 12:03:00
```

> `cp` — not a symlink. launchd reads the copy in `~/Library/LaunchAgents/`, so
> **after any plist edit you must re-copy and `bootout` + `bootstrap` again.**

**Verify:**

```bash
launchctl print gui/$(id -u)/com.chronus.teampulse | grep -E "state|program|last exit"
pmset -g sched                                   # expect: wakepoweron at 12:03PM
```

Fire it immediately if you want a scheduler-path test (⚠️ real digest again):

```bash
launchctl kickstart -k gui/$(id -u)/com.chronus.teampulse
```

---

## 11. Go-live gate

Don't trust it unattended until all five hold:

- [ ] `logs/<today>.log` ends with `✅ RUN FINISHED OK`
- [ ] A new row appeared in the sheet, and Step 6 verified the row-count delta
- [ ] 6 cards landed threaded in the Google Chat Space
- [ ] Each teammate's briefing is under the **right** column / card (identity mapping)
- [ ] `launchctl print` shows the job registered with `state = waiting`

---

## 12. Troubleshooting a fresh install

| Symptom | Cause / fix |
|---|---|
| Nothing at noon; `logs/launchd.log` says `node: command not found` | plist `PATH` has a stale nvm version (§7) |
| Nothing at noon; `launchd.log` empty | Plist never bootstrapped, or wrapper not executable — `chmod +x run-digest.sh`, re-`bootstrap` |
| `FATAL: cannot cd to …` | `PROJECT_DIR` in `run-digest.sh` points at the old path (§7) |
| `claude=NOT FOUND` in the log header | `CLAUDE_BIN` wrong — repoint to `command -v claude` (§7) |
| Aborts at Step 0 | A `<FILL IN` survived in `config.json`, or invalid JSON (§6) |
| Aborts at Step 0.5 with a re-auth alert | Atlassian OAuth lapsed — re-run `authenticate` (§4) |
| Ran fine but nothing in Chat | Non-200 in the Step 7 `[render_cards]` lines → webhook stale; re-create it and update `gchat_webhook_url` |
| Row didn't land / `unauthorized` | Secret mismatch (§8). **Never retry the POST** — it duplicates the row; trust the Step 6 count |
| Briefings attributed to the wrong person | `team.json` order ≠ sheet column order (§6) |
| Run takes far longer than ~35 min | GitHub MCP calls not allowlisted → falling back to `gh` (§7) |
| Mac was asleep/closed | launchd runs a missed calendar job once on next wake — possibly *after* standup. Lid open / plugged in around noon; scheduled wake is unreliable lid-closed on battery |

**The escape hatch:** if laptop availability keeps being the failure mode, the same
`run-digest.sh` moves to an always-on box (Pi / mini / VPS) under plain `cron`
with no code change — only the paths in §7.
