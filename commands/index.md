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

A full rebuild clears the whole store. Choose how to start it:
- When `index_status` shows a `Checkout role:` line, the store is shared by the repository's worktrees, and only its primary checkout may rebuild it:
  - first, if that line says the configured primary is not a checkout of this repository, or that a bare-base layout needs `checkouts.primary.path`, the primary is missing or invalid: tell the user to set `checkouts.primary.path` to a checkout of this repository in the repository config named on the `Store:` line, then rerun `/status`
  - else, if that line says `secondary`, if the repository config named on the `Store:` line sets `indexing.allowForceRebuild` to `false`, or if a forced `index_codebase` call returned `FORCE_REBUILD_DISABLED`, do not call `index_codebase` with force. Tell the user to run this release's CLI in a terminal, with this server's host and the primary checkout's path (the main worktree or configured primary that the `Checkout role:` line names, or the current checkout when it is primary):
    `npx -y --package https://github.com/filip-gooddata/open-codebase-index/releases/download/v0.38.2-gd.7/open-codebase-index-0.38.2-gd.7.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <primary checkout>`
    Where the local wrapper's rebuild piece is installed, `ocbi-rebuild` from any checkout of the repository does the same in the background.
- Otherwise, and when no repository config is involved, `/index force` runs it. If that returns `FORCE_REBUILD_DISABLED`, give the user the terminal command above with the current checkout as `--project`.
