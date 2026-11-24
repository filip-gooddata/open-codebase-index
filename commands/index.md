---
description: Index the codebase for semantic search
---

Run the `index_codebase` tool with these settings:

User input: $ARGUMENTS

Parse the input and set tool arguments:
- force=true if input contains "force"
- estimateOnly=true if input contains "estimate" 
- verbose=false (default, for token efficiency)
- verbose=true if input contains "verbose" (for detailed output)

Examples:
- `/index` → force=false, estimateOnly=false, verbose=false
- `/index force` → force=true, estimateOnly=false, verbose=false
- `/index estimate` → force=false, estimateOnly=true, verbose=false
- `/index verbose` → force=false, estimateOnly=false, verbose=true

IMPORTANT: You MUST pass the parsed arguments to `index_codebase`. Do not ignore them.

Show final statistics including files processed, chunks indexed, tokens used, and duration.

If indexing completes but the codebase still is not ready, tell the user to run `/status` next.
- If `/status` reports failed embedding batches, fix the provider/auth issue and rerun `/index` normally.
- Use `/index force` only for a full rebuild or when `/status` reports provider/model incompatibility.
- Before a forced run (`/index force`), and when `index_codebase` returns `FORCE_REBUILD_DISABLED`, follow the rebuild rules below; never retry a refused forced call.

A full rebuild clears the whole store. Choose how to start it, using the `Store:` and `Checkout role:` lines of `index_status`:
1. If the `Checkout role:` line says the configured primary is not a checkout of this repository, or that a bare-base layout needs `checkouts.primary.path`, the repository's primary checkout is missing or invalid. Tell the user to set `checkouts.primary.path` to a checkout of this repository in the repository config: the file named on the `Store:` line, or `<git common dir>/codebase-index/config.json` when that line says `repository default store`. A running server keeps the role it resolved first, so the user then restarts the MCP server (a new session, or reconnect it) and runs `/status` again. Do not rebuild until then.
2. Else, if the `Checkout role:` line says `secondary`, only the primary checkout may rebuild the shared store. Do not call `index_codebase` with force; give the user the terminal rebuild below with the primary checkout the line names.
3. Otherwise run `index_codebase` with force (`/index force`). The server merges every config layer for `indexing.allowForceRebuild` and, when forced rebuilds are disabled, returns `FORCE_REBUILD_DISABLED` before it changes anything. On that refusal do not retry; give the user the terminal rebuild below with the current checkout.

Terminal rebuild: this release's CLI, with this server's host and the checkout chosen above:
`npx -y --package https://github.com/filip-gooddata/open-codebase-index/releases/download/v0.38.2-gd.10/open-codebase-index-0.38.2-gd.10.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <checkout>`
Where the local wrapper's rebuild piece is installed, `ocbi-rebuild` from any checkout of the repository does the same in the background.
