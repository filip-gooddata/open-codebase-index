import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { HostMode } from "./config/host.js";
import { getGlobalConfigPath } from "./config/paths.js";
import { IDENTITY_CATALOG } from "./identity-catalog.js";
import { getPackageVersion } from "./package-metadata.js";

/**
 * The Claude Code and Codex plugins start whichever `open-codebase-index-mcp` is on PATH and pass
 * the release version they pin in this variable, so an installed binary of another version can
 * say so. Keep the name in step with scripts/plugin-manifests.mjs.
 */
export const PLUGIN_VERSION_ENV = "OCBI_PLUGIN_VERSION";


export interface PluginLaunchRecord {
  host: HostMode;
  pluginVersion: string;
  serverVersion: string;
  recordedAt: string;
}

export interface PluginVersionPin {
  version: string;
  source: "environment" | "last plugin launch";
  recordedAt?: string;
}

/**
 * Next to the host's global config, so `ocbi status` in a terminal finds what the plugin pinned.
 * One file per host mode: Codex, Pi and Jcode share their global config directory.
 */
export function getPluginLaunchRecordPath(host: HostMode): string {
  return path.join(path.dirname(getGlobalConfigPath(host)), `codebase-index-plugin-launch.${host}.json`);
}

export function releaseTarballUrl(version: string): string {
  const repository = IDENTITY_CATALOG.release.repository.replace(/\/+$/, "");
  const packageName = IDENTITY_CATALOG.product.future.packageName;
  return `${repository}/releases/download/${IDENTITY_CATALOG.release.tagPrefix}${version}/${packageName}-${version}.tgz`;
}

function pinFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  const value = env[PLUGIN_VERSION_ENV]?.trim();
  return value ? value : null;
}

/**
 * Records the plugin's pinned version when a plugin starts this server. Returns the record path,
 * or null when the server was not started by a plugin.
 */
export function recordPluginLaunch(
  host: HostMode,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): string | null {
  const pluginVersion = pinFromEnvironment(env);
  if (pluginVersion === null) return null;
  const recordPath = getPluginLaunchRecordPath(host);
  const record: PluginLaunchRecord = {
    host,
    pluginVersion,
    serverVersion: getPackageVersion(),
    recordedAt: now.toISOString(),
  };
  mkdirSync(path.dirname(recordPath), { recursive: true });
  const temporary = `${recordPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  renameSync(temporary, recordPath);
  return recordPath;
}

function readLaunchRecord(host: HostMode): PluginLaunchRecord | null {
  const recordPath = getPluginLaunchRecordPath(host);
  if (!existsSync(recordPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf-8")) as Partial<PluginLaunchRecord>;
    if (parsed.host !== host) return null;
    if (typeof parsed.pluginVersion !== "string" || parsed.pluginVersion.trim() === "") return null;
    return {
      host,
      pluginVersion: parsed.pluginVersion.trim(),
      serverVersion: typeof parsed.serverVersion === "string" ? parsed.serverVersion : "",
      recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
    };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The plugin's pin: from this process's environment, else from the last plugin launch for the host. */
export function resolvePluginVersionPin(host: HostMode, env: NodeJS.ProcessEnv = process.env): PluginVersionPin | null {
  const fromEnvironment = pinFromEnvironment(env);
  if (fromEnvironment !== null) return { version: fromEnvironment, source: "environment" };
  const record = readLaunchRecord(host);
  if (record === null) return null;
  return {
    version: record.pluginVersion,
    source: "last plugin launch",
    ...(record.recordedAt ? { recordedAt: record.recordedAt } : {}),
  };
}

/**
 * A status warning when the running package differs from the plugin's pinned release; null when
 * they match or no plugin pin is known. A warning only: the server keeps working.
 */
export function formatPluginVersionSkew(
  host: HostMode,
  env: NodeJS.ProcessEnv = process.env,
  currentVersion: string = getPackageVersion(),
): string | null {
  let pin: PluginVersionPin | null;
  try {
    pin = resolvePluginVersionPin(host, env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Plugin version check: cannot read ${getPluginLaunchRecordPath(host)}: ${message}`;
  }
  if (pin === null || pin.version === currentVersion) return null;
  const origin = pin.source === "environment"
    ? "the codebase-index plugin that started this server pins"
    : `the codebase-index plugin last started a ${host} server${pin.recordedAt ? ` at ${pin.recordedAt}` : ""} pinning`;
  return `Version skew: ${origin} ${pin.version}, but the installed open-codebase-index is ${currentVersion}. `
    + `Install the pinned release with \`npm install -g ${releaseTarballUrl(pin.version)}\` `
    + "(or rerun the local wrapper's install.sh with that URL), or update the plugin.";
}
