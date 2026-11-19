# Local wrapper: one index for many worktrees

`contrib/local-wrapper/` holds the scripts one machine uses to run open-codebase-index for
repositories with many git worktrees. This page explains what they do, which settings they rely
on, and what tends to go wrong. [The bundle README](../contrib/local-wrapper/README.md) covers the
pieces, installation and removal.

## When you need it

For one checkout per project, skip the wrapper. Register the server directly as described in
[Installation and host setup](installation.md), for example:

```bash
node <install dir>/node_modules/open-codebase-index/dist/cli.js --host claude --project <repo>
```

The wrapper is for a repository with many worktrees, where each worktree would otherwise build its
own index. The package shares an index across worktrees only when the git common dir is named
`.git`, which rules out bare clones, and it keeps that index inside the checkout. The launcher
instead links every worktree of a listed project to one store under `$OCBI_HOME/<project>/`:

```text
<worktree>/.claude/index               -> $OCBI_HOME/<project>/claude-index
<worktree>/.claude/codebase-index.json -> $OCBI_HOME/<project>/codebase-index.json
                                          (or profiles/main.json, profiles/worktree.json)
```

It makes those links on every start, then starts the server with `--host claude --project <root>`.
The launcher's header comment documents every rule; the summary:

- A project is listed in `projects.conf` as `name|git common dir`. A worktree belongs to it when
  `git rev-parse --git-common-dir` resolves to that directory.
- Linking needs a plain store directory with its `codebase-index.json`, which must set
  `"scope": "project"` (without it the package can inherit `global` from the global config and
  use the global index), and both `.claude` paths ignored through `info/exclude` and untracked.
  When a precondition fails, nothing is linked, links the launcher made earlier are removed, and
  the reason is logged and shown by `index_status`.
- Anything else in the way of a link is moved to `$OCBI_HOME/<project>/parked/<stamp>/`, never
  deleted.
- With a `profiles.conf` line, the primary checkout gets `profiles/main.json` (background indexing
  as in the base config) and every other worktree `profiles/worktree.json` (`watchFiles` and
  `autoIndexOnStartup` off). Both are generated from the base config
  whenever it changes. A bare clone must pin its primary's git dir, because git cannot confirm a
  primary checkout there.

## Host registration

**Claude Code.** The `plugin` piece installs a local marketplace whose plugin starts the launcher
and adds three hooks that call launcher modes:

| Hook | Mode | Why |
|---|---|---|
| SessionStart | `--session-hint` | Tells the model to use the index, only inside listed projects. |
| PreToolUse on `index_codebase` | `--guard-force` | Blocks `force=true`, which would wipe the shared store for every worktree. |
| PostToolUse on `index_status` | `--status-output` | Claude Code shows the model only the tool's structured content, so the hook replaces it with the `cbi status` text plus the routing (project, store, profile, or why nothing is linked). |

The server itself runs behind `mcp-force-guard.mjs`, which answers a forced `index_codebase` call
without passing it on. That covers hosts that do not run the plugin's hooks.

**Codex.** Register the server in `~/.codex/config.toml`:

```toml
[mcp_servers.codebase-index]
command = "/bin/bash"
args = ["<OCBI_HOME>/ocbi-mcp.sh"]
startup_timeout_sec = 30.0
tool_timeout_sec = 420.0
```

`tool_timeout_sec` must exceed `indexing.autoIndexWaitMs` (below); Codex's 60 s default is
shorter. The launcher uses `--host claude` for Codex too: the host only selects storage paths, and
`--host codex` adds an idle supervisor that stops the file watcher after 15 idle minutes.

**git.** The `hook` piece refreshes the index after each branch checkout, so a new worktree is
warm before an agent asks. Register it per repository, in the local config on a git with
config-based hooks:

```bash
git -C <repo> config --local hook.ocbi-prewarm.event post-checkout
git -C <repo> config --local hook.ocbi-prewarm.command "'<OCBI_HOME>/ocbi-post-checkout.sh'"
```

or, on any git version, by linking it as the repository's `post-checkout` hook in
`<git common dir>/hooks/`. git 2.43 has no config-based hooks; git 2.54 does.

## Settings that matter

- `indexing.autoIndexWaitMs: 360000` in the example base config. Retrieval waits this long for a
  refresh that another session is running instead of failing at once. The package caps it at
  600000. Keep each host's tool timeout above it.
- The primary checkout keeps `watchFiles`; every other worktree gets `watchFiles: false`, because
  hundreds of watchers on one store cost more than they save. The profiles also set
  `autoIndexOnStartup` (true for the primary, false elsewhere) for a package that reads it. The
  current package ignores that key, so with `autoIndex: true` every worktree still indexes when
  its server starts; `index_status` says so in its routing line. Set `autoIndex: false` in the
  base config if only on-demand indexing is wanted, on the primary too.
- Tune `exclude` for your repository. Generated code, build output and vendored dependencies cost
  embedding time and push real code out of results.
- `knowledgeBases` entries are absolute paths. Point them at your own clones, or leave them out.
- The index works only with the provider and model it was built with. Changing either means a
  full rebuild.

## Pitfalls

- The launcher resolves the project from its working directory. In server mode it passes its own
  `--host claude --project <root>` after any arguments it was given, so the server always runs on
  the checkout it linked. Hosts start MCP servers in the session's directory, which is what you
  want; when you run it by hand, run it from inside the checkout.
- Never run `index_codebase` with `force=true` on a shared store: it drops every worktree's
  catalog, and re-embedding a large repository can take hours. The guard and the hook block it.
  For a full rebuild use `ocbi-rebuild <project>` (macOS today; Linux support is planned). It
  runs the forced index through the launcher with `OCBI_REQUIRE_PROJECT=<project>`, so the
  launcher refuses it (exit 3) unless that checkout is linked to the project's store at that
  moment. The post-checkout hook does the same with `OCBI_REQUIRE_PROJECT='*'`, so it never
  indexes a local or global index.
- One process indexes a store at a time (`indexing.lock`). The CLI returns `INDEX_BUSY`; MCP
  retrieval waits up to `autoIndexWaitMs`.
- The guard does not restart a server that dies. After a server is killed, reconnect the MCP
  server or restart the session.
- Upgrading the package in `$OCBI_HOME/pkg` does not affect running servers; each keeps its
  version until its session restarts.
- A store with hundreds of branch catalogs grows to gigabytes. `ocbi prune` (a dry run unless
  `--apply`) removes catalogs of branches with no worktree; see
  [Human CLI](installation.md#human-cli). The launcher counts such catalogs once a day per project
  and, past `OCBI_STALE_THRESHOLD` (15), sends a notification when the `notify` piece is
  installed.
- git exports `GIT_DIR` and related variables to hooks. The post-checkout hook clears them before
  it calls the launcher; otherwise the primary checkout would be linked to the worktree profile.

## Verify

From inside a checkout of a listed project:

```bash
"$OCBI_HOME/ocbi-mcp.sh" --link-only      # prints the root; check the .claude links
"$OCBI_HOME/ocbi-mcp.sh" --cbi status --host claude
"$OCBI_HOME/ocbi-mcp.sh" --cbi index --host claude
"$OCBI_HOME/ocbi-mcp.sh" --cbi search "some concept in the repo" --limit 3
```

It works when `status` exits 0 and reports a ready catalog with no pending storage migrations, a
search returns results, and a new agent session lists the `codebase-index` tools and answers
`index_status` with a `Routing: project <name>, shared index ...` line.

## Platforms

The launcher, guard, hook, plugin and installer run on macOS (bash 3.2, BSD tools) and Linux
(bash 5, GNU tools); `contrib/local-wrapper/test/run-tests.sh` runs on both. The `rebuild` and
`notify` pieces are macOS-only for now: the rebuild uses a launchd job, and notifications with an
action button use a small Swift app built from source. Linux support for both is planned.
