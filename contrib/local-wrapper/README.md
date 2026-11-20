# Local wrapper

Scripts that run open-codebase-index from one machine-local install and let every git worktree of
a repository share one index. They live outside the package: nothing in `src/` or `native/`
depends on them. For why each piece exists and the settings it relies on, read
[docs/local-wrapper.md](../../docs/local-wrapper.md).

Each piece is self-contained. Install any subset with `install.sh --pieces`, and delete a piece's
directory once the package does its job natively.

| Piece | Files | Installs to | What it does | Platforms |
|---|---|---|---|---|
| `launcher` | `launcher/ocbi-mcp.sh`, `launcher/*.example*` | `$OCBI_HOME` | Links each worktree's `.claude/index` and `.claude/codebase-index.json` to a shared store, picks the primary or worktree profile, then starts the MCP server. Also the session-hint mode the plugin calls. | macOS, Linux |
| `hook` | `hook/ocbi-post-checkout.sh` | `$OCBI_HOME` | git `post-checkout` hook: refreshes the shared index in the background after a branch checkout or `git worktree add`. | macOS, Linux |
| `plugin` | `claude-plugin/` (copies of the repository's commands and skill; `index.md` and `status.md` differ) | local marketplace dir | Claude Code plugin that starts the launcher and wires the session-hint hook; a Codex skill plugin in the same marketplace. | macOS, Linux |
| `rebuild` | `rebuild/ocbi-rebuild.sh`, `rebuild/ocbi-rebuild`, `rebuild/rebuild.plist.template` | `$OCBI_HOME`, bin dir, `~/Library/LaunchAgents` | `ocbi-rebuild <project>`: full rebuild of a shared store in the background, through an on-demand launchd job. | macOS; Linux support is planned |
| `notify` | `notify/ocbi-notify.sh`, `notify/notifier/` (Swift source) | `$OCBI_HOME` | Desktop notifications for the stale-catalog check and the rebuild, with an action button when the notifier app is built. | macOS; Linux support is planned |
| `pkg` | none | `$OCBI_HOME/pkg` | `npm install` of the package spec you pass with `--package`. | macOS, Linux |

`rebuild` and `notify` already fall back to `nohup` and `notify-send` off macOS, but only the
macOS path is in daily use. Full Linux support for both is planned as a later step.

## Requirements

bash 3.2 or newer, git 2.31 or newer, perl, Node.js 22 or newer, and an embedding provider for the
index (the example config uses Ollama). `sqlite3` is needed only for the stale-catalog check, and
the Xcode command line tools only to build the macOS notifier.

## Install

```bash
contrib/local-wrapper/install.sh --dry-run                       # see what would change
contrib/local-wrapper/install.sh --package <release tarball URL>  # all pieces plus the package
contrib/local-wrapper/install.sh --pieces launcher,hook          # a subset
```

`OCBI_HOME` defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/ocbi`; `--home`, `--bin-dir`,
`--marketplace-dir`, `--launch-agents-dir` and `--label` override the destinations. Reruns are
idempotent. The installer never writes `projects.conf`, `profiles.conf` or a project's store
config; it installs `*.example` files next to them. It never registers anything with Claude Code,
Codex, git or launchd either: it prints those commands for you to run. `install.sh --help` lists
every option.

The installed scripts find `OCBI_HOME` from their own location, so they need no environment
variables. Setting `OCBI_HOME` overrides that.

## Configure a shared store

For a repository at `~/src/myproject` (a normal clone, git common dir `~/src/myproject/.git`):

```bash
H="${XDG_DATA_HOME:-$HOME/.local/share}/ocbi"
echo "myproject|$HOME/src/myproject/.git" >>"$H/projects.conf"
mkdir -p "$H/myproject"
cp "$H/codebase-index.example.json" "$H/myproject/codebase-index.json"   # keep "scope" and allowForceRebuild; edit exclude
printf '.claude/index\n.claude/codebase-index.json\n' >>"$HOME/src/myproject/.git/info/exclude"
echo "myproject|$HOME/src/myproject" >>"$H/profiles.conf"                 # optional: primary checkout
(cd ~/src/myproject && "$H/ocbi-mcp.sh" --link-only)                     # check the links
```

A bare clone needs its primary's git dir pinned in `profiles.conf`; see `profiles.conf.example`.

## Test

```bash
bash contrib/local-wrapper/test/run-tests.sh
```

It installs into a temporary `HOME`, stubs the server and CLI, and needs no index, embedding
provider or network. Shellcheck runs when it is on `PATH`; `OCBI_WRAPPER_REQUIRE_SHELLCHECK=1`
makes its absence a failure.

## Remove a piece

Delete the installed files listed in the table, then the piece's directory here, its
`install_<piece>` function and `--pieces` entry in `install.sh`, and its section in
`test/run-tests.sh`. The launcher is the only piece others call: `hook` and `rebuild` run
`ocbi-mcp.sh --cbi` with `OCBI_REQUIRE_PROJECT` set, which makes the launcher refuse (exit 3, or
exit 1 with `refusing to start:` for a listed checkout it cannot link) unless the checkout is
linked to that project's shared store, and the plugin starts
`ocbi-mcp.sh`. Point them at the package's `cbi` and MCP binaries, with an equivalent check,
before removing it.
