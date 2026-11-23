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
| `rebuild` | `ocbi-rebuild [checkout]`: a full rebuild from the primary, then an incremental index of every other worktree, in a launchd job that outlives the terminal, waiting out `INDEX_BUSY` and notifying at the start and end. |
| `notify` | Desktop notifications for the hook and the rebuild. |
| `pkg` | `npm install` of a pinned package spec into `$OCBI_HOME/pkg`. |

The hook, the rebuild and the plugin run the Node.js that `install.sh` found (or `--node`), with
`dist/cbi.js` or `dist/cli.js` from `$OCBI_HOME/pkg`. The hook and the rebuild do nothing in a
repository without a repository config, so they never build a checkout-local index. They run the
CLI with `--host claude`; set `OCBI_HOST` to change that.

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
     `profiles.conf`;
   - for a bare clone, `"checkouts": { "primary": { "path": "<primary checkout>" } }`, the checkout
     its `profiles.conf` line named.

   Servers older than gd.7 ignore this file, so it can be written while they run.
2. Upgrade the package and the pieces: `install.sh --package <gd.7 or later spec>`. This repoints
   the Claude Code plugin at `dist/cli.js` and removes its session-hint hook. If Claude Code keeps
   starting `ocbi-mcp.sh`, update the `ocbi-local` marketplace and the plugin from `/plugin`.
3. Point the Codex registration at `dist/cli.js --host codex`, as `install.sh` prints it.
4. Restart the agent sessions, so every server comes from the new package.
5. Check from a few worktrees: `<node> <OCBI_HOME>/pkg/node_modules/open-codebase-index/dist/cbi.js status --host claude`
   prints `Store: <OCBI_HOME>/<name>/claude-index (repository config ...)` and the checkout's role,
   with no `Warning:` line.

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
`ps -eo pid,lstart,command | grep -E 'open-codebase-index/dist/(cli|cbi)\.js'` with the time of
step 2 (the modification time of `$OCBI_HOME/pkg/node_modules/open-codebase-index/package.json`).
Restarting every agent session after step 2 gets there. Then:

- in every worktree, remove `.claude/index` and `.claude/codebase-index.json` where they are
  symlinks into `$OCBI_HOME` (`find <worktree>/.claude -maxdepth 1 -type l -lname "<OCBI_HOME>/*"`),
  and optionally their lines in `<git common dir>/info/exclude`;
- remove `$OCBI_HOME/ocbi-mcp.sh`, `projects.conf`, `profiles.conf`, the `*.example` files, and in
  each `$OCBI_HOME/<name>/` the `codebase-index.json`, `profiles/`, `parked/` and
  `stale-check.stamp`. Keep `claude-index/`: the repository config points at it.

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
  catalog, and re-embedding a large repository can take hours. Use `ocbi-rebuild` (macOS today;
  Linux support is planned) from any checkout. It forces the index in the primary checkout
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
  [Human CLI](installation.md#human-cli). The hook's daily check notifies past
  `OCBI_STALE_THRESHOLD` (15) when the `notify` piece is installed.
- git exports `GIT_DIR` and related variables to hooks. The hook clears them before it runs the
  CLI, which would otherwise describe the hook's repository view instead of the checkout.

## Platforms

The hook, plugin and installer run on macOS (bash 3.2, BSD tools) and Linux (bash 5, GNU tools);
`contrib/local-wrapper/test/run-tests.sh` runs on both. The `rebuild` and `notify` pieces are
macOS-only for now: the rebuild uses a launchd job, and notifications with an action button use a
small Swift app built from source. Linux support for both is planned.
