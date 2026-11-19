import { runGitRaw } from "./branch-resolution.js";

export interface WorktreeCatalogIdentity {
  path: string;
  identity: string;
  detached: boolean;
}

/**
 * Catalog identities of every checked-out worktree, named the way
 * getCurrentBranch names a checkout: the branch, or a detached HEAD's
 * seven-character SHA. Bare entries have no checkout and name nothing.
 */
export function parseWorktreeCatalogIdentities(porcelainZ: string): WorktreeCatalogIdentity[] {
  const identities: WorktreeCatalogIdentity[] = [];
  let worktreePath: string | null = null;
  let head: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let bare = false;

  const flush = (): void => {
    if (worktreePath !== null && !bare) {
      if (branch !== null) {
        identities.push({ path: worktreePath, identity: branch, detached: false });
      } else if (detached && head !== null && /^[0-9a-f]{40,64}$/.test(head)) {
        identities.push({ path: worktreePath, identity: head.slice(0, 7), detached: true });
      } else {
        throw new Error(`Cannot name the catalog of worktree ${worktreePath}.`);
      }
    }
    worktreePath = null;
    head = null;
    branch = null;
    detached = false;
    bare = false;
  };

  for (const field of porcelainZ.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      flush();
      worktreePath = field.slice("worktree ".length);
    } else if (field.startsWith("HEAD ")) {
      head = field.slice("HEAD ".length);
    } else if (field.startsWith("branch ")) {
      const ref = field.slice("branch ".length);
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (field === "detached") {
      detached = true;
    } else if (field === "bare") {
      bare = true;
    }
  }
  flush();
  return identities;
}

export async function listWorktreeCatalogIdentities(
  projectRoot: string,
  options: { signal?: AbortSignal } = {},
): Promise<WorktreeCatalogIdentity[]> {
  const output = await runGitRaw(projectRoot, ["worktree", "list", "--porcelain", "-z"], options);
  return parseWorktreeCatalogIdentities(output);
}
