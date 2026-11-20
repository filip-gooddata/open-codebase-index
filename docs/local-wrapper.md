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
  use the global index) and `"indexing": { "allowForceRebuild": false }`, and both `.claude`
  paths ignored through `info/exclude` and untracked. When a precondition fails, nothing is
  linked, links the launcher made earlier in that checkout are removed, and the launcher starts
  nothing there: no server, no CLI, and `--link-only` exits 1. It logs `refusing to start:` and
  the reason in the `[ocbi-mcp]` lines of the MCP log. A checkout of a listed project never falls
  back to the global config, because other checkouts keep their links and a worktree can inherit
  them, with a profile that may predate `allowForceRebuild`.
- A linked checkout needs a package with `indexing.allowForceRebuild` in `$OCBI_HOME/pkg`. With
  an older one the launcher refuses to start the same way and says the package must be
  upgraded.
- Anything else in the way of a link is moved to `$OCBI_HOME/<project>/parked/<stamp>/`, never
  deleted.
- With a `profiles.conf` line, the primary checkout gets `profiles/main.json` (background indexing
  as in the base config) and every other worktree `profiles/worktree.json` (`watchFiles` and
  `autoIndexOnStartup` off). Both are generated from the base config
  whenever it changes. A bare clone must pin its primary's git dir, because git cannot confirm a
  primary checkout there.

## Host registration

**Claude Code.** The `plugin` piece installs a local marketplace whose plugin starts the launcher
and adds one SessionStart hook, `--session-hint`, which tells the model to use the index, only
inside listed projects.

The package itself covers what earlier wrapper versions did with more hooks and a stdio guard:

- **Forced rebuilds.** The example store config sets `"indexing": { "allowForceRebuild": false }`,
  and both profiles inherit it. The server then refuses `index_codebase` with `force: true` in
  every host with `FORCE_REBUILD_DISABLED`, before it takes any lock. Only the CLI can override it,
  with `ocbi index --force --allow-shared-rebuild`, which is what `ocbi-rebuild` runs. The launcher
  links only a store whose config sets the key to `false`.
- **Status text.** With `--host claude`, `index_status` returns text only, with the MCP
  diagnostics (active and latest interrupted operations) appended, so Claude Code shows the
  formatted status rather than structured content.

The launcher no longer adds a `Routing:` line to `index_status`. Why a checkout is not linked is in
the `[ocbi-mcp]` lines of the MCP log and in `ocbi-mcp.sh --link-only`, which prints the root and
logs the reason.

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

## Upgrading from a wrapper with the force guard

The installer never edits a store config, and the default pieces do not upgrade the package. After
updating the wrapper:

1. Upgrade the package: `install.sh --pieces pkg --package <spec>`, with a release that has
   `indexing.allowForceRebuild`.
2. Add `"allowForceRebuild": false` to the `indexing` object of every
   `$OCBI_HOME/<project>/codebase-index.json`. The profiles are regenerated from it.
3. Restart the MCP servers, or the agent sessions that run them.

Until both are done, the launcher starts nothing in checkouts of that project and logs why.

## Settings that matter

- `indexing.autoIndexWaitMs: 360000` in the example base config. Retrieval waits this long for a
  refresh that another session is running instead of failing at once. The package caps it at
  600000. Keep each host's tool timeout above it.
- The primary checkout keeps `watchFiles`; every other worktree gets `watchFiles: false`, because
  hundreds of watchers on one store cost more than they save. The profiles also set
  `autoIndexOnStartup` (true for the primary, false elsewhere) for a package that reads it. The
  current package ignores that key, so with `autoIndex: true` every worktree still indexes when
  its server starts. Set `autoIndex: false` in the
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
  catalog, and re-embedding a large repository can take hours. `allowForceRebuild: false` in the
  store config makes the server refuse it with `FORCE_REBUILD_DISABLED`. For a full rebuild use
  `ocbi-rebuild <project>` (macOS today; Linux support is planned). It runs the forced index
  through the launcher with `--allow-shared-rebuild` and `OCBI_REQUIRE_PROJECT=<project>`, so the
  launcher refuses it unless that checkout is linked to the project's store at that moment. A
  `refusing to start:` refusal fails the rebuild at once; other failures, such as `INDEX_BUSY`,
  are retried. The post-checkout hook does the same with `OCBI_REQUIRE_PROJECT='*'`, so it never
  indexes a local or global index. A guarded run accepts only `index`, and always runs it with
  `--host claude --project <absolute root>`.
- One process indexes a store at a time (`indexing.lock`). The CLI returns `INDEX_BUSY`; MCP
  retrieval waits up to `autoIndexWaitMs`.
- Nothing restarts a server that dies. After a server is killed, reconnect the MCP server or
  restart the session.
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
`index_status` with the formatted status text. `index_codebase` with `force: true` should return
`FORCE_REBUILD_DISABLED`.

## Platforms

The launcher, hook, plugin and installer run on macOS (bash 3.2, BSD tools) and Linux
(bash 5, GNU tools); `contrib/local-wrapper/test/run-tests.sh` runs on both. The `rebuild` and
`notify` pieces are macOS-only for now: the rebuild uses a launchd job, and notifications with an
action button use a small Swift app built from source. Linux support for both is planned.
