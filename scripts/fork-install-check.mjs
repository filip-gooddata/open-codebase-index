#!/usr/bin/env node
// Installs a packed tarball into a fresh temporary project, imports the package
// through both module systems, and calls a native function from the bundled
// binary for the current platform. Usage: node scripts/fork-install-check.mjs <tarball>
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}
