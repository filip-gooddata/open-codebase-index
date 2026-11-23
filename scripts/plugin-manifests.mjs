import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The Claude Code and Codex plugin manifests launch the server from the fork's
 * GitHub release tarball of the package version they ship with. This module
 * derives those launch arguments from package.json and the identity catalog,
 * so a version bump rewrites them (npm `version` lifecycle) and a stale
 * manifest fails `--check` in tests and in the release workflow.
 */

const SERVER_NAME = "codebase-index";

/**
 * @param {{ product: { future: { packageName: string } }, release: { repository: string, tagPrefix: string } }} catalog
 * @param {string} version
 * @returns {string}
 */
export function releaseTarballUrl(catalog, version) {
  const repository = catalog.release.repository.replace(/\/+$/, "");
  const tag = `${catalog.release.tagPrefix}${version}`;
  return `${repository}/releases/download/${tag}/${catalog.product.future.packageName}-${version}.tgz`;
}

/**
 * npx needs `--package <spec> <bin>` because the tarball declares several bins.
 *
 * @param {{ product: { future: { packageName: string, mcpBinary: string } }, release: { repository: string, tagPrefix: string } }} catalog
 * @param {string} version
 * @param {"claude" | "codex"} host
 * @param {string} [packageSpec]
 * @returns {string[]}
 */
export function pluginServerArgs(catalog, version, host, packageSpec = releaseTarballUrl(catalog, version)) {
  return ["-y", "--package", packageSpec, catalog.product.future.mcpBinary, "--host", host];
}

function readJson(filePath) {
  if (!existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function serverEntry(manifest, filePath) {
  const server = manifest.mcpServers?.[SERVER_NAME];
  if (!server || typeof server !== "object" || !Array.isArray(server.args)) {
    throw new Error(`Missing ${SERVER_NAME} MCP server in ${filePath}`);
  }
  return server;
}

/**
 * Computes every plugin manifest as it should read for the root's package
 * version. Returns `[relativePath, expectedObject]` pairs.
 *
 * @param {string} root
 * @param {{ packageSpec?: string }} [options]
 * @returns {Array<[string, unknown]>}
 */
export function expectedPluginManifests(root, options = {}) {
  const catalog = readJson(path.join(root, "src", "identity-catalog.json"));
  const { version } = readJson(path.join(root, "package.json"));
  const argsFor = (host) => pluginServerArgs(catalog, version, host, options.packageSpec);

  const mcpPath = ".mcp.json";
  const mcp = readJson(path.join(root, mcpPath));
  Object.assign(serverEntry(mcp, mcpPath), { command: "npx", args: argsFor("codex") });

  const claudePath = path.join(".claude-plugin", "plugin.json");
  const claude = readJson(path.join(root, claudePath));
  claude.version = version;
  Object.assign(serverEntry(claude, claudePath), { command: "npx", args: argsFor("claude") });

  const codexPath = path.join(".codex-plugin", "plugin.json");
  const codex = readJson(path.join(root, codexPath));
  codex.version = version;

  const claudeMarketplacePath = path.join(".claude-plugin", "marketplace.json");
  const claudeMarketplace = readJson(path.join(root, claudeMarketplacePath));
  claudeMarketplace.name = catalog.release.marketplaceName;
  for (const plugin of claudeMarketplace.plugins ?? []) {
    if (plugin.name === SERVER_NAME) plugin.version = version;
  }

  const codexMarketplacePath = path.join(".agents", "plugins", "marketplace.json");
  const codexMarketplace = readJson(path.join(root, codexMarketplacePath));
  codexMarketplace.name = catalog.release.marketplaceName;

  return [
    [mcpPath, mcp],
    [claudePath, claude],
    [codexPath, codex],
    [claudeMarketplacePath, claudeMarketplace],
    [codexMarketplacePath, codexMarketplace],
  ];
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * @param {string} root
 * @param {{ check?: boolean, packageSpec?: string }} [options]
 * @returns {string[]} relative paths that were stale (and, unless checking, rewritten)
 */
export function syncPluginManifests(root, options = {}) {
  const stale = [];
  for (const [relativePath, expected] of expectedPluginManifests(root, options)) {
    const filePath = path.join(root, relativePath);
    const text = serialize(expected);
    if (readFileSync(filePath, "utf-8") === text) continue;
    stale.push(relativePath);
    if (!options.check) writeFileSync(filePath, text, "utf-8");
  }
  return stale;
}

function main(argv) {
  const check = argv.includes("--check");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 && argv[rootIndex + 1]
    ? path.resolve(argv[rootIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stale = syncPluginManifests(root, { check });
  if (check && stale.length > 0) {
    console.error(`Plugin manifests do not match package.json; run npm run sync:plugin-manifests:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log(check ? "Plugin manifests match package.json" : `Updated ${stale.length} plugin manifest(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
