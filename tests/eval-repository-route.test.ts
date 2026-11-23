import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getRepositoryConfigPath,
  resetRepositoryRoutesForTests,
  resolveMatchedRepositoryRoute,
  type RepositoryRoute,
} from "../src/config/repository-route.js";
import { parseConfig } from "../src/config/schema.js";
import { loadParsedConfig } from "../src/eval/runner-config.js";
import { runEvaluation } from "../src/eval/runner.js";
import { Indexer } from "../src/indexer/index.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

const PROVIDER_SETTINGS = {
  embeddingProvider: "custom",
  customProvider: {
    baseUrl: "http://localhost:11434/v1",
    model: "mock-embedding-model",
    dimensions: 8,
  },
  indexing: { watchFiles: false },
};

describe("eval runner with a repository config", () => {
  let tempDir: string;
  let mainRoot: string;
  let worktreeRoot: string;
  let commonDir: string;
  let datasetPath: string;

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-repository-route-")));
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(mainRoot);
    git(mainRoot, "init", "-q", "-b", "main");
    git(mainRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-q", "-m", "fixture");
    worktreeRoot = path.join(tempDir, "repo-feature");
    git(mainRoot, "worktree", "add", "-q", "-b", "feature", worktreeRoot);
    commonDir = fs.realpathSync(path.join(mainRoot, ".git"));

    datasetPath = path.join(tempDir, "dataset.json");
    writeJson(datasetPath, {
      version: "1.0.0",
      name: "small",
      queries: [{
        id: "q1",
        query: "where is rankHybridResults implementation",
        queryType: "definition",
        retrievalMode: "context",
        expected: { filePath: "src/index.ts", symbol: "rankHybridResults" },
      }],
    });
  });

  afterEach(() => {
    resetRepositoryRoutesForTests();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRepoConfig(value: Record<string, unknown>): void {
    writeJson(getRepositoryConfigPath(commonDir), { ...PROVIDER_SETTINGS, ...value });
    resetRepositoryRoutesForTests();
  }

  function routeFor(checkout: string): RepositoryRoute {
    const route = resolveMatchedRepositoryRoute(checkout, "opencode");
    if (!route) throw new Error(`expected a routed checkout at ${checkout}`);
    return route;
  }

  function checkoutWithRole(role: "primary" | "secondary"): string {
    const match = [mainRoot, worktreeRoot].find((checkout) => routeFor(checkout).role === role);
    if (!match) throw new Error(`no ${role} checkout`);
    return match;
  }

  it("reads the repository config settings when --config is absent", () => {
    writeRepoConfig({ search: { maxResults: 7, rrfK: 77 } });

    for (const checkout of [mainRoot, worktreeRoot]) {
      const config = loadParsedConfig(checkout);
      expect(config.search.maxResults).toBe(7);
      expect(config.search.rrfK).toBe(77);
      expect(config.embeddingProvider).toBe("custom");
    }
  });

  it("lets an explicit --config replace every setting, including the repository config", () => {
    writeRepoConfig({ search: { maxResults: 7, rrfK: 77 } });
    const explicitPath = path.join(tempDir, "explicit.json");
    writeJson(explicitPath, { search: { maxResults: 3 } });

    const config = loadParsedConfig(worktreeRoot, explicitPath);

    expect(config.search.maxResults).toBe(3);
    expect(config.search.rrfK).toBe(parseConfig({}).search.rrfK);
    expect(config.embeddingProvider).toBe(parseConfig({}).embeddingProvider);
  });

  for (const role of ["primary", "secondary"] as const) {
    it(`refuses project-scope --reindex in the ${role} checkout before writing or deleting anything`, async () => {
      writeRepoConfig({});
      const checkout = checkoutWithRole(role);
      const route = routeFor(checkout);
      expect(loadParsedConfig(checkout).scope).toBe("project");
      const storePath = route.indexPath;
      if (!storePath) throw new Error("expected a shared store path");

      const storeSentinel = path.join(storePath, "sentinel");
      const localSentinel = path.join(checkout, ".opencode", "index", "sentinel");
      writeJson(storeSentinel, {});
      writeJson(localSentinel, {});
      const indexSpy = vi.spyOn(Indexer.prototype, "index");

      const run = runEvaluation({
        projectRoot: checkout,
        datasetPath,
        outputRoot: path.join(tempDir, "results"),
        reindex: true,
      });

      await expect(run).rejects.toThrow("Refusing evaluation --reindex");
      await expect(run).rejects.toThrow(storePath);
      expect(indexSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(checkout, ".opencode", "codebase-index.json"))).toBe(false);
      expect(fs.existsSync(storeSentinel)).toBe(true);
      expect(fs.existsSync(localSentinel)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "results"))).toBe(false);
    });
  }

  it("keeps the legacy --reindex path: local config copy and local index cleared", async () => {
    expect(resolveMatchedRepositoryRoute(worktreeRoot, "opencode")).toBeNull();
    writeJson(path.join(mainRoot, ".opencode", "codebase-index.json"), {
      ...PROVIDER_SETTINGS,
      search: { maxResults: 5 },
    });
    const mainSentinel = path.join(mainRoot, ".opencode", "index", "sentinel");
    const localSentinel = path.join(worktreeRoot, ".opencode", "index", "sentinel");
    writeJson(mainSentinel, {});
    writeJson(localSentinel, {});
    vi.spyOn(Indexer.prototype, "index").mockRejectedValue(new Error("stop after reindex preparation"));

    await expect(runEvaluation({
      projectRoot: worktreeRoot,
      datasetPath,
      outputRoot: path.join(tempDir, "results"),
      reindex: true,
    })).rejects.toThrow("stop after reindex preparation");

    const localConfigPath = path.join(worktreeRoot, ".opencode", "codebase-index.json");
    expect(JSON.parse(fs.readFileSync(localConfigPath, "utf-8"))).toMatchObject({ search: { maxResults: 5 } });
    expect(fs.existsSync(localSentinel)).toBe(false);
    expect(fs.existsSync(mainSentinel)).toBe(true);
  });
});
