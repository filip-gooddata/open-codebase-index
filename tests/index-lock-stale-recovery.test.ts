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
  parseDarwinMounts,
  parseLinuxMounts,
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

function darwinRunner(names: Record<string, string>, mounts = "/dev/disk1s1 on / (apfs, local, journaled)\n"): LockHostIdentitySources["run"] {
  return (file, args) => {
    if (file === "/usr/sbin/ioreg") return IOREG_OUTPUT;
    if (file === "/sbin/mount") return mounts;
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
    expect(normalizeLockHostName(" Former-Host.local. ")).toBe("former-host.local");
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

  it("reads the Windows MachineGuid and tolerates a failing lookup", () => {
    const guid = "5b9e2c1a-3d4f-4e6a-8b7c-9d0e1f2a3b4c";
    const run = (file: string): string | null => file.endsWith("\\System32\\reg.exe")
      ? `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n`
      : null;
    expect(resolveLocalMachineId(sources({ platform: "win32", run }))).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveLocalMachineId(sources({ platform: "win32" }))).toBeNull();
    expect(resolveLocalHostNames(sources({ platform: "win32", run }))).toEqual(["current-host"]);
  });

  it("reads mount locality on macOS and Linux", () => {
    expect(parseDarwinMounts("/dev/disk1s1 on / (apfs, local, journaled)\n//host/share on /Volumes/team share (smbfs, nodev)\n"))
      .toEqual([{ mountPoint: "/", local: true }, { mountPoint: "/Volumes/team share", local: false }]);
    expect(parseLinuxMounts("/dev/sda1 / ext4 rw 0 0\nserver:/srv /mnt/shared\\040store nfs4 rw 0 0\nsshfs#h /mnt/s fuse.sshfs rw 0 0\n"))
      .toEqual([
        { mountPoint: "/", local: true },
        { mountPoint: "/mnt/shared store", local: false },
        { mountPoint: "/mnt/s", local: false },
      ]);
  });

  it("collects the macOS local and configured host names", () => {
    const names = resolveLocalHostNames(sources({
      platform: "darwin",
      run: darwinRunner({ LocalHostName: "former-host", HostName: "current-host" }),
    }));
    expect(names).toEqual(["current-host", "former-host", "former-host.local"]);
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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "index-lock-stale-")));
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

  it("recovers the bare Bonjour name as well as its .local form", () => {
    expectRecovered(writeOwner({ pid: exitedPid(), hostname: "former-host" }));
  });

  it("refuses a former-hostname lock on shared storage", () => {
    setLockHostIdentitySourcesForTesting({
      platform: "darwin",
      hostname: () => "current-host",
      run: darwinRunner(
        { LocalHostName: "former-host" },
        `/dev/disk1s1 on / (apfs, local, journaled)\n//server/share on ${tempDir} (smbfs, nodev)\n`,
      ),
    });
    writeOwner({ pid: exitedPid(), hostname: "former-host.local" });
    expectBusy();
  });

  it("refuses an exact-hostname old-format lock on shared storage", () => {
    setLockHostIdentitySourcesForTesting({
      platform: "darwin",
      hostname: () => "current-host",
      run: darwinRunner({}, `/dev/disk1s1 on / (apfs, local, journaled)\nserver:/export on ${tempDir} (nfs, nodev)\n`),
    });
    writeOwner({ pid: exitedPid(), hostname: "current-host" });
    expectBusy();
  });

  it("refuses an exact-hostname old-format lock on a Linux filesystem type it does not know to be local", () => {
    setLockHostIdentitySourcesForTesting({
      platform: "linux",
      hostname: () => "current-host",
      readFile: (filePath) => filePath === "/proc/self/mounts"
        ? `/dev/sda1 / ext4 rw 0 0\npvfs2://server:3334/fs ${tempDir} pvfs2 rw 0 0\n`
        : null,
    });
    writeOwner({ pid: exitedPid(), hostname: "current-host" });
    expectBusy();
  });

  it.each([
    ["a share mounted over a local filesystem at the same point", (dir: string) => `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${dir} ext4 rw 0 0\npvfs2://server:3334/fs ${dir} pvfs2 rw 0 0\n`],
    ["a local filesystem listed before a share at the same point", (dir: string) => `/dev/sda1 / ext4 rw 0 0\npvfs2://server:3334/fs ${dir} pvfs2 rw 0 0\n/dev/sdb1 ${dir} ext4 rw 0 0\n`],
    ["a share mounted over an ancestor of a local mount", (dir: string) => `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${dir}/index ext4 rw 0 0\nserver:/export ${dir} nfs4 rw 0 0\n`],
  ])("refuses an exact-hostname old-format lock under %s", (_label, mounts) => {
    setLockHostIdentitySourcesForTesting({
      platform: "linux",
      hostname: () => "current-host",
      readFile: (filePath) => filePath === "/proc/self/mounts" ? mounts(tempDir) : null,
    });
    writeOwner({ pid: exitedPid(), hostname: "current-host" });
    expectBusy();
  });

  it("recovers an exact-hostname old-format lock on a local filesystem mounted over a share", () => {
    setLockHostIdentitySourcesForTesting({
      platform: "linux",
      hostname: () => "current-host",
      readFile: (filePath) => filePath === "/proc/self/mounts"
        ? `/dev/sda1 / ext4 rw 0 0\nserver:/export ${tempDir} nfs4 rw 0 0\n/dev/sdb1 ${tempDir}/index ext4 rw 0 0\n`
        : null,
    });
    expectRecovered(writeOwner({ pid: exitedPid(), hostname: "current-host" }));
  });

  it("recovers a force-abandoned marker even where an unrelated process holds its PID", () => {
    const token = "abababab-abab-4bab-8bab-abababababab";
    const markerPath = path.join(indexPath, `indexing.lock.recovery.${token}`);
    fs.mkdirSync(markerPath, { recursive: true });
    fs.writeFileSync(path.join(markerPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      hostname: "remote-host",
      startedAt: new Date().toISOString(),
      operation: "index",
      token,
      abandonedAt: new Date().toISOString(),
    }));

    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map((recovery) => recovery.owner.token)).toEqual([token]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("does not widen a plain hostname into a .local alias", () => {
    setLockHostIdentitySourcesForTesting({ platform: "linux", hostname: () => "current-host" });
    writeOwner({ pid: exitedPid(), hostname: "current-host.local" });
    expectBusy();
  });

  it("keeps a machine-id owner unverified when this machine cannot produce an id", () => {
    setLockHostIdentitySourcesForTesting({ platform: "win32", hostname: () => "current-host", run: () => null });
    writeOwner({ pid: exitedPid(), hostname: "current-host", machineId: "f".repeat(32) });
    expectBusy();
  });

  it("keeps an exact-hostname old-format lock unverified when storage locality is unknown", () => {
    setLockHostIdentitySourcesForTesting({ platform: "win32", hostname: () => "current-host", run: () => null });
    writeOwner({ pid: exitedPid(), hostname: "current-host" });
    expectBusy();
  });

  it("recovers an exact-hostname old-format lock on local storage without a machine id", () => {
    setLockHostIdentitySourcesForTesting({
      platform: "linux",
      hostname: () => "current-host",
      readFile: (filePath) => filePath === "/proc/self/mounts" ? "/dev/sda1 / ext4 rw 0 0\n" : null,
    });
    expectRecovered(writeOwner({ pid: exitedPid(), hostname: "current-host" }));
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

  function makeOld(...paths: string[]): void {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const target of paths) fs.utimesSync(target, old, old);
  }

  function oldStart(): string {
    return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "index-unlock-")));
    indexPath = path.join(tempDir, "index");
    lockPath = path.join(indexPath, "indexing.lock");
    fs.mkdirSync(indexPath, { recursive: true });
    setLockHostIdentitySourcesForTesting({
      platform: "linux",
      hostname: () => "current-host",
      readFile: (filePath) => filePath === "/proc/self/mounts" ? "/dev/sda1 / ext4 rw 0 0\n" : null,
    });
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
    const owner = writeOwner({ pid: exitedPid(), hostname: "remote-host" });

    const refused = await cli(indexPath);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('"hostname":"remote-host"');
    expect(refused.stderr).toContain("cannot be verified");
    expect(refused.stderr).toContain("Rerun with --force only after confirming");
    expect(refused.stderr).toContain("may still be in use");
    expect(fs.existsSync(lockPath)).toBe(true);

    const forced = await cli(lockPath, "--force");
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("next index run recovers");
    expect(fs.existsSync(lockPath)).toBe(false);

    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map((recovery) => recovery.owner.token)).toEqual([owner.token]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("requires --force for a fresh lock even when its local owner has exited", () => {
    writeOwner({ pid: exitedPid(), hostname: "current-host" });

    expect(breakIndexLock(indexPath).status).toBe("refused-fresh");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(breakIndexLock(indexPath, { force: true }).status).toBe("removed");
  });

  it("clears an old dead local owner without --force and keeps its recovery marker", () => {
    const owner = writeOwner({ pid: exitedPid(), hostname: "current-host", startedAt: oldStart() });
    makeOld(path.join(lockPath, "owner.json"), lockPath);

    const result = breakIndexLock(indexPath);

    expect(result).toMatchObject({ status: "removed", recoverable: true });
    expect(result.entries.map((entry) => entry.state)).toEqual(["dead"]);
    expect(fs.existsSync(path.join(indexPath, `indexing.lock.recovery.${owner.token}`))).toBe(true);
  });

  it("requires --force for an unreadable lock record and reports that recovery is unavailable", async () => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{");

    expect(breakIndexLock(indexPath).status).toBe("refused-unverified");
    expect(fs.existsSync(lockPath)).toBe(true);
    const forced = await cli(indexPath, "--force");
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("cannot be recovered automatically");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  function writeClaim(pid: number, hostname: string): void {
    fs.mkdirSync(path.join(lockPath, "reclaiming"), { recursive: true });
    fs.writeFileSync(path.join(lockPath, "reclaiming", "owner.json"), JSON.stringify({
      pid,
      hostname,
      startedAt: oldStart(),
      token: "88888888-8888-4888-8888-888888888888",
      expectedOwnerToken: "99999999-9999-4999-8999-999999999999",
    }));
  }

  it("does not clear an unreadable lock a live local process is claiming", () => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{");
    writeClaim(process.pid, "current-host");

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-alive");
    expect(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")).toBe("{");
  });

  it.each([
    ["an exited local unlock", "current-host"],
    ["an unlock on another machine", "remote-host"],
  ])("retries an unreadable lock whose claim was left by %s", (_label, hostname) => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{");
    writeClaim(exitedPid(), hostname);

    expect(breakIndexLock(indexPath).status).not.toBe("removed");
    expect(breakIndexLock(indexPath, { force: true }).status).toBe("removed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("vetoes a forced clear when the machine id cannot be checked but the PID is alive under this hostname", () => {
    setLockHostIdentitySourcesForTesting({ platform: "win32", hostname: () => "current-host", run: () => null });
    writeOwner({ pid: process.pid, hostname: "current-host", machineId: "f".repeat(32) });

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-alive");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("vetoes a forced clear of a renamed owner whose PID is alive when the machine id cannot be checked", () => {
    setLockHostIdentitySourcesForTesting({ platform: "win32", hostname: () => "current-host", run: () => null });
    writeOwner({ pid: process.pid, hostname: "retired-name", machineId: "f".repeat(32) });

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-alive");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("vetoes a forced clear of a hostname-only owner under a forgotten name whose PID runs here", () => {
    writeOwner({ pid: process.pid, hostname: "forgotten-name" });

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-alive");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("clears a lock under several claims left by interrupted unlocks", () => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{");
    let claimDirectory = lockPath;
    for (let level = 0; level < 4; level += 1) {
      claimDirectory = path.join(claimDirectory, "reclaiming");
      fs.mkdirSync(claimDirectory);
      fs.writeFileSync(path.join(claimDirectory, "owner.json"), JSON.stringify({
        pid: exitedPid(),
        hostname: "current-host",
        startedAt: oldStart(),
        token: `${level}${level}${level}${level}${level}${level}${level}${level}-0000-4000-8000-000000000000`,
        expectedOwnerToken: "99999999-9999-4999-8999-999999999999",
      }));
    }

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("removed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("leaves a stale claim alone while another unlock is taking it over", () => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), "{");
    writeClaim(exitedPid(), "current-host");
    const nested = path.join(lockPath, "reclaiming", "reclaiming");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "owner.json"), JSON.stringify({
      pid: process.pid,
      hostname: "current-host",
      startedAt: new Date().toISOString(),
      token: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      expectedOwnerToken: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }));

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-changed");
    expect(fs.existsSync(path.join(nested, "owner.json"))).toBe(true);
    expect(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")).toBe("{");
  });

  it("clears a recovery marker that is a plain file only with --force", () => {
    const markerPath = path.join(indexPath, "indexing.lock.recovery.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    fs.writeFileSync(markerPath, "damaged");
    expect(() => acquireIndexLock(indexPath, "index")).toThrowError(expect.objectContaining({ code: "INDEX_BUSY" }));

    expect(breakIndexLock(indexPath).status).toBe("refused-unverified");
    const result = breakIndexLock(indexPath, { force: true });
    expect(result).toMatchObject({ status: "removed", recoverable: false });
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("takes over a stale unlock guard and releases its own guard afterwards", () => {
    const guardPath = path.join(indexPath, "indexing.lock.unlock");
    writeOwner({ pid: exitedPid(), hostname: "current-host", startedAt: oldStart() });
    makeOld(path.join(lockPath, "owner.json"), lockPath);
    writeOwner({ pid: exitedPid(), hostname: "current-host", operation: "recovery" }, guardPath);

    expect(breakIndexLock(indexPath).status).toBe("removed");
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("displaces an unlock guard from another machine only with --force", () => {
    const guardPath = path.join(indexPath, "indexing.lock.unlock");
    writeOwner({ pid: exitedPid(), hostname: "remote-host" });
    writeOwner({ pid: exitedPid(), hostname: "remote-host", operation: "recovery", token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, guardPath);

    const forced = breakIndexLock(indexPath, { force: true });
    expect(forced.status).toBe("removed");
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("refuses while another unlock holds the guard", () => {
    writeOwner({ pid: exitedPid(), hostname: "current-host" });
    writeOwner({ pid: process.pid, hostname: "current-host", operation: "recovery" }, path.join(indexPath, "indexing.lock.unlock"));

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-busy");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("handles legacy single-file locks by owner liveness and age", () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: "current-host", startedAt: new Date().toISOString() }));
    expect(breakIndexLock(indexPath, { force: true }).status).toBe("refused-alive");

    fs.writeFileSync(lockPath, JSON.stringify({ pid: exitedPid(), hostname: "current-host", startedAt: oldStart() }));
    expect(breakIndexLock(indexPath).status).toBe("refused-fresh");
    makeOld(lockPath);
    const result = breakIndexLock(indexPath);
    expect(result).toMatchObject({ status: "removed", recoverable: false });
    expect(result.entries[0]?.kind).toBe("legacy-lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("treats a legacy lock without a hostname as unverified", () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: exitedPid(), startedAt: oldStart() }));
    makeOld(lockPath);

    expect(breakIndexLock(indexPath).status).toBe("refused-unverified");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("shows a stranded reclaimer from another machine and clears it only with --force", async () => {
    const owner = writeOwner({ pid: exitedPid(), hostname: "remote-host", startedAt: oldStart() });
    fs.mkdirSync(path.join(lockPath, "reclaiming"));
    fs.writeFileSync(path.join(lockPath, "reclaiming", "owner.json"), JSON.stringify({
      pid: exitedPid(),
      hostname: "remote-host",
      startedAt: oldStart(),
      token: "66666666-6666-4666-8666-666666666666",
      expectedOwnerToken: owner.token,
    }));

    const refused = await cli(indexPath);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("- reclaim-marker:");
    expect(refused.stderr).toMatch(/PID \d+ on remote-host/);

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("removed");
    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map((recovery) => recovery.owner.token)).toEqual([owner.token]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
  });

  it("resolves a relative index path against the working directory", async () => {
    const nested = path.join(tempDir, "nested");
    fs.mkdirSync(nested);
    const stdout: string[] = [];
    const exitCode = await runCbiCli(["node", "ocbi", "unlock", "../index", "--json"], nested, {
      printStdout: (text) => stdout.push(text),
      printStderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "no-lock", indexPath: fs.realpathSync(indexPath) });
  });

  it("abandons a blocking recovery marker from another machine only with --force", async () => {
    const markerPath = path.join(indexPath, "indexing.lock.recovery.44444444-4444-4444-8444-444444444444");
    writeOwner({ pid: exitedPid(), hostname: "remote-host", token: "44444444-4444-4444-8444-444444444444" }, markerPath);
    expect(() => acquireIndexLock(indexPath, "index")).toThrowError(expect.objectContaining({ code: "INDEX_BUSY" }));

    const refused = await cli(indexPath, "--json");
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ status: "refused-unverified", entries: [{ kind: "recovery-marker" }] });

    expect(breakIndexLock(indexPath, { force: true }).status).toBe("removed");
    const lease = acquireIndexLock(indexPath, "recovery");
    expect(lease.recoveries.map((recovery) => recovery.owner.token)).toEqual(["44444444-4444-4444-8444-444444444444"]);
    completeLeaseRecovery(lease);
    expect(releaseIndexLock(lease)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
