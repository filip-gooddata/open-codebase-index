import type { BranchCatalogRows, Database } from "../native/index.js";

import { existsSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";

import { hashContent } from "../native/index.js";

/** Version metadata a catalog keys as `${prefix}.${hash24(catalogKey)}` and a new branch seeds from its base. */
export const BRANCH_SEED_METADATA_PREFIXES = [
  "index.callGraphResolutionVersion",
  "index.localModuleResolutionConfigHash",
  "index.scipTypeScriptState",
  "index.parser.javascriptVersion",
  "index.parser.swiftVersion",
  "index.parser.metalVersion",
  "index.parser.markupVersion",
  "index.parser.kotlinVersion",
  "index.parser.rubyVersion",
  "index.symbolExtractorVersion",
] as const;

/** Every metadata prefix a catalog keys as `${prefix}.${hash24(catalogKey)}`. */
const BRANCH_CATALOG_METADATA_PREFIXES = ["index.branchCommit", ...BRANCH_SEED_METADATA_PREFIXES] as const;

/** Runtime sidecars a project-scope catalog keys as `${base}.${hash16(catalogKey)}${ext}`. */
const BRANCH_CATALOG_SIDECARS = ["file-hashes.json", "file-dependencies.json", "failed-batches.json"] as const;

export interface BranchPruneCatalog {
  key: string;
  rows: Omit<BranchCatalogRows, "branch">;
  sidecars: string[];
}

export interface BranchPruneRefusal {
  key: string;
  reason: string;
}

export interface BranchPruneTotals {
  branchChunks: number;
  branchSymbols: number;
  branchCallEdges: number;
  branchCallEdgesStale: number;
  metadata: number;
  sidecars: number;
}

export interface BranchPruneGc {
  symbols: number;
  callEdges: number;
  chunks: number;
  embeddings: number;
}

export interface BranchPruneResult {
  applied: boolean;
  indexPath: string;
  catalogCount: number;
  liveCatalogCount: number;
  catalogs: BranchPruneCatalog[];
  refused: BranchPruneRefusal[];
  removed: BranchPruneTotals | null;
  gc: BranchPruneGc | null;
  elapsedMs: number;
}

export interface BranchPrunePlanInput {
  database: Database;
  indexPath: string;
  /** Catalog keys of every checked-out worktree, already mapped through the store's scope. */
  liveKeys: ReadonlySet<string>;
  /** Explicit catalog keys; when absent, every listed non-live catalog the key filter accepts. */
  keys?: readonly string[];
  /** Global scope shares a store across projects: only this project's keys are candidates. */
  candidateKeyFilter: (key: string) => boolean;
  /** Project scope namespaces sidecars per catalog; global scope does not. */
  namespacedSidecars: boolean;
}

export interface BranchPrunePlan {
  catalogCount: number;
  liveCatalogCount: number;
  catalogs: BranchPruneCatalog[];
  refused: BranchPruneRefusal[];
  metadataKeys: string[];
}

function catalogMetadataKeys(key: string): string[] {
  const hash = hashContent(key).slice(0, 24);
  return BRANCH_CATALOG_METADATA_PREFIXES.map((prefix) => `${prefix}.${hash}`);
}

function catalogSidecarPaths(indexPath: string, key: string): string[] {
  const namespace = hashContent(key).slice(0, 16);
  return BRANCH_CATALOG_SIDECARS.map((fileName) => {
    const extension = path.extname(fileName);
    return path.join(indexPath, `${fileName.slice(0, -extension.length)}.${namespace}${extension}`);
  });
}

function isFile(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isFile();
}

export function planBranchPrune(input: BranchPrunePlanInput): BranchPrunePlan {
  const listed = input.database.getAllBranches();
  const refused: BranchPruneRefusal[] = [];
  let targets: string[];
  if (input.keys) {
    targets = [];
    for (const key of new Set(input.keys)) {
      if (input.liveKeys.has(key)) {
        refused.push({ key, reason: "catalog of a checked-out worktree" });
      } else if (key === "") {
        refused.push({ key, reason: "empty catalog key" });
      } else {
        targets.push(key);
      }
    }
  } else {
    targets = listed.filter((key) => !input.liveKeys.has(key) && input.candidateKeyFilter(key));
  }
  targets.sort();

  const rows = input.database.countBranchCatalogRows(targets);
  const catalogs = rows.map(({ branch, ...counts }) => ({
    key: branch,
    rows: counts,
    sidecars: input.namespacedSidecars ? catalogSidecarPaths(input.indexPath, branch).filter(isFile) : [],
  }));
  return {
    catalogCount: listed.length,
    liveCatalogCount: listed.filter((key) => input.liveKeys.has(key)).length,
    catalogs,
    refused,
    metadataKeys: targets.flatMap(catalogMetadataKeys),
  };
}

/** Remove the planned catalogs, then collect what no remaining catalog references. */
export function applyBranchPrune(
  database: Database,
  plan: BranchPrunePlan,
): { catalogs: BranchPruneCatalog[]; removed: BranchPruneTotals; gc: BranchPruneGc } {
  const pruned = database.deleteBranchCatalogs(plan.catalogs.map((catalog) => catalog.key), plan.metadataKeys);
  const removed: BranchPruneTotals = {
    branchChunks: 0,
    branchSymbols: 0,
    branchCallEdges: 0,
    branchCallEdgesStale: 0,
    metadata: pruned.metadata,
    sidecars: 0,
  };
  const catalogs = plan.catalogs.map((catalog, index) => {
    const { branchChunks, branchSymbols, branchCallEdges, branchCallEdgesStale } = pruned.branches[index];
    const counts = { branchChunks, branchSymbols, branchCallEdges, branchCallEdgesStale };
    removed.branchChunks += counts.branchChunks;
    removed.branchSymbols += counts.branchSymbols;
    removed.branchCallEdges += counts.branchCallEdges;
    removed.branchCallEdgesStale += counts.branchCallEdgesStale;
    const sidecars = catalog.sidecars.filter((sidecar) => {
      try {
        unlinkSync(sidecar);
        return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    removed.sidecars += sidecars.length;
    return { key: catalog.key, rows: counts, sidecars };
  });

  const gc: BranchPruneGc = {
    symbols: database.gcOrphanSymbols(),
    callEdges: database.gcOrphanCallEdges(),
    chunks: database.gcOrphanChunks(),
    embeddings: database.gcOrphanEmbeddings(),
  };
  return { catalogs, removed, gc };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatBranchPruneResult(result: BranchPruneResult): string {
  const lines: string[] = [];
  const verb = result.applied ? "Removed" : "Would remove";
  lines.push(`Index: ${result.indexPath}`);
  lines.push(`Catalogs: ${result.catalogCount} listed, ${result.liveCatalogCount} of checked-out worktrees`);
  for (const refusal of result.refused) {
    lines.push(`Refused ${refusal.key}: ${refusal.reason}`);
  }
  lines.push(`${verb} ${plural(result.catalogs.length, "catalog")}:`);
  for (const catalog of result.catalogs) {
    const { branchChunks, branchSymbols, branchCallEdges, branchCallEdgesStale } = catalog.rows;
    lines.push(
      `  ${catalog.key}  branch_chunks=${branchChunks} branch_symbols=${branchSymbols} `
      + `branch_call_edges=${branchCallEdges} branch_call_edges_stale=${branchCallEdgesStale} `
      + `sidecars=${catalog.sidecars.length}`,
    );
  }
  if (result.removed) {
    const removed = result.removed;
    lines.push(
      `Rows removed: branch_chunks=${removed.branchChunks} branch_symbols=${removed.branchSymbols} `
      + `branch_call_edges=${removed.branchCallEdges} branch_call_edges_stale=${removed.branchCallEdgesStale} `
      + `metadata=${removed.metadata} sidecars=${removed.sidecars}`,
    );
  }
  if (result.gc) {
    lines.push(
      `Orphans collected: symbols=${result.gc.symbols} call_edges=${result.gc.callEdges} `
      + `chunks=${result.gc.chunks} embeddings=${result.gc.embeddings}`,
    );
  }
  if (!result.applied && result.catalogs.length > 0) lines.push("Dry run. Re-run with --apply to remove them.");
  lines.push(`Elapsed: ${result.elapsedMs} ms`);
  return lines.join("\n");
}
