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
      mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };

    const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string };
    expect(pluginManifest.name).toBe("codebase-index");
    expect(pluginManifest.version).toBe(packageManifest.version);
    expect(pluginManifest.hooks).toBeUndefined();
    expect(pluginManifest.skills).toBe("./skills/");

    const codebaseMcp = pluginManifest.mcpServers?.["codebase-index"];
    // Runs the installed open-codebase-index-mcp from PATH, else this version's GitHub release
    // tarball through npx, so a git marketplace install never needs the uncommitted dist/.
    expect(codebaseMcp?.command).toBe("sh");
    expect(codebaseMcp?.args).toEqual([
      "-c",
      "if [ \"$OS\" = Windows_NT ]; then echo \"codebase-index: this plugin's launcher does not support Windows; "
        + "register open-codebase-index-mcp directly in the host's MCP settings (docs/installation.md)\" >&2; exit 1; fi; "
        + "if command -v ocbi-mcp >/dev/null 2>&1; then exec ocbi-mcp \"$@\"; fi; "
        + `exec npx -y --package '${IDENTITY_CATALOG.release.repository}/releases/download/v${packageManifest.version}/`
        + `open-codebase-index-${packageManifest.version}.tgz' open-codebase-index-mcp "$@"`,
      "ocbi-mcp",
      "--host",
      "claude",
    ]);
    expect(codebaseMcp?.env).toEqual({ OCBI_PLUGIN_VERSION: packageManifest.version });
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
      + `open-codebase-index-${version}.tgz ocbi index --force --allow-shared-rebuild --host <host> --project <checkout>`;
    for (const command of ["./commands/index.md", "./commands/status.md"]) {
      const text = fs.readFileSync(command, "utf-8");
      expect(text, command).toContain("FORCE_REBUILD_DISABLED");
      expect(text, command).toContain(releaseCli);
      expect(text, command).toContain("Checkout role:");
      expect(text, command).not.toContain("npm install -g");
      // A missing or invalid primary must be fixed before any rebuild, and a config that
      // disables force routes straight to the terminal rebuild.
      expect(text, command).toContain("set `checkouts.primary.path`");
      // The default store's Store line names no file, and a running server keeps its first role.
      expect(text, command).toContain("`<git common dir>/codebase-index/config.json` when that line says `repository default store`");
      expect(text, command).toContain("restarts the MCP server");
      // The force policy is the server's merged-config decision, refused before any change.
      expect(text, command).toContain("`FORCE_REBUILD_DISABLED`");
      expect(text, command).toContain("before it changes anything");
      expect(text, command).not.toContain("sets `indexing.allowForceRebuild` to `false`");
    }
    // The commands key off index_status text; keep the quoted phrases in step with the formatter.
    const route = fs.readFileSync("src/config/repository-route.ts", "utf-8");
    for (const phrase of [
      "Checkout role: ${route.role} - ${route.roleReason}",
      "is not a checkout of this repository",
      "bare-base layout needs checkouts.primary.path",
      "\"repository default store\"",
      "linked worktree; the main worktree ${mainWorktree} is primary",
    ]) {
      expect(route, phrase).toContain(phrase);
    }
    // /status is a readiness check: it asks the user to run /index force and never forces itself.
    expect(fs.readFileSync("./commands/status.md", "utf-8")).toContain("Otherwise tell the user to run `/index force`. Never call `index_codebase` with force from `/status`");
    expect(fs.readFileSync("./commands/status.md", "utf-8")).not.toContain("Otherwise run `index_codebase` with force");
    expect(fs.readFileSync("./commands/index.md", "utf-8")).toContain("3. Otherwise run `index_codebase` with force (`/index force`)");
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
