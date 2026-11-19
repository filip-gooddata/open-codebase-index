function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Checks the shape of one config layer (global, repository, or project file)
 * and throws a "Config file <path> ..." error naming the first bad field.
 */
export function validateConfigLayerShape(rawConfig: unknown, filePath: string): Record<string, unknown> {
  if (!isRecord(rawConfig)) {
    throw new Error(`Config file ${filePath} must contain a JSON object at the root.`);
  }

  if (rawConfig.embeddingFallback !== undefined && rawConfig.embeddingFallback !== false && !isRecord(rawConfig.embeddingFallback)) {
    throw new Error(`Config file ${filePath} field 'embeddingFallback' must be an object or false.`);
  }

  if (rawConfig.knowledgeBases !== undefined && !isStringArray(rawConfig.knowledgeBases)) {
    throw new Error(`Config file ${filePath} field 'knowledgeBases' must be an array of strings.`);
  }
  if (rawConfig.additionalInclude !== undefined && !isStringArray(rawConfig.additionalInclude)) {
    throw new Error(`Config file ${filePath} field 'additionalInclude' must be an array of strings.`);
  }
  if (rawConfig.include !== undefined && !isStringArray(rawConfig.include)) {
    throw new Error(`Config file ${filePath} field 'include' must be an array of strings.`);
  }
  if (rawConfig.exclude !== undefined && !isStringArray(rawConfig.exclude)) {
    throw new Error(`Config file ${filePath} field 'exclude' must be an array of strings.`);
  }

  for (const section of ["customProvider", "indexing", "search", "debug", "effectivenessMetrics", "reranker", "mcp"] as const) {
    const value = rawConfig[section];
    if (value !== undefined && !isRecord(value)) {
      throw new Error(`Config file ${filePath} field '${section}' must be an object.`);
    }
  }

  return rawConfig;
}
