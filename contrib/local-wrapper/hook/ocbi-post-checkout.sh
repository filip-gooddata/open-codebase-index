#!/usr/bin/env bash
# git post-checkout hook for checkouts of a project listed in projects.conf. Register it per
# repository, either in the local git config, on a git with config-based hooks
# (hook.<name>.event; git 2.43 lacks them):
#   git -C <repo> config --local hook.ocbi-prewarm.event post-checkout
#   git -C <repo> config --local hook.ocbi-prewarm.command <OCBI_HOME>/ocbi-post-checkout.sh
# or, on any git and when the repository has no post-checkout hook yet, as a symlink:
#   ln -s <OCBI_HOME>/ocbi-post-checkout.sh <git common dir>/hooks/post-checkout
# After a branch checkout, including `git worktree add`, it refreshes the shared OCBI index for
# this worktree in the background, so the index is warm before agent sessions query it. File
# checkouts ($3 = 0) and rebases are skipped. One refresh per worktree at a time; a checkout
# during a running refresh queues exactly one more pass.
# Runs only in checkouts linked to a shared store (OCBI_REQUIRE_PROJECT=*); elsewhere the log
# records the refusal. Logs: $OCBI_HOME/logs/prewarm/<worktree dir>-<path checksum>.log.
# Set OCBI_PREWARM=0 to skip.
set -u
[ "${3:-0}" = 1 ] || exit 0
[ "${OCBI_PREWARM:-1}" = 0 ] && exit 0
case "${GIT_REFLOG_ACTION:-}" in rebase*) exit 0 ;; esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
# git exports these to hooks. Left set, they make the launcher's git calls describe this hook's
# repository view instead of the checkout it resolves from the working directory, so a primary
# checkout would be linked to the worktree profile.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX
# OCBI_HOME defaults to the directory of this script, after following symlinks to it.
self="$0"
while [ -L "$self" ]; do
  t="$(readlink "$self")"
  case "$t" in /*) self="$t" ;; *) self="$(dirname "$self")/$t" ;; esac
done
home=${OCBI_HOME:-$(cd "$(dirname "$self")" && pwd)}
# Worktrees of different repositories often share a directory name, so the key adds a checksum
# of the full path.
name=$(basename "$root")-$(printf '%s' "$root" | cksum | cut -d' ' -f1)
state=$home/logs/prewarm
mkdir -p "$state" || exit 0
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

(
  trap 'rm -rf "$lock"' EXIT
  cd "$root" || exit 0
  while :; do
    rm -f "$again"
    echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $(git rev-parse --abbrev-ref HEAD 2>/dev/null) $(git rev-parse --short HEAD 2>/dev/null)"
    OCBI_HOME="$home" OCBI_REQUIRE_PROJECT='*' nice -n 10 "$home/ocbi-mcp.sh" --cbi index --host claude
    echo "== exit $? $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ -e "$again" ] || break
  done
) </dev/null >> "$state/$name.log" 2>&1 &
echo $! > "$lock/pid"
disown
exit 0
