import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { HostMode } from "../config/host.js";
import { loadMergedConfig } from "../config/merger.js";
import { REPOSITORY_CONFIG_DIRNAME, resolveMatchedRepositoryRoute } from "../config/repository-route.js";
import { parseConfig } from "../config/schema.js";
import { resolveDefaultProjectRoot } from "./index.js";

/** The variables git's `local_repo_env` lists: each pins a git command to one repository view. */
export const GIT_LOCAL_REPOSITORY_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

const STALE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_THRESHOLD = 15;
const LOG_ROTATE_BYTES = 1024 * 1024;
/** A lock file that cannot be parsed for this long is corrupt, not a writer mid-write. */
const UNREADABLE_LOCK_STALE_MS = 60 * 1000;

export type HookEnv = Record<string, string | undefined>;

/**
 * Copies `env` without the variables git exports to hooks that pin a repository view. A refresh
 * started from a hook must describe the checkout it indexes, not the view git ran the hook with.
 */
export function scrubGitRepositoryEnv(env: HookEnv): HookEnv {
  const scrubbed: HookEnv = { ...env };
  for (const name of GIT_LOCAL_REPOSITORY_ENV_VARS) delete scrubbed[name];
  for (const name of Object.keys(scrubbed)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete scrubbed[name];
  }
  return scrubbed;
}

export type PostCheckoutSkipReason =
  | "file checkout"
  | "disabled by OCBI_PREWARM=0"
  | "rebase"
  | "unsupported platform";

/** Applies the hook's skip rules to `ocbi hook post-checkout <prev> <new> <flag>`. */
export function getPostCheckoutSkipReason(
  args: readonly string[],
  env: HookEnv,
  platform: NodeJS.Platform = process.platform,
): PostCheckoutSkipReason | null {
  if (platform === "win32") return "unsupported platform";
  if (args[2] !== "1") return "file checkout";
  if (env.OCBI_PREWARM === "0") return "disabled by OCBI_PREWARM=0";
  if ((env.GIT_REFLOG_ACTION ?? "").startsWith("rebase")) return "rebase";
  return null;
}

/** Per-repository hook state: `<common dir>/codebase-index/logs/post-checkout`. */
export function getPostCheckoutStateDir(commonDir: string): string {
  return path.join(commonDir, REPOSITORY_CONFIG_DIRNAME, "logs", "post-checkout");
}

/** `<checkout dir name>-<hash of its realpath>`, so equal directory names never share a lock. */
export function getCheckoutStateKey(checkoutRoot: string): string {
  const digest = createHash("sha256").update(checkoutRoot).digest("hex").slice(0, 12);
  const name = path.basename(checkoutRoot).replace(/[^A-Za-z0-9._-]/g, "_") || "checkout";
  return `${name}-${digest}`;
}

export interface CheckoutStatePaths {
  stateDir: string;
  key: string;
  log: string;
  lock: string;
  again: string;
}

export function getCheckoutStatePaths(commonDir: string, checkoutRoot: string): CheckoutStatePaths {
  const stateDir = getPostCheckoutStateDir(commonDir);
  const key = getCheckoutStateKey(checkoutRoot);
  return {
    stateDir,
    key,
    log: path.join(stateDir, `${key}.log`),
    lock: path.join(stateDir, `${key}.lock`),
    again: path.join(stateDir, `${key}.again`),
  };
}

interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: string;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLockOwner(content: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, hostname, startedAt } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || typeof hostname !== "string" || typeof startedAt !== "string") return null;
    return { pid, hostname, startedAt };
  } catch {
    return null;
  }
}

function readLockContent(lockPath: string): string | null {
  try {
    return fs.readFileSync(lockPath, "utf-8");
  } catch {
    return null;
  }
}

function readLockOwner(lockPath: string): LockOwner | null {
  const content = readLockContent(lockPath);
  return content === null ? null : parseLockOwner(content);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return getErrorCode(error) === "EPERM";
  }
}

function lockFileAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether lock content names a live owner: one running on this host, or one written on another
 * host, whose liveness cannot be checked. Content that does not parse is a live writer only while
 * the file is young; acquisition links a complete file, so it is corrupt after that.
 */
function isLockContentLive(content: string, lockPath: string): boolean {
  const owner = parseLockOwner(content);
  if (owner) return owner.hostname !== os.hostname() || isProcessAlive(owner.pid);
  const age = lockFileAgeMs(lockPath);
  return age !== null && age < UNREADABLE_LOCK_STALE_MS;
}

/** True when the lock exists and its owner is live. */
export function isRefreshLockHeld(lockPath: string): boolean {
  const content = readLockContent(lockPath);
  return content !== null && isLockContentLive(content, lockPath);
}

function writeOwnerFile(target: string, pid: number): string {
  const temp = `${target}.${pid}.${randomBytes(4).toString("hex")}.tmp`;
  const owner: LockOwner = { pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  fs.writeFileSync(temp, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  return temp;
}

function tryLinkLock(lockPath: string, pid: number): boolean {
  const temp = writeOwnerFile(lockPath, pid);
  try {
    fs.linkSync(temp, lockPath);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Removes the lock whose dead content was read as `staleContent`. The lock is moved aside first
 * and its content compared, so a lock another process took in the meantime is put back instead of
 * removed. If a third process linked a new lock before it could go back, that owner keeps the new
 * lock and the moved one's owner loses its file: at worst two refreshes run, and the store's own
 * index lock serializes them.
 */
function removeStaleLock(lockPath: string, staleContent: string): void {
  const moved = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
  try {
    fs.renameSync(lockPath, moved);
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return;
    throw error;
  }
  try {
    if (readLockContent(moved) === staleContent) return;
    try {
      fs.linkSync(moved, lockPath);
    } catch (error: unknown) {
      if (getErrorCode(error) !== "EEXIST") throw error;
    }
  } finally {
    fs.rmSync(moved, { force: true });
  }
}

/** Takes the checkout's refresh lock for `pid`; recovers a lock whose owner is gone. */
export function tryAcquireRefreshLock(lockPath: string, pid: number = process.pid): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (tryLinkLock(lockPath, pid)) return true;
  const content = readLockContent(lockPath);
  if (content !== null) {
    if (isLockContentLive(content, lockPath)) return false;
    removeStaleLock(lockPath, content);
  }
  return tryLinkLock(lockPath, pid);
}

/** Releases the lock when `pid` still owns it. */
export function releaseRefreshLock(lockPath: string, pid: number = process.pid): void {
  if (readLockOwner(lockPath)?.pid === pid) fs.rmSync(lockPath, { force: true });
}

/** Takes a queued refresh request; false when none is queued. */
function consumeRefreshRequest(againPath: string): boolean {
  try {
    fs.unlinkSync(againPath);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export interface PostCheckoutTarget {
  checkoutRoot: string;
  commonDir: string;
  paths: CheckoutStatePaths;
}

export type PostCheckoutResolution =
  | { kind: "target"; target: PostCheckoutTarget }
  | { kind: "skip"; reason: string; paths?: CheckoutStatePaths };

/**
 * Resolves the checkout a hook runs for through the repository route. Only a checkout whose
 * project-scope store is the repository's shared store gets a refresh, so the hook never builds a
 * checkout-local or global index. Routing reads git's files and ignores the hook's GIT_* variables.
 */
export function resolvePostCheckoutTarget(cwd: string, host: HostMode): PostCheckoutResolution {
  const checkoutRoot = resolveDefaultProjectRoot(cwd);
  const route = resolveMatchedRepositoryRoute(checkoutRoot, host);
  if (!route?.layout) return { kind: "skip", reason: "no repository config" };
  const paths = getCheckoutStatePaths(route.layout.commonDir, route.checkoutRoot);
  let scope: string;
  try {
    scope = parseConfig(loadMergedConfig(route.checkoutRoot, host)).scope;
  } catch (error: unknown) {
    return { kind: "skip", reason: `config error: ${getErrorMessage(error)}`, paths };
  }
  if (scope !== "project") {
    return { kind: "skip", reason: `scope ${scope} does not use the repository store`, paths };
  }
  return { kind: "target", target: { checkoutRoot: route.checkoutRoot, commonDir: route.layout.commonDir, paths } };
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function appendHookLog(logPath: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    // The log is diagnostic only; a hook must never fail the checkout over it.
  }
}

function rotateLog(logPath: string): void {
  try {
    if (fs.statSync(logPath).size > LOG_ROTATE_BYTES) fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Missing log: nothing to rotate.
  }
}

export interface RefreshWorkerOptions {
  checkoutRoot: string;
  commonDir: string;
  host: HostMode;
  staleNotify?: string;
}

export interface PostCheckoutHookDeps {
  env?: HookEnv;
  platform?: NodeJS.Platform;
  /** Starts the detached worker and returns its pid. */
  spawnWorker?: (options: RefreshWorkerOptions, paths: CheckoutStatePaths) => number;
  /** Absolute path of the `ocbi` entry script the worker and its passes run. */
  entryScript?: string;
  stderr?: (text: string) => void;
}

export type PostCheckoutOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "queued"; paths: CheckoutStatePaths }
  | { kind: "started"; pid: number; paths: CheckoutStatePaths };

export function workerArgs(options: RefreshWorkerOptions): string[] {
  const args = [
    "hook", "refresh-worker",
    "--project", options.checkoutRoot,
    "--common-dir", options.commonDir,
    "--host", options.host,
  ];
  if (options.staleNotify) args.push("--stale-notify", options.staleNotify);
  return args;
}

function defaultSpawnWorker(entryScript: string, env: HookEnv) {
  return (options: RefreshWorkerOptions, paths: CheckoutStatePaths): number => {
    const logFd = fs.openSync(paths.log, "a");
    try {
      const child = spawn(process.execPath, [entryScript, ...workerArgs(options)], {
        cwd: options.checkoutRoot,
        detached: true,
        env: scrubGitRepositoryEnv(env),
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();
      if (child.pid === undefined) throw new Error("the refresh worker did not start");
      return child.pid;
    } finally {
      fs.closeSync(logFd);
    }
  };
}

/**
 * `ocbi hook post-checkout <prev> <new> <flag>`: queues a refresh of this checkout and starts a
 * detached worker unless one runs. The request is written before the lock is checked, so a worker
 * that is finishing either sees it or has released the lock for the new worker to take.
 */
export function runPostCheckoutHook(
  args: readonly string[],
  cwd: string,
  host: HostMode,
  options: { staleNotify?: string } = {},
  deps: PostCheckoutHookDeps = {},
): PostCheckoutOutcome {
  const env = deps.env ?? process.env;
  const skip = getPostCheckoutSkipReason(args, env, deps.platform);
  if (skip === "unsupported platform") {
    deps.stderr?.("ocbi hook post-checkout: Windows is not supported; skipping the index refresh.");
  }
  if (skip) return { kind: "skipped", reason: skip };

  const resolution = resolvePostCheckoutTarget(cwd, host);
  if (resolution.kind === "skip") {
    if (resolution.paths) appendHookLog(resolution.paths.log, `== ${timestamp()} skipped: ${resolution.reason}`);
    return { kind: "skipped", reason: resolution.reason };
  }

  const { target } = resolution;
  const { paths } = target;
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.again, "");
  if (isRefreshLockHeld(paths.lock)) return { kind: "queued", paths };

  try {
    rotateLog(paths.log);
    const entryScript = deps.entryScript ?? process.argv[1];
    const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker(entryScript, env);
    const pid = spawnWorker({ checkoutRoot: target.checkoutRoot, commonDir: target.commonDir, host, staleNotify: options.staleNotify }, paths);
    return { kind: "started", pid, paths };
  } catch (error: unknown) {
    appendHookLog(paths.log, `== ${timestamp()} failed to start a refresh: ${getErrorMessage(error)}`);
    return { kind: "skipped", reason: `worker failed to start: ${getErrorMessage(error)}` };
  }
}

export interface RefreshPassResult {
  exitCode: number | null;
  busy: boolean;
}

export interface RefreshWorkerDeps {
  env?: HookEnv;
  entryScript?: string;
  /** Runs one `ocbi index` pass for the checkout. */
  runPass?: (options: RefreshWorkerOptions, paths: CheckoutStatePaths) => Promise<RefreshPassResult> | RefreshPassResult;
  /** Counts the catalogs `ocbi prune` would remove; null when the count failed. */
  countPrunable?: (options: RefreshWorkerOptions) => number | null;
  notify?: (command: string, title: string, message: string) => void;
  now?: () => number;
  pid?: number;
}

function describeHead(checkoutRoot: string, env: HookEnv): string {
  const run = (gitArgs: string[]): string => {
    const result = spawnSync("git", gitArgs, { cwd: checkoutRoot, env: env as NodeJS.ProcessEnv, encoding: "utf-8" });
    return result.status === 0 ? result.stdout.trim() : "?";
  };
  return `${run(["rev-parse", "--abbrev-ref", "HEAD"])} ${run(["rev-parse", "--short", "HEAD"])}`;
}

function defaultRunPass(entryScript: string, env: HookEnv) {
  return (options: RefreshWorkerOptions, paths: CheckoutStatePaths): RefreshPassResult => {
    const offset = fs.existsSync(paths.log) ? fs.statSync(paths.log).size : 0;
    const logFd = fs.openSync(paths.log, "a");
    let status: number | null;
    try {
      status = spawnSync(process.execPath, [entryScript, "index", "--project", options.checkoutRoot, "--host", options.host], {
        cwd: options.checkoutRoot,
        env: env as NodeJS.ProcessEnv,
        stdio: ["ignore", logFd, logFd],
      }).status;
    } finally {
      fs.closeSync(logFd);
    }
    return { exitCode: status, busy: status !== 0 && /^INDEX_BUSY:/m.test(readFrom(paths.log, offset)) };
  };
}

function readFrom(filePath: string, offset: number): string {
  try {
    const buffer = fs.readFileSync(filePath);
    return buffer.subarray(Math.min(offset, buffer.length)).toString("utf-8");
  } catch {
    return "";
  }
}

function defaultCountPrunable(entryScript: string, env: HookEnv) {
  return (options: RefreshWorkerOptions): number | null => {
    const result = spawnSync(process.execPath, [entryScript, "prune", "--json", "--project", options.checkoutRoot, "--host", options.host], {
      cwd: options.checkoutRoot,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return null;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      const catalogs = typeof parsed === "object" && parsed !== null ? (parsed as { catalogs?: unknown }).catalogs : undefined;
      return Array.isArray(catalogs) ? catalogs.length : null;
    } catch {
      return null;
    }
  };
}

function defaultNotify(env: HookEnv) {
  return (command: string, title: string, message: string): void => {
    spawnSync(command, [title, message], { env: env as NodeJS.ProcessEnv, stdio: "ignore", timeout: 30_000 });
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function repositoryName(commonDir: string): string {
  const base = path.basename(commonDir);
  return base === ".git" ? path.basename(path.dirname(commonDir)) : base;
}

/**
 * At most once a day per repository, counts the catalogs `ocbi prune` would remove, logs the
 * count and, from OCBI_STALE_THRESHOLD (15) on, runs the configured notifier.
 */
function runStaleCheck(options: RefreshWorkerOptions, paths: CheckoutStatePaths, env: HookEnv, deps: Required<Pick<RefreshWorkerDeps, "countPrunable" | "notify" | "now">>): void {
  if (env.OCBI_STALE_CHECK === "0") return;
  const stamp = path.join(paths.stateDir, "stale-check.stamp");
  try {
    if (deps.now() - fs.statSync(stamp).mtimeMs < STALE_CHECK_INTERVAL_MS) return;
  } catch {
    // No stamp yet.
  }
  const count = deps.countPrunable(options);
  if (count === null) {
    appendHookLog(paths.log, "== stale check: could not count prunable catalogs");
    return;
  }
  fs.writeFileSync(stamp, `${new Date(deps.now()).toISOString()} ${count}\n`);
  const parsedThreshold = Number.parseInt(env.OCBI_STALE_THRESHOLD ?? "", 10);
  const threshold = Number.isInteger(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : DEFAULT_STALE_THRESHOLD;
  const command = ["ocbi", "prune", "--apply", "--host", options.host, "--project", options.checkoutRoot].map(shellQuote).join(" ");
  appendHookLog(paths.log, `== stale check: ${count} catalogs of deleted branches or worktrees${count > 0 ? `; remove them with: ${command}` : ""}`);
  if (count < threshold || !options.staleNotify) return;
  try {
    deps.notify(options.staleNotify, `Worth a cleanup: ${repositoryName(options.commonDir)}`, `${count} catalogs of deleted branches or worktrees. Run: ${command}`);
  } catch (error: unknown) {
    appendHookLog(paths.log, `== stale check: notifier failed: ${getErrorMessage(error)}`);
  }
}

/**
 * The detached worker: takes the checkout's lock, or exits when another worker holds it (that one
 * sees the queued request). Each pass consumes the queued request first, so a request a pass
 * already covered does not cause another. After releasing the lock it looks once more, so a
 * request queued just before the release is not lost.
 */
export async function runRefreshWorker(options: RefreshWorkerOptions, deps: RefreshWorkerDeps = {}): Promise<number> {
  const env = scrubGitRepositoryEnv(deps.env ?? process.env);
  const pid = deps.pid ?? process.pid;
  const entryScript = deps.entryScript ?? process.argv[1];
  const paths = getCheckoutStatePaths(options.commonDir, options.checkoutRoot);
  const runPass = deps.runPass ?? defaultRunPass(entryScript, env);
  if (!tryAcquireRefreshLock(paths.lock, pid)) return 0;
  try {
    os.setPriority(10);
  } catch {
    // Lowering priority is best effort.
  }

  let passes = 0;
  for (;;) {
    if (consumeRefreshRequest(paths.again)) {
      appendHookLog(paths.log, `== ${timestamp()} ${options.checkoutRoot} ${describeHead(options.checkoutRoot, env)}`);
      let result: RefreshPassResult;
      try {
        result = await runPass(options, paths);
      } catch (error: unknown) {
        result = { exitCode: null, busy: false };
        appendHookLog(paths.log, `== pass failed: ${getErrorMessage(error)}`);
      }
      passes += 1;
      appendHookLog(paths.log, result.busy
        ? `== busy: another index operation holds the store; skipped ${timestamp()}`
        : `== exit ${result.exitCode ?? "signal"} ${timestamp()}`);
      if (fs.existsSync(paths.again)) continue;
    }
    releaseRefreshLock(paths.lock, pid);
    if (fs.existsSync(paths.again) && tryAcquireRefreshLock(paths.lock, pid)) continue;
    break;
  }

  if (passes > 0) {
    runStaleCheck(options, paths, env, {
      countPrunable: deps.countPrunable ?? defaultCountPrunable(entryScript, env),
      notify: deps.notify ?? defaultNotify(env),
      now: deps.now ?? Date.now,
    });
  }
  return passes;
}
