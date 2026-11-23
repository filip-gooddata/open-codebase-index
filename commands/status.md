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

Whenever status reports provider/model incompatibility, indexed or not, a full rebuild is needed. A full rebuild clears the whole store. Choose how to start it:
- When `index_status` shows a `Checkout role:` line, the store is shared by the repository's worktrees, and only its primary checkout may rebuild it:
  - first, if that line says the configured primary is not a checkout of this repository, or that a bare-base layout needs `checkouts.primary.path`, the primary is missing or invalid: tell the user to set `checkouts.primary.path` to a checkout of this repository in the repository config named on the `Store:` line, then rerun `/status`
  - else, if that line says `secondary`, if the repository config named on the `Store:` line sets `indexing.allowForceRebuild` to `false`, or if a forced `index_codebase` call returned `FORCE_REBUILD_DISABLED`, do not call `index_codebase` with force. Tell the user to run this release's CLI in a terminal, with this server's host and the primary checkout's path (the main worktree or configured primary that the `Checkout role:` line names, or the current checkout when it is primary):
    `npx -y --package https://github.com/filip-gooddata/open-codebase-index/releases/download/v0.38.2-gd.7/open-codebase-index-0.38.2-gd.7.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <primary checkout>`
    Where the local wrapper's rebuild piece is installed, `ocbi-rebuild` from any checkout of the repository does the same in the background.
- Otherwise, and when no repository config is involved, `/index force` runs it. If that returns `FORCE_REBUILD_DISABLED`, give the user the terminal command above with the current checkout as `--project`.
