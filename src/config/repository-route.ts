import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import * as os from "os";
import * as path from "path";

import type { HostMode } from "./host.js";
import { validateConfigLayerShape } from "./layer-shape.js";
import { resolveRepositoryLayout, type RepositoryLayout } from "../git/layout.js";
import { getHostProjectIndexRelativePath, resolveGlobalIndexPath } from "./paths.js";

export type CheckoutRole = "primary" | "secondary";
export type RepositoryStoreSource = "repository config" | "repository default store";

export const REPOSITORY_CONFIG_DIRNAME = "codebase-index";
export const REPOSITORY_CONFIG_FILENAME = "config.json";

/**
 * The per-repository route of one checkout: whether the repository has a
 * config file in its git common dir, where its store lives, and which role the
 * checkout plays. Resolved once per process per (checkout, host).
 */
export interface RepositoryRoute {
  checkoutRoot: string;
  host: HostMode;
  layout: RepositoryLayout | null;
  /** `<common dir>/codebase-index/config.json`, or null outside a checkout. */
  configPath: string | null;
  /** Parsed repository config as read at resolution time, or null when absent. */
  config: Record<string, unknown> | null;
  /** Shared store path when the repository config exists. */
  indexPath: string | null;
  storeSource: RepositoryStoreSource | null;
  role: CheckoutRole | null;
  roleReason: string | null;
  primaryPath: string | null;
  warnings: string[];
}

const routeCache = new Map<string, RepositoryRoute>();

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

/** Path of the repository config file for a git common dir. */
export function getRepositoryConfigPath(commonDir: string): string {
  return path.join(commonDir, REPOSITORY_CONFIG_DIRNAME, REPOSITORY_CONFIG_FILENAME);
}

/** Returns the first shape error of the routing fields, or null. */
function getRoutingShapeError(configPath: string, config: unknown): string | null {
  const label = `Repository config ${configPath}`;
  if (!isRecord(config)) {
    return `${label} must contain a JSON object at the root.`;
  }

  const storage = config.storage;
  if (storage !== undefined) {
    if (!isRecord(storage)) return `${label} field 'storage' must be an object.`;
    if (storage.indexPath !== undefined && (typeof storage.indexPath !== "string" || storage.indexPath.trim() === "")) {
      return `${label} field 'storage.indexPath' must be a non-empty string.`;
    }
  }

  const checkouts = config.checkouts;
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

  const indexing = config.indexing;
  if (isRecord(indexing) && indexing.autoIndexOnStartup !== undefined
    && typeof indexing.autoIndexOnStartup !== "boolean") {
    return `${label} field 'indexing.autoIndexOnStartup' must be a boolean.`;
  }

  return null;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when nothing, not even a dangling symbolic link, exists at the path. */
function isAbsentPath(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return false;
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return true;
    throw new Error(`Failed to read repository config ${filePath}: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Reads the repository config file. Returns null only when the file is
 * genuinely absent (ENOENT with nothing at the path). Any other read failure,
 * a dangling symbolic link, unparsable JSON, or an invalid routing or section
 * shape throws a config error naming the file (fail closed: never fall back
 * to a local store).
 */
function readRepositoryConfig(configPath: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT" && isAbsentPath(configPath)) {
      return null;
    }
    const reason = getErrorCode(error) === "ENOENT"
      ? "it is a symbolic link whose target does not exist"
      : getErrorMessage(error);
    throw new Error(`Failed to read repository config ${configPath}: ${reason}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(`Failed to load repository config ${configPath}: ${getErrorMessage(error)}`, { cause: error });
  }

  const shapeError = getRoutingShapeError(configPath, parsed);
  if (shapeError) {
    throw new Error(shapeError);
  }
  return validateConfigLayerShape(parsed, configPath);
}

interface RoleDecision {
  role: CheckoutRole;
  reason: string;
  primaryPath: string | null;
  warning: string | null;
}

function decideRole(layout: RepositoryLayout, config: Record<string, unknown>): RoleDecision {
  const checkouts = isRecord(config.checkouts) ? config.checkouts : {};
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
  const layout = resolveRepositoryLayout(projectRoot);
  const configPath = layout ? getRepositoryConfigPath(layout.commonDir) : null;
  const route: RepositoryRoute = {
    checkoutRoot: layout?.checkoutRoot ?? canonicalize(projectRoot),
    host,
    layout,
    configPath,
    config: null,
    indexPath: null,
    storeSource: null,
    role: null,
    roleReason: null,
    primaryPath: null,
    warnings: [],
  };

  if (!layout || !configPath) return route;

  const config = readRepositoryConfig(configPath);
  if (!config) return route;

  route.config = config;
  const storage = isRecord(config.storage) ? config.storage : {};
  if (typeof storage.indexPath === "string") {
    route.indexPath = resolveRepositoryEntryPath(storage.indexPath, layout.commonDir);
    route.storeSource = "repository config";
  } else {
    route.indexPath = path.join(layout.commonDir, REPOSITORY_CONFIG_DIRNAME, "index");
    route.storeSource = "repository default store";
  }

  const decision = decideRole(layout, config);
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
 * process is kept: later edits to the repository config do not re-route a
 * running process (status reports the change instead). An invalid repository
 * config throws a config error and is not cached.
 */
export function resolveRepositoryRoute(projectRoot: string, host: HostMode): RepositoryRoute {
  const cacheKey = `${canonicalize(projectRoot)}\0${host}`;
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  const route = buildRoute(projectRoot, host);
  routeCache.set(cacheKey, route);
  return route;
}

/** Returns the route when the repository config exists, else null. */
export function resolveMatchedRepositoryRoute(projectRoot: string, host: HostMode): RepositoryRoute | null {
  const route = resolveRepositoryRoute(projectRoot, host);
  return route.config === null ? null : route;
}

/** Test-only: forget every resolved route so a test can change repository configs. */
export function resetRepositoryRoutesForTests(): void {
  routeCache.clear();
}

function describeRouteDrift(route: RepositoryRoute): string | null {
  if (!route.configPath) return null;
  let current: Record<string, unknown> | null;
  try {
    current = readRepositoryConfig(route.configPath);
  } catch (error: unknown) {
    return `Repository config changed since start: ${getErrorMessage(error)}`;
  }

  const before = route.config === null ? null : JSON.stringify(route.config);
  const after = current === null ? null : JSON.stringify(current);
  return before === after
    ? null
    : `Repository config ${route.configPath} changed since start; restart to apply it.`;
}

export interface RepositoryRouteStatusOptions {
  /** Return an empty string for a legacy checkout with nothing to warn about. */
  omitLegacy?: boolean;
}

/** True when `indexPath` is `storePath` or its structural-mode subdirectory. */
function isIndexPathInStore(indexPath: string, storePath: string): boolean {
  const canonicalIndexPath = canonicalize(indexPath);
  return canonicalIndexPath === canonicalize(storePath)
    || canonicalIndexPath === canonicalize(path.join(storePath, "structural"));
}

/**
 * Status lines for the repository route of a checkout. `indexPath` is the
 * store the running indexer inspected; the label is derived from that path,
 * so a config reload during the request cannot pair it with another scope.
 * Store routing never depends on settings, so a routed checkout whose
 * indexer does not use the repository store is running in global scope.
 */
export function formatRepositoryRouteStatus(
  projectRoot: string,
  host: HostMode,
  indexPath: string,
  options: RepositoryRouteStatusOptions = {},
): string {
  let route: RepositoryRoute;
  try {
    route = resolveRepositoryRoute(projectRoot, host);
  } catch (error: unknown) {
    return `Repository route error: ${getErrorMessage(error)}`;
  }

  const routedStore = route.config !== null && route.indexPath !== null
    && isIndexPathInStore(indexPath, route.indexPath);
  const globalStore = !routedStore && isIndexPathInStore(indexPath, resolveGlobalIndexPath(host));

  const lines: string[] = [];
  const warnings: string[] = [];
  if (routedStore) {
    const source = route.storeSource === "repository config"
      ? `repository config ${route.configPath ?? ""}`
      : "repository default store";
    lines.push(`Store: ${indexPath} (${source})`);
    lines.push(`Checkout role: ${route.role} - ${route.roleReason}`);
    warnings.push(...route.warnings);
  } else if (globalStore || route.config !== null) {
    lines.push(`Store: ${indexPath} (global scope)`);
  } else {
    lines.push(`Store: ${indexPath} (host default)`);
    warnings.push(...route.warnings);
  }

  const drift = describeRouteDrift(route);
  if (drift) warnings.push(drift);
  if (options.omitLegacy && route.config === null && warnings.length === 0) {
    return "";
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}
