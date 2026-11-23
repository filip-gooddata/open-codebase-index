import type { HostMode } from "../src/config/host.js";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMergedConfig } from "../src/config/merger.js";
import { resolveGlobalConfigPath, resolveWritableProjectConfigPath } from "../src/config/paths.js";
import {
  getRepositoryConfigPath,
  resetRepositoryRoutesForTests,
  resolveMatchedRepositoryRoute,
} from "../src/config/repository-route.js";
import { parseConfig } from "../src/config/schema.js";
import { assertEvalForceRebuildAllowedOnDisk, assertEvalReindexAllowed, loadParsedConfig } from "../src/eval/runner-config.js";
import { runEvaluation } from "../src/eval/runner.js";
import { executeIndexCodebase } from "../src/tools/execute-common.js";
import { getIndexerForProject, initializeTools } from "../src/tools/operation-runtime.js";

const REFUSAL = "FORCE_REBUILD_DISABLED: forced rebuild refused";
const BASE_INDEXING = {
  mode: "structural",
  autoIndex: false,
  watchFiles: false,
  autoGc: false,
  requireProjectMarker: false,
} as const;

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe("indexing.allowForceRebuild from the repository config", () => {
  let tempDir: string;
  let mainRoot: string;
  let commonDir: string;
  const initialized: Array<[string, HostMode]> = [];

  function writeRepoConfig(indexing: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    writeJson(getRepositoryConfigPath(commonDir), {
      include: ["**/*.ts"],
      exclude: [],
      search: { minScore: 0 },
      indexing: { ...BASE_INDEXING, ...indexing },
      ...extra,
    });
  }

  function initialize(root: string, host: HostMode): void {
    initializeTools(root, parseConfig(loadMergedConfig(root, host)), host);
    initialized.push([root, host]);
  }

  async function forceIndex(root: string, host: HostMode): Promise<{ text: string; isError?: boolean }> {
    return executeIndexCodebase(root, host, { force: true });
  }

  beforeEach(() => {
    resetRepositoryRoutesForTests();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repository-route-force-")));
    mainRoot = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    git(mainRoot, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(mainRoot, "src", "entry.ts"), "export function keptTarget() {\n  return 42;\n}\n");
    git(mainRoot, "add", "src/entry.ts");
    git(mainRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture");
    commonDir = path.join(mainRoot, ".git");
  });

  afterEach(async () => {
    for (const [root, host] of initialized.splice(0)) {
      await getIndexerForProject(root, host).close();
    }
    resetRepositoryRoutesForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(["claude", "pi"] as const)("refuses a forced index_codebase when only the repository file sets false (%s)", async (host) => {
    writeRepoConfig({ allowForceRebuild: false });
    expect(resolveMatchedRepositoryRoute(mainRoot, host)?.role).toBe("primary");
    initialize(mainRoot, host);

    const indexed = await executeIndexCodebase(mainRoot, host, { force: false });
    expect(indexed.isError).not.toBe(true);

    const refused = await forceIndex(mainRoot, host);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(REFUSAL);
    expect(refused.text).toContain(`--host ${host} --project`);
    const results = await getIndexerForProject(mainRoot, host).search("keptTarget", 1, {
      definitionIntent: true,
      metadataOnly: true,
    });
    expect(results[0]).toMatchObject({ name: "keptTarget" });

    const overridden = await executeIndexCodebase(mainRoot, host, { force: true }, undefined, undefined, {
      allowForceRebuildOverride: true,
    });
    expect(overridden.text).not.toContain("FORCE_REBUILD_DISABLED");
  });

  it("re-reads the repository file for each forced request after the route is fixed", async () => {
    const host: HostMode = "claude";
    writeRepoConfig({ allowForceRebuild: true });
    initialize(mainRoot, host);

    writeRepoConfig({ allowForceRebuild: false });
    const refused = await forceIndex(mainRoot, host);
    expect(refused.text).toContain(REFUSAL);

    fs.writeFileSync(getRepositoryConfigPath(commonDir), "{ not json");
    const unreadable = await forceIndex(mainRoot, host)
      .then((result) => result.text)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(unreadable).toContain("Cannot confirm indexing.allowForceRebuild before a forced rebuild");

    writeRepoConfig({ allowForceRebuild: true });
    const allowed = await forceIndex(mainRoot, host);
    expect(allowed.text).not.toContain("FORCE_REBUILD_DISABLED");
  });

  it("keeps the refusal through a project indexing section that omits the key", async () => {
    const host: HostMode = "claude";
    writeRepoConfig({ allowForceRebuild: false });
    writeJson(resolveWritableProjectConfigPath(mainRoot, host), { indexing: { watchFiles: false } });
    initialize(mainRoot, host);
    expect((await forceIndex(mainRoot, host)).text).toContain(REFUSAL);
  });

  it("lets an explicit project allowForceRebuild true win over the repository file", async () => {
    const host: HostMode = "claude";
    writeRepoConfig({ allowForceRebuild: false });
    writeJson(resolveWritableProjectConfigPath(mainRoot, host), { indexing: { allowForceRebuild: true } });
    initialize(mainRoot, host);
    expect((await forceIndex(mainRoot, host)).text).not.toContain("FORCE_REBUILD_DISABLED");
  });

  it("ignores allowForceRebuild in a checkout role override", async () => {
    const host: HostMode = "claude";
    writeRepoConfig({ allowForceRebuild: false }, { checkouts: { primary: { allowForceRebuild: true } } });
    initialize(mainRoot, host);
    expect(parseConfig(loadMergedConfig(mainRoot, host)).indexing.allowForceRebuild).toBe(false);
    expect((await forceIndex(mainRoot, host)).text).toContain(REFUSAL);
  });

  it("refuses evaluation --reindex in global scope when only the repository file sets false", () => {
    writeRepoConfig({ allowForceRebuild: false }, { scope: "global" });
    const config = loadParsedConfig(mainRoot);
    expect(config.scope).toBe("global");
    expect(() => assertEvalReindexAllowed(mainRoot, config)).toThrow(/^FORCE_REBUILD_DISABLED: refusing evaluation --reindex/);
    expect(() => assertEvalForceRebuildAllowedOnDisk(mainRoot)).toThrow(/^FORCE_REBUILD_DISABLED/);

    const explicitConfigPath = path.join(tempDir, "eval-config.json");
    writeJson(explicitConfigPath, { scope: "global", indexing: { ...BASE_INDEXING, allowForceRebuild: true } });
    const explicitConfig = loadParsedConfig(mainRoot, explicitConfigPath);
    expect(explicitConfig.indexing.allowForceRebuild).toBe(true);
    expect(() => assertEvalReindexAllowed(mainRoot, explicitConfig)).not.toThrow();
    expect(() => assertEvalForceRebuildAllowedOnDisk(mainRoot)).toThrow(/^FORCE_REBUILD_DISABLED/);

    fs.writeFileSync(getRepositoryConfigPath(commonDir), "{ not json");
    expect(() => assertEvalForceRebuildAllowedOnDisk(mainRoot))
      .toThrow("Cannot confirm indexing.allowForceRebuild before evaluation --reindex");

    writeRepoConfig({ allowForceRebuild: true }, { scope: "global" });
    resetRepositoryRoutesForTests();
    expect(() => assertEvalForceRebuildAllowedOnDisk(mainRoot)).not.toThrow();
    expect(() => assertEvalReindexAllowed(mainRoot, loadParsedConfig(mainRoot))).not.toThrow();
  });

  describe("evaluation --reindex outside a repository config", () => {
    let projectRoot: string;
    let checkoutConfigPath: string;
    let sentinel: string;
    let datasetPath: string;
    let globalConfigPath: string;

    beforeEach(() => {
      projectRoot = path.join(tempDir, "plain");
      fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "src", "entry.ts"), "export function plainTarget() { return 1; }\n");
      checkoutConfigPath = resolveWritableProjectConfigPath(projectRoot, "opencode");
      sentinel = path.join(projectRoot, ".opencode", "index", "sentinel");
      writeJson(sentinel, {});
      datasetPath = path.join(tempDir, "dataset.json");
      writeJson(datasetPath, {
        version: "1.0.0",
        name: "small",
        queries: [{
          id: "q1",
          query: "where is plainTarget",
          queryType: "definition",
          retrievalMode: "context",
          expected: { filePath: "src/entry.ts", symbol: "plainTarget" },
        }],
      });
      globalConfigPath = resolveGlobalConfigPath("opencode");
    });

    afterEach(() => {
      fs.rmSync(globalConfigPath, { force: true });
    });

    async function reindexWith(configPath: string): Promise<string> {
      return runEvaluation({ projectRoot, datasetPath, configPath, outputRoot: path.join(tempDir, "results"), reindex: true })
        .then(() => "completed")
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    }

    it("refuses when the project config sets false and keeps it when --config omits the key", async () => {
      const checkoutConfig = { indexing: { ...BASE_INDEXING, allowForceRebuild: false } };
      writeJson(checkoutConfigPath, checkoutConfig);
      const explicitConfigPath = path.join(tempDir, "eval-config.json");
      writeJson(explicitConfigPath, { indexing: { ...BASE_INDEXING } });

      expect(await reindexWith(explicitConfigPath)).toMatch(/^FORCE_REBUILD_DISABLED: refusing evaluation --reindex/);
      expect(JSON.parse(fs.readFileSync(checkoutConfigPath, "utf-8"))).toEqual(checkoutConfig);
      expect(fs.existsSync(sentinel)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "results"))).toBe(false);
    });

    it("refuses a global false that a --config true would override once copied", async () => {
      writeJson(globalConfigPath, { indexing: { allowForceRebuild: false } });
      const explicitConfigPath = path.join(tempDir, "eval-config.json");
      writeJson(explicitConfigPath, { indexing: { ...BASE_INDEXING, allowForceRebuild: true } });

      expect(await reindexWith(explicitConfigPath)).toMatch(/^FORCE_REBUILD_DISABLED: refusing evaluation --reindex/);
      expect(fs.existsSync(checkoutConfigPath)).toBe(false);
      expect(fs.existsSync(sentinel)).toBe(true);
    });

    it("refuses when the evaluation's own config sets false", () => {
      writeJson(checkoutConfigPath, { indexing: { ...BASE_INDEXING, allowForceRebuild: false } });
      expect(() => assertEvalReindexAllowed(projectRoot, loadParsedConfig(projectRoot, checkoutConfigPath)))
        .toThrow(/^FORCE_REBUILD_DISABLED/);
      writeJson(checkoutConfigPath, { indexing: { ...BASE_INDEXING, allowForceRebuild: true } });
      expect(() => assertEvalReindexAllowed(projectRoot, loadParsedConfig(projectRoot, checkoutConfigPath))).not.toThrow();
      expect(() => assertEvalForceRebuildAllowedOnDisk(projectRoot)).not.toThrow();
    });
  });
});
