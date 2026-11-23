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
- if status reports provider/model incompatibility, a full rebuild is needed:
  - when the `Checkout role:` line says `secondary`, or `/index force` already returned `FORCE_REBUILD_DISABLED`, tell the user to run this release's CLI in a terminal, with this server's host and the primary checkout's path from that line (the current checkout when it is primary):
    `npx -y --package https://github.com/filip-gooddata/open-codebase-index/releases/download/v0.38.2-gd.7/open-codebase-index-0.38.2-gd.7.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <primary checkout>`
    Where the local wrapper's rebuild piece is installed, `ocbi-rebuild` from any checkout of the repository does the same in the background.
  - otherwise tell the user to run `/index force`
