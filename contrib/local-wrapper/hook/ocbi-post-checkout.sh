#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted JavaScript program
# git post-checkout hook for repositories with a repository config
# (<git common dir>/codebase-index/config.json). Register it per repository, either in the local
# git config, on a git with config-based hooks (hook.<name>.event; git 2.43 lacks them):
#   git -C <repo> config --local hook.ocbi-prewarm.event post-checkout
#   git -C <repo> config --local hook.ocbi-prewarm.command "'<OCBI_HOME>/ocbi-post-checkout.sh'"
# (git runs the value through the shell, hence the inner quotes)
# or, on any git and when the repository has no post-checkout hook yet, as a symlink:
#   ln -s <OCBI_HOME>/ocbi-post-checkout.sh <git common dir>/hooks/post-checkout
# After a branch checkout, including `git worktree add`, it runs `ocbi index` for this checkout in
# the background, so its branch catalog in the shared store is warm before agent sessions query
# it. File checkouts ($3 = 0) and rebases are skipped. One refresh per worktree at a time; a
# checkout during a running refresh queues exactly one more pass.
# Without a repository config, or when the package does not report the repository's store for
# this checkout (a global scope, say), the hook does nothing but log that, so it never builds a
# checkout-local or global index. After a refresh, at most once a day per repository, it counts the branch
# catalogs `ocbi prune` would remove and, from OCBI_STALE_THRESHOLD (15) on, notifies through
# $OCBI_HOME/ocbi-notify.sh when that is installed (OCBI_STALE_CHECK=0 turns this off).
# The CLI runs with --host $OCBI_HOST (default claude). Logs:
# $OCBI_HOME/logs/prewarm/<worktree dir>-<path checksum>.log. Set OCBI_PREWARM=0 to skip.
set -u
[ "${3:-0}" = 1 ] || exit 0
[ "${OCBI_PREWARM:-1}" = 0 ] && exit 0
case "${GIT_REFLOG_ACTION:-}" in rebase*) exit 0 ;; esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
# git exports these to hooks. Left set, they would make the CLI's git calls describe this hook's
# repository view instead of the checkout it indexes.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX
common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
# OCBI_HOME defaults to the directory of this script, after following symlinks to it.
self="$0"
while [ -L "$self" ]; do
  t="$(readlink "$self")"
  case "$t" in /*) self="$t" ;; *) self="$(dirname "$self")/$t" ;; esac
done
home=${OCBI_HOME:-$(cd "$(dirname "$self")" && pwd)}
node=${OCBI_NODE:-@NODE@}
host=${OCBI_HOST:-claude}
cbi=$home/pkg/node_modules/open-codebase-index/dist/cbi.js
# Worktrees of different repositories often share a directory name, so keys add a checksum of the
# full path.
key() { printf '%s-%s' "$(basename "$1")" "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"; }
name=$(key "$root")
state=$home/logs/prewarm
mkdir -p "$state" || exit 0
if [ ! -f "$common/codebase-index/config.json" ]; then
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) skipped: no repository config $common/codebase-index/config.json" >>"$state/$name.log"
  exit 0
fi
lock=$state/$name.lock
again=$state/$name.again

if ! mkdir "$lock" 2>/dev/null; then
  pid=$(cat "$lock/pid" 2>/dev/null)
  # A lock without a pid is a hook that has not written it yet, unless it is a minute old.
  if { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; } ||
    { [ -z "$pid" ] && [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }; then
    : > "$again"
    exit 0
  fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || exit 0
fi

# Counts the catalogs `ocbi prune` would remove and notifies past the threshold. Skipped while a
# rebuild holds its flock, and run at most once a day per repository.
stale_check() {
  [ "${OCBI_STALE_CHECK:-1}" != 0 ] && [ -x "$home/ocbi-notify.sh" ] || return 0
  [ -f "$home/rebuild.flock" ] && ! perl -MFcntl=:flock -e 'open(my $f, "<", $ARGV[0]) or exit 0; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "$home/rebuild.flock" && return 0
  local stamp repo stale
  stamp=$state/$(key "$common").stale-check
  [ -n "$(find "$stamp" -mmin -1440 2>/dev/null)" ] && return 0
  repo=$(basename "$common")
  [ "$repo" = .git ] && repo=$(basename "$(dirname "$common")")
  stale=$("$node" "$cbi" prune --json --host "$host" --project "$root" 2>/dev/null |
    "$node" -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const n = JSON.parse(s).catalogs.length; if (Number.isInteger(n)) console.log(n); } catch {} });') || return 0
  [ -n "$stale" ] || return 0
  touch "$stamp"
  [ -n "$stale" ] && [ "$stale" -ge "${OCBI_STALE_THRESHOLD:-15}" ] || return 0
  echo "== $stale catalogs of deleted branches or worktrees"
  "$home/ocbi-notify.sh" "Worth a cleanup: $repo" \
    "$stale catalogs of deleted branches or worktrees. Run: $node $cbi prune --apply --project $root" >/dev/null 2>&1
}

(
  trap 'rm -rf "$lock"' EXIT
  cd "$root" || exit 0
  while :; do
    rm -f "$again"
    echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $(git rev-parse --abbrev-ref HEAD 2>/dev/null) $(git rev-parse --short HEAD 2>/dev/null)"
    store=$("$node" "$cbi" status --host "$host" --project "$root" 2>/dev/null | grep -E '^Store: ')
    if ! printf '%s\n' "$store" | grep -qE '^Store: .* \((repository config |repository default store\))'; then
      echo "== skipped: not the repository's shared store (${store:-no status})"
      exit 0
    fi
    nice -n 10 "$node" "$cbi" index --host "$host" --project "$root"
    echo "== exit $? $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ -e "$again" ] || break
  done
  stale_check
) </dev/null >> "$state/$name.log" 2>&1 &
echo $! > "$lock/pid"
disown
exit 0
