import type { HostMode } from "../src/config/host.js";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMergedConfig } from "../src/config/merger.js";
import { resolveWritableProjectConfigPath } from "../src/config/paths.js";
import {
  getRepositoryConfigPath,
  resetRepositoryRoutesForTests,
  resolveMatchedRepositoryRoute,
} from "../src/config/repository-route.js";
import { parseConfig } from "../src/config/schema.js";
import { assertEvalReindexAllowed, loadParsedConfig } from "../src/eval/runner-config.js";
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

    const explicitConfigPath = path.join(tempDir, "eval-config.json");
    writeJson(explicitConfigPath, { scope: "global", indexing: { ...BASE_INDEXING, allowForceRebuild: true } });
    const explicitConfig = loadParsedConfig(mainRoot, explicitConfigPath);
    expect(explicitConfig.indexing.allowForceRebuild).toBe(true);
    expect(() => assertEvalReindexAllowed(mainRoot, explicitConfig)).toThrow(/^FORCE_REBUILD_DISABLED/);

    writeRepoConfig({ allowForceRebuild: true }, { scope: "global" });
    resetRepositoryRoutesForTests();
    expect(() => assertEvalReindexAllowed(mainRoot, loadParsedConfig(mainRoot))).not.toThrow();
  });

  it("refuses evaluation --reindex outside a repository config when the project config sets false", () => {
    const projectRoot = path.join(tempDir, "plain");
    fs.mkdirSync(projectRoot, { recursive: true });
    const configPath = resolveWritableProjectConfigPath(projectRoot, "opencode");
    writeJson(configPath, { indexing: { ...BASE_INDEXING, allowForceRebuild: false } });
    expect(() => assertEvalReindexAllowed(projectRoot, loadParsedConfig(projectRoot, configPath)))
      .toThrow(/^FORCE_REBUILD_DISABLED/);

    writeJson(configPath, { indexing: { ...BASE_INDEXING, allowForceRebuild: true } });
    expect(() => assertEvalReindexAllowed(projectRoot, loadParsedConfig(projectRoot, configPath))).not.toThrow();
  });
});
