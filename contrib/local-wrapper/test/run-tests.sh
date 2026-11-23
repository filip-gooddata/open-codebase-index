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

NODE="$(command -v node)"
export OCBI_NODE="$NODE"

# --- static checks -------------------------------------------------------------------------------
scripts=("$here/install.sh" "$here/hook/ocbi-post-checkout.sh"
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
bash "$here/install.sh" --pieces pkg >/dev/null 2>&1
expect_eq "install rejects pkg without --package" 2 "$?"
bash "$here/install.sh" --node "$T/no-node" >/dev/null 2>&1
expect_eq "install rejects a --node that is not Node.js" 2 "$?"

out="$(bash "$here/install.sh" --dry-run "${install_args[@]}" 2>&1)"
expect_eq "dry run exits 0" 0 "$?"
expect_match "dry run lists planned files" "would create +$H/ocbi-post-checkout.sh" "$out"
if [ -z "$(find "$HOME" -mindepth 1 -not -name . 2>/dev/null)" ]; then ok "dry run writes nothing"; else
  not_ok "dry run writes nothing" "$(find "$HOME" -mindepth 1)"; fi
out="$(bash "$here/install.sh" --dry-run --package ./x.tgz "${install_args[@]}" 2>&1)"
expect_match "dry run prints the npm install of --package" "would run: npm install --prefix $H/pkg" "$out"

# An earlier version's files in OCBI_HOME stay.
mkdir -p "$H"
printf '#!/bin/sh\n' >"$H/ocbi-mcp.sh"
printf '# mine\n' >"$H/projects.conf"
out="$(bash "$here/install.sh" "${install_args[@]}" 2>&1)"
expect_eq "install exits 0" 0 "$?"
for f in ocbi-post-checkout.sh ocbi-rebuild.sh ocbi-notify.sh; do
  check "installed executable $f" test -x "$H/$f"
done
check "installed ocbi-rebuild into the bin dir" test -x "$HOME/.local/bin/ocbi-rebuild"
check "installed open-codebase-index-mcp into the bin dir" test -x "$HOME/.local/bin/open-codebase-index-mcp"
check "open-codebase-index-mcp runs the package with the chosen node" grep -qF "exec \"$NODE\" \"$H/pkg/node_modules/open-codebase-index/dist/cli.js\" \"\$@\"" "$HOME/.local/bin/open-codebase-index-mcp"
expect_eq "install leaves an earlier version's launcher and projects.conf alone" "#!/bin/sh # mine" "$(cat "$H/ocbi-mcp.sh") $(cat "$H/projects.conf")"
rm -f "$H/ocbi-mcp.sh" "$H/projects.conf"
if grep -rq '@[A-Z_]*@' "$HOME/.local/bin" "$H"; then not_ok "no template placeholders left" "$(grep -rl '@[A-Z_]*@' "$HOME/.local/bin" "$H")"; else ok "no template placeholders left"; fi
check "install places no plugin marketplace" test ! -e "$HOME/.claude"
expect_match "install prints the repository marketplace for Claude Code" "claude plugin install codebase-index@open-codebase-index" "$out"
if [ "$(uname -s)" = Darwin ]; then
  plist="$HOME/Library/LaunchAgents/io.github.open-codebase-index.rebuild.plist"
  check "installed the launchd plist" grep -q "<string>$H/ocbi-rebuild.sh</string>" "$plist"
  if command -v plutil >/dev/null 2>&1; then check "plist is valid" plutil -lint -s "$plist"; fi
else
  check "no launchd plist off macOS" test ! -e "$HOME/Library/LaunchAgents"
fi
expect_match "install prints the Codex registration with --host codex" "args = \\[\"$H/pkg/node_modules/open-codebase-index/dist/cli.js\", \"--host\", \"codex\"\\]" "$out"
expect_match "install prints the Codex command as the chosen node" "command = \"$NODE\"" "$out"
expect_match "install prints the git hook registration" "hook.ocbi-prewarm.command \"'$H/ocbi-post-checkout.sh'\"" "$out"
out="$(bash "$here/install.sh" "${install_args[@]}" 2>&1)"
expect_match "second install changes nothing" "^0 change\\(s\\)\\." "$out"
chmod -x "$H/ocbi-post-checkout.sh"
bash "$here/install.sh" "${install_args[@]}" >/dev/null 2>&1
check "reinstall restores the hook's executable bit" test -x "$H/ocbi-post-checkout.sh"
BO="$T/bundle-only"
mkdir -p "$BO" && cp -R "$here" "$BO/local-wrapper"
bash "$BO/local-wrapper/install.sh" --home "$BO/home" --bin-dir "$BO/bin" --launch-agents-dir "$BO/la" >/dev/null 2>&1
expect_eq "install works from the bundle alone" 0 "$?"
check "bundle-only install has the hook" test -x "$BO/home/ocbi-post-checkout.sh"
mkdir -p "$BO/home/pkg/node_modules/open-codebase-index/dist"
printf 'console.log(process.argv.slice(2).join(" "));\n' >"$BO/home/pkg/node_modules/open-codebase-index/dist/cli.js"
expect_eq "open-codebase-index-mcp passes its arguments to the package's cli.js" "--host claude" "$(env PATH=/usr/bin:/bin "$BO/bin/open-codebase-index-mcp" --host claude)"
bash "$here/install.sh" --home "$T/a&b" >/dev/null 2>&1
expect_eq "install rejects a path with &" "2 absent" "$? $([ -e "$T/a&b" ] && echo present || echo absent)"
P2="$T/preflight"
mkdir -p "$P2/ocbi-post-checkout.sh"
bash "$here/install.sh" --pieces hook,rebuild --home "$P2" --bin-dir "$P2/bin" "${install_args[@]}" >/dev/null 2>&1
expect_eq "install refuses a directory at a destination and writes nothing" "2 absent" "$? $([ -e "$P2/ocbi-rebuild.sh" ] || [ -e "$P2/bin" ] && echo present || echo absent)"

# --- stub CLI ------------------------------------------------------------------------------------
# stub_cbi HOME [JS]: a dist/cbi.js under HOME/pkg that appends to HOME/calls, and prints unless
# it is a prune,
#   CBI <args> cwd=<cwd> git_dir=<GIT_DIR or unset>
# then runs JS, which sees argv (the arguments), calls (the calls file so far) and sleep(ms). It
# answers `prune --json` with HOME/prune-count catalogs and `status --project P` with
# HOME/status-<basename P>, else HOME/status (default: a primary on the repository store). It carries the markers install.sh probes for.
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
if (argv[0] !== "prune") process.stdout.write(line);
const calls = fs.readFileSync(path.join(home, "calls"), "utf8");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (argv[0] === "prune") {
  let n = 0;
  try { n = Number(fs.readFileSync(path.join(home, "prune-count"), "utf8")); } catch {}
  console.log(JSON.stringify({ applied: false, catalogs: Array.from({ length: n }, (_, i) => ({ key: "gone" + i })) }));
}
if (argv[0] === "status") {
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
bash "$here/install.sh" --pieces hook,rebuild --home "$OP" --bin-dir "$OP/bin" "${install_args[@]}" >"$T/oldpkg.out" 2>&1
expect_eq "install refuses a pre-gd.7 package and places nothing" "2 absent" "$? $([ -e "$OP/ocbi-post-checkout.sh" ] || [ -e "$OP/bin" ] && echo present || echo absent)"
expect_match "install names the package upgrade" "predates the repository config" "$(cat "$T/oldpkg.out")"
rm -f "$OP/pkg/node_modules/open-codebase-index/dist/cbi.js"
bash "$here/install.sh" --pieces hook,rebuild --home "$OP" --bin-dir "$OP/bin" "${install_args[@]}" >"$T/oldpkg.out" 2>&1
expect_eq "install refuses a package without dist/cbi.js and places nothing" "2 absent" "$? $([ -e "$OP/ocbi-post-checkout.sh" ] || [ -e "$OP/bin" ] && echo present || echo absent)"
stub_cbi "$OP"
bash "$here/install.sh" --pieces hook --home "$OP" >/dev/null 2>&1
expect_eq "install accepts a package with both markers" "0 present" "$? $([ -x "$OP/ocbi-post-checkout.sh" ] && echo present || echo absent)"

# --- repositories --------------------------------------------------------------------------------
R="$T/src/demo"
mkdir -p "$R"
git -C "$R" init -q -b main
echo hi >"$R/a.txt"
git -C "$R" add a.txt && git -C "$R" commit -qm init
git -C "$R" worktree add -q "$T/src/demo-feature" -b feature
W="$T/src/demo-feature"

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

# --- post-checkout hook --------------------------------------------------------------------------
S="$T/stubhome"
mkdir -p "$S"
stub_cbi "$S"
cp "$H/ocbi-post-checkout.sh" "$S/ocbi-post-checkout.sh"
key="demo-feature-$(printf '%s' "$W" | cksum | cut -d' ' -f1)"
log="$S/logs/prewarm/$key.log"
(cd "$W" && bash "$S/ocbi-post-checkout.sh" old new 1)
sleep 0.3
expect_match "without a repository config the hook only logs" "skipped: no repository config $R/.git/codebase-index/config.json" "$(cat "$log" 2>/dev/null)"
check "without a repository config the hook runs no CLI" test ! -e "$S/calls"
mkdir -p "$R/.git/codebase-index"
printf '{}\n' >"$R/.git/codebase-index/config.json"
(cd "$W" && GIT_DIR="$R/.git/worktrees/demo-feature" bash "$S/ocbi-post-checkout.sh" old new 1)
if wait_for "$log" '^== exit'; then ok "hook runs a refresh in the background"; else not_ok "hook runs a refresh in the background" "$(cat "$log" 2>/dev/null)"; fi
expect_match "hook indexes the checkout root with the claude host and no git env" "^CBI index --host claude --project $W cwd=$W git_dir=unset" "$(cat "$log" 2>/dev/null)"
(cd "$W" && bash "$S/ocbi-post-checkout.sh" old new 0)
sleep 0.3
expect_eq "hook skips file checkouts" 1 "$(grep -c '^CBI index' "$log")"
(cd "$W" && OCBI_PREWARM=0 bash "$S/ocbi-post-checkout.sh" old new 1)
(cd "$W" && GIT_REFLOG_ACTION="rebase (pick)" bash "$S/ocbi-post-checkout.sh" old new 1)
sleep 0.3
expect_eq "hook honours OCBI_PREWARM=0 and skips rebases" 1 "$(grep -c '^CBI index' "$log")"
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
(cd "$W" && OCBI_HOST=codex bash "$S/ocbi-post-checkout.sh" old new 1)
if wait_for "$log" '^CBI index --host codex'; then ok "hook honours OCBI_HOST"; else not_ok "hook honours OCBI_HOST" "$(cat "$log")"; fi
wait_unlocked
printf 'Store: /g/global-index (global scope)\n' >"$S/status"
before="$(grep -c '^CBI index' "$log")"
(cd "$W" && bash "$S/ocbi-post-checkout.sh" old new 1)
wait_unlocked
expect_eq "hook indexes nothing when the package reports another store" "$before" "$(grep -c '^CBI index' "$log")"
expect_match "hook logs why it skipped" "skipped: not the repository's shared store \\(Store: .* \\(global scope\\)\\)" "$(cat "$log")"
rm -f "$S/status"
# The stale-catalog check: notifies at the threshold, at most once a day per repository.
printf '#!/usr/bin/env bash\nprintf "%%s|" "$@" >>"%s/notified"\n' "$T" >"$S/ocbi-notify.sh"
chmod +x "$S/ocbi-notify.sh"
printf '2\n' >"$S/prune-count"
(cd "$W" && OCBI_STALE_CHECK=1 OCBI_STALE_THRESHOLD=2 bash "$S/ocbi-post-checkout.sh" old new 1)
wait_unlocked
expect_match "stale check runs a dry-run prune of the checkout" "^CBI prune --json --host claude --project $W " "$(cat "$S/calls")"
expect_match "stale check notifies at the threshold" "^Worth a cleanup: demo\\|2 catalogs of deleted branches or worktrees\\. Run: $NODE $S/pkg/node_modules/open-codebase-index/dist/cbi.js prune --apply --host claude --project $W\\|$" "$(cat "$T/notified" 2>/dev/null)"
notified="$(cat "$T/notified" 2>/dev/null)"
notified="${notified#*Run: }"
eval "set -- ${notified%|}"
expect_eq "the notified prune command keeps host and project as separate shell words" "8 --host claude --project $W" "$# $5 $6 $7 $8"
rm -f "$T/notified"
(cd "$W" && OCBI_STALE_CHECK=1 OCBI_STALE_THRESHOLD=2 bash "$S/ocbi-post-checkout.sh" old new 1)
wait_unlocked
check "stale check runs at most once a day" test ! -e "$T/notified"
rm -f "$S"/logs/prewarm/*.stale-check
printf '1\n' >"$S/prune-count"
(cd "$W" && OCBI_STALE_CHECK=1 OCBI_STALE_THRESHOLD=2 bash "$S/ocbi-post-checkout.sh" old new 1)
wait_unlocked
check "stale check stays quiet below the threshold" test ! -e "$T/notified"
rm -f "$S/ocbi-notify.sh" "$S/prune-count"
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
stub_cbi "$SP"
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
expect_match "the spaced-home hook indexes through its own package" "^CBI index --host claude --project $W " "$(cat "$splog" 2>/dev/null)"
rm -f "$R/.git/hooks/post-checkout"
wait_unlocked "$SP"

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

printf '# pass %d fail %d\n' "$pass" "$fail"
[ "$fail" = 0 ]
