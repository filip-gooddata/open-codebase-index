import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, readlinkSync, realpathSync } from "fs";
import * as os from "os";
import * as path from "path";

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
  realpath: (filePath: string) => string | null;
}

interface MountEntry {
  mountPoint: string;
  local: boolean;
}

const MACHINE_ID_NAMESPACE = "open-codebase-index:index-lock:v1";
const HOST_NAMES_TTL_MS = 30_000;
const MISSING_MACHINE_ID_RETRY_MS = 60_000;
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

function resolveRealPath(filePath: string): string | null {
  try {
    return realpathSync.native(filePath);
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
  realpath: resolveRealPath,
};

// Linux filesystem types whose files other machines can also reach.
const SHARED_LINUX_FILESYSTEMS = new Set([
  "nfs", "nfs4", "cifs", "smb3", "smbfs", "ncpfs", "9p", "afs", "ceph", "glusterfs", "lustre", "gpfs", "beegfs",
  "ocfs2", "gfs2", "davfs", "virtiofs",
]);

let sources: LockHostIdentitySources = defaultSources;
let cachedMachineId: { id: string | null; expiresAt: number } | undefined;
let cachedHostNames: { names: string[]; expiresAt: number } | undefined;
let cachedMounts: { mounts: MountEntry[]; expiresAt: number } | undefined;

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
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Every name this machine currently answers to; the OS hostname comes first. On macOS
 * that adds the configured HostName and the Bonjour LocalHostName, bare and with
 * `.local`, which macOS keeps unique on the local network.
 */
export function resolveLocalHostNames(source: LockHostIdentitySources): string[] {
  const names = [source.hostname()];
  if (source.platform === "darwin") {
    const hostName = source.run("/usr/sbin/scutil", ["--get", "HostName"])?.trim();
    if (hostName) names.push(hostName);
    const localHostName = source.run("/usr/sbin/scutil", ["--get", "LocalHostName"])?.trim();
    if (localHostName) names.push(localHostName, `${localHostName}.local`);
  }
  return [...new Set(names.filter((name) => name.length > 0))];
}

export function getLocalMachineId(): string | null {
  const now = Date.now();
  if (cachedMachineId === undefined || cachedMachineId.expiresAt <= now) {
    const id = resolveLocalMachineId(sources);
    cachedMachineId = { id, expiresAt: id === null ? now + MISSING_MACHINE_ID_RETRY_MS : Number.POSITIVE_INFINITY };
  }
  return cachedMachineId.id;
}

function getLocalHostNames(): string[] {
  const now = Date.now();
  if (cachedHostNames === undefined || cachedHostNames.expiresAt <= now) {
    cachedHostNames = { names: resolveLocalHostNames(sources), expiresAt: now + HOST_NAMES_TTL_MS };
  }
  return cachedHostNames.names;
}

/** Parses `mount` output on macOS, where `local` marks storage no other machine reaches. */
export function parseDarwinMounts(output: string): MountEntry[] {
  return output.split("\n").flatMap((line) => {
    const match = /^.* on (.+) \(([^()]*)\)$/.exec(line.trim());
    if (!match) return [];
    const options = match[2].split(",").map((option) => option.trim());
    return [{ mountPoint: match[1], local: options.includes("local") }];
  });
}

/** Parses /proc/self/mounts on Linux; FUSE and shared filesystem types count as not local. */
export function parseLinuxMounts(contents: string): MountEntry[] {
  return contents.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) return [];
    const mountPoint = fields[1].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    const type = fields[2];
    return [{ mountPoint, local: !SHARED_LINUX_FILESYSTEMS.has(type) && !type.startsWith("fuse") }];
  });
}

function getMounts(): MountEntry[] {
  const now = Date.now();
  if (cachedMounts === undefined || cachedMounts.expiresAt <= now) {
    let mounts: MountEntry[] = [];
    if (sources.platform === "darwin") {
      const output = sources.run("/sbin/mount", []);
      mounts = output === null ? [] : parseDarwinMounts(output);
    } else if (sources.platform === "linux") {
      const contents = sources.readFile("/proc/self/mounts");
      mounts = contents === null ? [] : parseLinuxMounts(contents);
    }
    cachedMounts = { mounts, expiresAt: now + HOST_NAMES_TTL_MS };
  }
  return cachedMounts.mounts;
}

/** Whether the storage holding a path is local to this machine; false when unknown. */
export function isStorageLocal(storagePath: string): boolean {
  let candidate = storagePath;
  let realPath = sources.realpath(candidate);
  while (realPath === null && path.dirname(candidate) !== candidate) {
    candidate = path.dirname(candidate);
    realPath = sources.realpath(candidate);
  }
  if (realPath === null) return false;
  let best: MountEntry | undefined;
  for (const mount of getMounts()) {
    const prefix = mount.mountPoint.endsWith(path.sep) ? mount.mountPoint : `${mount.mountPoint}${path.sep}`;
    if (realPath !== mount.mountPoint && !realPath.startsWith(prefix)) continue;
    if (best === undefined || mount.mountPoint.length > best.mountPoint.length) best = mount;
  }
  return best?.local ?? false;
}

/** Whether a recorded hostname is one this machine answers to now, ignoring any machine id. */
export function lockOwnerNamesThisHost(owner: LockHostOwner): boolean {
  if (owner.hostname === sources.hostname()) return true;
  const recorded = normalizeLockHostName(owner.hostname);
  return recorded.length > 0 && getLocalHostNames().some((name) => normalizeLockHostName(name) === recorded);
}

/**
 * Whether a lock owner was written on this machine, so its PID can be checked here.
 * A recorded machine id decides on its own; when this machine cannot produce one,
 * such an owner stays unverified. An owner without one counts when it records the
 * exact OS hostname, as before. Any other name this machine answers to (a former
 * spelling, the macOS Bonjour name) counts only for a lock on local storage, since a
 * machine elsewhere can use the same name for a store it shares.
 */
export function isLocalLockOwner(owner: LockHostOwner, storagePath?: string): boolean {
  if (owner.machineId !== undefined) return owner.machineId === getLocalMachineId();
  if (owner.hostname === sources.hostname()) return true;
  if (!lockOwnerNamesThisHost(owner)) return false;
  return storagePath !== undefined && isStorageLocal(storagePath);
}

export function setLockHostIdentitySourcesForTesting(override: Partial<LockHostIdentitySources> | null): void {
  sources = override === null ? defaultSources : { ...defaultSources, ...override };
  cachedMachineId = undefined;
  cachedHostNames = undefined;
  cachedMounts = undefined;
}
