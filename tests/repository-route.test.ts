import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { loadMergedConfig } from "../src/config/merger.js";
import {
  getHostProjectIndexRelativePath,
  getProjectConfigCandidatePaths,
  isProjectIndexPathOwnedByProject,
  resolveGlobalConfigPath,
  resolveProjectIndexPath,
} from "../src/config/paths.js";
import {
  formatRepositoryRouteStatus,
  getRepositoryConfigPath,
  resetRepositoryRoutesForTests,
  resolveMatchedRepositoryRoute,
  resolveRepositoryRoute,
} from "../src/config/repository-route.js";
import { parseConfig } from "../src/config/schema.js";
import { resolveRepositoryLayout } from "../src/git/layout.js";

// omp runs in the pi host mode, so these are every host mode a checkout can resolve under.
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

function writeRepoConfig(commonDir: string, value: unknown): string {
  const configPath = getRepositoryConfigPath(commonDir);
  writeJson(configPath, value);
  return configPath;
}

function symlinkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function clearGlobals(): void {
  for (const host of HOSTS) {
    fs.rmSync(resolveGlobalConfigPath(host), { force: true });
  }
}

describe("repository config file routing", () => {
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

  function bareClone(): { bareDir: string; first: string; second: string } {
    normalClone();
    const bareDir = path.join(tempDir, "bare.git");
    git(tempDir, "clone", "--bare", mainRoot, bareDir);
    const first = path.join(tempDir, "bare-main");
    git(bareDir, "worktree", "add", first, "main");
    const second = path.join(tempDir, "bare-topic");
    git(bareDir, "worktree", "add", "-b", "topic", second, "main");
    return { bareDir: real(bareDir), first, second };
  }

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    clearGlobals();
    tempDir = real(fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-")));
  });

  afterEach(() => {
    resetRepositoryRoutesForTests();
    clearGlobals();
    vi.unstubAllEnvs();
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
      const { bareDir, first } = bareClone();
      expect(resolveRepositoryLayout(first)).toMatchObject({
        checkoutRoot: real(first),
        commonDir: bareDir,
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
    it("routes every checkout and host mode of a normal clone to the default store from one file inside .git", () => {
      normalClone();
      const configPath = writeRepoConfig(commonDir, {});
      expect(configPath).toBe(path.join(commonDir, "codebase-index", "config.json"));
      const expected = path.join(commonDir, "codebase-index", "index");

      for (const host of HOSTS) {
        for (const checkout of [mainRoot, worktreeRoot]) {
          expect(resolveProjectIndexPath(checkout, "project", host)).toBe(expected);
          const route = resolveRepositoryRoute(checkout, host);
          expect(route.configPath).toBe(configPath);
          expect(route.storeSource).toBe("repository default store");
        }
        expect(resolveProjectIndexPath(mainRoot, "global", host)).not.toBe(expected);
      }
    });

    it("routes a bare clone and its worktrees to the store in the bare common dir", () => {
      const { bareDir, first, second } = bareClone();
      const configPath = writeRepoConfig(bareDir, {});
      const expected = path.join(bareDir, "codebase-index", "index");

      for (const host of HOSTS) {
        for (const checkout of [first, second]) {
          expect(resolveProjectIndexPath(checkout, "project", host)).toBe(expected);
          expect(resolveRepositoryRoute(checkout, host).configPath).toBe(configPath);
        }
      }
      // The normal clone the bare repository came from has no repo file of its own.
      expect(resolveMatchedRepositoryRoute(mainRoot, "claude")).toBeNull();
    });

    it("routes a separate-git-dir checkout and its worktree through the store beside that git dir", () => {
      const checkout = path.join(tempDir, "checkout");
      const storeDir = path.join(tempDir, "store.git");
      git(tempDir, "init", "-b", "main", `--separate-git-dir=${storeDir}`, checkout);
      commit(checkout);
      const linked = path.join(tempDir, "checkout-linked");
      git(checkout, "worktree", "add", "-b", "other", linked);
      writeRepoConfig(real(storeDir), {});

      const expected = path.join(real(storeDir), "codebase-index", "index");
      for (const host of HOSTS) {
        expect(resolveProjectIndexPath(checkout, "project", host)).toBe(expected);
        expect(resolveProjectIndexPath(linked, "project", host)).toBe(expected);
      }
    });

    it("resolves storage.indexPath as absolute, home-relative, or relative to the common dir", () => {
      normalClone();
      const absolute = path.join(tempDir, "shared-store");
      writeRepoConfig(commonDir, { storage: { indexPath: absolute } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "codex")).toBe(absolute);
      expect(resolveRepositoryRoute(worktreeRoot, "codex").storeSource).toBe("repository config");

      resetRepositoryRoutesForTests();
      writeRepoConfig(commonDir, { storage: { indexPath: "~/stores/example" } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "codex"))
        .toBe(path.join(os.homedir(), "stores", "example"));

      resetRepositoryRoutesForTests();
      writeRepoConfig(commonDir, { storage: { indexPath: "../shared" } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "codex"))
        .toBe(path.resolve(commonDir, "../shared"));
    });

    it("ignores GIT_DIR in the environment", () => {
      normalClone();
      const other = path.join(tempDir, "other");
      fs.mkdirSync(other);
      git(other, "init", "-b", "main");
      writeRepoConfig(real(path.join(other, ".git")), { storage: { indexPath: path.join(tempDir, "wrong") } });
      writeRepoConfig(commonDir, {});
      vi.stubEnv("GIT_DIR", path.join(other, ".git"));
      vi.stubEnv("GIT_WORK_TREE", other);

      expect(resolveRepositoryLayout(worktreeRoot)?.commonDir).toBe(commonDir);
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(commonDir, "codebase-index", "index"));
    });

    it("keeps legacy routing and precedence without a repository config file", () => {
      normalClone();
      for (const host of HOSTS) {
        expect(resolveMatchedRepositoryRoute(mainRoot, host)).toBeNull();
        expect(resolveMatchedRepositoryRoute(worktreeRoot, host)).toBeNull();
      }

      const rel = getHostProjectIndexRelativePath("claude");
      // Main checkout: its own host index dir.
      expect(resolveProjectIndexPath(mainRoot, "project", "claude")).toBe(path.join(mainRoot, rel));
      // Linked worktree without its own config inherits the main checkout's store.
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(path.join(real(mainRoot), rel));
      // A worktree-local host config opts out of inheritance.
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), {});
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(path.join(worktreeRoot, rel));
      // Codex keeps host-neutral storage.
      expect(resolveProjectIndexPath(mainRoot, "project", "codex"))
        .toBe(path.join(mainRoot, getHostProjectIndexRelativePath("codex")));
      // Without a repo file the worktree reads the main checkout's project config too.
      expect(getProjectConfigCandidatePaths(worktreeRoot, "claude"))
        .toContain(path.join(real(mainRoot), ".claude", "codebase-index.json"));
      expect(formatRepositoryRouteStatus(mainRoot, "claude", path.join(mainRoot, rel)))
        .toBe(`Store: ${path.join(mainRoot, rel)} (host default)`);
    });

    it("does not route anything from global config keys", () => {
      normalClone();
      const stray = { repositories: { [commonDir]: { storage: { indexPath: path.join(tempDir, "stray") } } } };
      for (const host of HOSTS) {
        writeJson(resolveGlobalConfigPath(host), stray);
      }
      for (const host of HOSTS) {
        expect(resolveMatchedRepositoryRoute(worktreeRoot, host)).toBeNull();
        expect(resolveProjectIndexPath(mainRoot, "project", host))
          .toBe(path.join(mainRoot, getHostProjectIndexRelativePath(host)));
      }
    });
  });

  describe("roles", () => {
    it("defaults the main worktree of a normal clone to primary", () => {
      normalClone();
      writeRepoConfig(commonDir, {});
      const main = resolveRepositoryRoute(mainRoot, "claude");
      const linked = resolveRepositoryRoute(worktreeRoot, "claude");
      expect(main.role).toBe("primary");
      expect(main.roleReason).toBe("main worktree of a normal clone");
      expect(linked.role).toBe("secondary");
      expect(linked.primaryPath).toBe(real(mainRoot));
      const store = path.join(commonDir, "codebase-index", "index");
      expect(isProjectIndexPathOwnedByProject(mainRoot, store, "claude")).toBe(true);
      expect(isProjectIndexPathOwnedByProject(worktreeRoot, store, "claude")).toBe(false);
    });

    it("uses a configured primary given as absolute, relative to the common dir, or through a symlink", () => {
      normalClone();
      for (const value of [worktreeRoot, path.relative(commonDir, worktreeRoot)]) {
        resetRepositoryRoutesForTests();
        writeRepoConfig(commonDir, { checkouts: { primary: { path: value } } });
        expect(resolveRepositoryRoute(worktreeRoot, "codex")).toMatchObject({
          role: "primary",
          roleReason: "configured primary",
        });
        expect(resolveRepositoryRoute(mainRoot, "codex").role).toBe("secondary");
      }

      resetRepositoryRoutesForTests();
      const linkToWorktree = path.join(tempDir, "link-feature");
      symlinkDir(worktreeRoot, linkToWorktree);
      writeRepoConfig(commonDir, { checkouts: { primary: { path: linkToWorktree } } });
      // Configured through a symlink, resolved from the real path, and the reverse.
      expect(resolveRepositoryRoute(worktreeRoot, "codex").role).toBe("primary");
      resetRepositoryRoutesForTests();
      writeRepoConfig(commonDir, { checkouts: { primary: { path: worktreeRoot } } });
      expect(resolveRepositoryRoute(linkToWorktree, "codex").role).toBe("primary");
      expect(resolveProjectIndexPath(linkToWorktree, "project", "codex"))
        .toBe(path.join(commonDir, "codebase-index", "index"));
    });

    it("makes every checkout secondary when the configured primary is not a checkout of the repository", () => {
      normalClone();
      const other = path.join(tempDir, "other");
      fs.mkdirSync(other);
      git(other, "init", "-b", "main");
      for (const value of [other, path.join(tempDir, "missing")]) {
        resetRepositoryRoutesForTests();
        writeRepoConfig(commonDir, { checkouts: { primary: { path: value } } });
        const reason = `configured primary ${value} is not a checkout of this repository`;
        for (const checkout of [mainRoot, worktreeRoot]) {
          const route = resolveRepositoryRoute(checkout, "claude");
          expect(route.role).toBe("secondary");
          expect(route.roleReason).toBe(reason);
          expect(formatRepositoryRouteStatus(checkout, "claude", route.indexPath ?? ""))
            .toContain(`Checkout role: secondary - ${reason}`);
        }
      }
    });

    it("requires checkouts.primary.path for a bare-base layout", () => {
      const { bareDir, first, second } = bareClone();
      writeRepoConfig(bareDir, {});
      for (const checkout of [first, second]) {
        expect(resolveRepositoryRoute(checkout, "claude")).toMatchObject({
          role: "secondary",
          roleReason: "bare-base layout needs checkouts.primary.path",
        });
      }

      resetRepositoryRoutesForTests();
      writeRepoConfig(bareDir, { checkouts: { primary: { path: second } } });
      expect(resolveRepositoryRoute(second, "claude").role).toBe("primary");
      expect(resolveRepositoryRoute(first, "claude").role).toBe("secondary");
    });

    it("decides roles ignoring GIT_DIR in the environment", () => {
      normalClone();
      writeRepoConfig(commonDir, {});
      vi.stubEnv("GIT_DIR", path.join(worktreeRoot, ".git"));
      expect(resolveRepositoryRoute(mainRoot, "claude").role).toBe("primary");
      expect(resolveRepositoryRoute(worktreeRoot, "claude").role).toBe("secondary");
    });
  });

  describe("invalid repository config", () => {
    const shapes: Array<[string, unknown, string]> = [
      ["a non-object root", [], "must contain a JSON object at the root"],
      ["a non-object storage", { storage: "x" }, "field 'storage' must be an object"],
      ["an empty indexPath", { storage: { indexPath: " " } }, "field 'storage.indexPath' must be a non-empty string"],
      ["a non-object checkouts", { checkouts: [] }, "field 'checkouts' must be an object"],
      ["a non-string primary path", { checkouts: { primary: { path: 3 } } }, "field 'checkouts.primary.path' must be a non-empty string"],
      ["a non-boolean role flag", { checkouts: { secondary: { watchFiles: "no" } } }, "field 'checkouts.secondary.watchFiles' must be a boolean"],
    ];

    it("fails closed on invalid JSON, naming the file, and is not cached", () => {
      normalClone();
      const configPath = getRepositoryConfigPath(commonDir);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, "{ not json");

      expect(() => resolveProjectIndexPath(worktreeRoot, "project", "claude")).toThrow(configPath);
      expect(() => resolveProjectIndexPath(mainRoot, "project", "codex")).toThrow(/Failed to load repository config/);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", "unused")).toContain("Repository route error:");

      writeRepoConfig(commonDir, {});
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude"))
        .toBe(path.join(commonDir, "codebase-index", "index"));
    });

    it.each(shapes)("fails closed on %s, naming the file", (_label, value, message) => {
      normalClone();
      const configPath = writeRepoConfig(commonDir, value);
      for (const host of HOSTS) {
        expect(() => resolveProjectIndexPath(worktreeRoot, "project", host))
          .toThrow(`Repository config ${configPath} ${message}`);
      }
    });
  });

  describe("snapshot and status", () => {
    it("keeps the first route per process and reports a changed file in status", () => {
      normalClone();
      const configPath = writeRepoConfig(commonDir, {});
      const store = path.join(commonDir, "codebase-index", "index");
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(store);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", store)).not.toContain("Warning:");

      writeRepoConfig(commonDir, { storage: { indexPath: path.join(tempDir, "moved") } });
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(store);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", store))
        .toContain(`Warning: Repository config ${configPath} changed since start; restart to apply it.`);

      fs.rmSync(configPath);
      expect(resolveProjectIndexPath(worktreeRoot, "project", "claude")).toBe(store);
      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", store)).toContain("changed since start");

      resetRepositoryRoutesForTests();
      expect(resolveMatchedRepositoryRoute(worktreeRoot, "claude")).toBeNull();
    });

    it("reports a legacy process that gains a repository config as changed", () => {
      normalClone();
      const legacy = resolveProjectIndexPath(mainRoot, "project", "claude");
      const configPath = writeRepoConfig(commonDir, {});
      expect(resolveProjectIndexPath(mainRoot, "project", "claude")).toBe(legacy);
      expect(formatRepositoryRouteStatus(mainRoot, "claude", legacy))
        .toContain(`Warning: Repository config ${configPath} changed since start`);
    });

    it("shows store, source, role, reason and a differing local index", () => {
      normalClone();
      const store = path.join(tempDir, "store");
      const configPath = writeRepoConfig(commonDir, { storage: { indexPath: store } });
      const localIndex = path.join(worktreeRoot, ".claude", "index");
      fs.mkdirSync(localIndex, { recursive: true });

      expect(formatRepositoryRouteStatus(worktreeRoot, "claude", store).split("\n")).toEqual([
        `Store: ${store} (repository config ${configPath})`,
        `Checkout role: secondary - linked worktree; the main worktree ${real(mainRoot)} is primary`,
        `Warning: Local index ${path.join(real(worktreeRoot), ".claude", "index")} is not used; this checkout reads the shared store ${store}.`,
      ]);

      resetRepositoryRoutesForTests();
      writeRepoConfig(commonDir, {});
      const defaultStore = path.join(commonDir, "codebase-index", "index");
      expect(formatRepositoryRouteStatus(mainRoot, "codex", defaultStore).split("\n")).toEqual([
        `Store: ${defaultStore} (repository default store)`,
        "Checkout role: primary - main worktree of a normal clone",
      ]);
    });
  });

  describe("config merge", () => {
    function setupRepoConfig(extra: Record<string, unknown> = {}): string {
      normalClone();
      writeJson(resolveGlobalConfigPath("claude"), {
        embeddingProvider: "ollama",
        include: ["global/**"],
        knowledgeBases: [path.join(tempDir, "global-kb")],
        indexing: { autoIndexWaitMs: 1000, watchFiles: true, maxFileSize: 1234 },
        search: { maxResults: 5, minScore: 0.1 },
        customProvider: { baseUrl: "http://global.invalid", apiKey: "global-key", model: "g" },
      });
      return writeRepoConfig(commonDir, {
        storage: { indexPath: path.join(tempDir, "store") },
        checkouts: {
          primary: { watchFiles: true, autoIndexOnStartup: true },
          secondary: { watchFiles: false, autoIndexOnStartup: false },
        },
        include: ["repo/**"],
        indexing: { autoIndexWaitMs: 2000, allowForceRebuild: false },
        search: { maxResults: 9 },
        customProvider: { baseUrl: "http://repo.invalid", model: "r" },
        knowledgeBases: ["docs"],
        ...extra,
      });
    }

    function merged(checkout: string, host: HostMode = "claude"): Record<string, unknown> {
      return loadMergedConfig(checkout, host) as Record<string, unknown>;
    }

    it("merges global < repository config < role < checkout project config", () => {
      setupRepoConfig();
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), {
        indexing: { autoIndexWaitMs: 3000 },
        search: { minScore: 0.3 },
      });

      const config = merged(worktreeRoot);
      expect(config.embeddingProvider).toBe("ollama");
      expect(config.include).toEqual(["repo/**"]);
      expect(config.indexing).toEqual({
        autoIndexWaitMs: 3000,
        watchFiles: false,
        maxFileSize: 1234,
        autoIndexOnStartup: false,
        allowForceRebuild: false,
      });
      expect(config.search).toEqual({ maxResults: 9, minScore: 0.3 });
      // customProvider is atomic: the repo layer's object replaces the global one, apiKey included.
      expect(config.customProvider).toEqual({ baseUrl: "http://repo.invalid", model: "r" });
      expect(config.knowledgeBases).toEqual(expect.arrayContaining([
        path.join(tempDir, "global-kb"),
        path.join(worktreeRoot, "docs"),
      ]));
      expect(config).not.toHaveProperty("storage");
      expect(config).not.toHaveProperty("checkouts");
      expect(parseConfig(config).indexing.autoIndexOnStartup).toBe(false);
    });

    it("applies the primary role overrides and resolves relative knowledge bases per checkout", () => {
      setupRepoConfig();
      const config = merged(mainRoot);
      expect(config.indexing).toMatchObject({ watchFiles: true, autoIndexOnStartup: true, autoIndexWaitMs: 2000 });
      expect(config.knowledgeBases).toContain(path.join(mainRoot, "docs"));
      expect(config.knowledgeBases).not.toContain(path.join(worktreeRoot, "docs"));
    });

    it("carries the repo allowForceRebuild through a worktree project indexing section", () => {
      setupRepoConfig({ indexing: { allowForceRebuild: true } });
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), { indexing: { autoIndexWaitMs: 3000 } });
      expect(merged(worktreeRoot).indexing).toMatchObject({ allowForceRebuild: true, autoIndexWaitMs: 3000 });
    });

    it("lets an explicit project allowForceRebuild and customProvider win over the repository config", () => {
      setupRepoConfig();
      writeJson(path.join(worktreeRoot, ".claude", "codebase-index.json"), {
        indexing: { allowForceRebuild: true },
        customProvider: { baseUrl: "http://project.invalid", model: "p" },
      });
      const config = merged(worktreeRoot);
      expect(config.indexing).toMatchObject({ allowForceRebuild: true, autoIndexWaitMs: 2000 });
      expect(config.customProvider).toEqual({ baseUrl: "http://project.invalid", model: "p" });
    });

    it("does not inherit the main checkout's project config in a routed worktree", () => {
      setupRepoConfig();
      writeJson(path.join(mainRoot, ".claude", "codebase-index.json"), { search: { maxResults: 42 } });
      expect(merged(mainRoot).search).toMatchObject({ maxResults: 42 });
      expect(merged(worktreeRoot).search).toMatchObject({ maxResults: 9 });
    });

    it("reads the same repository config under every host mode", () => {
      setupRepoConfig();
      for (const host of HOSTS) {
        expect(merged(worktreeRoot, host)).toMatchObject({
          include: ["repo/**"],
          search: { maxResults: 9 },
          indexing: { autoIndexWaitMs: 2000, watchFiles: false, autoIndexOnStartup: false },
        });
      }
    });

    it("throws a config error naming the repository config for an invalid section or invalid JSON", () => {
      const configPath = setupRepoConfig({ knowledgeBases: "docs" });
      expect(() => merged(worktreeRoot)).toThrow(
        `Config file ${configPath} field 'knowledgeBases' must be an array of strings.`,
      );

      resetRepositoryRoutesForTests();
      fs.writeFileSync(configPath, "{");
      expect(() => merged(worktreeRoot)).toThrow(`Failed to load repository config ${configPath}`);
      expect(() => merged(mainRoot, "codex")).toThrow(configPath);
    });

    it("keeps legacy merge and main-checkout inheritance without a repository config", () => {
      normalClone();
      writeJson(resolveGlobalConfigPath("claude"), { search: { maxResults: 5 }, indexing: { allowForceRebuild: true } });
      writeJson(path.join(mainRoot, ".claude", "codebase-index.json"), { search: { maxResults: 42 } });
      const config = merged(worktreeRoot);
      expect(config.search).toMatchObject({ maxResults: 42 });
      expect(parseConfig(config).indexing.autoIndexOnStartup).toBe(true);
    });
  });

  describe("project config candidates", () => {
    it("reads only the checkout's own project config when routed", () => {
      normalClone();
      writeRepoConfig(commonDir, {});
      const candidates = getProjectConfigCandidatePaths(worktreeRoot, "claude");
      expect(candidates).toEqual([
        path.join(worktreeRoot, ".claude", "codebase-index.json"),
        path.join(worktreeRoot, ".opencode", "codebase-index.json"),
      ]);
    });
  });
});
