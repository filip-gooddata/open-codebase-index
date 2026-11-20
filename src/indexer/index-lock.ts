import { randomUUID } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import * as os from "os";
import * as path from "path";

import { getLocalMachineId, isLocalLockOwner } from "./lock-host-identity.js";

export type IndexMutationOperation =
  | "initialize"
  | "index"
  | "force-index"
  | "clear"
  | "health-check"
  | "retry-failed-batches"
  | "recovery"
  | "worktree"
  | "prune";

export interface IndexLockOwner {
  pid: number;
  hostname: string;
  /** Hashed machine identity; absent in locks written by older versions. */
  machineId?: string;
  startedAt: string;
  operation: IndexMutationOperation;
  token: string;
  /** Set on a recovery marker whose unverifiable owner was explicitly abandoned. */
  abandonedAt?: string;
  /** Recovery protocol written by owners that persist destructive phase state. */
  recoveryProtocolVersion?: 1;
  /** Originating project root for interrupted global clears (recovery scope). */
  projectRoot?: string;
  /** Originating scoped roots for interrupted global clears (recovery scope). */
  scopedRoots?: string[];
  /** Destructive clear state, present only while a clear is in progress. */
  clearRecovery?: IndexLockClearRecoveryState;
}

export interface IndexLockClearRecoveryState {
  phase: "clearing";
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingStrategyVersion: string;
  compatibilityDecision: "compatible" | "embedding-strategy-mismatch" | "incompatible";
}

export interface IndexLockRecovery {
  owner: IndexLockOwner;
  markerPath: string;
}

export interface IndexLockLease {
  canonicalIndexPath: string;
  lockPath: string;
  owner: IndexLockOwner;
  recoveries: IndexLockRecovery[];
}

type OwnerLiveness = "alive" | "dead" | "unknown";

interface ReclaimOwner {
  pid: number;
  hostname: string;
  machineId?: string;
  startedAt: string;
  token: string;
  expectedOwnerToken: string;
}

const OWNER_FILE_NAME = "owner.json";
const RECLAIM_DIRECTORY_NAME = "reclaiming";
const RECOVERY_MARKER_PREFIX = "indexing.lock.recovery.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_OPERATIONS = new Set<IndexMutationOperation>([
  "initialize",
  "index",
  "force-index",
  "clear",
  "health-check",
  "retry-failed-batches",
  "recovery",
  "worktree",
  "prune",
]);

let temporaryCounter = 0;

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function retryTransientFilesystemOperation(operation: () => void): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      operation();
      return;
    } catch (error) {
      lastError = error;
      const code = getErrorCode(error);
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      if (attempt < 2) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 10);
      }
    }
  }
  throw lastError;
}

function parseOwner(value: unknown): IndexLockOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<IndexLockOwner>;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return null;
  if (typeof candidate.hostname !== "string" || candidate.hostname.length === 0) return null;
  if (candidate.machineId !== undefined && typeof candidate.machineId !== "string") return null;
  if (typeof candidate.startedAt !== "string" || Number.isNaN(Date.parse(candidate.startedAt))) return null;
  if (candidate.abandonedAt !== undefined
    && (typeof candidate.abandonedAt !== "string" || Number.isNaN(Date.parse(candidate.abandonedAt)))) return null;
  if (typeof candidate.operation !== "string" || !VALID_OPERATIONS.has(candidate.operation as IndexMutationOperation)) return null;
  if (typeof candidate.token !== "string" || !UUID_PATTERN.test(candidate.token)) return null;
  if (candidate.recoveryProtocolVersion !== undefined && candidate.recoveryProtocolVersion !== 1) return null;
  if (candidate.projectRoot !== undefined && typeof candidate.projectRoot !== "string") return null;
  if (candidate.scopedRoots !== undefined) {
    if (!Array.isArray(candidate.scopedRoots) || candidate.scopedRoots.some((root) => typeof root !== "string")) {
      return null;
    }
  }
  if (candidate.clearRecovery !== undefined) {
    const recovery = candidate.clearRecovery as Partial<IndexLockClearRecoveryState>;
    if (
      typeof recovery !== "object"
      || recovery === null
      || recovery.phase !== "clearing"
      || typeof recovery.embeddingProvider !== "string"
      || recovery.embeddingProvider.length === 0
      || typeof recovery.embeddingModel !== "string"
      || recovery.embeddingModel.length === 0
      || !Number.isInteger(recovery.embeddingDimensions)
      || (recovery.embeddingDimensions ?? 0) <= 0
      || typeof recovery.embeddingStrategyVersion !== "string"
      || recovery.embeddingStrategyVersion.length === 0
      || (
        recovery.compatibilityDecision !== "compatible"
        && recovery.compatibilityDecision !== "embedding-strategy-mismatch"
        && recovery.compatibilityDecision !== "incompatible"
      )
      || (candidate.operation !== "clear" && candidate.operation !== "force-index")
    ) {
      return null;
    }
  }
  return candidate as IndexLockOwner;
}

function parseReclaimOwner(value: unknown): ReclaimOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ReclaimOwner>;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return null;
  if (typeof candidate.hostname !== "string" || candidate.hostname.length === 0) return null;
  if (candidate.machineId !== undefined && typeof candidate.machineId !== "string") return null;
  if (typeof candidate.startedAt !== "string" || Number.isNaN(Date.parse(candidate.startedAt))) return null;
  if (typeof candidate.token !== "string" || !UUID_PATTERN.test(candidate.token)) return null;
  if (typeof candidate.expectedOwnerToken !== "string" || !UUID_PATTERN.test(candidate.expectedOwnerToken)) return null;
  return candidate as ReclaimOwner;
}

function readJsonDirectory<T>(directoryPath: string, parser: (value: unknown) => T | null): T | null {
  try {
    return parser(JSON.parse(readFileSync(path.join(directoryPath, OWNER_FILE_NAME), "utf-8")));
  } catch {
    return null;
  }
}

function readDirectoryOwner(lockPath: string): IndexLockOwner | null {
  return readJsonDirectory(lockPath, parseOwner);
}

function readReclaimOwner(markerPath: string): ReclaimOwner | null {
  return readJsonDirectory(markerPath, parseReclaimOwner);
}

function readRecoveryOwner(markerPath: string): IndexLockOwner | null {
  return readDirectoryOwner(markerPath);
}

function readLegacyOwner(lockPath: string): IndexLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid?: unknown;
      startedAt?: unknown;
      hostname?: unknown;
      operation?: unknown;
      token?: unknown;
    };
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return null;
    if (typeof parsed.startedAt !== "string" || Number.isNaN(Date.parse(parsed.startedAt))) return null;
    return {
      pid: Number(parsed.pid),
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : os.hostname(),
      startedAt: parsed.startedAt,
      operation: typeof parsed.operation === "string" && VALID_OPERATIONS.has(parsed.operation as IndexMutationOperation)
        ? parsed.operation as IndexMutationOperation
        : "index",
      token: typeof parsed.token === "string" ? parsed.token : "legacy-v0.14.0",
    };
  } catch {
    return null;
  }
}

function getOwnerLiveness(owner: Pick<IndexLockOwner, "pid" | "hostname" | "machineId">): OwnerLiveness {
  if (!isLocalLockOwner(owner)) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function sameOwner(left: IndexLockOwner, right: IndexLockOwner): boolean {
  return left.pid === right.pid && left.hostname === right.hostname && left.token === right.token;
}

function sameReclaimOwner(left: ReclaimOwner, right: ReclaimOwner): boolean {
  return left.pid === right.pid
    && left.hostname === right.hostname
    && left.token === right.token
    && left.expectedOwnerToken === right.expectedOwnerToken;
}

function publishJsonDirectory(finalPath: string, value: IndexLockOwner | ReclaimOwner): boolean {
  const candidatePath = `${finalPath}.candidate.${process.pid}.${randomUUID()}`;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    writeFileSync(path.join(candidatePath, OWNER_FILE_NAME), JSON.stringify(value), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    if (existsSync(finalPath)) return false;
    try {
      renameSync(candidatePath, finalPath);
      return true;
    } catch (error) {
      if (existsSync(finalPath)) return false;
      if (getErrorCode(error) === "ENOENT") return false;
      throw error;
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  } finally {
    if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true });
  }
}

function localIdentityFields(): { pid: number; hostname: string; machineId?: string } {
  const machineId = getLocalMachineId();
  return machineId === null
    ? { pid: process.pid, hostname: os.hostname() }
    : { pid: process.pid, hostname: os.hostname(), machineId };
}

function createOwner(operation: IndexMutationOperation): IndexLockOwner {
  return {
    ...localIdentityFields(),
    startedAt: new Date().toISOString(),
    operation,
    token: randomUUID(),
  };
}

export interface IndexLockRecoveryScope {
  projectRoot: string;
  scopedRoots: string[];
}

function recoveryMarkerPath(indexPath: string, owner: IndexLockOwner): string {
  return path.join(indexPath, `${RECOVERY_MARKER_PREFIX}${owner.token}`);
}

function publishRecoveryMarker(indexPath: string, owner: IndexLockOwner, abandon = false): string {
  const markerPath = recoveryMarkerPath(indexPath, owner);
  const markerOwner = abandon ? { ...owner, abandonedAt: new Date().toISOString() } : owner;
  if (!publishJsonDirectory(markerPath, markerOwner)) {
    const markerOwner = readRecoveryOwner(markerPath);
    if (!markerOwner || !sameOwner(markerOwner, owner)) {
      throw new IndexLockContentionError(markerPath, markerOwner, "unknown-owner");
    }
  }
  return markerPath;
}

function getPendingRecoveries(indexPath: string): IndexLockRecovery[] {
  const recoveries: IndexLockRecovery[] = [];
  const markerNames = readdirSync(indexPath).filter((name) => {
    if (!name.startsWith(RECOVERY_MARKER_PREFIX)) return false;
    return UUID_PATTERN.test(name.slice(RECOVERY_MARKER_PREFIX.length));
  }).sort();
  for (const markerName of markerNames) {
    const markerPath = path.join(indexPath, markerName);
    const markerToken = markerName.slice(RECOVERY_MARKER_PREFIX.length);
    let markerStats;
    try {
      markerStats = lstatSync(markerPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!markerStats.isDirectory()) {
      throw new IndexLockContentionError(markerPath, null, "unknown-owner");
    }
    const owner = readRecoveryOwner(markerPath);
    if (!owner || owner.token !== markerToken || !isRecoverableMarkerOwner(owner)) {
      throw new IndexLockContentionError(markerPath, owner, "unknown-owner");
    }
    recoveries.push({ owner, markerPath });
  }
  recoveries.sort((left, right) => {
    const byTimestamp = left.owner.startedAt.localeCompare(right.owner.startedAt);
    return byTimestamp !== 0 ? byTimestamp : left.markerPath.localeCompare(right.markerPath);
  });
  return recoveries;
}

function isRecoverableMarkerOwner(owner: IndexLockOwner): boolean {
  const liveness = getOwnerLiveness(owner);
  return liveness === "dead" || (owner.abandonedAt !== undefined && liveness === "unknown");
}

function cleanupDeadPublicationCandidates(indexPath: string): void {
  const candidatePattern = /^indexing\.lock(?:\.recovery\.[0-9a-f-]{36})?\.candidate\.(\d+)\.[0-9a-f-]{36}$/i;
  for (const entry of readdirSync(indexPath)) {
    const match = candidatePattern.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (getOwnerLiveness({ pid, hostname: os.hostname() }) !== "dead") continue;
    rmSync(path.join(indexPath, entry), { recursive: true, force: true });
  }
}

function removeDeadReclaimMarker(
  lockPath: string,
  expectedOwner: IndexLockOwner,
  reclaimable: (owner: IndexLockOwner) => boolean,
): boolean {
  const markerPath = path.join(lockPath, RECLAIM_DIRECTORY_NAME);
  const marker = readReclaimOwner(markerPath);
  if (!marker || marker.expectedOwnerToken !== expectedOwner.token || getOwnerLiveness(marker) !== "dead") {
    return false;
  }

  const currentOwner = readDirectoryOwner(lockPath);
  if (!currentOwner || !sameOwner(currentOwner, expectedOwner) || !reclaimable(currentOwner)) {
    return false;
  }

  const claimedMarkerPath = `${markerPath}.stale.${marker.pid}.${marker.token}.${randomUUID()}`;
  try {
    renameSync(markerPath, claimedMarkerPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }

  const claimedMarker = readReclaimOwner(claimedMarkerPath);
  const ownerAfterClaim = readDirectoryOwner(lockPath);
  if (!claimedMarker
    || !sameReclaimOwner(claimedMarker, marker)
    || !ownerAfterClaim
    || !sameOwner(ownerAfterClaim, expectedOwner)
    || !reclaimable(ownerAfterClaim)) {
    if (!existsSync(markerPath) && existsSync(claimedMarkerPath)) {
      renameSync(claimedMarkerPath, markerPath);
    }
    return false;
  }

  rmSync(claimedMarkerPath, { recursive: true, force: true });
  return true;
}

function reclaimDeadOwner(
  indexPath: string,
  lockPath: string,
  expectedOwner: IndexLockOwner,
  abandonUnverified = false,
): boolean {
  const reclaimable = (owner: IndexLockOwner): boolean => {
    const liveness = getOwnerLiveness(owner);
    return liveness === "dead" || (abandonUnverified && liveness === "unknown");
  };
  const reclaimPath = path.join(lockPath, RECLAIM_DIRECTORY_NAME);
  const reclaimOwner: ReclaimOwner = {
    ...localIdentityFields(),
    startedAt: new Date().toISOString(),
    token: randomUUID(),
    expectedOwnerToken: expectedOwner.token,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (publishJsonDirectory(reclaimPath, reclaimOwner)) break;
    if (attempt === 0 && removeDeadReclaimMarker(lockPath, expectedOwner, reclaimable)) continue;
    return false;
  }

  try {
    const currentReclaimer = readReclaimOwner(reclaimPath);
    const currentOwner = readDirectoryOwner(lockPath);
    if (!currentReclaimer
      || !sameReclaimOwner(currentReclaimer, reclaimOwner)
      || !currentOwner
      || !sameOwner(currentOwner, expectedOwner)
      || !reclaimable(currentOwner)) {
      return false;
    }

    publishRecoveryMarker(indexPath, expectedOwner, getOwnerLiveness(expectedOwner) !== "dead");

    const ownerBeforeQuarantine = readDirectoryOwner(lockPath);
    const reclaimerBeforeQuarantine = readReclaimOwner(reclaimPath);
    if (!ownerBeforeQuarantine
      || !sameOwner(ownerBeforeQuarantine, expectedOwner)
      || !reclaimable(ownerBeforeQuarantine)
      || !reclaimerBeforeQuarantine
      || !sameReclaimOwner(reclaimerBeforeQuarantine, reclaimOwner)) {
      return false;
    }

    const quarantinePath = `${lockPath}.stale.${expectedOwner.token}.${reclaimOwner.token}`;
    renameSync(lockPath, quarantinePath);
    rmSync(quarantinePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export class IndexLockContentionError extends Error {
  readonly code = "INDEX_BUSY";

  constructor(
    readonly lockPath: string,
    readonly owner: IndexLockOwner | null,
    readonly reason: "active" | "unknown-owner" | "legacy-lock" | "reclaiming",
  ) {
    const ownerDescription = owner
      ? `PID ${owner.pid} on ${owner.hostname}, operation ${owner.operation}, since ${owner.startedAt}`
      : "an unreadable owner";
    super(`Index mutation already in progress: ${ownerDescription}`);
    this.name = "IndexLockContentionError";
  }
}

export function isIndexLockContentionError(error: unknown): error is IndexLockContentionError {
  return error instanceof IndexLockContentionError
    || (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "INDEX_BUSY");
}

export function isTransientIndexLockContention(error: unknown): boolean {
  if (!isIndexLockContentionError(error) || !("reason" in error)) return false;
  return error.reason === "active" || error.reason === "reclaiming";
}

export type IndexLockEntryKind = "lock" | "legacy-lock" | "recovery-marker";
export type IndexLockEntryState = "alive" | "dead" | "unverified" | "unreadable";

export interface IndexLockEntry {
  kind: IndexLockEntryKind;
  path: string;
  contents: string | null;
  owner: IndexLockOwner | null;
  state: IndexLockEntryState;
  /** Whether the owner was written on this machine, so its PID was checked here. */
  local: boolean;
  /** Time since the owner started or last rewrote its record, when known. */
  ageMs: number | null;
}

export interface BreakIndexLockResult {
  status: "no-lock" | "removed" | "refused-alive" | "refused-unverified" | "refused-changed";
  indexPath: string;
  entries: IndexLockEntry[];
}

function readTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function modifiedTimeOrNull(filePath: string): number | null {
  try {
    return lstatSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function describeLockEntry(
  kind: IndexLockEntryKind,
  entryPath: string,
  contentsPath: string,
  owner: IndexLockOwner | null,
  ownerMatchesEntry = true,
): IndexLockEntry {
  const local = owner !== null && isLocalLockOwner(owner);
  let state: IndexLockEntryState = "unreadable";
  if (owner !== null && ownerMatchesEntry) {
    const liveness = getOwnerLiveness(owner);
    state = liveness === "unknown" ? "unverified" : liveness;
  }
  const startedAt = owner === null ? Number.NaN : Date.parse(owner.startedAt);
  const modifiedAt = modifiedTimeOrNull(contentsPath) ?? modifiedTimeOrNull(entryPath);
  const references = [startedAt, modifiedAt ?? Number.NaN].filter((value) => !Number.isNaN(value));
  return {
    kind,
    path: entryPath,
    contents: readTextOrNull(contentsPath),
    owner,
    state,
    local,
    ageMs: references.length === 0 ? null : Math.max(0, Date.now() - Math.max(...references)),
  };
}

/** Lists the lock and every recovery marker that would block the next index mutation. */
export function inspectIndexLocks(indexPath: string): IndexLockEntry[] {
  const entries: IndexLockEntry[] = [];
  const lockPath = path.join(indexPath, "indexing.lock");
  let lockStats;
  try {
    lockStats = lstatSync(lockPath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  if (lockStats?.isDirectory()) {
    entries.push(describeLockEntry("lock", lockPath, path.join(lockPath, OWNER_FILE_NAME), readDirectoryOwner(lockPath)));
  } else if (lockStats) {
    entries.push(describeLockEntry("legacy-lock", lockPath, lockPath, readLegacyOwner(lockPath)));
  }

  const markerNames = readdirSync(indexPath).filter((name) => (
    name.startsWith(RECOVERY_MARKER_PREFIX) && UUID_PATTERN.test(name.slice(RECOVERY_MARKER_PREFIX.length))
  )).sort();
  for (const markerName of markerNames) {
    const markerPath = path.join(indexPath, markerName);
    const owner = readRecoveryOwner(markerPath);
    const tokenMatches = owner?.token === markerName.slice(RECOVERY_MARKER_PREFIX.length);
    if (owner && tokenMatches && isRecoverableMarkerOwner(owner)) continue;
    entries.push(describeLockEntry("recovery-marker", markerPath, path.join(markerPath, OWNER_FILE_NAME), owner, tokenMatches));
  }
  return entries;
}

function quarantineAndRemove(entryPath: string, expectedContents: string | null, contentsPath: (moved: string) => string): boolean {
  const quarantinePath = `${entryPath}.stale.manual.${randomUUID()}`;
  try {
    renameSync(entryPath, quarantinePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (readTextOrNull(contentsPath(quarantinePath)) !== expectedContents) {
    if (!existsSync(entryPath)) renameSync(quarantinePath, entryPath);
    return false;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function abandonRecoveryMarker(entry: IndexLockEntry): boolean {
  if (entry.owner === null) return false;
  const ownerPath = path.join(entry.path, OWNER_FILE_NAME);
  if (readTextOrNull(ownerPath) !== entry.contents) return false;
  const temporaryPath = `${ownerPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, JSON.stringify({ ...entry.owner, abandonedAt: new Date().toISOString() }), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    retryTransientFilesystemOperation(() => renameSync(temporaryPath, ownerPath));
    return true;
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function breakLockEntry(indexPath: string, entry: IndexLockEntry, force: boolean): boolean {
  if (entry.kind === "lock" && entry.owner !== null) {
    return reclaimDeadOwner(indexPath, entry.path, entry.owner, force);
  }
  if (entry.kind === "recovery-marker" && entry.state !== "unreadable") {
    return abandonRecoveryMarker(entry);
  }
  const contentsPath = entry.kind === "legacy-lock"
    ? (moved: string) => moved
    : (moved: string) => path.join(moved, OWNER_FILE_NAME);
  return quarantineAndRemove(entry.path, entry.contents, contentsPath);
}

/**
 * Manual escape hatch for a lock automatic recovery refused. It never touches a lock
 * whose owner is alive on this machine; owners it cannot verify (another machine,
 * an unreadable record) need `force`. Recovery of an interrupted owner's partial
 * writes still runs on the next index mutation.
 */
export function breakIndexLock(target: string, options: { force?: boolean } = {}): BreakIndexLockResult {
  const requestedPath = path.basename(target) === "indexing.lock" ? path.dirname(target) : target;
  if (!existsSync(requestedPath)) return { status: "no-lock", indexPath: requestedPath, entries: [] };
  const indexPath = realpathSync.native(requestedPath);
  const entries = inspectIndexLocks(indexPath);
  if (entries.length === 0) return { status: "no-lock", indexPath, entries };
  if (entries.some((entry) => entry.state === "alive")) return { status: "refused-alive", indexPath, entries };
  const force = options.force === true;
  if (!force && entries.some((entry) => entry.state !== "dead")) {
    return { status: "refused-unverified", indexPath, entries };
  }
  for (const entry of entries) {
    if (!breakLockEntry(indexPath, entry, force)) return { status: "refused-changed", indexPath, entries };
  }
  return { status: "removed", indexPath, entries };
}

export function acquireIndexLock(
  indexPath: string,
  operation: IndexMutationOperation,
  recoveryScope?: IndexLockRecoveryScope,
): IndexLockLease {
  mkdirSync(indexPath, { recursive: true });
  const canonicalIndexPath = realpathSync.native(indexPath);
  const lockPath = path.join(canonicalIndexPath, "indexing.lock");
  cleanupDeadPublicationCandidates(canonicalIndexPath);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const owner = recoveryScope === undefined
      ? createOwner(operation)
      : {
          ...createOwner(operation),
          recoveryProtocolVersion: 1 as const,
          projectRoot: recoveryScope.projectRoot,
          scopedRoots: recoveryScope.scopedRoots,
        };
    if (publishJsonDirectory(lockPath, owner)) {
      const lease: IndexLockLease = {
        canonicalIndexPath,
        lockPath,
        owner,
        recoveries: [],
      };
      try {
        lease.recoveries = getPendingRecoveries(canonicalIndexPath);
        return lease;
      } catch (error) {
        releaseIndexLock(lease);
        throw error;
      }
    }

    let stats;
    try {
      stats = lstatSync(lockPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") continue;
      throw error;
    }

    if (!stats.isDirectory()) {
      const legacyOwner = readLegacyOwner(lockPath);
      throw new IndexLockContentionError(lockPath, legacyOwner, "legacy-lock");
    }

    const existingOwner = readDirectoryOwner(lockPath);
    if (!existingOwner) {
      throw new IndexLockContentionError(lockPath, null, "unknown-owner");
    }

    const liveness = getOwnerLiveness(existingOwner);
    if (liveness !== "dead") {
      throw new IndexLockContentionError(lockPath, existingOwner, liveness === "alive" ? "active" : "unknown-owner");
    }

    if (!reclaimDeadOwner(canonicalIndexPath, lockPath, existingOwner)) {
      throw new IndexLockContentionError(lockPath, existingOwner, "reclaiming");
    }
  }

  throw new IndexLockContentionError(lockPath, null, "reclaiming");
}

export function releaseIndexLock(lease: IndexLockLease): boolean {
  const currentOwner = readDirectoryOwner(lease.lockPath);
  if (!currentOwner || !sameOwner(currentOwner, lease.owner)) return false;

  const releasePath = `${lease.lockPath}.release.${lease.owner.pid}.${lease.owner.token}`;
  try {
    retryTransientFilesystemOperation(() => renameSync(lease.lockPath, releasePath));
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }

  const claimedOwner = readDirectoryOwner(releasePath);
  if (!claimedOwner || !sameOwner(claimedOwner, lease.owner)) {
    if (!existsSync(lease.lockPath) && existsSync(releasePath)) {
      renameSync(releasePath, lease.lockPath);
    }
    return false;
  }

  try {
    retryTransientFilesystemOperation(() => rmSync(releasePath, { recursive: true, force: true }));
  } catch (error) {
    console.error(`[codebase-index] Lease released but tombstone cleanup failed: ${releasePath}`, error);
  }
  return true;
}

export function setIndexLockClearRecoveryState(
  lease: IndexLockLease,
  clearRecovery: IndexLockClearRecoveryState | null,
): void {
  const currentOwner = readDirectoryOwner(lease.lockPath);
  if (!currentOwner || !sameOwner(currentOwner, lease.owner)) {
    throw new Error(`Lost ownership of index mutation lease ${lease.owner.token}`);
  }

  const nextOwner: IndexLockOwner = { ...currentOwner };
  if (clearRecovery === null) {
    delete nextOwner.clearRecovery;
  } else {
    nextOwner.clearRecovery = clearRecovery;
  }

  const ownerPath = path.join(lease.lockPath, OWNER_FILE_NAME);
  const temporaryPath = path.join(
    lease.lockPath,
    `${OWNER_FILE_NAME}.tmp.${lease.owner.pid}.${lease.owner.token}.${randomUUID()}`,
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify(nextOwner), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    retryTransientFilesystemOperation(() => renameSync(temporaryPath, ownerPath));
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export async function withIndexLock<T>(
  indexPath: string,
  operation: IndexMutationOperation,
  callback: (lease: IndexLockLease) => Promise<T> | T,
  options: { completeRecoveries?: boolean; recoveryScope?: IndexLockRecoveryScope } = {},
): Promise<T> {
  const lease = acquireIndexLock(indexPath, operation, options.recoveryScope);
  let result: T | undefined;
  let callbackError: unknown;
  let callbackFailed = false;
  try {
    result = await callback(lease);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  if (!callbackFailed && options.completeRecoveries !== false) {
    try {
      completeLeaseRecovery(lease);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }
  }

  let releaseError: unknown;
  try {
    if (!releaseIndexLock(lease)) {
      releaseError = new Error(`Lost ownership of index mutation lease ${lease.owner.token}`);
    }
  } catch (error) {
    releaseError = error;
  }
  if (releaseError !== undefined) {
    if (callbackFailed) throw new AggregateError([callbackError, releaseError], "Index mutation and lease release both failed");
    throw releaseError;
  }
  if (callbackFailed) throw callbackError;
  return result as T;
}

export function createLeaseTemporaryPath(
  targetPath: string,
  owner: IndexLockOwner,
  kind: "tmp" | "bak" = "tmp",
): string {
  if (kind === "bak") return `${targetPath}.bak.${owner.pid}.${owner.token}`;
  temporaryCounter += 1;
  return `${targetPath}.tmp.${owner.pid}.${owner.token}.${temporaryCounter}`;
}

export function removeLeaseTemporaryPath(temporaryPath: string): void {
  if (existsSync(temporaryPath)) rmSync(temporaryPath, { recursive: true, force: true });
}

export function recoverLeaseArtifacts(
  indexPath: string,
  owner: IndexLockOwner,
  backupTargets: string[],
): void {
  for (const targetPath of backupTargets) {
    const backupPath = createLeaseTemporaryPath(targetPath, owner, "bak");
    if (!existsSync(backupPath)) continue;
    if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
    renameSync(backupPath, targetPath);
  }

  const temporaryOwnerMarker = `.tmp.${owner.pid}.${owner.token}.`;
  for (const entry of readdirSync(indexPath)) {
    if (!entry.includes(temporaryOwnerMarker)) continue;
    rmSync(path.join(indexPath, entry), { recursive: true, force: true });
  }
}

export function completeLeaseRecovery(lease: IndexLockLease): void {
  for (const recovery of lease.recoveries) {
    const markerOwner = readRecoveryOwner(recovery.markerPath);
    if (!markerOwner || !sameOwner(markerOwner, recovery.owner)) {
      throw new Error(`Recovery marker ownership changed: ${recovery.markerPath}`);
    }
  }
  for (const recovery of lease.recoveries) {
    rmSync(recovery.markerPath, { recursive: true, force: true });
  }
}
