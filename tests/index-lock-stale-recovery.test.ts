import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCbiCli } from "../src/adapters/cbi.js";
import {
  acquireIndexLock,
  breakIndexLock,
  completeLeaseRecovery,
  releaseIndexLock,
  type IndexLockOwner,
} from "../src/indexer/index-lock.js";
import {
  getLocalMachineId,
  normalizeLockHostName,
  resolveLocalHostNames,
  resolveLocalMachineId,
  setLockHostIdentitySourcesForTesting,
  type LockHostIdentitySources,
} from "../src/indexer/lock-host-identity.js";

const LINUX_MACHINE_ID = "0123456789abcdef0123456789abcdef";
const PLATFORM_UUID = "8A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
const IOREG_OUTPUT = `+-o Device  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformUUID" = "${PLATFORM_UUID}"\n    }\n`;

function sources(overrides: Partial<LockHostIdentitySources>): LockHostIdentitySources {
  return {
    platform: "linux",
    hostname: () => "current-host",
    readFile: () => null,
    readLink: () => null,
    run: () => null,
    ...overrides,
  };
}

function darwinRunner(names: Record<string, string>): LockHostIdentitySources["run"] {
  return (file, args) => {
    if (file === "/usr/sbin/ioreg") return IOREG_OUTPUT;
    if (file === "/usr/sbin/scutil" && args[0] === "--get") return names[args[1]] ?? null;
    return null;
  };
}

function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (typeof child.pid !== "number") throw new Error("child process did not start");
  return child.pid;
}

describe("lock host identity", () => {
  it("normalizes Bonjour and trailing-dot host names", () => {
    expect(normalizeLockHostName(" Former-Host.local. ")).toBe("former-host");
    expect(normalizeLockHostName("build.example.com")).toBe("build.example.com");
  });

  it("derives a hashed Linux identity from machine-id and PID namespace", () => {
    const read = (filePath: string): string | null => filePath === "/etc/machine-id" ? `${LINUX_MACHINE_ID}\n` : null;
    const first = resolveLocalMachineId(sources({ readFile: read, readLink: () => "pid:[4026531836]" }));
    const again = resolveLocalMachineId(sources({ readFile: read, readLink: () => "pid:[4026531836]" }));
    const otherNamespace = resolveLocalMachineId(sources({ readFile: read, readLink: () => "pid:[4026532001]" }));

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toContain(LINUX_MACHINE_ID);
    expect(again).toBe(first);
    expect(otherNamespace).not.toBe(first);
    expect(resolveLocalMachineId(sources({ readFile: read }))).toBeNull();
    expect(resolveLocalMachineId(sources({ readLink: () => "pid:[4026531836]" }))).toBeNull();
  });

  it("reads the macOS platform UUID and tolerates a failing lookup", () => {
    const id = resolveLocalMachineId(sources({ platform: "darwin", run: darwinRunner({}) }));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveLocalMachineId(sources({ platform: "darwin" }))).toBeNull();
  });

  it("returns no machine id and only the OS hostname on Windows without running commands", () => {
    const run = (): string => {
      throw new Error("no commands on Windows");
    };
    expect(resolveLocalMachineId(sources({ platform: "win32", run }))).toBeNull();
    expect(resolveLocalHostNames(sources({ platform: "win32", run }))).toEqual(["current-host"]);
  });

  it("collects the macOS local and configured host names", () => {
    const names = resolveLocalHostNames(sources({
      platform: "darwin",
      run: darwinRunner({ LocalHostName: "former-host", HostName: "current-host" }),
    }));
    expect(names).toEqual(["current-host", "former-host"]);
  });
});

describe("stale index lock recovery", () => {
  let tempDir: string;
  let indexPath: string;
  let lockPath: string;

  function writeOwner(owner: Partial<IndexLockOwner> & { pid: number; hostname: string }, token = "11111111-1111-4111-8111-111111111111"): IndexLockOwner {
    const record = {
      startedAt: new Date().toISOString(),
      operation: "index" as const,
      token,
      ...owner,
    };
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(record));
    return record;
  }

  function expectRecovered(owner: IndexLockOwner): void {
    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map((recovery) => recovery.owner.token)).toEqual([owner.token]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
  }

  function expectBusy(): void {
    expect(() => acquireIndexLock(indexPath, "index")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY", reason: "unknown-owner" }),
    );
    expect(fs.existsSync(lockPath)).toBe(true);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-lock-stale-"));
    indexPath = path.join(tempDir, "index");
    lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(indexPath, { recursive: true });
    setLockHostIdentitySourcesForTesting({
      platform: "darwin",
      hostname: () => "current-host",
      run: darwinRunner({ LocalHostName: "former-host" }),
    });
  });

  afterEach(() => {
    setLockHostIdentitySourcesForTesting(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records the machine id alongside every field older readers require", () => {
    const lease = acquireIndexLock(indexPath, "index");
    const stored = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as Record<string, unknown>;
    releaseIndexLock(lease);

    expect(stored.pid).toBe(process.pid);
    expect(stored.hostname).toBe(os.hostname());
    expect(Date.parse(String(stored.startedAt))).not.toBeNaN();
    expect(stored.operation).toBe("index");
    expect(stored.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.machineId).toBe(getLocalMachineId());
  });

  it("recovers a dead owner recorded with this host's current name", () => {
    expectRecovered(writeOwner({ pid: exitedPid(), hostname: "current-host" }));
  });

  it("recovers a dead owner whose old-format lock names this machine's former hostname", () => {
    expectRecovered(writeOwner({ pid: exitedPid(), hostname: "Former-Host.local" }));
  });

  it("recovers a dead owner whose new-format lock carries this machine id under another hostname", () => {
    expectRecovered(writeOwner({ pid: exitedPid(), hostname: "retired-name", machineId: getLocalMachineId() ?? "" }));
  });

  it("never steals a live owner recorded under a former hostname", () => {
    writeOwner({ pid: process.pid, hostname: "former-host.local" });
    expect(() => acquireIndexLock(indexPath, "index")).toThrowError(
      expect.objectContaining({ code: "INDEX_BUSY", reason: "active" }),
    );
  });

  it("refuses a lock from another machine even when the hostnames collide", () => {
    writeOwner({ pid: exitedPid(), hostname: "current-host", machineId: "f".repeat(32) });
    expectBusy();
  });

  it("refuses an old-format lock whose hostname matches no local name", () => {
    writeOwner({ pid: exitedPid(), hostname: "build-agent-7" });
    expectBusy();
  });

  it("falls back to host names when this machine has no id", () => {
    setLockHostIdentitySourcesForTesting({ platform: "win32", hostname: () => "current-host" });
    expectRecovered(writeOwner({ pid: exitedPid(), hostname: "current-host", machineId: "f".repeat(32) }));
  });
});

describe("manual index unlock", () => {
  let tempDir: string;
  let indexPath: string;
  let lockPath: string;

  function writeOwner(owner: Partial<IndexLockOwner> & { pid: number; hostname: string }, directory = lockPath): IndexLockOwner {
    const record: IndexLockOwner = {
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "33333333-3333-4333-8333-333333333333",
      ...owner,
    };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify(record));
    return record;
  }

  async function cli(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCbiCli(["node", "ocbi", "unlock", ...args], tempDir, {
      printStdout: (text) => stdout.push(text),
      printStderr: (text) => stderr.push(text),
    });
    return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-unlock-"));
    indexPath = path.join(tempDir, "index");
    lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(indexPath, { recursive: true });
    setLockHostIdentitySourcesForTesting({ platform: "linux", hostname: () => "current-host" });
  });

  afterEach(() => {
    setLockHostIdentitySourcesForTesting(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports when there is no lock", async () => {
    const result = await cli(indexPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No index lock found");
  });

  it("refuses a live owner on this machine, even with --force", async () => {
    writeOwner({ pid: process.pid, hostname: "current-host" });

    const result = await cli(indexPath, "--force");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`PID ${process.pid} on current-host (this machine)`);
    expect(result.stderr).toContain("still running on this machine");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("refuses an owner on another machine until --force, then lets the next run recover it", async () => {
    const owner = writeOwner({ pid: 4242, hostname: "remote-host" });

    const refused = await cli(indexPath);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('"hostname":"remote-host"');
    expect(refused.stderr).toContain("cannot be verified");
    expect(refused.stderr).toContain("rerun with --force");
    expect(refused.stderr).toContain("updated recently");
    expect(fs.existsSync(lockPath)).toBe(true);

    const forced = await cli(lockPath, "--force");
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Cleared");
    expect(fs.existsSync(lockPath)).toBe(false);

    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map((recovery) => recovery.owner.token)).toEqual([owner.token]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("clears a dead local owner without --force and keeps its recovery marker", () => {
    const owner = writeOwner({ pid: exitedPid(), hostname: "current-host" });

    const result = breakIndexLock(indexPath);

    expect(result.status).toBe("removed");
    expect(result.entries.map((entry) => entry.state)).toEqual(["dead"]);
    expect(fs.existsSync(path.join(indexPath, `indexing.lock.recovery.${owner.token}`))).toBe(true);
  });

  it("requires --force for an unreadable lock record", () => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{");

    expect(breakIndexLock(indexPath).status).toBe("refused-unverified");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(breakIndexLock(indexPath, { force: true }).status).toBe("removed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("handles legacy single-file locks by owner liveness", () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: "current-host", startedAt: new Date().toISOString() }));
    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-alive");

    fs.writeFileSync(lockPath, JSON.stringify({ pid: exitedPid(), hostname: "current-host", startedAt: new Date().toISOString() }));
    const result = breakIndexLock(indexPath);
    expect(result.status).toBe("removed");
    expect(result.entries[0]?.kind).toBe("legacy-lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("abandons a blocking recovery marker from another machine only with --force", async () => {
    const markerPath = path.join(indexPath, "indexing.lock.recovery.44444444-4444-4444-8444-444444444444");
    writeOwner({ pid: 4243, hostname: "remote-host", token: "44444444-4444-4444-8444-444444444444" }, markerPath);
    expect(() => acquireIndexLock(indexPath, "index")).toThrowError(expect.objectContaining({ code: "INDEX_BUSY" }));

    const refused = await cli(indexPath, "--json");
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ status: "refused-unverified", entries: [{ kind: "recovery-marker" }] });

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("removed");
    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map((recovery) => recovery.owner.pid)).toEqual([4243]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
