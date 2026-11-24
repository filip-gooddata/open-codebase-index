import type { HostMode } from "../config/host.js";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
    /** Prefix of the lock's generation files, `<lock>.<n>`. */
    lock: path.join(stateDir, `${key}.lock`),
    again: path.join(stateDir, `${key}.again`),
  };
}

interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  released?: boolean;
  /** The holder process's start, as processIdentity reads it; set by `localOwners` locks. */
  process?: string;
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
    const { pid, hostname, startedAt, released, process: identity } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || typeof hostname !== "string" || typeof startedAt !== "string") return null;
    return { pid, hostname, startedAt, released: released === true, ...(typeof identity === "string" ? { process: identity } : {}) };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return getErrorCode(error) === "EPERM";
  }
}

/*
 * The refresh lock is a series of generation files `<lock>.<n>`; the highest one present is the
 * lock. Taking it means creating `<lock>.<highest + 1>` with link(2), which fails when that file
 * exists, so two processes that saw the same free generation cannot both win the next one. A
 * holder releases by marking its file released, never by deleting it, so a generation number is
 * not reused while it is the highest. Older generations are deleted after an acquisition; a
 * delayed process can then recreate one of them, so every acquisition ends by checking that its
 * generation is still the highest, and gives it up otherwise.
 */

function lockGenerationPath(lockPrefix: string, generation: number): string {
  return `${lockPrefix}.${generation}`;
}

function listLockGenerations(lockPrefix: string): number[] {
  const dir = path.dirname(lockPrefix);
  const prefix = `${path.basename(lockPrefix)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const generations: number[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (/^[1-9][0-9]*$/.test(suffix)) generations.push(Number(suffix));
  }
  return generations.sort((left, right) => left - right);
}

function highestLockGeneration(lockPrefix: string): number {
  const generations = listLockGenerations(lockPrefix);
  return generations.length === 0 ? 0 : generations[generations.length - 1];
}

type GenerationState =
  | { kind: "gone" }
  | { kind: "unknown" }
  | { kind: "owner"; owner: LockOwner | null };

function readGeneration(lockPrefix: string, generation: number): GenerationState {
  let content: string;
  try {
    content = fs.readFileSync(lockGenerationPath(lockPrefix, generation), "utf-8");
  } catch (error: unknown) {
    return getErrorCode(error) === "ENOENT" ? { kind: "gone" } : { kind: "unknown" };
  }
  return { kind: "owner", owner: parseLockOwner(content) };
}

function readGenerationOwner(lockPrefix: string, generation: number): LockOwner | null {
  const state = readGeneration(lockPrefix, generation);
  return state.kind === "owner" ? state.owner : null;
}

/**
 * Whether a generation is held: its owner has not released it and runs on this host, or was
 * written on another host, whose processes cannot be checked. A file that cannot be read (a
 * permission error, say) is held, since its owner may be live. Content that does not parse is
 * free: link(2) creates generations complete and rename(2) replaces them whole, so it is
 * corruption, not a writer mid-write. `gone` means the generation vanished since it was listed.
 */
function inspectGeneration(lockPrefix: string, generation: number, localOwners = false): "held" | "free" | "gone" {
  const state = readGeneration(lockPrefix, generation);
  if (state.kind === "gone") return "gone";
  if (state.kind === "unknown") return "held";
  const { owner } = state;
  if (!owner || owner.released) return "free";
  if (localOwners) return isProcessAlive(owner.pid) && !isReusedPid(owner) ? "held" : "free";
  return owner.hostname !== os.hostname() || isProcessAlive(owner.pid) ? "held" : "free";
}

/**
 * When the process `pid` started, in a form that stays the same for that process and differs for
 * a later one with the same pid, whatever the wall clock does: on Linux its start in clock ticks
 * since boot, elsewhere the start time the kernel stored at fork as `ps` prints it. Null when the
 * process is gone or its start cannot be read.
 */
function processIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Field 22, starttime; the fields after the command name start at field 3.
    if (fields[19]) return `ticks:${fields[19]}`;
  } catch {
    // No procfs (macOS), or the process is gone.
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf-8",
    // Fixed locale and zone: workers with different TZ or LANG must read the same identity.
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  const started = result.status === 0 ? result.stdout.trim() : "";
  return started ? `lstart:${started}` : null;
}

/** True when the owner's pid now runs another process than the one that took the lock. */
function isReusedPid(owner: LockOwner): boolean {
  if (owner.process === undefined) return false;
  const current = processIdentity(owner.pid);
  return current !== null && current !== owner.process;
}

const ACQUIRE_ATTEMPTS = 8;

/** The highest generation and whether it is held, rescanning when it vanishes while read. */
function inspectLock(lockPrefix: string, localOwners = false): { highest: number; held: boolean } {
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const highest = highestLockGeneration(lockPrefix);
    if (highest === 0) return { highest, held: false };
    const state = inspectGeneration(lockPrefix, highest, localOwners);
    if (state !== "gone") return { highest, held: state === "held" };
  }
  // The highest kept vanishing: other processes are taking the lock right now.
  return { highest: highestLockGeneration(lockPrefix), held: true };
}

/** True when the checkout's refresh lock has a live holder. */
export function isRefreshLockHeld(lockPrefix: string): boolean {
  return inspectLock(lockPrefix).held;
}

/** The live, readable holder of the checkout's refresh lock, or null. */
export function readRefreshLockOwner(lockPrefix: string): LockOwner | null {
  const { highest, held } = inspectLock(lockPrefix);
  return held ? readGenerationOwner(lockPrefix, highest) : null;
}

function writeOwnerFile(target: string, owner: LockOwner): string {
  const temp = `${target}.${owner.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  return temp;
}

function newOwner(pid: number, withIdentity: boolean): LockOwner {
  const owner: LockOwner = { pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  const identity = withIdentity ? processIdentity(pid) : null;
  return identity === null ? owner : { ...owner, process: identity };
}

/** Atomically creates `target` naming `pid` as its owner; false when it exists. */
function tryLinkOwnerFile(target: string, pid: number, withIdentity = false): boolean {
  const temp = writeOwnerFile(target, newOwner(pid, withIdentity));
  try {
    fs.linkSync(temp, target);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export interface AcquireRefreshLockOptions {
  /** Test seam: runs after the free generation was read and before the next one is created. */
  beforeLink?: (generation: number) => void;
  /**
   * The lock lives on this machine only: a holder is judged by its pid whatever hostname it
   * recorded (the hostname may have changed since), and it records its process's start, so a pid
   * a later process reused is gone. No wall-clock comparison is involved.
   */
  localOwners?: boolean;
}

/**
 * Takes the checkout's refresh lock for `pid`, recovering one whose holder is gone. Returns false
 * when a live holder has it.
 */
export function tryAcquireRefreshLock(lockPrefix: string, pid: number = process.pid, options: AcquireRefreshLockOptions = {}): boolean {
  fs.mkdirSync(path.dirname(lockPrefix), { recursive: true });
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const { highest, held } = inspectLock(lockPrefix, options.localOwners);
    if (held) return false;
    const next = highest + 1;
    options.beforeLink?.(next);
    if (!tryLinkOwnerFile(lockGenerationPath(lockPrefix, next), pid, options.localOwners)) continue;
    if (highestLockGeneration(lockPrefix) !== next) {
      // A generation above ours exists: we recreated one an earlier holder had already passed.
      fs.rmSync(lockGenerationPath(lockPrefix, next), { force: true });
      continue;
    }
    for (const generation of listLockGenerations(lockPrefix)) {
      if (generation < next) fs.rmSync(lockGenerationPath(lockPrefix, generation), { force: true });
    }
    return true;
  }
  return false;
}

/** Releases the lock when `pid` holds it, by marking its generation released. */
export function releaseRefreshLock(lockPrefix: string, pid: number = process.pid): void {
  const highest = highestLockGeneration(lockPrefix);
  if (highest === 0) return;
  const target = lockGenerationPath(lockPrefix, highest);
  const owner = readGenerationOwner(lockPrefix, highest);
  if (!owner || owner.pid !== pid || owner.released) return;
  fs.renameSync(writeOwnerFile(target, { ...owner, released: true }), target);
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

export interface CompatibilityVerdict {
  compatible: boolean;
  reason?: string;
}

/** A notification button: its label and the shell command it runs. */
export interface NotifyAction {
  label: string;
  command: string;
}

export interface RefreshWorkerDeps {
  env?: HookEnv;
  entryScript?: string;
  /** Runs one `ocbi index` pass for the checkout. */
  runPass?: (options: RefreshWorkerOptions, paths: CheckoutStatePaths) => Promise<RefreshPassResult> | RefreshPassResult;
  /** Counts the catalogs `ocbi prune` would remove; null when the count failed. */
  countPrunable?: (options: RefreshWorkerOptions) => number | null;
  /** The store's compatibility verdict, as `ocbi status` reports it; null when it has none. */
  checkCompatibility?: (options: RefreshWorkerOptions) => Promise<CompatibilityVerdict | null> | CompatibilityVerdict | null;
  /** Absolute path of an executable named `name` on PATH, or null. */
  findExecutable?: (name: string) => string | null;
  /** Runs the notifier as `command TITLE BODY [ACTION_LABEL ACTION_COMMAND]`. */
  notify?: (command: string, title: string, message: string, action?: NotifyAction) => void;
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

async function defaultCheckCompatibility(options: RefreshWorkerOptions): Promise<CompatibilityVerdict | null> {
  // `ocbi status` reads the verdict this way; the import keeps the native runtime out of the hook.
  const { getIndexerForProject, readIndexStatusSnapshot } = await import("../tools/operations.js");
  try {
    const { status } = await readIndexStatusSnapshot(options.checkoutRoot, options.host);
    const { compatibility } = status;
    return compatibility ? { compatible: compatibility.compatible, reason: compatibility.reason } : null;
  } finally {
    await getIndexerForProject(options.checkoutRoot, options.host).close();
  }
}

/** Looks `name` up on PATH as a shell in `cwd` would: relative and empty entries resolve against `cwd`. */
function defaultFindExecutable(env: HookEnv, cwd: string) {
  return (name: string): string | null => {
    for (const dir of (env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.resolve(cwd, dir, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        // Not here; keep looking.
      }
    }
    return null;
  };
}

function defaultNotify(env: HookEnv) {
  return (command: string, title: string, message: string, action?: NotifyAction): void => {
    const args = action ? [title, message, action.label, action.command] : [title, message];
    const result = spawnSync(command, args, { env: env as NodeJS.ProcessEnv, stdio: "ignore", timeout: 30_000 });
    if (result.error) throw result.error;
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function repositoryName(commonDir: string): string {
  const base = path.basename(commonDir);
  return base === ".git" ? path.basename(path.dirname(commonDir)) : base;
}

type DailyCheckDeps = Required<Pick<RefreshWorkerDeps, "countPrunable" | "checkCompatibility" | "findExecutable" | "notify" | "now">>;

function runNotifier(options: RefreshWorkerOptions, paths: CheckoutStatePaths, deps: DailyCheckDeps, title: string, message: string, action?: NotifyAction): void {
  if (!options.staleNotify) return;
  try {
    deps.notify(options.staleNotify, title, message, action);
  } catch (error: unknown) {
    appendHookLog(paths.log, `== daily check: notifier failed: ${getErrorMessage(error)}`);
  }
}

/** The MCP-oriented advice at the end of a verdict's reason does not apply to a notification. */
function compatibilityReason(verdict: CompatibilityVerdict): string {
  const reason = (verdict.reason ?? "the store no longer matches the configured embedding provider or model").replace(/\s+/g, " ").trim();
  return reason.replace(/\s*Run index_codebase with force=true\b.*$/, "").replace(/\.$/, "");
}

/**
 * Notifies when the store's embeddings no longer match the configured provider or model, the one
 * case that needs a full rebuild. Returns the verdict, or null when there is none to report.
 */
async function runCompatibilityCheck(
  options: RefreshWorkerOptions,
  paths: CheckoutStatePaths,
  entryScript: string,
  deps: DailyCheckDeps,
): Promise<CompatibilityVerdict | null> {
  let verdict: CompatibilityVerdict | null;
  try {
    verdict = await deps.checkCompatibility(options);
  } catch (error: unknown) {
    appendHookLog(paths.log, `== compatibility check: could not read the store's status: ${getErrorMessage(error)}`);
    return null;
  }
  if (verdict === null) {
    appendHookLog(paths.log, "== compatibility check: unknown (the store reports no verdict)");
    return null;
  }
  if (verdict.compatible) {
    appendHookLog(paths.log, "== compatibility check: compatible");
    return verdict;
  }
  const reason = compatibilityReason(verdict);
  const rebuild = deps.findExecutable("ocbi-rebuild");
  const command = rebuild
    ? [rebuild, options.checkoutRoot].map(shellQuote).join(" ")
    : [process.execPath, entryScript, "index", "--force", "--host", options.host, "--project", options.checkoutRoot].map(shellQuote).join(" ");
  appendHookLog(paths.log, `== compatibility check: incompatible: ${reason}; rebuild with: ${command}`);
  const message = `${reason}. A full rebuild re-embeds every file with the configured model.`;
  runNotifier(options, paths, deps, `Rebuild needed: ${repositoryName(options.commonDir)}`,
    rebuild ? message : `${message} Rebuild with: ${command}`,
    rebuild ? { label: "Rebuild", command } : undefined);
  return verdict;
}

/** Counts the catalogs `ocbi prune` would remove and notifies from OCBI_STALE_THRESHOLD (15) on. */
function runStaleCheck(
  options: RefreshWorkerOptions,
  paths: CheckoutStatePaths,
  env: HookEnv,
  entryScript: string,
  deps: DailyCheckDeps,
): number | null {
  const count = deps.countPrunable(options);
  if (count === null) {
    appendHookLog(paths.log, "== stale check: could not count prunable catalogs");
    return null;
  }
  const parsedThreshold = Number.parseInt(env.OCBI_STALE_THRESHOLD ?? "", 10);
  const threshold = Number.isInteger(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : DEFAULT_STALE_THRESHOLD;
  // The worker's own node and script: the CLI may not be on PATH (a private install, say).
  const command = [process.execPath, entryScript, "prune", "--apply", "--host", options.host, "--project", options.checkoutRoot].map(shellQuote).join(" ");
  appendHookLog(paths.log, `== stale check: ${count} catalogs of deleted branches or worktrees${count > 0 ? `; remove them with: ${command}` : ""}`);
  if (count >= threshold) {
    runNotifier(options, paths, deps, `Worth a cleanup: ${repositoryName(options.commonDir)}`,
      `${count} catalogs of deleted branches or worktrees.`, { label: "Prune", command });
  }
  return count;
}

/** The verdict a fresh compatibility stamp records, so a later checkout that day honors it. */
function readStampVerdict(stamp: string): string | null {
  try {
    return fs.readFileSync(stamp, "utf-8").trim().split(" ")[1] ?? null;
  } catch {
    return null;
  }
}

function isDue(stamp: string, now: number): boolean {
  try {
    return now - fs.statSync(stamp).mtimeMs >= STALE_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

/**
 * At most once a day per repository and check: checks that the store still matches the configured
 * embedding provider and model (OCBI_COMPAT_CHECK=0 skips it) and counts the catalogs of deleted
 * branches and worktrees (OCBI_STALE_CHECK=0 skips it). It only logs and notifies; a rebuild or a
 * prune waits for the user. A store that needs a rebuild is not counted, since the rebuild drops
 * every catalog. Each check keeps its own day; one that could not run is retried after the next
 * checkout.
 */
async function runDailyCheck(
  options: RefreshWorkerOptions,
  paths: CheckoutStatePaths,
  env: HookEnv,
  entryScript: string,
  pid: number,
  deps: DailyCheckDeps,
): Promise<void> {
  const compatStamp = path.join(paths.stateDir, "compat-check.stamp");
  const staleStamp = path.join(paths.stateDir, "stale-check.stamp");
  const compatDue = env.OCBI_COMPAT_CHECK !== "0" && isDue(compatStamp, deps.now());
  const staleDue = env.OCBI_STALE_CHECK !== "0" && isDue(staleStamp, deps.now());
  if (!compatDue && !staleDue) return;
  // One worker per repository: the generation lock hands a dead holder's claim to exactly one taker.
  // A shared git dir on another machine's worker is judged as local: at worst it notifies twice.
  const claim = path.join(paths.stateDir, "daily-check.lock");
  if (!tryAcquireRefreshLock(claim, pid, { localOwners: true })) return;
  try {
    // Another worker may have finished a check between the look above and the claim.
    let incompatible = false;
    if (compatDue && isDue(compatStamp, deps.now())) {
      const verdict = await runCompatibilityCheck(options, paths, entryScript, deps);
      if (verdict !== null) {
        fs.writeFileSync(compatStamp, `${new Date(deps.now()).toISOString()} ${verdict.compatible ? "compatible" : "incompatible"}\n`);
      }
      incompatible = verdict?.compatible === false;
    } else if (env.OCBI_COMPAT_CHECK !== "0") {
      incompatible = readStampVerdict(compatStamp) === "incompatible";
    }
    if (staleDue && !incompatible && isDue(staleStamp, deps.now())) {
      const count = runStaleCheck(options, paths, env, entryScript, deps);
      if (count !== null) fs.writeFileSync(staleStamp, `${new Date(deps.now()).toISOString()} ${count}\n`);
    }
  } finally {
    releaseRefreshLock(claim, pid);
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
  let lastPassBusy = false;
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
      lastPassBusy = result.busy;
      appendHookLog(paths.log, result.busy
        ? `== busy: another index operation holds the store; skipped ${timestamp()}`
        : `== exit ${result.exitCode ?? "signal"} ${timestamp()}`);
      if (fs.existsSync(paths.again)) continue;
    }
    releaseRefreshLock(paths.lock, pid);
    if (fs.existsSync(paths.again) && tryAcquireRefreshLock(paths.lock, pid)) continue;
    break;
  }

  // A busy store may be mid-rebuild, whose intermediate state is no reason to notify.
  if (passes > 0 && !lastPassBusy) {
    await runDailyCheck(options, paths, env, entryScript, pid, {
      countPrunable: deps.countPrunable ?? defaultCountPrunable(entryScript, env),
      checkCompatibility: deps.checkCompatibility ?? defaultCheckCompatibility,
      findExecutable: deps.findExecutable ?? defaultFindExecutable(env, options.checkoutRoot),
      notify: deps.notify ?? defaultNotify(env),
      now: deps.now ?? Date.now,
    });
  }
  return passes;
}
