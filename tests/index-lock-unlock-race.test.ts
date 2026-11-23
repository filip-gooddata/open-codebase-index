import * as actualFs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameHook = vi.hoisted(() => ({
  before: null as ((from: string) => void) | null,
  afterRead: null as ((filePath: string) => void) | null,
}));

vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    readFileSync: ((...args: Parameters<typeof original.readFileSync>) => {
      const result = original.readFileSync(...args);
      renameHook.afterRead?.(String(args[0]));
      return result;
    }) as typeof original.readFileSync,
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
    setLockHostIdentitySourcesForTesting({
      platform: "linux",
      hostname: () => "current-host",
      statfsType: () => 0xef53,
    });
  });

  afterEach(() => {
    renameHook.before = null;
    renameHook.afterRead = null;
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

  it("judges and compares the same bytes when a live owner replaces an unreadable lock after inspection", () => {
    const ownerPath = path.join(lockPath, "owner.json");
    actualFs.mkdirSync(lockPath);
    actualFs.writeFileSync(ownerPath, "{");
    const liveOwner = JSON.stringify({
      pid: process.pid,
      hostname: "current-host",
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "12121212-1212-4121-8121-121212121212",
    });
    renameHook.afterRead = (filePath) => {
      if (filePath !== ownerPath) return;
      renameHook.afterRead = null;
      actualFs.writeFileSync(ownerPath, liveOwner);
    };

    const result = breakIndexLock(indexPath, { force: true });

    expect(result.status).toBe("refused-changed");
    expect(actualFs.readFileSync(ownerPath, "utf-8")).toBe(liveOwner);
  });

  it("leaves a live unlock guard in place when it replaced a stale one before the takeover rename", () => {
    const guardPath = path.join(indexPath, "indexing.lock.unlock");
    actualFs.mkdirSync(lockPath);
    actualFs.writeFileSync(path.join(lockPath, "owner.json"), "{");
    const staleGuard = JSON.stringify({
      pid: 2_147_483_000,
      hostname: "current-host",
      startedAt: new Date().toISOString(),
      operation: "recovery",
      token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const liveGuard = JSON.stringify({
      pid: process.pid,
      hostname: "current-host",
      startedAt: new Date().toISOString(),
      operation: "recovery",
      token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    actualFs.mkdirSync(guardPath);
    actualFs.writeFileSync(path.join(guardPath, "owner.json"), staleGuard);
    renameHook.before = (from) => {
      if (from !== guardPath) return;
      renameHook.before = null;
      actualFs.rmSync(guardPath, { recursive: true, force: true });
      actualFs.mkdirSync(guardPath);
      actualFs.writeFileSync(path.join(guardPath, "owner.json"), liveGuard);
    };

    const result = breakIndexLock(indexPath, { force: true });

    expect(result.status).toBe("refused-busy");
    expect(actualFs.readFileSync(path.join(guardPath, "owner.json"), "utf-8")).toBe(liveGuard);
    expect(actualFs.existsSync(path.join(lockPath, "owner.json"))).toBe(true);
  });
});
