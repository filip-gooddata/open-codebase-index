#!/usr/bin/env bash
# Installs the local-wrapper pieces. See README.md next to this script.
#
# Usage: install.sh [options]
#   --pieces LIST        comma-separated pieces to install (default: launcher,hook,plugin,rebuild,notify)
#                        launcher  ocbi-mcp.sh, mcp-force-guard.mjs and config examples into OCBI_HOME
#                        hook      ocbi-post-checkout.sh into OCBI_HOME (registration is printed)
#                        plugin    Claude Code / Codex local marketplace into --marketplace-dir
#                        rebuild   ocbi-rebuild.sh into OCBI_HOME, ocbi-rebuild into --bin-dir and,
#                                  on macOS, the launchd job plist into --launch-agents-dir
#                        notify    ocbi-notify.sh into OCBI_HOME (the macOS notifier app is
#                                  built separately; the command is printed)
#                        pkg       npm install of --package into OCBI_HOME/pkg
#   --home DIR           OCBI_HOME (default: $OCBI_HOME, else ${XDG_DATA_HOME:-$HOME/.local/share}/ocbi)
#   --bin-dir DIR        default: $HOME/.local/bin
#   --marketplace-dir D  default: $HOME/.claude/local-marketplaces/ocbi-local
#   --launch-agents-dir D  default: $HOME/Library/LaunchAgents (macOS only)
#   --label LABEL        launchd label (default: io.github.open-codebase-index.rebuild)
#   --package SPEC       npm spec for the pkg piece: a release tarball URL, a local .tgz, or a
#                        registry name such as open-codebase-index@<version>. Adds pkg to --pieces.
#   --dry-run            print what would change, change nothing
#   -h, --help
# Every run is idempotent: unchanged files are left alone, and projects.conf, profiles.conf and
# project store configs are never written (only *.example files are). Host registration (Claude
# Code, Codex, git hooks, launchd) is printed, never applied.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

pieces="launcher,hook,plugin,rebuild,notify"
home="${OCBI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ocbi}"
bin_dir="$HOME/.local/bin"
marketplace_dir="$HOME/.claude/local-marketplaces/ocbi-local"
agents_dir="$HOME/Library/LaunchAgents"
label="io.github.open-codebase-index.rebuild"
package=""
dry_run=0

usage() { sed -n '2,/^set -u/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 2; }
need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --pieces) need_arg "$@"; pieces="$2"; shift 2 ;;
    --home) need_arg "$@"; home="$2"; shift 2 ;;
    --bin-dir) need_arg "$@"; bin_dir="$2"; shift 2 ;;
    --marketplace-dir) need_arg "$@"; marketplace_dir="$2"; shift 2 ;;
    --launch-agents-dir) need_arg "$@"; agents_dir="$2"; shift 2 ;;
    --label) need_arg "$@"; label="$2"; shift 2 ;;
    --package) need_arg "$@"; package="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

case "$home" in /*) ;; *) die "--home must be an absolute path" ;; esac
case "$home$bin_dir$marketplace_dir$agents_dir" in
  *\"* | *\\* | *@*) die "paths must not contain \", \\ or @" ;;
esac
[[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid --label $label"
[ -n "$package" ] && pieces="$pieces,pkg"

has_piece() { case ",$pieces," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
for p in $(printf '%s' "$pieces" | tr ',' ' '); do
  case "$p" in launcher | hook | plugin | rebuild | notify | pkg) ;; *) die "unknown piece $p" ;; esac
done
if has_piece pkg && [ -z "$package" ]; then die "the pkg piece needs --package SPEC"; fi

is_macos=0
[ "$(uname -s)" = Darwin ] && is_macos=1
version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$repo_root/package.json" | head -n 1)"
version="${version:-0.0.0}-local"
changes=0

say() { printf '%s\n' "$*"; }
run() {
  if [ "$dry_run" = 1 ]; then
    say "  would run: $*"
  else
    "$@"
  fi
}

# render SRC: SRC with @OCBI_HOME@, @VERSION@, @LABEL@, @BIN_DIR@ and @PATH@ replaced, on stdout.
render() {
  local line path_value="${OCBI_INSTALL_PATH_VALUE:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line//@OCBI_HOME@/$home}"
    line="${line//@VERSION@/$version}"
    line="${line//@LABEL@/$label}"
    line="${line//@BIN_DIR@/$bin_dir}"
    line="${line//@PATH@/$path_value}"
    printf '%s\n' "$line"
  done <"$1"
}

# place MODE SRC DEST [render]: install SRC (rendered when $4 = render) at DEST with MODE, unless
# DEST already has that content. Never follows a symlink at DEST.
place() {
  local mode="$1" src="$2" dest="$3" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/ocbi-install.XXXXXX")" || die "mktemp failed"
  if [ "${4:-}" = render ]; then render "$src" >"$tmp"; else cat "$src" >"$tmp"; fi
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$tmp" "$dest"; then
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

install_launcher() {
  say "launcher -> $home"
  place 755 "$here/launcher/ocbi-mcp.sh" "$home/ocbi-mcp.sh"
  place 644 "$here/launcher/mcp-force-guard.mjs" "$home/mcp-force-guard.mjs"
  place 644 "$here/launcher/projects.conf.example" "$home/projects.conf.example"
  place 644 "$here/launcher/profiles.conf.example" "$home/profiles.conf.example"
  place 644 "$here/launcher/codebase-index.example.json" "$home/codebase-index.example.json"
}

install_hook() {
  say "hook -> $home"
  place 755 "$here/hook/ocbi-post-checkout.sh" "$home/ocbi-post-checkout.sh"
}

install_plugin() {
  local m="$marketplace_dir" p="$here/claude-plugin" f name
  say "plugin -> $m"
  place 644 "$p/.claude-plugin/marketplace.json" "$m/.claude-plugin/marketplace.json" render
  place 644 "$p/.agents/plugins/marketplace.json" "$m/.agents/plugins/marketplace.json"
  place 644 "$p/plugins/codebase-index/.claude-plugin/plugin.json" "$m/plugins/codebase-index/.claude-plugin/plugin.json" render
  place 644 "$p/plugins/codebase-index/.codex-plugin/plugin.json" "$m/plugins/codebase-index/.codex-plugin/plugin.json" render
  place 644 "$p/plugins/codebase-index/hooks/hooks.json" "$m/plugins/codebase-index/hooks/hooks.json" render
  # Commands and the skill come from the repository; index.md and status.md are overridden
  # because a forced index is blocked on a shared store.
  for f in "$repo_root"/commands/*.md; do
    name="${f##*/}"
    case "$name" in reindex.md | visualize.md) continue ;; esac
    if [ -f "$p/plugins/codebase-index/commands/$name" ]; then
      f="$p/plugins/codebase-index/commands/$name"
    fi
    place 644 "$f" "$m/plugins/codebase-index/commands/$name"
  done
  place 644 "$repo_root/skills/codebase-search/SKILL.md" "$m/plugins/codebase-index/skills/codebase-search/SKILL.md"
}

install_rebuild() {
  say "rebuild -> $home, $bin_dir"
  place 755 "$here/rebuild/ocbi-rebuild.sh" "$home/ocbi-rebuild.sh"
  place 755 "$here/rebuild/ocbi-rebuild" "$bin_dir/ocbi-rebuild" render
  if [ "$is_macos" = 1 ]; then
    place 644 "$here/rebuild/rebuild.plist.template" "$agents_dir/$label.plist" render
  fi
}

install_notify() {
  say "notify -> $home"
  place 755 "$here/notify/ocbi-notify.sh" "$home/ocbi-notify.sh"
}

install_pkg() {
  say "pkg -> $home/pkg ($package)"
  if [ "$dry_run" = 0 ]; then
    mkdir -p "$home/pkg" || die "cannot create $home/pkg"
    [ -f "$home/pkg/package.json" ] || printf '{ "private": true }\n' >"$home/pkg/package.json"
  fi
  changes=$((changes + 1))
  run npm install --prefix "$home/pkg" --no-audit --no-fund "$package" || die "npm install failed"
}

[ "$dry_run" = 1 ] && say "Dry run: nothing is written."
has_piece launcher && install_launcher
has_piece hook && install_hook
has_piece plugin && install_plugin
has_piece rebuild && install_rebuild
has_piece notify && install_notify
has_piece pkg && install_pkg

say ""
say "$changes change(s)$([ "$dry_run" = 1 ] && printf ' planned')."
say ""
say "Next steps (printed only, nothing below was applied):"
if has_piece launcher; then
  cat <<EOF

* Shared stores: list projects in $home/projects.conf (see projects.conf.example), create
  $home/<name>/codebase-index.json from codebase-index.example.json, and add
  .claude/index and .claude/codebase-index.json to <git common dir>/info/exclude.
  Optionally name each primary checkout in $home/profiles.conf.
EOF
fi
if has_piece plugin; then
  cat <<EOF

* Claude Code: add the local marketplace and enable the plugin:
    claude plugin marketplace add "$marketplace_dir"
    claude plugin install codebase-index@ocbi-local
EOF
fi
cat <<EOF

* Codex (~/.codex/config.toml): tool_timeout_sec must exceed indexing.autoIndexWaitMs.
    [mcp_servers.codebase-index]
    command = "/bin/bash"
    args = ["$home/ocbi-mcp.sh"]
    startup_timeout_sec = 30.0
    tool_timeout_sec = 420.0
EOF
if has_piece hook; then
  cat <<EOF

* Git post-checkout prewarm, per repository. With config-based hooks (git 2.43 lacks them):
    git -C <repo> config --local hook.ocbi-prewarm.event post-checkout
    git -C <repo> config --local hook.ocbi-prewarm.command "$home/ocbi-post-checkout.sh"
  On any git, when the repository has no post-checkout hook yet:
    ln -s "$home/ocbi-post-checkout.sh" "\$(git -C <repo> rev-parse --path-format=absolute --git-common-dir)/hooks/post-checkout"
EOF
fi
if has_piece rebuild && [ "$is_macos" = 1 ]; then
  cat <<EOF

* Rebuild job (macOS launchd, on demand only):
    launchctl bootstrap gui/\$(id -u) "$agents_dir/$label.plist"
  Make sure $bin_dir is on PATH, then: ocbi-rebuild <project>
EOF
fi
if has_piece notify && [ "$is_macos" = 1 ]; then
  cat <<EOF

* Notifications with an action button (macOS, needs Xcode command line tools):
    bash "$here/notify/notifier/build.sh"
EOF
fi
if ! has_piece pkg && [ ! -f "$home/pkg/node_modules/open-codebase-index/dist/cli.js" ]; then
  cat <<EOF

* The server package is not installed in $home/pkg. Rerun with --package <spec>, e.g. a
  release tarball URL of this repository.
EOF
fi
