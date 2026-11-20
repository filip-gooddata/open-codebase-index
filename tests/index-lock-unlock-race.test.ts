import * as actualFs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameHook = vi.hoisted(() => ({ before: null as ((from: string) => void) | null }));

vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    renameSync: (from: actualFs.PathLike, to: actualFs.PathLike): void => {
      renameHook.before?.(String(from));
      original.renameSync(from, to);
    },
  };
});

const { breakIndexLock } = await import("../src/indexer/index-lock.js");
const { setLockHostIdentitySourcesForTesting } = await import("../src/indexer/lock-host-identity.js");

describe("manual unlock against a concurrently replaced lock", () => {
  let tempDir: string;
  let indexPath: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = actualFs.realpathSync(actualFs.mkdtempSync(path.join(os.tmpdir(), "index-unlock-race-")));
    indexPath = path.join(tempDir, "index");
    lockPath = path.join(indexPath, "indexing.lock");
    actualFs.mkdirSync(indexPath, { recursive: true });
    setLockHostIdentitySourcesForTesting({ platform: "linux", hostname: () => "current-host" });
  });

  afterEach(() => {
    renameHook.before = null;
    setLockHostIdentitySourcesForTesting(null);
    actualFs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("puts back a live lock that replaced the checked unreadable one before the rename", () => {
    actualFs.mkdirSync(lockPath);
    actualFs.writeFileSync(path.join(lockPath, "owner.json"), "{");
    const liveOwner = JSON.stringify({
      pid: process.pid,
      hostname: "current-host",
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "77777777-7777-4777-8777-777777777777",
    });
    renameHook.before = (from) => {
      if (from !== lockPath) return;
      renameHook.before = null;
      actualFs.rmSync(lockPath, { recursive: true, force: true });
      actualFs.mkdirSync(lockPath);
      actualFs.writeFileSync(path.join(lockPath, "owner.json"), liveOwner);
    };

    const result = breakIndexLock(indexPath, { force: true });

    expect(result.status).toBe("refused-changed");
    expect(actualFs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")).toBe(liveOwner);
    expect(actualFs.existsSync(path.join(lockPath, "reclaiming"))).toBe(false);
  });
});
