#!/usr/bin/env bash
# Usage: ocbi-check.sh [CHECKOUT...]
# The optional scheduled check. The post-checkout hook installed with `ocbi hooks install
# --stale-notify` runs the same two checks once a day after a checkout; this timer is for machines
# that rarely check out a branch. Run daily by the launchd job or systemd timer that `ocbi-schedule install`
# registers. For each checkout (the arguments, else the lines of $OCBI_HOME/check.conf; blank lines
# and # comments are skipped) of a repository with a repository config, it notifies when
#   - the store no longer matches the configured embedding provider or model (a full rebuild is
#     needed): action Rebuild, which runs `ocbi-rebuild CHECKOUT`;
#   - `ocbi prune` would remove OCBI_STALE_THRESHOLD (15) or more catalogs of deleted branches and
#     removed worktrees: action Prune, which runs `ocbi prune --apply` for that checkout (skipped
#     with OCBI_STALE_CHECK=0, for instance where the post-checkout hook already notifies through
#     `ocbi hooks install --stale-notify`).
# It never rebuilds or prunes by itself; both wait for the user's click (or the printed command
# where notifications cannot carry a button). Checkouts of one repository are checked once. Nothing
# is checked while a rebuild runs. Notifies through $OCBI_HOME/ocbi-notify.sh when installed, and
# logs to $OCBI_HOME/logs/check.log. OCBI_HOME defaults to the directory this script is installed
# in; the CLI runs with --host $OCBI_HOST (default claude).
set -u

if [ -z "${OCBI_HOME:-}" ]; then
  OCBI_HOME="$(cd "$(dirname "$0")" && pwd)" || exit 1
fi
NODE="${OCBI_NODE:-@NODE@}"
CBI_JS="$OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cbi.js"
HOST="${OCBI_HOST:-claude}"
REBUILD_CMD="${OCBI_REBUILD_CMD:-@BIN_DIR@/ocbi-rebuild}"
THRESHOLD="${OCBI_STALE_THRESHOLD:-15}"
LOG_DIR="$OCBI_HOME/logs"
LOG="$LOG_DIR/check.log"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX

mkdir -p "$LOG_DIR" || exit 1
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
# quote ARG: ARG as one single-quoted shell word.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
notify() {
  [ -x "$OCBI_HOME/ocbi-notify.sh" ] || return 0
  "$OCBI_HOME/ocbi-notify.sh" "$@" >/dev/null 2>&1 || true
}

# A rebuild drops and refills every catalog; its intermediate state is no reason to notify.
if [ -f "$OCBI_HOME/rebuild.flock" ] &&
  ! perl -MFcntl=:flock -e 'open(my $f, "<", $ARGV[0]) or exit 0; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' -- "$OCBI_HOME/rebuild.flock"; then
  log "a rebuild is running; nothing checked"
  exit 0
fi

if [ $# -gt 0 ]; then
  checkouts="$(printf '%s\n' "$@")"
elif [ -f "$OCBI_HOME/check.conf" ]; then
  checkouts="$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^#/d' -e '/^$/d' "$OCBI_HOME/check.conf")"
else
  checkouts=""
fi
[ -n "$checkouts" ] || { log "no checkouts to check (add them with ocbi-schedule install CHECKOUT)"; exit 0; }

# The first line of the compatibility verdict in `status --json`: "incompatible<TAB>reason" when the
# stored provider or model differs from the configured one, nothing otherwise.
compat_js='let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try { const c = JSON.parse(s).compatibility;
    if (c && c.compatible === false) console.log("incompatible\t" + String(c.reason || "provider or model changed").replace(/\s+/g, " ")); } catch {} });'
count_js='let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try { const n = JSON.parse(s).catalogs.length; if (Number.isInteger(n)) console.log(n); } catch {} });'

seen=""
status=0
while IFS= read -r checkout; do
  root="$(git -C "$checkout" rev-parse --show-toplevel 2>/dev/null)" &&
    common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
    common="$(cd "$common" && pwd -P)" ||
    { log "skipped $checkout: not a git checkout"; status=1; continue; }
  case "$seen" in *"|$common|"*) continue ;; esac
  seen="$seen|$common|"
  [ -f "$common/codebase-index/config.json" ] ||
    { log "skipped $root: no repository config $common/codebase-index/config.json"; status=1; continue; }
  repo="$(basename "$common")"
  [ "$repo" = .git ] && repo="$(basename "$(dirname "$common")")"

  verdict="$(cd "$root" && "$NODE" "$CBI_JS" status --json --host "$HOST" --project "$root" 2>/dev/null | "$NODE" -e "$compat_js")"
  if [ -n "$verdict" ]; then
    reason="${verdict#*	}"
    reason="${reason%.}"
    log "$repo: full rebuild needed: $reason"
    notify "Rebuild needed: $repo" "$reason. A full rebuild re-embeds every file with the configured model." \
      "Rebuild" "$(quote "$REBUILD_CMD") $(quote "$root")"
    continue
  fi

  [ "${OCBI_STALE_CHECK:-1}" != 0 ] || continue
  stale="$(cd "$root" && "$NODE" "$CBI_JS" prune --json --host "$HOST" --project "$root" 2>/dev/null | "$NODE" -e "$count_js")"
  if [ -z "$stale" ]; then
    log "$repo: prune dry run failed"
    status=1
    continue
  fi
  log "$repo: $stale catalogs of deleted branches or worktrees"
  [ "$stale" -ge "$THRESHOLD" ] || continue
  notify "Worth a cleanup: $repo" "$stale catalogs of deleted branches or worktrees." \
    "Prune" "cd $(quote "$root") && $(quote "$NODE") $(quote "$CBI_JS") prune --apply --host $(quote "$HOST") --project $(quote "$root") >>$(quote "$LOG_DIR/prune.log") 2>&1"
done <<EOF
$checkouts
EOF
exit "$status"
