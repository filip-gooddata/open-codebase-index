import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { HostMode } from "../config/host.js";
import type { executeIndexStatus } from "../tools/execute-common.js";

import { parseHostMode } from "../config/host.js";
import { loadConfigFile } from "../config/merger.js";
import { resolveProjectIndexPath } from "../config/paths.js";
import { parseConfig } from "../config/schema.js";
import { resolveDefaultProjectRoot } from "../git/index.js";
import type { WorkspaceStatusResult } from "../tools/workspace-status.js";
import type { BranchPruneResult } from "../indexer/branch-prune.js";
import type { BreakIndexLockResult, IndexLockEntry } from "../indexer/index-lock.js";
import { FRESH_INDEX_LOCK_MS } from "../indexer/index-lock.js";
import type { handleIndexCommand } from "./mcp/cli.js";
import { redactSensitiveText } from "../utils/redact.js";
import { runHistoryCli } from "./history-cli.js";
import { runHookCli, runHooksCli } from "./hooks-cli.js";

type TextSink = (text: string) => void;
type Result = { text: string; isError?: boolean };
type GraphDirection = "callers" | "callees";

export interface CbiDeps {
  runIndex?: typeof handleIndexCommand;
  runStatus?: typeof executeIndexStatus;
  runDefinition?: (projectRoot: string | undefined, host: HostMode, query: string) => Promise<Result>;
  runSearch?: (projectRoot: string | undefined, host: HostMode, query: string, limit: number) => Promise<Result>;
  runCallGraph?: (
    projectRoot: string | undefined,
    host: HostMode,
    symbol: string,
    direction: GraphDirection,
    filePath?: string,
  ) => Promise<Result>;
  runPrune?: (
    projectRoot: string,
    host: HostMode,
    options: { keys?: readonly string[]; apply: boolean },
  ) => Promise<BranchPruneResult>;
  runWorkspaceStatus?: (repoSpecs: string[], cwd: string, host: HostMode) => Promise<WorkspaceStatusResult>;
  initializeRuntimeForConfig?: (projectRoot: string, config: ReturnType<typeof parseConfig>, host: HostMode) => void;
  readConfigFile?: (filePath: string) => unknown;
  breakLock?: (target: string, options: { force: boolean }) => BreakIndexLockResult;
  printStdout?: TextSink;
  printStderr?: TextSink;
}

export interface CbiCommandArgs {
  project: string;
  host: HostMode;
  config?: string;
  limit: number;
  filePath?: string;
  positionals: string[];
  checkFreshness: boolean;
  workingTree: boolean;
  json: boolean;
  apply: boolean;
  force: boolean;
}

function printUsage(output: TextSink): void {
  output(`Usage: ocbi <command> [options]

Commands:
  status [--check-freshness] [--json] Show stored status; optionally check source freshness
  impact --working-tree [--json]  Inspect current indexed working-tree file impact
  prune [<catalog-key>...] [--apply] [--json]
                                  Remove branch catalogs no checked-out worktree uses (dry run unless --apply)
  index [options]                 Create or refresh the index
  unlock [<index-path>] [--force] [--json]
                                  Inspect and clear a stale index lock automatic recovery refused
  search <query> [--limit <n>]    Full-content semantic search
  definition <symbol>             Find authoritative definitions
  graph <callers|callees> <symbol> Inspect direct call-graph edges
  workspace status --repo NAME=PATH [--repo NAME=PATH ...] [--host <mode>] [--json]
                                  Show bounded multi-repository readiness
  history <sync|search|status|clear> Local-only opt-in GitHub issue/PR evidence
  hooks <install|uninstall|status> [--repo <path>]
                                  Manage the git post-checkout hook that refreshes the index
  hook post-checkout <prev> <new> <flag>
                                  Run by git: refresh this checkout's index in the background

Global options:
  --project <path>  Project root, default: containing Git checkout or current directory
  --host <mode>     opencode, codex, claude, pi (alias: omp), or jcode
  --config <path>   Explicit JSON config path
  --help            Show this message
`);
}

function printCommandUsage(output: TextSink, command: string): void {
  const usage: Record<string, string> = {
    status: "Usage: ocbi status [--check-freshness] [--json] [--project <path>] [--host <mode>] [--config <path>]",
    impact: "Usage: ocbi impact --working-tree [--json] [--project <path>] [--host <mode>] [--config <path>]",
    prune: "Usage: ocbi prune [<catalog-key>...] [--apply] [--json] [--project <path>] [--host <mode>] [--config <path>]",
    unlock: "Usage: ocbi unlock [<index-path>] [--force] [--json] [--project <path>] [--host <mode>]\n"
      + "Shows the index lock and clears it when its owner has exited. Never clears a lock whose owner is running on\n"
      + "this machine. An owner on another machine, an unreadable lock record, or a lock updated in the last 15 minutes\n"
      + "is cleared only with --force.",
    index: "Usage: ocbi index [--project <path>] [--host <mode>] [--config <path>] [--force [--allow-shared-rebuild]] [--estimate-only] [--dry-run] [--verbose]",
    search: "Usage: ocbi search <query> [--limit <n>] [--project <path>] [--host <mode>] [--config <path>]",
    definition: "Usage: ocbi definition <symbol> [--project <path>] [--host <mode>] [--config <path>]",
    graph: "Usage: ocbi graph <callers|callees> <symbol> [--file <path>] [--project <path>] [--host <mode>] [--config <path>]",
    workspace: "Usage: ocbi workspace status --repo NAME=PATH [--repo NAME=PATH ...] [--host <mode>] [--json]",
  };
  output(usage[command] ?? "Usage: ocbi <command> [options]");
}

function optionValue(args: string[], index: number, name: string): { value: string; consumed: number } {
  const arg = args[index];
  const equalsPrefix = `--${name}=`;
  if (arg.startsWith(equalsPrefix)) return { value: arg.slice(equalsPrefix.length), consumed: 0 };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value.`);
  return { value, consumed: 1 };
}

export function parseCbiCommandArgs(command: string, args: string[], cwd: string): CbiCommandArgs {
  let project: string | undefined;
  let host: HostMode = "opencode";
  let config: string | undefined;
  let limit = 5;
  let filePath: string | undefined;
  let checkFreshness = false;
  let workingTree = false;
  let json = false;
  let apply = false;
  let force = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new Error("help-requested");
    if (command === "status" && arg === "--check-freshness") {
      checkFreshness = true;
      continue;
    }
    if (command === "prune" && arg === "--apply") {
      apply = true;
      continue;
    }
    if (command === "unlock" && arg === "--force") {
      force = true;
      continue;
    }
    if ((command === "status" || command === "impact" || command === "prune" || command === "unlock") && arg === "--json") {
      json = true;
      continue;
    }
    if (command === "impact" && arg === "--working-tree") {
      workingTree = true;
      continue;
    }

    if (arg === "--project" || arg.startsWith("--project=")) {
      const parsed = optionValue(args, index, "project");
      project = path.resolve(cwd, parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = optionValue(args, index, "host");
      host = parseHostMode(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      const parsed = optionValue(args, index, "config");
      config = path.resolve(cwd, parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (command === "search" && (arg === "--limit" || arg.startsWith("--limit="))) {
      const parsed = optionValue(args, index, "limit");
      limit = Number(parsed.value);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
      index += parsed.consumed;
      continue;
    }
    if (command === "graph" && (arg === "--file" || arg.startsWith("--file="))) {
      const parsed = optionValue(args, index, "file");
      filePath = path.resolve(cwd, parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  return { project: project ?? resolveDefaultProjectRoot(cwd), host, config, limit, filePath, positionals, checkFreshness, workingTree, json, apply, force };
}

async function initializeFromConfig(args: CbiCommandArgs, deps: CbiDeps): Promise<void> {
  if (!args.config) return;
  const rawConfig = (deps.readConfigFile ?? loadConfigFile)(args.config);
  if (rawConfig === null) throw new Error(`Config file not found: ${args.config}`);
  // Native code runtime is only loaded for an explicit code command, never history/status/clear.
  const { initializeTools } = await import("../tools/operation-runtime.js");
  (deps.initializeRuntimeForConfig ?? initializeTools)(args.project, parseConfig(rawConfig), args.host);
}

const defaultSearch = async (projectRoot: string | undefined, host: HostMode, query: string, limit: number): Promise<Result> => {
  // Search is a code-only execution boundary; history never imports the code runtime.
  const { searchCodebase } = await import("../tools/operations.js");
  const { formatSearchResults } = await import("../tools/utils.js");
  const results = await searchCodebase(projectRoot, host, query, { limit });
  return results.length === 0
    ? { text: "No matching code found. Try a different query or run `ocbi index` first." }
    : { text: `Found ${results.length} results for "${query}":\n\n${formatSearchResults(results, "score")}` };
};

function requirePositionals(args: CbiCommandArgs, command: string, count: number): string[] {
  if (args.positionals.length !== count) {
    let expected = "a direction and a symbol";
    if (count === 0) expected = "no positional arguments";
    else if (count === 1) expected = "exactly one argument";
    throw new Error(`${command} requires ${expected}.`);
  }
  return args.positionals;
}

export async function runCbiCli(argv: string[], cwd: string, deps: CbiDeps = {}): Promise<number> {
  const stdout = deps.printStdout ?? ((text) => console.log(text));
  const stderr = deps.printStderr ?? ((text) => console.error(redactSensitiveText(text)));
  const command = argv[2];
  if (command === "history") return runHistoryCli(argv.slice(3), cwd, { printStdout: stdout, printStderr: stderr });
  if (command === "hook") return runHookCli(argv.slice(3), cwd, { printStdout: stdout, printStderr: stderr });
  if (command === "hooks") return runHooksCli(argv.slice(3), cwd, { printStdout: stdout, printStderr: stderr });

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage(stdout);
    return 0;
  }

  if (!["status", "impact", "prune", "index", "unlock", "search", "definition", "graph", "workspace"].includes(command)) {
    stderr(`Unknown command: ${command}`);
    printUsage(stderr);
    return 1;
  }

  try {
    if (command === "unlock") return await runUnlock(parseCbiCommandArgs(command, argv.slice(3), cwd), cwd, deps, stdout, stderr);
    // Keep the public CLI facade native-free until a code command actually executes.
    const { executeCallGraph, executeImplementationLookup, executeIndexStatus } = await import("../tools/execute-common.js");
    const { formatWorkspaceStatus, getWorkspaceStatus, parseWorkspaceRepoSpecs } = await import("../tools/workspace-status.js");
    const { handleIndexCommand } = await import("./mcp/cli.js");
    if (command === "workspace") {
      const args = argv.slice(3);
      if (args[0] !== "status") throw new Error("workspace requires the status subcommand.");
      let host: HostMode = "opencode";
      let json = false;
      const repoSpecs: string[] = [];
      for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help" || arg === "-h") throw new Error("help-requested");
        if (arg === "--json") {
          json = true;
          continue;
        }
        if (arg === "--host" || arg.startsWith("--host=")) {
          const parsed = optionValue(args, index, "host");
          host = parseHostMode(parsed.value);
          index += parsed.consumed;
          continue;
        }
        if (arg === "--repo" || arg.startsWith("--repo=")) {
          const parsed = optionValue(args, index, "repo");
          repoSpecs.push(parsed.value);
          index += parsed.consumed;
          continue;
        }
        throw new Error(arg.startsWith("--") ? `Unknown option: ${arg}` : `Unexpected argument: ${arg}`);
      }
      const result = await (deps.runWorkspaceStatus ?? (async (specs, root, hostMode) =>
        getWorkspaceStatus(parseWorkspaceRepoSpecs(specs, root), hostMode)))(repoSpecs, cwd, host);
      stdout(json ? JSON.stringify(result, null, 2) : formatWorkspaceStatus(result));
      return result.ready ? 0 : 1;
    }

    if (command === "index") {
      if (argv.slice(3).some((arg) => arg === "--help" || arg === "-h")) {
        printCommandUsage(stdout, command);
        return 0;
      }
      return await (deps.runIndex ?? handleIndexCommand)(argv.slice(3), cwd, {
        printStdout: stdout,
        printStderr: stderr,
      });
    }

    const args = parseCbiCommandArgs(command, argv.slice(3), cwd);
    if (command === "impact") {
      requirePositionals(args, command, 0);
      if (!args.workingTree) throw new Error("impact requires --working-tree.");
    }
    await initializeFromConfig(args, deps);

    if (command === "status") {
      requirePositionals(args, command, 0);
      const result = await (deps.runStatus ?? executeIndexStatus)(args.project, args.host, { checkFreshness: args.checkFreshness });
      if (result.isError) { stderr(result.text); return 1; }
      if (args.json && result.details === undefined) throw new Error("Status did not return structured details.");
      stdout(args.json ? JSON.stringify(result.details, null, 2) : result.text);
      return 0;
    }
    if (command === "prune") {
      const run = deps.runPrune ?? (async (root, hostMode, options) => {
        // Static imports would load the native code runtime for help/history-only CLI use.
        const { pruneBranchCatalogs } = await import("../tools/operations.js");
        return pruneBranchCatalogs(root, hostMode, options);
      });
      const result = await run(args.project, args.host, {
        keys: args.positionals.length > 0 ? args.positionals : undefined,
        apply: args.apply,
      });
      const { formatBranchPruneResult } = await import("../indexer/branch-prune.js");
      stdout(args.json ? JSON.stringify(result, null, 2) : formatBranchPruneResult(result));
      return result.refused.length > 0 ? 1 : 0;
    }
    if (command === "impact") {
      // Static imports would load the native code runtime for help/history-only CLI use.
      const { getPrImpact } = await import("../tools/operations.js");
      const { formatPrImpact } = await import("../tools/format-pr-impact.js");
      const result = await getPrImpact(args.project, args.host, { workingTree: true });
      stdout(args.json ? JSON.stringify(result, null, 2) : formatPrImpact(result));
      return 0;
    }
    if (command === "search") {
      const [query] = requirePositionals(args, command, 1);
      const result = await (deps.runSearch ?? defaultSearch)(args.project, args.host, query, args.limit);
      if (result.isError) { stderr(result.text); return 1; }
      stdout(result.text);
      return 0;
    }
    if (command === "definition") {
      const [query] = requirePositionals(args, command, 1);
      const result = await (deps.runDefinition ?? ((root, hostMode, symbol) =>
        executeImplementationLookup(root, hostMode, { query: symbol, limit: 5 })))(args.project, args.host, query);
      if (result.isError) { stderr(result.text); return 1; }
      stdout(result.text);
      return 0;
    }

    const [direction, symbol] = requirePositionals(args, command, 2);
    if (direction !== "callers" && direction !== "callees") throw new Error("graph direction must be callers or callees.");
    const result = await (deps.runCallGraph ?? ((root, hostMode, name, graphDirection, file) =>
      executeCallGraph(root, hostMode, { name, direction: graphDirection, filePath: file })))(args.project, args.host, symbol, direction, args.filePath);
    if (result.isError) { stderr(result.text); return 1; }
    stdout(result.text);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === "help-requested") {
      printCommandUsage(stderr, command);
      return 0;
    }
    stderr(error instanceof Error ? error.message : String(error));
    printCommandUsage(stderr, command);
    return 1;
  }
}

function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days`;
}

const ENTRY_STATE_TEXT: Record<IndexLockEntry["state"], string> = {
  alive: "owner process is running on this machine",
  dead: "owner process has exited",
  unverified: "owner cannot be verified from this machine",
  unreadable: "lock record is unreadable",
};

function formatLockEntry(entry: IndexLockEntry): string {
  const lines = [`- ${entry.kind}: ${entry.path}`];
  if (entry.owner) {
    const machine = entry.local ? "this machine" : "another machine or a former hostname not recognized here";
    const operation = entry.owner.operation === undefined ? "" : `, operation ${entry.owner.operation}`;
    lines.push(`  owner: PID ${entry.owner.pid} on ${entry.owner.hostname} (${machine})${operation}, started ${entry.owner.startedAt}`);
  }
  lines.push(`  state: ${ENTRY_STATE_TEXT[entry.state]}${entry.ageMs === null ? "" : `, last updated ${formatAge(entry.ageMs)} ago`}`);
  lines.push(`  contents: ${entry.contents === null ? "(missing)" : entry.contents.trim()}`);
  return lines.join("\n");
}

const FORCE_ADVICE = "Rerun with --force only after confirming that no index process using this index is running on any machine that can reach it.";

function formatBreakLockOutcome(result: BreakIndexLockResult): string {
  switch (result.status) {
    case "no-lock":
      return `No index lock found in ${result.indexPath}.`;
    case "removed":
      return result.recoverable
        ? "Cleared. The next index run recovers any partial writes the previous owner left behind."
        : "Cleared. The removed record was unreadable or from a legacy release, so partial writes its owner may have left cannot be recovered automatically. If results look wrong, rebuild with `ocbi index --force`.";
    case "refused-alive":
      return "Refused: the lock owner is still running on this machine. Let it finish or stop it first.";
    case "refused-busy":
      return "Refused: another unlock holds the guard shown above. If no unlock is still running, rerun with --force; a holder alive on this machine is never displaced.";
    case "refused-changed":
      return "Refused: the lock changed while it was being cleared. Run the command again to inspect the new state.";
    case "refused-fresh":
      return `Refused: the owner has exited, but the lock was updated less than 15 minutes ago. The next index run on this machine recovers it automatically. ${FORCE_ADVICE}`;
    case "refused-unverified": {
      const fresh = result.entries.some((entry) => entry.ageMs !== null && entry.ageMs < FRESH_INDEX_LOCK_MS);
      const warning = fresh ? " The lock was updated less than 15 minutes ago, so it may still be in use." : "";
      return `Refused: the lock owner cannot be verified from this machine.${warning} ${FORCE_ADVICE}`;
    }
  }
}

function resolveUnlockTarget(args: CbiCommandArgs, cwd: string): string {
  if (args.positionals.length > 1) throw new Error("unlock accepts at most one index path.");
  if (args.positionals.length === 1) return path.resolve(cwd, args.positionals[0]);
  const indexPath = resolveProjectIndexPath(args.project, "project", args.host);
  const structuralPath = path.join(indexPath, "structural");
  return !existsSync(path.join(indexPath, "indexing.lock")) && existsSync(path.join(structuralPath, "indexing.lock"))
    ? structuralPath
    : indexPath;
}

async function runUnlock(args: CbiCommandArgs, cwd: string, deps: CbiDeps, stdout: TextSink, stderr: TextSink): Promise<number> {
  const target = resolveUnlockTarget(args, cwd);
  const breakLock = deps.breakLock ?? (await import("../indexer/index-lock.js")).breakIndexLock;
  const result = breakLock(target, { force: args.force });
  const succeeded = result.status === "removed" || result.status === "no-lock";
  if (args.json) {
    stdout(JSON.stringify(result, null, 2));
    return succeeded ? 0 : 1;
  }
  const report = [
    ...(result.entries.length > 0 ? [`Index lock in ${result.indexPath}:`, ...result.entries.map(formatLockEntry)] : []),
    formatBreakLockOutcome(result),
  ].join("\n");
  (succeeded ? stdout : stderr)(report);
  return succeeded ? 0 : 1;
}

export function isCbiEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}
