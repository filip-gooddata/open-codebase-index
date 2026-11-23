# Installation and host setup

`open-codebase-index` requires Node.js 22.22 or newer and is the preferred package identity. Node.js 24 LTS is recommended. `opencode-codebase-index` remains a supported legacy package alias, and `open-codebase-index-mcp` is the preferred binary alias.

The published package includes the MCP server dependencies and native binaries for supported platforms.

Both identities expose the same root plugin object (`id`, `setup`, and the v1 `server` callback). Root declarations are generated from the implementation: ESM imports resolve `dist/index.d.ts`, while CommonJS consumers resolve `dist/index.d.cts` and access the object's `default` export. Packed consumer checks use TypeScript 5.9.3 with strict NodeNext resolution and `skipLibCheck: false`; this is the tested compiler version, not a claimed minimum TypeScript version.

## OpenCode

Install the package:

```bash
npm install open-codebase-index
```

Legacy install:

```bash
npm install opencode-codebase-index
```

Add it to `opencode.json`:

For OpenCode 2.x:

```json
{
  "plugins": ["open-codebase-index"]
}
```

For OpenCode 1.x (1.3.4 or newer):

```json
{
  "plugin": ["open-codebase-index"]
}
```

Legacy OpenCode alias (OpenCode 2.x):

```json
{
  "plugins": ["opencode-codebase-index"]
}
```

Legacy OpenCode alias (OpenCode 1.x):

```json
{
  "plugin": ["opencode-codebase-index"]
}
```

Open the repository, run `/status`, and then run `/index`.

OpenCode uses:

- project config: `.opencode/codebase-index.json`
- project index: `.opencode/index/`
- global config: `~/.config/opencode/codebase-index.json`
- global index: `~/.opencode/global-index/`

## Jcode

Jcode starts non-shared MCP servers in each session's working directory. Configure the server once in `~/.jcode/mcp.json`:

```json
{
  "servers": {
    "codebase-index": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "open-codebase-index@latest",
        "open-codebase-index-mcp",
        "--host",
        "jcode"
      ],
      "env": {},
      "shared": false
    }
  }
}
```

Do not add a fixed `--project` argument. Jcode supplies the active session directory as the process working directory. `shared: false` prevents indexer state from being shared across repositories.

Restart Jcode after changing the MCP configuration. Jcode uses `.codebase-index/` project storage and can fall back to existing OpenCode state when appropriate.

## Pi

Install the Pi package:

```bash
pi install npm:open-codebase-index
```

For local development:

```bash
pi install ./path/to/open-codebase-index
```

The package provides native tools and the `codebase-search` skill. Pi uses `.codebase-index/` project storage.

On Pi hosts with mutable prompt sections, workflow guidance is contributed through
`systemPromptOptions.sections.codebase_index_guidance`, so sibling section and append
instructions reach the rendered prompt regardless of extension order. An intentional
full-prompt override takes precedence in either order; this extension does not clear or
repair it. Older Pi hosts retain the string-return fallback.

## omp (oh-my-pi)

Install the extension package:

```bash
omp plugin install npm:open-codebase-index
```

Or add the bundled marketplace and install from it:

```bash
omp plugin marketplace add filip-gooddata/open-codebase-index
omp plugin install codebase-index@open-codebase-index
```

For local development from this checkout:

```bash
npm run build:ts
omp plugin link /path/to/open-codebase-index
```

The package declares `omp.extensions` and `omp.skills`, so omp loads `dist/omp-extension.js` and the bundled `codebase-search` skill. The extension registers the same native tool surface as the Pi package and reuses `.codebase-index/` project storage, preferring the host's TypeBox-compatible schema builder when omp exposes one. omp still accepts the `pi` manifest as a fallback and takes `omp` first when both are declared.

The human and MCP CLIs accept `--host omp` as an alias for canonical `pi`. Both spellings use the same existing `.codebase-index/config.json` and `.codebase-index/index/` paths (and `.codebase-index/history/` for history), not a separate omp storage tree. This CLI alias does not add a programmatic `HostMode` value.

The omp extension preserves existing system-prompt blocks and appends its repository guidance as a separate block; Pi retains its string-based prompt format.

Use either the native extension or the MCP server, not both. If a repository's portable `.mcp.json` also declares `codebase-index`, merge `"disabledServers": ["codebase-index"]` into your omp user configuration at `~/.omp/agent/mcp.json` to suppress that MCP copy while retaining the native extension. Preserve any existing server definitions and disabled entries. Run `/mcp reload` or start a new session after changing MCP configuration; this omp-only exclusion does not affect other hosts.

Native Pi and omp tools pass host cancellation to supported shared operations. `index_codebase` publishes partial updates with indexing phase, file/chunk counts, and percentage. Cancellation is cooperative: it stops eligible asynchronous work at operation boundaries, but cannot preempt a synchronous native computation already executing.

To use the MCP server instead of the native extension, register it in `.omp/mcp.json` (project) or `~/.omp/agent/mcp.json` (user):

```json
{
  "mcpServers": {
    "codebase-index": {
      "command": "npx",
      "args": ["-y", "--package", "open-codebase-index", "open-codebase-index-mcp", "--host", "omp"]
    }
  }
}
```

## Codex

Add the marketplace and install the plugin:

```text
codex plugin marketplace add filip-gooddata/open-codebase-index
codex plugin add codebase-index@open-codebase-index
```

Restart or open a new thread in the target workspace. The plugin bundles MCP configuration, session guidance, and the `codebase-search` skill.

The plugin's server runs `npx -y --package <release tarball> open-codebase-index-mcp --host codex`, where `<release tarball>` is the GitHub release asset of the plugin's own version, `https://github.com/filip-gooddata/open-codebase-index/releases/download/v<version>/open-codebase-index-<version>.tgz`. See [Plugin launch through npx](#plugin-launch-through-npx) for Node.js, network and first-start requirements.

Approve the plugin's tools in `~/.codex/config.toml` with its plugin policy table:

```toml
[plugins."codebase-index@open-codebase-index".mcp_servers.codebase-index]
default_tools_approval_mode = "approve"
```

Codex documents `startup_timeout_sec` (default 10 s) and `tool_timeout_sec` (default 60 s) only for servers registered under `[mcp_servers]`. A cold first start takes longer than 10 s, and a retrieval call that waits for first-use indexing takes longer than 60 s. To set both, turn off the plugin's copy of the server and register it directly, keeping the plugin for its skill and session guidance:

```toml
[plugins."codebase-index@open-codebase-index".mcp_servers.codebase-index]
enabled = false

[mcp_servers.codebase-index]
command = "npx"
args = ["-y", "--package", "<release tarball>", "open-codebase-index-mcp", "--host", "codex"]
startup_timeout_sec = 120
tool_timeout_sec = 420
default_tools_approval_mode = "approve"
```

Set `tool_timeout_sec` above `indexing.autoIndexWaitMs` (converted to seconds). A direct entry does not follow plugin updates: change its tarball URL when you upgrade.

`--host codex` reads `~/.config/codebase-index/config.json` as its global config and `.codebase-index/` as project storage, so in a repository without a [repository config](configuration.md#repository-config-and-shared-store) it builds an index separate from Claude Code's `.claude/index/`. Its idle engine shuts down after 900 seconds and stops watching files; pass `--mcp-idle-timeout 0` to keep it running. To reuse Claude Code's global config and project indexes instead, register the direct entry with `--host claude`. That server has no idle shutdown and sends Claude Code's routing instructions. In a repository with a repository config both host modes use the shared store.

If Codex reports `Transport closed`, inspect `index_status` from a new thread or client session. Server-side cancellation and durable diagnostics cannot make a client reuse a stdio transport that it has already closed.

For local development from this checkout, run `npm run build:ts` and register `node /path/to/open-codebase-index/dist/cli.js --host codex` as the direct `[mcp_servers.codebase-index]` entry.

## Claude Code

From Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add filip-gooddata/open-codebase-index
/plugin install codebase-index@open-codebase-index
```

or from a shell:

```bash
claude plugin marketplace add filip-gooddata/open-codebase-index
claude plugin install codebase-index@open-codebase-index
```

Restart or open a new session in the target workspace. The plugin provides the MCP server, the `codebase-search` skill, and the `/codebase-index:` commands `index`, `status`, `search`, `find`, `peek`, `definition`, `call-graph` and `pr-impact`. It has no SessionStart hook: the server sends its routing guidance in the MCP `instructions` at initialize.

The server runs `npx -y --package <release tarball> open-codebase-index-mcp --host claude` (see [Plugin launch through npx](#plugin-launch-through-npx)). The plugin version equals the package version, so `/plugin marketplace update open-codebase-index` followed by a plugin update moves the server to the new release. To stay on one release, add the marketplace at its tag, for example `filip-gooddata/open-codebase-index@v<version>`.

### Plugin launch through npx

The plugins in this fork of [Helweg/open-codebase-index](https://github.com/Helweg/open-codebase-index) start the server from the release tarball of their own version; nothing is installed from the npm registry under the package name. `npm run sync:plugin-manifests` (run by `npm version`) writes the tarball URL and version into `.claude-plugin/plugin.json`, `.mcp.json`, `.codex-plugin/plugin.json` and the marketplace manifests, and the release workflow refuses a tag whose manifests are stale.

- `npx` and Node.js 22.22 or newer must be on the `PATH` the host passes to MCP servers. A host started from a desktop launcher may not see a shell-managed Node.js.
- The tarball holds the native module for every release platform (macOS arm64 and Linux x64 glibc), so no build runs on install.
- The first start downloads the tarball (about 35 MB) and its dependencies into the npm cache. That took about 50 s on a cold cache, past Claude Code's 30 s `MCP_TIMEOUT` and Codex's 10 s default `startup_timeout_sec`. Later starts reuse the cache and took 2 to 6 s.
- `npx` revalidates the URL on each start, so a start needs network access to GitHub.

After installing or upgrading, fill the cache once from a shell so the host's first start is fast:

```bash
npx -y --package <release tarball> ocbi --help
```

Alternatively raise the timeout, for example `MCP_TIMEOUT=120000 claude`, or reconnect the server from `/mcp` after the first download finishes.

Claude uses:

- project config: `.claude/codebase-index.json`
- project index: `.claude/index/`
- global config: `~/.claude/codebase-index.json`
- global index: `~/.claude/global-index/`

## Human CLI

The concise `ocbi` command is for terminal use. `cbi` remains available as a compatibility alias. It shares `open-codebase-index` index and retrieval operations, while `open-codebase-index-mcp` remains the MCP-server binary.

```bash
# Inspect readiness, then create or refresh the index
ocbi status --project /path/to/repo --host jcode
# Optional read-only source/HEAD freshness check with machine-readable status
ocbi status --check-freshness --json --project /path/to/repo --host jcode
ocbi index --project /path/to/repo --host jcode

# Search and inspect code from the terminal
ocbi search "retry recovery" --project /path/to/repo --limit 5
ocbi definition Indexer --project /path/to/repo
ocbi graph callers Indexer --project /path/to/repo

# Refresh edited source, then inspect the current indexed dirty tree without committing
ocbi index --project /path/to/repo --host omp
ocbi impact --working-tree --json --project /path/to/repo --host omp
```

A store shared by many worktrees keeps a catalog for every branch it has indexed. `ocbi prune` lists the catalogs whose key is neither the branch of a checked-out worktree of the project's repository nor the seven-character SHA of a detached worktree HEAD, with their rows per table. Nothing changes until you add `--apply`, which removes those catalogs under the index lock and then collects chunks, symbols, edges and embeddings no remaining catalog references. Name catalog keys to prune only those; if one of them is the catalog of a checked-out worktree, the command removes nothing and exits 1. Git offers no lock to hold, so a branch checked out in the milliseconds between prune's final worktree check and its commit can still lose its catalog; that catalog is rebuilt on the branch's next index.

```bash
ocbi prune --project /path/to/worktree --host claude          # dry run
ocbi prune --apply --project /path/to/worktree --host claude  # remove stale catalogs
ocbi prune old-branch 1a2b3c4 --apply --json --project /path/to/worktree --host claude
```

Index mutations hold `indexing.lock` in the index directory. When its owner exits without releasing it, the next run on the same machine recovers it. A lock counts as this machine's when its machine id matches: new locks record a hash of `/etc/machine-id` plus the PID namespace on Linux, of the platform UUID on macOS, or of the MachineGuid on Windows. A lock without a machine id (written by an older release, or on a machine without one) counts only when it names this machine and the index sits on storage known to be local: the OS hostname, a different spelling of it, or on macOS the configured HostName or the Bonjour LocalHostName with or without `.local`. Storage counts as local when the filesystem visible at the index directory is known to be: on Linux its statfs type is a local one (ext4, xfs, btrfs, zfs, tmpfs, overlay and similar); on macOS every mount-table entry on its path whose device matches the directory's is marked `local`. On any other storage, or where the mount table cannot be read, a machine elsewhere could use the same name, so such a lock is not recovered automatically. A lock from another machine is never recovered automatically, because its process cannot be checked from here, and a lock's age is never taken as proof that its owner stopped. When automatic recovery is refused, `INDEX_BUSY` names the command to run:

```bash
ocbi unlock /path/to/index            # show the lock; clear it only if its owner has exited
ocbi unlock /path/to/index --force    # confirm: owner on another machine, unreadable record, or a lock under 15 minutes old
ocbi unlock --json --project /path/to/repo --host claude
```

`ocbi unlock` lists the lock, any recovery in progress inside it, and any recovery marker that blocks the next run, with their raw contents. It never clears a lock whose owner is still running on this machine, even with `--force`, and treats an owner as running whenever a process with its PID runs here, unless its recorded machine id proves it came from another machine. A guard (`indexing.lock.unlock`) keeps two unlocks from working on one index at once; one left by an unlock that exited is replaced, and one from another machine needs `--force`. Use `--force` only after confirming that no index process using that index runs on any machine that can reach it. A cleared lock with a readable record leaves a recovery marker, so the next index run restores the partial writes its owner left. An unreadable or legacy single-file record carries nothing to recover from, and the command says so; rebuild with `ocbi index --force` if results look wrong. Releases before this one do not understand a force-cleared marker and keep reporting `INDEX_BUSY` until a run of this release completes the recovery.

Known limitation: after a reboot, an unrelated process can reuse the dead owner's PID. The lock then looks alive and stays until that process exits.

Use `ocbi index --dry-run` for a parse-only embedding-token total, `--estimate-only` for an estimate, and `ocbi --help` for command usage.

A forced rebuild clears every branch catalog in the index and re-embeds the whole codebase. When several checkouts or sessions share one index, set `"indexing": { "allowForceRebuild": false }` so that `index_codebase` with `force: true` is refused in every host. An operator who really needs a full rebuild, for example after changing the embedding model, runs it from a terminal in the checkout that owns the index:

```bash
ocbi index --force --allow-shared-rebuild --project /path/to/repo --host claude
```

`--allow-shared-rebuild` is accepted only together with `--force`. Linked worktrees catch up through their normal incremental refresh afterwards.

Ordinary status reports stored catalog facts with freshness explicitly not checked. `--check-freshness` compares current selected source/configuration and HEAD with the index; it does not refresh the index or request embeddings. A successfully inspected missing/stale index still exits successfully; operational failures exit nonzero. The `--check-freshness` and status `--json` flags apply only to status (workspace status retains its separate JSON contract).

Without `--project`, the CLI discovers the nearest containing Git checkout and reuses its project configuration and branch catalog, even from a nested package directory. MCP startup uses the same rule. Nested repositories, submodules, and linked worktrees retain their own checkout roots. Non-Git directories keep the current directory as their scope. An explicit `--project` is never widened, so use `--project .` to deliberately index only a child directory.

`ocbi impact` requires `--working-tree` and accepts optional `--json` plus project/host/config selection. It reports the union of staged, unstaged, and untracked changes against the current indexed files, not staged source or deleted historical declarations. Refresh stale source with ordinary `ocbi index` first; impact inspection itself does not index or contact GitHub. Missing graph coverage or the 200-path cap produces UNKNOWN risk. See [Impact evidence](tools.md#pr_impact) for provenance and consistency limits.

### Private history on GitHub.com and Enterprise

Enable sources in the **project-local** host configuration using `repositoryHistory.repositories` (see [Configuration](configuration.md#private-github-history)). Selectors accept `[HOST/]OWNER/REPO`: bare `owner/repo` defaults to GitHub.com, and explicit `github.com/OWNER/REPO` normalizes to that same lowercase identity. Enterprise selectors normalize to lowercase `hostname/owner/repo`. Use a DNS hostname only, with no URL scheme, credentials, port, or traversal components.

For Enterprise, authenticate separately with normal `gh auth login --hostname github.example.com`. History uses existing authentication without changing it or copying credentials; sync depends on `gh` REST and GraphQL access on the selected server.

```sh
ocbi history sync --project /path/to/repo --host omp --repository github.example.com/team/service
```

Here `--host omp` chooses Pi-compatible local config/storage; the `--repository` hostname chooses the GitHub server. That hostname binds source/cache/staging/citation/permission identity, so matching owner/repo names on different servers remain isolated. Citations and `#number` references use the selected server; explicit URL references are validated, not cross-host rewritten or fetched. History remains manually synchronized, read-only, and local lexical/BM25 retrieval with no cloud embeddings. Offline reads cannot establish current permissions; see [Tools and commands](tools.md#private-github-repository-history) for freshness and selected-source access-loss cleanup limitations.

## Generic MCP clients

Run the published MCP server with `npx`:

```bash
npx -y --package open-codebase-index open-codebase-index-mcp --project /path/to/repo
```

Legacy command:

```bash
npx -y --package opencode-codebase-index opencode-codebase-index-mcp --project /path/to/repo
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "codebase-index": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "open-codebase-index",
        "open-codebase-index-mcp",
        "--project",
        "/path/to/repo"
      ]
    }
  }
}
```

### CLI options

```text
--project <path>  Repository to index. Defaults to the containing Git checkout, or cwd outside Git.
--config <path>   Explicit configuration file.
--host <mode>     opencode, codex, claude, pi, omp (alias for pi), or jcode.
--mcp-idle-timeout <seconds>  Idle engine timeout; 0 disables (default: 900 for codex, 0 otherwise).
--help, -h        Print root usage to stdout and exit without starting the MCP server.
```

Examples:

```bash
open-codebase-index-mcp --project /path/to/repo
open-codebase-index-mcp --config /path/to/config.json
open-codebase-index-mcp --host jcode
```

Use `--host` when you want the corresponding host's configuration and storage paths. `--host omp` and `--host pi` select the same canonical Pi mode and existing `.codebase-index` config/storage. Without it, the CLI uses OpenCode-compatible behavior.

Both `open-codebase-index-mcp --help` and `opencode-codebase-index-mcp -h` show the MCP options and available `index`, `eval`, and `visualize` commands without loading project configuration or starting indexing, providers, or watchers. With no command or help flag, the binary starts the stdio MCP server. Use `index --help` or `eval --help` for their existing command-specific usage.

The same binary also accepts a dedicated indexing mode:

```bash
open-codebase-index-mcp index --project /path/to/repo --estimate-only
open-codebase-index-mcp index --project /path/to/repo --force
open-codebase-index-mcp index --project /path/to/repo --config /path/to/config.json --host jcode
opencode-codebase-index-mcp index --project /path/to/repo --estimate-only
```

When using `index`:

- `--estimate-only` prints the estimate directly and exits.
- `--dry-run` parses the file set and reports the exact embedding token total (files, source chunks, tokens) without indexing; read-only, no embedding requests.
- `--force` bypasses stale-index checks.
- `--verbose` includes detailed final index statistics.
- `--config` loads and parses that file, then initializes the runtime from it before indexing.

Progress and diagnostics for `index` are written to `stderr`; the final formatted result is written to `stdout`.

## Local source checkout

Development requires Node.js 22.22 or newer within 22.x, 24.11 or newer within 24.x, or 26 or newer. Chokidar 6's engine requirement applies to source installs as well as published packages.

```bash
npm ci
npm run build
npm run dev:link-mcp
```

If native code changed, run:

```bash
npm run build:native
```

## First use

For every host:

1. Open the repository you want to index.
2. Run `index_status` or `/status`.
3. Run `index_codebase` or `/index` if the index is missing or stale.
4. Choose the task-specific tool: compact `codebase_context` for unfamiliar orientation, `implementation_lookup` for known definitions, or graph tools for identified relationships.

Provider setup and storage configuration are covered in [Configuration](configuration.md). Tool selection is covered in [Tools and commands](tools.md).
