import type { HostMode } from "../config/host.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseHostMode } from "../config/host.js";
import {
  formatPostCheckoutHookStatus,
  getPostCheckoutHookStatus,
  installPostCheckoutHook,
  resolveHookNodePath,
  resolveHookRepository,
  uninstallPostCheckoutHook,
  type HookInstallMethod,
} from "../git/hook-install.js";
import { runPostCheckoutHook, runRefreshWorker, type PostCheckoutHookDeps } from "../git/post-checkout-hook.js";

type TextSink = (text: string) => void;

export interface HooksCliDeps {
  printStdout?: TextSink;
  printStderr?: TextSink;
  platform?: NodeJS.Platform;
  /** Entry script the installed hook runs; defaults to the running `ocbi` script. */
  entryScript?: string;
  hookDeps?: PostCheckoutHookDeps;
}

const HOOK_USAGE = "Usage: ocbi hook post-checkout [--host <mode>] [--stale-notify <command>] <previous-head> <new-head> <branch-flag>";
const HOOKS_USAGE = `Usage: ocbi hooks <install|uninstall|status> [--repo <path>] [options]

  install    Register \`ocbi hook post-checkout\` for the repository
             [--host <mode>] [--method config|file] [--node <path>] [--stale-notify <command>]
             A reinstall keeps the installed hook's --host unless one is given.
  uninstall  Remove what install registered and restore a chained hook
  status     Show what is installed and whether it runs this package [--json]

  --repo <path>  A checkout, linked worktree or bare repository (default: current directory)

After a branch checkout the hook refreshes the checkout's index in the background. Once a day per
repository it also reads the store's compatibility verdict, as \`ocbi status\` reports it, and
counts the catalogs \`ocbi prune\` would remove. An incompatible store (embeddings from another
provider, model or dimensions, or a store format a release changed) is the only reason for a full
rebuild; stale catalogs need a prune, never a rebuild. It only logs and notifies; it never rebuilds or
prunes. --stale-notify <command> runs <command> TITLE BODY [ACTION_LABEL ACTION_COMMAND] for a
"Rebuild needed" (action: ocbi-rebuild <checkout>, when on PATH) or "Worth a cleanup" (action:
ocbi prune --apply) notice. OCBI_PREWARM=0 skips the hook; OCBI_COMPAT_CHECK=0 and
OCBI_STALE_CHECK=0 skip either check. A scheduled check on a timer (the local wrapper's
ocbi-schedule) is optional; the hook covers both checks.`;

interface ParsedOptions {
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

function parseOptions(args: readonly string[], valueOptions: readonly string[], flagOptions: readonly string[]): ParsedOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [name, inline] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name !== null && valueOptions.includes(name)) {
      const value = inline ?? args[index + 1];
      if (value === undefined) throw new Error(`Missing value for --${name}`);
      if (inline === undefined) index += 1;
      values.set(name, value);
    } else if (name !== null && flagOptions.includes(name)) {
      flags.add(name);
    } else if (name !== null && arg !== "--") {
      throw new Error(`Unknown option: ${arg}`);
    } else if (arg !== "--") {
      positionals.push(arg);
    }
  }
  return { values, flags, positionals };
}

function resolveEntryScript(deps: HooksCliDeps): string {
  const entry = deps.entryScript ?? process.argv[1];
  try {
    return fs.realpathSync.native(entry);
  } catch {
    return path.resolve(entry);
  }
}

function hostOption(parsed: ParsedOptions): HostMode {
  return parseHostMode(parsed.values.get("host") ?? "opencode");
}

/** `ocbi hook ...`: runs from git, so it never fails the checkout. */
export async function runHookCli(argv: string[], cwd: string, deps: HooksCliDeps = {}): Promise<number> {
  const stdout = deps.printStdout ?? ((text) => console.log(text));
  const stderr = deps.printStderr ?? ((text) => console.error(text));
  const [event, ...rest] = argv;
  if (!event || event === "--help" || event === "-h") {
    stdout(HOOK_USAGE);
    return 0;
  }
  try {
    if (event === "refresh-worker") {
      const parsed = parseOptions(rest, ["project", "common-dir", "host", "stale-notify"], []);
      const project = parsed.values.get("project");
      const commonDir = parsed.values.get("common-dir");
      if (!project || !commonDir) throw new Error("refresh-worker needs --project and --common-dir");
      await runRefreshWorker({ checkoutRoot: project, commonDir, host: hostOption(parsed), staleNotify: parsed.values.get("stale-notify") });
      return 0;
    }
    if (event !== "post-checkout") {
      stderr(`ocbi hook: unknown hook ${event}; only post-checkout is supported.`);
      return 0;
    }
    const parsed = parseOptions(rest, ["host", "stale-notify"], []);
    runPostCheckoutHook(parsed.positionals, cwd, hostOption(parsed), { staleNotify: parsed.values.get("stale-notify") }, {
      platform: deps.platform,
      entryScript: deps.entryScript ?? process.argv[1],
      stderr,
      ...deps.hookDeps,
    });
  } catch (error: unknown) {
    stderr(`ocbi hook ${event}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

export async function runHooksCli(argv: string[], cwd: string, deps: HooksCliDeps = {}): Promise<number> {
  const stdout = deps.printStdout ?? ((text) => console.log(text));
  const stderr = deps.printStderr ?? ((text) => console.error(text));
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h" || rest.includes("--help") || rest.includes("-h")) {
    stdout(HOOKS_USAGE);
    return 0;
  }
  if ((deps.platform ?? process.platform) === "win32") {
    stderr("ocbi hooks: Windows is not supported; the post-checkout hook runs on macOS and Linux.");
    return 1;
  }
  try {
    if (!["install", "uninstall", "status"].includes(action)) throw new Error(`Unknown hooks action: ${action}`);
    const parsed = parseOptions(rest, ["repo", "host", "method", "node", "stale-notify"], ["json"]);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
    const repository = resolveHookRepository(parsed.values.get("repo") ?? cwd);
    const entryScript = resolveEntryScript(deps);

    if (action === "status") {
      const status = getPostCheckoutHookStatus(repository, entryScript);
      stdout(parsed.flags.has("json") ? JSON.stringify(status, null, 2) : formatPostCheckoutHookStatus(status));
      return 0;
    }

    if (action === "uninstall") {
      const result = uninstallPostCheckoutHook(repository);
      stdout(result.changed ? result.actions.join("\n") : "Nothing to uninstall.");
      return 0;
    }

    const method = parsed.values.get("method");
    if (method !== undefined && method !== "config" && method !== "file") {
      throw new Error(`--method must be config or file, not ${method}`);
    }
    const staleNotify = parsed.values.get("stale-notify");
    const nodeOption = parsed.values.get("node");
    const installed = getPostCheckoutHookStatus(repository, entryScript);
    const installedHost = installed.config?.report?.host ?? installed.file?.report?.host ?? null;
    const host = parsed.values.has("host") || installedHost === null ? hostOption(parsed) : parseHostMode(installedHost);
    const result = installPostCheckoutHook(repository, {
      method: method as HookInstallMethod | undefined,
      spec: {
        nodePath: nodeOption === undefined ? resolveHookNodePath() : path.resolve(cwd, nodeOption),
        entryScript,
        host,
        staleNotify: staleNotify === undefined || !staleNotify.includes("/") ? staleNotify : path.resolve(cwd, staleNotify),
      },
    });
    stdout(result.changed ? result.actions.join("\n") : `Already installed (${result.method}).`);
    for (const warning of result.warnings) stderr(`Warning: ${warning}`);
    return 0;
  } catch (error: unknown) {
    stderr(`ocbi hooks ${action}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
