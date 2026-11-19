import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { loadMergedConfig } from "../src/config/merger.js";
import {
  getProjectConfigCandidatePaths,
  isProjectIndexPathOwnedByProject,
  resolveGlobalConfigPath,
  resolveProjectIndexPath,
} from "../src/config/paths.js";
import {
  formatRepositoryRouteStatus,
  resetRepositoryRoutesForTests,
  resolveMatchedRepositoryRoute,
  resolveRepositoryRoute,
} from "../src/config/repository-route.js";
import { parseConfig } from "../src/config/schema.js";
import { resolveRepositoryLayout } from "../src/git/layout.js";

const HOSTS: HostMode[] = ["claude", "codex", "pi", "opencode", "jcode"];

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(directory: string): void {
  git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-m", "fixture");
}

function real(filePath: string): string {
  return fs.realpathSync(filePath);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function globalConfigFile(host: HostMode): string {
  const home = os.homedir();
  if (host === "claude") return path.join(home, ".claude", "codebase-index.json");
  if (host === "opencode") return path.join(home, ".config", "opencode", "codebase-index.json");
  return path.join(home, ".config", "codebase-index", "config.json");
}

function writeGlobal(host: HostMode, value: unknown): void {
  writeJson(globalConfigFile(host), value);
}

function clearGlobals(): void {
  for (const host of HOSTS) {
    fs.rmSync(globalConfigFile(host), { force: true });
  }
}

describe("repository map routing", () => {
  let tempDir: string;
  let mainRoot: string;
  let worktreeRoot: string;
  let commonDir: string;

  function normalClone(): void {
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(mainRoot, { recursive: true });
    git(mainRoot, "init", "-b", "main");
    commit(mainRoot);
    worktreeRoot = path.join(tempDir, "repo-feature");
    git(mainRoot, "worktree", "add", "-b", "feature", worktreeRoot);
    commonDir = real(path.join(mainRoot, ".git"));
  }

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    clearGlobals();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-"));
  });

  afterEach(() => {
    resetRepositoryRoutesForTests();
    clearGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("layout", () => {
    it("resolves a normal clone and its linked worktree to one common dir", () => {
      normalClone();
      const main = resolveRepositoryLayout(mainRoot);
      const linked = resolveRepositoryLayout(worktreeRoot);

      expect(main).toMatchObject({
        checkoutRoot: real(mainRoot),
        commonDir,
        gitDir: commonDir,
        linked: false,
        bare: false,
        mainWorktree: real(mainRoot),
      });
      expect(linked).toMatchObject({
        checkoutRoot: real(worktreeRoot),
        commonDir,
        linked: true,
        bare: false,
        mainWorktree: real(mainRoot),
      });
      expect(linked?.gitDir).not.toBe(commonDir);
      expect(resolveRepositoryLayout(tempDir)).toBeNull();
    });

    it("resolves worktrees of a bare clone with no main worktree", () => {
      normalClone();
      const bareDir = path.join(tempDir, "bare.git");
      git(tempDir, "clone", "--bare", mainRoot, bareDir);
      const bareWorktree = path.join(tempDir, "bare-main");
      git(bareDir, "worktree", "add", bareWorktree, "main");

      expect(resolveRepositoryLayout(bareWorktree)).toMatchObject({
        checkoutRoot: real(bareWorktree),
        commonDir: real(bareDir),
        linked: true,
        bare: true,
        mainWorktree: null,
      });
    });

    it("accepts a separate git dir that is not named .git", () => {
      const checkout = path.join(tempDir, "checkout");
      const storeDir = path.join(tempDir, "store.git");
      git(tempDir, "init", "-b", "main", `--separate-git-dir=${storeDir}`, checkout);
      commit(checkout);
      const linked = path.join(tempDir, "checkout-linked");
      git(checkout, "worktree", "add", "-b", "other", linked);

      expect(resolveRepositoryLayout(checkout)).toMatchObject({
        commonDir: real(storeDir),
        linked: false,
        bare: false,
        mainWorktree: null,
      });
      expect(resolveRepositoryLayout(linked)).toMatchObject({
        commonDir: real(storeDir),
        linked: true,
        mainWorktree: null,
      });
    });
  });

  describe("store", () => {
    it("routes every checkout and host mode to the default shared store", () => {
      normalClone();
      const expected = path.join(commonDir, "codebase-index", "index");
      for (const host of HOSTS) {
        writeGlobal(host, { repositories: { [path.join(mainRoot, ".git")]: {} } });
      }

      for (const host of HOSTS) {
        expect(resolveProjectIndexPath(mainRoot, "project", host)).toBe(expected);
        expect(resolveProjectIndexPath(worktreeRoot, "project", host)).toBe(expected);
        expect(resolveRepositoryRoute(worktreeRoot, host).storeSource).toBe("repository default");
      }
    });

    it("resolves storage.indexPath as absolute, home-relative, or relative to the common dir", () => {
      normalClone();
      const key = path.join(mainRoot, ".git");
      const absolute = path.join(tempDir, "shared-index");

      writeGlobal("claude", { repositories: { [key]: { storage: { indexPath: absolute } } } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(absolute);
      expect(resolveRepositoryRoute(worktreeRoot, "claude").storeSource).toBe("repository map");

      resetRepositoryRoutesForTests();
      writeGlobal("claude", { repositories: { [key]: { storage: { indexPath: "~/indexes/repo" } } } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(os.homedir(), "indexes", "repo"));

      resetRepositoryRoutesForTests();
      writeGlobal("claude", { repositories: { [key]: { storage: { indexPath: "store/index" } } } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(commonDir, "store", "index"));
    });

    it("matches keys written with ~ or through a symlink by realpath", () => {
      const homeRepo = path.join(os.homedir(), "src", "repo");
      fs.mkdirSync(homeRepo, { recursive: true });
      git(homeRepo, "init", "-b", "main");
      commit(homeRepo);
      try {
        writeGlobal("codex", { repositories: { "~/src/repo/.git": {} } });
        expect(resolveMatchedRepositoryRoute(homeRepo, "codex")?.entryKey).toBe("~/src/repo/.git");

        normalClone();
        const link = path.join(tempDir, "repo-link");
        fs.symlinkSync(mainRoot, link, "dir");
        writeGlobal("codex", { repositories: { [path.join(link, ".git")]: {} } });
        expect(resolveProjectIndexPath(worktreeRoot, "project", "codex"))
          .toBe(path.join(commonDir, "codebase-index", "index"));
      } finally {
        fs.rmSync(path.join(os.homedir(), "src"), { recursive: true, force: true });
      }
    });

    it("ignores GIT_DIR in the environment", () => {
      normalClone();
      const other = path.join(tempDir, "other");
      fs.mkdirSync(other);
      git(other, "init", "-b", "main");
      writeGlobal("claude", { repositories: { [path.join(mainRoot, ".git")]: {} } });

      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(other, ".git");
      try {
        expect(resolveRepositoryLayout(worktreeRoot)?.commonDir).toBe(commonDir);
        expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
          .toBe(path.join(commonDir, "codebase-index", "index"));
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
      }
    });

    it("keeps legacy routing when no entry matches", () => {
      normalClone();
      const other = path.join(tempDir, "other");
      fs.mkdirSync(other);
      git(other, "init", "-b", "main");
      writeGlobal("claude", { repositories: { [path.join(other, ".git")]: {} } });

      // No local config: a linked worktree inherits the main checkout's index.
      expect(resolveMatchedRepositoryRoute(worktreeRoot, "claude")).toBeNull();
      expect(resolveProjectIndexPath(mainRoot, "project", "claude"))
        .toBe(path.join(mainRoot, ".claude", "index"));
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(real(mainRoot), ".claude", "index"));
      expect(resolveProjectIndexPath(worktreeRoot, "project", "codex"))
        .toBe(path.join(real(mainRoot), ".codebase-index", "index"));

      // A worktree with its own host config keeps a local index.
      resetRepositoryRoutesForTests();
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), {});
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(worktreeRoot, ".claude", "index"));

      // Legacy config candidates still include the main checkout's config.
      expect(getProjectConfigCandidatePaths(worktreeRoot, "claude"))
        .toContain(path.join(real(mainRoot), ".claude", "codebase-index.json"));
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", "/x/index")).toBe("Store: /x/index (host default)");
    });

    it("falls back to legacy routing with a warning when the global config is not valid JSON", () => {
      normalClone();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fs.mkdirSync(path.dirname(globalConfigFile("claude")), { recursive: true });
      fs.writeFileSync(globalConfigFile("claude"), "{ not json");

      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(real(mainRoot), ".claude", "index"));
      expect(warn.mock.calls.flat().join("\n")).toContain("could not be read");
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", "/x")).toContain("Warning: Global config");
    });

    it("ignores a repositories value that is not an object, with a warning", () => {
      normalClone();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      writeGlobal("claude", { repositories: [path.join(mainRoot, ".git")] });

      expect(resolveMatchedRepositoryRoute(mainRoot, "claude")).toBeNull();
      expect(formatRepositoryRouteStatus(mainRoot, "claude", "/x"))
        .toContain("field 'repositories' must be an object");
    });
  });

  describe("roles", () => {
    it("defaults the main worktree of a normal clone to primary", () => {
      normalClone();
      writeGlobal("claude", { repositories: { [path.join(mainRoot, ".git")]: {} } });
      const indexPath = resolveProjectIndexPath(mainRoot, "project", "claude");

      expect(resolveRepositoryRoute(mainRoot, "claude")).toMatchObject({
        role: "primary",
        roleReason: "main worktree of a normal clone",
      });
      expect(resolveRepositoryRoute(worktreeRoot, "claude").role).toBe("secondary");
      expect(isProjectIndexPathOwnedByProject(mainRoot, indexPath, "claude")).toBe(true);
      expect(isProjectIndexPathOwnedByProject(worktreeRoot, indexPath, "claude")).toBe(false);
    });

    it("uses a configured primary, also through symlinked paths", () => {
      normalClone();
      const worktreeLink = path.join(tempDir, "feature-link");
      fs.symlinkSync(worktreeRoot, worktreeLink, "dir");
      writeGlobal("claude", {
        repositories: { [path.join(mainRoot, ".git")]: { checkouts: { primary: { path: worktreeLink } } } },
      });

      expect(resolveRepositoryRoute(worktreeRoot, "claude")).toMatchObject({
        role: "primary",
        roleReason: "configured primary",
      });
      expect(resolveRepositoryRoute(worktreeLink, "claude").role).toBe("primary");
      expect(resolveRepositoryRoute(mainRoot, "claude").role).toBe("secondary");
    });

    it("makes every checkout secondary when the configured primary is not a checkout of the repository", () => {
      normalClone();
      const other = path.join(tempDir, "other");
      fs.mkdirSync(other);
      git(other, "init", "-b", "main");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      for (const primary of [other, path.join(tempDir, "missing")]) {
        resetRepositoryRoutesForTests();
        writeGlobal("claude", {
          repositories: { [path.join(mainRoot, ".git")]: { checkouts: { primary: { path: primary } } } },
        });
        for (const checkout of [mainRoot, worktreeRoot]) {
          const route = resolveRepositoryRoute(checkout, "claude");
          expect(route.role).toBe("secondary");
          expect(route.roleReason).toContain("is not a checkout of this repository");
        }
        expect(formatRepositoryRouteStatus(mainRoot, "claude", "/x"))
          .toContain("Warning: Checkout roles:");
      }
    });

    it("requires checkouts.primary.path for a bare-base layout", () => {
      normalClone();
      const bareDir = path.join(tempDir, "bare.git");
      git(tempDir, "clone", "--bare", mainRoot, bareDir);
      const wtMain = path.join(tempDir, "bare-main");
      const wtOther = path.join(tempDir, "bare-other");
      git(bareDir, "worktree", "add", wtMain, "main");
      git(bareDir, "worktree", "add", "-b", "other", wtOther);

      writeGlobal("claude", { repositories: { [bareDir]: {} } });
      for (const checkout of [wtMain, wtOther]) {
        expect(resolveRepositoryRoute(checkout, "claude")).toMatchObject({
          role: "secondary",
          roleReason: "bare-base layout needs checkouts.primary.path",
        });
      }
      expect(resolveProjectIndexPath(wtOther, "project", "claude"))
        .toBe(path.join(real(bareDir), "codebase-index", "index"));

      resetRepositoryRoutesForTests();
      writeGlobal("claude", { repositories: { [bareDir]: { checkouts: { primary: { path: wtOther } } } } });
      expect(resolveRepositoryRoute(wtOther, "claude").role).toBe("primary");
      expect(resolveRepositoryRoute(wtMain, "claude").role).toBe("secondary");
    });

    it("routes a separate-git-dir checkout through its git dir key", () => {
      const checkout = path.join(tempDir, "checkout");
      const storeDir = path.join(tempDir, "store.git");
      git(tempDir, "init", "-b", "main", `--separate-git-dir=${storeDir}`, checkout);
      commit(checkout);
      writeGlobal("claude", { repositories: { [storeDir]: { checkouts: { primary: { path: checkout } } } } });

      expect(resolveRepositoryRoute(checkout, "claude")).toMatchObject({
        role: "primary",
        indexPath: path.join(real(storeDir), "codebase-index", "index"),
      });
    });
  });

  describe("entry validation", () => {
    it("throws a config error naming the key for an invalid matching entry", () => {
      normalClone();
      const key = path.join(mainRoot, ".git");
      const cases: unknown[] = [
        "not an object",
        { storage: { indexPath: 5 } },
        { checkouts: { primary: { path: "" } } },
        { checkouts: { secondary: { watchFiles: "yes" } } },
      ];
      for (const entry of cases) {
        resetRepositoryRoutesForTests();
        writeGlobal("claude", { repositories: { [key]: entry } });
        expect(() => resolveProjectIndexPath(worktreeRoot, "project", "claude")).toThrow(`entry '${key}'`);
        expect(() => loadMergedConfig(worktreeRoot, "claude")).toThrow(`entry '${key}'`);
      }

      // A failed resolution is not cached: fixing the file takes effect.
      writeGlobal("claude", { repositories: { [key]: {} } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(commonDir, "codebase-index", "index"));
    });

    it("ignores an invalid non-matching entry with a warning", () => {
      normalClone();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const otherKey = path.join(tempDir, "elsewhere", ".git");
      writeGlobal("claude", {
        repositories: {
          [otherKey]: { storage: { indexPath: 5 } },
          [path.join(mainRoot, ".git")]: {},
        },
      });

      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(commonDir, "codebase-index", "index"));
      expect(warn.mock.calls.flat().join("\n")).toContain(`'${otherKey}'`);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", "/x")).toContain("is ignored");
    });

    it("uses the first of several matching keys and reports the duplicate", () => {
      normalClone();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const link = path.join(tempDir, "repo-link");
      fs.symlinkSync(mainRoot, link, "dir");
      const first = path.join(mainRoot, ".git");
      writeGlobal("claude", {
        repositories: {
          [first]: { storage: { indexPath: path.join(tempDir, "first") } },
          [path.join(link, ".git")]: { storage: { indexPath: path.join(tempDir, "second") } },
        },
      });

      expect(resolveProjectIndexPath(mainRoot, "project", "claude")).toBe(path.join(tempDir, "first"));
      expect(formatRepositoryRouteStatus(mainRoot, "claude", "/x")).toMatch(/Warning: Repositories keys .* all match/);
    });
  });

  describe("snapshot and status", () => {
    it("keeps the first route per process and reports drift in status", () => {
      normalClone();
      const key = path.join(mainRoot, ".git");
      const first = path.join(tempDir, "first");
      writeGlobal("claude", { repositories: { [key]: { storage: { indexPath: first } } } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(first);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", first)).not.toContain("changed since start");

      writeGlobal("claude", { repositories: { [key]: { storage: { indexPath: path.join(tempDir, "second") } } } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(first);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", first))
        .toContain("Warning: Global config changed since start");

      resetRepositoryRoutesForTests();
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(path.join(tempDir, "second"));
    });

    it("shows store, source, role, reason and a differing local index", () => {
      normalClone();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const key = path.join(mainRoot, ".git");
      fs.mkdirSync(path.join(worktreeRoot, ".claude", "index"), { recursive: true });
      writeGlobal("claude", { repositories: { [key]: {} } });
      const store = resolveProjectIndexPath(worktreeRoot, "project", "claude");

      const text = formatRepositoryRouteStatus(worktreeRoot, "claude", store);
      expect(text).toContain(`Store: ${store} (repository default '${key}')`);
      expect(text).toContain(`Checkout role: secondary - linked worktree; the main worktree ${real(mainRoot)} is primary`);
      expect(text).toContain(`Warning: Local index ${path.join(real(worktreeRoot), ".claude", "index")} is not used`);

      expect(formatRepositoryRouteStatus(mainRoot, "claude", store))
        .toContain("Checkout role: primary - main worktree of a normal clone");
    });
  });

  describe("config merge", () => {
    function setupEntry(entryExtra: Record<string, unknown> = {}): string {
      normalClone();
      const key = path.join(mainRoot, ".git");
      writeGlobal("claude", {
        embeddingProvider: "ollama",
        include: ["global/**"],
        knowledgeBases: [path.join(tempDir, "global-kb")],
        indexing: { autoIndexWaitMs: 1000, watchFiles: true },
        search: { maxResults: 5, minScore: 0.1 },
        customProvider: { baseUrl: "http://global.invalid", apiKey: "global-key", model: "g" },
        repositories: {
          [key]: {
            storage: { indexPath: path.join(tempDir, "store") },
            checkouts: {
              primary: { watchFiles: true, autoIndexOnStartup: true },
              secondary: { watchFiles: false, autoIndexOnStartup: false },
            },
            indexing: { autoIndexWaitMs: 2000, allowForceRebuild: false },
            search: { maxResults: 9 },
            customProvider: { baseUrl: "http://entry.invalid", model: "e" },
            knowledgeBases: ["docs"],
            ...entryExtra,
          },
        },
      });
      return key;
    }

    it("merges global < entry < role < checkout project config", () => {
      setupEntry();
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), {
        indexing: { autoIndexWaitMs: 3000 },
        customProvider: { baseUrl: "http://project.invalid", model: "p" },
      });

      const merged = loadMergedConfig(worktreeRoot, "claude") as Record<string, unknown>;
      expect(merged.repositories).toBeUndefined();
      expect(merged.storage).toBeUndefined();
      expect(merged.checkouts).toBeUndefined();
      expect(merged.embeddingProvider).toBe("ollama");
      expect(merged.include).toEqual(["global/**"]);
      expect(merged.indexing).toEqual({
        autoIndexWaitMs: 3000,
        watchFiles: false,
        autoIndexOnStartup: false,
        allowForceRebuild: false,
      });
      expect(merged.search).toEqual({ maxResults: 9, minScore: 0.1 });
      // customProvider is atomic: the project's baseUrl never inherits the global apiKey.
      expect(merged.customProvider).toEqual({ baseUrl: "http://project.invalid", model: "p" });
      expect(merged.knowledgeBases).toEqual(expect.arrayContaining([
        path.join(tempDir, "global-kb"),
        path.resolve(worktreeRoot, "docs"),
      ]));

      const parsed = parseConfig(merged);
      expect(parsed.indexing.autoIndexOnStartup).toBe(false);
      expect(parsed.indexing.watchFiles).toBe(false);
    });

    it("applies the primary role overrides on the primary checkout", () => {
      setupEntry();
      const merged = loadMergedConfig(mainRoot, "claude") as Record<string, unknown>;
      expect(merged.indexing).toMatchObject({ watchFiles: true, autoIndexOnStartup: true, autoIndexWaitMs: 2000 });
      expect(merged.customProvider).toEqual({ baseUrl: "http://entry.invalid", model: "e" });
    });

    it("lets an explicit project allowForceRebuild win over the entry", () => {
      setupEntry();
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), {
        indexing: { allowForceRebuild: true },
      });
      const merged = loadMergedConfig(worktreeRoot, "claude") as Record<string, unknown>;
      expect(merged.indexing).toMatchObject({ allowForceRebuild: true, autoIndexWaitMs: 2000 });
    });

    it("does not inherit the main checkout's project config in a matched worktree", () => {
      setupEntry();
      const mainConfig = path.join(real(mainRoot), ".claude", "codebase-index.json");
      writeJson(mainConfig, { search: { maxResults: 42 } });

      expect(getProjectConfigCandidatePaths(worktreeRoot, "claude")).not.toContain(mainConfig);
      const merged = loadMergedConfig(worktreeRoot, "claude") as Record<string, unknown>;
      expect(merged.search).toMatchObject({ maxResults: 9 });
      expect((loadMergedConfig(mainRoot, "claude") as Record<string, unknown>).search)
        .toMatchObject({ maxResults: 42 });
    });

    it("keeps legacy merge and inheritance without an entry", () => {
      normalClone();
      writeGlobal("claude", { search: { maxResults: 5 } });
      writeJson(path.join(real(mainRoot), ".claude", "codebase-index.json"), { search: { maxResults: 42 } });

      expect(resolveGlobalConfigPath("claude")).toBe(globalConfigFile("claude"));
      const merged = loadMergedConfig(worktreeRoot, "claude") as Record<string, unknown>;
      expect(merged.search).toMatchObject({ maxResults: 42 });
      expect(parseConfig(merged).indexing.autoIndexOnStartup).toBe(true);
    });
  });
});
