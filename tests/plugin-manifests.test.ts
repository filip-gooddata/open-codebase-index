import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IDENTITY_CATALOG } from "../src/identity-catalog.js";
import { pluginServerArgs, releaseTarballUrl, syncPluginManifests } from "../scripts/plugin-manifests.mjs";

type ServerManifest = { mcpServers: Record<string, { command: string; args: string[] }> };

const MANIFEST_PATHS = [
  ".mcp.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
];

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

const packageVersion = readJson<{ version: string }>("package.json").version;

describe("plugin manifests launch the pinned release tarball", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-manifests-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("derives the release asset URL from the catalog and version", () => {
    expect(releaseTarballUrl(IDENTITY_CATALOG, "1.2.3-gd.4")).toBe(
      `${IDENTITY_CATALOG.release.repository}/releases/download/v1.2.3-gd.4/open-codebase-index-1.2.3-gd.4.tgz`,
    );
    expect(IDENTITY_CATALOG.release.tagPrefix).toBe("v");
    expect(new URL(IDENTITY_CATALOG.release.repository).hostname).toBe("github.com");
  });

  it("checked-in manifests match package.json", () => {
    expect(syncPluginManifests(process.cwd(), { check: true })).toEqual([]);

    const url = releaseTarballUrl(IDENTITY_CATALOG, packageVersion);
    const claude = readJson<ServerManifest & { version: string }>(".claude-plugin/plugin.json");
    const codexServers = readJson<ServerManifest>(".mcp.json");
    expect(claude.version).toBe(packageVersion);
    expect(claude.mcpServers["codebase-index"]).toEqual({
      command: "npx",
      args: ["-y", "--package", url, IDENTITY_CATALOG.product.future.mcpBinary, "--host", "claude"],
    });
    expect(codexServers.mcpServers["codebase-index"]).toEqual({
      command: "npx",
      args: ["-y", "--package", url, IDENTITY_CATALOG.product.future.mcpBinary, "--host", "codex"],
    });
  });

  it("rewrites every launch URL and version after a version bump", () => {
    for (const relative of [...MANIFEST_PATHS, "package.json", "src/identity-catalog.json"]) {
      fs.mkdirSync(path.dirname(path.join(tempDir, relative)), { recursive: true });
      fs.copyFileSync(relative, path.join(tempDir, relative));
    }
    const packageJson = readJson<Record<string, unknown>>(path.join(tempDir, "package.json"));
    packageJson.version = "9.9.9-gd.99";
    fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify(packageJson));

    expect(syncPluginManifests(tempDir, { check: true })).toEqual([
      ".mcp.json",
      path.join(".claude-plugin", "plugin.json"),
      path.join(".codex-plugin", "plugin.json"),
      path.join(".claude-plugin", "marketplace.json"),
    ]);
    syncPluginManifests(tempDir);
    expect(syncPluginManifests(tempDir, { check: true })).toEqual([]);

    const url = releaseTarballUrl(IDENTITY_CATALOG, "9.9.9-gd.99");
    expect(url).toContain("/v9.9.9-gd.99/open-codebase-index-9.9.9-gd.99.tgz");
    const claude = readJson<ServerManifest & { version: string }>(path.join(tempDir, ".claude-plugin/plugin.json"));
    const codex = readJson<{ version: string }>(path.join(tempDir, ".codex-plugin/plugin.json"));
    const marketplace = readJson<{ plugins: Array<{ name: string; version: string }> }>(
      path.join(tempDir, ".claude-plugin/marketplace.json"),
    );
    expect(claude.version).toBe("9.9.9-gd.99");
    expect(claude.mcpServers["codebase-index"].args).toEqual(pluginServerArgs(IDENTITY_CATALOG, "9.9.9-gd.99", "claude"));
    expect(readJson<ServerManifest>(path.join(tempDir, ".mcp.json")).mcpServers["codebase-index"].args)
      .toEqual(pluginServerArgs(IDENTITY_CATALOG, "9.9.9-gd.99", "codex"));
    expect(codex.version).toBe("9.9.9-gd.99");
    expect(marketplace.plugins.find((plugin) => plugin.name === "codebase-index")?.version).toBe("9.9.9-gd.99");
    for (const relative of MANIFEST_PATHS) {
      expect(fs.readFileSync(path.join(tempDir, relative), "utf-8")).not.toContain(packageVersion);
    }
  });

  it("keeps the npm version lifecycle regenerating and staging the manifests", () => {
    const scripts = readJson<{ scripts: Record<string, string> }>("package.json").scripts;
    expect(scripts["sync:plugin-manifests"]).toBe("node scripts/plugin-manifests.mjs");
    expect(scripts.version).toBe(
      "node scripts/plugin-manifests.mjs && git add .mcp.json .claude-plugin .codex-plugin .agents/plugins",
    );
  });
});

describe("plugin marketplaces", () => {
  it("lists the repository root plugin under the fork marketplace name for both hosts", () => {
    const claude = readJson<{
      name: string;
      owner: { name: string; url: string };
      plugins: Array<{ name: string; source: string; version: string }>;
    }>(".claude-plugin/marketplace.json");
    const codex = readJson<{
      name: string;
      plugins: Array<{ name: string; source: { source: string; path: string } }>;
    }>(".agents/plugins/marketplace.json");

    expect(claude.name).toBe(IDENTITY_CATALOG.release.marketplaceName);
    expect(claude.owner.url).toBe(IDENTITY_CATALOG.release.repository);
    expect(claude.plugins).toEqual([expect.objectContaining({ name: "codebase-index", source: "./", version: packageVersion })]);
    expect(codex.name).toBe(IDENTITY_CATALOG.release.marketplaceName);
    expect(codex.plugins).toEqual([
      expect.objectContaining({ name: "codebase-index", source: { source: "local", path: "./" } }),
    ]);
  });

  it("ships skills and commands that exist, with no machine-local paths", () => {
    const claude = readJson<{ skills: string; name: string }>(".claude-plugin/plugin.json");
    const codex = readJson<{ skills: string; hooks: string; mcpServers: string }>(".codex-plugin/plugin.json");
    expect(claude.name).toBe("codebase-index");
    for (const relative of [claude.skills, codex.skills, codex.hooks, codex.mcpServers]) {
      expect(fs.existsSync(relative)).toBe(true);
    }
    expect(fs.existsSync("skills/codebase-search/SKILL.md")).toBe(true);

    const distributed = [
      ...MANIFEST_PATHS,
      ".codex-plugin/hooks.json",
      ...fs.readdirSync("commands").map((name) => path.join("commands", name)),
      ...fs.readdirSync("skills", { recursive: true, encoding: "utf-8" })
        .map((name) => path.join("skills", name))
        .filter((name) => fs.statSync(name).isFile()),
    ];
    for (const relative of distributed) {
      const text = fs.readFileSync(relative, "utf-8");
      expect(text, relative).not.toMatch(/\/(?:Users|home)\/[A-Za-z0-9._-]+\//);
      expect(text, relative).not.toMatch(/[A-Za-z]:\\Users\\/);
      expect(text, relative).not.toMatch(/~\/\.local\/share\/|@[A-Z_]+@/);
    }
  });
});
