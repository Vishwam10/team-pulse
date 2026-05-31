#!/bin/zsh
#
# Team Pulse — headless daily digest runner.
#
# Invoked by the launchd LaunchAgent `com.chronus.teampulse` (see
# com.chronus.teampulse.plist), or run by hand to test:  ./run-digest.sh
#
# Logging: ONE file per calendar day at ./logs/YYYY-MM-DD.log, APPENDED per run.
# Every line is formatted:
#     [HH:MM:SS][PID] <detail>
# - HH:MM:SS  = wall-clock time the line was emitted (so phase timing is readable
#               straight from the log; the date is in the filename).
# - PID       = this wrapper's process id, i.e. a stable id for the whole run.
# The agent's own stdout/stderr is streamed through the same prefixer, so the
# entire log is a uniform timestamped stream.
#
# NOTE: this executes the FULL digest — every run posts a real row to the sheet
# and a real message to the standup channel. Don't run it casually.

set -u

PROJECT_DIR="/Users/vishwam/projects/teamPulse"
CLAUDE_BIN="/Users/vishwam/.local/bin/claude"
LOG_DIR="${PROJECT_DIR}/logs"
PID=$$                                              # run id, stamped on every line

cd "$PROJECT_DIR" || { echo "FATAL: cannot cd to $PROJECT_DIR" >&2; exit 1; }
mkdir -p "$LOG_DIR"

LOG="${LOG_DIR}/$(date '+%Y-%m-%d').log"             # local (IST) day
START_EPOCH="$(date '+%s')"

# Exported so digest.md can append a live [time][pid] progress marker after each
# step (plain `claude -p` otherwise flushes its output only at the very end).
export TEAMPULSE_STEP_LOG="$LOG"
export TEAMPULSE_RUN_PID="$PID"

# One [HH:MM:SS][PID] line.
logln()  { printf '[%s][%d] %s\n' "$(date '+%H:%M:%S')" "$PID" "$*" >> "$LOG"; }
# Prefix every line of a stream (the agent's stdout+stderr) the same way.
prefix() { while IFS= read -r line || [ -n "$line" ]; do
             printf '[%s][%d] %s\n' "$(date '+%H:%M:%S')" "$PID" "$line"
           done >> "$LOG"; }

logln "════════════════════════════════════════════════════════════════"
logln "▶ RUN STARTED  host=$(hostname -s)  user=$(whoami)  pwd=$(pwd)"
logln "  claude=$("$CLAUDE_BIN" --version 2>/dev/null || echo 'NOT FOUND')"
logln "────────────────────────────────────────────────────────────────"

# Stream the agent's stdout+stderr through the prefixer into the day's log.
# Model + reasoning are pinned for the scheduled run: Sonnet 4.6 (much faster than
# the default Opus 4.8) at medium effort — keeps the judgment the pilot relies on.
# (Add --verbose before the redirect for a tool-by-tool trace; bump --effort to
# high if a digest's judgment ever looks off.)
"$CLAUDE_BIN" --model claude-sonnet-4-6 --effort medium \
  -p "Read digest.md and execute its instructions exactly." 2>&1 | prefix
EXIT=${pipestatus[1]}                               # zsh: claude's exit code (1st in pipe)

DUR=$(( $(date '+%s') - START_EPOCH ))
logln "────────────────────────────────────────────────────────────────"
if [ "$EXIT" -eq 0 ]; then
  logln "✅ RUN FINISHED OK   (exit ${EXIT}, ${DUR}s)"
else
  logln "❌ RUN FAILED        (exit ${EXIT}, ${DUR}s)"
fi
logln "════════════════════════════════════════════════════════════════"

exit "$EXIT"
