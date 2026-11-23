# Local wrapper

Scripts around a machine-local install of open-codebase-index. They live outside the package:
nothing in `src/` or `native/` depends on them. Sharing one index across the worktrees of a
repository is the package's job now, through a
[repository config](../../docs/configuration.md#repository-config-and-shared-store); these pieces
add a pinned Claude Code plugin, a detached full rebuild and notifications. Background indexing
after checkouts ships in the package (`ocbi hooks install`). For why each piece exists, the settings it relies on and the migration from the
`projects.conf` launcher of earlier versions, read [docs/local-wrapper.md](../../docs/local-wrapper.md).

Each piece is self-contained. Install any subset with `install.sh --pieces`, and delete a piece's
directory once the package does its job natively.

| Piece | Files | Installs to | What it does | Platforms |
|---|---|---|---|---|
| `plugin` | `claude-plugin/` (copies of the repository's commands and skill; `index.md` and `status.md` differ) | local marketplace dir | Claude Code plugin that starts `dist/cli.js --host claude` from `$OCBI_HOME/pkg`; a Codex skill plugin in the same marketplace. | macOS, Linux |
| `rebuild` | `rebuild/ocbi-rebuild.sh`, `rebuild/ocbi-rebuild`, `rebuild/rebuild.plist.template` | `$OCBI_HOME`, bin dir, `~/Library/LaunchAgents` | `ocbi-rebuild [checkout]`: full rebuild of a repository's shared store from its primary checkout, in the background, through an on-demand launchd job. | macOS; Linux support is planned |
| `notify` | `notify/ocbi-notify.sh`, `notify/notifier/` (Swift source) | `$OCBI_HOME` | Desktop notifications for the stale-catalog check and the rebuild, with an action button when the notifier app is built. | macOS; Linux support is planned |
| `pkg` | none | `$OCBI_HOME/pkg` | `npm install` of the package spec you pass with `--package`. | macOS, Linux |

`repository-config.example.json` is a starting point for `<git common dir>/codebase-index/config.json`;
nothing installs it.

`rebuild` and `notify` already fall back to `nohup` and `notify-send` off macOS, but only the
macOS path is in daily use. Full Linux support for both is planned as a later step.

## Requirements

bash 3.2 or newer, git 2.31 or newer, perl, Node.js 22 or newer, and an embedding provider for the
index (the example config uses Ollama). The Xcode command line tools are needed only to build the
macOS notifier.

## Install

```bash
contrib/local-wrapper/install.sh --dry-run                       # see what would change
contrib/local-wrapper/install.sh --package <release tarball URL>  # all pieces plus the package
contrib/local-wrapper/install.sh --pieces plugin,rebuild         # a subset
```

`OCBI_HOME` defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/ocbi`; `--home`, `--bin-dir`,
`--marketplace-dir`, `--launch-agents-dir`, `--label` and `--node` override the destinations and
the Node.js the pieces run. The package is installed first, and the plugin and rebuild are
placed only next to a package with the repository config (gd.7) and `--allow-shared-rebuild`
(gd.6). Reruns are idempotent. The installer never writes a repository config,
and never registers anything with Claude Code, Codex, git or launchd: it prints those commands for
you to run. It removes only the plugin's session-hint hook of earlier versions; their other files
in `$OCBI_HOME` stay until you remove them as the migration describes. `install.sh --help` lists
every option.

`ocbi-rebuild.sh` finds `OCBI_HOME` from their own location, so it needs no
environment variables. Setting `OCBI_HOME` overrides that, and `OCBI_NODE` overrides the Node.js
chosen at install time.

## Configure a repository

For a repository at `~/src/myproject` (a normal clone, git common dir `~/src/myproject/.git`):

```bash
mkdir -p ~/src/myproject/.git/codebase-index
cp contrib/local-wrapper/repository-config.example.json ~/src/myproject/.git/codebase-index/config.json   # edit exclude
node ~/.local/share/ocbi/pkg/node_modules/open-codebase-index/dist/cbi.js hooks install \
  --repo ~/src/myproject --host claude --stale-notify ~/.local/share/ocbi/ocbi-notify.sh   # optional
```

The hook refreshes a checkout's index in the background after each branch checkout; see
[Git post-checkout hook](../../docs/configuration.md#git-post-checkout-hook).

A bare clone also needs `checkouts.primary.path` in that file.

## Test

```bash
bash contrib/local-wrapper/test/run-tests.sh
```

It installs into a temporary `HOME`, stubs the package CLI, and needs no index, embedding provider
or network. Shellcheck runs when it is on `PATH`; `OCBI_WRAPPER_REQUIRE_SHELLCHECK=1` makes its
absence a failure.

## Remove a piece

Delete the installed files listed in the table, then the piece's directory here, its
`install_<piece>` function and `--pieces` entry in `install.sh`, and its section in
`test/run-tests.sh`. No piece calls another except through `ocbi-notify.sh`, which the rebuild skips
when it is not installed.
