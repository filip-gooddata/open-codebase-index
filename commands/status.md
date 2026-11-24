---
description: Check if the codebase is indexed and ready for semantic search
---

Run the `index_status` tool to check if the codebase index is ready.

This shows:
- Whether the codebase is indexed
- Number of indexed chunks
- Embedding provider and model being used
- Current git branch
- Failed embedding batches or compatibility warnings that explain why search is not ready

No arguments needed - just run `index_status`.

If not indexed:
- suggest running `/index` when no index exists yet
- if status reports failed embedding batches, tell the user to fix the provider/auth issue and rerun `/index` normally

Whenever status reports provider/model incompatibility, indexed or not, a full rebuild is needed. A full rebuild clears the whole store. Choose how to start it, using the `Store:` and `Checkout role:` lines of `index_status`:
1. If the `Checkout role:` line says the configured primary is not a checkout of this repository, or that a bare-base layout needs `checkouts.primary.path`, the repository's primary checkout is missing or invalid. Tell the user to set `checkouts.primary.path` to a checkout of this repository in the repository config: the file named on the `Store:` line, or `<git common dir>/codebase-index/config.json` when that line says `repository default store`. A running server keeps the role it resolved first, so the user then restarts the MCP server (a new session, or reconnect it) and runs `/status` again. Do not rebuild until then.
2. Else, if the `Checkout role:` line says `secondary`, only the primary checkout may rebuild the shared store. Do not call `index_codebase` with force; give the user the terminal rebuild below with the primary checkout the line names.
3. Otherwise tell the user to run `/index force`. Never call `index_codebase` with force from `/status`: a forced run clears the store. `/index force` handles a `FORCE_REBUILD_DISABLED` refusal, which the server returns before it changes anything when the merged config disables forced rebuilds.

Terminal rebuild: this release's CLI, with this server's host and the checkout chosen above:
`npx -y --package https://github.com/filip-gooddata/open-codebase-index/releases/download/v0.38.2-gd.9/open-codebase-index-0.38.2-gd.9.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <checkout>`
Where the local wrapper's rebuild piece is installed, `ocbi-rebuild` from any checkout of the repository does the same in the background.
