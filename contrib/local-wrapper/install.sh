#!/usr/bin/env bash
# Installs the local-wrapper pieces. See README.md next to this script.
#
# Usage: install.sh [options]
#   --pieces LIST        comma-separated pieces to install (default: mcp,rebuild,notify)
#                        mcp       ocbi-mcp into --bin-dir: the package in OCBI_HOME/pkg
#                                  run by --node, which the Claude Code and Codex plugins start
#                                  from PATH
#                        rebuild   ocbi-rebuild.sh and ocbi-check.sh into OCBI_HOME, ocbi-rebuild
#                                  and ocbi-schedule into --bin-dir, and the jobs: on macOS two
#                                  launchd plists into --launch-agents-dir, on Linux three systemd
#                                  user units into --systemd-dir (ocbi-schedule install loads them)
#                        notify    ocbi-notify.sh into OCBI_HOME (macOS: the notifier app is built
#                                  separately, the command is printed; Linux: uses notify-send)
#                        pkg       npm install of --package into OCBI_HOME/pkg
#   --home DIR           OCBI_HOME (default: $OCBI_HOME, else ${XDG_DATA_HOME:-$HOME/.local/share}/ocbi)
#   --bin-dir DIR        default: $HOME/.local/bin
#   --launch-agents-dir D  default: $HOME/Library/LaunchAgents (macOS only)
#   --systemd-dir D      default: ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user (Linux only)
#   --label LABEL        launchd label of the rebuild job (default:
#                        io.github.open-codebase-index.rebuild); the daily check's label is LABEL
#                        with .rebuild replaced by .check (else LABEL.check)
#   --node PATH          Node.js >= 22 the mcp and rebuild run (default: $OCBI_NODE, else
#                        the first node >= 22 of the fnm default alias, Homebrew, /usr/local,
#                        /usr/bin and PATH; a per-shell fnm path is never chosen, it goes away)
#   --package SPEC       npm spec for the pkg piece: a release tarball URL, a local .tgz, or a
#                        registry name such as open-codebase-index@<version>. Adds pkg to --pieces.
#   --dry-run            print what would change, change nothing
#   -h, --help
# The git post-checkout hook ships in the package (`ocbi hooks install`, printed at the end).
# Every run is idempotent: unchanged files are left alone, and repository configs are never
# written. Host registration (Claude Code, Codex, git hooks, launchd, systemd) is printed, never
# applied. The Claude Code and Codex plugin comes from the repository's marketplace, not from here.
# Files of earlier wrapper versions in OCBI_HOME (ocbi-mcp.sh, projects.conf, profiles.conf, store
# directories) are left alone; docs/local-wrapper.md says when to remove them.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

pieces="mcp,rebuild,notify"
home="${OCBI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ocbi}"
bin_dir="$HOME/.local/bin"
agents_dir="$HOME/Library/LaunchAgents"
systemd_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
label="io.github.open-codebase-index.rebuild"
package=""
node="${OCBI_NODE:-}"
dry_run=0

usage() { sed -n '2,/^set -u/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 2; }
need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --pieces) need_arg "$@"; pieces="$2"; shift 2 ;;
    --home) need_arg "$@"; home="$2"; shift 2 ;;
    --bin-dir) need_arg "$@"; bin_dir="$2"; shift 2 ;;
    --marketplace-dir) die "--marketplace-dir went with the plugin piece; see docs/installation.md for the plugin" ;;
    --launch-agents-dir) need_arg "$@"; agents_dir="$2"; shift 2 ;;
    --systemd-dir) need_arg "$@"; systemd_dir="$2"; shift 2 ;;
    --label) need_arg "$@"; label="$2"; shift 2 ;;
    --package) need_arg "$@"; package="$2"; shift 2 ;;
    --node) need_arg "$@"; node="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# The paths end up in JSON, XML, shell and launchd files, and bash 5.2 expands & in ${x//p/r}
# replacements, so they must be absolute and free of characters any of those would interpret.
nl='
'
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }
if [ -z "$node" ]; then
  for candidate in "$HOME/.local/share/fnm/aliases/default/bin/node" /opt/homebrew/bin/node \
    /usr/local/bin/node /usr/bin/node "$(command -v node 2>/dev/null)"; do
    case "$candidate" in "" | */fnm_multishells/*) continue ;; esac
    [ -x "$candidate" ] && [ "$(node_major "$candidate" || echo 0)" -ge 22 ] && { node="$candidate"; break; }
  done
  [ -n "$node" ] || die "no Node.js >= 22 found; pass --node PATH"
else
  [ -x "$node" ] && [ "$(node_major "$node" || echo 0)" -ge 22 ] || die "--node $node is not a Node.js >= 22"
fi

is_macos=0 is_linux=0
case "${OCBI_UNAME:-$(uname -s)}" in Darwin) is_macos=1 ;; Linux) is_linux=1 ;; esac
check_path() {
  case "$1" in /*) ;; *) die "$1 must be an absolute path" ;; esac
  case "$1" in
    *[\"\\@\$\`\'\&\<\>%]* | *"$nl"*) die "$1 must not contain any of: \" \\ @ \$ \` ' & < > % or a newline" ;;
  esac
}
for path in "$home" "$bin_dir" "$agents_dir" "$node"; do check_path "$path"; done
while [ "${home%/}" != "$home" ] && [ "$home" != / ]; do home="${home%/}"; done
[[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid --label $label"
case "$label" in *.rebuild) check_label="${label%.rebuild}.check" ;; *) check_label="$label.check" ;; esac
[ -n "$package" ] && pieces="$pieces,pkg"

has_piece() { case ",$pieces," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
for p in $(printf '%s' "$pieces" | tr ',' ' '); do
  case "$p" in
    mcp | rebuild | notify | pkg) ;;
    plugin) die "the plugin piece is gone; install the repository's plugin marketplace (docs/installation.md)" ;;
    hook) die "the hook piece is gone: the package ships the hook, run ocbi hooks install --repo <repo> (docs/local-wrapper.md)" ;;
    *) die "unknown piece $p" ;;
  esac
done
if has_piece pkg && [ -z "$package" ]; then die "the pkg piece needs --package SPEC"; fi
# Only the Linux rebuild piece writes the systemd user dir; elsewhere a value under OCBI_HOME stands
# in for it in the rendered scripts, so an unused XDG_CONFIG_HOME cannot stop the install.
if [ "$is_linux" = 1 ] && has_piece rebuild; then check_path "$systemd_dir"; else systemd_dir="$home/systemd-user"; fi

version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$repo_root/package.json" 2>/dev/null | head -n 1)"
version="${version:-0.0.0}-local"
changes=0

preflight=0
say() { [ "$preflight" = 1 ] || printf '%s\n' "$*"; }
run() {
  if [ "$dry_run" = 1 ]; then
    say "  would run: $*"
  else
    "$@"
  fi
}

# render SRC: SRC with @OCBI_HOME@, @VERSION@, @LABEL@, @CHECK_LABEL@, @BIN_DIR@, @NODE@, @PATH@,
# @LAUNCH_AGENTS_DIR@ and @SYSTEMD_USER_DIR@ replaced, on stdout.
render() {
  local line path_value="${OCBI_INSTALL_PATH_VALUE:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line//@OCBI_HOME@/$home}"
    line="${line//@VERSION@/$version}"
    line="${line//@LABEL@/$label}"
    line="${line//@CHECK_LABEL@/$check_label}"
    line="${line//@LAUNCH_AGENTS_DIR@/$agents_dir}"
    line="${line//@SYSTEMD_USER_DIR@/$systemd_dir}"
    line="${line//@BIN_DIR@/$bin_dir}"
    line="${line//@NODE@/$node}"
    line="${line//@PATH@/$path_value}"
    printf '%s\n' "$line"
  done <"$1"
}

# place MODE SRC DEST [render]: install SRC (rendered when $4 = render) at DEST with MODE, unless
# DEST already has that content. Never follows a symlink at DEST.
place() {
  local mode="$1" src="$2" dest="$3" tmp
  if [ "$preflight" = 1 ]; then
    [ -f "$src" ] && [ -r "$src" ] || die "cannot read $src; nothing was installed"
    [ ! -d "$dest" ] || [ -L "$dest" ] || die "$dest is a directory; nothing was installed"
    local parent
    parent="$(dirname "$dest")"
    # Stop at the nearest path that exists or is a symlink; a dangling link blocks like a file.
    while [ ! -e "$parent" ] && [ ! -L "$parent" ] && [ "$parent" != / ]; do parent="$(dirname "$parent")"; done
    [ -d "$parent" ] || die "$parent is not a directory, so $dest cannot be installed; nothing was installed"
    return 0
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/ocbi-install.XXXXXX")" || die "mktemp failed"
  if [ "${4:-}" = render ]; then render "$src" >"$tmp"; else cat "$src" >"$tmp"; fi || {
    rm -f "$tmp"
    die "cannot read $src"
  }
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$tmp" "$dest" &&
    { { [ "$mode" = 755 ] && [ -x "$dest" ]; } || { [ "$mode" != 755 ] && [ ! -x "$dest" ]; }; }; then
    rm -f "$tmp"
    say "  unchanged  $dest"
    return 0
  fi
  changes=$((changes + 1))
  if [ "$dry_run" = 1 ]; then
    rm -f "$tmp"
    if [ -e "$dest" ] || [ -L "$dest" ]; then say "  would update  $dest"; else say "  would create  $dest"; fi
    return 0
  fi
  mkdir -p "$(dirname "$dest")" || die "cannot create $(dirname "$dest")"
  [ -L "$dest" ] && rm -f "$dest"
  if ! { chmod "$mode" "$tmp" && mv -f "$tmp" "$dest"; }; then rm -f "$tmp"; die "cannot write $dest"; fi
  say "  installed  $dest"
}

# retire DEST: remove a file an earlier version of this installer placed and nothing uses now.
retire() {
  [ "$preflight" = 1 ] && return 0
  { [ -f "$1" ] || [ -L "$1" ]; } || return 0
  changes=$((changes + 1))
  if [ "$dry_run" = 1 ]; then say "  would remove  $1"; return 0; fi
  rm -f "$1" || die "cannot remove $1"
  say "  removed  $1"
}

# The plugins prefer an ocbi-mcp on PATH to their pinned npx fallback, so place one
# only in front of a package that can run and that reports a plugin version skew (it reads
# OCBI_PLUGIN_VERSION). Otherwise retire a shim this installer placed earlier, so the plugins reach
# npx again, and leave any other file at the destination alone.
mcp_shim_marker='# ocbi-mcp of the package in '
# is_own_mcp_shim DEST: DEST is a shim this installer rendered for this OCBI_HOME's package, also
# when it was rendered with another spelling of the same directory (a symlink alias).
is_own_mcp_shim() {
  local target shim_home
  [ -f "$1" ] && [ ! -L "$1" ] && grep -qF -- "$mcp_shim_marker" "$1" || return 1
  target="$(sed -n 's/^exec "[^"]*" "\(.*\)" "\$@"$/\1/p' "$1")"
  shim_home="${target%/pkg/node_modules/open-codebase-index/dist/cli.js}"
  [ -n "$target" ] && [ "$shim_home" != "$target" ] || return 1
  # -ef compares the directories the kernel resolves (device and inode), not logical spellings.
  [ "$shim_home" = "$home" ] || [ "$shim_home" -ef "$home" ]
}
install_mcp() {
  local dist="$home/pkg/node_modules/open-codebase-index/dist" dest="$bin_dir/ocbi-mcp"
  if [ "$preflight" = 1 ]; then
    # --package may make the shim eligible, so check the destination whatever is installed now.
    place 755 "$here/mcp/ocbi-mcp" "$dest" render
    return 0
  fi
  say "mcp -> $bin_dir"
  if [ "$dry_run" = 1 ] && has_piece pkg; then
    say "  would place  $dest if $package reports plugin version skew"
    return 0
  fi
  local reason=""
  if [ ! -f "$dist/cli.js" ]; then
    reason="no package in $home/pkg; the plugins fall back to npx until you rerun with --package"
  elif ! grep -rqs --include='*.js' OCBI_PLUGIN_VERSION "$dist"; then
    reason="the package in $home/pkg predates plugin version checks; rerun with --package <gd.9 or later spec>"
  fi
  if [ -n "$reason" ]; then
    say "  skipped: $reason"
    if is_own_mcp_shim "$dest"; then retire "$dest"; fi
    return 0
  fi
  place 755 "$here/mcp/ocbi-mcp" "$dest" render
}

install_rebuild() {
  local unit
  say "rebuild -> $home, $bin_dir"
  place 755 "$here/rebuild/ocbi-rebuild.sh" "$home/ocbi-rebuild.sh" render
  place 755 "$here/rebuild/ocbi-check.sh" "$home/ocbi-check.sh" render
  place 755 "$here/rebuild/ocbi-rebuild" "$bin_dir/ocbi-rebuild" render
  place 755 "$here/rebuild/ocbi-schedule" "$bin_dir/ocbi-schedule" render
  if [ "$is_macos" = 1 ]; then
    place 644 "$here/rebuild/rebuild.plist.template" "$agents_dir/$label.plist" render
    place 644 "$here/rebuild/check.plist.template" "$agents_dir/$check_label.plist" render
  elif [ "$is_linux" = 1 ]; then
    for unit in ocbi-rebuild.service ocbi-check.service ocbi-check.timer; do
      place 644 "$here/rebuild/systemd/$unit" "$systemd_dir/$unit" render
    done
  fi
}

install_notify() {
  say "notify -> $home"
  place 755 "$here/notify/ocbi-notify.sh" "$home/ocbi-notify.sh"
}

install_pkg() {
  if [ "$preflight" = 1 ]; then
    [ "$dry_run" = 1 ] || command -v npm >/dev/null 2>&1 || die "npm is not on PATH; nothing was installed"
    return 0
  fi
  say "pkg -> $home/pkg ($package)"
  if [ "$dry_run" = 0 ]; then
    mkdir -p "$home/pkg" || die "cannot create $home/pkg"
    [ -f "$home/pkg/package.json" ] || printf '{ "private": true }\n' >"$home/pkg/package.json"
  fi
  changes=$((changes + 1))
  run npm install --prefix "$home/pkg" --no-audit --no-fund "$package" || die "npm install failed"
  [ "$dry_run" = 1 ] && return 0
  local js
  for js in cli.js cbi.js; do
    [ -f "$home/pkg/node_modules/open-codebase-index/dist/$js" ] || {
      retire_stale_mcp_shim
      die "$package did not install open-codebase-index with dist/$js; the servers run cli.js, the hook and rebuild cbi.js"
    }
  done
}

# The mcp and rebuild need a package with the repository config (gd.7) and the shared
# rebuild override (gd.6). Checked before any of them is placed; a package that is not installed
# yet only gets the reminder at the end.
# An unusable package also takes down a shim this installer placed in front of it, so the plugins
# reach their npx fallback while the install stops; any other file at the destination stays.
retire_stale_mcp_shim() {
  local dest="$bin_dir/ocbi-mcp"
  has_piece mcp && [ "$dry_run" = 0 ] || return 0
  is_own_mcp_shim "$dest" || return 0
  rm -f "$dest" && printf 'install.sh: removed %s, whose package is unusable, so the plugins fall back to npx\n' "$dest" >&2
}

check_pkg() {
  local dist="$home/pkg/node_modules/open-codebase-index/dist"
  has_piece mcp || has_piece rebuild || return 0
  [ -e "$home/pkg/node_modules/open-codebase-index" ] || return 0
  [ -f "$dist/cbi.js" ] && [ -f "$dist/cli.js" ] || {
    retire_stale_mcp_shim
    die "the package in $home/pkg has no dist/cbi.js or dist/cli.js; rerun with --package <gd.7 or later spec>; nothing else was installed"
  }
  grep -qs -- --allow-shared-rebuild "$dist/cbi.js" && grep -rqs --include='*.js' 'checkouts.primary.path' "$dist" || {
    retire_stale_mcp_shim
    die "the package in $home/pkg predates the repository config (gd.7) or --allow-shared-rebuild (gd.6); rerun with --package <gd.7 or later spec>; nothing else was installed"
  }
}

install_selected() {
  if [ "$preflight" = 1 ]; then
    # Destinations first: a package check that fails may retire this installer's ocbi-mcp shim,
    # which must not happen when another destination would stop the install anyway.
    install_pieces
    if has_piece pkg; then install_pkg; else check_pkg; fi
    return 0
  fi
  has_piece pkg && install_pkg
  [ "$dry_run" = 1 ] || check_pkg
  install_pieces
}

install_pieces() {
  has_piece mcp && install_mcp
  has_piece rebuild && install_rebuild
  has_piece notify && install_notify
  return 0
}

# Check every source and destination of the selected pieces before writing anything.
preflight=1
install_selected
preflight=0
[ "$dry_run" = 1 ] && say "Dry run: nothing is written."
install_selected

say ""
say "$changes change(s)$([ "$dry_run" = 1 ] && printf ' planned')."
say ""
say "Next steps (printed only, nothing below was applied):"
cat <<EOF

* Repository config, per repository whose worktrees share one index: write
  <git common dir>/codebase-index/config.json, starting from
  $here/repository-config.example.json.
  Coming from projects.conf: follow the migration in docs/local-wrapper.md first.
EOF
cat <<EOF

* Claude Code: install the plugin from the repository marketplace (docs/installation.md). It
  starts the first ocbi-mcp on PATH; with the mcp piece that is
  $bin_dir/ocbi-mcp, so keep $bin_dir on the PATH the host starts with.
    claude plugin marketplace add filip-gooddata/open-codebase-index
    claude plugin install codebase-index@open-codebase-index

* Codex (~/.codex/config.toml): tool_timeout_sec must exceed indexing.autoIndexWaitMs.
    [mcp_servers.codebase-index]
    command = "$node"
    args = ["$home/pkg/node_modules/open-codebase-index/dist/cli.js", "--host", "codex"]
    startup_timeout_sec = 30.0
    tool_timeout_sec = 420.0
EOF
cat <<EOF

* Git post-checkout refresh, per repository (package gd.8 or later):
    "$node" "$home/pkg/node_modules/open-codebase-index/dist/cbi.js" hooks install --repo <repo> --host claude --node "$node" --stale-notify "$home/ocbi-notify.sh"
  Check it with the same command and "hooks status --repo <repo>". Replacing the shell hook of
  earlier versions (hook.ocbi-prewarm, ocbi-post-checkout.sh): follow docs/local-wrapper.md.
EOF
if has_piece rebuild && { [ "$is_macos" = 1 ] || [ "$is_linux" = 1 ]; }; then
  if [ "$is_macos" = 1 ]; then job_names="launchd agents $label and $check_label"; else
    job_names="systemd user units ocbi-rebuild.service and ocbi-check.timer"; fi
  cat <<EOF

* Rebuild and daily check jobs ($job_names). Make sure $bin_dir
  is on PATH, then load the jobs and name the checkouts the daily check covers:
    ocbi-schedule install <checkout>...
  The check only notifies; it never rebuilds or prunes by itself. A rebuild on demand, from any
  checkout of the repository: ocbi-rebuild
EOF
fi
if has_piece notify && [ "$is_macos" = 1 ]; then
  cat <<EOF

* Notifications with an action button (macOS, needs Xcode command line tools):
    bash "$here/notify/notifier/build.sh"
EOF
elif has_piece notify && [ "$is_linux" = 1 ] && ! command -v notify-send >/dev/null 2>&1; then
  cat <<EOF

* Desktop notifications (Linux): install notify-send (libnotify-bin on Debian and Ubuntu,
  libnotify on Fedora and Arch). Without it, or without a desktop session, notifications are
  printed and logged to $home/logs/notify.log.
EOF
fi
if ! has_piece pkg && [ ! -f "$home/pkg/node_modules/open-codebase-index/dist/cli.js" ]; then
  cat <<EOF

* The server package is not installed in $home/pkg. Rerun with --package <spec>, e.g. a
  release tarball URL of this repository.
EOF
fi
