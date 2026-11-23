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
- If `index_codebase` returns `FORCE_REBUILD_DISABLED`, do not retry with force. Forced rebuilds are disabled for this project, for example because its worktrees share one store that only the primary checkout may rebuild. Run `index_status`: its `Checkout role:` line names the primary checkout when the current one is secondary. Tell the user to run this release's CLI in a terminal, with the host from the refusal and the primary checkout's path:
  `npx -y --package https://github.com/filip-gooddata/open-codebase-index/releases/download/v0.38.2-gd.7/open-codebase-index-0.38.2-gd.7.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <primary checkout>`
  Where the local wrapper's rebuild piece is installed, `ocbi-rebuild` from any checkout of the repository does the same in the background.
