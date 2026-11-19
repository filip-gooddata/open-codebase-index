import { execFileSync } from "child_process";
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import type { IndexStats } from "../src/indexer/index.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, hashContent } from "../src/native/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function write(repo: string, relativePath: string, content: string): void {
  const filePath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const FILLER_FILE_COUNT = 24;

function writeMainTree(repo: string): void {
  write(repo, "src/math.ts", `export function add(left: number, right: number): number {
  return left + right;
}

export function mul(left: number, right: number): number {
  return left * right;
}
`);
  write(repo, "src/barrel.ts", `export { add } from "./math.js";\n`);
  write(repo, "src/use-add.ts", `import { add } from "./barrel.js";

export function useAdd(): number {
  return add(1, 2);
}
`);
  write(repo, "src/use-mul.ts", `import { mul } from "./math.js";

export function useMul(): number {
  return mul(2, 3);
}
`);
  write(repo, "src/gone.ts", `export function gone(): number {
  return 7;
}
`);
  write(repo, "src/use-gone.ts", `import { gone } from "./gone.js";

export function useGone(): number {
  return gone();
}
`);
  write(repo, "src/old-name.ts", `export function legacy(): number {
  return 9;
}
`);
  write(repo, "src/use-legacy.ts", `import { legacy } from "./old-name.js";

export function useLegacy(): number {
  return legacy();
}
`);
  write(repo, "src/thing/index.ts", `export function thing(): string {
  return "directory";
}
`);
  write(repo, "src/use-thing.ts", `import { thing } from "./thing";

export function useThing(): string {
  return thing();
}
`);
  write(repo, "pkg/__init__.py", "");
  write(repo, "pkg/helpers.py", `def helper():
    return 1
`);
  write(repo, "pkg/main.py", `from .helpers import helper


def run():
    return helper()
`);
  for (let index = 0; index < FILLER_FILE_COUNT; index += 1) {
    write(repo, `src/filler/filler-${index}.ts`, `function localStep${index}(value: number): number {
  return value + ${index};
}

export function filler${index}(): number {
  return localStep${index}(${index});
}
`);
  }
}

/**
 * Feature-branch edits that change what unchanged importers resolve to:
 * a moved export behind a barrel, a deleted module, a renamed module, a new
 * file that shadows a directory-index probe, and a moved Python definition.
 */
function applyFeatureEdits(repo: string): void {
  write(repo, "src/math.ts", `// Feature branch moves both exports down.

export function add(left: number, right: number): number {
  return left + right;
}

export function mul(left: number, right: number): number {
  return left * right;
}
`);
  fs.rmSync(path.join(repo, "src/gone.ts"));
  git(repo, ["mv", "src/old-name.ts", "src/new-name.ts"]);
  write(repo, "src/thing.ts", `export function thing(): string {
  return "file";
}
`);
  write(repo, "pkg/helpers.py", `# Feature branch moves helper down.


def helper():
    return 1
`);
}

interface GraphSnapshot {
  chunkIds: string[];
  symbolIds: string[];
  symbols: string[];
  edges: string[];
}

function graphSnapshot(database: Database, branch: string): GraphSnapshot {
  const symbols = database.getSymbolsForBranch(branch);
  const labels = new Map(symbols.map((symbol) => [
    symbol.id,
    `${symbol.filePath}#${symbol.name}:${symbol.kind}@${symbol.startLine}:${symbol.startCol}`,
  ]));
  const edges = symbols.flatMap((symbol) => database.getCallees(symbol.id, branch).map((edge) => {
    const target = edge.toSymbolId ? labels.get(edge.toSymbolId) ?? `foreign:${edge.toSymbolId}` : "unresolved";
    return `${labels.get(edge.fromSymbolId)} -> ${edge.targetName} => ${target} [${edge.callType}@${edge.line}:${edge.col}]`;
  }));
  return {
    chunkIds: [...database.getBranchChunkIds(branch)].sort(),
    symbolIds: [...database.getBranchSymbolIds(branch)].sort(),
    symbols: [...labels.values()].sort(),
    edges: edges.sort(),
  };
}

function calleeTarget(snapshot: GraphSnapshot, caller: string, targetName: string): string | undefined {
  const edge = snapshot.edges.find((candidate) => candidate.includes(`#${caller}:`) && candidate.includes(` -> ${targetName} => `));
  return edge?.split(" => ")[1]?.split(" [")[0];
}

function artifactPath(repo: string, fileName: string, branch: string): string {
  const extension = path.extname(fileName);
  return path.join(
    repo,
    ".opencode",
    "index",
    `${fileName.slice(0, fileName.length - extension.length)}.${hashContent(branch).slice(0, 16)}${extension}`,
  );
}

function branchMetadataKey(prefix: string, branch: string): string {
  return `${prefix}.${hashContent(branch).slice(0, 24)}`;
}

describe("new-branch index seeding", () => {
  let tempDir: string;
  let repo: string;
  let config: ParsedCodebaseIndexConfig;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const openIndexers: Indexer[] = [];

  beforeEach(() => {
    // Package-format lookups compare real paths, and macOS temp paths are symlinked.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "branch-seeding-test-")));
    repo = path.join(tempDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeMainTree(repo);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main"]);

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({
        data: texts.map((text, index) => ({
          embedding: Array.from({ length: 8 }, (_, dimension) =>
            ((text.length + index * 11 + dimension * 17) % 101) / 101),
        })),
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false, autoGc: false },
    });
  });

  afterEach(async () => {
    for (const indexer of openIndexers.splice(0)) await indexer.close();
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createIndexer(root: string, indexerConfig = config): Indexer {
    const indexer = new Indexer(root, indexerConfig, "opencode");
    openIndexers.push(indexer);
    return indexer;
  }

  async function databaseOf(indexer: Indexer): Promise<Database> {
    await indexer.getStatus();
    return (indexer as unknown as { database: Database }).database;
  }

  async function closeIndexer(indexer: Indexer): Promise<void> {
    openIndexers.splice(openIndexers.indexOf(indexer), 1);
    await indexer.close();
  }

  async function indexMain(): Promise<IndexStats> {
    const indexer = createIndexer(repo);
    const stats = await indexer.index();
    await closeIndexer(indexer);
    return stats;
  }

  function checkoutFeature(): void {
    git(repo, ["checkout", "-b", "feature"]);
    applyFeatureEdits(repo);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "feature"]);
    // Uncommitted working-tree edit on top of the branch commit.
    write(repo, "src/use-mul.ts", `import { mul } from "./math.js";

export function useMul(): number {
  return mul(4, 5);
}
`);
  }

  /** Copies the working tree and git state, without any index, and indexes it from scratch. */
  async function scratchSnapshot(branch: string): Promise<{ snapshot: GraphSnapshot; stats: IndexStats; indexer: Indexer }> {
    const scratch = path.join(tempDir, `scratch-${branch}`);
    fs.cpSync(repo, scratch, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".opencode",
    });
    const indexer = createIndexer(scratch);
    const stats = await indexer.index();
    return { snapshot: graphSnapshot(await databaseOf(indexer), branch), stats, indexer };
  }

  it("seeds a new branch from its indexed ancestor and matches a scratch build", async () => {
    const main = createIndexer(repo);
    const mainStats = await main.index();
    expect(mainStats.seededFrom).toBeUndefined();
    expect(mainStats.seedFallbackReason).toBe("no usable indexed ancestor");
    const mainSnapshot = graphSnapshot(await databaseOf(main), "main");
    expect(calleeTarget(mainSnapshot, "useThing", "thing")).toBe("src/thing/index.ts#thing:function_declaration@1:7");
    expect(calleeTarget(mainSnapshot, "useGone", "gone")).toBe("src/gone.ts#gone:function_declaration@1:7");
    expect(calleeTarget(mainSnapshot, "useLegacy", "legacy")).toBe("src/old-name.ts#legacy:function_declaration@1:7");
    await closeIndexer(main);

    checkoutFeature();
    const seeded = createIndexer(repo);
    const seededStats = await seeded.index();
    const seededSnapshot = graphSnapshot(await databaseOf(seeded), "feature");
    const scratch = await scratchSnapshot("feature");

    expect(seededStats.seededFrom).toBe("main");
    expect(seededStats.seedFallbackReason).toBeUndefined();
    expect(scratch.stats.seededFrom).toBeUndefined();
    expect(seededSnapshot).toEqual(scratch.snapshot);

    // The moved, deleted, renamed, and shadowed targets are re-resolved in unchanged importers.
    expect(calleeTarget(seededSnapshot, "useAdd", "add")).toBe("src/math.ts#add:function_declaration@3:7");
    expect(calleeTarget(seededSnapshot, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@7:7");
    expect(calleeTarget(seededSnapshot, "useGone", "gone")).not.toMatch(/^src\/gone\.ts#/u);
    expect(calleeTarget(seededSnapshot, "useLegacy", "legacy")).not.toMatch(/^src\/old-name\.ts#/u);
    // A new file shadowing the directory-index probe makes the old target stale.
    expect(calleeTarget(seededSnapshot, "useThing", "thing")).not.toBe("src/thing/index.ts#thing:function_declaration@1:7");
    expect(calleeTarget(seededSnapshot, "run", "helper")).toBe("pkg/helpers.py#helper:function_definition@4:0");
    expect(seededSnapshot.symbols.some((symbol) => symbol.startsWith("src/gone.ts#"))).toBe(false);
    expect(seededSnapshot.symbols.some((symbol) => symbol.startsWith("src/old-name.ts#"))).toBe(false);

    // Only the diff and its importers are reprocessed; filler files are reused.
    const totalFiles = scratch.stats.reprocessedFiles ?? 0;
    expect(totalFiles).toBeGreaterThanOrEqual(FILLER_FILE_COUNT);
    expect(seededStats.reprocessedFiles).toBeGreaterThan(0);
    expect(seededStats.reprocessedFiles).toBeLessThan(totalFiles - FILLER_FILE_COUNT + 1);
    expect(seededStats.callExtractionFiles ?? 0).toBeLessThanOrEqual(seededStats.reprocessedFiles ?? 0);
    expect(scratch.stats.callExtractionFiles ?? 0).toBeGreaterThan(seededStats.callExtractionFiles ?? 0);

    // The ancestor keeps its own symbol catalog.
    const mainAfter = graphSnapshot(await databaseOf(seeded), "main");
    expect(mainAfter.symbolIds).toEqual(mainSnapshot.symbolIds);
    expect(mainAfter.chunkIds).toEqual(mainSnapshot.chunkIds);
  });

  it("reports the same pr_impact for a seeded branch as for a scratch build", async () => {
    await indexMain();
    checkoutFeature();
    const seeded = createIndexer(repo);
    expect((await seeded.index()).seededFrom).toBe("main");
    const scratch = await scratchSnapshot("feature");

    const summarize = async (indexer: Indexer): Promise<unknown> => {
      const impact = await indexer.getPrImpact({ maxDepth: 3, direction: "both" });
      return {
        changedFiles: [...impact.changedFiles].sort(),
        direct: impact.directSymbols.map((symbol) => symbol.id).sort(),
        callers: impact.transitiveCallers.map((symbol) => symbol.id).sort(),
      };
    };
    const seededImpact = await summarize(seeded);
    expect(seededImpact).toEqual(await summarize(scratch.indexer));
    expect((seededImpact as { direct: string[] }).direct.length).toBeGreaterThan(0);
  });

  it("re-resolves unchanged importers on an incremental run without seeding", async () => {
    const indexer = createIndexer(repo);
    await indexer.index();
    applyFeatureEdits(repo);

    const stats = await indexer.index();
    const snapshot = graphSnapshot(await databaseOf(indexer), "main");
    const scratch = await scratchSnapshot("main");

    expect(stats.seededFrom).toBeUndefined();
    expect(snapshot).toEqual(scratch.snapshot);
    expect(calleeTarget(snapshot, "useAdd", "add")).toBe("src/math.ts#add:function_declaration@3:7");
    expect(calleeTarget(snapshot, "useThing", "thing")).not.toBe("src/thing/index.ts#thing:function_declaration@1:7");
    expect(stats.reprocessedFiles).toBeLessThan((scratch.stats.reprocessedFiles ?? 0) - FILLER_FILE_COUNT + 1);
  });

  it("falls back to the old family rule when the dependency graph does not match the hash cache", async () => {
    const indexer = createIndexer(repo);
    await indexer.index();
    const dependencyGraph = artifactPath(repo, "file-dependencies.json", "main");
    expect(fs.existsSync(dependencyGraph)).toBe(true);
    const graph = JSON.parse(fs.readFileSync(dependencyGraph, "utf-8")) as { hashCacheFingerprint: string };
    graph.hashCacheFingerprint = "stale";
    fs.writeFileSync(dependencyGraph, JSON.stringify(graph));
    applyFeatureEdits(repo);

    const stats = await indexer.index();
    const snapshot = graphSnapshot(await databaseOf(indexer), "main");
    const scratch = await scratchSnapshot("main");

    expect(snapshot).toEqual(scratch.snapshot);
    // Every JavaScript-family file is reprocessed again.
    expect(stats.reprocessedFiles).toBeGreaterThanOrEqual(FILLER_FILE_COUNT);
  });

  it("re-resolves CommonJS importers when only a nested package format changes", async () => {
    // Declared workspaces that do not cover cjs/ keep its manifest out of the
    // workspace configuration hash, so only the format record can catch the flip.
    write(repo, "package.json", JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }));
    write(repo, "cjs/package.json", JSON.stringify({ name: "nested-cjs", type: "commonjs" }));
    write(repo, "cjs/lib.js", `function helperCjs() {
  return 1;
}

module.exports = helperCjs;
`);
    write(repo, "cjs/use.js", `const helperCjs = require("./lib.js");

function useCjs() {
  return helperCjs();
}

module.exports = { useCjs };
`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "cjs"]);
    const main = createIndexer(repo);
    await main.index();
    const mainSnapshot = graphSnapshot(await databaseOf(main), "main");
    expect(calleeTarget(mainSnapshot, "useCjs", "helperCjs")).toMatch(/^cjs\/lib\.js#helperCjs:/u);
    await closeIndexer(main);

    git(repo, ["checkout", "-b", "feature"]);
    write(repo, "cjs/package.json", JSON.stringify({ name: "nested-cjs", type: "module" }));
    const seeded = createIndexer(repo);
    const seededStats = await seeded.index();
    const seededSnapshot = graphSnapshot(await databaseOf(seeded), "feature");
    const scratch = await scratchSnapshot("feature");

    expect(seededStats.seededFrom).toBe("main");
    expect(seededSnapshot).toEqual(scratch.snapshot);
    expect(calleeTarget(seededSnapshot, "useCjs", "helperCjs")).not.toMatch(/^cjs\/lib\.js#helperCjs:/u);
    expect(seededStats.reprocessedFiles).toBeLessThan((scratch.stats.reprocessedFiles ?? 0) - FILLER_FILE_COUNT + 1);

    write(repo, "cjs/package.json", JSON.stringify({ name: "nested-cjs", type: "commonjs" }));
    await seeded.index();
    expect(calleeTarget(graphSnapshot(await databaseOf(seeded), "feature"), "useCjs", "helperCjs"))
      .toMatch(/^cjs\/lib\.js#helperCjs:/u);
  });

  it.each([
    {
      name: "a stale call-graph resolution version",
      reason: "no usable indexed ancestor",
      prepare: async (database: Database): Promise<void> => {
        database.setMetadata(branchMetadataKey("index.callGraphResolutionVersion", "main"), "0");
      },
    },
    {
      name: "pending failed embedding batches",
      reason: "no usable indexed ancestor",
      prepare: async (): Promise<void> => {
        fs.writeFileSync(artifactPath(repo, "failed-batches.json", "main"), "[{\"pending\":true}]");
      },
    },
    {
      name: "a missing hash cache",
      reason: "no usable indexed ancestor",
      prepare: async (): Promise<void> => {
        fs.rmSync(artifactPath(repo, "file-hashes.json", "main"));
      },
    },
    {
      name: "a failing catalog copy",
      reason: "seed copy failed",
      prepare: async (): Promise<void> => {
        vi.spyOn(Database.prototype, "copyBranchCatalog").mockImplementation(() => {
          throw new Error("copy failed");
        });
      },
    },
  ])("builds from scratch when the ancestor has $name", async ({ reason, prepare }) => {
    const main = createIndexer(repo);
    await main.index();
    await prepare(await databaseOf(main));
    await closeIndexer(main);
    checkoutFeature();

    const indexer = createIndexer(repo);
    const stats = await indexer.index();
    const snapshot = graphSnapshot(await databaseOf(indexer), "feature");
    const scratch = await scratchSnapshot("feature");

    expect(stats.seededFrom).toBeUndefined();
    expect(stats.seedFallbackReason).toBe(reason);
    expect(snapshot).toEqual(scratch.snapshot);
  });

  it("does not seed in structural mode", async () => {
    await indexMain();
    checkoutFeature();
    const structural = parseConfig({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
      indexing: { watchFiles: false, autoGc: false, mode: "structural" },
    });

    const stats = await createIndexer(repo, structural).index();

    expect(stats.seededFrom).toBeUndefined();
    expect(stats.seedFallbackReason).toBe("structural mode");
  });

  it("does not seed a branch that already has an index", async () => {
    await indexMain();
    checkoutFeature();
    const indexer = createIndexer(repo);
    expect((await indexer.index()).seededFrom).toBe("main");

    const again = await indexer.index();

    expect(again.seededFrom).toBeUndefined();
    expect(again.seedFallbackReason).toBeUndefined();
  });

  /**
   * Indexes a sibling branch that shifts math.ts down one line. use-mul.ts is
   * identical on both branches, so its call-edge row is shared and the sibling
   * run points it at the sibling's mul symbol.
   */
  async function indexShiftedSibling(): Promise<void> {
    git(repo, ["checkout", "-b", "sibling"]);
    write(repo, "src/math.ts", `// shifted\n${fs.readFileSync(path.join(repo, "src/math.ts"), "utf8")}`);
    git(repo, ["commit", "-am", "sibling"]);
    const sibling = createIndexer(repo);
    expect((await sibling.index()).seededFrom).toBe("main");
    const siblingSnapshot = graphSnapshot(await databaseOf(sibling), "sibling");
    expect(calleeTarget(siblingSnapshot, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@6:7");
    await closeIndexer(sibling);
    git(repo, ["checkout", "main"]);
  }

  it("does not read a call target that a sibling branch wrote into a shared edge row", async () => {
    await indexMain();
    await indexShiftedSibling();

    git(repo, ["checkout", "-b", "feature"]);
    write(repo, "src/extra.ts", "export const extra = 1;\n");
    git(repo, ["add", "src/extra.ts"]);
    git(repo, ["commit", "-m", "feature"]);
    const seeded = createIndexer(repo);
    expect((await seeded.index()).seededFrom).toBe("main");
    const seededSnapshot = graphSnapshot(await databaseOf(seeded), "feature");
    const scratch = await scratchSnapshot("feature");

    expect(calleeTarget(scratch.snapshot, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@5:7");
    expect(calleeTarget(seededSnapshot, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@5:7");
    expect(seededSnapshot.edges).toEqual(scratch.snapshot.edges);
  });

  it("keeps each branch's call target when a sibling branch rewrites a shared edge row", async () => {
    await indexMain();
    await indexShiftedSibling();

    const reader = createIndexer(repo);
    const database = await databaseOf(reader);
    const mainBefore = graphSnapshot(database, "main");
    const siblingAfter = graphSnapshot(database, "sibling");
    await closeIndexer(reader);

    expect(calleeTarget(mainBefore, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@5:7");
    expect(calleeTarget(siblingAfter, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@6:7");
    expect(mainBefore.edges.some((edge) => edge.includes("foreign:"))).toBe(false);

    const indexer = createIndexer(repo);
    const stats = await indexer.index();
    const snapshot = graphSnapshot(await databaseOf(indexer), "main");
    const scratch = await scratchSnapshot("main");

    expect(stats.seededFrom).toBeUndefined();
    expect(stats.reprocessedFiles).toBe(0);
    expect(snapshot.edges).toEqual(mainBefore.edges);
    expect(snapshot.edges).toEqual(scratch.snapshot.edges);
  });

  it("isolates a legacy unscoped edge write from sibling branches and refreshes it on the next index", async () => {
    await indexMain();
    await indexShiftedSibling();

    const database = new Database(path.join(repo, ".opencode", "index", "codebase.db"));
    const mainBefore = graphSnapshot(database, "main");
    const siblingBefore = graphSnapshot(database, "sibling");
    const [useAdd] = database.getSymbolsByName("useAdd");
    const [useMul] = database.getSymbolsByName("useMul");
    const sharedEdge = database.getCallees(useMul.id, "main").find((edge) => edge.targetName === "mul");
    expect(database.getBranchSymbolIds("sibling")).toContain(useAdd.id);
    expect(sharedEdge).toBeDefined();
    if (!sharedEdge) return;
    const siblingMulId = database.getCallees(useMul.id, "sibling").find((edge) => edge.targetName === "mul")?.toSymbolId;

    // A 0.34.0 writer has no branch and rewrites the shared row to a symbol both branches contain.
    database.upsertCallEdge({ ...sharedEdge, toSymbolId: useAdd.id, isResolved: true });

    for (const [branch, before] of [["main", mainBefore], ["sibling", siblingBefore]] as const) {
      expect(graphSnapshot(database, branch).edges).toEqual(before.edges);
      expect(database.getCallers("mul", branch).map((edge) => edge.toSymbolId)).not.toContain(useAdd.id);
      expect(database.getStaleCallEdgeFilePaths(branch)).toEqual(["src/use-mul.ts"]);
    }
    expect(database.getCallers("mul", "sibling").find((edge) => edge.fromSymbolId === useMul.id)?.toSymbolId)
      .toBe(siblingMulId);
    database.close();

    const embeddingRequestsBefore = fetchSpy.mock.calls.length;
    const indexer = createIndexer(repo);
    const stats = await indexer.index();
    // Re-parsing the unchanged file reuses its chunks and requests no embeddings.
    expect(fetchSpy.mock.calls.length).toBe(embeddingRequestsBefore);
    expect(stats.reprocessedFiles).toBe(1);
    const refreshed = await databaseOf(indexer);
    const scratch = await scratchSnapshot("main");

    expect(calleeTarget(graphSnapshot(refreshed, "main"), "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@5:7");
    expect(graphSnapshot(refreshed, "main").edges).toEqual(scratch.snapshot.edges);
    expect(refreshed.getStaleCallEdgeFilePaths("main")).toEqual([]);
    expect(refreshed.getStaleCallEdgeFilePaths("sibling")).toEqual(["src/use-mul.ts"]);
    expect(graphSnapshot(refreshed, "sibling").edges).toEqual(siblingBefore.edges);
    await closeIndexer(indexer);

    const next = createIndexer(repo);
    expect((await next.index()).reprocessedFiles).toBe(0);
  });

  function unreachableBranchCallEdges(): number {
    const raw = new DatabaseSync(path.join(repo, ".opencode", "index", "codebase.db"), { readOnly: true });
    try {
      const row = raw.prepare(`
        SELECT count(*) AS n FROM branch_call_edges b
        WHERE NOT EXISTS (
          SELECT 1 FROM call_edges ce
          INNER JOIN branch_symbols bs ON bs.symbol_id = ce.from_symbol_id AND bs.branch = b.branch
          WHERE ce.id = b.edge_id
        )`).get() as { n: number };
      return row.n;
    } finally {
      raw.close();
    }
  }

  it("leaves no unreachable branch call-edge targets when a caller moves on one branch", async () => {
    await indexMain();
    await indexShiftedSibling();
    const reader = createIndexer(repo);
    const mainBefore = graphSnapshot(await databaseOf(reader), "main");
    await closeIndexer(reader);
    expect(unreachableBranchCallEdges()).toBe(0);

    git(repo, ["checkout", "sibling"]);
    write(repo, "src/use-mul.ts", `// moved\n${fs.readFileSync(path.join(repo, "src/use-mul.ts"), "utf8")}`);
    git(repo, ["commit", "-am", "move caller"]);
    const indexer = createIndexer(repo);
    expect((await indexer.index()).reprocessedFiles).toBeGreaterThan(0);
    const database = await databaseOf(indexer);
    expect(graphSnapshot(database, "main").edges).toEqual(mainBefore.edges);
    expect(graphSnapshot(database, "sibling").edges).toEqual((await scratchSnapshot("sibling")).snapshot.edges);
    await closeIndexer(indexer);
    expect(unreachableBranchCallEdges()).toBe(0);
  });

  it("re-resolves a shared edge target left by a writer without branch targets", async () => {
    await indexMain();
    await indexShiftedSibling();
    // A store last written without per-branch targets keeps only the sibling's shared target.
    const raw = new DatabaseSync(path.join(repo, ".opencode", "index", "codebase.db"));
    try {
      raw.exec("DELETE FROM branch_call_edges");
    } finally {
      raw.close();
    }

    const reader = createIndexer(repo);
    const legacy = graphSnapshot(await databaseOf(reader), "main");
    await closeIndexer(reader);
    expect(calleeTarget(legacy, "useMul", "mul")).toBe("unresolved");
    expect(legacy.edges.some((edge) => edge.includes("foreign:"))).toBe(false);

    const indexer = createIndexer(repo);
    const stats = await indexer.index();
    const snapshot = graphSnapshot(await databaseOf(indexer), "main");
    const scratch = await scratchSnapshot("main");

    expect(calleeTarget(snapshot, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@5:7");
    expect(snapshot.edges).toEqual(scratch.snapshot.edges);
    // Only the file whose shared target was foreign is reprocessed.
    expect(stats.reprocessedFiles).toBeGreaterThan(0);
    expect(stats.reprocessedFiles).toBeLessThan(FILLER_FILE_COUNT);
  });

  it("re-resolves shared edge rows once when the branch has no trusted call-edge record", async () => {
    await indexMain();
    await indexShiftedSibling();
    const dependencyGraph = artifactPath(repo, "file-dependencies.json", "main");
    const graph = JSON.parse(fs.readFileSync(dependencyGraph, "utf-8")) as Record<string, unknown>;
    delete graph.edgeFingerprints;
    graph.version = 2;
    fs.writeFileSync(dependencyGraph, JSON.stringify(graph));

    const indexer = createIndexer(repo);
    const stats = await indexer.index();
    const snapshot = graphSnapshot(await databaseOf(indexer), "main");
    await closeIndexer(indexer);
    const scratch = await scratchSnapshot("main");

    expect(stats.seededFrom).toBeUndefined();
    expect(calleeTarget(snapshot, "useMul", "mul")).toBe("src/math.ts#mul:function_declaration@5:7");
    expect(snapshot.edges).toEqual(scratch.snapshot.edges);

    const next = createIndexer(repo);
    const nextStats = await next.index();
    expect(nextStats.reprocessedFiles).toBe(0);
    expect(calleeTarget(graphSnapshot(await databaseOf(next), "main"), "useMul", "mul"))
      .toBe("src/math.ts#mul:function_declaration@5:7");
  });

  it("does not seed from an ancestor whose dependency graph has no call-edge record", async () => {
    await indexMain();
    const dependencyGraph = artifactPath(repo, "file-dependencies.json", "main");
    // The shape written before call-edge fingerprints were recorded.
    const graph = JSON.parse(fs.readFileSync(dependencyGraph, "utf-8")) as Record<string, unknown>;
    delete graph.edgeFingerprints;
    graph.version = 2;
    fs.writeFileSync(dependencyGraph, JSON.stringify(graph));
    checkoutFeature();

    const indexer = createIndexer(repo);
    const stats = await indexer.index();
    const snapshot = graphSnapshot(await databaseOf(indexer), "feature");
    const scratch = await scratchSnapshot("feature");

    expect(stats.seededFrom).toBeUndefined();
    expect(stats.seedFallbackReason).toBe("no usable indexed ancestor");
    expect(snapshot).toEqual(scratch.snapshot);
  });
});
