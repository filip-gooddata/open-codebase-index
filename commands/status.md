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
- if status reports provider/model incompatibility, a full rebuild is needed: tell the user to run `/index force`. Where forced rebuilds are disabled (`indexing.allowForceRebuild: false`, as in a repository whose worktrees share one store), that returns `FORCE_REBUILD_DISABLED`; then the rebuild runs from a terminal in the repository's primary checkout, with the `ocbi index --force --allow-shared-rebuild` command the refusal names, or `ocbi-rebuild` where the local wrapper's rebuild piece is installed
