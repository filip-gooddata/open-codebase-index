#!/usr/bin/env bash
# Usage: ocbi-rebuild.sh PROJECT
# Full rebuild of the shared index of PROJECT (a name in $OCBI_HOME/projects.conf). Started on
# demand by `ocbi-rebuild PROJECT`, through a launchd job on macOS or detached with nohup
# elsewhere. OCBI_HOME defaults to the directory this script is installed in. When PROJECT is
# omitted, the name in $OCBI_HOME/rebuild.request (written by `ocbi-rebuild`) is used.
#
# A forced index drops every branch catalog. Before `cbi prune` existed this was the only way to
# drop the catalogs of deleted branches and removed worktrees; prefer `cbi prune --apply` for
# that now. Afterwards each worktree that still exists gets its catalog back with an incremental
# index, which reuses the embeddings the primary checkout just produced. Notifies through
# $OCBI_HOME/ocbi-notify.sh, when installed, when it starts and when it ends.
#
# The primary checkout is the profiles.conf entry for PROJECT, else the first worktree git lists
# when that is not the bare common dir. Set OCBI_REBUILD_PREFLIGHT_URL to the embedding provider's
# health URL (default: Ollama on localhost:11434), or to an empty value to skip the check.
set -u

if [ -z "${OCBI_HOME:-}" ]; then
  OCBI_HOME="$(cd "$(dirname "$0")" && pwd)" || exit 1
fi
LAUNCHER="$OCBI_HOME/ocbi-mcp.sh"
LOG_DIR="$OCBI_HOME/logs"
LOG="$LOG_DIR/rebuild-$(date +%Y%m%d-%H%M%S).log"
RUN_LOCK="$OCBI_HOME/rebuild.flock"
BUSY_WAIT_SECONDS="${OCBI_REBUILD_BUSY_WAIT:-1800}"
BUSY_POLL_SECONDS="${OCBI_REBUILD_BUSY_POLL:-30}"
RETRY_SECONDS="${OCBI_REBUILD_RETRY:-120}"
PREFLIGHT_URL="${OCBI_REBUILD_PREFLIGHT_URL-http://localhost:11434/api/tags}"

PROJECT="${1:-}"
if [ -z "$PROJECT" ] && [ -f "$OCBI_HOME/rebuild.request" ]; then
  PROJECT="$(head -n 1 "$OCBI_HOME/rebuild.request")"
fi
if ! [[ "$PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  echo "usage: ocbi-rebuild.sh PROJECT (a name from $OCBI_HOME/projects.conf)" >&2
  exit 64
fi
COMMON_DIR="$(sed -n "s/^$PROJECT|\\([^|]*\\)\$/\\1/p" "$OCBI_HOME/projects.conf" 2>/dev/null | head -n 1)"
[ -n "$COMMON_DIR" ] || { echo "$PROJECT is not listed in $OCBI_HOME/projects.conf" >&2; exit 64; }
MAIN_WORKTREE="$(sed -n "s/^$PROJECT|\\([^|]*\\).*/\\1/p" "$OCBI_HOME/profiles.conf" 2>/dev/null | head -n 1)"
if [ -z "$MAIN_WORKTREE" ]; then
  MAIN_WORKTREE="$(git --git-dir="$COMMON_DIR" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
  if [ -z "$MAIN_WORKTREE" ] || [ "$(cd "$MAIN_WORKTREE" 2>/dev/null && pwd -P)" = "$(cd "$COMMON_DIR" && pwd -P)" ]; then
    echo "$COMMON_DIR is a bare clone; add $PROJECT to $OCBI_HOME/profiles.conf to name its primary checkout" >&2
    exit 64
  fi
fi
DB="$OCBI_HOME/$PROJECT/claude-index/codebase.db"

mkdir -p "$LOG_DIR"
CBI_OUT="$(mktemp "${TMPDIR:-/tmp}/ocbi-rebuild.XXXXXX")" || exit 1
# Keep the 8 newest logs. Listed from inside the directory, the names carry no spaces.
# shellcheck disable=SC2012
(cd "$LOG_DIR" && ls -1t rebuild-*.log 2>/dev/null | tail -n +9 | xargs rm -f)

if [ "$(uname -s)" = Darwin ]; then OPEN=open; else OPEN=xdg-open; fi

# notify TITLE BODY [ACTION_LABEL ACTION_COMMAND]
notify() {
  [ -x "$OCBI_HOME/ocbi-notify.sh" ] || return 0
  "$OCBI_HOME/ocbi-notify.sh" "$@" >/dev/null 2>&1 || true
}
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
fail() {
  log "FAILED: $1"
  notify "Rebuild of $PROJECT failed" "$1" "Show log" "$OPEN '$LOG'"
  exit 1
}

# The progress lines repeat every second; keep only the summary lines in the log. The output of
# the last call is also left in $CBI_OUT. OCBI_REQUIRE_PROJECT makes the launcher check, in the
# same call that indexes, that the checkout is linked to $PROJECT's shared store; otherwise it
# refuses (exit 3, or exit 1 with "refusing to start:" for a listed checkout that cannot be
# linked) and nothing is indexed, so a forced index never reaches a local or global index.
cbi() {
  local worktree="$1"
  shift
  (cd "$worktree" && OCBI_HOME="$OCBI_HOME" OCBI_REQUIRE_PROJECT="$PROJECT" bash "$LAUNCHER" --cbi "$@" --host claude --project "$worktree") 2>&1 |
    grep -v -E '^(Embedding|Parsing): ' | tee "$CBI_OUT" >>"$LOG"
  return "${PIPESTATUS[0]}"
}

# The forced index drops every catalog, so agents in open sessions call index_codebase and their
# MCP workers take the index lock for minutes at a time. Wait for them instead of skipping the
# worktree: INDEX_BUSY is retried for up to $BUSY_WAIT_SECONDS, a launcher refusal (exit 3, or
# "refusing to start:" for a listed checkout that cannot be linked) never, any other failure once.
index_worktree() {
  local worktree="$1" deadline=$(($(date +%s) + BUSY_WAIT_SECONDS)) retried=0
  local rc
  until cbi "$worktree" index; do
    rc=$?
    [ "$rc" = 3 ] && return 1
    grep -q '^\[ocbi-mcp\] refusing to start: ' "$CBI_OUT" && return 1
    if grep -q '^INDEX_BUSY: another index operation is already in progress' "$CBI_OUT"; then
      [ "$(date +%s)" -lt "$deadline" ] || return 1
      sleep "$BUSY_POLL_SECONDS"
    else
      [ "$retried" = 0 ] || return 1
      retried=1
      log "retrying in $RETRY_SECONDS s"
      sleep "$RETRY_SECONDS"
    fi
  done
}

# One rebuild at a time. The run happens in a copy of this script started by perl while it holds
# an exclusive flock on $RUN_LOCK; the descriptor stays open across exec in that copy and in
# everything it starts. The kernel drops the lock when the last of those processes exits, so a
# killed rebuild never blocks the next one, and no contender removes another run's lock.
if [ -z "${OCBI_REBUILD_LOCKED:-}" ]; then
  rm -f "$CBI_OUT"
  # shellcheck disable=SC2016 # a single-quoted Perl program
  OCBI_HOME="$OCBI_HOME" OCBI_REBUILD_LOCKED=1 "$(command -v perl || echo /usr/bin/perl)" -MFcntl=:flock -e '
    my ($lock, @cmd) = @ARGV;
    $^F = 255;
    open(my $fh, ">>", $lock) or die "cannot open $lock: $!\n";
    flock($fh, LOCK_EX | LOCK_NB) or exit 75;
    exec("bash", @cmd) or die "cannot run bash: $!\n";' "$RUN_LOCK" "$0" "$PROJECT"
  rc=$?
  if [ "$rc" = 75 ]; then
    log "another rebuild is running; exiting"
    exit 0
  fi
  exit "$rc"
fi
trap 'rm -f "$CBI_OUT"' EXIT

# Keep the machine awake while this runs (macOS). A closed lid still suspends the run.
command -v caffeinate >/dev/null 2>&1 && caffeinate -i -w $$ &

if [ -n "$PREFLIGHT_URL" ] && ! curl -sf -m 5 "$PREFLIGHT_URL" >/dev/null; then
  fail "The embedding provider is not responding on $PREFLIGHT_URL, so nothing was rebuilt."
fi

started=$(date +%s)
notify "Rebuild of $PROJECT started" "Search in agent sessions may wait or ask to retry until it ends."
log "forced rebuild of $MAIN_WORKTREE"

# A session's auto-index can hold the index lock; give it a few chances to finish.
rebuilt=0
for attempt in 1 2 3; do
  if cbi "$MAIN_WORKTREE" index --force --allow-shared-rebuild; then
    rebuilt=1
    break
  fi
  if grep -q '^\[ocbi-mcp\] refusing to start: ' "$CBI_OUT"; then
    fail "Nothing was rebuilt: $(grep -m 1 '^\[ocbi-mcp\] refusing to start: ' "$CBI_OUT" | sed 's/^\[ocbi-mcp\] //')"
  fi
  if grep -q "refusing to run the CLI" "$CBI_OUT"; then
    fail "$MAIN_WORKTREE is not linked to the shared store of $PROJECT, so nothing was rebuilt. Run ocbi-mcp.sh --link-only there to see why."
  fi
  log "attempt $attempt failed; retrying in $RETRY_SECONDS s"
  sleep "$RETRY_SECONDS"
done
[ "$rebuilt" = 1 ] || fail "The forced index of $MAIN_WORKTREE failed 3 times."

worktrees=1
failed=""
main_phys="$(cd "$MAIN_WORKTREE" && pwd -P)"
common_phys="$(cd "$COMMON_DIR" && pwd -P)"
while IFS= read -r worktree; do
  [ -d "$worktree" ] || continue
  phys="$(cd "$worktree" && pwd -P)"
  [ "$phys" = "$main_phys" ] || [ "$phys" = "$common_phys" ] && continue
  log "incremental index of $worktree"
  if index_worktree "$worktree"; then
    worktrees=$((worktrees + 1))
  else
    failed="$failed $(basename "$worktree")"
  fi
done < <(git --git-dir="$COMMON_DIR" worktree list --porcelain | sed -n 's/^worktree //p')

minutes=$((($(date +%s) - started + 59) / 60))
chunks=$(sqlite3 -readonly "$DB" 'select count(*) from chunks' 2>/dev/null || echo "?")
log "done in ${minutes} min: $worktrees worktrees, $chunks chunks${failed:+, failed:$failed}"
if [ -n "$failed" ]; then
  notify "Rebuild of $PROJECT finished with errors" "Failed:$failed. $worktrees worktrees indexed in ${minutes} min." "Show log" "$OPEN '$LOG'"
  exit 1
fi
notify "Rebuild of $PROJECT finished" "$worktrees worktrees, $chunks chunks, ${minutes} min."
