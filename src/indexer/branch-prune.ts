import type { BranchCatalogRows, Database } from "../native/index.js";

import { readdirSync, statSync, unlinkSync } from "node:fs";
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

/** A catalog's sidecars and the temp files an interrupted atomic publish of one left behind. */
function catalogSidecarPaths(indexPath: string, entries: readonly string[], key: string): string[] {
  const namespace = hashContent(key).slice(0, 16);
  const names = BRANCH_CATALOG_SIDECARS.map((fileName) => {
    const extension = path.extname(fileName);
    return `${fileName.slice(0, -extension.length)}.${namespace}${extension}`;
  });
  return entries
    .filter((entry) => names.some((name) => entry === name || (entry.startsWith(`.${name}.`) && entry.endsWith(".tmp"))))
    .map((entry) => path.join(indexPath, entry))
    .filter((filePath) => statSync(filePath, { throwIfNoEntry: false })?.isFile() === true);
}

export function planBranchPrune(input: BranchPrunePlanInput): BranchPrunePlan {
  const listed = [...new Set([...input.database.getAllBranches(), ...input.database.getCallEdgeOverlayBranches()])];
  const refused: BranchPruneRefusal[] = [];
  let targets: string[];
  if (input.keys) {
    targets = [];
    for (const key of new Set(input.keys)) {
      if (input.liveKeys.has(key)) {
        refused.push({ key, reason: "catalog of a checked-out worktree" });
      } else if (key === "") {
        refused.push({ key, reason: "empty catalog key" });
      } else if (!input.candidateKeyFilter(key)) {
        refused.push({ key, reason: "catalog of another project in this global index" });
      } else {
        targets.push(key);
      }
    }
  } else {
    targets = listed.filter((key) => !input.liveKeys.has(key) && input.candidateKeyFilter(key));
  }
  targets.sort();

  const rows = input.database.countBranchCatalogRows(targets);
  // Unsuffixed sidecars belong to the default or shared catalog and never match a namespace.
  const entries = readdirSync(input.indexPath);
  const catalogs = rows.map(({ branch, ...counts }) => ({
    key: branch,
    rows: counts,
    sidecars: catalogSidecarPaths(input.indexPath, entries, branch),
  }));
  return {
    catalogCount: listed.length,
    liveCatalogCount: listed.filter((key) => input.liveKeys.has(key)).length,
    catalogs,
    refused,
    metadataKeys: targets.flatMap(catalogMetadataKeys),
  };
}

/** Drop catalogs whose worktree was checked out after the plan was made. */
export function withoutLiveCatalogs(plan: BranchPrunePlan, liveKeys: ReadonlySet<string>): BranchPrunePlan {
  const checkedOut = plan.catalogs.filter((catalog) => liveKeys.has(catalog.key));
  if (checkedOut.length === 0) return plan;
  const kept = plan.catalogs.filter((catalog) => !liveKeys.has(catalog.key));
  return {
    ...plan,
    catalogs: kept,
    refused: [...plan.refused, ...checkedOut.map(({ key }) => ({ key, reason: "checked out while pruning" }))],
    metadataKeys: kept.flatMap(({ key }) => catalogMetadataKeys(key)),
  };
}

export type BranchPruneApplyOutcome =
  | { applied: true; catalogs: BranchPruneCatalog[]; removed: BranchPruneTotals; gc: BranchPruneGc }
  | { applied: false; liveKeys: ReadonlySet<string> };

function unlinkExisting(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Delete the planned catalogs in one write transaction and commit only if
 * readLiveKeys, read after the deletes, still shows none of them checked out.
 * Sidecars go before the commit, so an interrupted run leaves the catalog's
 * rows for a retry to find. Orphans are collected after the commit.
 */
/**
 * Set in the catalog delete's transaction and cleared by the orphan collection, so a
 * recovered lease tells a prune that committed from one that died before its commit.
 */
export const BRANCH_PRUNE_ORPHAN_GC_PENDING_KEY = "prune.orphanGcPending";

export async function applyBranchPrune(
  database: Database,
  plan: BranchPrunePlan,
  readLiveKeys: () => Promise<ReadonlySet<string>>,
): Promise<BranchPruneApplyOutcome> {
  let catalogs: BranchPruneCatalog[];
  const removed: BranchPruneTotals = {
    branchChunks: 0,
    branchSymbols: 0,
    branchCallEdges: 0,
    branchCallEdgesStale: 0,
    metadata: 0,
    sidecars: 0,
  };
  database.beginWriteTransaction();
  let open = true;
  try {
    const pruned = database.deleteBranchCatalogs(plan.catalogs.map((catalog) => catalog.key), plan.metadataKeys);
    const liveKeys = await readLiveKeys();
    if (plan.catalogs.some((catalog) => liveKeys.has(catalog.key))) {
      open = false;
      database.rollbackWriteTransaction();
      return { applied: false, liveKeys };
    }
    database.setMetadata(BRANCH_PRUNE_ORPHAN_GC_PENDING_KEY, "1");
    removed.metadata = pruned.metadata;
    catalogs = plan.catalogs.map((catalog, index) => {
      const { branchChunks, branchSymbols, branchCallEdges, branchCallEdgesStale } = pruned.branches[index];
      removed.branchChunks += branchChunks;
      removed.branchSymbols += branchSymbols;
      removed.branchCallEdges += branchCallEdges;
      removed.branchCallEdgesStale += branchCallEdgesStale;
      const sidecars = catalog.sidecars.filter(unlinkExisting);
      removed.sidecars += sidecars.length;
      return { key: catalog.key, rows: { branchChunks, branchSymbols, branchCallEdges, branchCallEdgesStale }, sidecars };
    });
    open = false;
    database.commitWriteTransaction();
  } catch (error: unknown) {
    if (open) database.rollbackWriteTransaction();
    throw error;
  }

  return { applied: true, catalogs, removed, gc: collectBranchPruneOrphans(database) };
}

/** Collect the chunks, symbols, edges and embeddings no remaining catalog references. */
export function collectBranchPruneOrphans(database: Database): BranchPruneGc {
  const gc = {
    symbols: database.gcOrphanSymbols(),
    callEdges: database.gcOrphanCallEdges(),
    chunks: database.gcOrphanChunks(),
    embeddings: database.gcOrphanEmbeddings(),
  };
  database.deleteMetadata(BRANCH_PRUNE_ORPHAN_GC_PENDING_KEY);
  return gc;
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
  if (!result.applied && result.catalogs.length > 0) {
    lines.push(result.refused.length > 0
      ? "Nothing removed. Drop the refused keys and re-run."
      : "Dry run. Re-run with --apply to remove them.");
  }
  lines.push(`Elapsed: ${result.elapsedMs} ms`);
  return lines.join("\n");
}
