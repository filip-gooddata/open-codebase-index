#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted JavaScript programs
# Tests for contrib/local-wrapper. No arguments; exits nonzero when any test fails.
# Needs bash (3.2+), git (>= 2.31), node (>= 22), perl and coreutils. Runs shellcheck over the
# shell scripts when it is on PATH (set OCBI_WRAPPER_REQUIRE_SHELLCHECK=1 to fail without it),
# and the --stale-check test only when sqlite3 is on PATH.
# Everything runs in a temporary HOME; nothing outside it is read or written, and no real index,
# embedding provider or network is used: the server, CLI and launcher are stubbed where needed.
set -u

here="$(cd "$(dirname "$0")/.." && pwd)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/ocbi-wrapper-test.XXXXXX")" || exit 1
T="$(cd "$tmp_root" && pwd -P)"
trap 'rm -rf "$T"' EXIT

export HOME="$T/home"
mkdir -p "$HOME"
unset OCBI_HOME XDG_DATA_HOME GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
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

# --- static checks -------------------------------------------------------------------------------
scripts=("$here/install.sh" "$here/launcher/ocbi-mcp.sh" "$here/hook/ocbi-post-checkout.sh"
  "$here/rebuild/ocbi-rebuild.sh" "$here/rebuild/ocbi-rebuild" "$here/notify/ocbi-notify.sh"
  "$here/notify/notifier/build.sh" "$here/test/run-tests.sh")
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
done < <(find "$here/claude-plugin" "$here/launcher" -name '*.json')

# --- install.sh ----------------------------------------------------------------------------------
H="$HOME/.local/share/ocbi"
install_args=(--launch-agents-dir "$HOME/Library/LaunchAgents")
check "install --help exits 0" bash "$here/install.sh" --help >/dev/null
bash "$here/install.sh" --bogus >/dev/null 2>&1
expect_eq "install rejects an unknown option" 2 "$?"
bash "$here/install.sh" --pieces pkg >/dev/null 2>&1
expect_eq "install rejects pkg without --package" 2 "$?"

out="$(bash "$here/install.sh" --dry-run "${install_args[@]}" 2>&1)"
expect_eq "dry run exits 0" 0 "$?"
expect_match "dry run lists planned files" "would create +$H/ocbi-mcp.sh" "$out"
if [ -z "$(find "$HOME" -mindepth 1 -not -name . 2>/dev/null)" ]; then ok "dry run writes nothing"; else
  not_ok "dry run writes nothing" "$(find "$HOME" -mindepth 1)"; fi
out="$(bash "$here/install.sh" --dry-run --package ./x.tgz "${install_args[@]}" 2>&1)"
expect_match "dry run prints the npm install of --package" "would run: npm install --prefix $H/pkg" "$out"

out="$(bash "$here/install.sh" "${install_args[@]}" 2>&1)"
expect_eq "install exits 0" 0 "$?"
for f in ocbi-mcp.sh ocbi-post-checkout.sh ocbi-rebuild.sh ocbi-notify.sh; do
  check "installed executable $f" test -x "$H/$f"
done
check "installed ocbi-rebuild into the bin dir" test -x "$HOME/.local/bin/ocbi-rebuild"
check "installed config examples" test -f "$H/projects.conf.example" -a -f "$H/profiles.conf.example" -a -f "$H/codebase-index.example.json"
check "did not create projects.conf" test ! -e "$H/projects.conf"
M="$HOME/.claude/local-marketplaces/ocbi-local"
check "installed the plugin commands and skill" test -f "$M/plugins/codebase-index/commands/search.md" -a -f "$M/plugins/codebase-index/skills/codebase-search/SKILL.md"
check "plugin index.md is the shared-store override" grep -q 'force is never set' "$M/plugins/codebase-index/commands/index.md"
if grep -rq '@[A-Z_]*@' "$M" "$HOME/.local/bin/ocbi-rebuild"; then not_ok "no template placeholders left"; else ok "no template placeholders left"; fi
got="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(p.mcpServers["codebase-index"].args[0])' "$M/plugins/codebase-index/.claude-plugin/plugin.json")"
expect_eq "plugin.json points at the installed launcher" "$H/ocbi-mcp.sh" "$got"
got="$(node -e 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(Object.keys(h.hooks).join(",")+" "+h.hooks.SessionStart[0].hooks[0].command)' "$M/plugins/codebase-index/hooks/hooks.json")"
expect_eq "hooks.json wires only the session hint, through the installed launcher" "SessionStart /bin/bash \"$H/ocbi-mcp.sh\" --session-hint" "$got"
got="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).indexing.allowForceRebuild))' "$H/codebase-index.example.json")"
expect_eq "the example store config refuses forced rebuilds" false "$got"
if [ "$(uname -s)" = Darwin ]; then
  plist="$HOME/Library/LaunchAgents/io.github.open-codebase-index.rebuild.plist"
  check "installed the launchd plist" grep -q "<string>$H/ocbi-rebuild.sh</string>" "$plist"
  if command -v plutil >/dev/null 2>&1; then check "plist is valid" plutil -lint -s "$plist"; fi
else
  check "no launchd plist off macOS" test ! -e "$HOME/Library/LaunchAgents"
fi
expect_match "install prints the Codex snippet" "args = \\[\"$H/ocbi-mcp.sh\"\\]" "$out"
expect_match "install prints the git hook registration" "hook.ocbi-prewarm.command \"'$H/ocbi-post-checkout.sh'\"" "$out"
out="$(bash "$here/install.sh" "${install_args[@]}" 2>&1)"
expect_match "second install changes nothing" "^0 change\\(s\\)\\." "$out"
chmod -x "$H/ocbi-mcp.sh"
bash "$here/install.sh" "${install_args[@]}" >/dev/null 2>&1
check "reinstall restores the launcher's executable bit" test -x "$H/ocbi-mcp.sh"
BO="$T/bundle-only"
mkdir -p "$BO" && cp -R "$here" "$BO/local-wrapper"
bash "$BO/local-wrapper/install.sh" --home "$BO/home" --bin-dir "$BO/bin" --marketplace-dir "$BO/mp" --launch-agents-dir "$BO/la" >/dev/null 2>&1
expect_eq "install works from the bundle alone" 0 "$?"
check "bundle-only install has the plugin commands and skill" test -f "$BO/mp/plugins/codebase-index/commands/search.md" -a -f "$BO/mp/plugins/codebase-index/skills/codebase-search/SKILL.md"
bash "$here/install.sh" --home "$T/a&b" >/dev/null 2>&1
expect_eq "install rejects a path with &" "2 absent" "$? $([ -e "$T/a&b" ] && echo present || echo absent)"
P2="$T/preflight"
mkdir -p "$P2/ocbi-mcp.sh"
bash "$here/install.sh" --pieces launcher,hook --home "$P2" >/dev/null 2>&1
expect_eq "install refuses a directory at a destination and writes nothing" "2 absent" "$? $([ -e "$P2/projects.conf.example" ] || [ -e "$P2/ocbi-post-checkout.sh" ] && echo present || echo absent)"
printf '# mine\n' >"$H/projects.conf"
bash "$here/install.sh" "${install_args[@]}" >/dev/null 2>&1
expect_eq "install keeps an existing projects.conf" "# mine" "$(cat "$H/projects.conf")"
rm -f "$H/projects.conf"

# --- stubs: server, CLI ------------------------------------------------------------------------
dist="$H/pkg/node_modules/open-codebase-index/dist"
mkdir -p "$dist"
# Echo server: answers every JSON-RPC line with its method and the server's argv.
cat >"$dist/cli.js" <<'EOF'
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { echo: m.method, argv: process.argv.slice(2) } }) + "\n");
});
EOF
cat >"$dist/cbi.js" <<'EOF'
// The launcher looks for --allow-shared-rebuild to tell a package with indexing.allowForceRebuild.
process.stdout.write("CBI " + process.argv.slice(2).join(" ") + " cwd=" + process.cwd() + "\n");
EOF

# --- repositories --------------------------------------------------------------------------------
R="$T/src/demo"
mkdir -p "$R"
git -C "$R" init -q -b main
echo hi >"$R/a.txt"
git -C "$R" add a.txt && git -C "$R" commit -qm init
git -C "$R" worktree add -q "$T/src/demo-feature" -b feature
W="$T/src/demo-feature"

L="$H/ocbi-mcp.sh"

# --- not listed ----------------------------------------------------------------------------------
out="$(cd "$R" && bash "$L" --session-hint)"
expect_eq "--session-hint is silent for an unlisted repo" "" "$out"
out="$(cd "$R" && bash "$L" --link-only 2>/dev/null)"
expect_eq "--link-only prints the root of an unlisted repo" "$R" "$out"
check "no links in an unlisted repo" test ! -e "$R/.claude"

# --- listed, preconditions unmet ------------------------------------------------------------------
printf '# test\ndemo|%s\n' "$R/.git" >"$H/projects.conf"
mkdir -p "$H/demo"
cp "$H/codebase-index.example.json" "$H/demo/codebase-index.json"
err="$(cd "$R" && bash "$L" --link-only 2>&1 >/dev/null)"
expect_eq "unexcluded paths: a listed checkout refuses to start (--link-only exits 1)" 1 "$?"
expect_match "unexcluded paths are reported" "must be in .*info/exclude" "$err"
check "unexcluded paths: nothing linked" test ! -L "$R/.claude/index"

# --- listed, linked --------------------------------------------------------------------------------
printf '.claude/index\n.claude/codebase-index.json\n' >>"$R/.git/info/exclude"
out="$(cd "$R" && bash "$L" --session-hint)"
expect_match "--session-hint speaks for a listed repo" "codebase_context" "$out"
out="$(cd "$R/" && bash "$L" --link-only 2>/dev/null)"
expect_eq "--link-only prints the root" "$R" "$out"
expect_eq "index link targets the store" "$H/demo/claude-index" "$(readlink "$R/.claude/index")"
expect_eq "config link targets the base config" "$H/demo/codebase-index.json" "$(readlink "$R/.claude/codebase-index.json")"
(cd "$W" && bash "$L" --link-only >/dev/null 2>&1)
expect_eq "a linked worktree shares the store" "$H/demo/claude-index" "$(readlink "$W/.claude/index")"

# Something in the way of a link is parked, not deleted.
rm -f "$W/.claude/index"
mkdir -p "$W/.claude/index" && echo keep >"$W/.claude/index/file"
(cd "$W" && bash "$L" --link-only >/dev/null 2>&1)
check "a directory in the way is replaced by the link" test -L "$W/.claude/index"
parked="$(find "$H/demo/parked" -name file 2>/dev/null | head -n 1)"
expect_eq "the directory in the way is parked with its content" "keep" "$(cat "$parked" 2>/dev/null)"

# --- profiles ----------------------------------------------------------------------------------
printf 'demo|%s\n' "$R" >"$H/profiles.conf"
(cd "$R" && bash "$L" --link-only >/dev/null 2>&1)
(cd "$W" && bash "$L" --link-only >/dev/null 2>&1)
expect_eq "primary checkout gets the main profile" "$H/demo/profiles/main.json" "$(readlink "$R/.claude/codebase-index.json")"
expect_eq "other worktree gets the worktree profile" "$H/demo/profiles/worktree.json" "$(readlink "$W/.claude/codebase-index.json")"
got="$(node -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).indexing;process.stdout.write(`${i.watchFiles} ${i.autoIndexOnStartup}`)' "$H/demo/profiles/main.json")"
expect_eq "main profile keeps background indexing" "true true" "$got"
got="$(node -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).indexing;process.stdout.write(`${i.watchFiles} ${i.autoIndexOnStartup} ${i.autoIndexWaitMs}`)' "$H/demo/profiles/worktree.json")"
expect_eq "worktree profile indexes on demand, other keys kept" "false false 360000" "$got"
check "profile hash sidecar matches" test "$(cat "$H/demo/profiles/main.json.sha256")" = "$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$H/demo/profiles/main.json")"
# A base config edit regenerates the profile; a hand-edited profile is parked first.
echo '{}' >"$H/demo/profiles/worktree.json"
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));c.indexing.autoIndexWaitMs=1234;require("fs").writeFileSync(f,JSON.stringify(c))' "$H/demo/codebase-index.json"
(cd "$W" && bash "$L" --link-only >/dev/null 2>&1)
got="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).indexing.autoIndexWaitMs))' "$H/demo/profiles/worktree.json")"
expect_eq "profile follows the base config" "1234" "$got"
check "hand-edited profile was parked" test -n "$(find "$H/demo/parked" -name worktree.json 2>/dev/null)"
# A pin that git does not confirm gives every checkout the worktree profile.
printf 'demo|%s|/nonexistent\n' "$R" >"$H/profiles.conf"
err="$(cd "$R" && bash "$L" --link-only 2>&1 >/dev/null)"
expect_match "a wrong pin is reported" "is not the pinned" "$err"
expect_eq "a wrong pin gives the primary the worktree profile" "$H/demo/profiles/worktree.json" "$(readlink "$R/.claude/codebase-index.json")"
printf 'demo|%s\n' "$R" >"$H/profiles.conf"

# --- bare clone with a pinned primary --------------------------------------------------------------
B="$T/src/bare.git"
git clone -q --bare "$R" "$B"
git -C "$B" worktree add -q "$B/main" main 2>/dev/null || git -C "$B" worktree add -q -f "$B/main" main
git -C "$B" worktree add -q "$B/topic" -b topic
printf '.claude/index\n.claude/codebase-index.json\n' >>"$B/info/exclude"
printf 'demo|%s\nbare|%s\n' "$R/.git" "$B" >"$H/projects.conf"
mkdir -p "$H/bare" && cp "$H/codebase-index.example.json" "$H/bare/codebase-index.json"
printf 'demo|%s\nbare|%s|%s\n' "$R" "$B/main" "$B/worktrees/main" >"$H/profiles.conf"
(cd "$B/main" && bash "$L" --link-only >/dev/null 2>&1)
(cd "$B/topic" && bash "$L" --link-only >/dev/null 2>&1)
expect_eq "bare clone: pinned primary gets main" "$H/bare/profiles/main.json" "$(readlink "$B/main/.claude/codebase-index.json")"
expect_eq "bare clone: other worktree gets worktree" "$H/bare/profiles/worktree.json" "$(readlink "$B/topic/.claude/codebase-index.json")"
printf 'demo|%s\nbare|%s\n' "$R" "$B/main" >"$H/profiles.conf"
err="$(cd "$B/main" && bash "$L" --link-only 2>&1 >/dev/null)"
expect_match "bare clone without a pin is reported" "pins no git dir" "$err"
printf 'demo|%s\n' "$R" >"$H/profiles.conf"

# --- unlisting removes our links -----------------------------------------------------------------
printf 'bare|%s\n' "$B" >"$H/projects.conf"
(cd "$W" && bash "$L" --link-only >/dev/null 2>&1)
check "unlisted again: launcher-made links are removed" test ! -L "$W/.claude/index" -a ! -L "$W/.claude/codebase-index.json"
printf 'demo|%s\nbare|%s\n' "$R/.git" "$B" >"$H/projects.conf"

# --- --cbi, server -------------------------------------------------------------------------------
out="$(cd "$W" && bash "$L" --cbi status --host claude 2>/dev/null)"
expect_eq "--cbi runs the CLI in the checkout" "CBI status --host claude cwd=$W" "$out"
out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index 2>/dev/null)"
expect_eq "guarded --cbi names --host claude and the root" "CBI index --host claude --project $W cwd=$W" "$out"
out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --force --allow-shared-rebuild 2>/dev/null)"
expect_eq "guarded --cbi passes the shared-rebuild override to the CLI" "CBI index --force --allow-shared-rebuild --host claude --project $W cwd=$W" "$out"
(cd "$W" && OCBI_REQUIRE_PROJECT=bare bash "$L" --cbi index >/dev/null 2>&1)
expect_eq "--cbi refuses another project's checkout" 3 "$?"
out="$(cd "$T" && OCBI_REQUIRE_PROJECT='*' bash "$L" --cbi index 2>&1)"
expect_eq "--cbi refuses an unlisted directory" "3" "$(cd "$T" && OCBI_REQUIRE_PROJECT='*' bash "$L" --cbi index >/dev/null 2>&1; echo $?)"
expect_match "--cbi says why it refuses" "refusing to run the CLI" "$out"
(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project "$R" >/dev/null 2>&1)
expect_eq "guarded --cbi refuses another --project" 3 "$?"
(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --config /tmp/x.json >/dev/null 2>&1)
expect_eq "guarded --cbi refuses --config" 3 "$?"
(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --host codex >/dev/null 2>&1)
expect_eq "guarded --cbi refuses another --host" 3 "$?"
out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --host claude --project "$W/" 2>/dev/null)"
expect_eq "guarded --cbi replaces its own --host and --project with the absolute root" "CBI index --host claude --project $W cwd=$W" "$out"
# From a symlinked working directory, ../x means different directories to the shell's logical cd
# and to the CLI; the guard resolves it as the CLI does and refuses the other checkout.
mkdir -p "$T/lnk" && ln -s "$W" "$T/lnk/wt" && ln -s "$W" "$T/lnk/demo"
(cd "$T/lnk/wt" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project ../demo >/dev/null 2>&1)
expect_eq "guarded --cbi refuses a relative --project that resolves to another checkout" 3 "$?"
out="$(cd "$T/lnk/wt" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --force --project . 2>/dev/null)"
expect_match "guarded --cbi accepts --project . and passes the physical root" "^CBI index --force --host claude --project $W cwd=" "$out"
# A symlink inside the argument followed by "..": the CLI resolves the ".." first (path.resolve),
# so the guard must too.
ln -s "$T/lnk" "$W/redirect"
(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project ../demo/redirect/.. >/dev/null 2>&1)
expect_eq "guarded --cbi refuses ../demo/redirect/.. (the CLI resolves it to the other checkout)" 3 "$?"
out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project redirect/.. 2>/dev/null)"
expect_eq "guarded --cbi accepts redirect/.. (the CLI resolves it to this checkout)" "CBI index --host claude --project $W cwd=$W" "$out"
rm -f "$W/redirect"
# Values that must never reach a resolver or the CLI: empty, option-shaped, and a sibling whose
# name differs only by a trailing newline.
for bad in "" "--require=$T/x.js" "-e"; do
  out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project "$bad" 2>&1)"
  expect_eq "guarded --cbi refuses --project '$bad' without starting the CLI" "3 no-cli" "$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project "$bad" >/dev/null 2>&1; echo $?) $(printf '%s' "$out" | grep -q '^CBI' && echo cli || echo no-cli)"
done
nl_sibling="$W
"
mkdir -p "$nl_sibling"
out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project "$nl_sibling" 2>&1)"
expect_eq "guarded --cbi refuses a sibling named like the root plus a newline" "3 no-cli" "$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project "$nl_sibling" >/dev/null 2>&1; echo $?) $(printf '%s' "$out" | grep -q '^CBI' && echo cli || echo no-cli)"
rm -rf "$nl_sibling"
(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --project >/dev/null 2>&1)
expect_eq "guarded --cbi refuses --project without a value" 3 "$?"
(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --host >/dev/null 2>&1)
expect_eq "guarded --cbi refuses --host without a value" 3 "$?"
(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi workspace status >/dev/null 2>&1)
expect_eq "guarded --cbi runs only index" 3 "$?"
out="$(cd "$W" && bash "$L" --cbi workspace status --json 2>/dev/null)"
expect_eq "unguarded --cbi passes arguments unchanged" "CBI workspace status --json cwd=$W" "$out"
# A store config without an explicit project scope is never linked, so guarded runs refuse.
cp "$H/demo/codebase-index.json" "$T/demo-config.json"
for scope in none global; do
  node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));if(process.argv[2]==="none")delete c.scope;else c.scope=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(c))' "$H/demo/codebase-index.json" "$scope"
  out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index 2>&1)"
  expect_eq "scope $scope: guarded --cbi refuses before the CLI starts" "1 no-cli" "$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index >/dev/null 2>&1; echo $?) $(printf '%s' "$out" | grep -q '^CBI' && echo cli || echo no-cli)"
  expect_match "scope $scope: the reason names the scope" 'must set "scope": "project"' "$out"
  check "scope $scope: the launcher removed its links" test ! -L "$W/.claude/index"
done
cp "$T/demo-config.json" "$H/demo/codebase-index.json"
# A store config from an older example, without allowForceRebuild false, starts nothing: the
# primary checkout keeps its links, and a worktree would inherit them.
(cd "$R" && bash "$L" --link-only >/dev/null 2>&1)
for allow in missing true; do
  node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));if(process.argv[2]==="missing")delete c.indexing.allowForceRebuild;else c.indexing.allowForceRebuild=true;require("fs").writeFileSync(f,JSON.stringify(c))' "$H/demo/codebase-index.json" "$allow"
  out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index 2>&1)"
  expect_eq "allowForceRebuild $allow: guarded --cbi refuses before the CLI starts" "1 no-cli" "$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index >/dev/null 2>&1; echo $?) $(printf '%s' "$out" | grep -q '^CBI' && echo cli || echo no-cli)"
  expect_match "allowForceRebuild $allow: the reason names the setting" '"allowForceRebuild": false' "$out"
  check "allowForceRebuild $allow: the launcher removed its links" test ! -L "$W/.claude/index"
  check "allowForceRebuild $allow: the primary still has its link" test -L "$R/.claude/index"
  out="$(cd "$W" && echo '{"jsonrpc":"2.0","id":8,"method":"ping"}' | bash "$L" 2>/dev/null; echo "exit=$?")"
  expect_eq "allowForceRebuild $allow: server mode starts no server in a worktree" "exit=1" "$out"
done
cp "$T/demo-config.json" "$H/demo/codebase-index.json"
(cd "$W" && bash "$L" --link-only >/dev/null 2>&1)
check "scope project: linked again" test -L "$W/.claude/index"
# A package without indexing.allowForceRebuild must not serve or rebuild a linked store.
cp "$dist/cbi.js" "$T/cbi.js.new"
printf 'process.stdout.write("CBI old\\n");\n' >"$dist/cbi.js"
out="$(cd "$W" && echo '{"jsonrpc":"2.0","id":7,"method":"ping"}' | bash "$L" 2>&1)"
expect_eq "old package: server mode exits 1 without starting" "1 no-server" "$(cd "$W" && echo '{"jsonrpc":"2.0","id":7,"method":"ping"}' | bash "$L" >/dev/null 2>&1; echo $?) $(printf '%s' "$out" | grep -q '"echo"' && echo server || echo no-server)"
expect_match "old package: the reason says to upgrade" "predates indexing.allowForceRebuild" "$out"
out="$(cd "$W" && OCBI_REQUIRE_PROJECT=demo bash "$L" --cbi index --force --allow-shared-rebuild 2>&1)"
expect_eq "old package: guarded --cbi does not start the CLI" "no-cli" "$(printf '%s' "$out" | grep -q '^CBI' && echo cli || echo no-cli)"
mv "$T/cbi.js.new" "$dist/cbi.js"
# A listed worktree left unlinked (here: the .claude paths not excluded) could inherit the
# primary's linked store and its profile, so it starts nothing.
(cd "$R" && bash "$L" --link-only >/dev/null 2>&1)
cp "$R/.git/info/exclude" "$T/exclude.bak"
grep -v '^\.claude/' "$T/exclude.bak" >"$R/.git/info/exclude"
out="$(cd "$W" && echo '{"jsonrpc":"2.0","id":9,"method":"ping"}' | bash "$L" 2>&1; echo "exit=$?")"
check "unlinked listed worktree: the primary still has its links" test -L "$R/.claude/index" -a -L "$R/.claude/codebase-index.json"
expect_match "unlinked listed worktree: refuses to start, no server" "refusing to start: demo: .*exit=1" "$(printf '%s' "$out" | tr '\n' ' ')"
if printf '%s' "$out" | grep -q '"echo"'; then not_ok "unlinked listed worktree: no server answered" "$out"; else ok "unlinked listed worktree: no server answered"; fi
cp "$T/exclude.bak" "$R/.git/info/exclude"
out="$(cd "$W" && echo '{"jsonrpc":"2.0","id":5,"method":"ping"}' | bash "$L" --project /elsewhere --host codex 2>/dev/null)"
expect_match "server mode: the launcher's --host and --project come last" "\"argv\":\\[\"--project\",\"/elsewhere\",\"--host\",\"codex\",\"--host\",\"claude\",\"--project\",\"$W\"\\]" "$out"

out="$(cd "$W" && printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | bash "$L" 2>/dev/null)"
expect_match "server mode: calls reach the server" '"id":2,"result":\{"echo":"tools/list"' "$out"
expect_match "server mode: the server gets --host claude --project <root>" "\"argv\":\\[\"--host\",\"claude\",\"--project\",\"$W\"\\]" "$out"


# --- post-checkout hook --------------------------------------------------------------------------
S="$T/stubhome"
mkdir -p "$S"
cat >"$S/ocbi-mcp.sh" <<'EOF'
#!/usr/bin/env bash
echo "STUB $* cwd=$PWD git_dir=${GIT_DIR:-unset} home=$OCBI_HOME req=${OCBI_REQUIRE_PROJECT:-unset}"
EOF
chmod +x "$S/ocbi-mcp.sh"
cp "$H/ocbi-post-checkout.sh" "$S/ocbi-post-checkout.sh"
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
(cd "$W" && GIT_DIR="$R/.git/worktrees/demo-feature" bash "$S/ocbi-post-checkout.sh" old new 1)
key="demo-feature-$(printf '%s' "$W" | cksum | cut -d' ' -f1)"
log="$S/logs/prewarm/$key.log"
if wait_for "$log" '^== exit'; then ok "hook runs a refresh in the background"; else not_ok "hook runs a refresh in the background" "$(cat "$log" 2>/dev/null)"; fi
expect_match "hook calls the launcher's CLI mode from the root without git env" "STUB --cbi index --host claude cwd=$W git_dir=unset home=$S req=\\*" "$(cat "$log" 2>/dev/null)"
(cd "$W" && bash "$S/ocbi-post-checkout.sh" old new 0)
sleep 0.3
expect_eq "hook skips file checkouts" 1 "$(grep -c '^STUB' "$log")"
(cd "$W" && OCBI_PREWARM=0 bash "$S/ocbi-post-checkout.sh" old new 1)
(cd "$W" && GIT_REFLOG_ACTION="rebase (pick)" bash "$S/ocbi-post-checkout.sh" old new 1)
sleep 0.3
expect_eq "hook honours OCBI_PREWARM=0 and skips rebases" 1 "$(grep -c '^STUB' "$log")"
# Real checkouts through git run the hook, registered either way install.sh prints.
# wait_unlocked [STATE_HOME]: until the prewarm lock of this worktree under STATE_HOME (default
# $S) is released; fails after 30 s.
wait_unlocked() {
  local lock="${1:-$S}/logs/prewarm/$key.lock" i=0
  while [ -d "$lock" ]; do
    [ "$i" -lt 300 ] || { not_ok "prewarm lock $lock released within 30 s"; return 1; }
    sleep 0.1
    i=$((i + 1))
  done
}
wait_unlocked
git init -q "$T/probe"
git -C "$T/probe" config hook.probe.event post-checkout
git -C "$T/probe" config hook.probe.command "touch '$T/probe-ran'"
git -C "$T/probe" hook run post-checkout -- a b 1 >/dev/null 2>&1
if [ -e "$T/probe-ran" ]; then
  git -C "$W" config --local hook.ocbi-prewarm.event post-checkout
  git -C "$W" config --local hook.ocbi-prewarm.command "$S/ocbi-post-checkout.sh"
  git -C "$W" checkout -q -b feature2
  if wait_for "$log" " feature2 "; then ok "git runs the config-registered hook"; else
    not_ok "git runs the config-registered hook" "$(cat "$log")"; fi
  git -C "$W" config --local --unset hook.ocbi-prewarm.event
  git -C "$W" config --local --unset hook.ocbi-prewarm.command
  wait_unlocked
else
  skip "git runs the config-registered hook" "$(git version) has no config-based hooks"
fi
ln -s "$S/ocbi-post-checkout.sh" "$R/.git/hooks/post-checkout"
git -C "$W" checkout -q -b feature3
if wait_for "$log" " feature3 "; then ok "git runs the hook linked into the common hooks dir"; else
  not_ok "git runs the hook linked into the common hooks dir" "$(cat "$log")"; fi
rm -f "$R/.git/hooks/post-checkout"
wait_unlocked
# The registration commands install.sh prints work as printed, also from a home with a space.
SP="$T/sp ace/ocbi"
reg="$(bash "$here/install.sh" --pieces hook --home "$SP" 2>&1 | grep -E 'hook\.ocbi-prewarm\.|ln -s ')"
cp "$S/ocbi-mcp.sh" "$SP/ocbi-mcp.sh"
splog="$SP/logs/prewarm/$key.log"
if [ -e "$T/probe-ran" ]; then
  while IFS= read -r cmd; do eval "${cmd//<repo>/\"\$W\"}"; done < <(printf '%s\n' "$reg" | grep 'git -C <repo> config')
  git -C "$W" checkout -q -b feature4
  if wait_for "$splog" " feature4 "; then ok "the printed config registration runs the hook from a spaced home"; else
    not_ok "the printed config registration runs the hook from a spaced home" "$reg
$(cat "$splog" 2>/dev/null)"; fi
  git -C "$W" config --local --unset hook.ocbi-prewarm.event
  git -C "$W" config --local --unset hook.ocbi-prewarm.command
  wait_unlocked "$SP"
else
  skip "the printed config registration runs the hook from a spaced home" "no config-based hooks"
fi
eval "$(printf '%s\n' "$reg" | grep 'ln -s ' | sed 's/<repo>/"$W"/g')"
git -C "$W" checkout -q -b feature5
if wait_for "$splog" " feature5 "; then ok "the printed symlink registration runs the hook from a spaced home"; else
  not_ok "the printed symlink registration runs the hook from a spaced home" "$reg
$(cat "$splog" 2>/dev/null)"; fi
rm -f "$R/.git/hooks/post-checkout"
wait_unlocked "$SP"

# --- rebuild -------------------------------------------------------------------------------------
bash "$HOME/.local/bin/ocbi-rebuild" nosuch >/dev/null 2>&1
expect_eq "ocbi-rebuild rejects an unlisted project" 64 "$?"
bash "$H/ocbi-rebuild.sh" >/dev/null 2>&1
expect_eq "ocbi-rebuild.sh needs a project" 64 "$?"
RB="$T/rebuildhome"
mkdir -p "$RB"
cp "$H/ocbi-rebuild.sh" "$RB/"
printf 'demo|%s\n' "$R/.git" >"$RB/projects.conf"
cat >"$RB/ocbi-mcp.sh" <<'EOF'
#!/usr/bin/env bash
echo "STUB $* cwd=$PWD req=$OCBI_REQUIRE_PROJECT" >>"$OCBI_HOME/calls"
EOF
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" demo
expect_eq "rebuild exits 0" 0 "$?"
expect_eq "rebuild forces the primary, then indexes each other worktree" \
  "STUB --cbi index --force --allow-shared-rebuild --host claude --project $R cwd=$R req=demo
STUB --cbi index --host claude --project $W cwd=$W req=demo" "$(cat "$RB/calls" 2>/dev/null)"
# Another process holding the flock keeps a rebuild out; once it is gone the lock is free.
: >"$RB/calls"
perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $m, ">", $ARGV[1]); print $m "held\n"; close $m; sleep 3' \
  "$RB/rebuild.flock" "$T/held" &
holder=$!
wait_for "$T/held" held
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" demo
expect_eq "rebuild exits 0 while another run holds the lock" 0 "$?"
check "rebuild did nothing while another one runs" test ! -s "$RB/calls"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" demo
check "rebuild runs once the holder is gone" test -s "$RB/calls"
# Two rebuilds started together: exactly one runs.
cat >"$RB/ocbi-mcp.sh" <<'EOF'
#!/usr/bin/env bash
echo "STUB $* cwd=$PWD req=$OCBI_REQUIRE_PROJECT" >>"$OCBI_HOME/calls"
sleep 1
EOF
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" demo & first=$!
OCBI_REBUILD_PREFLIGHT_URL='' bash "$RB/ocbi-rebuild.sh" demo & second=$!
wait "$first"; wait "$second"
expect_eq "concurrent rebuilds: one runs, one exits" 2 "$(grep -c '^STUB' "$RB/calls")"
# A launcher refusing an old package or a store config that allows forced rebuilds fails the
# rebuild at once, with the launcher's reason, instead of retrying.
cat >"$RB/ocbi-mcp.sh" <<'EOF'
#!/usr/bin/env bash
echo "STUB $* cwd=$PWD req=$OCBI_REQUIRE_PROJECT" >>"$OCBI_HOME/calls"
echo "[ocbi-mcp] refusing to start: the package in $OCBI_HOME/pkg predates indexing.allowForceRebuild, which a shared store needs; upgrade it" >&2
exit 1
EOF
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=30 bash "$RB/ocbi-rebuild.sh" demo
expect_eq "rebuild with an old package fails after one attempt" "1 1" "$? $(grep -c '^STUB' "$RB/calls")"
# shellcheck disable=SC2012 # names are rebuild-<timestamp>.log
expect_match "rebuild names the package upgrade" "Nothing was rebuilt: refusing to start: the package in .* predates indexing.allowForceRebuild" "$(cat "$(ls -1t "$RB"/logs/rebuild-*.log | head -n 1)")"
# Ordinary launcher output that mentions allowForceRebuild does not stop the retry of a busy index.
cat >"$RB/ocbi-mcp.sh" <<'EOF'
#!/usr/bin/env bash
echo "STUB $* cwd=$PWD req=$OCBI_REQUIRE_PROJECT" >>"$OCBI_HOME/calls"
echo "[ocbi-mcp] regenerated $OCBI_HOME/allowForceRebuild/profiles/main.json" >&2
if [ "$(grep -c -- '--force' "$OCBI_HOME/calls")" = 1 ]; then echo "INDEX_BUSY" >&2; exit 1; fi
EOF
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=1 bash "$RB/ocbi-rebuild.sh" demo
expect_eq "rebuild retries a busy index despite an allowForceRebuild log line" "0 2" "$? $(grep -c -- '--force' "$RB/calls")"
# A worktree the launcher refuses is not retried after the primary's forced index.
cat >"$RB/ocbi-mcp.sh" <<'EOF'
#!/usr/bin/env bash
echo "STUB $* cwd=$PWD req=$OCBI_REQUIRE_PROJECT" >>"$OCBI_HOME/calls"
case " $* " in *" --force "*) exit 0 ;; esac
echo "[ocbi-mcp] refusing to start: demo: $PWD/.claude is not a directory; a checkout of a listed project runs only on its linked shared store" >&2
exit 1
EOF
: >"$RB/calls"
OCBI_REBUILD_PREFLIGHT_URL='' OCBI_REBUILD_RETRY=30 bash "$RB/ocbi-rebuild.sh" demo >/dev/null 2>&1
expect_eq "rebuild tries a refused worktree once" "1 1" "$(grep -c -- '--force' "$RB/calls") $(grep -c "cwd=$W " "$RB/calls")"
# With the real launcher, a primary that is not linked to the store is never force-indexed.
mkdir -p "$T/src/loose" && git -C "$T/src/loose" init -q -b main && git -C "$T/src/loose" commit -q --allow-empty -m init
printf 'loose|%s\n' "$T/src/loose/.git" >>"$H/projects.conf"
OCBI_REBUILD_PREFLIGHT_URL='' bash "$H/ocbi-rebuild.sh" loose
expect_eq "rebuild of an unlinked primary fails" 1 "$?"
# shellcheck disable=SC2012 # names are rebuild-<timestamp>.log
log_file="$(ls -1t "$H"/logs/rebuild-*.log | head -n 1)"
if grep -q 'CBI index --force' "$log_file"; then not_ok "rebuild of an unlinked primary runs no forced index" "$(cat "$log_file")"; else
  ok "rebuild of an unlinked primary runs no forced index"; fi
expect_match "rebuild names the reason" "Nothing was rebuilt: refusing to start: loose: " "$(cat "$log_file")"
printf 'demo|%s\nbare|%s\n' "$R/.git" "$B" >"$H/projects.conf"

# --- stale check ---------------------------------------------------------------------------------
if command -v sqlite3 >/dev/null 2>&1; then
  mkdir -p "$H/demo/claude-index"
  sqlite3 "$H/demo/claude-index/codebase.db" "create table branch_chunks(branch text); insert into branch_chunks values ('main'),('feature'),('gone1'),('gone2');"
  printf '#!/usr/bin/env bash\nprintf "%%s|" "$@" >>"%s/notified"\n' "$T" >"$H/ocbi-notify.sh"
  (cd "$R" && OCBI_STALE_THRESHOLD=2 bash "$L" --stale-check)
  expect_match "stale check notifies at the threshold" "^Worth a cleanup: demo\\|2 catalogs of deleted branches" "$(cat "$T/notified" 2>/dev/null)"
  rm -f "$T/notified"
  (cd "$R" && OCBI_STALE_THRESHOLD=2 bash "$L" --stale-check)
  check "stale check runs at most once a day" test ! -e "$T/notified"
  cp "$here/notify/ocbi-notify.sh" "$H/ocbi-notify.sh"
else
  skip "stale check" "sqlite3 not on PATH"
fi

printf '# pass %d fail %d\n' "$pass" "$fail"
[ "$fail" = 0 ]
