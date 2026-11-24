import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { loadMergedConfig } from "../src/config/merger.js";
import { resolveProjectIndexPath } from "../src/config/paths.js";
import { getRepositoryConfigPath, resetRepositoryRoutesForTests } from "../src/config/repository-route.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { createMcpServer } from "../src/mcp-server.js";
import { resetAutoIndexCoordinatorsForTests } from "../src/utils/auto-index.js";
import {
  getBackgroundWorkerLeasePath,
  isBackgroundWorkerLeader,
  resetBackgroundWorkersForTests,
} from "../src/utils/background-worker.js";

const HOST: HostMode = "codex";
const FOLLOWER_HOST: HostMode = "jcode";
const DEAD_OWNER_TOKEN = "55555555-5555-4555-8555-555555555555";

const EMBEDDING_CONFIG = {
  embeddingProvider: "custom",
  customProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "route-test", dimensions: 8 },
  include: ["**/*.ts"],
};

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeDeadOwner(storePath: string, owner: Record<string, unknown>): void {
  const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const lockPath = path.join(storePath, "indexing.lock");
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
    pid: deadProcess.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    token: DEAD_OWNER_TOKEN,
    ...owner,
  }));
}

describe("repository config file through indexing and the MCP server", () => {
  let tempDir: string;
  let cleanupDir: string | undefined;
  let mainRoot: string;
  const indexers: Indexer[] = [];
  const closers: Array<() => Promise<void>> = [];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function createIndexer(checkout: string): Indexer {
    const indexer = new Indexer(checkout, parseConfig(loadMergedConfig(checkout, HOST)), HOST);
    indexers.push(indexer);
    return indexer;
  }

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-indexing-"));
    tempDir = fs.realpathSync(cleanupDir);
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    git(mainRoot, "init", "-q", "-b", "main");
    fs.writeFileSync(
      path.join(mainRoot, "src", "retry.ts"),
      "export function retryFailedRequest(attempts: number): number {\n  return attempts + 1;\n}\n",
    );
    git(mainRoot, "add", "src/retry.ts");
    git(mainRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture");

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({
        data: input.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
        usage: { total_tokens: input.length },
      }));
    });
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    const attempt = async (step: () => unknown): Promise<void> => {
      try {
        await step();
      } catch (error: unknown) {
        failures.push(error);
      }
    };
    for (const close of closers.splice(0).reverse()) {
      await attempt(close);
    }
    await attempt(resetAutoIndexCoordinatorsForTests);
    await attempt(resetBackgroundWorkersForTests);
    for (const indexer of indexers.splice(0)) {
      await attempt(() => indexer.close());
    }
    resetRepositoryRoutesForTests();
    vi.restoreAllMocks();
    if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
    if (failures.length > 0) throw failures[0];
  });

  describe("bare-base secondaries", () => {
    let bareDir: string;
    let firstRoot: string;
    let secondRoot: string;
    let store: string;

    function writeBareConfig(extra: Record<string, unknown> = {}): void {
      writeJson(getRepositoryConfigPath(bareDir), {
        ...EMBEDDING_CONFIG,
        indexing: { autoIndex: false, watchFiles: false, autoGc: false, requireProjectMarker: false },
        search: { minScore: 0 },
        ...extra,
      });
    }

    beforeEach(() => {
      const bareSpelling = path.join(tempDir, "repo.git");
      git(tempDir, "clone", "-q", "--bare", mainRoot, bareSpelling);
      bareDir = fs.realpathSync(bareSpelling);
      firstRoot = path.join(tempDir, "bare-first");
      secondRoot = path.join(tempDir, "bare-second");
      git(bareDir, "worktree", "add", "-q", firstRoot, "main");
      git(bareDir, "worktree", "add", "-q", "-b", "second", secondRoot, "main");
      store = path.join(bareDir, "codebase-index", "index");
    });

    it("recovers an interrupted index and refuses force when no primary is configured", async () => {
      writeBareConfig();
      expect(resolveProjectIndexPath(firstRoot, "project", HOST)).toBe(store);
      writeDeadOwner(store, { operation: "index" });

      const secondary = createIndexer(firstRoot);
      const stats = await secondary.index();
      expect(stats.failedChunks).toBe(0);
      expect(stats.indexedChunks).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(store, "indexing.lock", "owner.json"))).toBe(false);
      expect((await secondary.search("retryFailedRequest")).length).toBeGreaterThan(0);

      await expect(secondary.forceIndex()).rejects.toThrow(
        `once checkouts.primary.path is set in ${getRepositoryConfigPath(bareDir)}`,
      );
    });

    it("recovers a clear the configured primary started and keeps force on that primary", async () => {
      writeBareConfig({ checkouts: { primary: { path: secondRoot } } });
      const primary = createIndexer(secondRoot);
      expect((await primary.index()).indexedChunks).toBeGreaterThan(0);
      writeDeadOwner(store, {
        operation: "clear",
        recoveryProtocolVersion: 1,
        clearRecovery: {
          phase: "clearing",
          embeddingProvider: "custom",
          embeddingModel: "route-test",
          embeddingDimensions: 8,
          embeddingStrategyVersion: "2",
          compatibilityDecision: "compatible",
        },
      });

      const secondary = createIndexer(firstRoot);
      const stats = await secondary.index();
      expect(stats.failedChunks).toBe(0);
      expect(stats.indexedChunks).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(store, "indexing.lock", "owner.json"))).toBe(false);
      expect((await secondary.search("retryFailedRequest")).length).toBeGreaterThan(0);

      await expect(secondary.forceIndex()).rejects.toThrow(
        "Project-scoped force rebuild is limited to the primary checkout of a shared repository store.",
      );
      await expect(primary.forceIndex()).resolves.toMatchObject({ failedChunks: 0 });
    });
  });

  describe("autoIndexOnStartup through MCP servers", () => {
    const baseIndexing = {
      autoIndex: true,
      watchFiles: false,
      autoGc: false,
      requireProjectMarker: false,
      retries: 0,
      autoIndexWaitMs: 20_000,
    };
    let worktreeRoot: string;
    let commonDir: string;

    beforeEach(() => {
      worktreeRoot = path.join(tempDir, "repo-fresh");
      git(mainRoot, "worktree", "add", "-q", "-b", "fresh", worktreeRoot);
      commonDir = fs.realpathSync(path.join(mainRoot, ".git"));
    });

    function startServer(checkout: string, host: HostMode): ReturnType<typeof createMcpServer> {
      const server = createMcpServer(checkout, parseConfig(loadMergedConfig(checkout, host)), host);
      closers.push(async () => {
        await server.close();
      });
      return server;
    }

    async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
      const client = new Client({ name: "repository-route-indexing", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      closers.push(async () => {
        await client.close();
      });
      return client;
    }

    it.each([
      {
        name: "secondary role override",
        repository: { indexing: baseIndexing, checkouts: { secondary: { autoIndexOnStartup: false } } },
      },
      {
        name: "repository indexing setting",
        repository: { indexing: { ...baseIndexing, autoIndexOnStartup: false } },
      },
    ])("skips the startup run and indexes on a follower's first retrieval ($name)", async ({ repository }) => {
      writeJson(getRepositoryConfigPath(commonDir), { ...EMBEDDING_CONFIG, search: { minScore: 0 }, ...repository });
      expect(parseConfig(loadMergedConfig(worktreeRoot, HOST)).indexing.autoIndexOnStartup).toBe(false);

      // A second host gets its own worker in this process; both contend for the
      // one background lease of this checkout and store, so the second follows.
      startServer(worktreeRoot, HOST);
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(worktreeRoot, HOST)).toBe(true));
      const follower = startServer(worktreeRoot, FOLLOWER_HOST);
      expect(getBackgroundWorkerLeasePath(worktreeRoot, parseConfig(loadMergedConfig(worktreeRoot, FOLLOWER_HOST)), FOLLOWER_HOST))
        .toBe(getBackgroundWorkerLeasePath(worktreeRoot, parseConfig(loadMergedConfig(worktreeRoot, HOST)), HOST));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(commonDir, "codebase-index", "index", "codebase.db"))).toBe(false);

      expect(isBackgroundWorkerLeader(worktreeRoot, FOLLOWER_HOST)).toBe(false);
      expect(isBackgroundWorkerLeader(worktreeRoot, HOST)).toBe(true);

      const client = await connect(follower);
      const result = await client.callTool({
        name: "codebase_search",
        arguments: { query: "retry failed request", limit: 2 },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("retry.ts");
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("still runs the startup index on a secondary when the key is absent", async () => {
      writeJson(getRepositoryConfigPath(commonDir), { ...EMBEDDING_CONFIG, search: { minScore: 0 }, indexing: baseIndexing });
      expect(parseConfig(loadMergedConfig(worktreeRoot, HOST)).indexing.autoIndexOnStartup).toBe(true);

      startServer(worktreeRoot, HOST);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled(), { timeout: 20_000 });
    });
  });
});
