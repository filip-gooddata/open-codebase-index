#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted JavaScript and Perl programs
# Launches the pinned open-codebase-index MCP server for Claude Code and Codex.
#
# OCBI_HOME is the directory this script is installed in unless the environment sets it. It holds
# pkg/ (the npm install of open-codebase-index), mcp-force-guard.mjs, projects.conf, profiles.conf
# and one store directory per listed project. Runs on macOS (bash 3.2, BSD tools) and Linux (bash
# 4/5, GNU tools); needs git, perl, Node.js >= 22, and sqlite3 for --stale-check only.
#
# Projects listed in $OCBI_HOME/projects.conf ("name|git common dir" per line; nothing is listed
# when the file is missing) get one index shared by every worktree. open-codebase-index only
# shares an index when the git common dir is named ".git", which rules out a bare clone, and it
# would keep the index inside the checkout. So for each worktree of a listed project this script
# links
#   <worktree>/.claude/index               -> $OCBI_HOME/<name>/claude-index
#   <worktree>/.claude/codebase-index.json -> $OCBI_HOME/<name>/codebase-index.json
# before the server starts. Names are [A-Za-z0-9][A-Za-z0-9_-]*; other lines are ignored.
# Linking needs a real store dir $OCBI_HOME/<name> with its config, and both paths ignored by
# info/exclude and not tracked. Otherwise nothing is linked, links this script made earlier
# (to any $OCBI_HOME/<name> store) are removed, and a warning says which config now applies.
# Anything else in the way of a link is parked in $OCBI_HOME/<name>/parked/<stamp>-<random>/
# with an "origin" file. If a link step fails, the script exits 1 without starting anything.
# Everywhere else the server runs on the inert ~/.claude/codebase-index.json.
#
# A project that also has a "name|primary checkout[|its absolute git dir]" line in
# $OCBI_HOME/profiles.conf links .claude/codebase-index.json to a profile generated from its base
# config instead:
#   $OCBI_HOME/<name>/profiles/main.json      the primary checkout: background indexing as in
#                                             the base config, autoIndexOnStartup = autoIndex
#   $OCBI_HOME/<name>/profiles/worktree.json  every other worktree: on demand, autoIndexOnStartup
#                                             and watchFiles false
# autoIndex and every other key come from the base config, so a base with autoIndex false stays
# off in both profiles. The primary is the declared path when git agrees. In a normal clone that
# is the checkout whose git dir is the common dir. A bare clone has no such checkout, so its line
# must pin the git dir: the declared checkout's common dir, git dir and the git dir's gitdir
# back-pointer must all match the pin. Branch and path names, or being a listed worktree, play no
# part. A missing or wrong pin, an invalid line or a declared path git does not confirm gives
# every checkout the worktree profile, with the reason logged and in status. A profile is
# regenerated whenever it differs from what the base config yields; one whose content no longer
# matches its recorded hash is parked first. Generation is serialized by a flock on
# profiles/.lock and repeated until the base config is unchanged across it. A profiles dir,
# profile, .sha256 sidecar or lock that is not a plain dir or file stops the launch (exit 1)
# without writing through it.
#
# Modes:
#   (no args)        link if listed, then exec the MCP server behind mcp-force-guard.mjs
#   --link-only      link if listed, print the project root, exit
#   --session-hint   print the routing hint for listed projects only (SessionStart hook)
#   --guard-force    PreToolUse hook: block index_codebase force=true, which would wipe the
#                    shared index for every worktree; rebuild from a terminal instead
#   --cbi ARGS...    link if listed, then run the ocbi CLI (dist/cbi.js) with ARGS. With
#                    OCBI_REQUIRE_PROJECT=<name> it runs only when this checkout is linked to
#                    the shared store of <name> (any listed project for "*") and exits 3
#                    otherwise, so a forced or background index never lands on a local or
#                    global index. A guarded run accepts only the `index` subcommand, refuses
#                    --config and any --host or --project other than claude and this root,
#                    passes its own --host claude --project <absolute root>, and checks that
#                    the linked config is project-scoped. The hook and the rebuild set it.
#   --stale-check    for the listed project of the current directory, count branch catalogs
#                    whose branch or worktree is gone and, once they reach OCBI_STALE_THRESHOLD
#                    (15), notify through $OCBI_HOME/ocbi-notify.sh when it is installed. The
#                    server start runs it in the background, at most once a day per project;
#                    OCBI_STALE_CHECK=0 turns that off.
#   --status-output  PostToolUse hook for index_status: Claude Code shows the model only the
#                    tool's structuredContent ({"mcpDiagnostics":...}), not the status text,
#                    so replace the output with the text of `cbi status`
set -u

if [ "${1:-}" = "--guard-force" ]; then
  if tr -d '\n\r' | grep -Eq '"force"[[:space:]]*:[[:space:]]*true'; then
    echo "Blocked: index_codebase force=true wipes the shared index for every worktree and re-embeds everything. Use index_codebase without force for normal refreshes. If a full rebuild is really needed, ask the user to run one from a terminal (ocbi-rebuild, when installed)." >&2
    exit 2
  fi
  exit 0
fi

# OCBI_HOME defaults to the directory of this script, after following symlinks to it.
if [ -z "${OCBI_HOME:-}" ]; then
  self="$0"
  while [ -L "$self" ]; do
    t="$(readlink "$self")"
    case "$t" in /*) self="$t" ;; *) self="$(dirname "$self")/$t" ;; esac
  done
  OCBI_HOME="$(cd "$(dirname "$self")" && pwd)" || exit 1
fi
PROJECTS_CONF="$OCBI_HOME/projects.conf"
PROFILES_CONF="$OCBI_HOME/profiles.conf"
SERVER_JS="$OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cli.js"
STALE_THRESHOLD="${OCBI_STALE_THRESHOLD:-15}"
OCBI_BIN_DIR="${OCBI_BIN_DIR:-$HOME/.local/bin}"

log() { printf '[ocbi-mcp] %s\n' "$*" >&2; }

pick_node() {
  local candidate major
  for candidate in "${OCBI_NODE:-}" "$(command -v node 2>/dev/null)" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || continue
    if [ "${major:-0}" -ge 22 ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; }

# Physical path of an existing directory, or nothing.
phys_dir() { [ -n "$1" ] && (cd "$1" 2>/dev/null && pwd -P); }

STORE_ROOT="$(phys_dir "$OCBI_HOME")"

# True when $2 is "<valid name>/X", where X is claude-index for .claude/index ($1 = index) and
# codebase-index.json, profiles/main.json or profiles/worktree.json for the config.
owned_rest() {
  local want
  case "$1" in
    index) want="claude-index" ;;
    *) want="codebase-index.json profiles/main.json profiles/worktree.json" ;;
  esac
  valid_name "${2%%/*}" && [[ " $want " == *" ${2#*/} "* ]] && [ "${2#*/}" != "$2" ]
}

# True when $1 is a symlink this script may have made: it names $OCBI_HOME/<owned_rest>, either
# literally or once resolved.
owned_link() {
  local link="$1" kind t rest parent
  [ -L "$link" ] || return 1
  case "${link##*/}" in
    index) kind=index ;;
    codebase-index.json) kind=config ;;
    *) return 1 ;;
  esac
  t="$(readlink "$link")" || return 1
  case "$t" in /*) ;; *) t="${link%/*}/$t" ;; esac
  rest="${t#"$OCBI_HOME"/}"
  if [ "$rest" != "$t" ] && owned_rest "$kind" "$rest"; then
    return 0
  fi
  [ -n "$STORE_ROOT" ] && parent="$(phys_dir "${t%/*}")" || return 1
  rest="${parent#"$STORE_ROOT"/}"
  [ "$rest" != "$parent" ] && owned_rest "$kind" "$rest/${t##*/}"
}

list_projects() {
  [ -f "$PROJECTS_CONF" ] && grep -Ev '^[[:space:]]*(#|$)' "$PROJECTS_CONF"
  return 0
}

# project: the listed name owning this worktree; route: linked, global, local or error.
root="$PWD"
common=""
project=""
route=""
why=""
if top="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)"; then
  root="$top"
  common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  common="$( [ -n "$common" ] && phys_dir "$common")"
  while IFS='|' read -r name dir extra; do
    if ! valid_name "$name" || [ -n "$extra" ] || [ "${dir#/}" = "$dir" ]; then
      log "ignoring invalid projects.conf line for name '$name'"
      continue
    fi
    [ -n "$common" ] && [ "$(phys_dir "$dir")" = "$common" ] || continue
    project="$name"
    break
  done < <(list_projects)
fi
SHARED_DIR="$OCBI_HOME/$project"
node_bin=""

# Catalogs are keyed by branch name, or by the 7-character SHA of a detached HEAD.
if [ "${1:-}" = "--stale-check" ]; then
  [ -n "$project" ] && [ -d "$SHARED_DIR" ] && [ ! -L "$SHARED_DIR" ] || exit 0
  # A rebuild holds a flock on rebuild.flock for as long as it runs; skip while it does.
  [ -f "$OCBI_HOME/rebuild.flock" ] && ! perl -MFcntl=:flock -e 'open(my $f, "<", $ARGV[0]) or exit 0; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "$OCBI_HOME/rebuild.flock" && exit 0
  stamp="$SHARED_DIR/stale-check.stamp"
  [ -n "$(find "$stamp" -mmin -1440 2>/dev/null)" ] && exit 0
  touch "$stamp"
  command -v sqlite3 >/dev/null 2>&1 || exit 0
  live="$({
    git --git-dir="$common" for-each-ref --format='%(refname:short)' refs/heads
    git --git-dir="$common" worktree list --porcelain | sed -n 's/^HEAD \(.......\).*/\1/p'
  } | sort -u)" || exit 0
  catalogs="$(sqlite3 -readonly "$SHARED_DIR/claude-index/codebase.db" 'select distinct branch from branch_chunks' 2>/dev/null | sort -u)" || exit 0
  stale="$(comm -23 <(printf '%s\n' "$catalogs") <(printf '%s\n' "$live") | grep -c .)"
  if [ "$stale" -ge "$STALE_THRESHOLD" ]; then
    log "$project: $stale catalogs of deleted branches or worktrees"
    if [ -x "$OCBI_HOME/ocbi-notify.sh" ]; then
      if [ -x "$OCBI_BIN_DIR/ocbi-rebuild" ]; then
        "$OCBI_HOME/ocbi-notify.sh" "Worth a cleanup: $project" \
          "$stale catalogs of deleted branches or worktrees. Run cbi prune, or rebuild." \
          "Rebuild" "'$OCBI_BIN_DIR/ocbi-rebuild' $project" >/dev/null 2>&1
      else
        "$OCBI_HOME/ocbi-notify.sh" "Worth a cleanup: $project" \
          "$stale catalogs of deleted branches or worktrees. Run cbi prune." >/dev/null 2>&1
      fi
    fi
  fi
  exit 0
fi

# sha256 of file $1: GNU coreutils on Linux, shasum (perl) on macOS.
if command -v sha256sum >/dev/null 2>&1; then
  sha_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi
PERL="$(command -v perl 2>/dev/null || echo /usr/bin/perl)"

# Sets primary to the physical path of declared primary checkout $1 when git confirms it. $2 is
# the pinned absolute git dir, or empty. The checkout's common dir must be $common, and its git
# dir the pin when one is given. Normal clone: the checkout must also be the first worktree, with
# $common as its git dir. Bare clone: the pin is required, must be $common/worktrees/<id>, and its
# gitdir file must point back at $1/.git, so a moved or replaced checkout is not confirmed. A clone
# whose first worktree is $common itself counts as bare even with core.bare false.
primary=""
confirm_primary() {
  local declared gitdir pin first
  declared="$(phys_dir "$1")" || { policy_why="the declared primary $1 does not exist"; return 1; }
  [ "$(phys_dir "$(git -C "$declared" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")" = "$common" ] || {
    policy_why="the declared primary $1 is not a checkout of $common"
    return 1
  }
  gitdir="$(phys_dir "$(git -C "$declared" rev-parse --absolute-git-dir 2>/dev/null)")"
  if [ -n "$2" ]; then
    pin="$(phys_dir "$2")"
    [ -n "$pin" ] && [ "$gitdir" = "$pin" ] || { policy_why="the git dir of $1 is not the pinned $2"; return 1; }
  fi
  first="$(git --git-dir="$common" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
  if [ "$(git --git-dir="$common" rev-parse --is-bare-repository 2>/dev/null)" != false ] ||
    [ "$(phys_dir "$first")" = "$common" ]; then
    [ -n "$2" ] || { policy_why="$common is a bare clone and profiles.conf pins no git dir for $1"; return 1; }
    [ "${pin%/*}" = "$common/worktrees" ] && [ -f "$pin/gitdir" ] && [ ! -L "$pin/gitdir" ] &&
      [ "$(phys_dir "$(sed -n '1s|/\.git$||p' "$pin/gitdir")")" = "$declared" ] || {
      policy_why="the pinned $2 is not the linked worktree of $common checked out at $1"
      return 1
    }
  else
    [ -n "$first" ] && [ "$(phys_dir "$first")" = "$declared" ] && [ "$gitdir" = "$common" ] || {
      policy_why="the declared primary $1 is not the primary checkout of $common"
      return 1
    }
  fi
  primary="$declared"
}

# policy: main or worktree when $project has a profiles.conf line, empty for the base config.
policy=""
policy_why=""
pick_policy() {
  local name declared pin extra
  [ -n "$project" ] && [ -f "$PROFILES_CONF" ] || return 0
  while IFS='|' read -r name declared pin extra; do
    [ "$name" = "$project" ] || continue
    if [ -n "$extra" ] || [ "${declared#/}" = "$declared" ] || { [ -n "$pin" ] && [ "${pin#/}" = "$pin" ]; }; then
      policy=worktree
      policy_why="invalid profiles.conf line for $project, so no checkout is primary"
      return 0
    fi
    if confirm_primary "$declared" "$pin" && [ "$primary" = "$(phys_dir "$root")" ]; then
      policy=main
    else
      policy=worktree
    fi
    return 0
  done < <(grep -Ev '^[[:space:]]*(#|$)' "$PROFILES_CONF")
}

# Prints the $2 profile (main or worktree) generated from base config $1.
PROFILE_JS='
const fs = require("fs");
const [base, kind] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(base, "utf8"));
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
if (!object(config) || !object(config.indexing)) throw new Error("no indexing object");
const indexing = config.indexing;
for (const key of ["autoIndex", "watchFiles", "autoIndexOnStartup"]) {
  if (key in indexing && typeof indexing[key] !== "boolean") throw new Error(`indexing.${key} is not a boolean`);
}
if (!("autoIndex" in indexing) || !("watchFiles" in indexing)) throw new Error("indexing.autoIndex and indexing.watchFiles must be set");
const out = { ...config, indexing: { ...indexing } };
if (kind === "main") {
  out.indexing.autoIndexOnStartup = indexing.autoIndex && (indexing.autoIndexOnStartup ?? true);
} else {
  out.indexing.autoIndexOnStartup = false;
  out.indexing.watchFiles = false;
}
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
'

# True when $1 is a plain file or does not exist; never a symlink or anything else.
plain_or_absent() { [ ! -L "$1" ] && { [ -f "$1" ] || [ ! -e "$1" ]; }; }

# POSIX rename addresses the destination entry itself, including a replacement symlink.
# Unlike mv, it never interprets a destination directory symlink as a container.
replace_entry() { "$PERL" -e 'rename($ARGV[0], $ARGV[1]) or die "rename: $!\n"' -- "$1" "$2"; }

# Replaces plain file $2 with the line $1 through a temp file renamed over it, so a link put in
# its place is replaced, not followed.
put_line() {
  local tmp
  tmp="$(mktemp "${2%/*}/.${2##*/}.XXXXXXXX")" || return 1
  { printf '%s\n' "$1" >"$tmp" && chmod 644 "$tmp" && replace_entry "$tmp" "$2"; } || { rm -f "$tmp"; return 1; }
}

# Takes an exclusive flock on $1 (a plain file, created if missing), waiting at most
# OCBI_PROFILE_LOCK_WAIT seconds. A perl holder opens it with O_NOFOLLOW|O_NONBLOCK, so neither a
# link nor a FIFO put in its place is followed or blocks, refuses any descriptor that is not a
# plain file with the inode at $1, then reports "locked" on fd 8 and holds the lock until
# unlock_profiles stops it or this shell exits. A live holder is never overridden.
PROFILE_LOCK_WAIT="${OCBI_PROFILE_LOCK_WAIT:-20}"
lock_pid=""
lock_profiles() {
  local state
  exec 8< <(LOCK="$1" WAIT="$PROFILE_LOCK_WAIT" exec "$PERL" -MFcntl=:DEFAULT,:flock -e '
    my $parent = getppid(); exit 1 if $parent == 1;
    sysopen(my $fd, $ENV{LOCK}, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CREAT, 0600) or exit 1;
    my @f = stat($fd); exit 1 unless @f && -f _;
    my @l = lstat($ENV{LOCK}); exit 1 unless @l && -f _ && $f[0] == $l[0] && $f[1] == $l[1];
    local $SIG{ALRM} = sub { exit 3 }; alarm $ENV{WAIT};
    flock($fd, LOCK_EX) or exit 1; alarm 0;
    $SIG{TERM} = sub { exit 0 }; $| = 1; print "locked $$\n";
    select(undef, undef, undef, 0.1) while getppid() == $parent;' 2>/dev/null)
  read -r state lock_pid <&8 && [ "$state" = locked ] && return 0
  unlock_profiles
  return 1
}
# Stops the holder and waits for it to exit, so the lock is free before anything else runs.
unlock_profiles() {
  [ -n "$lock_pid" ] && kill "$lock_pid" 2>/dev/null
  cat <&8 >/dev/null
  exec 8<&-
  lock_pid=""
}

# Brings $SHARED_DIR/profiles/$policy.json and its .sha256 sidecar up to date with the base
# config, under the profiles lock. Same returns as link_shared_index; 2 also when a managed path
# is not a plain dir or file, so nothing is written through it and nothing starts.
sync_profile() {
  local dir="$SHARED_DIR/profiles" file="$SHARED_DIR/profiles/$policy.json" base="$SHARED_DIR/codebase-index.json"
  local side="$SHARED_DIR/profiles/$policy.json.sha256" tmp want before pass rc=0
  node_bin="$(pick_node)" || { why="no Node.js >= 22 to generate the $policy profile"; return 1; }
  if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
    why="$dir is not a plain directory"
    return 2
  fi
  mkdir -p "$dir" || return 2
  if [ "$(phys_dir "$dir")" != "$STORE_ROOT/$project/profiles" ]; then
    why="$dir is not a plain directory inside $OCBI_HOME"
    return 2
  fi
  lock_profiles "$dir/.lock" || { why="cannot lock $dir/.lock within ${PROFILE_LOCK_WAIT}s, or it is not a plain file"; return 2; }
  for pass in 1 2 3; do
    if ! plain_or_absent "$file" || ! plain_or_absent "$side"; then
      why="$file or $side is not a plain file"
      rc=2
      break
    fi
    before="$(sha_of "$base")"
    tmp="$(mktemp "$dir/.$policy.json.XXXXXXXX")" || { rc=2; break; }
    if ! "$node_bin" -e "$PROFILE_JS" "$base" "$policy" >"$tmp" 2>/dev/null; then
      rm -f "$tmp"
      why="cannot generate the $policy profile from $base"
      rc=1
      break
    fi
    want="$(sha_of "$tmp")"
    if [ -f "$file" ] && [ "$(sha_of "$file")" = "$want" ]; then
      rm -f "$tmp"
      [ "$(cat "$side" 2>/dev/null)" = "$want" ] || put_line "$want" "$side" || { rc=2; break; }
    else
      if [ -f "$file" ] && [ "$(sha_of "$file")" != "$(cat "$side" 2>/dev/null)" ]; then
        park "$file" || { rm -f "$tmp"; rc=2; break; }
      fi
      { put_line "$want" "$side" && chmod 644 "$tmp" && replace_entry "$tmp" "$file"; } || { rm -f "$tmp"; rc=2; break; }
      log "$project: regenerated $file from the base config"
    fi
    [ "$(sha_of "$base")" = "$before" ] && break
    [ "$pass" = 3 ] && { why="$base kept changing while the $policy profile was generated"; rc=2; }
  done
  unlock_profiles
  return "$rc"
}

# Moves $1 into a fresh $SHARED_DIR/parked/<stamp>-<random>/ next to an "origin" file.
park() {
  local path="$1" base="$SHARED_DIR/parked" dest
  mkdir -p "$base" 2>/dev/null
  if [ ! -d "$base" ] || [ -L "$base" ]; then
    log "$base is not a directory; cannot park $path"
    return 1
  fi
  dest="$(mktemp -d "$base/$(date +%Y%m%dT%H%M%S)-XXXXXXXX")" || return 1
  printf '%s\n' "$path" > "$dest/origin" || return 1
  mv "$path" "$dest/${path##*/}" || return 1
  if [ -e "$path" ] || [ -L "$path" ] || { [ ! -e "$dest/${path##*/}" ] && [ ! -L "$dest/${path##*/}" ]; }; then
    log "parking $path in $dest did not complete"
    return 1
  fi
  log "moved $path to $dest/${path##*/}"
}

ensure_link() {
  local link="$1" target="$2"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    return 0
  elif owned_link "$link"; then
    rm -f "$link" || return 1
  elif [ -e "$link" ] || [ -L "$link" ]; then
    park "$link" || return 1
  fi
  # A launcher starting in the same worktree may have made the same link meanwhile.
  ln -s "$target" "$link" 2>/dev/null || [ "$(readlink "$link")" = "$target" ] || {
    log "could not link $link -> $target"
    return 1
  }
}

# Returns 0 when linked, 1 when a precondition is unmet (nothing changed, why says which),
# 2 when a link step failed.
link_shared_index() {
  [ -n "$STORE_ROOT" ] || { why="$OCBI_HOME is not a directory"; return 1; }
  if [ ! -d "$SHARED_DIR" ] || [ -L "$SHARED_DIR" ] || [ "$(phys_dir "$SHARED_DIR")" != "$STORE_ROOT/$project" ]; then
    why="$SHARED_DIR is not a plain directory inside $OCBI_HOME"
    return 1
  fi
  if [ ! -f "$SHARED_DIR/codebase-index.json" ] || [ -L "$SHARED_DIR/codebase-index.json" ]; then
    why="$SHARED_DIR/codebase-index.json is missing or not a plain file"
    return 1
  fi
  # Without an explicit project scope the package may take "global" from the global config and
  # use the global index, which a linked checkout must never reach.
  node_bin="$(pick_node)" || { why="no Node.js >= 22 to read $SHARED_DIR/codebase-index.json"; return 1; }
  if ! "$node_bin" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(c && c.scope === "project" ? 0 : 1)' \
    "$SHARED_DIR/codebase-index.json" 2>/dev/null; then
    why="$SHARED_DIR/codebase-index.json must set \"scope\": \"project\""
    return 1
  fi
  if [ -L "$SHARED_DIR/claude-index" ] || { [ -e "$SHARED_DIR/claude-index" ] && [ ! -d "$SHARED_DIR/claude-index" ]; }; then
    why="$SHARED_DIR/claude-index is not a plain directory"
    return 1
  fi
  if ! git -C "$root" check-ignore -q --no-index .claude/index ||
    ! git -C "$root" check-ignore -q --no-index .claude/codebase-index.json; then
    why=".claude/index and .claude/codebase-index.json must be in $common/info/exclude"
    return 1
  fi
  if [ -n "$(git -C "$root" ls-files -- .claude/index .claude/codebase-index.json)" ]; then
    why=".claude/index or .claude/codebase-index.json is tracked by git"
    return 1
  fi
  if [ -L "$root/.claude" ] || { [ -e "$root/.claude" ] && [ ! -d "$root/.claude" ]; }; then
    why="$root/.claude is not a plain directory"
    return 1
  fi
  local config="$SHARED_DIR/codebase-index.json" rc
  if [ -n "$policy" ]; then
    sync_profile
    rc=$?
    [ "$rc" = 0 ] || return "$rc"
    config="$SHARED_DIR/profiles/$policy.json"
  fi
  { mkdir -p "$root/.claude" && mkdir -p "$SHARED_DIR/claude-index"; } || return 2
  ensure_link "$root/.claude/index" "$SHARED_DIR/claude-index" || return 2
  ensure_link "$root/.claude/codebase-index.json" "$config" || return 2
}

# Not linked: drop links this script made, unless they are tracked or behind a symlinked .claude,
# then report what the server will really read.
local_paths=""
settle_unlinked() {
  local p
  for p in index codebase-index.json; do
    if [ -n "$common" ] && [ ! -L "$root/.claude" ] && owned_link "$root/.claude/$p" &&
      [ -z "$(git -C "$root" ls-files -- ".claude/$p")" ]; then
      rm -f "$root/.claude/$p" && log "removed stale link $root/.claude/$p"
    fi
    if [ -e "$root/.claude/$p" ] || [ -L "$root/.claude/$p" ]; then
      local_paths="$local_paths .claude/$p"
    fi
  done
  if [ -n "$local_paths" ]; then
    route=local
  else
    route=global
  fi
}

if [ "${1:-}" = "--session-hint" ]; then
  [ -n "$project" ] && printf '\nFor repository questions, use index_status when readiness is unknown, then call codebase_context before shell search, grep, or broad file reads. Pass symbol for definitions or from+to for dependency paths; use specialized lookup and graph tools afterward.\n'
  exit 0
fi

pick_policy
[ -n "$policy_why" ] && log "$project: $policy_why; using the worktree profile"
if [ -n "$project" ]; then
  link_shared_index
  case $? in
    0) route=linked ;;
    2) route=error ;;
    *) settle_unlinked ;;
  esac
else
  settle_unlinked
fi
case "$route" in
  error) log "$project: linking the shared index failed${why:+: $why}; nothing started" ;;
  global) [ -n "$project" ] && log "$project: $why; using the global config" ;;
  local) log "${project:-$root}: ${why:+$why; }not linked, the local$local_paths in $root applies instead of the global config" ;;
esac

if [ "$route" = error ] && [ "${1:-}" != "--status-output" ]; then
  exit 1
fi

if [ "${1:-}" = "--link-only" ]; then
  printf '%s\n' "$root"
  exit 0
fi

[ -n "$node_bin" ] || node_bin="$(pick_node)" || { log "no Node.js >= 22 found"; exit 1; }

need_js() { [ -f "$1" ] || { log "$1 is missing; install the package into $OCBI_HOME/pkg"; exit 1; }; }

if [ "${1:-}" = "--cbi" ]; then
  shift
  need_js "$OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cbi.js"
  want="${OCBI_REQUIRE_PROJECT:-}"
  if [ -n "$want" ] && { [ "$route" != linked ] || { [ "$want" != "*" ] && [ "$project" != "$want" ]; }; }; then
    log "refusing to run the CLI: $root is not linked to the shared store of $(if [ "$want" = "*" ]; then echo "a listed project"; else echo "$want"; fi) (route ${route:-none}${project:+, project $project})"
    exit 3
  fi
  # A guarded run only indexes, and indexes exactly what was checked: this root, the claude host
  # paths and the linked config. Any --host must be claude and any --project must resolve, as the
  # kernel and the CLI resolve it, to this root; both are then replaced by the launcher's own
  # --host claude --project <absolute root>. Every other subcommand and --config are refused.
  if [ -n "$want" ]; then
    [ "${1:-}" = index ] || { log "refusing to run the CLI: only \`index\` runs with OCBI_REQUIRE_PROJECT, not \`${1:-}\`"; exit 3; }
    real_root="$(cd -P "$root" 2>/dev/null && pwd -P)"
    n=$#
    pending=""
    while [ "$n" -gt 0 ]; do
      arg="$1"
      shift
      n=$((n - 1))
      case "$pending" in
        --project)
          [ "$(cd -P "$arg" 2>/dev/null && pwd -P)" = "$real_root" ] || { log "refusing to run the CLI: --project $arg is not $root"; exit 3; }
          pending=""
          continue
          ;;
        --host)
          [ "$arg" = claude ] || { log "refusing to run the CLI: --host $arg is not claude"; exit 3; }
          pending=""
          continue
          ;;
      esac
      case "$arg" in
        --project | --host) pending="$arg"; continue ;;
        --config | --config=* | --project=* | --host=*) log "refusing to run the CLI: $arg is not allowed with OCBI_REQUIRE_PROJECT"; exit 3 ;;
      esac
      set -- "$@" "$arg"
    done
    [ -z "$pending" ] || { log "refusing to run the CLI: $pending needs a value"; exit 3; }
    set -- "$@" --host claude --project "$real_root"
    # The config the CLI reads is the one linked into this checkout; it must stay project-scoped.
    if ! "$node_bin" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(c && c.scope === "project" ? 0 : 1)' \
      "$root/.claude/codebase-index.json" 2>/dev/null; then
      log "refusing to run the CLI: $root/.claude/codebase-index.json does not set \"scope\": \"project\""
      exit 3
    fi
  fi
  exec "$node_bin" "$OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cbi.js" "$@"
fi

if [ "${1:-}" = "--status-output" ]; then
  cat >/dev/null
  status="$("$node_bin" "$OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cbi.js" status --host claude --project "$root" 2>&1)" || exit 0
  case "$route" in
    linked)
      routing="Routing: project $project, shared index $SHARED_DIR/claude-index."
      if [ -n "$policy" ]; then
        flags="$("$node_bin" -e 'const i = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).indexing; process.stdout.write(["autoIndex", "autoIndexOnStartup", "watchFiles"].map((k) => k + " " + i[k]).join(", "))' "$SHARED_DIR/profiles/$policy.json" 2>/dev/null)"
        if [ "$policy" = main ]; then
          routing="$routing Profile: main (primary checkout, background indexing as configured): $flags."
        else
          routing="$routing Profile: worktree (not the primary checkout, indexes on demand): $flags.${policy_why:+ Reason: $policy_why.}"
        fi
        grep -qs autoIndexOnStartup "$OCBI_HOME/pkg/node_modules/open-codebase-index/dist/mcp-worker.js" ||
          routing="$routing The installed core ignores autoIndexOnStartup, so autoIndex still indexes at startup."
      fi
      ;;
    error) routing="Routing: ERROR, linking the shared index of project $project failed${why:+ ($why)}, so the MCP server does not start here. See the [ocbi-mcp] messages in the MCP log." ;;
    *)
      if [ -n "$project" ]; then
        routing="Routing: project $project is listed but its shared index is not linked: $why."
      else
        routing="Routing: $root is not a listed project."
      fi
      if [ "$route" = local ]; then
        routing="$routing The local$local_paths in $root applies, not the global config."
      elif [ -n "$project" ]; then
        routing="$routing The global config applies. Linking needs $SHARED_DIR/codebase-index.json and both .claude/index and .claude/codebase-index.json in info/exclude and untracked."
      else
        routing="$routing The global config ~/.claude/codebase-index.json applies (auto-index off). Retrieval returns INDEX_UNAVAILABLE unless that store has a catalog for this branch."
      fi
      ;;
  esac
  status="$routing
$status
(Read from the index on disk by a separate \`cbi status\` process. \"Ready\" means a compatible catalog is registered for the branch. It does not mean the next retrieval passes the freshness check, and it does not show the live MCP server: its background indexing, refresh owner or worker health. A retrieval can still return INDEX_UNAVAILABLE when the snapshot is stale and the refresh does not finish within the wait; retry shortly and quote the reason it gives.)"
  STATUS="$status" "$node_bin" -e 'process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: "PostToolUse", updatedToolOutput: process.env.STATUS}}))'
  exit 0
fi
need_js "$SERVER_JS"
if [ "$route" = linked ] && [ "${OCBI_STALE_CHECK:-1}" != 0 ]; then
  /bin/bash "$0" --stale-check </dev/null >/dev/null 2>&1 &
fi

# --host claude in Codex too: the host only picks storage paths, and --host codex would add an
# idle supervisor that stops the file watcher after 15 idle minutes.
# The package takes the last --host and --project, so the launcher's own come last: the server always
# runs on the checkout this script linked.
exec "$node_bin" "$OCBI_HOME/mcp-force-guard.mjs" "$node_bin" "$SERVER_JS" "$@" --host claude --project "$root"
