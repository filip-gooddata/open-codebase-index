#!/usr/bin/env bash
# Usage: ocbi-rebuild.sh CHECKOUT
# Full rebuild of the shared store of the repository CHECKOUT (an absolute path) belongs to. The
# repository needs a repository config, <git common dir>/codebase-index/config.json. Started on
# demand by `ocbi-rebuild [CHECKOUT]`, through a launchd job on macOS or a systemd user unit on
# Linux, or detached with nohup without them. OCBI_HOME defaults to the directory this script is
# installed in. When CHECKOUT is omitted, the path in $OCBI_HOME/rebuild.request (written by
# `ocbi-rebuild`) is used.
#
# A forced index drops every branch catalog. Before `ocbi prune` existed this was the only way to
# drop the catalogs of deleted branches and removed worktrees; prefer `ocbi prune --apply` for
# that now. Only the primary checkout may force-clear a shared store, so the forced index runs
# there: checkouts.primary.path from the repository config, else the main worktree of a normal
# clone (the directory holding the .git common dir). Afterwards each other worktree gets its
# catalog back with an incremental index, which reuses the embeddings the primary just produced.
# Notifies through $OCBI_HOME/ocbi-notify.sh, when installed, when it starts and when it ends.
# The CLI runs with --host $OCBI_HOST (default claude). Before forcing, it checks that the
# embedding provider answers: for the ollama provider (what `ocbi status` reports for the primary)
# Ollama's API at $OLLAMA_HOST (default localhost:11434), as the package reaches it; no check for
# other providers. OCBI_REBUILD_PREFLIGHT_URL replaces that URL; an empty value skips the check.
set -u

if [ -z "${OCBI_HOME:-}" ]; then
  OCBI_HOME="$(cd "$(dirname "$0")" && pwd)" || exit 1
fi
NODE="${OCBI_NODE:-@NODE@}"
CBI_JS="$OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cbi.js"
HOST="${OCBI_HOST:-claude}"
LOG_DIR="$OCBI_HOME/logs"
LOG="$LOG_DIR/rebuild-$(date +%Y%m%d-%H%M%S).log"
RUN_LOCK="$OCBI_HOME/rebuild.flock"
BUSY_WAIT_SECONDS="${OCBI_REBUILD_BUSY_WAIT:-1800}"
BUSY_POLL_SECONDS="${OCBI_REBUILD_BUSY_POLL:-30}"
RETRY_SECONDS="${OCBI_REBUILD_RETRY:-120}"
usage() { echo "usage: ocbi-rebuild.sh CHECKOUT (an absolute path in a repository with <git common dir>/codebase-index/config.json)" >&2; exit 64; }

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX
CHECKOUT="${1:-}"
if [ -z "$CHECKOUT" ] && [ -f "$OCBI_HOME/rebuild.request" ]; then
  CHECKOUT="$(head -n 1 "$OCBI_HOME/rebuild.request")"
fi
case "$CHECKOUT" in /*) ;; *) usage ;; esac
COMMON_DIR="$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || usage
COMMON_DIR="$(cd "$COMMON_DIR" && pwd -P)" || usage
CONFIG="$COMMON_DIR/codebase-index/config.json"
[ -f "$CONFIG" ] || { echo "$CHECKOUT has no repository config $CONFIG; nothing to rebuild" >&2; exit 64; }
# checkouts.primary.path is absolute, ~/..., or relative to the common dir, as the package reads it.
MAIN_WORKTREE="$(cd "$COMMON_DIR" && "$NODE" -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.checkouts?.primary?.path;
  if (typeof p !== "string" || p.trim() === "") process.exit(0);
  console.log(path.resolve(p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p));' -- "$CONFIG" 2>/dev/null)" ||
  { echo "cannot read $CONFIG" >&2; exit 64; }
if [ -z "$MAIN_WORKTREE" ]; then
  if [ "$(basename "$COMMON_DIR")" != .git ] || [ "$(git --git-dir="$COMMON_DIR" config --bool core.bare 2>/dev/null)" = true ]; then
    echo "$COMMON_DIR is a bare-base layout; set checkouts.primary.path in $CONFIG to name its primary checkout" >&2
    exit 64
  fi
  MAIN_WORKTREE="$(dirname "$COMMON_DIR")"
fi
[ -d "$MAIN_WORKTREE" ] || { echo "the primary checkout $MAIN_WORKTREE does not exist" >&2; exit 64; }
# The primary must be the root of a checkout of this same repository.
MAIN_WORKTREE="$(cd "$MAIN_WORKTREE" && pwd -P)" || exit 64
if [ "$(git -C "$MAIN_WORKTREE" rev-parse --show-toplevel 2>/dev/null)" != "$MAIN_WORKTREE" ] ||
  [ "$(cd "$(git -C "$MAIN_WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)" != "$COMMON_DIR" ]; then
  echo "the primary checkout $MAIN_WORKTREE is not the root of a checkout of $COMMON_DIR" >&2
  exit 64
fi
NAME="$(basename "$MAIN_WORKTREE")"

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
  notify "Rebuild of $NAME failed" "$1" "Show log" "$OPEN '$LOG'"
  exit 1
}

# The progress lines repeat every second; keep only the summary lines in the log. The output of
# the last call is also left in $CBI_OUT. The repository config routes every checkout to the
# shared store, so no checkout here indexes a local or global index.
cbi() {
  local worktree="$1"
  shift
  (cd "$worktree" && "$NODE" "$CBI_JS" "$@" --host "$HOST" --project "$worktree") 2>&1 |
    grep -v -E '^(Embedding|Parsing): ' | tee "$CBI_OUT" >>"$LOG"
  return "${PIPESTATUS[0]}"
}

# route WORKTREE: the Store and Checkout role lines the package reports for WORKTREE. A store that
# is not the repository's (global scope, or no repository config) prints another Store line.
route() {
  (cd "$1" && "$NODE" "$CBI_JS" status --host "$HOST" --project "$1" 2>/dev/null) | grep -E '^(Store|Checkout role): '
}
repo_store() { printf '%s\n' "$1" | grep -E '^Store: .* \((repository config |repository default store\))'; }
# on_store WORKTREE [primary]: WORKTREE still reports $STORE (and, with "primary", the primary role).
# Checked before every index attempt, so a config edit between retries cannot redirect one.
on_store() {
  local r
  r="$(route "$1")"
  [ "$(repo_store "$r")" = "$STORE" ] || { log "$1 does not report the store $STORE (${r:-no status})"; return 1; }
  [ "${2:-}" != primary ] || printf '%s\n' "$r" | grep -q '^Checkout role: primary - ' ||
    { log "the package does not treat $1 as the primary checkout (${r:-no status})"; return 1; }
}

# The forced index drops every catalog, so agents in open sessions call index_codebase and their
# MCP workers take the index lock for minutes at a time. Wait for them instead of skipping the
# worktree: INDEX_BUSY is retried for up to $BUSY_WAIT_SECONDS, any other failure once.
index_worktree() {
  local worktree="$1" deadline=$(($(date +%s) + BUSY_WAIT_SECONDS)) retried=0
  until on_store "$worktree" && cbi "$worktree" index; do
    on_store "$worktree" || return 1
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
    exec("bash", @cmd) or die "cannot run bash: $!\n";' "$RUN_LOCK" "$0" "$CHECKOUT"
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

if [ -n "${OCBI_REBUILD_PREFLIGHT_URL+set}" ]; then
  PREFLIGHT_URL="$OCBI_REBUILD_PREFLIGHT_URL"
else
  provider="$( (cd "$MAIN_WORKTREE" && "$NODE" "$CBI_JS" status --json --host "$HOST" --project "$MAIN_WORKTREE") 2>/dev/null |
    "$NODE" -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const p = JSON.parse(s).provider; if (typeof p === "string") console.log(p); } catch {} });')"
  case "$provider" in
    # Unknown when status fails; the Ollama default is what earlier versions always checked.
    ollama | "") PREFLIGHT_URL="${OLLAMA_HOST:-http://localhost:11434}"; PREFLIGHT_URL="${PREFLIGHT_URL%/}/api/tags" ;;
    *) PREFLIGHT_URL=""; log "embedding provider $provider: no preflight check" ;;
  esac
fi
if [ -n "$PREFLIGHT_URL" ] && ! curl -sf -m 5 "$PREFLIGHT_URL" >/dev/null; then
  fail "The embedding provider is not responding on $PREFLIGHT_URL, so nothing was rebuilt."
fi

started=$(date +%s)
notify "Rebuild of $NAME started" "Search in agent sessions may wait or ask to retry until it ends."
log "forced rebuild of $MAIN_WORKTREE"

# Check the route right before forcing: the repository's store, project scope, primary role.
main_route="$(route "$MAIN_WORKTREE")"
STORE="$(repo_store "$main_route")"
[ -n "$STORE" ] || fail "Nothing was rebuilt: $MAIN_WORKTREE does not use the repository's shared store (${main_route:-no status})."
printf '%s\n' "$main_route" | grep -q '^Checkout role: primary - ' ||
  fail "Nothing was rebuilt: the package does not treat $MAIN_WORKTREE as the primary checkout ($(printf '%s' "$main_route" | grep '^Checkout role: ' || echo 'no role'))."
log "$STORE"

# A session's auto-index can hold the index lock; give it a few chances to finish.
rebuilt=0
for attempt in 1 2 3; do
  on_store "$MAIN_WORKTREE" primary || fail "Nothing more was rebuilt: the route of $MAIN_WORKTREE changed before attempt $attempt; see the log."
  if cbi "$MAIN_WORKTREE" index --force --allow-shared-rebuild; then
    rebuilt=1
    break
  fi
  # A checkout the package treats as secondary can never force-clear the store; retrying is useless.
  if grep -q 'limited to the primary checkout' "$CBI_OUT"; then
    fail "Nothing was rebuilt: $(grep -m 1 -o 'Project-scoped force rebuild is limited to the primary checkout.*' "$CBI_OUT")"
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
log "done in ${minutes} min: $worktrees worktrees${failed:+, failed:$failed}"
if [ -n "$failed" ]; then
  notify "Rebuild of $NAME finished with errors" "Failed:$failed. $worktrees worktrees indexed in ${minutes} min." "Show log" "$OPEN '$LOG'"
  exit 1
fi
notify "Rebuild of $NAME finished" "$worktrees worktrees, ${minutes} min."
