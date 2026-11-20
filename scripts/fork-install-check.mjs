#!/usr/bin/env node
// Installs a packed tarball into a fresh temporary project, imports the package
// through both module systems, and calls a native function from the bundled
// binary for the current platform. Usage: node scripts/fork-install-check.mjs <tarball>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const tarballArgument = process.argv[2];
if (!tarballArgument || !existsSync(tarballArgument)) {
  console.error("Usage: node scripts/fork-install-check.mjs <existing tarball>");
  process.exit(2);
}
const tarball = path.resolve(tarballArgument);

const platformSuffixes = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
  "win32-arm64": "win32-arm64-msvc",
  "win32-x64": "win32-x64-msvc",
};
const suffix = platformSuffixes[`${process.platform}-${process.arch}`];
if (!suffix) throw new Error(`Unsupported platform ${process.platform}-${process.arch}`);

const projectRoot = mkdtempSync(path.join(os.tmpdir(), "fork-install-check-"));
try {
  writeFileSync(path.join(projectRoot, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const packageName = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
  ).name;
  const packageRoot = path.join(projectRoot, "node_modules", packageName);
  const installedManifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  console.log(`Installed ${installedManifest.name}@${installedManifest.version}`);

  const projectRequire = createRequire(path.join(projectRoot, "index.cjs"));
  const cjsExports = projectRequire(packageName);
  const importTarget = installedManifest.exports["."].import;
  const importPath = typeof importTarget === "string" ? importTarget : importTarget.default;
  const esmExports = await import(pathToFileURL(path.join(packageRoot, importPath)).href);
  for (const [label, exported] of [["require", cjsExports], ["import", esmExports]]) {
    if (exported === null || typeof exported !== "object" || Object.keys(exported).length === 0) {
      throw new Error(`${label}(${packageName}) returned no exports`);
    }
    console.log(`${label}(${packageName}) exports: ${Object.keys(exported).sort().join(", ")}`);
  }

  const binaryPath = path.join(packageRoot, "native", `codebase-index-native.${suffix}.node`);
  if (!existsSync(binaryPath)) throw new Error(`Installed package lacks ${path.basename(binaryPath)}`);
  const native = projectRequire(binaryPath);
  if (typeof native.hashContent !== "function") throw new Error("Native module has no hashContent export");
  const first = native.hashContent("fork install check");
  const second = native.hashContent("fork install check");
  const other = native.hashContent("fork install check!");
  if (typeof first !== "string" || first.length === 0 || first !== second || first === other) {
    throw new Error(`hashContent returned unexpected values: ${JSON.stringify([first, second, other])}`);
  }
  console.log(`Loaded ${path.basename(binaryPath)}; hashContent -> ${first}`);

  // Exercise the package's own loader: a dry-run index parses and chunks a
  // fixture through native code and fails or reports no chunks if the loader
  // fell back to its stub.
  const fixtureRoot = path.join(projectRoot, "fixture");
  mkdirSync(fixtureRoot);
  execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
  writeFileSync(path.join(fixtureRoot, "math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  // A dry run reads the chunk token limit from the configured embedding model
  // but never calls the provider, so an unreachable custom endpoint suffices on
  // runners without credentials or a local Ollama.
  const configPath = path.join(projectRoot, "codebase-index.json");
  writeFileSync(configPath, `${JSON.stringify({
    embeddingProvider: "custom",
    customProvider: { baseUrl: "http://127.0.0.1:9/v1", model: "install-check", dimensions: 8 },
  })}\n`);
  const cli = path.join(packageRoot, installedManifest.bin.ocbi);
  const indexArgs = [cli, "index", "--dry-run", "--project", fixtureRoot, "--config", configPath];
  const indexRun = spawnSync(process.execPath, indexArgs, {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(projectRoot, "home"), USERPROFILE: path.join(projectRoot, "home") },
  });
  const indexOutput = `${indexRun.stdout}${indexRun.stderr}`;
  const chunks = /Chunks to embed:\s+(\d+)/.exec(indexOutput);
  if (indexRun.status !== 0 || !chunks || Number(chunks[1]) < 1 || indexOutput.includes("Failed to load native module")) {
    throw new Error(`ocbi index --dry-run failed (exit ${indexRun.status}):\n${indexOutput}`);
  }
  console.log(`ocbi index --dry-run via the package loader: ${chunks[1]} chunk(s) to embed`);
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}
