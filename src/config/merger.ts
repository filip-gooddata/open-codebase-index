import { existsSync, readFileSync } from "fs";
import * as path from "path";

import {
  getGlobalConfigPath,
  getProjectConfigCandidatePaths,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from "./paths.js";
import type { HostMode } from "./host.js";
import { validateConfigLayerShape } from "./layer-shape.js";
import { resolveInheritedKnowledgeBaseEntries } from "./rebase.js";
import { resolveMatchedRepositoryRoute, type RepositoryRoute } from "./repository-route.js";

const PROJECT_OVERRIDE_KEYS = [
  "embeddingProvider",
  "customProvider",
  "embeddingFallback",
  "embeddingModel",
  "reranker",
  "include",
  "exclude",
  "indexing",
  "search",
  "debug",
  "effectivenessMetrics",
  "mcp",
  "scope",
] as const;

const MERGE_ARRAY_KEYS = ["knowledgeBases", "additionalInclude"] as const;

// Sections merged key by key across repository layers. Other sections,
// including customProvider, reranker and embeddingFallback, are atomic.
const REPOSITORY_RECURSIVE_KEYS = ["indexing", "search", "debug", "mcp", "effectivenessMetrics"] as const;

type ProjectOverrideKey = (typeof PROJECT_OVERRIDE_KEYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyProjectOverride(
  merged: Record<string, unknown>,
  normalizedProjectConfig: Record<string, unknown>,
  globalConfig: Record<string, unknown>,
  key: ProjectOverrideKey,
): void {
  if (key in normalizedProjectConfig) {
    merged[key] = normalizedProjectConfig[key];
    return;
  }

  if (key in globalConfig) {
    merged[key] = globalConfig[key];
  }
}

/** A project indexing section that omits allowForceRebuild must not re-enable a global refusal. */
function preserveGlobalForceRebuildRefusal(
  merged: Record<string, unknown>,
  globalConfig: Record<string, unknown>,
): void {
  const globalIndexing = globalConfig.indexing;
  const mergedIndexing = merged.indexing;
  if (!isRecord(globalIndexing) || globalIndexing.allowForceRebuild !== false) return;
  if (!isRecord(mergedIndexing) || "allowForceRebuild" in mergedIndexing) return;
  merged.indexing = { ...mergedIndexing, allowForceRebuild: false };
}

function mergeUniqueStringArray(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()))];
}

function normalizeKnowledgeBasePath(value: unknown): string {
  let normalized = path.normalize(String(value).trim());
  const root = path.parse(normalized).root;

  while (normalized.length > root.length && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function mergeKnowledgeBasePaths(values: unknown[]): string[] {
  return [...new Set(values.map((value) => normalizeKnowledgeBasePath(value)).filter((value) => value.length > 0))];
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

interface ConfigLayer {
  path: string;
  config: Record<string, unknown> | null;
}

/**
 * Path resolution treats any existsSync failure as absence. Strict loads read the same candidates
 * directly, in the same order, and fall through only when a candidate is missing, so a config that
 * cannot be read is an error rather than an absent layer.
 */
function readStrictConfigLayer(candidates: string[]): ConfigLayer {
  for (const candidate of candidates) {
    let content: string;
    try {
      content = readFileSync(candidate, "utf-8");
    } catch (error: unknown) {
      if (isMissingPathError(error)) continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read config file ${candidate}: ${message}`, { cause: error });
    }
    return { path: candidate, config: parseJsonConfig(content, candidate) as Record<string, unknown> };
  }
  return { path: candidates[0], config: null };
}

function getGlobalConfigCandidatePaths(host: HostMode): string[] {
  return host === "opencode"
    ? [getGlobalConfigPath(host)]
    : [getGlobalConfigPath(host), getGlobalConfigPath("opencode")];
}

function loadJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return null;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config file ${filePath}: ${message}`, { cause: error });
  }
  return parseJsonConfig(content, filePath);
}

function parseJsonConfig(content: string, filePath: string): unknown {
  try {
    return validateConfigLayerShape(JSON.parse(content), filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Config file ")) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config file ${filePath}: ${message}`, { cause: error });
  }
}

export function loadConfigFile(filePath: string): unknown {
  return loadJsonFile(filePath);
}

export function loadProjectConfigLayer(projectRoot: string, host: HostMode): Record<string, unknown> {
  const projectConfigPath = resolveProjectConfigPath(projectRoot, host);
  const projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;
  return normalizeProjectConfigLayer(projectConfig, projectConfigPath, projectRoot);
}

function normalizeProjectConfigLayer(
  projectConfig: Record<string, unknown> | null,
  projectConfigPath: string,
  projectRoot: string,
): Record<string, unknown> {
  if (!projectConfig) {
    return {};
  }

  const normalizedConfig: Record<string, unknown> = { ...projectConfig };
  const projectConfigBaseDir = path.dirname(path.dirname(projectConfigPath));

  if (Array.isArray(normalizedConfig.knowledgeBases)) {
    normalizedConfig.knowledgeBases = resolveInheritedKnowledgeBaseEntries(
      normalizedConfig.knowledgeBases,
      projectConfigBaseDir,
      projectRoot,
    );
  }

  return normalizedConfig;
}

/**
 * Loads and merges global and project configs.
 * 
 * Merge rules:
 * - Global config is the base
 * - For most fields: project overrides global if set, otherwise load global (fallback)
 * - For knowledgeBases: merge arrays (union, deduplicated)
 * - For additionalInclude: merge arrays (union, deduplicated)
 * - For include/exclude: project overrides global if set, otherwise load global
 */
export interface LoadMergedConfigOptions {
  /**
   * Throw on an unreadable global config instead of falling back to the project config alone, and
   * on any config candidate that cannot be inspected instead of treating it as absent.
   */
  strict?: boolean;
}

export function loadMergedConfig(projectRoot: string, host: HostMode, options: LoadMergedConfigOptions = {}): unknown {
  const route = resolveMatchedRepositoryRoute(projectRoot, host);
  if (route) {
    return loadRepositoryMergedConfig(projectRoot, host, route, options);
  }

  let globalConfig: Record<string, unknown> | null = null;
  let globalConfigError: Error | null = null;

  let projectConfig: Record<string, unknown> | null;
  let normalizedProjectConfig: Record<string, unknown>;
  if (options.strict === true) {
    globalConfig = readStrictConfigLayer(getGlobalConfigCandidatePaths(host)).config;
    const projectLayer = readStrictConfigLayer(getProjectConfigCandidatePaths(projectRoot, host));
    projectConfig = projectLayer.config;
    normalizedProjectConfig = normalizeProjectConfigLayer(projectConfig, projectLayer.path, projectRoot);
  } else {
    const globalConfigPath = resolveGlobalConfigPath(host);
    const projectConfigPath = resolveProjectConfigPath(projectRoot, host);
    try {
      globalConfig = loadJsonFile(globalConfigPath) as Record<string, unknown> | null;
    } catch (error: unknown) {
      globalConfigError = error instanceof Error ? error : new Error(String(error));
    }

    projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;
    normalizedProjectConfig = loadProjectConfigLayer(projectRoot, host);
  }

  if (globalConfigError) {
    if (!projectConfig) {
      throw globalConfigError;
    }
    globalConfig = null;
  }

  if (!globalConfig && !projectConfig) {
    return {};
  }

  if (!projectConfig && globalConfig) {
    return globalConfig;
  }

  if (!globalConfig && projectConfig) {
    return normalizedProjectConfig;
  }

  if (!globalConfig || !projectConfig) {
    return globalConfig ?? normalizedProjectConfig;
  }


  const merged: Record<string, unknown> = { ...globalConfig };

  for (const key of PROJECT_OVERRIDE_KEYS) {
    applyProjectOverride(merged, normalizedProjectConfig, globalConfig, key);
  }
  preserveGlobalForceRebuildRefusal(merged, globalConfig);

  // For other config sections: project overrides if set, otherwise use global
  if (projectConfig) {
    for (const key of Object.keys(projectConfig)) {
      if (
        PROJECT_OVERRIDE_KEYS.includes(key as ProjectOverrideKey) ||
        MERGE_ARRAY_KEYS.includes(key as (typeof MERGE_ARRAY_KEYS)[number])
      ) {
        continue; // Already handled above
      }
      merged[key] = normalizedProjectConfig[key];
    }
  }

  // For knowledgeBases: merge arrays (union, deduplicated)
  const globalKbs = globalConfig && Array.isArray(globalConfig.knowledgeBases) ? globalConfig.knowledgeBases : [];
  const projectKbs = projectConfig
    ? (Array.isArray(normalizedProjectConfig.knowledgeBases) ? normalizedProjectConfig.knowledgeBases as string[] : [])
    : [];
  const allKbs = [...globalKbs, ...projectKbs];
  merged.knowledgeBases = mergeKnowledgeBasePaths(allKbs);

  // For additionalInclude: merge arrays (union, deduplicated)
  const globalAdditional = globalConfig && Array.isArray(globalConfig.additionalInclude) ? globalConfig.additionalInclude : [];
  const projectAdditional = projectConfig && Array.isArray(projectConfig.additionalInclude) ? projectConfig.additionalInclude : [];
  const allAdditional = [...globalAdditional, ...projectAdditional];
  merged.additionalInclude = mergeUniqueStringArray(allAdditional);

  return merged;
}

function mergeRecords(base: Record<string, unknown>, layer: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeRecords(current, value) : value;
  }
  return merged;
}

function applyRepositoryLayer(merged: Record<string, unknown>, layer: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(layer)) {
    if (MERGE_ARRAY_KEYS.includes(key as (typeof MERGE_ARRAY_KEYS)[number])) {
      continue;
    }
    const current = merged[key];
    merged[key] = REPOSITORY_RECURSIVE_KEYS.includes(key as (typeof REPOSITORY_RECURSIVE_KEYS)[number])
      && isRecord(current) && isRecord(value)
      ? mergeRecords(current, value)
      : value;
  }
}

function getRoleOverrideLayer(route: RepositoryRoute): Record<string, unknown> {
  const checkouts = route.config && isRecord(route.config.checkouts) ? route.config.checkouts : {};
  const roleConfig = route.role ? checkouts[route.role] : undefined;
  if (!isRecord(roleConfig)) {
    return {};
  }

  const indexing: Record<string, unknown> = {};
  for (const flag of ["watchFiles", "autoIndexOnStartup"] as const) {
    if (typeof roleConfig[flag] === "boolean") {
      indexing[flag] = roleConfig[flag];
    }
  }
  return Object.keys(indexing).length > 0 ? { indexing } : {};
}

/**
 * Merge for a checkout whose repository has a repository config:
 * global < repository config (minus storage/checkouts) < role overrides < the
 * checkout's own project config. Recursive sections merge key by key;
 * knowledgeBases and additionalInclude are unions.
 */
function loadRepositoryMergedConfig(
  projectRoot: string,
  host: HostMode,
  route: RepositoryRoute,
  options: LoadMergedConfigOptions,
): Record<string, unknown> {
  const strict = options.strict === true;
  const globalLayer = (strict
    ? readStrictConfigLayer(getGlobalConfigCandidatePaths(host)).config
    : (loadJsonFile(resolveGlobalConfigPath(host)) as Record<string, unknown> | null)) ?? {};

  const repositoryLayer: Record<string, unknown> = {
    ...validateConfigLayerShape(route.config ?? {}, route.configPath ?? ""),
  };
  delete repositoryLayer.storage;
  delete repositoryLayer.checkouts;
  if (Array.isArray(repositoryLayer.knowledgeBases)) {
    repositoryLayer.knowledgeBases = (repositoryLayer.knowledgeBases as string[]).map((entry) =>
      path.isAbsolute(entry) || entry.startsWith("~") ? entry : path.resolve(projectRoot, entry),
    );
  }

  let projectLayer: Record<string, unknown>;
  if (strict) {
    const strictProjectLayer = readStrictConfigLayer(getProjectConfigCandidatePaths(projectRoot, host));
    projectLayer = normalizeProjectConfigLayer(strictProjectLayer.config, strictProjectLayer.path, projectRoot);
  } else {
    projectLayer = loadProjectConfigLayer(projectRoot, host);
  }
  const layers = [globalLayer, repositoryLayer, getRoleOverrideLayer(route), projectLayer];

  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    applyRepositoryLayer(merged, layer);
  }

  merged.knowledgeBases = mergeKnowledgeBasePaths(
    layers.flatMap((layer) => (Array.isArray(layer.knowledgeBases) ? layer.knowledgeBases : [])),
  );
  merged.additionalInclude = mergeUniqueStringArray(
    layers.flatMap((layer) => (Array.isArray(layer.additionalInclude) ? layer.additionalInclude : [])),
  );
  return merged;
}
