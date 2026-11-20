import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, readlinkSync } from "fs";
import * as os from "os";

export interface LockHostOwner {
  hostname: string;
  machineId?: string;
}

export interface LockHostIdentitySources {
  platform: NodeJS.Platform;
  hostname: () => string;
  readFile: (filePath: string) => string | null;
  readLink: (filePath: string) => string | null;
  run: (file: string, args: readonly string[]) => string | null;
}

const MACHINE_ID_NAMESPACE = "open-codebase-index:index-lock:v1";
const HOST_NAMES_TTL_MS = 30_000;
const COMMAND_TIMEOUT_MS = 2_000;

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function readLinkTarget(filePath: string): string | null {
  try {
    return readlinkSync(filePath);
  } catch {
    return null;
  }
}

function runCommand(file: string, args: readonly string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

const defaultSources: LockHostIdentitySources = {
  platform: process.platform,
  hostname: () => os.hostname(),
  readFile: readTextFile,
  readLink: readLinkTarget,
  run: runCommand,
};

let sources: LockHostIdentitySources = defaultSources;
let cachedMachineId: string | null | undefined;
let cachedHostNames: { names: string[]; expiresAt: number } | undefined;

function hashMachineId(raw: string): string {
  return createHash("sha256").update(`${MACHINE_ID_NAMESPACE}\0${raw}`).digest("hex").slice(0, 32);
}

function readLinuxMachineId(source: LockHostIdentitySources): string | null {
  const machineId = [source.readFile("/etc/machine-id"), source.readFile("/var/lib/dbus/machine-id")]
    .map((value) => value?.trim() ?? "")
    .find((value) => /^[0-9a-f]{32}$/i.test(value));
  if (!machineId) return null;
  // Containers can share an image's machine-id while having separate PID namespaces.
  const pidNamespace = source.readLink("/proc/self/ns/pid")?.trim();
  if (!pidNamespace) return null;
  return `linux:${machineId.toLowerCase()}:${pidNamespace}`;
}

function readDarwinMachineId(source: LockHostIdentitySources): string | null {
  const output = source.run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const match = output ? /"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i.exec(output) : null;
  return match ? `darwin:${match[1].toUpperCase()}` : null;
}

/**
 * Stable identity of this machine and PID namespace, hashed so the raw platform id
 * never lands on disk. Null when the platform offers no reliable identity.
 */
export function resolveLocalMachineId(source: LockHostIdentitySources): string | null {
  let raw: string | null = null;
  if (source.platform === "linux") raw = readLinuxMachineId(source);
  else if (source.platform === "darwin") raw = readDarwinMachineId(source);
  return raw === null ? null : hashMachineId(raw);
}

export function normalizeLockHostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "").replace(/\.local$/, "");
}

/** Every name this machine currently answers to; the OS hostname comes first. */
export function resolveLocalHostNames(source: LockHostIdentitySources): string[] {
  const names = [source.hostname()];
  if (source.platform === "darwin") {
    for (const key of ["LocalHostName", "HostName"]) {
      const value = source.run("/usr/sbin/scutil", ["--get", key])?.trim();
      if (value) names.push(value);
    }
  }
  return [...new Set(names.filter((name) => name.length > 0))];
}

export function getLocalMachineId(): string | null {
  if (cachedMachineId === undefined) cachedMachineId = resolveLocalMachineId(sources);
  return cachedMachineId;
}

function getLocalHostNames(): string[] {
  const now = Date.now();
  if (cachedHostNames === undefined || cachedHostNames.expiresAt <= now) {
    cachedHostNames = { names: resolveLocalHostNames(sources), expiresAt: now + HOST_NAMES_TTL_MS };
  }
  return cachedHostNames.names;
}

/**
 * Whether a lock owner was written on this machine, so its PID can be checked here.
 * A recorded machine id decides on its own when this machine has one too. Otherwise
 * the recorded hostname must match a name this machine currently answers to.
 */
export function isLocalLockOwner(owner: LockHostOwner): boolean {
  if (owner.machineId !== undefined) {
    const localMachineId = getLocalMachineId();
    if (localMachineId !== null) return owner.machineId === localMachineId;
  }
  if (owner.hostname === sources.hostname()) return true;
  const recorded = normalizeLockHostName(owner.hostname);
  if (recorded.length === 0) return false;
  return getLocalHostNames().some((name) => normalizeLockHostName(name) === recorded);
}

export function setLockHostIdentitySourcesForTesting(override: Partial<LockHostIdentitySources> | null): void {
  sources = override === null ? defaultSources : { ...defaultSources, ...override };
  cachedMachineId = undefined;
  cachedHostNames = undefined;
}
