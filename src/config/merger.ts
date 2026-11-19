import { existsSync, readFileSync } from "fs";
import * as path from "path";

import { resolveGlobalConfigPath, resolveProjectConfigPath } from "./paths.js";
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

function loadJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
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
export function loadMergedConfig(projectRoot: string, host: HostMode): unknown {
  const route = resolveMatchedRepositoryRoute(projectRoot, host);
  if (route) {
    return loadRepositoryMergedConfig(projectRoot, host, route);
  }

  const globalConfigPath = resolveGlobalConfigPath(host);
  const projectConfigPath = resolveProjectConfigPath(projectRoot, host);
  let globalConfig: Record<string, unknown> | null = null;
  let globalConfigError: Error | null = null;

  try {
    globalConfig = loadJsonFile(globalConfigPath) as Record<string, unknown> | null;
  } catch (error: unknown) {
    globalConfigError = error instanceof Error ? error : new Error(String(error));
  }

  const projectConfig = loadJsonFile(projectConfigPath) as Record<string, unknown> | null;
  const normalizedProjectConfig = loadProjectConfigLayer(projectRoot, host);

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
function loadRepositoryMergedConfig(projectRoot: string, host: HostMode, route: RepositoryRoute): Record<string, unknown> {
  const globalLayer = (loadJsonFile(resolveGlobalConfigPath(host)) as Record<string, unknown> | null) ?? {};

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

  const projectLayer = loadProjectConfigLayer(projectRoot, host);
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
