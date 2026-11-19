import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { loadMergedConfig } from "../src/config/merger.js";
import { getRepositoryConfigPath, resetRepositoryRoutesForTests } from "../src/config/repository-route.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else {
        snapshot[path.relative(root, entryPath)] = fs.readFileSync(entryPath).toString("base64");
      }
    }
  };
  walk(root);
  return snapshot;
}

const DEAD_OWNER_TOKEN = "44444444-4444-4444-8444-444444444444";

describe("shared repository store guards on secondary checkouts", () => {
  let tempDir: string;
  let mainRoot: string;
  let worktreeRoot: string;
  let commonDir: string;
  let store: string;
  let lockPath: string;
  const indexers: Indexer[] = [];

  function writeRepoConfig(extra: Record<string, unknown> = {}): void {
    writeJson(getRepositoryConfigPath(commonDir), {
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "route-test", dimensions: 8 },
      include: ["**/*.ts"],
      indexing: { autoIndex: true, watchFiles: false, autoGc: false, requireProjectMarker: false },
      search: { minScore: 0 },
      checkouts: { secondary: { autoIndexOnStartup: false } },
      ...extra,
    });
  }

  function createIndexer(checkout: string, host: HostMode = "codex"): Indexer {
    const indexer = new Indexer(checkout, parseConfig(loadMergedConfig(checkout, host)), host);
    indexers.push(indexer);
    return indexer;
  }

  async function indexFromPrimary(): Promise<void> {
    const primary = createIndexer(mainRoot, "claude");
    expect((await primary.index()).indexedChunks).toBeGreaterThan(0);
    await primary.close();
  }

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-guards-")));
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    git(mainRoot, "init", "-q", "-b", "main");
    fs.writeFileSync(
      path.join(mainRoot, "src", "entry.ts"),
      "export function sharedGuardTarget() {\n  const seed = 40;\n  return seed + 2;\n}\n",
    );
    git(mainRoot, "add", "src/entry.ts");
    git(mainRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture");
    worktreeRoot = path.join(tempDir, "repo-feature");
    git(mainRoot, "worktree", "add", "-q", "-b", "feature", worktreeRoot);
    commonDir = fs.realpathSync(path.join(mainRoot, ".git"));
    store = path.join(commonDir, "codebase-index", "index");
    lockPath = path.join(store, "indexing.lock");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({
        data: input.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
        usage: { total_tokens: input.length },
      }));
    });
  });

  afterEach(async () => {
    for (const indexer of indexers.splice(0)) {
      await indexer.close();
    }
    resetRepositoryRoutesForTests();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("force rebuild and clear", () => {
    it("refuses forceIndex and clearIndex on a secondary before taking a lease or writing a recovery marker", async () => {
      writeRepoConfig();
      await indexFromPrimary();
      const before = snapshotTree(store);

      const secondary = createIndexer(worktreeRoot);
      const primaryPath = fs.realpathSync(mainRoot);
      const refusal = "Project-scoped force rebuild is limited to the primary checkout of a shared repository store. "
        + `This checkout is secondary (linked worktree; the main worktree ${primaryPath} is primary). `
        + `Run index_codebase with force=true from the primary checkout ${primaryPath}.`;
      await expect(secondary.forceIndex()).rejects.toThrow(refusal);
      await expect(secondary.clearIndex()).rejects.toThrow(refusal);

      expect(fs.existsSync(lockPath)).toBe(false);
      expect(snapshotTree(store)).toEqual(before);
    });

    it("names checkouts.primary.path in the repository config when no primary resolves", async () => {
      writeRepoConfig({ checkouts: { primary: { path: path.join(tempDir, "not-a-checkout") } } });
      const checkout = createIndexer(mainRoot);

      await expect(checkout.clearIndex()).rejects.toThrow(
        `Run index_codebase with force=true from the primary checkout once checkouts.primary.path is set in ${getRepositoryConfigPath(commonDir)}.`,
      );
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("still lets a secondary recover a clear the primary started", async () => {
      writeRepoConfig();
      await indexFromPrimary();
      const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: deadProcess.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        operation: "clear",
        token: DEAD_OWNER_TOKEN,
        recoveryProtocolVersion: 1,
        clearRecovery: {
          phase: "clearing",
          embeddingProvider: "custom",
          embeddingModel: "route-test",
          embeddingDimensions: 8,
          embeddingStrategyVersion: "2",
          compatibilityDecision: "compatible",
        },
      }));

      const secondary = createIndexer(worktreeRoot);
      const stats = await secondary.index();
      expect(stats.failedChunks).toBe(0);
      expect(stats.indexedChunks).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(lockPath, "owner.json"))).toBe(false);
      expect((await secondary.search("sharedGuardTarget")).length).toBeGreaterThan(0);
    });
  });

  describe("unreadable shared artifacts", () => {
    it("keeps an unreadable keyword index on a secondary and names the primary", async () => {
      writeRepoConfig();
      await indexFromPrimary();
      const keywordPath = path.join(store, "inverted-index.json");
      fs.writeFileSync(keywordPath, "{ not a keyword index");

      const secondary = createIndexer(worktreeRoot);
      await expect(secondary.index()).rejects.toThrow(
        `The keyword index ${keywordPath} of the shared repository store is unreadable. `
        + "This checkout is secondary (linked worktree; "
        + `the main worktree ${fs.realpathSync(mainRoot)} is primary) and does not reset shared store artifacts; `
        + `repair it by running index_codebase with force=true from the primary checkout ${fs.realpathSync(mainRoot)}.`,
      );
      expect(fs.readFileSync(keywordPath, "utf8")).toBe("{ not a keyword index");

      const primary = createIndexer(mainRoot, "claude");
      expect((await primary.index()).failedChunks).toBe(0);
      // The primary keeps the existing repair: it drops the unreadable keyword artifact.
      expect(fs.existsSync(keywordPath)).toBe(false);
    });

    it("keeps a corrupted database on a secondary and names the primary, while the primary still resets it", async () => {
      writeRepoConfig();
      await indexFromPrimary();

      const secondary = createIndexer(worktreeRoot);
      expect((await secondary.index()).failedChunks).toBe(0);
      const before = snapshotTree(store);
      const corrupt = (): void => {
        vi.spyOn(Database.prototype, "gcOrphanEmbeddings").mockReturnValue(0);
        vi.spyOn(Database.prototype, "gcOrphanChunks").mockImplementation(() => {
          throw new Error("SQLite error: database disk image is malformed");
        });
      };

      corrupt();
      await expect(secondary.healthCheck()).rejects.toThrow(
        `The SQLite database ${path.join(store, "codebase.db")} of the shared repository store is unreadable. `
        + "This checkout is secondary (linked worktree; "
        + `the main worktree ${fs.realpathSync(mainRoot)} is primary) and does not reset shared store artifacts; `
        + `repair it by running index_codebase with force=true from the primary checkout ${fs.realpathSync(mainRoot)}.`,
      );
      vi.mocked(Database.prototype.gcOrphanChunks).mockRestore();
      vi.mocked(Database.prototype.gcOrphanEmbeddings).mockRestore();
      expect(snapshotTree(store)).toEqual(before);

      const primary = createIndexer(mainRoot, "claude");
      expect((await primary.index()).failedChunks).toBe(0);
      corrupt();
      const result = await primary.healthCheck();
      expect(result.resetCorruptedIndex).toBe(true);
      expect((await primary.getStatus()).vectorCount).toBe(0);
    });
  });
});
