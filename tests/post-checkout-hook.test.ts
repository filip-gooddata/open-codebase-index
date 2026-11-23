import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRepositoryRoutesForTests } from "../src/config/repository-route.js";
import {
  getCheckoutStatePaths,
  getPostCheckoutSkipReason,
  isRefreshLockHeld,
  readRefreshLockOwner,
  releaseRefreshLock,
  resolvePostCheckoutTarget,
  runPostCheckoutHook,
  runRefreshWorker,
  scrubGitRepositoryEnv,
  tryAcquireRefreshLock,
  type RefreshPassResult,
  type RefreshWorkerOptions,
} from "../src/git/post-checkout-hook.js";
import { runHookCli } from "../src/adapters/hooks-cli.js";

const GIT_ENV = {
  ...scrubGitRepositoryEnv(process.env),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

function writeRepositoryConfig(commonDir: string, config: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(commonDir, "codebase-index"), { recursive: true });
  fs.writeFileSync(path.join(commonDir, "codebase-index", "config.json"), JSON.stringify(config));
}

function createRepository(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return fs.realpathSync(root);
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
  return Number(child.stdout);
}

describe("post-checkout hook", () => {
  let tempDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-checkout-hook-")));
    previousHome = process.env.HOME;
    process.env.HOME = path.join(tempDir, "home");
    resetRepositoryRoutesForTests();
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    resetRepositoryRoutesForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("skip rules", () => {
    it("runs only for branch checkouts", () => {
      expect(getPostCheckoutSkipReason(["a", "b", "1"], {}, "linux")).toBeNull();
      expect(getPostCheckoutSkipReason(["a", "b", "0"], {}, "linux")).toBe("file checkout");
      expect(getPostCheckoutSkipReason([], {}, "linux")).toBe("file checkout");
    });

    it("honours OCBI_PREWARM=0 and skips rebases", () => {
      expect(getPostCheckoutSkipReason(["a", "b", "1"], { OCBI_PREWARM: "0" }, "darwin")).toBe("disabled by OCBI_PREWARM=0");
      expect(getPostCheckoutSkipReason(["a", "b", "1"], { OCBI_PREWARM: "1" }, "darwin")).toBeNull();
      expect(getPostCheckoutSkipReason(["a", "b", "1"], { GIT_REFLOG_ACTION: "rebase (pick)" }, "darwin")).toBe("rebase");
      expect(getPostCheckoutSkipReason(["a", "b", "1"], { GIT_REFLOG_ACTION: "checkout" }, "darwin")).toBeNull();
    });

    it("reports Windows as unsupported and still exits 0", async () => {
      const errors: string[] = [];
      const code = await runHookCli(["post-checkout", "a", "b", "1"], tempDir, { platform: "win32", printStderr: (text) => errors.push(text) });
      expect(code).toBe(0);
      expect(errors.join("\n")).toContain("Windows is not supported");
    });
  });

  it("scrubs the variables that pin git to one repository view", () => {
    const scrubbed = scrubGitRepositoryEnv({
      GIT_DIR: "/x/.git",
      GIT_WORK_TREE: "/x",
      GIT_INDEX_FILE: "/x/.git/index",
      GIT_COMMON_DIR: "/x/.git",
      GIT_PREFIX: "sub/",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_AUTHOR_NAME: "kept",
      GIT_CONFIG_GLOBAL: "/kept/gitconfig",
      PATH: "/bin",
    });
    expect(scrubbed).toEqual({ GIT_AUTHOR_NAME: "kept", GIT_CONFIG_GLOBAL: "/kept/gitconfig", PATH: "/bin" });
  });

  it("keys state by the checkout's full path, so equal directory names do not collide", () => {
    const first = getCheckoutStatePaths("/repo/.git", "/one/feature");
    const second = getCheckoutStatePaths("/repo/.git", "/two/feature");
    expect(first.key).toMatch(/^feature-[0-9a-f]{12}$/);
    expect(first.lock).not.toBe(second.lock);
    expect(first.log).not.toBe(second.log);
    expect(path.dirname(first.lock)).toBe(path.join("/repo/.git", "codebase-index", "logs", "post-checkout"));
  });

  it("does nothing and writes nothing without a repository config", () => {
    const repo = createRepository(path.join(tempDir, "plain"));
    const outcome = runPostCheckoutHook(["a", "b", "1"], repo, "codex", {}, {
      env: {},
      spawnWorker: () => { throw new Error("must not spawn"); },
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no repository config" });
    expect(fs.existsSync(path.join(repo, ".git", "codebase-index"))).toBe(false);
  });

  it("does nothing when the merged config uses the global scope", () => {
    const repo = createRepository(path.join(tempDir, "global-scope"));
    writeRepositoryConfig(path.join(repo, ".git"), { scope: "global" });
    const outcome = runPostCheckoutHook(["a", "b", "1"], repo, "codex", {}, {
      env: {},
      spawnWorker: () => { throw new Error("must not spawn"); },
    });
    expect(outcome.kind).toBe("skipped");
    const { log } = getCheckoutStatePaths(path.join(repo, ".git"), repo);
    expect(fs.readFileSync(log, "utf-8")).toContain("skipped: scope global does not use the repository store");
  });

  it("resolves the checkout it runs in, whatever GIT_DIR the hook inherited", () => {
    const repo = createRepository(path.join(tempDir, "main"));
    writeRepositoryConfig(path.join(repo, ".git"));
    const worktree = path.join(tempDir, "wt", "feature");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    const other = createRepository(path.join(tempDir, "other"));

    const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      const resolution = resolvePostCheckoutTarget(worktree, "codex");
      expect(resolution.kind).toBe("target");
      if (resolution.kind !== "target") return;
      expect(resolution.target.checkoutRoot).toBe(fs.realpathSync(worktree));
      expect(resolution.target.commonDir).toBe(path.join(repo, ".git"));
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  describe("refresh lock", () => {
    const owner = (pid: number, released = false) =>
      JSON.stringify({ pid, hostname: os.hostname(), startedAt: "2020-01-01T00:00:00Z", released });
    let lock: string;
    const generations = () => fs.readdirSync(path.dirname(lock)).filter((name) => /^x\.lock\.\d+$/.test(name)).sort();

    beforeEach(() => {
      lock = path.join(tempDir, "state", "x.lock");
      fs.mkdirSync(path.dirname(lock), { recursive: true });
    });

    it("recovers a lock whose owner is gone and keeps one whose owner runs", () => {
      fs.writeFileSync(`${lock}.1`, owner(deadPid()));
      expect(isRefreshLockHeld(lock)).toBe(false);
      expect(tryAcquireRefreshLock(lock, process.pid)).toBe(true);
      expect(readRefreshLockOwner(lock)?.pid).toBe(process.pid);
      expect(generations()).toEqual(["x.lock.2"]);
      expect(tryAcquireRefreshLock(lock, process.ppid)).toBe(false);
      releaseRefreshLock(lock, process.ppid);
      expect(isRefreshLockHeld(lock)).toBe(true);
      releaseRefreshLock(lock, process.pid);
      expect(isRefreshLockHeld(lock)).toBe(false);
      expect(tryAcquireRefreshLock(lock, process.ppid)).toBe(true);
      expect(generations()).toEqual(["x.lock.3"]);
    });

    it("lets only one of three contenders that saw the same dead holder take the lock", () => {
      fs.writeFileSync(`${lock}.1`, owner(deadPid()));
      const winners: number[] = [];
      const [first, second, third] = [process.pid, process.ppid, 1];
      const acquired = tryAcquireRefreshLock(lock, first, {
        beforeLink: () => {
          // Two more contenders run while the first sits between reading the dead holder and linking.
          for (const pid of [second, third]) {
            if (tryAcquireRefreshLock(lock, pid)) winners.push(pid);
          }
        },
      });
      if (acquired) winners.push(first);
      expect(winners).toEqual([second]);
      expect(readRefreshLockOwner(lock)?.pid).toBe(second);
    });

    it("gives up a generation recreated after later holders deleted it", () => {
      fs.writeFileSync(`${lock}.1`, owner(deadPid()));
      let delayed = true;
      const acquired = tryAcquireRefreshLock(lock, process.pid, {
        beforeLink: (generation) => {
          if (!delayed) return;
          delayed = false;
          expect(generation).toBe(2);
          // While the first contender stalls, one holder takes and releases generation 2 and the
          // next takes 3, deleting 1 and 2. The stalled contender then recreates 2.
          expect(tryAcquireRefreshLock(lock, process.ppid)).toBe(true);
          releaseRefreshLock(lock, process.ppid);
          expect(tryAcquireRefreshLock(lock, 1)).toBe(true);
          expect(generations()).toEqual(["x.lock.3"]);
        },
      });
      expect(acquired).toBe(false);
      expect(generations()).toEqual(["x.lock.3"]);
      expect(readRefreshLockOwner(lock)?.pid).toBe(1);
    });

    it("treats an unreadable generation as free", () => {
      fs.writeFileSync(`${lock}.4`, "");
      expect(tryAcquireRefreshLock(lock, process.pid)).toBe(true);
      expect(generations()).toEqual(["x.lock.5"]);
    });
  });

  describe("queueing", () => {
    function setUpRepository(): { repo: string; commonDir: string } {
      const repo = createRepository(path.join(tempDir, "queue"));
      const commonDir = path.join(repo, ".git");
      writeRepositoryConfig(commonDir);
      return { repo, commonDir };
    }

    it("runs one refresh per checkout and queues exactly one more pass", async () => {
      const { repo, commonDir } = setUpRepository();
      const releases: Array<() => void> = [];
      let passes = 0;
      let worker: Promise<number> | null = null;
      const runPass = (): Promise<RefreshPassResult> => {
        passes += 1;
        return new Promise((resolve) => releases.push(() => resolve({ exitCode: 0, busy: false })));
      };
      const spawnWorker = (options: RefreshWorkerOptions): number => {
        worker = runRefreshWorker(options, { env: { OCBI_STALE_CHECK: "0" }, runPass });
        return process.pid;
      };
      const hook = () => runPostCheckoutHook(["a", "b", "1"], repo, "codex", {}, { env: {}, spawnWorker });

      expect(hook().kind).toBe("started");
      await vi.waitFor(() => expect(passes).toBe(1));
      expect(hook().kind).toBe("queued");
      expect(hook().kind).toBe("queued");
      releases.shift()?.();
      await vi.waitFor(() => expect(passes).toBe(2));
      releases.shift()?.();
      expect(await worker).toBe(2);

      const paths = getCheckoutStatePaths(commonDir, repo);
      expect(isRefreshLockHeld(paths.lock)).toBe(false);
      expect(fs.existsSync(paths.again)).toBe(false);
      expect(fs.readFileSync(paths.log, "utf-8").match(/^== exit 0 /gm)).toHaveLength(2);
    });

    it("lets two checkouts with the same directory name refresh at once", () => {
      const repo = createRepository(path.join(tempDir, "main"));
      writeRepositoryConfig(path.join(repo, ".git"));
      const first = path.join(tempDir, "a", "feature");
      const second = path.join(tempDir, "b", "feature");
      git(repo, "worktree", "add", "-q", "-b", "one", first);
      git(repo, "worktree", "add", "-q", "-b", "two", second);
      const spawned: string[] = [];
      const spawnWorker = (options: RefreshWorkerOptions): number => { spawned.push(options.checkoutRoot); return process.pid; };
      expect(runPostCheckoutHook(["a", "b", "1"], first, "codex", {}, { env: {}, spawnWorker }).kind).toBe("started");
      expect(runPostCheckoutHook(["a", "b", "1"], second, "codex", {}, { env: {}, spawnWorker }).kind).toBe("started");
      expect(spawned).toEqual([fs.realpathSync(first), fs.realpathSync(second)]);
    });

    it("releases the lock when the worker fails to start", () => {
      const { repo, commonDir } = setUpRepository();
      const outcome = runPostCheckoutHook(["a", "b", "1"], repo, "codex", {}, {
        env: {},
        spawnWorker: () => { throw new Error("spawn EACCES"); },
      });
      expect(outcome).toEqual({ kind: "skipped", reason: "worker failed to start: spawn EACCES" });
      expect(isRefreshLockHeld(getCheckoutStatePaths(commonDir, repo).lock)).toBe(false);
    });

    it("does no pass when nothing is queued, and leaves a live worker's lock alone", async () => {
      const { repo, commonDir } = setUpRepository();
      const paths = getCheckoutStatePaths(commonDir, repo);
      const runPass = (): RefreshPassResult => { throw new Error("must not run"); };
      expect(await runRefreshWorker({ checkoutRoot: repo, commonDir, host: "codex" }, { env: {}, runPass })).toBe(0);
      expect(isRefreshLockHeld(paths.lock)).toBe(false);

      expect(tryAcquireRefreshLock(paths.lock, process.pid)).toBe(true);
      fs.writeFileSync(paths.again, "");
      expect(await runRefreshWorker({ checkoutRoot: repo, commonDir, host: "codex" }, { env: {}, runPass, pid: deadPid() })).toBe(0);
      expect(fs.existsSync(paths.again)).toBe(true);
      expect(readRefreshLockOwner(paths.lock)?.pid).toBe(process.pid);
    });

    it("queues before checking the lock, so a finishing worker picks the request up", async () => {
      const { repo, commonDir } = setUpRepository();
      const paths = getCheckoutStatePaths(commonDir, repo);
      let passes = 0;
      let queued: ReturnType<typeof runPostCheckoutHook> | null = null;
      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.writeFileSync(paths.again, "");
      expect(await runRefreshWorker({ checkoutRoot: repo, commonDir, host: "codex" }, {
        env: { OCBI_STALE_CHECK: "0" },
        runPass: () => {
          passes += 1;
          if (passes === 1) queued = runPostCheckoutHook(["a", "b", "1"], repo, "codex", {}, { env: {}, spawnWorker: () => { throw new Error("must not spawn"); } });
          return { exitCode: 0, busy: false };
        },
      })).toBe(2);
      expect(queued).toMatchObject({ kind: "queued" });
      expect(isRefreshLockHeld(paths.lock)).toBe(false);
    });

    it("logs a busy store and does not retry", async () => {
      const { repo, commonDir } = setUpRepository();
      const paths = getCheckoutStatePaths(commonDir, repo);
      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.writeFileSync(paths.again, "");
      const passes = await runRefreshWorker({ checkoutRoot: repo, commonDir, host: "codex" }, {
        env: { OCBI_STALE_CHECK: "0" },
        runPass: () => ({ exitCode: 1, busy: true }),
      });
      expect(passes).toBe(1);
      expect(fs.readFileSync(paths.log, "utf-8")).toMatch(/^== busy: another index operation holds the store/m);
      expect(isRefreshLockHeld(paths.lock)).toBe(false);
    });
  });

  describe("stale check", () => {
    it("quotes the cleanup command so a shell gets the exact arguments", async () => {
      const repo = createRepository(path.join(tempDir, "it's quoted"));
      const commonDir = path.join(repo, ".git");
      writeRepositoryConfig(commonDir);
      const paths = getCheckoutStatePaths(commonDir, repo);
      fs.mkdirSync(paths.stateDir, { recursive: true });
      fs.writeFileSync(paths.again, "");
      const entryScript = path.join(tempDir, "pkg dir", "it's", "cbi.js");
      const messages: string[] = [];
      await runRefreshWorker({ checkoutRoot: repo, commonDir, host: "codex", staleNotify: "notifier" }, {
        env: {},
        entryScript,
        runPass: () => ({ exitCode: 0, busy: false }),
        countPrunable: () => 15,
        notify: (_command, _title, message) => { messages.push(message); },
      });
      const command = messages[0]?.split("Run: ")[1] ?? "";
      const words = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { encoding: "utf-8" }).split("\n").slice(0, -1);
      expect(words).toEqual([process.execPath, entryScript, "prune", "--apply", "--host", "codex", "--project", repo]);
    });

    it("counts prunable catalogs once a day and notifies from the threshold", async () => {
      const repo = createRepository(path.join(tempDir, "stale"));
      const commonDir = path.join(repo, ".git");
      writeRepositoryConfig(commonDir);
      const notifications: string[][] = [];
      let counts = 0;
      const { again, stateDir } = getCheckoutStatePaths(commonDir, repo);
      fs.mkdirSync(stateDir, { recursive: true });
      const run = (env: Record<string, string>, now: number) => (fs.writeFileSync(again, ""), runRefreshWorker(
        { checkoutRoot: repo, commonDir, host: "codex", staleNotify: "notifier" },
        {
          env,
          runPass: () => ({ exitCode: 0, busy: false }),
          countPrunable: () => { counts += 1; return 20; },
          notify: (command, title, message) => { notifications.push([command, title, message]); },
          now: () => now,
        },
      ));

      await run({ OCBI_STALE_CHECK: "0" }, Date.now());
      expect(counts).toBe(0);
      await run({}, Date.now());
      expect(counts).toBe(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0][0]).toBe("notifier");
      expect(notifications[0][1]).toBe("Worth a cleanup: stale");
      expect(notifications[0][2]).toContain(`20 catalogs of deleted branches or worktrees. Run: ${process.execPath} `);
      expect(notifications[0][2]).toContain(" prune --apply --host codex --project");
      await run({}, Date.now());
      expect(counts).toBe(1);
      await run({ OCBI_STALE_THRESHOLD: "50" }, Date.now() + 25 * 60 * 60 * 1000);
      expect(counts).toBe(2);
      expect(notifications).toHaveLength(1);
      const log = fs.readFileSync(getCheckoutStatePaths(commonDir, repo).log, "utf-8");
      expect(log).toMatch(/^== stale check: 20 catalogs of deleted branches or worktrees; remove them with: \S+ \S+ prune --apply/m);
    });
  });
});
