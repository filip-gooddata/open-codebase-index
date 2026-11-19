import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostMode } from "../src/config/host.js";
import type { CodebaseIndexExtensionAPI } from "../src/adapters/shared/extension-core.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import codebaseIndexPiExtension from "../src/adapters/pi/extension.js";
import codebaseIndexOmpExtension from "../src/adapters/omp/extension.js";
import { index_codebase } from "../src/adapters/opencode/tools.js";
import { resolveGlobalConfigPath, resolveWritableProjectConfigPath } from "../src/config/paths.js";
import { parseConfig } from "../src/config/schema.js";
import { executeIndexCodebase } from "../src/tools/execute-common.js";
import { getIndexerForProject, initializeTools } from "../src/tools/operation-runtime.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";

type NativeTool = Parameters<CodebaseIndexExtensionAPI["registerTool"]>[0];
type Progress = Record<string, unknown>;

function nativeIndexTool(host: "Pi" | "omp"): NativeTool {
  const tools = new Map<string, NativeTool>();
  const api = {
    registerTool(tool: NativeTool) { tools.set(tool.name, tool); },
    on() {},
  };
  if (host === "Pi") codebaseIndexPiExtension(api as Parameters<typeof codebaseIndexPiExtension>[0]);
  else codebaseIndexOmpExtension(api as Parameters<typeof codebaseIndexOmpExtension>[0]);
  return tools.get("index_codebase")!;
}

function progressDetails(details: unknown): Progress {
  if (!details || typeof details !== "object") throw new Error("Index update is missing progress details");
  return details as Progress;
}

describe("adapter indexing cancellation and progress", () => {
  it.each(["Pi", "omp", "OpenCode"] as const)("%s stops real indexing and permits a successful retry", async (host) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-index-control-"));
    const hostMode: HostMode = host === "OpenCode" ? "opencode" : "pi";
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(root, `worker-${i}.ts`), `export function worker${i}() { return ${i}; }\n`);
    }
    const config = parseConfig({
      indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
      include: ["**/*.ts"],
      exclude: [],
      search: { minScore: 0 },
    });
    initializeTools(root, config, hostMode);
    const indexer = getIndexerForProject(root, hostMode);
    const nativeTool = host === "OpenCode" ? undefined : nativeIndexTool(host);
    const run = (signal: AbortSignal, update: (progress: Progress) => void) => {
      if (nativeTool) {
        return nativeTool.execute("index-control", {}, signal, (result) => update(progressDetails(result.details)),
          { cwd: root } as ExtensionContext);
      }
      return index_codebase.execute({}, {
        worktree: root,
        abort: signal,
        metadata: (result: { metadata?: Record<string, unknown> }) => update(progressDetails(result.metadata)),
      } as Parameters<typeof index_codebase.execute>[1]);
    };
    try {
      const controller = new AbortController();
      const interruptedPhases: unknown[] = [];
      await expect(run(controller.signal, (progress) => {
        interruptedPhases.push(progress.phase);
        if (progress.phase === "parsing") controller.abort();
      })).rejects.toBeInstanceOf(OperationCancelledError);
      expect(controller.signal.aborted).toBe(true);
      expect(interruptedPhases).not.toContain("complete");

      const updates: Progress[] = [];
      await run(new AbortController().signal, (progress) => { updates.push(progress); });
      expect(updates.some((progress) => progress.phase === "parsing" && progress.totalFiles === 40)).toBe(true);
      expect(updates.at(-1)).toMatchObject({ phase: "complete", percentage: 100, filesProcessed: 40, totalFiles: 40 });
      const results = await indexer.search("worker39", 1, { definitionIntent: true, metadataOnly: true });
      expect(results[0]).toMatchObject({ name: "worker39", filePath: path.join(root, "worker-39.ts") });
    } finally {
      await indexer.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["Pi", "omp", "OpenCode"] as const)("%s refuses force when indexing.allowForceRebuild is false", async (host) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-force-refusal-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-force-refusal-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const hostMode: HostMode = host === "OpenCode" ? "opencode" : "pi";
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(root, `kept-${i}.ts`), `export function kept${i}() { return ${i}; }\n`);
    }
    const baseIndexing = { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false } as const;
    const configFor = (allowForceRebuild: boolean) => parseConfig({
      indexing: { ...baseIndexing, allowForceRebuild },
      include: ["**/*.ts"],
      exclude: [],
      search: { minScore: 0 },
    });
    initializeTools(root, configFor(false), hostMode);
    const indexer = getIndexerForProject(root, hostMode);
    const nativeTool = host === "OpenCode" ? undefined : nativeIndexTool(host);
    const run = async (force: boolean): Promise<string> => {
      if (nativeTool) {
        const result = await nativeTool.execute("force-refusal", { force }, new AbortController().signal, () => {},
          { cwd: root } as ExtensionContext);
        return result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
      }
      return index_codebase.execute({ force }, {
        worktree: root,
        abort: new AbortController().signal,
        metadata: () => {},
      } as Parameters<typeof index_codebase.execute>[1]);
    };
    try {
      await run(false);
      const before = await indexer.getStatus();
      expect(before.indexed).toBe(true);

      const refused = await run(true);
      expect(refused).toContain("FORCE_REBUILD_DISABLED: forced rebuild refused");
      expect(refused).toContain("ocbi index --force --allow-shared-rebuild");
      const results = await indexer.search("kept2", 1, { definitionIntent: true, metadataOnly: true });
      expect(results[0]).toMatchObject({ name: "kept2" });

      const overridden = await executeIndexCodebase(root, hostMode, { force: true }, undefined, undefined, {
        allowForceRebuildOverride: true,
      });
      expect(overridden.isError).not.toBe(true);
      expect(overridden.text).not.toContain("FORCE_REBUILD_DISABLED");

      initializeTools(root, configFor(true), hostMode);
      const allowed = await run(true);
      expect(allowed).not.toContain("FORCE_REBUILD_DISABLED");

      const projectConfigPath = resolveWritableProjectConfigPath(root, hostMode);
      fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
      fs.writeFileSync(projectConfigPath, JSON.stringify({ indexing: { allowForceRebuild: false } }));
      const refusedFromDisk = await run(true);
      expect(refusedFromDisk).toContain("FORCE_REBUILD_DISABLED: forced rebuild refused");
      expect(refusedFromDisk).toContain(`--host ${hostMode} --project`);

      fs.writeFileSync(projectConfigPath, JSON.stringify({ indexing: { watchFiles: false } }));
      const globalConfigPath = resolveGlobalConfigPath(hostMode);
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, "{ not json");
      const unreadableGlobal = await run(true).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      expect(unreadableGlobal).toContain("Cannot confirm indexing.allowForceRebuild before a forced rebuild");
      const afterUnreadable = await indexer.search("kept2", 1, { definitionIntent: true, metadataOnly: true });
      expect(afterUnreadable[0]).toMatchObject({ name: "kept2" });
    } finally {
      await getIndexerForProject(root, hostMode).close();
      await indexer.close();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
