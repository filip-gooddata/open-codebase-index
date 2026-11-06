import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import type { Database } from "../src/native/index.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import {
  buildKnowledgeBaseReuseCache,
  computeKnowledgeBaseRoots,
  selectReusableKnowledgeBaseFiles,
} from "../src/indexer/knowledge-base-reuse.js";

const nativeSpies = vi.hoisted(() => ({
  parsedPaths: [] as string[],
  extractedContents: [] as string[],
  failParsePaths: new Set<string>(),
}));

vi.mock("../src/native/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/native/index.js")>();
  return {
    ...actual,
    parseFiles: (...args: Parameters<typeof actual.parseFiles>) => {
      for (const file of args[0]) nativeSpies.parsedPaths.push(file.path);
      return actual.parseFiles(...args).map((parsed) =>
        nativeSpies.failParsePaths.has(parsed.path) ? { ...parsed, chunks: [], symbols: [], parseFailed: true } : parsed
      );
    },
    extractCalls: (...args: Parameters<typeof actual.extractCalls>) => {
      nativeSpies.extractedContents.push(args[0]);
      return actual.extractCalls(...args);
    },
  };
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const KB_MARKER = "kbReuseMarker";

describe("knowledge-base reuse across branches", () => {
  let tempDir: string;
  let repo: string;
  let knowledgeBase: string;
  let canonicalKnowledgeBase: string;
  let config: ParsedCodebaseIndexConfig;
  let indexer: Indexer | null = null;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-reuse-test-"));
    repo = path.join(tempDir, "repo");
    knowledgeBase = path.join(tempDir, "sdk");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(knowledgeBase);
    canonicalKnowledgeBase = fs.realpathSync.native(knowledgeBase);
    fs.writeFileSync(path.join(knowledgeBase, "client.ts"), [
      `// ${KB_MARKER} client`,
      "import { formatPayload } from \"./format\";",
      "export function sendRequest(input: string): string {",
      "  const payload = formatPayload(input);",
      "  return normalizePayload(payload);",
      "}",
      "function normalizePayload(payload: string): string {",
      "  return payload.trim();",
      "}",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(knowledgeBase, "format.ts"), [
      `// ${KB_MARKER} format`,
      "export function formatPayload(input: string): string {",
      "  return `payload:${input}`;",
      "}",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(repo, "src", "app.ts"), [
      "import { sendRequest } from \"../../sdk/client\";",
      "export function runApp(): string {",
      "  return sendRequest(\"main\");",
      "}",
      "",
    ].join("\n"));
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["add", "."]);
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
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
      indexing: { watchFiles: false, autoGc: false },
      knowledgeBases: [knowledgeBase],
    });
  });

  afterEach(async () => {
    await indexer?.close();
    indexer = null;
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function indexCurrentBranch(): Promise<Database> {
    await indexer?.close();
    nativeSpies.parsedPaths.length = 0;
    nativeSpies.extractedContents.length = 0;
    nativeSpies.failParsePaths.clear();
    indexer = new Indexer(repo, config, "opencode");
    await indexer.index();
    await indexer.getStatus();
    return (indexer as unknown as { database: Database }).database;
  }

  function knowledgeBaseParses(): string[] {
    return nativeSpies.parsedPaths.filter((filePath) => filePath.startsWith(canonicalKnowledgeBase));
  }

  function knowledgeBaseCallExtractions(): number {
    return nativeSpies.extractedContents.filter((content) => content.includes(KB_MARKER)).length;
  }

  async function knowledgeBaseSearch(): Promise<string[]> {
    const results = await (indexer as Indexer).search("format payload request", 20);
    return results
      .filter((result) => result.filePath.startsWith(canonicalKnowledgeBase))
      .map((result) => `${result.filePath}:${result.startLine}-${result.endLine}:${result.name ?? ""}`)
      .sort();
  }

  function knowledgeBaseGraph(db: Database, branch: string): string[] {
    const symbols = db.getSymbolsForBranch(branch).filter((symbol) => symbol.filePath.startsWith(canonicalKnowledgeBase));
    return symbols.flatMap((symbol) =>
      db.getCallees(symbol.id, branch).map((edge) => `${symbol.name}->${edge.targetName}:${edge.toSymbolId ?? "unresolved"}`)
    ).sort();
  }

  function projectToKnowledgeBaseEdge(db: Database, branch: string): string | undefined {
    const runApp = db.getSymbolsForBranch(branch).find((symbol) => symbol.name === "runApp");
    if (!runApp) return undefined;
    const edge = db.getCallees(runApp.id, branch).find((callee) => callee.targetName === "sendRequest");
    return edge ? `${edge.targetName}:${edge.toSymbolId ?? "unresolved"}` : undefined;
  }

  it("reuses unchanged knowledge-base files on a new branch without reparsing them", async () => {
    const mainDb = await indexCurrentBranch();
    expect(knowledgeBaseParses().length).toBeGreaterThan(0);
    expect(knowledgeBaseCallExtractions()).toBeGreaterThan(0);
    const mainSearch = await knowledgeBaseSearch();
    const mainGraph = knowledgeBaseGraph(mainDb, "main");
    const mainKbSymbolIds = mainDb.getSymbolsForBranch("main")
      .filter((symbol) => symbol.filePath.startsWith(canonicalKnowledgeBase))
      .map((symbol) => symbol.id)
      .sort();
    expect(mainSearch.length).toBeGreaterThan(0);
    expect(mainGraph).toContainEqual(expect.stringMatching(/^sendRequest->normalizePayload:(?!unresolved)/));
    const mainProjectEdge = projectToKnowledgeBaseEdge(mainDb, "main");

    git(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "src", "extra.ts"), "export function featureOnly(): number { return 7; }\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feature"]);

    const featureDb = await indexCurrentBranch();
    expect(knowledgeBaseParses()).toEqual([]);
    expect(knowledgeBaseCallExtractions()).toBe(0);
    expect(nativeSpies.parsedPaths.some((filePath) => filePath.endsWith("extra.ts"))).toBe(true);
    expect(await knowledgeBaseSearch()).toEqual(mainSearch);
    expect(knowledgeBaseGraph(featureDb, "feature")).toEqual(mainGraph);
    expect(featureDb.getSymbolsForBranch("feature")
      .filter((symbol) => symbol.filePath.startsWith(canonicalKnowledgeBase))
      .map((symbol) => symbol.id)
      .sort()).toEqual(mainKbSymbolIds);
    expect(mainProjectEdge).toBe("sendRequest:unresolved");
    expect(projectToKnowledgeBaseEdge(featureDb, "feature")).toBe(mainProjectEdge);
    expect(knowledgeBaseGraph(featureDb, "main")).toEqual(mainGraph);
  });

  it("keeps a resolved cross-file knowledge-base edge identical with and without reuse", async () => {
    fs.writeFileSync(path.join(knowledgeBase, "greet.go"), [
      `// ${KB_MARKER} greet`,
      "package sdk",
      "",
      "func Greet() string {",
      "\treturn helper()",
      "}",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(knowledgeBase, "helper.go"), [
      `// ${KB_MARKER} helper`,
      "package sdk",
      "",
      "func helper() string {",
      "\treturn \"hello\"",
      "}",
      "",
    ].join("\n"));
    const goEdge = (db: Database, branch: string): { from?: string; to?: string; target?: string } => {
      const symbols = db.getSymbolsForBranch(branch);
      const greet = symbols.find((symbol) => symbol.name === "Greet");
      const helper = symbols.find((symbol) => symbol.name === "helper");
      const edge = greet ? db.getCallees(greet.id, branch).find((callee) => callee.targetName === "helper") : undefined;
      return { from: greet?.filePath, to: edge?.toSymbolId, target: helper ? `${helper.filePath}:${helper.id}` : undefined };
    };

    const mainDb = await indexCurrentBranch();
    expect(new Set(knowledgeBaseParses()).size).toBe(4);
    const mainGraph = knowledgeBaseGraph(mainDb, "main");
    const mainEdge = goEdge(mainDb, "main");
    const helperSymbol = mainDb.getSymbolsForBranch("main").find((symbol) => symbol.name === "helper");
    expect(mainEdge.from).toBe(path.join(canonicalKnowledgeBase, "greet.go"));
    expect(helperSymbol?.filePath).toBe(path.join(canonicalKnowledgeBase, "helper.go"));
    expect(mainEdge.to).toBe(helperSymbol?.id);
    expect(mainGraph).toContain(`Greet->helper:${helperSymbol?.id}`);
    expect(projectToKnowledgeBaseEdge(mainDb, "main")).toBe("sendRequest:unresolved");

    git(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "src", "app.ts"), [
      "import { sendRequest } from \"../../sdk/client\";",
      "export function runApp(): string {",
      "  return sendRequest(\"feature\");",
      "}",
      "",
    ].join("\n"));
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feature"]);
    const featureDb = await indexCurrentBranch();
    expect(knowledgeBaseParses()).toEqual([]);
    expect(knowledgeBaseCallExtractions()).toBe(0);
    expect(nativeSpies.parsedPaths.some((filePath) => filePath.endsWith(path.join("src", "app.ts")))).toBe(true);
    expect(goEdge(featureDb, "feature")).toEqual(mainEdge);
    expect(knowledgeBaseGraph(featureDb, "feature")).toEqual(mainGraph);
    expect(projectToKnowledgeBaseEdge(featureDb, "feature")).toBe("sendRequest:unresolved");

    const cachePath = path.join(repo, ".opencode", "index", "knowledge-base-files.json");
    fs.rmSync(cachePath);
    git(repo, ["checkout", "-b", "without-reuse"]);
    const freshDb = await indexCurrentBranch();
    expect(new Set(knowledgeBaseParses()).size).toBe(4);
    expect(goEdge(freshDb, "without-reuse")).toEqual(mainEdge);
    expect(knowledgeBaseGraph(freshDb, "without-reuse")).toEqual(mainGraph);
    expect(projectToKnowledgeBaseEdge(freshDb, "without-reuse")).toBe("sendRequest:unresolved");
  });

  it("reprocesses the whole knowledge-base root when one of its files changes", async () => {
    await indexCurrentBranch();
    git(repo, ["checkout", "-b", "feature"]);
    fs.appendFileSync(path.join(knowledgeBase, "format.ts"), "export function extraFormat(): string { return \"x\"; }\n");

    const featureDb = await indexCurrentBranch();
    expect(knowledgeBaseParses().sort()).toEqual([
      path.join(canonicalKnowledgeBase, "client.ts"),
      path.join(canonicalKnowledgeBase, "format.ts"),
    ]);
    expect(featureDb.getSymbolsForBranch("feature").map((symbol) => symbol.name)).toContain("extraFormat");
    expect(knowledgeBaseGraph(featureDb, "feature"))
      .toContainEqual(expect.stringMatching(/^sendRequest->normalizePayload:(?!unresolved)/));

    git(repo, ["checkout", "-b", "second-feature"]);
    await indexCurrentBranch();
    expect(knowledgeBaseParses()).toEqual([]);
  });

  it("reprocesses knowledge-base files when the reuse cache is missing", async () => {
    await indexCurrentBranch();
    const cachePath = path.join(repo, ".opencode", "index", "knowledge-base-files.json");
    expect(fs.existsSync(cachePath)).toBe(true);
    fs.rmSync(cachePath);
    git(repo, ["checkout", "-b", "feature"]);

    await indexCurrentBranch();
    expect(knowledgeBaseParses().length).toBe(2);
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it("does not record a root with a failed embedding and reprocesses it on the next branch", async () => {
    config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-model",
        dimensions: 8,
        maxBatchSize: 1,
        requestIntervalMs: 0,
      },
      indexing: { watchFiles: false, autoGc: false },
      knowledgeBases: [knowledgeBase],
    });
    const respond = fetchSpy.getMockImplementation();
    fetchSpy.mockImplementation(async (url, init?) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      if ((body.input ?? []).some((text) => text.includes("formatPayload(input"))) {
        return new Response("unavailable", { status: 400 });
      }
      return respond ? respond(url, init) : new Response("{}", { status: 500 });
    });
    await indexCurrentBranch();
    const cachePath = path.join(repo, ".opencode", "index", "knowledge-base-files.json");
    expect(JSON.parse(fs.readFileSync(cachePath, "utf-8"))).toEqual({ version: 1, entries: {} });
    fetchSpy.mockImplementation(async (url, init?) =>
      respond ? respond(url, init) : new Response("{}", { status: 500 })
    );
    git(repo, ["checkout", "-b", "feature"]);

    await indexCurrentBranch();
    expect(knowledgeBaseParses().sort()).toEqual([
      path.join(canonicalKnowledgeBase, "client.ts"),
      path.join(canonicalKnowledgeBase, "format.ts"),
    ]);
  });

  it("reuses a root that contains an empty knowledge-base file", async () => {
    fs.writeFileSync(path.join(knowledgeBase, "empty.ts"), "\n");
    await indexCurrentBranch();
    expect(knowledgeBaseParses()).toContain(path.join(canonicalKnowledgeBase, "empty.ts"));
    git(repo, ["checkout", "-b", "feature"]);

    await indexCurrentBranch();
    expect(knowledgeBaseParses()).toEqual([]);
  });

  it("does not record a root whose file failed to parse and retries it on the next branch", async () => {
    const failedPath = path.join(canonicalKnowledgeBase, "format.ts");
    const indexWithFailure = async (): Promise<void> => {
      await indexer?.close();
      nativeSpies.parsedPaths.length = 0;
      nativeSpies.extractedContents.length = 0;
      nativeSpies.failParsePaths.clear();
      nativeSpies.failParsePaths.add(failedPath);
      indexer = new Indexer(repo, config, "opencode");
      await indexer.index();
    };
    await indexWithFailure();
    expect(knowledgeBaseParses()).toContain(failedPath);
    git(repo, ["checkout", "-b", "feature"]);

    const featureDb = await indexCurrentBranch();
    expect(knowledgeBaseParses().sort()).toEqual([
      path.join(canonicalKnowledgeBase, "client.ts"),
      failedPath,
    ]);
    expect(featureDb.getSymbolsForBranch("feature").map((symbol) => symbol.name)).toContain("formatPayload");

    git(repo, ["checkout", "-b", "second-feature"]);
    await indexCurrentBranch();
    expect(knowledgeBaseParses()).toEqual([]);
  });
});

describe("knowledge-base reuse helpers", () => {
  const hashContent = (content: string): string => `h${content.length}:${content}`;
  const rootFor = (storedPath: string): string | undefined => storedPath.startsWith("/kb/") ? "/kb" : undefined;

  it("refuses a root whose resolved call edges leave it", () => {
    const roots = computeKnowledgeBaseRoots(new Map([["/kb/a.ts", "1"], ["/kb/b.ts", "2"], ["src/x.ts", "3"]]), rootFor, hashContent);
    const database = {
      getChunksByFile: (filePath: string) => [{ chunkId: `chunk:${filePath}` }],
      getSymbolsByFile: (filePath: string) => [{ id: `symbol:${filePath}` }],
      getCallees: (symbolId: string) => symbolId === "symbol:/kb/a.ts" ? [{ toSymbolId: "symbol:src/x.ts" }] : [],
    };
    const options = {
      previous: new Map(),
      reused: new Map(),
      indexed: [
        { storedPath: "/kb/a.ts", hash: "1", fingerprint: "f" },
        { storedPath: "/kb/b.ts", hash: "2", fingerprint: "f" },
      ],
      database,
      branchKey: "main",
      roots,
      currentChunkIds: new Set(["chunk:/kb/a.ts", "chunk:/kb/b.ts"]),
      committedChunkIds: new Set(["chunk:/kb/a.ts", "chunk:/kb/b.ts"]),
      committedSymbolIds: new Set(["symbol:/kb/a.ts", "symbol:/kb/b.ts"]),
    };
    expect(buildKnowledgeBaseReuseCache(options).size).toBe(0);

    const selfContained = buildKnowledgeBaseReuseCache({ ...options, database: { ...database, getCallees: () => [] } });
    expect([...selfContained.keys()].sort()).toEqual(["/kb/a.ts", "/kb/b.ts"]);
    expect(buildKnowledgeBaseReuseCache({
      ...options,
      database: { ...database, getCallees: () => [] },
      isRecordable: (storedPath) => storedPath !== "/kb/b.ts",
    }).size).toBe(0);
    expect(buildKnowledgeBaseReuseCache({
      ...options,
      database: { ...database, getCallees: () => [] },
      committedChunkIds: new Set(["chunk:/kb/a.ts"]),
    }).size).toBe(0);
  });

  it("reuses a root only when every file matches and its rows are still referenced", () => {
    const fileHashes = new Map([["/kb/a.ts", "1"], ["/kb/b.ts", "2"]]);
    const roots = computeKnowledgeBaseRoots(fileHashes, rootFor, hashContent);
    const rootSignature = roots.signatures.get("/kb") ?? "";
    const cache = new Map([
      ["/kb/a.ts", { hash: "1", fingerprint: "f", rootSignature, chunkIds: ["ca"], symbolIds: ["sa"] }],
      ["/kb/b.ts", { hash: "2", fingerprint: "f", rootSignature, chunkIds: ["cb"], symbolIds: ["sb"] }],
    ]);
    const candidates = [
      { storedPath: "/kb/a.ts", hash: "1", fingerprint: "f" },
      { storedPath: "/kb/b.ts", hash: "2", fingerprint: "f" },
    ];
    const allReferenced = {
      getReferencedChunkIds: (ids: string[]) => ids,
      getReferencedSymbolIds: (ids: string[]) => ids,
    };
    expect(selectReusableKnowledgeBaseFiles({ candidates, cache, database: allReferenced, roots }).size).toBe(2);
    expect(selectReusableKnowledgeBaseFiles({
      candidates,
      cache,
      database: { ...allReferenced, getReferencedChunkIds: (ids: string[]) => ids.filter((id) => id !== "cb") },
      roots,
    }).size).toBe(0);
    expect(selectReusableKnowledgeBaseFiles({
      candidates: [candidates[0], { ...candidates[1], fingerprint: "other" }],
      cache,
      database: allReferenced,
      roots,
    }).size).toBe(0);
    expect(selectReusableKnowledgeBaseFiles({
      candidates,
      cache,
      database: allReferenced,
      roots: computeKnowledgeBaseRoots(new Map([...fileHashes, ["/kb/c.ts", "3"]]), rootFor, hashContent),
    }).size).toBe(0);
    expect(selectReusableKnowledgeBaseFiles({
      candidates,
      cache,
      database: allReferenced,
      roots,
      hasStoredChunks: (ids) => new Set(ids.filter((id) => id !== "ca")),
    }).size).toBe(0);
  });
});
