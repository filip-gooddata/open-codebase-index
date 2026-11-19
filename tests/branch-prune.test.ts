import { execFileSync, spawnSync } from "child_process";
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCbiCli } from "../src/adapters/cbi.js";
import { parseConfig } from "../src/config/schema.js";
import { parseWorktreeList } from "../src/git/worktree-catalogs.js";
import { planBranchPrune } from "../src/indexer/branch-prune.js";
import { Indexer } from "../src/indexer/index.js";
import { acquireIndexLock, IndexLockContentionError, releaseIndexLock } from "../src/indexer/index-lock.js";
import { Database, hashContent } from "../src/native/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

const config = parseConfig({
  embeddingProvider: "custom",
  customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
  indexing: { watchFiles: false, autoGc: false },
});

describe("parseWorktreeList", () => {
  it("names branches verbatim, detached HEADs by seven-character SHA, and skips bare entries", () => {
    const sha1 = "0123456789abcdef0123456789abcdef01234567";
    const sha256 = "fedcba9876543210".repeat(4);
    const output = [
      "worktree /repo.git", "bare", "",
      "worktree /repo", `HEAD ${sha1}`, "branch refs/heads/main", "",
      "worktree /wt/feature", `HEAD ${sha1}`, "branch refs/heads/feature/a/b", "locked", "",
      "worktree /wt/detached", `HEAD ${sha1}`, "detached", "prunable gitdir file points to non-existent location", "",
      "worktree /wt/sha256", `HEAD ${sha256}`, "detached", "",
      "worktree /wt/odd", "HEAD zz", "",
      "",
    ].join("\0");

    expect(parseWorktreeList(output)).toEqual([
      { path: "/repo", identity: "main" },
      { path: "/wt/feature", identity: "feature/a/b" },
      { path: "/wt/detached", identity: "0123456" },
      { path: "/wt/sha256", identity: "fedcba9" },
      { path: "/wt/odd", identity: null },
    ]);
  });
});

describe("Indexer.pruneBranchCatalogs", () => {
  let tempDir: string;
  let repo: string;
  let indexPath: string;
  let dbPath: string;
  let detachedKey: string;
  const openIndexers: Indexer[] = [];

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "branch-prune-")));
    repo = path.join(tempDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["branch", "feature"]);
    git(repo, ["worktree", "add", path.join(tempDir, "wt-feature"), "feature"]);
    git(repo, ["worktree", "add", "--detach", path.join(tempDir, "wt-detached"), "HEAD"]);
    detachedKey = git(repo, ["rev-parse", "HEAD"]).slice(0, 7);

    indexPath = path.join(repo, ".opencode", "index");
    fs.mkdirSync(indexPath, { recursive: true });
    dbPath = path.join(indexPath, "codebase.db");
    new Database(dbPath).close();
  });

  afterEach(async () => {
    for (const indexer of openIndexers.splice(0)) await indexer.close();
    vi.restoreAllMocks();
    // Git and indexer teardown can still be flushing into the repo, so removal can lose the race with ENOTEMPTY.
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function createIndexer(): Indexer {
    const indexer = new Indexer(repo, config, "opencode");
    openIndexers.push(indexer);
    return indexer;
  }

  function sql(statements: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec(statements);
    db.close();
  }

  function count(query: string): number {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(query).get() as { n: number };
    db.close();
    return row.n;
  }

  function seedCatalog(branch: string, shared = true): void {
    const own = `${branch}-only`;
    sql(`
      INSERT OR IGNORE INTO embeddings (content_hash, embedding, chunk_text, model, created_at)
        VALUES ('h-shared', x'00', 'shared', 'm', 0), ('h-${own}', x'00', '${own}', 'm', 0);
      INSERT OR IGNORE INTO chunks (chunk_id, content_hash, file_path, start_line, end_line, language)
        VALUES ('c-shared', 'h-shared', 'a.ts', 1, 1, 'typescript'), ('c-${own}', 'h-${own}', 'a.ts', 2, 2, 'typescript');
      INSERT OR IGNORE INTO symbols (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
        VALUES ('s-shared', 'a.ts', 'shared', 'function', 1, 0, 1, 1, 'typescript'),
               ('s-${own}', 'a.ts', '${own}', 'function', 2, 0, 2, 1, 'typescript');
      INSERT OR IGNORE INTO call_edges (id, from_symbol_id, target_name, to_symbol_id, call_type, line, col, is_resolved)
        VALUES ('e-${own}', 's-${own}', 'shared', 's-shared', 'Call', 2, 0, 1);
      INSERT INTO branch_chunks (branch, chunk_id) VALUES ('${branch}', 'c-${own}');
      INSERT INTO branch_symbols (branch, symbol_id) VALUES ('${branch}', 's-${own}');
      INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved) VALUES ('${branch}', 'e-${own}', 's-shared', 1);
      INSERT INTO metadata (key, value) VALUES ('index.branchCommit.${hashContent(branch).slice(0, 24)}', 'abc');
      INSERT INTO metadata (key, value) VALUES ('index.symbolExtractorVersion.${hashContent(branch).slice(0, 24)}', '1');
    `);
    if (shared) {
      sql(`
        INSERT INTO branch_chunks (branch, chunk_id) VALUES ('${branch}', 'c-shared');
        INSERT INTO branch_symbols (branch, symbol_id) VALUES ('${branch}', 's-shared');
      `);
    }
    const namespace = hashContent(branch).slice(0, 16);
    fs.writeFileSync(path.join(indexPath, `file-hashes.${namespace}.json`), "{}");
    fs.writeFileSync(path.join(indexPath, `file-dependencies.${namespace}.json`), "{}");
    fs.writeFileSync(path.join(indexPath, `.failed-batches.${namespace}.json.${"a".repeat(40)}.tmp`), "");
  }

  function seedStore(): void {
    for (const branch of ["main", "feature", detachedKey, "gone", "pr/42"]) seedCatalog(branch);
  }

  function catalogRows(branch: string): number {
    return count(`SELECT
      (SELECT COUNT(*) FROM branch_chunks WHERE branch = '${branch}')
      + (SELECT COUNT(*) FROM branch_symbols WHERE branch = '${branch}')
      + (SELECT COUNT(*) FROM branch_call_edges WHERE branch = '${branch}') AS n`);
  }

  function sidecarCount(branch: string): number {
    const namespace = hashContent(branch).slice(0, 16);
    return fs.readdirSync(indexPath).filter((name) => name.includes(`.${namespace}.`)).length;
  }

  it("lists stale catalogs with per-table rows on a dry run and changes nothing", async () => {
    seedStore();
    const result = await createIndexer().pruneBranchCatalogs();

    expect(result.applied).toBe(false);
    expect(result.catalogCount).toBe(5);
    expect(result.liveCatalogCount).toBe(3);
    expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["gone", "pr/42"]);
    expect(result.catalogs[0].rows).toEqual({ branchChunks: 2, branchSymbols: 2, branchCallEdges: 1, branchCallEdgesStale: 0 });
    expect(result.catalogs[0].sidecars).toHaveLength(3);
    expect(result.removed).toBeNull();
    expect(catalogRows("gone")).toBe(5);
    expect(sidecarCount("gone")).toBe(3);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
  });

  it("removes stale catalogs, their metadata and sidecars, then collects orphans", async () => {
    seedStore();
    const result = await createIndexer().pruneBranchCatalogs({ apply: true });

    expect(result.applied).toBe(true);
    expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["gone", "pr/42"]);
    expect(result.removed).toEqual({
      branchChunks: 4, branchSymbols: 4, branchCallEdges: 2, branchCallEdgesStale: 0, metadata: 4, sidecars: 6,
    });
    expect(result.gc).toEqual({ symbols: 2, callEdges: 0, chunks: 2, embeddings: 2 });
    for (const branch of ["gone", "pr/42"]) {
      expect(catalogRows(branch)).toBe(0);
      expect(sidecarCount(branch)).toBe(0);
    }
    for (const branch of ["main", "feature", detachedKey]) {
      expect(catalogRows(branch)).toBe(5);
      expect(sidecarCount(branch)).toBe(3);
    }
    expect(count("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'index.branchCommit.%'")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM chunks WHERE chunk_id = 'c-shared'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM chunks WHERE chunk_id = 'c-gone-only'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM call_edges WHERE id = 'e-main-only'")).toBe(1);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);

    const again = await createIndexer().pruneBranchCatalogs({ apply: true });
    expect(again.catalogs).toEqual([]);
  });

  it("refuses explicit keys of checked-out worktrees, including a detached HEAD, and applies none of the request", async () => {
    seedStore();
    const result = await createIndexer().pruneBranchCatalogs({ keys: ["feature", detachedKey, "gone"], apply: true });

    expect(result.applied).toBe(false);
    expect(result.refused).toEqual([
      { key: "feature", reason: "catalog of a checked-out worktree" },
      { key: detachedKey, reason: "catalog of a checked-out worktree" },
    ]);
    expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["gone"]);
    expect(result.removed).toBeNull();
    expect(catalogRows("feature")).toBe(5);
    expect(catalogRows(detachedKey)).toBe(5);
    expect(catalogRows("gone")).toBe(5);
    expect(sidecarCount("gone")).toBe(3);
  });

  it("prunes explicitly named catalogs only", async () => {
    seedStore();
    const result = await createIndexer().pruneBranchCatalogs({ keys: ["gone", "never-indexed"], apply: true });

    expect(result.applied).toBe(true);
    expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["gone", "never-indexed"]);
    expect(catalogRows("gone")).toBe(0);
    expect(catalogRows("pr/42")).toBe(5);
  });

  it("lists and prunes a catalog left only in the call-edge overlay", async () => {
    seedStore();
    sql("INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved) VALUES ('edges-only', 'e-main-only', NULL, 0);");

    const result = await createIndexer().pruneBranchCatalogs({ apply: true });

    expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["edges-only", "gone", "pr/42"]);
    expect(count("SELECT COUNT(*) AS n FROM branch_call_edges WHERE branch = 'edges-only'")).toBe(0);
  });

  it("keeps a catalog whose worktree is checked out while the prune plans", async () => {
    seedStore();
    git(repo, ["branch", "gone"]);
    const original = Database.prototype.countBranchCatalogRows;
    vi.spyOn(Database.prototype, "countBranchCatalogRows").mockImplementation(function (this: Database, ...args) {
      git(repo, ["worktree", "add", path.join(tempDir, "wt-gone"), "gone"]);
      return original.apply(this, args);
    });

    const result = await createIndexer().pruneBranchCatalogs({ apply: true });

    expect(result.applied).toBe(true);
    expect(result.refused).toEqual([{ key: "gone", reason: "checked out while pruning" }]);
    expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["pr/42"]);
    expect(catalogRows("gone")).toBe(5);
    expect(sidecarCount("gone")).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM metadata WHERE key = 'index.branchCommit.${hashContent("gone").slice(0, 24)}'`)).toBe(1);
    expect(catalogRows("pr/42")).toBe(0);
  });

  it("refuses explicit keys outside this project in a global index", () => {
    seedStore();
    const database = Database.openReadOnly(dbPath);
    try {
      const plan = planBranchPrune({
        database,
        indexPath,
        liveKeys: new Set(),
        keys: ["gone", "pr/42"],
        candidateKeyFilter: (key) => key === "pr/42",
      });
      expect(plan.refused).toEqual([{ key: "gone", reason: "catalog of another project in this global index" }]);
      // Prepared global catalogs namespace their sidecars too; unsuffixed shared files never match.
      expect(plan.catalogs.map((catalog) => catalog.key)).toEqual(["pr/42"]);
      expect(plan.catalogs[0].sidecars).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it("prunes a detached-HEAD catalog once its worktree is gone", async () => {
    seedStore();
    git(repo, ["worktree", "remove", path.join(tempDir, "wt-detached")]);
    const result = await createIndexer().pruneBranchCatalogs({ apply: true });

    expect(result.catalogs.map((catalog) => catalog.key).sort()).toEqual([detachedKey, "gone", "pr/42"].sort());
    expect(catalogRows(detachedKey)).toBe(0);
    expect(catalogRows("feature")).toBe(5);
  });

  it("handles a store written before the branch call-edge overlay", async () => {
    seedStore();
    sql("DROP TRIGGER IF EXISTS branch_call_edges_legacy_write; DROP TABLE branch_call_edges_stale; DROP TABLE branch_call_edges; DELETE FROM metadata WHERE key = 'branch_call_edges_version';");

    const dryRun = await createIndexer().pruneBranchCatalogs();
    expect(dryRun.catalogs.map((catalog) => catalog.rows)).toEqual([
      { branchChunks: 2, branchSymbols: 2, branchCallEdges: 0, branchCallEdgesStale: 0 },
      { branchChunks: 2, branchSymbols: 2, branchCallEdges: 0, branchCallEdgesStale: 0 },
    ]);

    const applied = await createIndexer().pruneBranchCatalogs({ apply: true });
    expect(applied.removed).toMatchObject({ branchChunks: 4, branchSymbols: 4 });
    expect(count("SELECT COUNT(*) AS n FROM branch_chunks WHERE branch IN ('gone', 'pr/42')")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM branch_chunks WHERE branch = 'main'")).toBe(2);
  });

  it("removes stale-edge rows a 0.34.0-era writer left for a pruned catalog only", async () => {
    seedStore();
    sql("INSERT INTO branch_symbols (branch, symbol_id) VALUES ('gone', 's-main-only');");
    // A 0.34.0 writer has no branch and rewrites the shared row in place.
    sql(`INSERT OR REPLACE INTO call_edges (id, from_symbol_id, target_name, to_symbol_id, call_type, line, col, is_resolved)
      VALUES ('e-main-only', 's-main-only', 'shared', NULL, 'Call', 2, 0, 0);`);
    expect(count("SELECT COUNT(*) AS n FROM branch_call_edges_stale WHERE branch = 'gone'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM branch_call_edges_stale WHERE branch = 'main'")).toBe(1);

    const result = await createIndexer().pruneBranchCatalogs({ keys: ["gone"], apply: true });

    expect(result.catalogs[0].rows).toEqual({ branchChunks: 2, branchSymbols: 3, branchCallEdges: 2, branchCallEdgesStale: 1 });
    expect(count("SELECT COUNT(*) AS n FROM branch_call_edges_stale WHERE branch = 'gone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM branch_call_edges_stale WHERE branch = 'main'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM branch_call_edges WHERE branch = 'main'")).toBe(1);
  });

  it("fails without changes while another writer holds the index lock", async () => {
    seedStore();
    const lease = acquireIndexLock(indexPath, "index");
    try {
      await expect(createIndexer().pruneBranchCatalogs({ apply: true })).rejects.toBeInstanceOf(IndexLockContentionError);
    } finally {
      releaseIndexLock(lease);
    }
    expect(catalogRows("gone")).toBe(5);
    expect(sidecarCount("gone")).toBe(3);
  });

  it("holds the index lock while it deletes", async () => {
    seedStore();
    const owners: unknown[] = [];
    const original = Database.prototype.deleteBranchCatalogs;
    vi.spyOn(Database.prototype, "deleteBranchCatalogs").mockImplementation(function (this: Database, ...args) {
      owners.push(JSON.parse(fs.readFileSync(path.join(indexPath, "indexing.lock", "owner.json"), "utf8")));
      return original.apply(this, args);
    });

    await createIndexer().pruneBranchCatalogs({ apply: true });

    expect(owners).toEqual([expect.objectContaining({ operation: "prune", pid: process.pid })]);
    expect(fs.existsSync(path.join(indexPath, "indexing.lock"))).toBe(false);
  });

  function deleteSpyAddingWorktree(branch: string): void {
    git(repo, ["branch", branch]);
    const original = Database.prototype.deleteBranchCatalogs;
    let added = false;
    vi.spyOn(Database.prototype, "deleteBranchCatalogs").mockImplementation(function (this: Database, ...args) {
      const pruned = original.apply(this, args);
      if (!added) {
        added = true;
        git(repo, ["worktree", "add", path.join(tempDir, `wt-${branch}`), branch]);
      }
      return pruned;
    });
  }

  it("rolls back and keeps a catalog checked out after the deletes, before the commit", async () => {
    seedStore();
    deleteSpyAddingWorktree("gone");

    const result = await createIndexer().pruneBranchCatalogs({ apply: true });

    expect(result.applied).toBe(true);
    expect(result.refused).toEqual([{ key: "gone", reason: "checked out while pruning" }]);
    expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["pr/42"]);
    expect(catalogRows("gone")).toBe(5);
    expect(sidecarCount("gone")).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM metadata WHERE key = 'index.branchCommit.${hashContent("gone").slice(0, 24)}'`)).toBe(1);
    expect(catalogRows("pr/42")).toBe(0);
  });

  it("applies none of an explicit request when one key is checked out before the commit", async () => {
    seedStore();
    deleteSpyAddingWorktree("gone");

    const result = await createIndexer().pruneBranchCatalogs({ keys: ["gone", "pr/42"], apply: true });

    expect(result.applied).toBe(false);
    expect(result.refused).toEqual([{ key: "gone", reason: "checked out while pruning" }]);
    expect(result.removed).toBeNull();
    expect(catalogRows("gone")).toBe(5);
    expect(catalogRows("pr/42")).toBe(5);
    expect(sidecarCount("pr/42")).toBe(3);
  });

  it("leaves the catalog for a retry when the run stops after removing sidecars", async () => {
    seedStore();
    const commit = vi.spyOn(Database.prototype, "commitWriteTransaction").mockImplementationOnce(() => {
      throw new Error("interrupted");
    });

    await expect(createIndexer().pruneBranchCatalogs({ keys: ["gone"], apply: true })).rejects.toThrow("interrupted");
    expect(catalogRows("gone")).toBe(5);
    expect(sidecarCount("gone")).toBe(0);
    commit.mockRestore();

    const retry = await createIndexer().pruneBranchCatalogs({ apply: true });
    expect(retry.catalogs.map((catalog) => catalog.key)).toEqual(["gone", "pr/42"]);
    expect(catalogRows("gone")).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM metadata WHERE key = 'index.branchCommit.${hashContent("gone").slice(0, 24)}'`)).toBe(0);
  });

  it("reads worktrees of the project's repository even when GIT_DIR names another", async () => {
    seedStore();
    const other = path.join(tempDir, "other");
    fs.mkdirSync(other);
    git(other, ["init", "-b", "main"]);
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, ".git");
    try {
      const result = await createIndexer().pruneBranchCatalogs();
      expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["gone", "pr/42"]);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("refuses to apply while an interrupted writer's recovery is pending, and keeps its marker", async () => {
    seedStore();
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: child.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "11111111-1111-4111-8111-111111111111",
    }));

    await expect(createIndexer().pruneBranchCatalogs({ apply: true })).rejects.toThrow(/recovery pending/);
    expect(catalogRows("gone")).toBe(5);
    expect(fs.readdirSync(indexPath).some((name) => name.startsWith("indexing.lock.recovery."))).toBe(true);
  });

  it("runs through the cbi prune command with host-aware paths", async () => {
    seedStore();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { printStdout: (text: string) => stdout.push(text), printStderr: (text: string) => stderr.push(text) };

    expect(await runCbiCli(["node", "cbi", "prune", "--project", repo, "--json"], tempDir, io)).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "{}")).toMatchObject({ applied: false, catalogCount: 5 });

    expect(await runCbiCli(["node", "cbi", "prune", "feature", "--project", repo], tempDir, io)).toBe(1);
    expect(stdout.pop()).toContain("Refused feature: catalog of a checked-out worktree");

    expect(await runCbiCli(["node", "cbi", "prune", "--apply", "--project", repo], tempDir, io)).toBe(0);
    expect(stdout.pop()).toMatch(/Removed 2 catalogs:[\s\S]*Rows removed: branch_chunks=4 branch_symbols=4/);
    expect(catalogRows("gone")).toBe(0);
    expect(stderr).toEqual([]);
  });
});

describe("cbi prune arguments", () => {
  it("passes explicit keys and --apply to the prune operation", async () => {
    const runPrune = vi.fn(async () => ({
      applied: true, indexPath: "/i", catalogCount: 1, liveCatalogCount: 0, catalogs: [], refused: [],
      removed: null, gc: null, elapsedMs: 1,
    }));
    const code = await runCbiCli(["node", "cbi", "prune", "a", "b", "--apply", "--host", "claude", "--project", "/p"], "/", {
      runPrune, printStdout: () => {}, printStderr: () => {},
    });

    expect(code).toBe(0);
    expect(runPrune).toHaveBeenCalledWith("/p", "claude", { keys: ["a", "b"], apply: true });
  });

  it("rejects --apply on other commands", async () => {
    const stderr: string[] = [];
    const code = await runCbiCli(["node", "cbi", "status", "--apply"], "/", { printStdout: () => {}, printStderr: (text) => stderr.push(text) });
    expect(code).toBe(1);
    expect(stderr[0]).toBe("Unknown option: --apply");
  });
});

describe("Indexer.pruneBranchCatalogs in a SHA-256 repository", () => {
  let tempDir: string;

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("keeps the catalog a detached SHA-256 worktree indexes into", async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "branch-prune-sha256-")));
    const repo = path.join(tempDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "--object-format=sha256", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["worktree", "add", "--detach", path.join(tempDir, "wt-detached"), "HEAD"]);
    const shortSha = git(repo, ["rev-parse", "HEAD"]).slice(0, 7);
    const indexPath = path.join(repo, ".opencode", "index");
    fs.mkdirSync(indexPath, { recursive: true });
    const dbPath = path.join(indexPath, "codebase.db");
    new Database(dbPath).close();
    const db = new DatabaseSync(dbPath);
    for (const branch of ["main", "default", shortSha, "gone"]) {
      db.prepare("INSERT INTO branch_chunks (branch, chunk_id) VALUES (?, 'c')").run(branch);
    }
    db.close();

    const indexer = new Indexer(repo, config, "opencode");
    try {
      const result = await indexer.pruneBranchCatalogs();
      expect(result.catalogs.map((catalog) => catalog.key)).toEqual(["gone"]);
    } finally {
      await indexer.close();
    }
  });
});
