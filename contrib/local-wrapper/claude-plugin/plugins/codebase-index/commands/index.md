---
description: Index the codebase for semantic search
---

Run the `index_codebase` tool with these settings:

User input: $ARGUMENTS

Parse the input and set tool arguments:
- force is never set: a forced rebuild wipes the index shared by every worktree, only the primary checkout may run it, and the repository config sets `indexing.allowForceRebuild: false`, so the server refuses it with `FORCE_REBUILD_DISABLED`
- estimateOnly=true if input contains "estimate"
- verbose=false (default, for token efficiency)
- verbose=true if input contains "verbose" (for detailed output)

Examples:
- `/index` → force=false, estimateOnly=false, verbose=false
- `/index force` → do not call the tool; tell the user to start a full rebuild from a terminal (see below)
- `/index estimate` → force=false, estimateOnly=true, verbose=false
- `/index verbose` → force=false, estimateOnly=false, verbose=true

IMPORTANT: You MUST pass the parsed arguments to `index_codebase`. Do not ignore them.

Show final statistics including files processed, chunks indexed, tokens used, and duration.

If indexing completes but the codebase still is not ready, tell the user to run `/status` next.
- If `/status` reports failed embedding batches, fix the provider/auth issue and rerun `/index` normally.
- For a full rebuild, or when `/status` reports provider/model incompatibility, tell the user to run `ocbi-rebuild` in a terminal from any checkout of the repository, which rebuilds in the background. To drop catalogs of deleted branches, `ocbi prune --apply` is enough.
