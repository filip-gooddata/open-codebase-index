#!/usr/bin/env node
// Prints release notes for one version: the matching CHANGELOG.md section plus
// fork install guidance. Usage: node scripts/fork-release-notes.mjs <version> <platforms>
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const [version, platforms] = process.argv.slice(2);
if (!version || !platforms) {
  console.error("Usage: node scripts/fork-release-notes.mjs <version> <comma-separated platforms>");
  process.exit(2);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8").split("\n");
const heading = `## [${version}]`;
const start = changelog.findIndex((line) => line.startsWith(heading));
if (start === -1) {
  console.error(`CHANGELOG.md has no section starting with "${heading}"`);
  process.exit(1);
}
let end = changelog.findIndex((line, index) => index > start && line.startsWith("## ["));
if (end === -1) end = changelog.length;
const section = changelog.slice(start + 1, end).join("\n").trim();
if (section.length === 0) {
  console.error(`CHANGELOG.md section "${heading}" is empty`);
  process.exit(1);
}

const tarball = `open-codebase-index-${version}.tgz`;
process.stdout.write(`**Not published to npm.** Install from the attached tarball: \`npm install -g ./${tarball}\`.

**Native binaries included:** ${platforms.split(",").map((p) => `\`${p}\``).join(", ")}. Other platforms fall back to a non-functional native stub. Each \`.node\` file is also attached individually; \`SHA256SUMS\` covers every asset.

${section}
`);
