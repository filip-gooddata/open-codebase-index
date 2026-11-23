import * as fs from "fs";

import { describe, expect, it } from "vitest";

import { IDENTITY_CATALOG } from "../src/identity-catalog.js";

describe("Claude Code plugin", () => {
  it("exposes Claude plugin manifest with inline MCP command on the claude host", () => {
    const pluginManifest = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf-8")) as {
      name: string;
      version: string;
      hooks?: string;
      skills?: string;
      mcpServers?: Record<string, { command: string; args: string[] }>;
    };

    const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string };
    expect(pluginManifest.name).toBe("codebase-index");
    expect(pluginManifest.version).toBe(packageManifest.version);
    expect(pluginManifest.hooks).toBeUndefined();
    expect(pluginManifest.skills).toBe("./skills/");

    const codebaseMcp = pluginManifest.mcpServers?.["codebase-index"];
    // Runs the pinned GitHub release tarball of this version, not the
    // uncommitted dist/, so a git marketplace install starts without a build.
    expect(codebaseMcp?.command).toBe("npx");
    expect(codebaseMcp?.args).toEqual([
      "-y",
      "--package",
      `${IDENTITY_CATALOG.release.repository}/releases/download/v${packageManifest.version}/open-codebase-index-${packageManifest.version}.tgz`,
      "open-codebase-index-mcp",
      "--host",
      "claude",
    ]);
  });

  it("loads no SessionStart hook and only the commands that work on Claude Code", () => {
    // Claude Code merges a root hooks/hooks.json into every plugin; the server's
    // initialize instructions already carry the routing guidance.
    expect(fs.existsSync("hooks/hooks.json")).toBe(false);

    const pluginManifest = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf-8")) as {
      commands: string[];
    };
    expect(pluginManifest.commands).toEqual([
      "./commands/call-graph.md",
      "./commands/definition.md",
      "./commands/find.md",
      "./commands/index.md",
      "./commands/peek.md",
      "./commands/pr-impact.md",
      "./commands/search.md",
      "./commands/status.md",
    ]);
    for (const command of pluginManifest.commands) {
      const text = fs.readFileSync(command, "utf-8");
      expect(text, command).not.toContain("index_visualize");
    }
    // A shared store refuses forced rebuilds; the commands must route the user to a terminal
    // rebuild instead of a retry that the server refuses.
    // The rebuild must use this release's CLI (the flag is fork-specific) and target the
    // primary checkout, which index_status names on its Checkout role line.
    const version = (JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string }).version;
    const releaseCli = `npx -y --package ${IDENTITY_CATALOG.release.repository}/releases/download/v${version}/`
      + `open-codebase-index-${version}.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <primary checkout>`;
    for (const command of ["./commands/index.md", "./commands/status.md"]) {
      const text = fs.readFileSync(command, "utf-8");
      expect(text, command).toContain("FORCE_REBUILD_DISABLED");
      expect(text, command).toContain(releaseCli);
      expect(text, command).toContain("Checkout role:");
      expect(text, command).not.toContain("npm install -g");
      // A missing or invalid primary must be fixed before any rebuild, and a config that
      // disables force routes straight to the terminal rebuild.
      expect(text, command).toContain("set `checkouts.primary.path`");
      expect(text, command).toContain("sets `indexing.allowForceRebuild` to `false`");
    }
    // Incompatibility needs a rebuild even when the index is populated.
    const status = fs.readFileSync("./commands/status.md", "utf-8");
    expect(status).toContain("Whenever status reports provider/model incompatibility, indexed or not");
    expect(status.slice(status.indexOf("If not indexed:"), status.indexOf("Whenever status reports")))
      .not.toContain("incompatibility");
  });

  it("exposes a Claude marketplace manifest using owner metadata", () => {
    const marketplace = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf-8")) as {
      name: string;
      owner: { name: string };
      plugins: Array<{ name: string; source: string; version: string }>;
    };

    const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string };
    expect(marketplace.name).toBe(IDENTITY_CATALOG.release.marketplaceName);
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({
      name: "codebase-index",
      version: packageManifest.version,
    }));
  });
});
