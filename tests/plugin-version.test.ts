import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeIndexStatus } from "../src/tools/execute-common.js";
import { getIndexerForProject, initializeTools } from "../src/tools/operation-runtime.js";
import { parseConfig } from "../src/config/schema.js";
import { getPackageVersion } from "../src/package-metadata.js";
import {
  PLUGIN_VERSION_ENV,
  formatPluginVersionSkew,
  getPluginLaunchRecordPath,
  recordPluginLaunch,
  releaseTarballUrl,
  resolvePluginVersionPin,
} from "../src/plugin-version.js";
import { PLUGIN_VERSION_ENV as MANIFEST_PLUGIN_VERSION_ENV, releaseTarballUrl as manifestTarballUrl } from "../scripts/plugin-manifests.mjs";
import { IDENTITY_CATALOG } from "../src/identity-catalog.js";

const current = getPackageVersion();

describe("plugin version skew", () => {
  afterEach(() => {
    for (const host of ["claude", "codex"] as const) {
      fs.rmSync(getPluginLaunchRecordPath(host), { force: true });
    }
  });

  it("shares the variable name and tarball URL with the manifest generator", () => {
    expect(PLUGIN_VERSION_ENV).toBe(MANIFEST_PLUGIN_VERSION_ENV);
    expect(releaseTarballUrl("1.2.3-gd.4")).toBe(manifestTarballUrl(IDENTITY_CATALOG, "1.2.3-gd.4"));
  });

  it("stays quiet without a plugin pin or when the pin matches", () => {
    expect(formatPluginVersionSkew("claude", {})).toBeNull();
    expect(formatPluginVersionSkew("claude", { [PLUGIN_VERSION_ENV]: current })).toBeNull();
    expect(recordPluginLaunch("claude", {})).toBeNull();
    expect(fs.existsSync(getPluginLaunchRecordPath("claude"))).toBe(false);
  });

  it("warns with the install command when the plugin that started the server pins another version", () => {
    const warning = formatPluginVersionSkew("claude", { [PLUGIN_VERSION_ENV]: "9.9.9-gd.99" }, "1.0.0");
    expect(warning).toBe(
      "Version skew: the codebase-index plugin that started this server pins 9.9.9-gd.99, but the installed "
      + "open-codebase-index is 1.0.0. Install the pinned release with "
      + `\`npm install -g ${releaseTarballUrl("9.9.9-gd.99")}\` (or rerun the local wrapper's install.sh with `
      + "that URL), or update the plugin.",
    );
  });

  it("lets a terminal status see the pin the last plugin launch recorded for its host", () => {
    const recordPath = recordPluginLaunch("codex", { [PLUGIN_VERSION_ENV]: "9.9.9-gd.99" }, new Date("2026-01-02T03:04:05Z"));
    expect(recordPath).toBe(getPluginLaunchRecordPath("codex"));
    expect(JSON.parse(fs.readFileSync(recordPath as string, "utf-8"))).toEqual({
      host: "codex", pluginVersion: "9.9.9-gd.99", serverVersion: current, recordedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(resolvePluginVersionPin("codex", {})).toEqual({
      version: "9.9.9-gd.99", source: "last plugin launch", recordedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(formatPluginVersionSkew("codex", {}, "1.0.0")).toContain(
      "the codebase-index plugin last started a codex server at 2026-01-02T03:04:05.000Z pinning 9.9.9-gd.99",
    );
    // Hosts keep separate records, and the environment wins over the record.
    expect(resolvePluginVersionPin("claude", {})).toBeNull();
    expect(resolvePluginVersionPin("codex", { [PLUGIN_VERSION_ENV]: "1.0.0" })?.source).toBe("environment");
  });

  it("ignores an unreadable record instead of failing status", () => {
    const recordPath = getPluginLaunchRecordPath("claude");
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, "{not json");
    expect(formatPluginVersionSkew("claude", {})).toBeNull();
  });
});

describe("index status reports plugin version skew", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-version-status-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
    initializeTools(projectRoot, parseConfig({
      scope: "project",
      indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
    }), "claude");
  });

  afterEach(async () => {
    delete process.env[PLUGIN_VERSION_ENV];
    fs.rmSync(getPluginLaunchRecordPath("claude"), { force: true });
    await getIndexerForProject(projectRoot, "claude").close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("adds a warning, not an error, to index_status and ocbi status output", async () => {
    const quiet = await executeIndexStatus(projectRoot, "claude");
    expect(quiet.text).not.toContain("Version skew");
    expect(quiet.details?.versionWarning).toBeUndefined();

    process.env[PLUGIN_VERSION_ENV] = "9.9.9-gd.99";
    const fromServer = await executeIndexStatus(projectRoot, "claude");
    expect(fromServer.isError).toBeUndefined();
    expect(fromServer.text).toContain(`Warning: Version skew: the codebase-index plugin that started this server pins 9.9.9-gd.99, but the installed open-codebase-index is ${current}.`);
    expect(fromServer.details?.versionWarning).toContain("9.9.9-gd.99");

    recordPluginLaunch("claude");
    delete process.env[PLUGIN_VERSION_ENV];
    const fromTerminal = await executeIndexStatus(projectRoot, "claude");
    expect(fromTerminal.text).toContain("Warning: Version skew: the codebase-index plugin last started a claude server at ");
  });
});
