import { existsSync, readFileSync, realpathSync } from "fs";
import * as os from "os";
import * as path from "path";

import type { HostMode } from "./host.js";
import { resolveRepositoryLayout, type RepositoryLayout } from "../git/layout.js";
import { getHostProjectIndexRelativePath, resolveGlobalConfigPath } from "./paths.js";

export type CheckoutRole = "primary" | "secondary";
export type RepositoryStoreSource = "repository map" | "repository default";

/**
 * The per-repository route of one checkout: which `repositories` entry of the
 * host global config matches it, where its store lives, and which role the
 * checkout plays. Resolved once per process per (checkout, host).
 */
export interface RepositoryRoute {
  checkoutRoot: string;
  host: HostMode;
  globalConfigPath: string;
  layout: RepositoryLayout | null;
  /** Matching entry key as written in the global config, or null. */
  entryKey: string | null;
  /** Matching entry as read at resolution time, or null. */
  entry: Record<string, unknown> | null;
  /** Shared store path when an entry matches. */
  indexPath: string | null;
  storeSource: RepositoryStoreSource | null;
  role: CheckoutRole | null;
  roleReason: string | null;
  primaryPath: string | null;
  warnings: string[];
}

const routeCache = new Map<string, RepositoryRoute>();
const emittedWarnings = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Expands `~` and resolves a relative path against the repository's common dir. */
export function resolveRepositoryEntryPath(value: string, commonDir: string): string {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(commonDir, expanded);
}

function warnOnce(message: string): void {
  if (emittedWarnings.has(message)) return;
  emittedWarnings.add(message);
  console.warn(`[codebase-index] ${message}`);
}

function describeEntry(globalConfigPath: string, key: string): string {
  return `Config file ${globalConfigPath} repositories entry '${key}'`;
}

/** Returns the first shape error of an entry's routing fields, or null. */
function getEntryShapeError(globalConfigPath: string, key: string, entry: unknown): string | null {
  const label = describeEntry(globalConfigPath, key);
  if (!isRecord(entry)) {
    return `${label} must be an object.`;
  }

  const storage = entry.storage;
  if (storage !== undefined) {
    if (!isRecord(storage)) return `${label} field 'storage' must be an object.`;
    if (storage.indexPath !== undefined && (typeof storage.indexPath !== "string" || storage.indexPath.trim() === "")) {
      return `${label} field 'storage.indexPath' must be a non-empty string.`;
    }
  }

  const checkouts = entry.checkouts;
  if (checkouts !== undefined) {
    if (!isRecord(checkouts)) return `${label} field 'checkouts' must be an object.`;
    for (const role of ["primary", "secondary"] as const) {
      const roleConfig = checkouts[role];
      if (roleConfig === undefined) continue;
      if (!isRecord(roleConfig)) return `${label} field 'checkouts.${role}' must be an object.`;
      if (role === "primary" && roleConfig.path !== undefined
        && (typeof roleConfig.path !== "string" || roleConfig.path.trim() === "")) {
        return `${label} field 'checkouts.primary.path' must be a non-empty string.`;
      }
      for (const flag of ["watchFiles", "autoIndexOnStartup"] as const) {
        if (roleConfig[flag] !== undefined && typeof roleConfig[flag] !== "boolean") {
          return `${label} field 'checkouts.${role}.${flag}' must be a boolean.`;
        }
      }
    }
  }

  return null;
}

interface GlobalRepositoryMap {
  globalConfigPath: string;
  repositories: Record<string, unknown> | null;
  warning: string | null;
}

function readGlobalRepositoryMap(host: HostMode): GlobalRepositoryMap {
  const globalConfigPath = resolveGlobalConfigPath(host);
  if (!existsSync(globalConfigPath)) {
    return { globalConfigPath, repositories: null, warning: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      globalConfigPath,
      repositories: null,
      warning: `Global config ${globalConfigPath} could not be read (${message}); the repositories map is ignored and legacy store routing is in use.`,
    };
  }

  if (!isRecord(parsed) || parsed.repositories === undefined) {
    return { globalConfigPath, repositories: null, warning: null };
  }
  if (!isRecord(parsed.repositories)) {
    return {
      globalConfigPath,
      repositories: null,
      warning: `Config file ${globalConfigPath} field 'repositories' must be an object; it is ignored.`,
    };
  }
  return { globalConfigPath, repositories: parsed.repositories, warning: null };
}

interface EntryMatch {
  key: string;
  entry: Record<string, unknown>;
  warnings: string[];
}

function findMatchingEntry(
  map: GlobalRepositoryMap,
  layout: RepositoryLayout,
): EntryMatch | null {
  if (!map.repositories) return null;

  const matches: Array<[string, unknown]> = [];
  const warnings: string[] = [];
  for (const [key, entry] of Object.entries(map.repositories)) {
    const matchesLayout = key.trim() !== ""
      && canonicalize(resolveRepositoryEntryPath(key, process.cwd())) === layout.commonDir;
    if (matchesLayout) {
      matches.push([key, entry]);
      continue;
    }
    const shapeError = getEntryShapeError(map.globalConfigPath, key, entry);
    if (shapeError) {
      warnings.push(`${shapeError} The entry does not match this repository and is ignored.`);
    }
  }

  if (matches.length === 0) return null;

  const [key, entry] = matches[0];
  const shapeError = getEntryShapeError(map.globalConfigPath, key, entry);
  if (shapeError) {
    throw new Error(shapeError);
  }
  if (matches.length > 1) {
    warnings.push(
      `Repositories keys ${matches.map(([duplicate]) => `'${duplicate}'`).join(", ")} all match ${layout.commonDir}; using '${key}'.`,
    );
  }
  return { key, entry: entry as Record<string, unknown>, warnings };
}

interface RoleDecision {
  role: CheckoutRole;
  reason: string;
  primaryPath: string | null;
  warning: string | null;
}

function decideRole(layout: RepositoryLayout, entry: Record<string, unknown>): RoleDecision {
  const checkouts = isRecord(entry.checkouts) ? entry.checkouts : {};
  const primary = isRecord(checkouts.primary) ? checkouts.primary : {};

  if (typeof primary.path === "string") {
    const configuredPath = resolveRepositoryEntryPath(primary.path, layout.commonDir);
    const primaryLayout = resolveRepositoryLayout(configuredPath);
    if (!primaryLayout || primaryLayout.commonDir !== layout.commonDir) {
      const reason = `configured primary ${configuredPath} is not a checkout of this repository`;
      return { role: "secondary", reason, primaryPath: null, warning: `Checkout roles: ${reason}; every checkout is secondary.` };
    }
    return primaryLayout.checkoutRoot === layout.checkoutRoot
      ? { role: "primary", reason: "configured primary", primaryPath: primaryLayout.checkoutRoot, warning: null }
      : { role: "secondary", reason: `configured primary is ${primaryLayout.checkoutRoot}`, primaryPath: primaryLayout.checkoutRoot, warning: null };
  }

  if (layout.mainWorktree) {
    const mainWorktree = canonicalize(layout.mainWorktree);
    return mainWorktree === layout.checkoutRoot
      ? { role: "primary", reason: "main worktree of a normal clone", primaryPath: mainWorktree, warning: null }
      : { role: "secondary", reason: `linked worktree; the main worktree ${mainWorktree} is primary`, primaryPath: mainWorktree, warning: null };
  }

  return {
    role: "secondary",
    reason: "bare-base layout needs checkouts.primary.path",
    primaryPath: null,
    warning: null,
  };
}

function buildRoute(projectRoot: string, host: HostMode): RepositoryRoute {
  const map = readGlobalRepositoryMap(host);
  const layout = resolveRepositoryLayout(projectRoot);
  const route: RepositoryRoute = {
    checkoutRoot: layout?.checkoutRoot ?? canonicalize(projectRoot),
    host,
    globalConfigPath: map.globalConfigPath,
    layout,
    entryKey: null,
    entry: null,
    indexPath: null,
    storeSource: null,
    role: null,
    roleReason: null,
    primaryPath: null,
    warnings: map.warning ? [map.warning] : [],
  };

  if (!layout) return route;

  const match = findMatchingEntry(map, layout);
  if (!match) return route;

  route.entryKey = match.key;
  route.entry = match.entry;
  route.warnings.push(...match.warnings);

  const storage = isRecord(match.entry.storage) ? match.entry.storage : {};
  if (typeof storage.indexPath === "string") {
    route.indexPath = resolveRepositoryEntryPath(storage.indexPath, layout.commonDir);
    route.storeSource = "repository map";
  } else {
    route.indexPath = path.join(layout.commonDir, "codebase-index", "index");
    route.storeSource = "repository default";
  }

  const decision = decideRole(layout, match.entry);
  route.role = decision.role;
  route.roleReason = decision.reason;
  route.primaryPath = decision.primaryPath;
  if (decision.warning) route.warnings.push(decision.warning);

  const localIndexPath = path.join(layout.checkoutRoot, getHostProjectIndexRelativePath(host));
  if (existsSync(localIndexPath) && canonicalize(localIndexPath) !== canonicalize(route.indexPath)) {
    route.warnings.push(
      `Local index ${localIndexPath} is not used; this checkout reads the shared store ${route.indexPath}.`,
    );
  }

  return route;
}

/**
 * Resolves the repository route for a checkout. The first resolution in a
 * process is kept: later edits to the global config do not re-route a running
 * process (status reports the drift instead). A matching but invalid entry
 * throws a config error and is not cached.
 */
export function resolveRepositoryRoute(projectRoot: string, host: HostMode): RepositoryRoute {
  const cacheKey = `${canonicalize(projectRoot)}\0${host}`;
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  const route = buildRoute(projectRoot, host);
  for (const warning of route.warnings) warnOnce(warning);
  routeCache.set(cacheKey, route);
  return route;
}

/** Returns the matched route, or null when no repositories entry matches. */
export function resolveMatchedRepositoryRoute(projectRoot: string, host: HostMode): RepositoryRoute | null {
  const route = resolveRepositoryRoute(projectRoot, host);
  return route.entryKey === null ? null : route;
}

/** Test-only: forget every resolved route so a test can change the global config. */
export function resetRepositoryRoutesForTests(): void {
  routeCache.clear();
  emittedWarnings.clear();
}

function describeRouteDrift(route: RepositoryRoute): string | null {
  if (!route.layout) return null;
  let current: EntryMatch | null;
  try {
    current = findMatchingEntry(readGlobalRepositoryMap(route.host), route.layout);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Global config changed since start: ${message}`;
  }

  const before = route.entryKey === null ? null : JSON.stringify([route.entryKey, route.entry]);
  const after = current === null ? null : JSON.stringify([current.key, current.entry]);
  return before === after
    ? null
    : "Global config changed since start: the repositories entry for this checkout differs; restart to apply it.";
}

/**
 * Status lines for the repository route of a checkout. `indexPath` is the
 * store the indexer actually uses.
 */
export function formatRepositoryRouteStatus(projectRoot: string, host: HostMode, indexPath: string): string {
  let route: RepositoryRoute;
  try {
    route = resolveRepositoryRoute(projectRoot, host);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Repository route error: ${message}`;
  }

  const lines: string[] = [];
  if (route.entryKey !== null) {
    lines.push(`Store: ${indexPath} (${route.storeSource} '${route.entryKey}')`);
    lines.push(`Checkout role: ${route.role} - ${route.roleReason}`);
  } else {
    lines.push(`Store: ${indexPath} (host default)`);
  }

  const warnings = [...route.warnings];
  const drift = describeRouteDrift(route);
  if (drift) warnings.push(drift);
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}
