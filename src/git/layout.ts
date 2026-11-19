import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import * as path from "path";

import { resolveGitDir } from "./index.js";
import { resolveCommonGitDir } from "./refs.js";

export interface RepositoryLayout {
  /** Canonical path of the checkout whose `.git` entry was resolved. */
  checkoutRoot: string;
  /** Canonical per-checkout git directory. */
  gitDir: string;
  /** Canonical git directory shared by every checkout of the repository. */
  commonDir: string;
  /** True when the checkout is a linked worktree (`git worktree add`). */
  linked: boolean;
  /**
   * Main worktree of a normal clone (`<main>/.git` is the common dir and the
   * repository is not bare). Null for a bare-base layout, where every checkout
   * is a linked worktree of a bare repository or of a git dir not named `.git`.
   */
  mainWorktree: string | null;
  /** True when the common dir's config declares `core.bare = true`. */
  bare: boolean;
}

function canonicalize(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/** A git dir contains `HEAD`, `objects/` and `refs/`, whatever its basename. */
export function isGitDirectory(directory: string): boolean {
  return existsSync(path.join(directory, "HEAD"))
    && isDirectory(path.join(directory, "objects"))
    && isDirectory(path.join(directory, "refs"));
}

/** Reads `core.bare` from a git config file without spawning git. */
export function isBareGitDirectory(gitDir: string): boolean {
  let content: string;
  try {
    content = readFileSync(path.join(gitDir, "config"), "utf-8");
  } catch {
    return false;
  }

  let inCoreSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (line.length === 0) continue;
    const section = line.match(/^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]$/);
    if (section) {
      inCoreSection = section[1].toLowerCase() === "core";
      continue;
    }
    if (!inCoreSection) continue;
    const entry = line.match(/^([A-Za-z0-9-]+)\s*(?:=\s*(.*))?$/);
    if (entry && entry[1].toLowerCase() === "bare") {
      const value = (entry[2] ?? "true").trim().toLowerCase();
      return value === "true" || value === "yes" || value === "on" || value === "1";
    }
  }
  return false;
}

/**
 * Resolves the git layout of a checkout from files only. It never spawns git
 * and ignores GIT_DIR / GIT_WORK_TREE, so the answer depends only on the
 * checkout on disk. Returns null when the path is not a checkout root.
 */
export function resolveRepositoryLayout(checkoutRoot: string): RepositoryLayout | null {
  const resolvedGitDir = resolveGitDir(checkoutRoot);
  // A linked worktree's own git dir has HEAD but no objects/; only the common
  // dir must be a complete git dir.
  if (!resolvedGitDir || !existsSync(path.join(resolvedGitDir, "HEAD"))) {
    return null;
  }

  const gitDir = canonicalize(resolvedGitDir);
  const commonDir = canonicalize(resolveCommonGitDir(resolvedGitDir));
  if (!isGitDirectory(commonDir)) {
    return null;
  }

  const bare = isBareGitDirectory(commonDir);
  const mainWorktree = !bare && path.basename(commonDir) === ".git"
    ? path.dirname(commonDir)
    : null;

  return {
    checkoutRoot: canonicalize(checkoutRoot),
    gitDir,
    commonDir,
    linked: gitDir !== commonDir,
    mainWorktree,
    bare,
  };
}
