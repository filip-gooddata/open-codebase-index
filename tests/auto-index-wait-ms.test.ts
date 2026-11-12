import type { Indexer } from "../src/indexer/index.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_AUTO_INDEX_WAIT_MS, parseConfig } from "../src/config/schema.js";
import { waitForPublishedSnapshot } from "../src/utils/auto-index.js";

function waitMsFor(value: unknown): number {
  return parseConfig({ indexing: { autoIndexWaitMs: value } }).indexing.autoIndexWaitMs;
}

describe("indexing.autoIndexWaitMs clamp", () => {
  it("defaults to 10 seconds when unset", () => {
    expect(parseConfig({}).indexing.autoIndexWaitMs).toBe(10_000);
    expect(parseConfig({ indexing: {} }).indexing.autoIndexWaitMs).toBe(10_000);
  });

  it("preserves values above 60 seconds", () => {
    expect(waitMsFor(60_001)).toBe(60_001);
    expect(waitMsFor(360_000)).toBe(360_000);
    expect(waitMsFor(MAX_AUTO_INDEX_WAIT_MS)).toBe(600_000);
  });

  it("clamps values above 10 minutes to 600000", () => {
    expect(waitMsFor(600_001)).toBe(600_000);
    expect(waitMsFor(3_600_000)).toBe(600_000);
    expect(waitMsFor(Number.POSITIVE_INFINITY)).toBe(600_000);
  });

  it("keeps the existing handling of negative, fractional, and non-numeric values", () => {
    expect(waitMsFor(-5)).toBe(0);
    expect(waitMsFor(0)).toBe(0);
    expect(waitMsFor(1500.9)).toBe(1500);
    expect(waitMsFor("360000")).toBe(10_000);
    expect(waitMsFor(null)).toBe(10_000);
  });
});

describe("waitForPublishedSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function coordinatorPublishingAt(publishAt: number): {
    coordinator: { getIndexer: () => Indexer };
    getStatus: ReturnType<typeof vi.fn>;
  } {
    const getStatus = vi.fn(async () => ({ indexed: Date.now() >= publishAt }));
    const indexer = { getStatus } as unknown as Indexer;
    return { coordinator: { getIndexer: () => indexer }, getStatus };
  }

  it("keeps waiting past 60 seconds for another session to publish and reports progress", async () => {
    const startedAt = Date.now();
    const { coordinator } = coordinatorPublishingAt(startedAt + 90_000);
    const reportProgress = vi.fn<(progress: number) => Promise<void>>(async () => undefined);
    let settledAt: number | undefined;

    const wait = waitForPublishedSnapshot(coordinator, 360_000, { reportProgress }).then(() => {
      settledAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    await wait;

    expect(settledAt).toBeDefined();
    expect((settledAt ?? 0) - startedAt).toBeGreaterThanOrEqual(90_000);
    expect((settledAt ?? 0) - startedAt).toBeLessThan(91_000);
    const reported = reportProgress.mock.calls.map(([progress]) => progress);
    expect(reported.length).toBeGreaterThan(0);
    expect(Math.max(...reported)).toBeGreaterThanOrEqual(Math.floor((90_000 / 360_000) * 99) - 1);
    expect(Math.max(...reported)).toBeLessThan(100);
    for (let index = 1; index < reported.length; index += 1) {
      expect(reported[index]).toBeGreaterThanOrEqual(reported[index - 1]);
    }
  });

  it("gives up at the configured wait rather than at 60 seconds", async () => {
    const startedAt = Date.now();
    const { coordinator } = coordinatorPublishingAt(Number.POSITIVE_INFINITY);
    let settledAt: number | undefined;

    const wait = waitForPublishedSnapshot(coordinator, 120_000).then(() => {
      settledAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(60_500);
    expect(settledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    await wait;

    expect((settledAt ?? 0) - startedAt).toBeGreaterThanOrEqual(120_000);
    expect((settledAt ?? 0) - startedAt).toBeLessThan(120_500);
  });

  it("returns without polling when the wait is zero", async () => {
    const { coordinator, getStatus } = coordinatorPublishingAt(Number.POSITIVE_INFINITY);
    await waitForPublishedSnapshot(coordinator, 0);
    expect(getStatus).not.toHaveBeenCalled();
  });
});
