import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { loadMergedConfig } from "../src/config/merger.js";
import { resolveProjectIndexPath } from "../src/config/paths.js";
import { getRepositoryConfigPath, resetRepositoryRoutesForTests } from "../src/config/repository-route.js";
import { parseConfig, type ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { acquireIndexLock, releaseIndexLock } from "../src/indexer/index-lock.js";
import { Indexer } from "../src/indexer/index.js";
import { executeIndexStatus } from "../src/tools/execute-common.js";
import {
  configureAutoIndex,
  resetAutoIndexCoordinatorsForTests,
  startAutoIndexForBackgroundWorker,
  stopAutoIndexForBackgroundWorker,
  waitForAutoIndexForRetrieval,
} from "../src/utils/auto-index.js";
import {
  configureBackgroundWorker,
  getBackgroundWorkerLeasePath,
  isBackgroundWorkerLeader,
  resetBackgroundWorkersForTests,
} from "../src/utils/background-worker.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function symlinkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("repository config file at runtime", () => {
  let tempDir: string;
  let mainRoot: string;
  let worktreeRoot: string;
  let commonDir: string;
  let store: string;
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

  function mergedConfig(checkout: string, host: HostMode): ParsedCodebaseIndexConfig {
    return parseConfig(loadMergedConfig(checkout, host));
  }

  function createIndexer(checkout: string, host: HostMode): Indexer {
    const indexer = new Indexer(checkout, mergedConfig(checkout, host), host);
    indexers.push(indexer);
    return indexer;
  }

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-runtime-")));
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    git(mainRoot, "init", "-q", "-b", "main");
    fs.writeFileSync(
      path.join(mainRoot, "src", "entry.ts"),
      "export function sharedRouteTarget() {\n  const seed = 40;\n  return seed + 2;\n}\n",
    );
    git(mainRoot, "add", "src/entry.ts");
    git(mainRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture");
    worktreeRoot = path.join(tempDir, "repo-feature");
    git(mainRoot, "worktree", "add", "-q", "-b", "feature", worktreeRoot);
    commonDir = fs.realpathSync(path.join(mainRoot, ".git"));
    store = path.join(commonDir, "codebase-index", "index");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({
        data: input.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
        usage: { total_tokens: input.length },
      }));
    });
  });

  afterEach(async () => {
    await resetAutoIndexCoordinatorsForTests();
    await resetBackgroundWorkersForTests();
    for (const indexer of indexers.splice(0)) {
      await indexer.close();
    }
    resetRepositoryRoutesForTests();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("lock and lease identity", () => {
    it("uses one mutation lock for an indexPath reached through a symlink", () => {
      const realStore = path.join(tempDir, "data", "store");
      fs.mkdirSync(realStore, { recursive: true });
      const linkedStore = path.join(tempDir, "store-link");
      symlinkDir(realStore, linkedStore);
      writeRepoConfig({ storage: { indexPath: linkedStore } });
      const linkedCheckout = path.join(tempDir, "feature-link");
      symlinkDir(worktreeRoot, linkedCheckout);

      const routed = [
        resolveProjectIndexPath(worktreeRoot, "project", "claude"),
        resolveProjectIndexPath(linkedCheckout, "project", "codex"),
        resolveProjectIndexPath(mainRoot, "project", "jcode"),
      ];
      expect(routed).toEqual([linkedStore, linkedStore, linkedStore]);

      const lease = acquireIndexLock(linkedStore, "index");
      try {
        expect(lease.lockPath).toBe(path.join(fs.realpathSync(realStore), "indexing.lock"));
        expect(() => acquireIndexLock(realStore, "index")).toThrow(/Index mutation already in progress/);
      } finally {
        releaseIndexLock(lease);
      }
      const second = acquireIndexLock(realStore, "index");
      expect(second.lockPath).toBe(lease.lockPath);
      releaseIndexLock(second);
    });

    it("names one background lease per checkout across spellings of index path and checkout root", () => {
      const realStore = path.join(tempDir, "data", "store");
      fs.mkdirSync(realStore, { recursive: true });
      const linkedStore = path.join(tempDir, "store-link");
      symlinkDir(realStore, linkedStore);
      const linkedCheckout = path.join(tempDir, "feature-link");
      symlinkDir(worktreeRoot, linkedCheckout);

      writeRepoConfig({ storage: { indexPath: linkedStore } });
      const viaLinks = getBackgroundWorkerLeasePath(linkedCheckout, mergedConfig(linkedCheckout, "codex"), "codex");
      resetRepositoryRoutesForTests();
      writeRepoConfig({ storage: { indexPath: realStore } });
      const viaReal = getBackgroundWorkerLeasePath(worktreeRoot, mergedConfig(worktreeRoot, "claude"), "claude");
      const mainLease = getBackgroundWorkerLeasePath(mainRoot, mergedConfig(mainRoot, "claude"), "claude");

      expect(viaLinks).toBe(viaReal);
      expect(path.dirname(viaReal)).toBe(fs.realpathSync(realStore));
      expect(mainLease).not.toBe(viaReal);
      expect(path.dirname(mainLease)).toBe(path.dirname(viaReal));
    });
  });

  describe("indexer roles", () => {
    it("indexes the shared store from the primary and refuses a project force rebuild on a secondary", async () => {
      writeRepoConfig();
      const primary = createIndexer(mainRoot, "claude");
      expect((await primary.index()).indexedChunks).toBeGreaterThan(0);
      expect(fs.existsSync(store)).toBe(true);
      expect(fs.existsSync(path.join(mainRoot, ".claude", "index"))).toBe(false);

      const secondary = createIndexer(worktreeRoot, "codex");
      await expect(secondary.forceIndex()).rejects.toThrow(
        "Project-scoped force rebuild is limited to the primary checkout of a shared repository store. "
        + `This checkout is secondary (linked worktree; the main worktree ${fs.realpathSync(mainRoot)} is primary).`,
      );
      // Secondaries still index their own branch into the shared store.
      expect((await secondary.index()).failedChunks).toBe(0);
      expect((await secondary.search("sharedRouteTarget")).length).toBeGreaterThan(0);

      await expect(primary.forceIndex()).resolves.toMatchObject({ failedChunks: 0 });
    });

    it("recovers an interrupted shared store from a secondary checkout", async () => {
      writeRepoConfig();
      const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      const lockPath = path.join(store, "indexing.lock");
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: deadProcess.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        operation: "index",
        token: "33333333-3333-4333-8333-333333333333",
      }));

      const secondary = createIndexer(worktreeRoot, "codex");
      const stats = await secondary.index();
      expect(stats.failedChunks).toBe(0);
      expect(stats.indexedChunks).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(lockPath, "owner.json"))).toBe(false);
      expect((await secondary.search("sharedRouteTarget")).length).toBeGreaterThan(0);
    });
  });

  describe("autoIndexOnStartup", () => {
    function startWorker(checkout: string, host: HostMode, indexer: Indexer): ParsedCodebaseIndexConfig {
      const config = mergedConfig(checkout, host);
      configureAutoIndex(checkout, host, config, () => indexer);
      configureBackgroundWorker(checkout, host, config, {
        startAutoIndex: (source) => {
          startAutoIndexForBackgroundWorker(checkout, host, source);
        },
        stopAutoIndex: () => stopAutoIndexForBackgroundWorker(checkout, host),
      });
      return config;
    }

    it("gates only the startup run per checkout role", async () => {
      writeRepoConfig();
      const startPrimary = vi.fn();
      const startSecondary = vi.fn();
      const stop = vi.fn(async () => ({ completed: true as const, completion: Promise.resolve() }));
      configureBackgroundWorker(mainRoot, "codex", mergedConfig(mainRoot, "codex"), {
        startAutoIndex: startPrimary,
        stopAutoIndex: stop,
      });
      configureBackgroundWorker(worktreeRoot, "codex", mergedConfig(worktreeRoot, "codex"), {
        startAutoIndex: startSecondary,
        stopAutoIndex: stop,
      });
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(mainRoot, "codex")).toBe(true));
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(worktreeRoot, "codex")).toBe(true));
      expect(startPrimary).toHaveBeenCalledWith("startup");
      expect(startSecondary).not.toHaveBeenCalled();
    });

    it("refreshes a fresh secondary on retrieval, from the leader and from a follower", async () => {
      writeRepoConfig();
      const leaderIndexer = createIndexer(worktreeRoot, "codex");
      const leaderIndex = vi.spyOn(leaderIndexer, "index");
      const leaderConfig = startWorker(worktreeRoot, "codex", leaderIndexer);
      expect(leaderConfig.indexing).toMatchObject({ autoIndex: true, autoIndexOnStartup: false });
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(worktreeRoot, "codex")).toBe(true));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(leaderIndex).not.toHaveBeenCalled();

      const followerIndexer = createIndexer(worktreeRoot, "jcode");
      const followerIndex = vi.spyOn(followerIndexer, "index");
      startWorker(worktreeRoot, "jcode", followerIndexer);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(isBackgroundWorkerLeader(worktreeRoot, "jcode")).toBe(false);

      await expect(waitForAutoIndexForRetrieval(worktreeRoot, "jcode")).resolves.toMatchObject({ ready: true });
      // One process shares one coordinator per checkout and store, so the leader's
      // worker runs the refresh with the latest registered indexer: exactly one run.
      expect(leaderIndex.mock.calls.length + followerIndex.mock.calls.length).toBe(1);
      expect((await followerIndexer.search("sharedRouteTarget")).length).toBeGreaterThan(0);

      await expect(waitForAutoIndexForRetrieval(worktreeRoot, "codex")).resolves.toMatchObject({ ready: true });
      expect(leaderIndex.mock.calls.length + followerIndex.mock.calls.length).toBe(1);
      expect((await leaderIndexer.search("sharedRouteTarget")).length).toBeGreaterThan(0);
    });
  });

  describe("status", () => {
    it("appends the store, source and role to index_status", async () => {
      writeRepoConfig();
      await createIndexer(mainRoot, "claude").index();
      const result = await executeIndexStatus(worktreeRoot, "claude");
      const text = JSON.stringify(result);
      expect(text).toContain(`Store: ${store} (repository default store)`);
      expect(text).toContain("Checkout role: secondary - linked worktree");
    });
  });
});
