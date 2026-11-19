import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { getBranchOrDefault } from "./index.js";

const execFileAsync = promisify(execFile);

/** Variables that point Git at a repository other than the one at cwd. */
const REPOSITORY_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const;

export interface WorktreeEntry {
  path: string;
  /** The identity Git reports: the branch, or a detached HEAD's seven-character SHA. */
  identity: string | null;
}

export function parseWorktreeList(porcelainZ: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let worktreePath: string | null = null;
  let head: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let bare = false;

  const flush = (): void => {
    if (worktreePath !== null && !bare) {
      let identity: string | null = null;
      if (branch !== null) identity = branch;
      else if (detached && head !== null && /^[0-9a-f]{40,64}$/.test(head)) identity = head.slice(0, 7);
      entries.push({ path: worktreePath, identity });
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
  return entries;
}

/**
 * Catalog identities every checked-out worktree of the repository at
 * projectRoot can index into. Each worktree is named the way the Indexer names
 * its own checkout (getBranchOrDefault reads its HEAD), plus the identity Git
 * reports, so a worktree whose HEAD the Indexer cannot parse still protects its
 * fallback catalog. A worktree neither can name fails the whole listing.
 */
export async function listWorktreeCatalogIdentities(
  projectRoot: string,
  options: { signal?: AbortSignal } = {},
): Promise<Set<string>> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of REPOSITORY_ENV_OVERRIDES) delete env[name];
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
    signal: options.signal,
  });

  const identities = new Set<string>();
  for (const entry of parseWorktreeList(stdout)) {
    if (entry.identity !== null) identities.add(entry.identity);
    if (existsSync(entry.path)) {
      identities.add(getBranchOrDefault(entry.path));
    } else if (entry.identity === null) {
      throw new Error(`Cannot name the catalog of worktree ${entry.path}.`);
    }
  }
  return identities;
}
