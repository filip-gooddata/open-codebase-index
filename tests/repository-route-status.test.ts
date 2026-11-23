import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { loadMergedConfig } from "../src/config/merger.js";
import { resolveGlobalConfigPath, resolveGlobalIndexPath, resolveProjectIndexPath } from "../src/config/paths.js";
import {
  formatRepositoryRouteStatus,
  getRepositoryConfigPath,
  resetRepositoryRoutesForTests,
  resolveMatchedRepositoryRoute,
} from "../src/config/repository-route.js";
import codebaseIndexOmpExtension from "../src/omp-extension.js";
import codebaseIndexPiExtension from "../src/pi-extension.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { executeIndexStatus } from "../src/tools/execute-common.js";
import { getIndexerForProject, initializeTools } from "../src/tools/operation-runtime.js";
import { getIndexStatus } from "../src/tools/operations.js";
import { TOOL_NAME } from "../src/tools/tool-names.js";
import { formatStatus } from "../src/tools/utils.js";

const HOSTS: HostMode[] = ["claude", "codex", "pi", "opencode", "jcode"];

interface StatusTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd?: string },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

type PiExtensionApi = Parameters<typeof codebaseIndexPiExtension>[0];
type OmpExtensionApi = Parameters<typeof codebaseIndexOmpExtension>[0];

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function clearGlobals(): void {
  for (const host of HOSTS) {
    fs.rmSync(resolveGlobalConfigPath(host), { force: true });
  }
}

function statusToolFor(extension: "pi" | "omp"): StatusTool {
  const tools: StatusTool[] = [];
  const api = {
    registerTool(tool: StatusTool) {
      tools.push(tool);
    },
    on() {},
  };
  if (extension === "pi") {
    codebaseIndexPiExtension(api as unknown as PiExtensionApi);
  } else {
    codebaseIndexOmpExtension(api as unknown as OmpExtensionApi);
  }
  const tool = tools.find((candidate) => candidate.name === TOOL_NAME.INDEX_STATUS);
  if (!tool) throw new Error("index status tool was not registered");
  return tool;
}

async function runStatusTool(extension: "pi" | "omp", cwd: string): Promise<string> {
  const result = await statusToolFor(extension).execute("call", {}, undefined, undefined, { cwd });
  return result.content.map((part) => part.text).join("");
}

describe("repository route status and config reads", () => {
  let tempDir: string;
  let mainRoot: string;
  let worktreeRoot: string;
  let commonDir: string;
  let configPath: string;

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    clearGlobals();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-status-")));
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(mainRoot, { recursive: true });
    git(mainRoot, "init", "-b", "main");
    git(mainRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "fixture");
    worktreeRoot = path.join(tempDir, "repo-feature");
    git(mainRoot, "worktree", "add", "-b", "feature", worktreeRoot);
    commonDir = fs.realpathSync(path.join(mainRoot, ".git"));
    configPath = getRepositoryConfigPath(commonDir);
  });

  afterEach(() => {
    resetRepositoryRoutesForTests();
    clearGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("reading the repository config", () => {
    it("keeps a genuinely absent config on the legacy path", () => {
      expect(resolveMatchedRepositoryRoute(worktreeRoot, "claude")).toBeNull();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      resetRepositoryRoutesForTests();
      expect(resolveMatchedRepositoryRoute(worktreeRoot, "claude")).toBeNull();
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "fails closed, naming the file, when the config cannot be read",
      () => {
        writeJson(configPath, {});
        fs.chmodSync(configPath, 0o000);
        try {
          for (const host of HOSTS) {
            expect(() => resolveProjectIndexPath(worktreeRoot, "project", host))
              .toThrow(`Failed to read repository config ${configPath}`);
          }
          expect(formatRepositoryRouteStatus(worktreeRoot, "claude", "unused"))
            .toContain(`Repository route error: Failed to read repository config ${configPath}`);
        } finally {
          fs.chmodSync(configPath, 0o600);
        }
      },
    );

    it.skipIf(process.platform === "win32")("fails closed on a dangling symbolic link at the config path", () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(path.join(tempDir, "missing.json"), configPath);
      expect(() => resolveProjectIndexPath(mainRoot, "project", "claude"))
        .toThrow(`Failed to read repository config ${configPath}: it is a symbolic link whose target does not exist`);
    });

    it("fails closed when the config path is a directory", () => {
      fs.mkdirSync(configPath, { recursive: true });
      expect(() => resolveProjectIndexPath(mainRoot, "project", "codex"))
        .toThrow(`Failed to read repository config ${configPath}`);
    });

    it.each([
      ["indexing", { indexing: true }, "field 'indexing' must be an object."],
      ["search", { search: [] }, "field 'search' must be an object."],
      ["include", { include: "src/**" }, "field 'include' must be an array of strings."],
      ["knowledgeBases", { knowledgeBases: [1] }, "field 'knowledgeBases' must be an array of strings."],
      ["embeddingFallback", { embeddingFallback: true }, "field 'embeddingFallback' must be an object or false."],
    ])("rejects a bad '%s' section shape at route time", (_label, value, message) => {
      writeJson(configPath, value);
      for (const host of HOSTS) {
        resetRepositoryRoutesForTests();
        expect(() => resolveMatchedRepositoryRoute(worktreeRoot, host))
          .toThrow(`Config file ${configPath} ${message}`);
        expect(() => loadMergedConfig(worktreeRoot, host)).toThrow(`Config file ${configPath} ${message}`);
      }
    });
    it("rejects a non-boolean indexing.autoIndexOnStartup, naming the file and field", () => {
      writeJson(configPath, { indexing: { autoIndexOnStartup: "no" } });
      const message = `Repository config ${configPath} field 'indexing.autoIndexOnStartup' must be a boolean.`;
      for (const host of HOSTS) {
        resetRepositoryRoutesForTests();
        expect(() => resolveProjectIndexPath(worktreeRoot, "project", host)).toThrow(message);
        expect(() => loadMergedConfig(worktreeRoot, host)).toThrow(message);
      }
    });
  });

  describe("status route block", () => {
    it("labels a global-scope store without a checkout role", () => {
      writeJson(configPath, {});
      const globalStore = resolveGlobalIndexPath("claude");
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", globalStore, { scope: "global" }))
        .toBe(`Store: ${globalStore} (global scope)`);
      expect(formatRepositoryRouteStatus(mainRoot, "claude", globalStore, { scope: "global", omitLegacy: true }))
        .toBe(`Store: ${globalStore} (global scope)`);

      fs.rmSync(configPath);
      resetRepositoryRoutesForTests();
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", globalStore, { scope: "global" }))
        .toBe(`Store: ${globalStore} (global scope)`);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", globalStore, { scope: "global", omitLegacy: true }))
        .toBe("");
    });

    it("reports global scope when the repository store is the host global index", async () => {
      const globalStore = resolveGlobalIndexPath("claude");
      writeJson(configPath, { storage: { indexPath: globalStore } });
      const routeBlock = await statusWithExplicitConfig("global");
      expect(routeBlock).toBe(`Store: ${path.join(globalStore, "structural")} (global scope)`);
    });

    it("labels the store the indexer inspected even if the config is reloaded mid-request", async () => {
      writeJson(configPath, {});
      const store = path.join(commonDir, "codebase-index", "index");
      initializeTools(worktreeRoot, parseConfig({
        scope: "project",
        indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
      }), "claude");
      const inspected = getIndexerForProject(worktreeRoot, "claude");
      const originalGetStatus = Indexer.prototype.getStatus;
      const spy = vi.spyOn(Indexer.prototype, "getStatus").mockImplementation(async function (this: Indexer) {
        const status = await originalGetStatus.call(this);
        // A watcher config reload swaps in a global-scope indexer while this request is in flight.
        initializeTools(worktreeRoot, parseConfig({
          scope: "global",
          indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
        }), "claude");
        return status;
      });
      try {
        const result = await executeIndexStatus(worktreeRoot, "claude");
        const routeBlock = result.text.slice(result.text.lastIndexOf("\n\n") + 2);
        expect(routeBlock.split("\n")[0]).toBe(`Store: ${path.join(store, "structural")} (repository default store)`);
        expect(routeBlock).toContain("Checkout role: secondary - linked worktree");
      } finally {
        spy.mockRestore();
        await inspected.close();
        await getIndexerForProject(worktreeRoot, "claude").close();
      }
    });

    it("index_status uses the effective global scope", async () => {
      writeJson(configPath, {});
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), { scope: "global" });
      const result = await executeIndexStatus(worktreeRoot, "claude");
      const routeBlock = result.text.slice(result.text.lastIndexOf("\n\n") + 2);
      expect(routeBlock).toMatch(/^Store: .+ \(global scope\)$/);
      expect(result.text).not.toContain("Checkout role:");
      expect(result.text).not.toContain("repository default store");
    });

    async function statusWithExplicitConfig(scope: "global" | "project"): Promise<string> {
      initializeTools(worktreeRoot, parseConfig({
        scope,
        indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
      }), "claude");
      try {
        const result = await executeIndexStatus(worktreeRoot, "claude");
        return result.text.slice(result.text.lastIndexOf("\n\n") + 2);
      } finally {
        await getIndexerForProject(worktreeRoot, "claude").close();
      }
    }

    it("index_status labels the store with the explicit config's global scope", async () => {
      writeJson(configPath, { scope: "project" });
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), { scope: "project" });
      const routeBlock = await statusWithExplicitConfig("global");
      expect(routeBlock).toMatch(/^Store: .+ \(global scope\)$/);
      expect(routeBlock).not.toContain("Checkout role:");
    });

    it("index_status keeps the routed project store when the explicit config overrides a global scope", async () => {
      writeJson(configPath, {});
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), { scope: "global" });
      const routeBlock = await statusWithExplicitConfig("project");
      expect(routeBlock).not.toContain("(global scope)");
      expect(routeBlock).toContain("Checkout role:");
    });

    it.each(["pi", "omp"] as const)("%s status appends the route block for a routed checkout", async (extension) => {
      writeJson(configPath, {});
      const store = path.join(commonDir, "codebase-index", "index");
      const text = await runStatusTool(extension, worktreeRoot);
      const status = await getIndexStatus(worktreeRoot, "pi");
      expect(text.startsWith(formatStatus(status))).toBe(true);
      expect(text).toContain(`Store: ${store} (repository default store)`);
      expect(text).toContain("Checkout role: secondary - linked worktree");
    });

    it.each(["pi", "omp"] as const)("%s status is unchanged for a legacy checkout", async (extension) => {
      const text = await runStatusTool(extension, mainRoot);
      const status = await getIndexStatus(mainRoot, "pi");
      expect(text).toBe(formatStatus(status));
      expect(text).not.toContain("Store:");
    });
  });
});
