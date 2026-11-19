import { existsSync, readFileSync, statSync } from "fs";
import * as path from "path";

/** Resolves the git dir a checkout's `.git` entry names (a directory or a `gitdir:` file). */
export function resolveGitDir(repoRoot: string): string | null {
  const gitPath = path.join(repoRoot, ".git");
  
  if (!existsSync(gitPath)) {
    return null;
  }
  
  try {
    const stat = statSync(gitPath);
    
    if (stat.isDirectory()) {
      return gitPath;
    }
    
    if (stat.isFile()) {
      const content = readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitdir = match[1];
        // Handle relative paths
        const resolvedPath = path.isAbsolute(gitdir)
          ? gitdir
          : path.resolve(repoRoot, gitdir);
        
        if (existsSync(resolvedPath)) {
          return resolvedPath;
        }
      }
    }
  } catch {
    // Ignore errors (permission issues, etc.)
  }
  
  return null;
}
