# Local wrapper: helpers for a machine-local install

`contrib/local-wrapper/` holds the scripts one machine uses around a pinned install of
open-codebase-index. This page explains what they do, which settings they rely on, and how to
migrate from the launcher of earlier versions. [The bundle README](../contrib/local-wrapper/README.md)
covers the pieces, installation and removal.

## What the package does itself

Sharing one index across the worktrees of a repository needs no wrapper. A
[repository config](configuration.md#repository-config-and-shared-store) at
`<git common dir>/codebase-index/config.json` routes every checkout of the repository, bare-base
layouts included, to one store in every host mode, and gives each checkout a role:

- `storage.indexPath` names the shared store (default `<git common dir>/codebase-index/index`).
- `checkouts.primary` and `checkouts.secondary` set `watchFiles` and `autoIndexOnStartup` per role.
  The primary is the main worktree of a normal clone, or `checkouts.primary.path`, which a bare
  clone or a Git directory not named `.git` needs.
- Ordinary sections (`indexing`, `exclude`, embedding settings and so on) apply to every checkout.
- Only the primary can force-clear the store; secondaries index, search, and recover an
  interrupted run, but refuse `force` and clears.

`contrib/local-wrapper/repository-config.example.json` is a starting point. Register the server as
described in [Installation and host setup](installation.md), for example:

```bash
node <install dir>/node_modules/open-codebase-index/dist/cli.js --host claude
```

## What the bundle still does

Everything that linked worktrees to a store under `$OCBI_HOME` and picked their settings is gone:
`projects.conf`, `profiles.conf`, primary confirmation, the bare-clone pin, profile generation and
its lock, `ocbi-mcp.sh` with `--link-only` and `--cbi`, and running Codex with `--host claude`.
What remains has a job the package does not do:

| Piece | Why it is still here |
|---|---|
| `plugin` | A Claude Code plugin that runs the server from `$OCBI_HOME/pkg` with `--host claude`, instead of the repository plugin's `npx` of the registry package. Its `/index` and `/status` commands never request `force` and point at `ocbi-rebuild`. The session-hint hook is gone: the server's MCP instructions carry the same guidance. |
| `hook` | A git `post-checkout` hook that indexes a new branch or worktree in the background, so a secondary checkout (which skips the startup index) is warm before an agent asks. Once a day per repository it also counts the catalogs `ocbi prune` would remove and notifies past a threshold. |
| `rebuild` | `ocbi-rebuild [checkout]`: a full rebuild from the primary, then an incremental index of every other worktree, in a launchd job or systemd user unit that outlives the terminal, waiting out `INDEX_BUSY` and notifying at the start and end. A daily check (`ocbi-check.sh`) notifies when the store needs a full rebuild or a prune; see [Scheduled check](#scheduled-check). |
| `notify` | Desktop notifications for the hook, the check and the rebuild, on macOS and Linux. |
| `pkg` | `npm install` of a pinned package spec into `$OCBI_HOME/pkg`. |

The hook, the rebuild and the plugin run the Node.js that `install.sh` found (or `--node`), with
`dist/cbi.js` or `dist/cli.js` from `$OCBI_HOME/pkg`. `install.sh` installs the package first and
refuses to place these pieces next to a package without the repository config (gd.7) or
`--allow-shared-rebuild` (gd.6). Pick a stable Node.js path: a per-shell path such as fnm's
`fnm_multishells` disappears with the shell, and the installer never picks one itself.

The hook and the rebuild do nothing in a repository without a repository config. Before indexing
they also ask the package (`ocbi status`) which store the checkout uses, and skip it unless that is
the repository's store, so a `global` scope from some config layer never sends them to the global
index. The rebuild forces only in a checkout the package reports as primary. They run the CLI with
`--host claude`; set `OCBI_HOST` to change that.

## Host registration

**Claude Code.** Install the `plugin` piece and enable it:

```bash
claude plugin marketplace add "$HOME/.claude/local-marketplaces/ocbi-local"
claude plugin install codebase-index@ocbi-local
```

The plugin starts `<node> $OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cli.js --host claude`
in the session's directory.

**Codex.** Register the server in `~/.codex/config.toml`; `install.sh` prints this with your paths:

```toml
[mcp_servers.codebase-index]
command = "<node>"
args = ["<OCBI_HOME>/pkg/node_modules/open-codebase-index/dist/cli.js", "--host", "codex"]
startup_timeout_sec = 30.0
tool_timeout_sec = 420.0
```

`tool_timeout_sec` must exceed `indexing.autoIndexWaitMs` (below); Codex's 60 s default is
shorter. `--host codex` reads `~/.config/codebase-index/config.json` as its global config and stops
its file watcher after 15 idle minutes. Keep settings that change index content in the repository
config, so Claude Code and Codex servers index the shared store the same way.

**git.** Register the hook per repository, in the local config on a git with config-based hooks:

```bash
git -C <repo> config --local hook.ocbi-prewarm.event post-checkout
git -C <repo> config --local hook.ocbi-prewarm.command "'<OCBI_HOME>/ocbi-post-checkout.sh'"
```

or, on any git version, by linking it as the repository's `post-checkout` hook in
`<git common dir>/hooks/`. git 2.43 has no config-based hooks; git 2.54 does.

## Migrating from projects.conf

Earlier versions linked `<worktree>/.claude/index` to `$OCBI_HOME/<name>/claude-index` and
`<worktree>/.claude/codebase-index.json` to `$OCBI_HOME/<name>/codebase-index.json` or a generated
profile. For each line `name|<git common dir>` of `$OCBI_HOME/projects.conf`:

1. Write `<git common dir>/codebase-index/config.json`. Copy the settings of
   `$OCBI_HOME/<name>/codebase-index.json`, then add:
   - `"storage": { "indexPath": "<OCBI_HOME>/<name>/claude-index" }`, so the existing store is
     reused and nothing is re-embedded;
   - `"checkouts"` with the role overrides from `repository-config.example.json`, which replace
     `profiles.conf`; for a bare clone, also `"path": "<primary checkout>"` in
     `checkouts.primary`, the checkout its `profiles.conf` line named.

   Servers older than gd.7 ignore this file, so it can be written while they run.
2. Note the time, then upgrade the package and the pieces:
   `install.sh --package <gd.7 or later spec>`. This repoints
   the Claude Code plugin at `dist/cli.js` and removes its session-hint hook. If Claude Code keeps
   starting `ocbi-mcp.sh`, update the `ocbi-local` marketplace and the plugin from `/plugin`.
3. Point the Codex registration at `dist/cli.js --host codex`, as `install.sh` prints it.
4. Restart the agent sessions, so every server comes from the new package.
5. Check the primary and a few other worktrees, with `--host claude` and `--host codex`:
   `<node> <OCBI_HOME>/pkg/node_modules/open-codebase-index/dist/cbi.js status --host <host>`
   prints `Store: <OCBI_HOME>/<name>/claude-index (repository config ...)` and the expected
   checkout role, with no `Warning:` line. The two hosts read different global configs
   (`~/.claude/codebase-index.json` and `~/.config/codebase-index/config.json`); move any setting
   Codex relied on from the former into the repository config.

Leave the old files alone until no pre-gd.7 process remains: the `.claude/index` and
`.claude/codebase-index.json` links in every worktree, `$OCBI_HOME/ocbi-mcp.sh`, `projects.conf`,
`profiles.conf`, and `$OCBI_HOME/<name>/codebase-index.json` with its `profiles/`.

- A pre-gd.7 server reaches the store only through its checkout's `.claude/index` link and its
  settings through `.claude/codebase-index.json`. Removing either under it sends it to an empty
  local index or to the global config.
- A session started before the upgrade keeps its old registration and reconnects through
  `ocbi-mcp.sh`, which keeps linking new worktrees only while `projects.conf` lists the project.
  With the project unlisted, it removes the links it made.
- A gd.7 server reads `.claude/codebase-index.json` as the checkout's project config, above the
  repository config, so until the links go, keep the repository config's settings equal to the
  store config's. A `.claude/index` link to the same store as `storage.indexPath` is harmless; one
  to another store makes status warn that the local index is not used.

The links can go once no server or CLI process started from a pre-gd.7 package remains on the
machine. Every such process started before the upgrade, so compare
`ps -eo pid,lstart,command | grep -E 'open-codebase-index/dist/(cli|cbi)\.js'` with the time noted
in step 2. Restarting every agent session after step 2 gets there. Then:

- in every worktree, remove `.claude/index` and `.claude/codebase-index.json` where they are
  symlinks into `$OCBI_HOME` (`find <worktree>/.claude -maxdepth 1 -type l -lname "<OCBI_HOME>/*"`),
  and optionally their lines in `<git common dir>/info/exclude`;
- once no session uses an old registration either, remove `$OCBI_HOME/ocbi-mcp.sh`,
  `projects.conf`, `profiles.conf`, the `*.example` files, and in each `$OCBI_HOME/<name>/` the
  `codebase-index.json`, `profiles/` and `stale-check.stamp`. Keep `claude-index/`: the
  repository config points at it.
- `$OCBI_HOME/<name>/parked/` holds files the launcher moved out of the way of a link. Each
  `parked/<stamp>/origin` names where its file came from; restore or keep what you still need
  before deleting anything there.

## Settings that matter

- `indexing.autoIndexWaitMs: 360000` in the example. Retrieval waits this long for a refresh that
  another session is running instead of failing at once. The package caps it at 600000. Keep each
  host's tool timeout above it.
- `checkouts.secondary.watchFiles: false`: hundreds of watchers on one store cost more than they
  save. `autoIndexOnStartup: false` for secondaries leaves their first index to the hook or to
  the first retrieval.
- `indexing.allowForceRebuild: false`. The server then refuses `index_codebase` with
  `force: true` in every host with `FORCE_REBUILD_DISABLED`. Only the CLI overrides it, with
  `ocbi index --force --allow-shared-rebuild` from the primary, which is what `ocbi-rebuild` runs.
- `scope: "project"`. With `global` from any layer the server uses the global index instead.
- Tune `exclude` for your repository. Generated code, build output and vendored dependencies cost
  embedding time and push real code out of results.
- `knowledgeBases` entries resolve against each checkout root when relative.
- The index works only with the provider and model it was built with. Changing either means a
  full rebuild.

## Pitfalls

- Never force a rebuild from an agent session on a shared store: it drops every worktree's
  catalog, and re-embedding a large repository can take hours. Use `ocbi-rebuild` from any
  checkout. It forces the index in the primary checkout
  (`checkouts.primary.path`, else the main worktree of a normal clone) and fails at once when the
  package refuses that checkout as secondary. Other failures, such as `INDEX_BUSY`, are retried.
- One process indexes a store at a time (`indexing.lock`). The CLI returns `INDEX_BUSY`; MCP
  retrieval waits up to `autoIndexWaitMs`.
- Each server resolves its store and role once. After editing the repository config, restart the
  servers; `index_status` reports the change until then.
- Nothing restarts a server that dies. Reconnect the MCP server or restart the session.
- Upgrading the package in `$OCBI_HOME/pkg` does not affect running servers; each keeps its
  version until its session restarts.
- A store with hundreds of branch catalogs grows to gigabytes. `ocbi prune` (a dry run unless
  `--apply`) removes catalogs of branches with no worktree; see
  [Human CLI](installation.md#human-cli); with the bundle's install, run it as
  `<node> $OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cbi.js prune`. The hook's daily
  check notifies past `OCBI_STALE_THRESHOLD` (15) when the `notify` piece is installed.
- git exports `GIT_DIR` and related variables to hooks. The hook clears them before it runs the
  CLI, which would otherwise describe the hook's repository view instead of the checkout.

## Scheduled check

`ocbi-check.sh` runs once a day (10:00, or at the next wake or boot after a missed run) for each
checkout listed in `$OCBI_HOME/check.conf`, one repository at a time:

- When `ocbi status --json` reports the store incompatible with the configured embedding provider
  or model, it notifies "Rebuild needed" with a Rebuild action that runs `ocbi-rebuild <checkout>`.
- Otherwise, when `ocbi prune --json` would remove `OCBI_STALE_THRESHOLD` (15) or more catalogs, it
  notifies "Worth a cleanup" with a Prune action that runs `ocbi prune --apply` for that checkout
  and logs to `$OCBI_HOME/logs/prune.log`.

It never rebuilds or prunes by itself, and checks nothing while a rebuild runs. Its log is
`$OCBI_HOME/logs/check.log`. Load the jobs and name the checkouts once:

```bash
ocbi-schedule install ~/src/my-repo     # adds the checkout to check.conf, loads the jobs
ocbi-schedule status                     # jobs, checked checkouts, last check log lines
ocbi-schedule uninstall                  # unloads the jobs and removes their files; keeps check.conf
```

| | macOS | Linux |
|---|---|---|
| Rebuild job | launchd agent `io.github.open-codebase-index.rebuild`, on demand | `ocbi-rebuild.service`, on demand (no `[Install]`) |
| Daily check | launchd agent `io.github.open-codebase-index.check` | `ocbi-check.service` started by `ocbi-check.timer` |
| Job files | `~/Library/LaunchAgents/<label>.plist` | `~/.config/systemd/user/` |
| Notifications | `Codebase Index.app` (build with `notify/notifier/build.sh`) with an action button; `osascript` without one when the app is missing | `notify-send` over the session D-Bus; an action button when the server reports the `actions` capability and notify-send has `--action` (libnotify 0.7.10 or later) |

Before forcing, the rebuild checks that Ollama answers at `$OLLAMA_HOST` (default
`localhost:11434`) when the primary reports the `ollama` provider, and checks nothing for other
providers. The jobs do not inherit your shell's environment: set `OLLAMA_HOST` or
`OCBI_REBUILD_PREFLIGHT_URL` (empty skips the check) with `systemctl --user set-environment` or in
the plist's `EnvironmentVariables`. `ocbi-schedule install` leaves a running rebuild's launchd agent
loaded, and `uninstall` refuses while a rebuild runs.

On Linux, user units run while you are logged in unless lingering is on (`loginctl
enable-linger`). A clicked action runs in a detached waiter (its own transient unit when the
notification comes from a systemd unit). Without `notify-send`, a session bus or a notification
server, as on a headless machine or over SSH, the notification and its command are printed to
stderr, which the journal or `launchd.log` keeps. Every notification is also appended to
`$OCBI_HOME/logs/notify.log`.

## Platforms

The hook, plugin, installer, rebuild, check and notifications run on macOS (bash 3.2, BSD tools)
and Linux (bash 5, GNU tools); `contrib/local-wrapper/test/run-tests.sh` runs on both and covers
the other system's job and notification paths with stand-ins for `launchctl`, `systemctl` and
`notify-send`. On Linux it also runs `systemd-analyze verify` on the units when that is available.
