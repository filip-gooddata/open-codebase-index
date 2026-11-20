import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, readlinkSync, realpathSync, statfsSync } from "fs";
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
  /** Filesystem type of the storage visible at an existing path, as statfs reports it. */
  statfsType: (filePath: string) => number | null;
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

function readStatfsType(filePath: string): number | null {
  try {
    return statfsSync(filePath).type;
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
  statfsType: readStatfsType,
};

// statfs magic numbers (Linux kernel ABI) of filesystems on this machine's own block
// devices or memory. Any other type (network, cluster, FUSE, unknown) counts as possibly shared.
const LOCAL_LINUX_FILESYSTEM_MAGICS = new Set([
  0xef53, // ext2, ext3, ext4
  0x58465342, // xfs
  0x9123683e, // btrfs
  0x2fc12fc1, // zfs
  0xf2f52010, // f2fs
  0xca451a4e, // bcachefs
  0x3153464a, // jfs
  0x52654973, // reiserfs
  0x3434, // nilfs2
  0x4d44, // vfat, msdos
  0x2011bab0, // exfat
  0x5346544e, // ntfs
  0x7366746e, // ntfs3
  0x482b, // hfsplus
  0x01021994, // tmpfs
  0x858458f6, // ramfs
  0x794c7630, // overlay
  0x73717368, // squashfs
  0xe0f5e1e2, // erofs
]);

let sources: LockHostIdentitySources = defaultSources;
let cachedMachineId: { id: string | null; expiresAt: number } | undefined;
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

function readWindowsMachineId(source: LockHostIdentitySources): string | null {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const output = source.run(`${systemRoot}\\System32\\reg.exe`, [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
    "/v",
    "MachineGuid",
  ]);
  const match = output ? /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(output) : null;
  return match ? `win32:${match[1].toLowerCase()}` : null;
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
  else if (source.platform === "win32") raw = readWindowsMachineId(source);
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

/** Parses `df -P <path>` output on macOS: the mount point of the filesystem holding the path. */
export function parseDarwinDfMountPoint(output: string): string | null {
  const line = output.trim().split("\n").at(-1) ?? "";
  const match = /\s\d+%\s+(\/.*)$/.exec(line);
  return match ? match[1] : null;
}

function nearestExistingPath(storagePath: string): string | null {
  let candidate = storagePath;
  let realPath = sources.realpath(candidate);
  while (realPath === null && path.dirname(candidate) !== candidate) {
    candidate = path.dirname(candidate);
    realPath = sources.realpath(candidate);
  }
  return realPath;
}

/**
 * Whether the storage holding a path is known to be local to this machine; false when
 * unknown. Both platforms ask about the filesystem actually visible at the path rather
 * than inferring it from mount order: Linux through the statfs magic, macOS through `df`
 * for the mount point and the mount table's `local` flag for every entry stacked there.
 * Read fresh on every call: it only runs for hostname-only locks, and mounts change.
 */
export function isStorageLocal(storagePath: string): boolean {
  const existing = nearestExistingPath(storagePath);
  if (existing === null) return false;
  if (sources.platform === "linux") {
    const type = sources.statfsType(existing);
    return type !== null && LOCAL_LINUX_FILESYSTEM_MAGICS.has(type >>> 0);
  }
  if (sources.platform === "darwin") {
    const dfOutput = sources.run("/bin/df", ["-P", existing]);
    const mountPoint = dfOutput === null ? null : parseDarwinDfMountPoint(dfOutput);
    const mountOutput = mountPoint === null ? null : sources.run("/sbin/mount", []);
    if (mountOutput === null) return false;
    const entries = parseDarwinMounts(mountOutput).filter((mount) => mount.mountPoint === mountPoint);
    return entries.length > 0 && entries.every((mount) => mount.local);
  }
  return false;
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
 * such an owner stays unverified. An owner without one (written by an older release,
 * or on a machine without an id) counts only when it names this host and the lock
 * sits on storage known to be local, since a machine elsewhere can use the same name
 * for a store it shares.
 */
export function isLocalLockOwner(owner: LockHostOwner, storagePath?: string): boolean {
  if (owner.machineId !== undefined) return owner.machineId === getLocalMachineId();
  if (!lockOwnerNamesThisHost(owner)) return false;
  return storagePath !== undefined && isStorageLocal(storagePath);
}

export function setLockHostIdentitySourcesForTesting(override: Partial<LockHostIdentitySources> | null): void {
  sources = override === null ? defaultSources : { ...defaultSources, ...override };
  cachedMachineId = undefined;
  cachedHostNames = undefined;
}
