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
What remains has a job the package does not do. The Claude Code and Codex plugin is not part of
the bundle. Install the server first, here with `install.sh --package <release tarball>` and the
`mcp` piece below, then the plugin from the repository's marketplace. The plugin starts the
`ocbi-mcp` on `PATH` and falls back to `npx` of its release tarball only when there
is none ([the plugin server](installation.md#server-for-the-claude-code-and-codex-plugins)).

| Piece | Why it is still here |
|---|---|
| `rebuild` | `ocbi-rebuild [checkout]`: a full rebuild from the primary, then an incremental index of every other worktree, in a launchd job that outlives the terminal, waiting out `INDEX_BUSY` and notifying at the start and end. |
| `notify` | Desktop notifications for the rebuild and, through `ocbi hooks install --stale-notify`, the post-checkout hook's daily stale-catalog check. |
| `mcp` | `ocbi-mcp` in the bin dir, running `$OCBI_HOME/pkg` with the Node.js `install.sh` found. The Claude Code and Codex plugins start the first `ocbi-mcp` on `PATH`, so this gives them the pinned package, with no `npx` download and no network. It is placed only in front of an installed package that reports plugin version skew (0.38.2-gd.9 or later); otherwise the installer says why it skipped it and leaves the bin dir alone. |
| `pkg` | `npm install` of a pinned package spec into `$OCBI_HOME/pkg`. |

`ocbi-mcp` and the rebuild run the Node.js that `install.sh` found (or `--node`), with
`dist/cbi.js` or `dist/cli.js` from `$OCBI_HOME/pkg`. `install.sh` installs the package first and
refuses to place these pieces next to a package without the repository config (gd.7) or
`--allow-shared-rebuild` (gd.6). Pick a stable Node.js path: a per-shell path such as fnm's
`fnm_multishells` disappears with the shell, and the installer never picks one itself.

The rebuild does nothing in a repository without a repository config. Before indexing it also
asks the package (`ocbi status`) which store the checkout uses, and skips it unless that is the
repository's store, so a `global` scope from some config layer never sends it to the global index.
It forces only in a checkout the package reports as primary. It runs the CLI with `--host claude`;
set `OCBI_HOST` to change that.

The post-checkout hook of earlier versions (`hook/ocbi-post-checkout.sh`) is gone: the package
ships it as `ocbi hook post-checkout` with `ocbi hooks install`; see
[Git post-checkout hook](configuration.md#git-post-checkout-hook).

## Host registration

**Claude Code.** With the package and the `mcp` piece installed, install the plugin from the
repository marketplace:

```bash
claude plugin marketplace add filip-gooddata/open-codebase-index
claude plugin install codebase-index@open-codebase-index
```

The plugin starts the first `ocbi-mcp` on the host's `PATH` with `--host claude` in
the session's directory, and falls back to `npx` of its release tarball only when there is none.
With the `mcp` piece that is `<bin dir>/ocbi-mcp`, which runs `$OCBI_HOME/pkg` with
a fixed Node.js; keep the bin dir on the `PATH` the host starts with. Install the package at the
plugin's version (`install.sh --package <release tarball>`); `index_status` warns when they differ.

**Codex.** Install the plugin the same way (`codex plugin marketplace add`, see
[Installation and host setup](installation.md#codex)), or register the server in
`~/.codex/config.toml`; `install.sh` prints this entry with your paths:

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

**git.** Install the package's post-checkout hook per repository; `install.sh` prints this with
your paths:

```bash
<node> <OCBI_HOME>/pkg/node_modules/open-codebase-index/dist/cbi.js hooks install --repo <repo> \
  --host claude --stale-notify <OCBI_HOME>/ocbi-notify.sh
```

`--stale-notify` hands the hook's daily stale-catalog count to the `notify` piece; leave it out to
only log the count. Upgrading the package in `$OCBI_HOME/pkg` keeps the hook working, since its
command names that unversioned path.

### Replacing the shell hook

Earlier versions registered `<OCBI_HOME>/ocbi-post-checkout.sh` as `hook.ocbi-prewarm` (or linked
it as `<git common dir>/hooks/post-checkout`). Per repository:

1. Save the old registration: `git -C <repo> config --local --get-regexp '^hook\.' > hooks-backup.txt`.
2. Remove it: `git -C <repo> config --local --remove-section hook.ocbi-prewarm` (or delete the
   symlink in `<git common dir>/hooks/`).
3. Install the new hook as above, then check `hooks status --repo <repo>`: `Installed: yes`, the
   command `current`, and no warning about `hook.ocbi-prewarm`.
4. Check out a branch in a test worktree and read its log in
   `<git common dir>/codebase-index/logs/post-checkout/`: one `== exit 0` per refresh.

The new hook keeps its state under the repository's common dir instead of
`$OCBI_HOME/logs/prewarm/`, which you can delete once no repository uses the shell hook. Remove
`$OCBI_HOME/ocbi-post-checkout.sh` last: git fails a checkout whose registered hook is missing.
To roll back, run `hooks uninstall --repo <repo>` and restore the saved `hook.ocbi-prewarm` keys.

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
   `install.sh --package <gd.7 or later spec>`. Install the Claude Code plugin from the repository
   marketplace and disable the plugin of the old local marketplace.
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
  save. `autoIndexOnStartup: false` for secondaries leaves their first index to the
  post-checkout hook or to the first retrieval.
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
  [Human CLI](installation.md#human-cli); with the bundle's install, run it as
  `<node> $OCBI_HOME/pkg/node_modules/open-codebase-index/dist/cbi.js prune`. The post-checkout
  hook logs the count once a day and notifies past `OCBI_STALE_THRESHOLD` (15) when installed
  with `--stale-notify`.

## Platforms

The mcp piece and installer run on macOS (bash 3.2, BSD tools) and Linux (bash 5, GNU tools), and the
package's post-checkout hook is Node code that runs on both;
`contrib/local-wrapper/test/run-tests.sh` runs on both. The `rebuild` and `notify` pieces are
macOS-only for now: the rebuild uses a launchd job, and notifications with an action button use a
small Swift app built from source. Linux support for both is planned.
