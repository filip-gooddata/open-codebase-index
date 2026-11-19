import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const autoIndexMocks = vi.hoisted(() => ({
  configureAutoIndex: vi.fn(),
  requestBackgroundIndex: vi.fn(),
}));

vi.mock("../src/utils/auto-index.js", () => ({
  configureAutoIndex: autoIndexMocks.configureAutoIndex,
  requestBackgroundIndex: autoIndexMocks.requestBackgroundIndex,
}));

vi.mock("../src/tools/operations.js", () => ({
  refreshIndexerForDirectory: vi.fn(),
}));

import type { Indexer } from "../src/indexer/index.js";
import { loadMergedConfig } from "../src/config/merger.js";
import { getRepositoryConfigPath, resetRepositoryRoutesForTests } from "../src/config/repository-route.js";
import { parseConfig, type ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { createWatcherWithIndexer, type CombinedWatcher } from "../src/watcher/index.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

const stubIndexer = {} as Indexer;

describe("watcher startup catch-up and autoIndexOnStartup", () => {
  let tempDir: string;
  let mainRoot: string;
  let worktreeRoot: string;
  let commonDir: string;
  const watchers: CombinedWatcher[] = [];

  function writeRepoConfig(checkouts: Record<string, unknown> = {}): void {
    writeJson(getRepositoryConfigPath(commonDir), {
      include: ["**/*.ts"],
      indexing: { autoIndex: true, watchFiles: true, autoGc: false, requireProjectMarker: false },
      checkouts,
    });
  }

  function startWatcher(checkout: string, config: ParsedCodebaseIndexConfig): CombinedWatcher {
    const watcher = createWatcherWithIndexer(() => stubIndexer, checkout, config, "claude");
    watchers.push(watcher);
    return watcher;
  }

  async function expectLaterChangeTriggersIndex(checkout: string): Promise<void> {
    const target = path.join(checkout, "src", "later.ts");
    const startedAt = Date.now();
    let attempt = 0;
    let lastError: unknown;
    while (Date.now() - startedAt < 10000) {
      fs.writeFileSync(target, `export const later = ${attempt++};\n`);
      try {
        await vi.waitFor(
          () => expect(autoIndexMocks.requestBackgroundIndex).toHaveBeenCalledWith(checkout, "claude"),
          { timeout: 2500, interval: 50 },
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    autoIndexMocks.configureAutoIndex.mockReset();
    autoIndexMocks.requestBackgroundIndex.mockReset();
    autoIndexMocks.requestBackgroundIndex.mockReturnValue(Promise.resolve({ outcome: "completed" }));
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-watcher-")));
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    git(mainRoot, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(mainRoot, "src", "entry.ts"), "export const entry = 1;\n");
    git(mainRoot, "add", "src/entry.ts");
    git(mainRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture");
    worktreeRoot = path.join(tempDir, "repo-feature");
    git(mainRoot, "worktree", "add", "-q", "-b", "feature", worktreeRoot);
    commonDir = fs.realpathSync(path.join(mainRoot, ".git"));
  });

  afterEach(async () => {
    for (const watcher of watchers.splice(0)) {
      await watcher.stop();
    }
    resetRepositoryRoutesForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips the readiness catch-up when autoIndexOnStartup is false but still indexes later changes", async () => {
    const config = parseConfig({
      include: ["**/*.ts"],
      indexing: { autoIndex: true, watchFiles: true, autoIndexOnStartup: false, requireProjectMarker: false },
    });
    const watcher = startWatcher(mainRoot, config);

    await watcher.whenReady();
    expect(autoIndexMocks.requestBackgroundIndex).not.toHaveBeenCalled();

    await expectLaterChangeTriggersIndex(mainRoot);
  });

  it("requests the readiness catch-up when autoIndexOnStartup is true", async () => {
    const config = parseConfig({
      include: ["**/*.ts"],
      indexing: { autoIndex: true, watchFiles: true, autoIndexOnStartup: true, requireProjectMarker: false },
    });
    const watcher = startWatcher(mainRoot, config);

    await watcher.whenReady();
    expect(autoIndexMocks.requestBackgroundIndex).toHaveBeenCalledTimes(1);
    expect(autoIndexMocks.requestBackgroundIndex).toHaveBeenCalledWith(mainRoot, "claude");
  });

  it("requests the readiness catch-up when autoIndexOnStartup is unset", async () => {
    const config = parseConfig({
      include: ["**/*.ts"],
      indexing: { autoIndex: true, watchFiles: true, requireProjectMarker: false },
    });
    expect(config.indexing.autoIndexOnStartup).toBe(true);
    const watcher = startWatcher(mainRoot, config);

    await watcher.whenReady();
    expect(autoIndexMocks.requestBackgroundIndex).toHaveBeenCalledTimes(1);
  });

  it("applies a secondary role's autoIndexOnStartup override to the catch-up only on that checkout", async () => {
    writeRepoConfig({ secondary: { autoIndexOnStartup: false } });

    const secondaryConfig = parseConfig(loadMergedConfig(worktreeRoot, "claude"));
    expect(secondaryConfig.indexing.watchFiles).toBe(true);
    expect(secondaryConfig.indexing.autoIndexOnStartup).toBe(false);
    const secondary = startWatcher(worktreeRoot, secondaryConfig);
    await secondary.whenReady();
    expect(autoIndexMocks.requestBackgroundIndex).not.toHaveBeenCalled();
    await expectLaterChangeTriggersIndex(worktreeRoot);

    autoIndexMocks.requestBackgroundIndex.mockClear();
    const primaryConfig = parseConfig(loadMergedConfig(mainRoot, "claude"));
    expect(primaryConfig.indexing.autoIndexOnStartup).toBe(true);
    const primary = startWatcher(mainRoot, primaryConfig);
    await primary.whenReady();
    expect(autoIndexMocks.requestBackgroundIndex).toHaveBeenCalledWith(mainRoot, "claude");
  });
});
