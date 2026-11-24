#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted JavaScript programs
# Tests for contrib/local-wrapper. No arguments; exits nonzero when any test fails.
# Needs bash (3.2+), git (>= 2.31), node (>= 22), perl and coreutils. Runs shellcheck over the
# shell scripts when it is on PATH (set OCBI_WRAPPER_REQUIRE_SHELLCHECK=1 to fail without it).
# Everything runs in a temporary HOME; nothing outside it is read or written, and no real index,
# embedding provider or network is used: the package CLI is stubbed.
set -u

here="$(cd "$(dirname "$0")/.." && pwd)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/ocbi-wrapper-test.XXXXXX")" || exit 1
T="$(cd "$tmp_root" && pwd -P)"
trap 'rm -rf "$T"' EXIT

export HOME="$T/home"
mkdir -p "$HOME"
unset OCBI_HOME XDG_DATA_HOME XDG_CONFIG_HOME GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$T/gitconfig"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export OCBI_STALE_CHECK=0
# Run git outside any repository: started from inside a checkout whose .git cannot be resolved
# (a mounted worktree, say), git would refuse even `config --global`.
cd "$T" || exit 1
git config --global init.defaultBranch main
git config --global protocol.file.allow always

pass=0 fail=0 n=0
ok() { n=$((n + 1)); pass=$((pass + 1)); printf 'ok %d - %s\n' "$n" "$1"; }
not_ok() {
  n=$((n + 1)); fail=$((fail + 1)); printf 'not ok %d - %s\n' "$n" "$1"
  [ $# -ge 2 ] && printf '%s\n' "$2" | sed 's/^/#   /'
  return 0
}
skip() { n=$((n + 1)); printf 'ok %d - %s # SKIP %s\n' "$n" "$1" "$2"; }
# check NAME CMD...: passes when CMD exits 0.
check() { local name="$1"; shift; if "$@"; then ok "$name"; else not_ok "$name"; fi; }
# expect_eq NAME WANT GOT
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else not_ok "$1" "want: $2
got:  $3"; fi; }
# expect_match NAME ERE TEXT
expect_match() { if printf '%s' "$3" | grep -Eq -- "$2"; then ok "$1"; else not_ok "$1" "no match for /$2/ in:
$3"; fi; }

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 22 ] || { echo "Bail out! node >= 22 is required (found ${node_major})"; exit 1; }

NODE="$(command -v node)"
export OCBI_NODE="$NODE"

# --- static checks -------------------------------------------------------------------------------
scripts=("$here/install.sh"
  "$here/rebuild/ocbi-rebuild.sh" "$here/rebuild/ocbi-rebuild" "$here/rebuild/ocbi-check.sh"
  "$here/rebuild/ocbi-schedule" "$here/notify/ocbi-notify.sh"
  "$here/notify/notifier/build.sh" "$here/mcp/ocbi-mcp" "$here/test/run-tests.sh")
for s in "${scripts[@]}"; do
  check "bash -n ${s#"$here"/}" bash -n "$s"
done
if command -v shellcheck >/dev/null 2>&1; then
  if out="$(shellcheck -x -S warning "${scripts[@]}" 2>&1)"; then ok "shellcheck"; else not_ok "shellcheck" "$out"; fi
elif [ "${OCBI_WRAPPER_REQUIRE_SHELLCHECK:-0}" = 1 ]; then
  not_ok "shellcheck" "shellcheck is not on PATH"
else
  skip "shellcheck" "not on PATH"
fi
while IFS= read -r j; do
  check "valid JSON ${j#"$here"/}" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$j"
done < <(find "$here/repository-config.example.json" -name '*.json')
got="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write([c.scope,c.indexing.allowForceRebuild,c.checkouts.secondary.watchFiles,c.checkouts.secondary.autoIndexOnStartup].join(" "))' "$here/repository-config.example.json")"
expect_eq "the example repository config is project-scoped, refuses forced rebuilds and keeps secondaries quiet" "project false false false" "$got"

# --- install.sh ----------------------------------------------------------------------------------
H="$HOME/.local/share/ocbi"
install_args=(--launch-agents-dir "$HOME/Library/LaunchAgents")
check "install --help exits 0" bash "$here/install.sh" --help >/dev/null
bash "$here/install.sh" --bogus >/dev/null 2>&1
expect_eq "install rejects an unknown option" 2 "$?"
bash "$here/install.sh" --pieces launcher >/dev/null 2>&1
expect_eq "install rejects the removed launcher piece" 2 "$?"
out="$(bash "$here/install.sh" --pieces plugin 2>&1)"
expect_eq "install rejects the removed plugin piece" 2 "$?"
expect_match "install points the plugin piece at the repository marketplace" "docs/installation.md" "$out"
bash "$here/install.sh" --marketplace-dir "$T/mp" >/dev/null 2>&1
expect_eq "install rejects the removed --marketplace-dir" "2 absent" "$? $([ -e "$T/mp" ] && echo present || echo absent)"
out="$(bash "$here/install.sh" --pieces hook 2>&1)"
expect_eq "install rejects the removed hook piece" 2 "$?"
expect_match "install points the hook piece at ocbi hooks install" "run ocbi hooks install --repo <repo>" "$out"
bash "$here/install.sh" --pieces pkg >/dev/null 2>&1
expect_eq "install rejects pkg without --package" 2 "$?"
bash "$here/install.sh" --node "$T/no-node" >/dev/null 2>&1
expect_eq "install rejects a --node that is not Node.js" 2 "$?"

out="$(bash "$here/install.sh" --dry-run "${install_args[@]}" 2>&1)"
expect_eq "dry run exits 0" 0 "$?"
expect_match "dry run lists planned files" "would create +$H/ocbi-rebuild.sh" "$out"
if [ -z "$(find "$HOME" -mindepth 1 -not -name . 2>/dev/null)" ]; then ok "dry run writes nothing"; else
  not_ok "dry run writes nothing" "$(find "$HOME" -mindepth 1)"; fi
out="$(OCBI_UNAME=Darwin XDG_CONFIG_HOME="$T/x@cfg" bash "$here/install.sh" --dry-run "${install_args[@]}" 2>&1)"
expect_eq "install on macOS ignores an XDG_CONFIG_HOME the systemd units would refuse" 0 "$?"
OCBI_UNAME=Linux XDG_CONFIG_HOME="$T/x@cfg" bash "$here/install.sh" --dry-run "${install_args[@]}" >/dev/null 2>&1
expect_eq "install on Linux refuses a systemd dir with a character it cannot render" 2 "$?"
out="$(bash "$here/install.sh" --dry-run --package ./x.tgz "${install_args[@]}" 2>&1)"
expect_match "dry run prints the npm install of --package" "would run: npm install --prefix $H/pkg" "$out"

# An earlier version's files in OCBI_HOME stay.
mkdir -p "$H"
printf '#!/bin/sh\n' >"$H/ocbi-mcp.sh"
printf '# mine\n' >"$H/projects.conf"
out="$(bash "$here/install.sh" "${install_args[@]}" 2>&1)"
expect_eq "install exits 0" 0 "$?"
for f in ocbi-rebuild.sh ocbi-check.sh ocbi-notify.sh; do
  check "installed executable $f" test -x "$H/$f"
done
check "installed ocbi-rebuild and ocbi-schedule into the bin dir" test -x "$HOME/.local/bin/ocbi-rebuild" -a -x "$HOME/.local/bin/ocbi-schedule"
check "install places no ocbi-mcp without a package" test ! -e "$HOME/.local/bin/ocbi-mcp"
expect_match "install says why it skipped the mcp piece" "skipped: no package in $H/pkg" "$out"
expect_eq "install leaves an earlier version's launcher and projects.conf alone" "#!/bin/sh # mine" "$(cat "$H/ocbi-mcp.sh") $(cat "$H/projects.conf")"
rm -f "$H/ocbi-mcp.sh" "$H/projects.conf"
if grep -rq '@[A-Z_]*@' "$HOME/.local/bin" "$H"; then not_ok "no template placeholders left" "$(grep -rl '@[A-Z_]*@' "$HOME/.local/bin" "$H")"; else ok "no template placeholders left"; fi
check "install places no plugin marketplace" test ! -e "$HOME/.claude"
expect_match "install prints the repository marketplace for Claude Code" "claude plugin install codebase-index@open-codebase-index" "$out"
if [ "$(uname -s)" = Darwin ]; then
  plist="$HOME/Library/LaunchAgents/io.github.open-codebase-index.rebuild.plist"
  check "installed the launchd plist" grep -q "<string>$H/ocbi-rebuild.sh</string>" "$plist"
  check "installed the daily check plist" grep -q "<string>$H/ocbi-check.sh</string>" "$HOME/Library/LaunchAgents/io.github.open-codebase-index.check.plist"
  check "no systemd units on macOS" test ! -e "$HOME/.config/systemd"
  if command -v plutil >/dev/null 2>&1; then check "plist is valid" plutil -lint -s "$plist"; fi
else
  check "no launchd plist off macOS" test ! -e "$HOME/Library/LaunchAgents"
  check "installed the systemd user units" test -f "$HOME/.config/systemd/user/ocbi-check.timer" -a -f "$HOME/.config/systemd/user/ocbi-check.service" -a -f "$HOME/.config/systemd/user/ocbi-rebuild.service"
fi
expect_match "install prints the Codex registration with --host codex" "args = \\[\"$H/pkg/node_modules/open-codebase-index/dist/cli.js\", \"--host\", \"codex\"\\]" "$out"
expect_match "install prints the Codex command as the chosen node" "command = \"$NODE\"" "$out"
expect_match "install prints the package's hook installer" "\"$H/pkg/node_modules/open-codebase-index/dist/cbi.js\" hooks install --repo <repo> --host claude --node \"$NODE\" --stale-notify \"$H/ocbi-notify.sh\"" "$out"
check "install places no shell post-checkout hook" test ! -e "$H/ocbi-post-checkout.sh"
out="$(bash "$here/install.sh" "${install_args[@]}" 2>&1)"
expect_match "second install changes nothing" "^0 change\\(s\\)\\." "$out"
chmod -x "$H/ocbi-notify.sh"
bash "$here/install.sh" "${install_args[@]}" >/dev/null 2>&1
check "reinstall restores the executable bit" test -x "$H/ocbi-notify.sh"
BO="$T/bundle-only"
mkdir -p "$BO" && cp -R "$here" "$BO/local-wrapper"
bash "$BO/local-wrapper/install.sh" --home "$BO/home" --bin-dir "$BO/bin" --launch-agents-dir "$BO/la" >/dev/null 2>&1
expect_eq "install works from the bundle alone" 0 "$?"
check "bundle-only install has the rebuild script" test -x "$BO/home/ocbi-rebuild.sh"
# The mcp piece goes only in front of a package that runs and reports plugin version skew.
BD="$BO/home/pkg/node_modules/open-codebase-index/dist"
mkdir -p "$BD"
printf '// --allow-shared-rebuild\nprocess.exit(0);\n' >"$BD/cbi.js"
printf '// checkouts.primary.path\nconsole.log(process.argv.slice(2).join(" "));\n' >"$BD/cli.js"
printf '#!/bin/sh\necho mine\n' >"$BO/bin/ocbi-mcp" && chmod 755 "$BO/bin/ocbi-mcp"
out="$(bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" 2>&1)"
expect_match "install skips the mcp piece for a package without plugin version checks" "predates plugin version checks" "$out"
expect_eq "a skipped mcp piece leaves the existing executable alone" "mine" "$("$BO/bin/ocbi-mcp")"
printf '// checkouts.primary.path OCBI_PLUGIN_VERSION\nconsole.log(process.argv.slice(2).join(" "));\n' >"$BD/cli.js"
bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" >/dev/null 2>&1
check "ocbi-mcp runs the package with the chosen node" grep -qF "exec \"$NODE\" \"$BD/cli.js\" \"\$@\"" "$BO/bin/ocbi-mcp"
expect_eq "ocbi-mcp passes its arguments to the package's cli.js" "--host claude" "$(env PATH=/usr/bin:/bin "$BO/bin/ocbi-mcp" --host claude)"
# A shim this installer placed is retired once its package no longer qualifies, so the plugins reach npx.
printf '// checkouts.primary.path\nconsole.log("old");\n' >"$BD/cli.js"
out="$(bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" 2>&1)"
check "install retires its shim in front of a package without plugin version checks" test ! -e "$BO/bin/ocbi-mcp"
expect_match "install reports the retired shim" "removed  $BO/bin/ocbi-mcp" "$out"
printf '// checkouts.primary.path OCBI_PLUGIN_VERSION\nconsole.log("new");\n' >"$BD/cli.js"
bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" >/dev/null 2>&1
rm -rf "$BO/home/pkg"
bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" >/dev/null 2>&1
check "install retires its shim when the package is gone" test ! -e "$BO/bin/ocbi-mcp"
# A package directory left without dist/cli.js stops the install, and still takes down the shim.
mkdir -p "$BD"
printf '// --allow-shared-rebuild\nprocess.exit(0);\n' >"$BD/cbi.js"
printf '// checkouts.primary.path OCBI_PLUGIN_VERSION\nconsole.log("new");\n' >"$BD/cli.js"
bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" >/dev/null 2>&1
check "the shim is back in front of a usable package" test -x "$BO/bin/ocbi-mcp"
rm -f "$BD/cli.js"
out="$(bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" 2>&1)"
expect_eq "install refuses a package without dist/cli.js" 2 "$?"
check "install retires its shim in front of a package without dist/cli.js" test ! -e "$BO/bin/ocbi-mcp"
expect_match "install says it removed the shim" "removed $BO/bin/ocbi-mcp, whose package is unusable" "$out"
printf '#!/bin/sh\necho mine\n' >"$BO/bin/ocbi-mcp" && chmod 755 "$BO/bin/ocbi-mcp"
bash "$BO/local-wrapper/install.sh" --pieces mcp --home "$BO/home" --bin-dir "$BO/bin" >/dev/null 2>&1
expect_eq "a refused install leaves an unrelated ocbi-mcp alone" "mine" "$("$BO/bin/ocbi-mcp")"
# Shim lifecycle across refusal paths, in a separate bin dir shared by two OCBI_HOMEs.
SH="$T/shim"; SB="$SH/bin"; mkdir -p "$SB"
fake_pkg() { # fake_pkg HOME [cli-marker|nocli|old]
  local d="$1/pkg/node_modules/open-codebase-index/dist"
  rm -rf "$1/pkg"; mkdir -p "$d"
  case "${2:-cli}" in
    old) printf 'process.exit(0);\n' >"$d/cbi.js"; printf 'process.exit(0);\n' >"$d/cli.js" ;;
    *) printf '// --allow-shared-rebuild\nprocess.exit(0);\n' >"$d/cbi.js"
       [ "${2:-cli}" = nocli ] || printf '// checkouts.primary.path OCBI_PLUGIN_VERSION\nprocess.exit(0);\n' >"$d/cli.js" ;;
  esac
}
fake_pkg "$SH/a"; fake_pkg "$SH/b"
bash "$here/install.sh" --pieces mcp --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
check "home A's shim is placed" test -x "$SB/ocbi-mcp"
fake_pkg "$SH/b" nocli
bash "$here/install.sh" --pieces mcp --home "$SH/b" --bin-dir "$SB" >/dev/null 2>&1
expect_eq "a refused install for home B keeps home A's working shim" "2 present" "$? $([ -x "$SB/ocbi-mcp" ] && echo present || echo absent)"
# A destination that fails preflight stops the install before the package check touches the shim.
fake_pkg "$SH/a" nocli
mkdir -p "$SH/a/ocbi-notify.sh"
bash "$here/install.sh" --pieces mcp,notify --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
expect_eq "a blocked destination stops the install before the shim is retired" "2 present" "$? $([ -x "$SB/ocbi-mcp" ] && echo present || echo absent)"
rmdir "$SH/a/ocbi-notify.sh"
# A package that loses the gd.7 markers is refused and takes its shim down.
fake_pkg "$SH/a"; bash "$here/install.sh" --pieces mcp --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
fake_pkg "$SH/a" old
bash "$here/install.sh" --pieces mcp --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
expect_eq "a package predating gd.7 is refused and its shim retired" "2 absent" "$? $([ -e "$SB/ocbi-mcp" ] && echo present || echo absent)"
# --package that installs a package without dist/cli.js is refused and takes the shim down.
fake_pkg "$SH/a"; bash "$here/install.sh" --pieces mcp --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
check "home A's shim is back" test -x "$SB/ocbi-mcp"
mkdir -p "$SH/npm-bin"
cat >"$SH/npm-bin/npm" <<'NPM'
#!/bin/sh
# npm stub: "npm install --prefix DIR ..." leaves a package without dist/cli.js.
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix="$2"; shift; done
d="$prefix/node_modules/open-codebase-index/dist"; rm -rf "$d"; mkdir -p "$d"
printf '// --allow-shared-rebuild\n' >"$d/cbi.js"
NPM
chmod 755 "$SH/npm-bin/npm"
out="$(PATH="$SH/npm-bin:$PATH" bash "$here/install.sh" --pieces mcp --package ./broken.tgz --home "$SH/a" --bin-dir "$SB" 2>&1)"
expect_eq "--package without dist/cli.js is refused and the shim retired" "2 absent" "$? $([ -e "$SB/ocbi-mcp" ] && echo present || echo absent)"
expect_match "the refusal names the missing cli.js" "did not install open-codebase-index with dist/cli.js" "$out"
# The same home spelled with a trailing slash or through a symlink still owns its shim.
for alias in "$SH/a/" "$SH/a-link"; do
  ln -sfn "$SH/a" "$SH/a-link"
  fake_pkg "$SH/a"; bash "$here/install.sh" --pieces mcp --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
  fake_pkg "$SH/a" nocli
  bash "$here/install.sh" --pieces mcp --home "$alias" --bin-dir "$SB" >/dev/null 2>&1
  expect_eq "a refused install for $alias retires the shim of the same home" "2 absent" "$? $([ -e "$SB/ocbi-mcp" ] && echo present || echo absent)"
done
# A regular file in the way of a destination's parent stops the install before anything changes.
fake_pkg "$SH/a"; bash "$here/install.sh" --pieces mcp --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
fake_pkg "$SH/a" nocli
printf 'x\n' >"$SH/not-a-dir"
bash "$here/install.sh" --pieces mcp,rebuild --home "$SH/a" --bin-dir "$SB" --launch-agents-dir "$SH/not-a-dir/la" >/dev/null 2>&1
rc=$?
if [ "$(uname -s)" = Darwin ]; then
  expect_eq "a file blocking the plist's parent stops the install before the shim is retired" "2 present" "$rc $([ -x "$SB/ocbi-mcp" ] && echo present || echo absent)"
fi
fake_pkg "$SH/a"
rm -f "$SH/a/ocbi-rebuild.sh"
out="$(bash "$here/install.sh" --pieces mcp,rebuild --home "$SH/a" --bin-dir "$SH/not-a-dir/bin" 2>&1)"
expect_eq "a file blocking the bin dir is refused before any write" "2 absent" "$? $([ -e "$SH/a/ocbi-rebuild.sh" ] && echo present || echo absent)"
expect_match "the refusal names the blocking file" "$SH/not-a-dir is not a directory" "$out"
# A home spelled through symlink/.. is the directory the kernel resolves, not the logical parent.
mkdir -p "$SH/hb/x"; ln -sfn "$SH/hb/x" "$SH/a/lb"
fake_pkg "$SH/a"; bash "$here/install.sh" --pieces mcp --home "$SH/a" --bin-dir "$SB" >/dev/null 2>&1
fake_pkg "$SH/hb" nocli
bash "$here/install.sh" --pieces mcp --home "$SH/a/lb/.." --bin-dir "$SB" >/dev/null 2>&1
expect_eq "a refused install for another home spelled through symlink/.. keeps this home's shim" "2 present" "$? $([ -x "$SB/ocbi-mcp" ] && echo present || echo absent)"
# A dangling symlink among a destination's parents blocks like a file.
ln -sfn "$SH/nowhere" "$SH/dangling"
fake_pkg "$SH/a" nocli
bash "$here/install.sh" --pieces mcp,rebuild --home "$SH/a" --bin-dir "$SB" --launch-agents-dir "$SH/dangling/la" >/dev/null 2>&1
rc=$?
if [ "$(uname -s)" = Darwin ]; then
  expect_eq "a dangling link above the plist stops the install before the shim is retired" "2 present" "$rc $([ -x "$SB/ocbi-mcp" ] && echo present || echo absent)"
fi
fake_pkg "$SH/a"; rm -f "$SH/a/ocbi-rebuild.sh"
out="$(bash "$here/install.sh" --pieces rebuild,mcp --home "$SH/a" --bin-dir "$SH/dangling/bin" 2>&1)"
expect_eq "a dangling link above the bin dir is refused before the rebuild script is written" "2 absent" "$? $([ -e "$SH/a/ocbi-rebuild.sh" ] && echo present || echo absent)"
expect_match "the refusal names the dangling link" "$SH/dangling is not a directory" "$out"
# The destination is checked before anything is written, even when --package would make the shim eligible.
mkdir -p "$T/dir-bin/ocbi-mcp"
out="$(bash "$here/install.sh" --pieces mcp --package ./x.tgz --home "$T/dir-home" --bin-dir "$T/dir-bin" 2>&1)"
expect_eq "install refuses a directory at the shim destination before installing the package" "2 absent" "$? $([ -e "$T/dir-home/pkg" ] && echo present || echo absent)"
expect_match "install names the directory in the way" "ocbi-mcp is a directory; nothing was installed" "$out"
bash "$here/install.sh" --home "$T/a&b" >/dev/null 2>&1
expect_eq "install rejects a path with &" "2 absent" "$? $([ -e "$T/a&b" ] && echo present || echo absent)"
P2="$T/preflight"
mkdir -p "$P2/ocbi-notify.sh"
bash "$here/install.sh" --pieces notify,rebuild --home "$P2" --bin-dir "$P2/bin" "${install_args[@]}" >/dev/null 2>&1
expect_eq "install refuses a directory at a destination and writes nothing" "2 absent" "$? $([ -e "$P2/ocbi-rebuild.sh" ] || [ -e "$P2/bin" ] && echo present || echo absent)"

# --- stub CLI ------------------------------------------------------------------------------------
# stub_cbi HOME [JS]: a dist/cbi.js under HOME/pkg that appends to HOME/calls, and prints unless
# it is a prune or a status --json,
#   CBI <args> cwd=<cwd> git_dir=<GIT_DIR or unset>
# then runs JS, which sees argv (the arguments), calls (the calls file so far) and sleep(ms). It
# answers `prune --json` with HOME/prune-count catalogs and `status --project P` with
# HOME/status-<basename P>, else HOME/status (default: a primary on the repository store);
# `status --json` with HOME/status-json (default: {}). It carries the markers install.sh probes for.
stub_cbi() {
  local d="$1/pkg/node_modules/open-codebase-index/dist"
  mkdir -p "$d"
  cat >"$d/cbi.js" <<EOF
// --allow-shared-rebuild checkouts.primary.path
const fs = require("fs"), path = require("path");
const home = path.resolve(__dirname, "../../../..");
const argv = process.argv.slice(2);
const line = "CBI " + argv.join(" ") + " cwd=" + process.cwd() + " git_dir=" + (process.env.GIT_DIR ?? "unset") + "\\n";
fs.appendFileSync(path.join(home, "calls"), line);
const json = argv[0] === "status" && argv.includes("--json");
if (argv[0] !== "prune" && !json) process.stdout.write(line);
const calls = fs.readFileSync(path.join(home, "calls"), "utf8");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (argv[0] === "prune") {
  let n = 0;
  try { n = Number(fs.readFileSync(path.join(home, "prune-count"), "utf8")); } catch {}
  console.log(JSON.stringify({ applied: false, catalogs: Array.from({ length: n }, (_, i) => ({ key: "gone" + i })) }));
}
if (json) {
  let st = "{}";
  try { st = fs.readFileSync(path.join(home, "status-json"), "utf8"); } catch {}
  console.log(st);
} else if (argv[0] === "status") {
  let st = "Store: /shared (repository config /c/codebase-index/config.json)\\nCheckout role: primary - test";
  const project = argv[argv.indexOf("--project") + 1] ?? "";
  for (const f of ["status-" + path.basename(project), "status"]) {
    try { st = fs.readFileSync(path.join(home, f), "utf8"); break; } catch {}
  }
  console.log(st);
}
${2:-}
EOF
}

# install.sh probes an installed package before placing the pieces that call it.
OP="$T/oldpkg"
mkdir -p "$OP/pkg/node_modules/open-codebase-index/dist"
printf 'process.exit(0);\n' >"$OP/pkg/node_modules/open-codebase-index/dist/cbi.js"
printf 'process.exit(0);\n' >"$OP/pkg/node_modules/open-codebase-index/dist/cli.js"
bash "$here/install.sh" --pieces rebuild --home "$OP" --bin-dir "$OP/bin" "${install_args[@]}" >"$T/oldpkg.out" 2>&1
expect_eq "install refuses a pre-gd.7 package and places nothing" "2 absent" "$? $([ -e "$OP/ocbi-rebuild.sh" ] || [ -e "$OP/bin" ] && echo present || echo absent)"
expect_match "install names the package upgrade" "predates the repository config" "$(cat "$T/oldpkg.out")"
rm -f "$OP/pkg/node_modules/open-codebase-index/dist/cbi.js"
bash "$here/install.sh" --pieces rebuild --home "$OP" --bin-dir "$OP/bin" "${install_args[@]}" >"$T/oldpkg.out" 2>&1
expect_eq "install refuses a package without dist/cbi.js and places nothing" "2 absent" "$? $([ -e "$OP/ocbi-rebuild.sh" ] || [ -e "$OP/bin" ] && echo present || echo absent)"
stub_cbi "$OP"
bash "$here/install.sh" --pieces rebuild --home "$OP" --bin-dir "$OP/bin" "${install_args[@]}" >/dev/null 2>&1
expect_eq "install accepts a package with both markers" "0 present" "$? $([ -x "$OP/ocbi-rebuild.sh" ] && echo present || echo absent)"

# --- repositories --------------------------------------------------------------------------------
R="$T/src/demo"
mkdir -p "$R"
git -C "$R" init -q -b main
echo hi >"$R/a.txt"
git -C "$R" add a.txt && git -C "$R" commit -qm init
git -C "$R" worktree add -q "$T/src/demo-feature" -b feature
W="$T/src/demo-feature"
mkdir -p "$R/.git/codebase-index"
printf '{}\n' >"$R/.git/codebase-index/config.json"

# wait_for FILE PATTERN: up to 10 s.
wait_for() {
  local i=0
  while [ "$i" -lt 100 ]; do
    grep -q "$2" "$1" 2>/dev/null && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# --- rebuild -------------------------------------------------------------------------------------
NR="$T/src/noconfig"
mkdir -p "$NR" && git -C "$NR" init -q -b main && git -C "$NR" commit -q --allow-empty -m init
(cd "$T" && bash "$HOME/.local/bin/ocbi-rebuild" >/dev/null 2>&1)
expect_eq "ocbi-rebuild outside a checkout exits 64" 64 "$?"
bash "$HOME/.local/bin/ocbi-rebuild" "$NR" >/dev/null 2>&1
expect_eq "ocbi-rebuild refuses a repository without a repository config" 64 "$?"
bash "$H/ocbi-rebuild.sh" >/dev/null 2>&1
expect_eq "ocbi-rebuild.sh needs a checkout" 64 "$?"
bash "$H/ocbi-rebuild.sh" src/demo >/dev/null 2>&1
expect_eq "ocbi-rebuild.sh needs an absolute path" 64 "$?"
bash "$H/ocbi-rebuild.sh" "$NR" >/dev/null 2>&1
expect_eq "ocbi-rebuild.sh refuses a repository without a repository config" 64 "$?"
RB="$T/rebuildhome"
mkdir -p "$RB"
cp "$H/ocbi-rebuild.sh" "$RB/"
stub_cbi "$RB"
calls() { grep '^CBI index' "$RB/calls" 2>/dev/null; }
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$W"
expect_eq "rebuild exits 0" 0 "$?"
expect_eq "rebuild forces the primary (the main worktree), then indexes each other worktree" \
  "CBI index --force --allow-shared-rebuild --host claude --project $R cwd=$R git_dir=unset
CBI index --host claude --project $W cwd=$W git_dir=unset" "$(calls)"
# Another process holding the flock keeps a rebuild out; once it is gone the lock is free.
: >"$RB/calls"
perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $m, ">", $ARGV[1]); print $m "held\n"; close $m; sleep 3' \
  "$RB/rebuild.flock" "$T/held" &
holder=$!
wait_for "$T/held" held
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild exits 0 while another run holds the lock" 0 "$?"
check "rebuild did nothing while another one runs" test ! -s "$RB/calls"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$R"
check "rebuild runs once the holder is gone" test -s "$RB/calls"
# Two rebuilds started together: exactly one runs.
stub_cbi "$RB" 'sleep(1);'
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$R" & first=$!
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$R" & second=$!
wait "$first"; wait "$second"
expect_eq "concurrent rebuilds: one runs, one exits" 2 "$(calls | grep -c .)"
# A checkout the package treats as secondary fails the rebuild at once, with the package's reason.
stub_cbi "$RB" 'if (argv.includes("--force")) { console.error("Error: Project-scoped force rebuild is limited to the primary checkout of a shared repository store. This checkout is secondary (configured primary is /elsewhere)."); process.exit(1); }'
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=30 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild refused as secondary fails after one attempt" "1 1" "$? $(calls | grep -c .)"
# shellcheck disable=SC2012 # names are rebuild-<timestamp>.log
expect_match "rebuild names the package's refusal" "Nothing was rebuilt: Project-scoped force rebuild is limited to the primary checkout" "$(cat "$(ls -1t "$RB"/logs/rebuild-*.log | head -n 1)")"
# A busy forced index is retried.
stub_cbi "$RB" 'if (argv.includes("--force") && calls.split("--force").length === 2) { console.error("INDEX_BUSY: another index operation is already in progress"); process.exit(1); }'
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=0 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild retries a busy forced index" "0 2" "$? $(calls | grep -c -- '--force')"
# A worktree whose index fails is retried once, then reported.
stub_cbi "$RB" 'if (!argv.includes("--force")) process.exit(1);'
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=0 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild retries a failing worktree once and fails" "1 2" "$? $(calls | grep -c "cwd=$W ")"
# The route is checked before forcing: a secondary or a global scope forces nothing.
stub_cbi "$RB"
printf 'Store: /shared (repository default store)\nCheckout role: secondary - configured primary is /elsewhere\n' >"$RB/status"
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=30 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild of a primary the package calls secondary indexes nothing" "1 0" "$? $(calls | grep -c .)"
printf 'Store: /g (global scope)\n' >"$RB/status"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=30 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild under a global scope indexes nothing" "1 0" "$? $(calls | grep -c .)"
# shellcheck disable=SC2012 # names are rebuild-<timestamp>.log
expect_match "rebuild names the wrong store" "does not use the repository's shared store \\(Store: /g \\(global scope\\)\\)" "$(cat "$(ls -1t "$RB"/logs/rebuild-*.log | head -n 1)")"
# A worktree that reports another store than the primary is skipped and reported, not indexed.
rm -f "$RB/status"
printf 'Store: /other (repository default store)\nCheckout role: secondary - test\n' >"$RB/status-demo-feature"
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=0 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild skips a worktree on another store and fails" "1 1 0" "$? $(calls | grep -c -- '--force') $(calls | grep -c "cwd=$W ")"
rm -f "$RB/status-demo-feature"
# The route is checked again before every attempt: a scope change after a busy attempt stops it.
stub_cbi "$RB" 'if (argv.includes("--force")) { fs.writeFileSync(path.join(home, "status"), "Store: /g (global scope)\n"); console.error("INDEX_BUSY: another index operation is already in progress"); process.exit(1); }'
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=0 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild stops when the route changes between forced attempts" "1 1" "$? $(calls | grep -c .)"
rm -f "$RB/status"
stub_cbi "$RB" 'if (argv[0] === "index" && !argv.includes("--force")) { fs.writeFileSync(path.join(home, "status-demo-feature"), "Store: /g (global scope)\n"); process.exit(1); }'
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=0 bash "$RB/ocbi-rebuild.sh" "$R"
expect_eq "rebuild does not retry a worktree whose route changed" "1 1" "$? $(calls | grep -c "cwd=$W ")"
rm -f "$RB/status-demo-feature"
stub_cbi "$RB"
# The preflight follows the provider the primary reports: none for another provider, Ollama's API
# at OLLAMA_HOST for ollama.
printf '{ "provider": "openai" }' >"$RB/status-json"
: >"$RB/calls"
(unset OCBI_REBUILD_PREFLIGHT_URL; OLLAMA_HOST=http://127.0.0.1:9 bash "$RB/ocbi-rebuild.sh" "$R")
# shellcheck disable=SC2012 # names are rebuild-<timestamp>.log
expect_eq "rebuild with another provider skips the Ollama check" "0 1 1" "$? $(calls | grep -c -- '--force') $(grep -c 'embedding provider openai: no preflight check' "$(ls -1t "$RB"/logs/rebuild-*.log | head -n 1)")"
printf '{ "provider": "ollama" }' >"$RB/status-json"
: >"$RB/calls"
(unset OCBI_REBUILD_PREFLIGHT_URL; OLLAMA_HOST=http://127.0.0.1:9 bash "$RB/ocbi-rebuild.sh" "$R")
expect_eq "rebuild with ollama checks OLLAMA_HOST and forces nothing when it is down" "1 0" "$? $(calls | grep -c .)"
# shellcheck disable=SC2012 # names are rebuild-<timestamp>.log
expect_match "rebuild names the Ollama URL it checked" "not responding on http://127.0.0.1:9/api/tags" "$(cat "$(ls -1t "$RB"/logs/rebuild-*.log | head -n 1)")"
rm -f "$RB/status-json"
# The configured primary must be a checkout root of this repository.
printf '{ "checkouts": { "primary": { "path": "%s" } } }\n' "$NR" >"$R/.git/codebase-index/config.json"
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$R" 2>/dev/null
expect_eq "rebuild refuses a primary from another repository" "64 0" "$? $(calls | grep -c .)"
mkdir -p "$R/sub"
printf '{ "checkouts": { "primary": { "path": "%s/sub" } } }\n' "$R" >"$R/.git/codebase-index/config.json"
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$R" 2>/dev/null
expect_eq "rebuild refuses a primary that is not a checkout root" "64 0" "$? $(calls | grep -c .)"
printf '{}\n' >"$R/.git/codebase-index/config.json"
# Bare-base layout: the primary comes from checkouts.primary.path, relative to the common dir.
stub_cbi "$RB"
B="$T/src/bare.git"
git clone -q --bare "$R" "$B"
git -C "$B" worktree add -q "$T/src/bare-main" main
git -C "$B" worktree add -q "$T/src/bare-wt" -b wt
mkdir -p "$B/codebase-index"
printf '{}\n' >"$B/codebase-index/config.json"
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$T/src/bare-wt" 2>"$T/bare.err"
expect_eq "rebuild of a bare-base layout without checkouts.primary.path exits 64 and runs nothing" "64 0" "$? $(calls | grep -c .)"
expect_match "rebuild names checkouts.primary.path" "set checkouts.primary.path in $B/codebase-index/config.json" "$(cat "$T/bare.err")"
printf '{ "checkouts": { "primary": { "path": "../bare-main" } } }\n' >"$B/codebase-index/config.json"
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" "$T/src/bare-wt"
expect_eq "rebuild of a bare-base layout forces the configured primary and skips the bare dir" \
  "0 CBI index --force --allow-shared-rebuild --host claude --project $T/src/bare-main cwd=$T/src/bare-main git_dir=unset
CBI index --host claude --project $T/src/bare-wt cwd=$T/src/bare-wt git_dir=unset" "$? $(calls)"

# fake DIR NAME BODY: an executable DIR/NAME running the bash BODY.
fake() {
  mkdir -p "$1"
  printf '#!/usr/bin/env bash\n%s\n' "$3" >"$1/$2"
  chmod +x "$1/$2"
}

# --- daily check ---------------------------------------------------------------------------------
CK="$T/checkhome"
mkdir -p "$CK"
cp "$H/ocbi-check.sh" "$CK/"
stub_cbi "$CK"
fake "$CK" ocbi-notify.sh "printf '%s|' \"\$@\" >>'$T/ck-notified'; printf '\\n' >>'$T/ck-notified'"
ck_calls() { grep -c "^CBI $1" "$CK/calls" 2>/dev/null; }
ck_run() { : >"$CK/calls"; rm -f "$T/ck-notified"; OCBI_STALE_CHECK="${CK_STALE_CHECK:-1}" OCBI_REBUILD_CMD="$T/bin/ocbi-rebuild" bash "$CK/ocbi-check.sh" "$@"; }
ck_run
expect_eq "check without checkouts exits 0 and calls nothing" "0 0" "$? $(ck_calls '')"
expect_match "check without checkouts says how to add them" "no checkouts to check" "$(cat "$CK/logs/check.log")"
printf '# comment\n\n  %s  \n%s\n' "$R" "$W" >"$CK/check.conf"
printf '3' >"$CK/prune-count"
ck_run
expect_eq "check below the threshold exits 0, checks the repository once and notifies nothing" "0 1 1 absent" \
  "$? $(ck_calls 'status --json') $(ck_calls 'prune --json') $([ -e "$T/ck-notified" ] && echo present || echo absent)"
expect_match "check logs the stale count" "demo: 3 catalogs of deleted branches or worktrees" "$(cat "$CK/logs/check.log")"
printf '20' >"$CK/prune-count"
ck_run
expect_eq "check past the threshold exits 0 and notifies once" "0 1" "$? $(grep -c . "$T/ck-notified")"
expect_match "check offers a Prune action for the stale catalogs" "^Worth a cleanup: demo\\|20 catalogs of deleted branches or worktrees\\.\\|Prune\\|cd '$R' && .* prune --apply --host 'claude' --project '$R' >>'$CK/logs/prune.log' 2>&1\\|$" "$(cat "$T/ck-notified")"
cmd="$(cut -d '|' -f 4 "$T/ck-notified")"
: >"$CK/calls"
bash -c "$cmd"
expect_eq "the Prune action applies the prune for that checkout" "1" "$(grep -c "^CBI prune --apply --host claude --project $R cwd=$R " "$CK/calls")"
printf '{ "compatibility": { "compatible": false, "reason": "Embedding model changed." } }' >"$CK/status-json"
ck_run
expect_eq "check of an incompatible store notifies once and skips the prune dry run" "0 1 0" "$? $(grep -c . "$T/ck-notified") $(ck_calls 'prune')"
expect_eq "check offers a Rebuild action that runs ocbi-rebuild for the checkout" \
  "Rebuild needed: demo|Embedding model changed. A full rebuild re-embeds every file with the configured model.|Rebuild|'$T/bin/ocbi-rebuild' '$R'|" \
  "$(cat "$T/ck-notified")"
printf '{ "compatibility": { "compatible": true } }' >"$CK/status-json"
printf '0' >"$CK/prune-count"
ck_run
expect_eq "check of a compatible store goes on to the prune dry run" "0 1 absent" "$? $(ck_calls 'prune --json') $([ -e "$T/ck-notified" ] && echo present || echo absent)"
printf '20' >"$CK/prune-count"
CK_STALE_CHECK=0 ck_run
expect_eq "check with OCBI_STALE_CHECK=0 skips the prune dry run but still checks compatibility" "0 0 1 absent" \
  "$? $(ck_calls 'prune') $(ck_calls 'status --json') $([ -e "$T/ck-notified" ] && echo present || echo absent)"
printf '0' >"$CK/prune-count"
printf '%s\n%s\n%s\n' "$T/nowhere" "$NR" "$R" >"$CK/check.conf"
ck_run
expect_eq "check skips a missing path and a repository without config, checks the rest, exits 1" "1 1" "$? $(ck_calls 'prune --json')"
expect_match "check logs the repository without config" "skipped $NR: no repository config" "$(cat "$CK/logs/check.log")"
ck_run "$W"
expect_eq "check takes checkouts as arguments" "0 1" "$? $(ck_calls 'prune --json')"
perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $m, ">", $ARGV[1]); print $m "held\n"; close $m; sleep 3' \
  "$CK/rebuild.flock" "$T/ck-held" &
holder=$!
wait_for "$T/ck-held" held
ck_run "$R"
expect_eq "check does nothing while a rebuild runs" "0 0" "$? $(ck_calls '')"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
check "the check never indexes" test "$(grep -c '^CBI index' "$CK/calls")" = 0
rm -f "$CK/status-json" "$CK/prune-count"

# --- ocbi-rebuild through systemd ----------------------------------------------------------------
FS="$T/fake-systemd"
fake "$FS" systemctl "printf '%s\\n' \"\$*\" >>'$T/systemctl.calls'; [ \"\$2\" != cat ] || [ -e '$FS/unit-present' ] || exit 1
[ \"\$2\" != disable ] || [ ! -e '$FS/fail-disable' ] || { echo 'Failed to connect to bus' >&2; exit 1; }
if [ \"\$2\" = stop ]; then [ ! -e '$FS/fail-stop' ] || { echo 'Access denied' >&2; exit 1; }; echo 'Unit not loaded.' >&2; exit 5; fi"
: >"$T/systemctl.calls"
touch "$FS/unit-present"
rm -f "$H/rebuild.request"
out="$(PATH="$FS:$PATH" OCBI_UNAME=Linux bash "$HOME/.local/bin/ocbi-rebuild" "$W" 2>&1)"
expect_eq "ocbi-rebuild on Linux starts the systemd unit for the checkout" \
  "0 --user cat ocbi-rebuild.service
--user start --no-block ocbi-rebuild.service $W" "$? $(cat "$T/systemctl.calls") $(cat "$H/rebuild.request")"
expect_match "ocbi-rebuild reports the background start" "Rebuild of $W started in the background" "$out"

# --- install, Linux and macOS layouts ------------------------------------------------------------
LX="$T/linux-install"
OCBI_UNAME=Linux bash "$here/install.sh" --pieces rebuild,notify --home "$LX/home" --bin-dir "$LX/bin" \
  --systemd-dir "$LX/units" --launch-agents-dir "$LX/agents" >"$T/lx.out" 2>&1
expect_eq "Linux install exits 0" 0 "$?"
check "Linux install places the three units and no plist" test -f "$LX/units/ocbi-rebuild.service" -a -f "$LX/units/ocbi-check.service" -a -f "$LX/units/ocbi-check.timer" -a ! -e "$LX/agents"
check "the check unit runs the installed ocbi-check.sh" grep -qx "ExecStart=/bin/bash \"$LX/home/ocbi-check.sh\"" "$LX/units/ocbi-check.service"
check "the rebuild unit runs the installed ocbi-rebuild.sh and has no [Install]" eval "grep -qx 'ExecStart=/bin/bash \"$LX/home/ocbi-rebuild.sh\"' '$LX/units/ocbi-rebuild.service' && ! grep -q '^\\[Install\\]' '$LX/units/ocbi-rebuild.service'"
if grep -rq '@[A-Z_]*@' "$LX"; then not_ok "Linux install leaves no placeholders" "$(grep -rl '@[A-Z_]*@' "$LX")"; else ok "Linux install leaves no placeholders"; fi
expect_match "Linux install prints ocbi-schedule install" "ocbi-schedule install <checkout>" "$(cat "$T/lx.out")"
if command -v systemd-analyze >/dev/null 2>&1; then
  # --user needs a runtime directory, which CI runners and containers may not have.
  mkdir -p "$T/xdg-runtime" && chmod 700 "$T/xdg-runtime"
  if out="$(cd "$LX/units" && XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$T/xdg-runtime}" \
    systemd-analyze --user verify ocbi-rebuild.service ocbi-check.service ocbi-check.timer 2>&1)"; then
    ok "systemd-analyze verify accepts the units"
  else
    not_ok "systemd-analyze verify accepts the units" "$out"
  fi
else
  skip "systemd-analyze verify accepts the units" "systemd-analyze not found"
fi
SP="$T/spaced install"
OCBI_UNAME=Linux bash "$here/install.sh" --pieces rebuild --home "$SP/home" --bin-dir "$SP/bin" --systemd-dir "$SP/units" >/dev/null 2>&1
expect_eq "Linux install into a path with a space exits 0" 0 "$?"
check "the units quote a spaced script path" grep -qx "ExecStart=/bin/bash \"$SP/home/ocbi-check.sh\"" "$SP/units/ocbi-check.service"
if command -v systemd-analyze >/dev/null 2>&1; then
  if out="$(cd "$SP/units" && XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$T/xdg-runtime}" \
    systemd-analyze --user verify ocbi-rebuild.service ocbi-check.service ocbi-check.timer 2>&1)"; then
    ok "systemd-analyze verify accepts the units under a spaced path"
  else
    not_ok "systemd-analyze verify accepts the units under a spaced path" "$out"
  fi
else
  skip "systemd-analyze verify accepts the units under a spaced path" "systemd-analyze not found"
fi
MX="$T/mac-install"
OCBI_UNAME=Darwin bash "$here/install.sh" --pieces rebuild --home "$MX/home" --bin-dir "$MX/bin" \
  --systemd-dir "$MX/units" --launch-agents-dir "$MX/agents" --label org.example.ocbi.rebuild >/dev/null 2>&1
expect_eq "macOS install exits 0" 0 "$?"
check "macOS install places both plists, the check labelled .check, and no units" \
  test -f "$MX/agents/org.example.ocbi.rebuild.plist" -a -f "$MX/agents/org.example.ocbi.check.plist" -a ! -e "$MX/units"
check "the check plist carries its label and a daily calendar interval" eval "grep -q '<string>org.example.ocbi.check</string>' '$MX/agents/org.example.ocbi.check.plist' && grep -q StartCalendarInterval '$MX/agents/org.example.ocbi.check.plist'"
if command -v plutil >/dev/null 2>&1; then check "check plist is valid" plutil -lint -s "$MX/agents/org.example.ocbi.check.plist"; fi

# --- ocbi-schedule -------------------------------------------------------------------------------
: >"$T/systemctl.calls"
sched() { PATH="$FS:$PATH" OCBI_UNAME=Linux bash "$LX/bin/ocbi-schedule" "$@"; }
sched install "$NR" >/dev/null 2>&1
expect_eq "schedule install refuses a repository without config and loads nothing" "64 0" "$? $(grep -c . "$T/systemctl.calls")"
out="$(sched install "$W" 2>&1)"
expect_eq "schedule install on Linux records the checkout and enables the timer" "0 $W --user daemon-reload
--user enable --now ocbi-check.timer" "$? $(cat "$LX/home/check.conf") $(cat "$T/systemctl.calls")"
sched install "$W" >/dev/null 2>&1
expect_eq "a second schedule install lists the checkout once" "0 1" "$? $(grep -c . "$LX/home/check.conf")"
out="$(sched status 2>&1)"
expect_match "schedule status lists the units and the checked checkouts" "ocbi-check.timer: .*checked daily .*$W" "$(printf '%s' "$out" | tr '\n' ' ')"
perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $m, ">", $ARGV[1]); print $m "held\n"; close $m; sleep 3' \
  "$LX/home/rebuild.flock" "$T/sched-held" &
holder=$!
wait_for "$T/sched-held" held
sched uninstall >/dev/null 2>&1
expect_eq "schedule uninstall refuses while a rebuild runs and keeps the units" "75 present" "$? $([ -f "$LX/units/ocbi-check.timer" ] && echo present || echo absent)"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
: >"$T/systemctl.calls"
touch "$FS/fail-disable"
err="$(sched uninstall 2>&1)"
expect_eq "schedule uninstall keeps the units when the timer cannot be disabled" "1 present" "$? $([ -f "$LX/units/ocbi-check.timer" ] && echo present || echo absent)"
expect_match "schedule uninstall reports the systemctl failure" "Failed to connect to bus.*kept the units" "$err"
rm -f "$FS/fail-disable"
: >"$T/systemctl.calls"
sched uninstall >/dev/null 2>&1
expect_eq "schedule uninstall disables the timer, removes the units and keeps check.conf" "0 absent $W" \
  "$? $([ -e "$LX/units/ocbi-check.timer" ] || [ -e "$LX/units/ocbi-rebuild.service" ] && echo present || echo absent) $(cat "$LX/home/check.conf")"
check "schedule uninstall called systemctl disable --now on the timer" grep -qx -- '--user disable --now ocbi-check.timer' "$T/systemctl.calls"
sched install >/dev/null 2>&1
expect_eq "schedule install without units fails and names install.sh" 1 "$?"
# Without the timer file: a failed stop keeps everything; a link in either the unit directory or
# the persistent user configuration directory (where systemctl enable puts it) is removed.
XC="$T/xdg-config"
mkdir -p "$LX/units/timers.target.wants" "$XC/systemd/user/timers.target.wants"
ln -s "$LX/units/ocbi-check.timer" "$LX/units/timers.target.wants/ocbi-check.timer"
ln -s "$LX/units/ocbi-check.timer" "$XC/systemd/user/timers.target.wants/ocbi-check.timer"
printf '[Service]\n' >"$LX/units/ocbi-check.service"
touch "$FS/fail-stop"
err="$(XDG_CONFIG_HOME="$XC" sched uninstall 2>&1)"
expect_eq "schedule uninstall keeps the links and units when the timer cannot be stopped" "1 present present" \
  "$? $([ -L "$XC/systemd/user/timers.target.wants/ocbi-check.timer" ] && echo present || echo absent) $([ -f "$LX/units/ocbi-check.service" ] && echo present || echo absent)"
expect_match "schedule uninstall reports the failed stop" "stop ocbi-check.timer failed \\(Access denied\\)" "$err"
rm -f "$FS/fail-stop"
if [ "$(id -u)" != 0 ]; then
  chmod 555 "$XC/systemd/user/timers.target.wants"
  XDG_CONFIG_HOME="$XC" sched uninstall >/dev/null 2>&1
  expect_eq "schedule uninstall keeps the units when an enablement link cannot be removed" "1 present present" \
    "$? $([ -L "$XC/systemd/user/timers.target.wants/ocbi-check.timer" ] && echo present || echo absent) $([ -f "$LX/units/ocbi-check.service" ] && echo present || echo absent)"
  chmod 000 "$XC/systemd/user/timers.target.wants"
  XDG_CONFIG_HOME="$XC" sched uninstall >/dev/null 2>&1
  expect_eq "schedule uninstall keeps the units when it cannot search for an enablement link" "1 present" \
    "$? $([ -f "$LX/units/ocbi-check.service" ] && echo present || echo absent)"
  chmod 755 "$XC/systemd/user/timers.target.wants"
  chmod 000 "$XC"
  XDG_CONFIG_HOME="$XC" sched uninstall >/dev/null 2>&1
  rc=$?
  chmod 755 "$XC"
  expect_eq "schedule uninstall keeps the units and the link when an ancestor cannot be searched" "1 present present" \
    "$rc $([ -f "$LX/units/ocbi-check.service" ] && echo present || echo absent) $([ -L "$XC/systemd/user/timers.target.wants/ocbi-check.timer" ] && echo present || echo absent)"
  # The same through a symlinked XDG_CONFIG_HOME whose target sits under an unsearchable directory.
  mkdir -p "$T/locked"
  mv "$XC" "$T/locked/xdg-config"
  ln -s "$T/locked/xdg-config" "$XC"
  chmod 000 "$T/locked"
  XDG_CONFIG_HOME="$XC" sched uninstall >/dev/null 2>&1
  rc=$?
  chmod 755 "$T/locked"
  expect_eq "schedule uninstall keeps the units and the link behind a symlinked unsearchable directory" "1 present present" \
    "$rc $([ -f "$LX/units/ocbi-check.service" ] && echo present || echo absent) $([ -L "$XC/systemd/user/timers.target.wants/ocbi-check.timer" ] && echo present || echo absent)"
else
  skip "schedule uninstall keeps the units when an enablement link cannot be removed" "root ignores directory permissions"
fi
# The failure cases above may have removed the link in the unit directory before stopping at the
# other one; put both back so this run has to remove both.
for d in "$LX/units" "$XC/systemd/user"; do
  mkdir -p "$d/timers.target.wants"
  ln -sf "$LX/units/ocbi-check.timer" "$d/timers.target.wants/ocbi-check.timer"
done
check "both enablement links exist before the paired uninstall" test -L "$LX/units/timers.target.wants/ocbi-check.timer" -a -L "$XC/systemd/user/timers.target.wants/ocbi-check.timer"
: >"$T/systemctl.calls"
XDG_CONFIG_HOME="$XC" sched uninstall >/dev/null 2>&1
expect_eq "schedule uninstall without the timer file stops it and removes both enablement links" "0 absent absent absent --user stop ocbi-check.timer" \
  "$? $([ -L "$LX/units/timers.target.wants/ocbi-check.timer" ] && echo present || echo absent) $([ -L "$XC/systemd/user/timers.target.wants/ocbi-check.timer" ] && echo present || echo absent) $([ -f "$LX/units/ocbi-check.service" ] && echo present || echo absent) $(head -n 1 "$T/systemctl.calls")"
# A configuration path that starts with a dash is data, not an option to perl or rm.
mkdir -p "$T/dash/-zexample/systemd/user/timers.target.wants"
ln -s "$LX/units/ocbi-check.timer" "$T/dash/-zexample/systemd/user/timers.target.wants/ocbi-check.timer"
(cd "$T/dash" && XDG_CONFIG_HOME=-zexample sched uninstall >/dev/null 2>&1)
expect_eq "schedule uninstall treats a configuration path with a leading dash as a path" "0 absent" \
  "$? $([ -L "$T/dash/-zexample/systemd/user/timers.target.wants/ocbi-check.timer" ] && echo present || echo absent)"
fake "$FS" launchctl "printf '%s\\n' \"\$*\" >>'$T/launchctl.calls'
if [ \"\$1\" = bootout ]; then
  perl -MFcntl=:flock -e 'open(my \$f, \">>\", \$ARGV[0]) or exit 1; exit(flock(\$f, LOCK_EX | LOCK_NB) ? 0 : 1)' '$MX/home/rebuild.flock' &&
    echo free >>'$T/bootout-lock' || echo held >>'$T/bootout-lock'
  [ ! -e '$FS/fail-bootout' ]
fi"
: >"$T/launchctl.calls"
msched() { PATH="$FS:$PATH" OCBI_UNAME=Darwin bash "$MX/bin/ocbi-schedule" "$@"; }
msched install "$R" >/dev/null 2>&1
uid="$(id -u)"
expect_eq "schedule install on macOS holds the rebuild lock while it unloads the agents" "held held" "$(tr '\n' ' ' <"$T/bootout-lock" | sed 's/ $//')"
expect_eq "schedule install on macOS reloads both agents" "0 bootout gui/$uid/org.example.ocbi.rebuild
bootstrap gui/$uid $MX/agents/org.example.ocbi.rebuild.plist
bootout gui/$uid/org.example.ocbi.check
bootstrap gui/$uid $MX/agents/org.example.ocbi.check.plist" "$? $(cat "$T/launchctl.calls")"
perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $m, ">", $ARGV[1]); print $m "held\n"; close $m; sleep 3' \
  "$MX/home/rebuild.flock" "$T/msched-held" &
holder=$!
wait_for "$T/msched-held" held
: >"$T/launchctl.calls"
out="$(msched install 2>&1)"
expect_eq "schedule install on macOS leaves a running rebuild's agent loaded and reloads the check" "0 print gui/$uid/org.example.ocbi.rebuild
bootout gui/$uid/org.example.ocbi.check
bootstrap gui/$uid $MX/agents/org.example.ocbi.check.plist" "$? $(cat "$T/launchctl.calls")"
expect_match "schedule install says why it kept the rebuild agent" "kept org.example.ocbi.rebuild loaded: a rebuild is running" "$out"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
touch "$FS/fail-bootout"
msched uninstall >/dev/null 2>&1
expect_eq "schedule uninstall on macOS keeps a plist it could not unload" "1 present" "$? $([ -f "$MX/agents/org.example.ocbi.check.plist" ] && echo present || echo absent)"
rm -f "$FS/fail-bootout" "$T/bootout-lock"
msched uninstall >/dev/null 2>&1
expect_eq "schedule uninstall on macOS boots both agents out and removes the plists" "0 absent" \
  "$? $([ -e "$MX/agents/org.example.ocbi.check.plist" ] || [ -e "$MX/agents/org.example.ocbi.rebuild.plist" ] && echo present || echo absent)"
expect_eq "schedule uninstall on macOS holds the rebuild lock while it unloads the agents" "held held" "$(tr '\n' ' ' <"$T/bootout-lock" | sed 's/ $//')"
OCBI_UNAME=SunOS bash "$MX/bin/ocbi-schedule" status >/dev/null 2>&1
expect_eq "schedule refuses an unsupported system" 69 "$?"

# --- notifications -------------------------------------------------------------------------------
NH="$T/notifyhome"
mkdir -p "$NH"
cp "$H/ocbi-notify.sh" "$NH/"
FN="$T/fake-notify"
# notify-send records its arguments, answers --help with or without --action, fails when
# FN/fail exists and prints "run" for --wait (the button was clicked).
fake "$FN" notify-send "if [ \"\$1\" = --help ]; then [ -e '$FN/old' ] && echo '-u, --urgency' || echo '-A, --action=[NAME=]Text'; exit 0; fi
printf '%s|' \"\$@\" >>'$T/notify-send.calls'; printf '\\n' >>'$T/notify-send.calls'
[ ! -e '$FN/fail' ] || exit 1
case \" \$* \" in *' --wait '*) [ ! -e '$FN/slow' ] || sleep 3; echo run ;; esac"
fake "$FN" gdbus "[ -e '$FN/caps' ] || exit 1; cat '$FN/caps'"
fake "$FN" systemd-run "printf '%s|' \"\$@\" >'$T/systemd-run.calls'"
nrun() {
  rm -f "$T/notify-send.calls" "$T/systemd-run.calls"
  env -u INVOCATION_ID PATH="$FN:$PATH" OCBI_UNAME=Linux "$@"
}
# A headless machine: no session bus. notify-send is never called; the command is printed.
err="$(nrun env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR="$T/no-runtime" bash "$NH/ocbi-notify.sh" "Worth a cleanup: demo" "20 catalogs." Prune "touch '$T/pruned'" 2>&1 >/dev/null)"
expect_eq "notify without a session bus exits 0 and calls nothing" "0 absent" "$? $([ -e "$T/notify-send.calls" ] && echo present || echo absent)"
expect_eq "notify without a session bus prints the notification and the command" "[ocbi-notify] Worth a cleanup: demo: 20 catalogs. Run: touch '$T/pruned'" "$err"
expect_match "notify logs every notification" "Worth a cleanup: demo: 20 catalogs\\. Run: touch '$T/pruned'$" "$(cat "$NH/logs/notify.log")"
# A session bus with no notification server: the capability query and notify-send fail.
touch "$FN/fail"
err="$(nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent bash "$NH/ocbi-notify.sh" "T" "B" Rebuild "echo hi" 2>&1 >/dev/null)"
expect_eq "notify without a notification server falls back to stderr" "0 [ocbi-notify] T: B Run: echo hi" "$? $err"
rm -f "$FN/fail"
# A server without actions: a plain notification whose body carries the command.
printf "(['body', 'body-markup'],)\n" >"$FN/caps"
err="$(nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x bash "$NH/ocbi-notify.sh" "T" "B" Rebuild "echo hi" 2>&1)"
expect_eq "notify on a server without actions sends the command in the body" "0 --app-name=Codebase index|T|B Run: echo hi|" "$? $err$(cat "$T/notify-send.calls")"
# A server with actions: a detached waiter shows the button and runs the command on a click.
printf "(['actions', 'body'],)\n" >"$FN/caps"
rm -f "$T/clicked"
nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x bash "$NH/ocbi-notify.sh" "T" "B" Rebuild "echo clicked >'$T/clicked'"
expect_eq "notify on a server with actions exits 0" 0 "$?"
if wait_for "$T/clicked" clicked; then ok "the action button runs the command"; else not_ok "the action button runs the command"; fi
expect_eq "the waiter offers the button and waits" "--app-name=Codebase index|--wait|--action=run=Rebuild|T|B|" "$(cat "$T/notify-send.calls")"
touch "$FN/old"
nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x bash "$NH/ocbi-notify.sh" "T" "B" Rebuild "echo hi"
expect_eq "notify-send without --action gets a plain notification" "--app-name=Codebase index|T|B Run: echo hi|" "$(cat "$T/notify-send.calls")"
rm -f "$FN/old"
nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x bash "$NH/ocbi-notify.sh" "T" "B"
expect_eq "notify without an action sends a plain notification" "--app-name=Codebase index|T|B|" "$(cat "$T/notify-send.calls")"
# The package's post-checkout hook (--stale-notify) passes TITLE and BODY only, the command after
# "Run: " at the end of BODY: it becomes the action.
printf "(['actions', 'body'],)\n" >"$FN/caps"
rm -f "$T/hook-clicked"
nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x bash "$NH/ocbi-notify.sh" "Worth a cleanup: demo" "20 catalogs of deleted branches or worktrees. Run: echo pruned >'$T/hook-clicked'"
if wait_for "$T/hook-clicked" pruned; then ok "a hook notification's Run command becomes the action"; else not_ok "a hook notification's Run command becomes the action"; fi
expect_eq "the hook notification shows the body without the command and a Run button" \
  "--app-name=Codebase index|--wait|--action=run=Run|Worth a cleanup: demo|20 catalogs of deleted branches or worktrees.|" "$(cat "$T/notify-send.calls")"
printf "(['body'],)\n" >"$FN/caps"
nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x bash "$NH/ocbi-notify.sh" "Worth a cleanup: demo" "20 catalogs. Run: echo hi"
expect_eq "without actions the hook notification keeps the command in its body" "--app-name=Codebase index|Worth a cleanup: demo|20 catalogs. Run: echo hi|" "$(cat "$T/notify-send.calls")"
printf "(['actions', 'body'],)\n" >"$FN/caps"
# Inside a systemd unit the waiter gets a transient unit of its own.
nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x INVOCATION_ID=test bash "$NH/ocbi-notify.sh" "T" "B" Rebuild "cd '/src/\${HOME}' && echo hi"
expect_match "notify inside a systemd unit starts the waiter with systemd-run, its text in variables" \
  "^--user\\|--quiet\\|--collect\\|--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/x\\|--setenv=OCBI_HOME=$NH\\|--setenv=PATH=.*\\|--setenv=OCBI_WAIT_TITLE=T\\|--setenv=OCBI_WAIT_BODY=B\\|--setenv=OCBI_WAIT_LABEL=Rebuild\\|--setenv=OCBI_WAIT_COMMAND=cd '/src/\\\$\\{HOME\\}' && echo hi\\|--\\|bash\\|$NH/ocbi-notify.sh\\|--wait-action\\|$" \
  "$(cat "$T/systemd-run.calls" 2>/dev/null)"
# The detached waiter must not keep a descriptor of its caller, such as the rebuild's lock, open.
touch "$FN/slow"
rm -f "$T/clicked" "$T/fd-lock"
nrun DBUS_SESSION_BUS_ADDRESS=unix:path=/x perl -MFcntl=:flock -e '
  my ($lock, @cmd) = @ARGV; $^F = 255;
  open(my $fh, ">>", $lock) or die; flock($fh, LOCK_EX | LOCK_NB) or die; exec(@cmd) or die;' \
  "$T/fd-lock" bash "$NH/ocbi-notify.sh" "T" "B" Rebuild "echo clicked >'$T/clicked'"
if perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 1; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "$T/fd-lock" &&
  [ ! -e "$T/clicked" ]; then
  ok "the waiter does not hold its caller's lock while the notification is open"
else
  not_ok "the waiter does not hold its caller's lock while the notification is open"
fi
wait_for "$T/clicked" clicked
rm -f "$FN/slow"
if command -v notify-send >/dev/null 2>&1; then
  skip "notify without notify-send prints the notification" "notify-send is installed here"
else
  err="$(env -u INVOCATION_ID OCBI_UNAME=Linux DBUS_SESSION_BUS_ADDRESS=unix:path=/x bash "$NH/ocbi-notify.sh" "T" "B" 2>&1)"
  expect_eq "notify without notify-send prints the notification" "0 [ocbi-notify] T: B" "$? $err"
fi
# macOS: the notifier app with its button, else osascript.
fake "$FN" open "printf '%s|' \"\$@\" >'$T/open.calls'"
fake "$FN" osascript "printf '%s|' \"\$@\" >'$T/osascript.calls'"
mkdir -p "$T/Notifier.app"
PATH="$FN:$PATH" OCBI_UNAME=Darwin OCBI_NOTIFIER_APP="$T/Notifier.app" bash "$NH/ocbi-notify.sh" "T" "B" Rebuild "echo hi"
expect_eq "notify on macOS opens the notifier app with the action" "-g|-n|$T/Notifier.app|--args|--title|T|--body|B|--action-label|Rebuild|--action-command|echo hi|" "$(cat "$T/open.calls")"
PATH="$FN:$PATH" OCBI_UNAME=Darwin OCBI_NOTIFIER_APP="$T/none.app" bash "$NH/ocbi-notify.sh" "T" "B"
check "notify on macOS without the app uses osascript" grep -q 'display notification' "$T/osascript.calls"
# A hook notification (TITLE BODY only) keeps its command in the osascript body, which has no button.
fake "$FN" osascript "printf '%s' \"\$BODY\" >'$T/osascript.body'"
PATH="$FN:$PATH" OCBI_UNAME=Darwin OCBI_NOTIFIER_APP="$T/none.app" bash "$NH/ocbi-notify.sh" "Worth a cleanup: demo" "20 catalogs. Run: echo hi"
expect_eq "notify on macOS without the app keeps a hook notification's command in the body" "20 catalogs. Run: echo hi" "$(cat "$T/osascript.body")"
PATH="$FN:$PATH" OCBI_UNAME=Darwin OCBI_NOTIFIER_APP="$T/Notifier.app" bash "$NH/ocbi-notify.sh" "Worth a cleanup: demo" "20 catalogs. Run: echo hi"
expect_eq "notify on macOS with the app turns a hook notification's command into the action" "-g|-n|$T/Notifier.app|--args|--title|Worth a cleanup: demo|--body|20 catalogs.|--action-label|Run|--action-command|echo hi|" "$(cat "$T/open.calls")"

printf '# pass %d fail %d\n' "$pass" "$fail"
[ "$fail" = 0 ]
