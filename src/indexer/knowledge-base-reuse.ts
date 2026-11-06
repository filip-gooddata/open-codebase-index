import { existsSync, readFileSync } from "fs";

export const KNOWLEDGE_BASE_REUSE_CACHE_FILE = "knowledge-base-files.json";
const KNOWLEDGE_BASE_REUSE_CACHE_VERSION = 1;

export interface KnowledgeBaseReuseEntry {
  hash: string;
  fingerprint: string;
  rootSignature: string;
  chunkIds: string[];
  symbolIds: string[];
}

export type KnowledgeBaseReuseCache = Map<string, KnowledgeBaseReuseEntry>;

export interface KnowledgeBaseReuseCandidate {
  storedPath: string;
  hash: string;
  fingerprint: string;
}

export interface KnowledgeBaseRoots {
  rootByPath: ReadonlyMap<string, string>;
  filesByRoot: ReadonlyMap<string, readonly string[]>;
  signatures: ReadonlyMap<string, string>;
}

export interface KnowledgeBaseReuseStore {
  getReferencedChunkIds(chunkIds: string[]): string[];
  getReferencedSymbolIds(symbolIds: string[]): string[];
}

export interface KnowledgeBaseRecordStore {
  getChunksByFile(filePath: string): Array<{ chunkId: string }>;
  getSymbolsByFile(filePath: string): Array<{ id: string }>;
  getCallees(symbolId: string, branch: string): Array<{ toSymbolId?: string | null }>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseEntry(value: unknown): KnowledgeBaseReuseEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.hash !== "string"
    || typeof record.fingerprint !== "string"
    || typeof record.rootSignature !== "string"
    || !isStringArray(record.chunkIds)
    || !isStringArray(record.symbolIds)
  ) {
    return null;
  }
  return {
    hash: record.hash,
    fingerprint: record.fingerprint,
    rootSignature: record.rootSignature,
    chunkIds: record.chunkIds,
    symbolIds: record.symbolIds,
  };
}

export function loadKnowledgeBaseReuseCache(
  cachePath: string,
  onError: (error: unknown) => void,
): KnowledgeBaseReuseCache {
  const cache: KnowledgeBaseReuseCache = new Map();
  if (!existsSync(cachePath)) return cache;
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return cache;
    const document = parsed as Record<string, unknown>;
    if (document.version !== KNOWLEDGE_BASE_REUSE_CACHE_VERSION) return cache;
    const entries = document.entries;
    if (!entries || typeof entries !== "object") return cache;
    for (const [storedPath, value] of Object.entries(entries as Record<string, unknown>)) {
      const entry = parseEntry(value);
      if (entry) cache.set(storedPath, entry);
    }
  } catch (error: unknown) {
    onError(error);
    cache.clear();
  }
  return cache;
}

export function serializeKnowledgeBaseReuseCache(cache: KnowledgeBaseReuseCache): string {
  const entries: Record<string, KnowledgeBaseReuseEntry> = {};
  for (const storedPath of [...cache.keys()].sort()) {
    const entry = cache.get(storedPath);
    if (entry) entries[storedPath] = entry;
  }
  return JSON.stringify({ version: KNOWLEDGE_BASE_REUSE_CACHE_VERSION, entries });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Call resolution can link any two files of one knowledge base, so reuse is decided per
 * knowledge-base root: the signature covers every indexed path and content hash under it.
 */
export function computeKnowledgeBaseRoots(
  fileHashes: ReadonlyMap<string, string>,
  rootFor: (storedPath: string) => string | undefined,
  hashContent: (content: string) => string,
): KnowledgeBaseRoots {
  const rootByPath = new Map<string, string>();
  const filesByRoot = new Map<string, string[]>();
  for (const storedPath of fileHashes.keys()) {
    const root = rootFor(storedPath);
    if (root === undefined) continue;
    rootByPath.set(storedPath, root);
    const files = filesByRoot.get(root) ?? [];
    files.push(storedPath);
    filesByRoot.set(root, files);
  }
  const signatures = new Map<string, string>();
  for (const [root, files] of filesByRoot) {
    files.sort(compareStrings);
    signatures.set(root, hashContent(JSON.stringify([root, files.map((file) => [file, fileHashes.get(file)])])));
  }
  return { rootByPath, filesByRoot, signatures };
}

function rootSignatureFor(storedPath: string, roots: KnowledgeBaseRoots): string | undefined {
  const root = roots.rootByPath.get(storedPath);
  return root === undefined ? undefined : roots.signatures.get(root);
}

/**
 * Returns the cached entries that can stand in for parsing. A root is reused only as a
 * whole: every file under it must match its content hash, indexing fingerprint and root
 * signature, and every recorded chunk and symbol must still be referenced by some branch
 * catalog (so the rows and vectors still exist).
 */
export function selectReusableKnowledgeBaseFiles(options: {
  candidates: readonly KnowledgeBaseReuseCandidate[];
  cache: KnowledgeBaseReuseCache;
  database: KnowledgeBaseReuseStore;
  roots: KnowledgeBaseRoots;
  hasStoredChunks?: (chunkIds: string[]) => Set<string>;
}): Map<string, KnowledgeBaseReuseEntry> {
  const matched = new Map<string, KnowledgeBaseReuseEntry>();
  for (const candidate of options.candidates) {
    const entry = options.cache.get(candidate.storedPath);
    const rootSignature = rootSignatureFor(candidate.storedPath, options.roots);
    if (
      !entry
      || rootSignature === undefined
      || entry.hash !== candidate.hash
      || entry.fingerprint !== candidate.fingerprint
      || entry.rootSignature !== rootSignature
    ) {
      continue;
    }
    matched.set(candidate.storedPath, entry);
  }
  if (matched.size === 0) return matched;

  const chunkIds = [...new Set([...matched.values()].flatMap((entry) => entry.chunkIds))];
  const symbolIds = [...new Set([...matched.values()].flatMap((entry) => entry.symbolIds))];
  const referencedChunkIds = new Set(options.database.getReferencedChunkIds(chunkIds));
  const referencedSymbolIds = new Set(options.database.getReferencedSymbolIds(symbolIds));
  const storedChunkIds = options.hasStoredChunks?.(chunkIds);

  const reusable = new Map<string, KnowledgeBaseReuseEntry>();
  for (const files of options.roots.filesByRoot.values()) {
    const entries: Array<[string, KnowledgeBaseReuseEntry]> = [];
    for (const storedPath of files) {
      const entry = matched.get(storedPath);
      const intact = entry !== undefined
        && entry.chunkIds.every((chunkId) =>
          referencedChunkIds.has(chunkId) && (!storedChunkIds || storedChunkIds.has(chunkId))
        )
        && entry.symbolIds.every((symbolId) => referencedSymbolIds.has(symbolId));
      if (!intact) break;
      entries.push([storedPath, entry]);
    }
    if (entries.length !== files.length) continue;
    for (const [storedPath, entry] of entries) reusable.set(storedPath, entry);
  }
  return reusable;
}

/**
 * Builds the shared cache published after a successful commit. Reused entries carry
 * forward. A knowledge-base root that was not reused is recorded only when all of its
 * files committed cleanly, the caller accepts each file, and every resolved call edge
 * from its symbols stays inside the root.
 */
export function buildKnowledgeBaseReuseCache(options: {
  previous: KnowledgeBaseReuseCache;
  reused: ReadonlyMap<string, KnowledgeBaseReuseEntry>;
  indexed: readonly KnowledgeBaseReuseCandidate[];
  database: KnowledgeBaseRecordStore;
  branchKey: string;
  roots: KnowledgeBaseRoots;
  currentChunkIds: ReadonlySet<string>;
  committedChunkIds: ReadonlySet<string>;
  committedSymbolIds: ReadonlySet<string>;
  isRecordable?: (storedPath: string) => boolean;
}): KnowledgeBaseReuseCache {
  const next: KnowledgeBaseReuseCache = new Map(options.previous);
  for (const [storedPath, entry] of options.reused) next.set(storedPath, entry);

  const indexedByPath = new Map(options.indexed.map((candidate) => [candidate.storedPath, candidate]));
  for (const [root, files] of options.roots.filesByRoot) {
    if (files.every((storedPath) => options.reused.has(storedPath))) continue;
    for (const storedPath of files) next.delete(storedPath);
    const rootSignature = options.roots.signatures.get(root);
    if (rootSignature === undefined) continue;

    const recorded: Array<[string, KnowledgeBaseReuseEntry]> = [];
    for (const storedPath of files) {
      const candidate = indexedByPath.get(storedPath);
      if (!candidate || options.isRecordable?.(storedPath) === false) break;
      const chunkIds = options.database.getChunksByFile(storedPath)
        .map((chunk) => chunk.chunkId)
        .filter((chunkId) => options.currentChunkIds.has(chunkId));
      if (chunkIds.some((chunkId) => !options.committedChunkIds.has(chunkId))) break;
      const symbolIds = options.database.getSymbolsByFile(storedPath)
        .map((symbol) => symbol.id)
        .filter((symbolId) => options.committedSymbolIds.has(symbolId));
      recorded.push([storedPath, {
        hash: candidate.hash,
        fingerprint: candidate.fingerprint,
        rootSignature,
        chunkIds,
        symbolIds,
      }]);
    }
    if (recorded.length !== files.length) continue;

    const rootSymbolIds = new Set(recorded.flatMap(([, entry]) => entry.symbolIds));
    const selfContained = [...rootSymbolIds].every((symbolId) =>
      options.database.getCallees(symbolId, options.branchKey).every((edge) =>
        !edge.toSymbolId || rootSymbolIds.has(edge.toSymbolId)
      )
    );
    if (!selfContained) continue;
    for (const [storedPath, entry] of recorded) next.set(storedPath, entry);
  }
  return next;
}
