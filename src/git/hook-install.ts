import type { HostMode } from "../config/host.js";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { getRepositoryConfigPath } from "../config/repository-route.js";
import { getPostCheckoutStateDir, scrubGitRepositoryEnv } from "./post-checkout-hook.js";

/** Friendly name of the config-based hook: `hook.ocbi-post-checkout.{command,event}`. */
export const HOOK_CONFIG_NAME = "ocbi-post-checkout";
/** First line after the shebang of a managed `post-checkout` script. */
export const MANAGED_HOOK_MARKER = "# open-codebase-index managed post-checkout hook";
/** Where a managed script moves an existing `post-checkout` hook it chains to. */
export const CHAINED_HOOK_NAME = "post-checkout.ocbi-chained";
/** Command fragment of the shell hook that the native hook replaces. */
const LEGACY_HOOK_SCRIPT = "ocbi-post-checkout.sh";

export type HookInstallMethod = "config" | "file";

export interface HookCommandSpec {
  nodePath: string;
  entryScript: string;
  host: HostMode;
  staleNotify?: string;
}

export interface HookRepository {
  repo: string;
  commonDir: string;
  bare: boolean;
  /**
   * Top level of the working tree `repo` is in, or null when it is in none: a bare repository, or a
   * non-bare common dir whose checkouts are all linked worktrees.
   */
  workTree: string | null;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: scrubGitRepositoryEnv(process.env) as NodeJS.ProcessEnv,
  });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

/** git ends its output with one newline; a path may itself end in spaces, so strip nothing else. */
function stripNewline(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function realpathOrResolve(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Resolves a checkout, linked worktree, bare repository, or a git dir with no working tree of its
 * own (core.bare=false, every checkout a linked worktree) to its git common dir.
 */
export function resolveHookRepository(repo: string): HookRepository {
  const absolute = path.resolve(repo);
  if (!fs.existsSync(absolute)) throw new Error(`Repository path does not exist: ${absolute}`);
  const commonDir = stripNewline(gitOk(absolute, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const bare = gitOk(absolute, ["rev-parse", "--is-bare-repository"]).trim() === "true";
  const inWorkTree = !bare && gitOk(absolute, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  const workTree = inWorkTree ? realpathOrResolve(stripNewline(gitOk(absolute, ["rev-parse", "--show-toplevel"]))) : null;
  return { repo: absolute, commonDir: realpathOrResolve(commonDir), bare, workTree };
}

/** Config-based hooks (`hook.<name>.event`) come with `git hook list`; older git lacks both. */
export function gitSupportsConfigHooks(): boolean {
  const result = spawnSync("git", ["hook", "-h"], { encoding: "utf-8", env: scrubGitRepositoryEnv(process.env) as NodeJS.ProcessEnv });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.includes("git hook list");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Shell function both install methods define; it gets git's hook arguments. */
export const HOOK_FUNCTION_NAME = "ocbi_post_checkout";

/**
 * The shell function that runs the hook. It fails open: a missing node binary or script (a removed
 * node version, a moved install) makes it do nothing instead of failing the checkout, and
 * `ocbi hooks status` reports the command as stale.
 */
export function buildHookFunction(spec: HookCommandSpec): string {
  const node = shellQuote(spec.nodePath);
  const entry = shellQuote(spec.entryScript);
  const words = [node, entry, "hook", "post-checkout", "--host", spec.host];
  if (spec.staleNotify) words.push("--stale-notify", shellQuote(spec.staleNotify));
  return `${HOOK_FUNCTION_NAME}() { [ -x ${node} ] && [ -f ${entry} ] || return 0; ${words.join(" ")} "$@" || :; }`;
}

/** The `hook.<name>.command` value: git appends the hook arguments, which reach the function. */
export function buildHookCommand(spec: HookCommandSpec): string {
  return `${buildHookFunction(spec)}; ${HOOK_FUNCTION_NAME}`;
}

/** The words of the `ocbi` invocation inside a command or script ocbi wrote, else null. */
export function parseHookInvocation(text: string): string[] | null {
  const match = /\|\| return 0; (.+) "\$@" \|\| :; \}/.exec(text);
  if (!match) return null;
  try {
    return splitHookCommand(match[1]);
  } catch {
    return null;
  }
}

/** Splits a command written by `buildHookCommand` (single-quoted words) back into words. */
export function splitHookCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) throw new Error("unterminated quote");
      current += command.slice(index + 1, end);
      index = end;
      inWord = true;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index += 1;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/**
 * The node binary the hook command names: the running binary's real path. Shell-session links
 * (version-manager shims, per-shell directories) can vanish; a real path stays until that node
 * version is removed, and status reports the command as stale then. `--node` overrides it.
 */
export function resolveHookNodePath(execPath: string = process.execPath): string {
  return realpathOrResolve(execPath);
}

export function managedHookScript(spec: HookCommandSpec): string {
  return `#!/bin/sh
${MANAGED_HOOK_MARKER} (ocbi hooks install).
# Remove it with: ocbi hooks uninstall. A hook that was here before runs first, from
# ${CHAINED_HOOK_NAME}, and its exit status is kept.
status=0
chained="$(dirname "$0")/${CHAINED_HOOK_NAME}"
if [ -x "$chained" ]; then
  "$chained" "$@"
  status=$?
fi
${buildHookFunction(spec)}
${HOOK_FUNCTION_NAME} "$@"
exit $status
`;
}

export interface HookFileLocation {
  dir: string;
  file: string;
  /** `core.hooksPath` when set. */
  hooksPath: string | null;
  error: string | null;
  warnings: string[];
}

/** True for a directory entry, including a symbolic link whose target is missing. */
function entryExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The `post-checkout` file git runs for the repository: `git rev-parse --git-path hooks`, which
 * honours `core.hooksPath`. A hooks path outside the repository's git dir and working tree may be
 * shared by other repositories, so installing or removing a file there is refused.
 */
export function resolveHookFileLocation(repository: HookRepository): HookFileLocation {
  const configured = git(repository.repo, ["config", "--get", "core.hooksPath"]);
  const hooksPath = configured.status === 0 ? stripNewline(configured.stdout) || null : null;
  const dir = realpathOrResolve(stripNewline(gitOk(repository.repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])));
  const location: HookFileLocation = { dir, file: path.join(dir, "post-checkout"), hooksPath, error: null, warnings: [] };
  if (hooksPath === null) return location;

  const topLevel = repository.workTree;
  if (isInside(dir, repository.commonDir)) return location;
  if (!(topLevel !== null && isInside(dir, topLevel))) {
    location.error = `core.hooksPath is ${hooksPath} (${dir}), outside this repository, so other repositories may share it. Use a git with config-based hooks, or call \`ocbi hook post-checkout "$@"\` from that hook yourself.`;
    return location;
  }
  location.warnings.push(`core.hooksPath ${hooksPath} is inside the working tree ${topLevel}: other worktrees use their own copy of it, and the managed hook shows up there as a working-tree change.`);
  return location;
}

interface ConfigHookEntry {
  command: string | null;
  events: string[];
  enabled: string | null;
}

function readConfigHook(repository: HookRepository): ConfigHookEntry {
  const read = (key: string, all = false): string[] => {
    const result = git(repository.repo, ["config", "--local", all ? "--get-all" : "--get", `hook.${HOOK_CONFIG_NAME}.${key}`]);
    return result.status === 0 ? result.stdout.split("\n").filter((line) => line.length > 0) : [];
  };
  return { command: read("command")[0] ?? null, events: read("event", true), enabled: read("enabled")[0] ?? null };
}

function isForeignCommand(command: string | null): boolean {
  return command !== null && parseHookInvocation(command) === null;
}

function removeConfigHook(repository: HookRepository): boolean {
  const entry = readConfigHook(repository);
  if (entry.command === null && entry.events.length === 0 && entry.enabled === null) return false;
  if (isForeignCommand(entry.command)) {
    throw new Error(`hook.${HOOK_CONFIG_NAME}.command is set to a command ocbi did not write (${entry.command}); remove or rename that hook first.`);
  }
  gitOk(repository.repo, ["config", "--local", "--remove-section", `hook.${HOOK_CONFIG_NAME}`]);
  return true;
}

function isManagedHookFile(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf-8").split("\n", 3).some((line) => line.startsWith(MANAGED_HOOK_MARKER));
  } catch {
    return false;
  }
}

/** Removes a managed hook file and moves a chained hook back in its place. */
function removeManagedHookFile(location: HookFileLocation): string[] {
  if (location.error || !isManagedHookFile(location.file)) return [];
  const actions = [`removed managed hook ${location.file}`];
  const chained = path.join(location.dir, CHAINED_HOOK_NAME);
  fs.rmSync(location.file, { force: true });
  if (entryExists(chained)) {
    fs.renameSync(chained, location.file);
    actions.push(`restored the earlier hook from ${chained}`);
  }
  return actions;
}

export interface LegacyHookEntry {
  name: string;
  command: string;
}

/** Config-based hooks that still run the shell hook this command replaces. */
export function findLegacyHooks(repository: HookRepository): LegacyHookEntry[] {
  const result = git(repository.repo, ["config", "--local", "--get-regexp", "^hook\\..*\\.command$"]);
  if (result.status !== 0) return [];
  const entries: LegacyHookEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^hook\.(.+)\.command (.*)$/.exec(line);
    if (match && match[1] !== HOOK_CONFIG_NAME && match[2].includes(LEGACY_HOOK_SCRIPT)) {
      entries.push({ name: match[1], command: match[2] });
    }
  }
  return entries;
}

export interface HookInstallOptions {
  method?: HookInstallMethod;
  spec: HookCommandSpec;
  configHooksSupported?: boolean;
}

export interface HookInstallResult {
  method: HookInstallMethod;
  changed: boolean;
  actions: string[];
  warnings: string[];
}

function legacyWarnings(repository: HookRepository): string[] {
  return findLegacyHooks(repository).map((entry) =>
    `the shell hook is still registered as hook.${entry.name}; remove it with: git -C ${shellQuote(repository.repo)} config --local --remove-section hook.${entry.name}`);
}

function installConfigHook(repository: HookRepository, command: string): HookInstallResult {
  const actions: string[] = [];
  const entry = readConfigHook(repository);
  const current = entry.command === command && entry.events.length === 1 && entry.events[0] === "post-checkout" && entry.enabled === null;
  if (!current) {
    // Throws on a same-name hook ocbi did not write, before anything changes.
    if (entry.command !== null || entry.events.length > 0 || entry.enabled !== null) removeConfigHook(repository);
    // git refuses to run any hook while an event has no command, so the command goes first.
    gitOk(repository.repo, ["config", "--local", `hook.${HOOK_CONFIG_NAME}.command`, command]);
    gitOk(repository.repo, ["config", "--local", `hook.${HOOK_CONFIG_NAME}.event`, "post-checkout"]);
    actions.push(`${entry.command === null ? "set" : "updated"} hook.${HOOK_CONFIG_NAME}.command and .event in ${path.join(repository.commonDir, "config")}`);
  }
  // A managed file from an install on an older git would run the hook a second time.
  actions.push(...removeManagedHookFile(resolveHookFileLocation(repository)));
  return { method: "config", changed: actions.length > 0, actions, warnings: [] };
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Writes the managed script through a temporary file. An existing unmanaged hook moves aside only
 * once that file is ready, and moves back if the managed script cannot take its place.
 */
function installHookFile(repository: HookRepository, spec: HookCommandSpec): HookInstallResult {
  const location = resolveHookFileLocation(repository);
  if (location.error) throw new Error(location.error);
  const actions: string[] = [];
  const script = managedHookScript(spec);
  fs.mkdirSync(location.dir, { recursive: true });
  const existing = readFileOrNull(location.file);
  const foreign = entryExists(location.file) && !isManagedHookFile(location.file);
  const chained = path.join(location.dir, CHAINED_HOOK_NAME);
  if (foreign && entryExists(chained)) {
    throw new Error(`${location.file} is not managed by ocbi and ${chained} already exists; move one of them before installing.`);
  }
  if (foreign || existing !== script) {
    const temp = `${location.file}.ocbi-${process.pid}.tmp`;
    fs.writeFileSync(temp, script, { mode: 0o755 });
    fs.chmodSync(temp, 0o755);
    try {
      if (foreign) fs.renameSync(location.file, chained);
      try {
        fs.renameSync(temp, location.file);
      } catch (error: unknown) {
        if (foreign) fs.renameSync(chained, location.file);
        throw error;
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
    if (foreign) actions.push(`moved the existing hook to ${chained}; the managed hook runs it first`);
    actions.push(`${existing === null || foreign ? "wrote" : "updated"} managed hook ${location.file}`);
  } else if ((fs.statSync(location.file).mode & 0o111) === 0) {
    fs.chmodSync(location.file, 0o755);
    actions.push(`made ${location.file} executable`);
  }
  if (removeConfigHook(repository)) actions.push(`removed hook.${HOOK_CONFIG_NAME} from the git config`);
  return { method: "file", changed: actions.length > 0, actions, warnings: [...location.warnings] };
}

export function installPostCheckoutHook(repository: HookRepository, options: HookInstallOptions): HookInstallResult {
  const supported = options.configHooksSupported ?? gitSupportsConfigHooks();
  const method = options.method ?? (supported ? "config" : "file");
  if (method === "config" && !supported) {
    throw new Error("This git has no config-based hooks (hook.<name>.event); use --method file.");
  }
  const configured = readConfigHook(repository).command;
  if (isForeignCommand(configured)) {
    throw new Error(`hook.${HOOK_CONFIG_NAME}.command is set to a command ocbi did not write (${configured}); remove or rename that hook first.`);
  }
  const result = method === "config"
    ? installConfigHook(repository, buildHookCommand(options.spec))
    : installHookFile(repository, options.spec);
  result.warnings.push(...legacyWarnings(repository));
  return result;
}

export function uninstallPostCheckoutHook(repository: HookRepository): { changed: boolean; actions: string[] } {
  const actions: string[] = [];
  const configured = readConfigHook(repository).command;
  if (isForeignCommand(configured)) {
    actions.push(`left hook.${HOOK_CONFIG_NAME} alone: ocbi did not write its command (${configured})`);
  } else if (removeConfigHook(repository)) {
    actions.push(`removed hook.${HOOK_CONFIG_NAME} from ${path.join(repository.commonDir, "config")}`);
  }
  actions.push(...removeManagedHookFile(resolveHookFileLocation(repository)));
  return { changed: actions.length > 0, actions };
}

export type HookCommandState = "current" | "other-install" | "stale" | "unparsed";

export interface HookCommandReport {
  command: string;
  state: HookCommandState;
  detail: string;
  host: string | null;
}

/** Compares an installed hook command with the running package's entry script. */
export function describeHookCommand(command: string, currentEntryScript: string): HookCommandReport {
  const words = parseHookInvocation(command) ?? [];
  if (words[2] !== "hook" || words[3] !== "post-checkout") {
    return { command, state: "unparsed", detail: "not a command written by ocbi hooks install", host: null };
  }
  const [nodePath, entryScript] = words;
  const hostIndex = words.indexOf("--host");
  const host = hostIndex >= 0 ? words[hostIndex + 1] ?? null : null;
  const missing = [nodePath, entryScript].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    return { command, state: "stale", detail: `${missing.join(" and ")} no longer exist${missing.length === 1 ? "s" : ""}, so the hook does nothing; rerun ocbi hooks install`, host };
  }
  if (realpathOrResolve(entryScript) !== realpathOrResolve(currentEntryScript)) {
    return { command, state: "other-install", detail: `runs ${entryScript}, not this package (${currentEntryScript}); rerun ocbi hooks install to switch`, host };
  }
  return { command, state: "current", detail: "runs this package", host };
}

export interface HookStatus {
  repo: string;
  commonDir: string;
  bare: boolean;
  configHooksSupported: boolean;
  config: (ConfigHookEntry & { report: HookCommandReport | null }) | null;
  file: { path: string; managed: boolean; chained: string | null; report: HookCommandReport | null } | null;
  fileError: string | null;
  legacy: LegacyHookEntry[];
  repositoryConfig: { path: string; exists: boolean };
  stateDir: string;
  installed: boolean;
}

function commandFromManagedFile(file: string): string | null {
  const line = fs.readFileSync(file, "utf-8").split("\n").find((entry) => entry.startsWith(`${HOOK_FUNCTION_NAME}() {`));
  return line ?? null;
}

export function getPostCheckoutHookStatus(
  repository: HookRepository,
  currentEntryScript: string,
  configHooksSupported: boolean = gitSupportsConfigHooks(),
): HookStatus {
  const entry = readConfigHook(repository);
  const config = entry.command === null && entry.events.length === 0
    ? null
    : { ...entry, report: entry.command === null ? null : describeHookCommand(entry.command, currentEntryScript) };
  const location = resolveHookFileLocation(repository);
  let file: HookStatus["file"] = null;
  if (!location.error && entryExists(location.file)) {
    const managed = isManagedHookFile(location.file);
    const chained = path.join(location.dir, CHAINED_HOOK_NAME);
    const command = managed ? commandFromManagedFile(location.file) : null;
    file = {
      path: location.file,
      managed,
      chained: entryExists(chained) ? chained : null,
      report: command === null ? null : describeHookCommand(command, currentEntryScript),
    };
  }
  const repositoryConfigPath = getRepositoryConfigPath(repository.commonDir);
  const configActive = config !== null && configHooksSupported && config.events.includes("post-checkout") && config.enabled !== "false";
  return {
    repo: repository.repo,
    commonDir: repository.commonDir,
    bare: repository.bare,
    configHooksSupported,
    config,
    file,
    fileError: location.error,
    legacy: findLegacyHooks(repository),
    repositoryConfig: { path: repositoryConfigPath, exists: fs.existsSync(repositoryConfigPath) },
    stateDir: getPostCheckoutStateDir(repository.commonDir),
    installed: configActive || file?.managed === true,
  };
}

export function formatPostCheckoutHookStatus(status: HookStatus): string {
  const lines = [`Repository: ${status.repo}${status.bare ? " (bare)" : ""}`, `Git common dir: ${status.commonDir}`];
  lines.push(`Config-based hooks: ${status.configHooksSupported ? "supported by this git" : "not supported by this git"}`);
  if (status.config) {
    const events = status.config.events.join(", ") || "none";
    lines.push(`Git config hook: hook.${HOOK_CONFIG_NAME} (events: ${events}${status.config.enabled === "false" ? ", disabled" : ""})`);
    if (status.config.report) {
      lines.push(`  Command: ${status.config.report.command}`);
      lines.push(`  ${status.config.report.state}: ${status.config.report.detail}`);
    }
    if (!status.configHooksSupported) lines.push("  Warning: this git ignores config-based hooks; install with --method file");
  } else {
    lines.push("Git config hook: not installed");
  }
  if (status.fileError) {
    lines.push(`Hook file: ${status.fileError}`);
  } else if (status.file) {
    lines.push(`Hook file: ${status.file.path} (${status.file.managed ? "managed by ocbi" : "not managed by ocbi"})`);
    if (status.file.report) {
      lines.push(`  Command: ${status.file.report.command}`);
      lines.push(`  ${status.file.report.state}: ${status.file.report.detail}`);
    }
    if (status.file.chained) lines.push(`  Chains to: ${status.file.chained}`);
  } else {
    lines.push("Hook file: none");
  }
  for (const legacy of status.legacy) {
    lines.push(`Warning: the shell hook is still registered as hook.${legacy.name} (${legacy.command})`);
  }
  if (status.config && status.file?.managed) {
    lines.push("Warning: both a config hook and a managed hook file are installed; the hook runs twice");
  }
  lines.push(`Repository config: ${status.repositoryConfig.path} (${status.repositoryConfig.exists ? "present" : "missing; the hook does nothing until it exists"})`);
  lines.push(`Hook logs: ${status.stateDir}`);
  lines.push(`Installed: ${status.installed ? "yes" : "no"}`);
  return lines.join("\n");
}
