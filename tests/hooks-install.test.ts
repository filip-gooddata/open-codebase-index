import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runHooksCli } from "../src/adapters/hooks-cli.js";
import {
  CHAINED_HOOK_NAME,
  HOOK_CONFIG_NAME,
  buildHookCommand,
  describeHookCommand,
  parseHookInvocation,
  getPostCheckoutHookStatus,
  gitSupportsConfigHooks,
  installPostCheckoutHook,
  resolveHookRepository,
  uninstallPostCheckoutHook,
  type HookCommandSpec,
} from "../src/git/hook-install.js";
import { getCheckoutStatePaths, isRefreshLockHeld, scrubGitRepositoryEnv } from "../src/git/post-checkout-hook.js";

const CBI = path.resolve("dist/cbi.js");
const CONFIG_HOOKS = gitSupportsConfigHooks();

let tempDir: string;
let gitEnv: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

function createRepository(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return fs.realpathSync(root);
}

function createBareLayout(root: string): { bare: string; worktree: string } {
  const seed = createRepository(path.join(root, "seed"));
  const bare = path.join(root, "repo.git");
  git(root, "clone", "-q", "--bare", seed, bare);
  const worktree = path.join(root, "checkouts", "main");
  git(bare, "worktree", "add", "-q", worktree, "main");
  return { bare: fs.realpathSync(bare), worktree: fs.realpathSync(worktree) };
}

/**
 * A git dir that is its own common dir with core.bare=false and no working tree of its own: every
 * checkout is a linked worktree, so `git rev-parse --show-toplevel` fails at its root.
 */
function createCommonDirLayout(root: string): { common: string; worktree: string } {
  const seed = createRepository(path.join(root, "seed"));
  const common = path.join(root, "repo");
  fs.renameSync(path.join(seed, ".git"), common);
  git(common, "config", "core.bare", "false");
  const worktree = path.join(root, "checkouts", "feature");
  git(common, "worktree", "add", "-q", "-b", "feature", worktree, "main");
  return { common: fs.realpathSync(common), worktree: fs.realpathSync(worktree) };
}

function spec(overrides: Partial<HookCommandSpec> = {}): HookCommandSpec {
  return { nodePath: process.execPath, entryScript: CBI, host: "codex", ...overrides };
}

function captureCli() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { printStdout: (text: string) => out.push(text), printStderr: (text: string) => err.push(text), entryScript: CBI } };
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hooks-install-")));
  const gitConfig = path.join(tempDir, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  gitEnv = {
    ...scrubGitRepositoryEnv(process.env),
    HOME: path.join(tempDir, "home"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    OCBI_STALE_CHECK: "0",
  } as NodeJS.ProcessEnv;
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("hook command", () => {
  it("round-trips paths with spaces and quotes", () => {
    const command = buildHookCommand(spec({ nodePath: "/opt/my node/bin/node", entryScript: "/x/it's/cbi.js", staleNotify: "/n/notify me" }));
    expect(parseHookInvocation(command)).toEqual([
      "/opt/my node/bin/node", "/x/it's/cbi.js", "hook", "post-checkout", "--host", "codex", "--stale-notify", "/n/notify me",
    ]);
  });

  it("reports a command whose files are gone as stale and another install's as such", () => {
    const missing = describeHookCommand(buildHookCommand(spec({ entryScript: path.join(tempDir, "gone", "cbi.js") })), CBI);
    expect(missing.state).toBe("stale");
    expect(missing.detail).toContain("rerun ocbi hooks install");
    const otherEntry = path.join(tempDir, "other-cbi.js");
    fs.writeFileSync(otherEntry, "");
    expect(describeHookCommand(buildHookCommand(spec({ entryScript: otherEntry })), CBI).state).toBe("other-install");
    expect(describeHookCommand(buildHookCommand(spec()), CBI)).toMatchObject({ state: "current", host: "codex" });
    expect(describeHookCommand("/usr/local/bin/something-else", CBI).state).toBe("unparsed");
  });
});

describe.runIf(CONFIG_HOOKS)("config-based install", () => {
  it("is idempotent in a normal clone and uninstalls cleanly", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    const first = installPostCheckoutHook(repo, { spec: spec() });
    expect(first).toMatchObject({ method: "config", changed: true });
    expect(installPostCheckoutHook(repo, { spec: spec() }).changed).toBe(false);
    expect(git(repo.repo, "config", "--local", "--get-all", `hook.${HOOK_CONFIG_NAME}.event`).trim()).toBe("post-checkout");

    const status = getPostCheckoutHookStatus(repo, CBI, true);
    expect(status.installed).toBe(true);
    expect(status.config?.report?.state).toBe("current");

    expect(uninstallPostCheckoutHook(repo).changed).toBe(true);
    expect(uninstallPostCheckoutHook(repo).changed).toBe(false);
    expect(getPostCheckoutHookStatus(repo, CBI, true).installed).toBe(false);
  });

  it("installs and reports from a non-bare common dir that has no working tree of its own", async () => {
    const { common, worktree } = createCommonDirLayout(tempDir);
    expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: common, env: gitEnv }).status).not.toBe(0);
    const repo = resolveHookRepository(common);
    expect(repo).toMatchObject({ commonDir: common, bare: false, workTree: null });
    expect(resolveHookRepository(worktree)).toMatchObject({ commonDir: common, workTree: worktree });

    // core.hooksPath makes status and install look for a working tree around the hooks dir.
    git(common, "config", "core.hooksPath", "hooks-shared");
    const cli = captureCli();
    expect(await runHooksCli(["install", "--repo", common, "--host", "claude", "--method", "config"], tempDir, cli.deps)).toBe(0);
    expect(fs.readFileSync(path.join(common, "config"), "utf-8")).toContain(`[hook "${HOOK_CONFIG_NAME}"]`);
    expect(await runHooksCli(["status", "--repo", common, "--host", "claude"], tempDir, cli.deps)).toBe(0);
    expect(cli.err.join("\n")).not.toContain("must be run in a work tree");
    expect(getPostCheckoutHookStatus(resolveHookRepository(worktree), CBI, true).installed).toBe(true);

    git(common, "config", "--unset", "core.hooksPath");
    expect(await runHooksCli(["status", "--repo", common, "--host", "claude"], tempDir, cli.deps)).toBe(0);
  });

  it("keeps the working tree a git dir names through core.worktree", async () => {
    const checkout = createRepository(path.join(tempDir, "checkout"));
    const gitDir = path.join(tempDir, "external.git");
    fs.renameSync(path.join(checkout, ".git"), gitDir);
    git(gitDir, "config", "core.worktree", checkout);
    git(gitDir, "config", "core.hooksPath", path.join(checkout, ".githooks"));
    // git reports the git dir as outside the working tree but still names it.
    expect(git(gitDir, "rev-parse", "--is-inside-work-tree").trim()).toBe("false");
    const repo = resolveHookRepository(gitDir);
    expect(repo).toMatchObject({ commonDir: fs.realpathSync(gitDir), bare: false, workTree: checkout });

    const cli = captureCli();
    expect(await runHooksCli(["install", "--repo", gitDir, "--host", "claude", "--method", "file"], tempDir, cli.deps)).toBe(0);
    expect(fs.existsSync(path.join(checkout, ".githooks", "post-checkout"))).toBe(true);
    expect(getPostCheckoutHookStatus(resolveHookRepository(gitDir), CBI, true).installed).toBe(true);
    expect(await runHooksCli(["status", "--repo", gitDir, "--host", "claude"], tempDir, cli.deps)).toBe(0);
  });

  it("writes the bare repository's config and is seen from its worktrees", () => {
    const { bare, worktree } = createBareLayout(tempDir);
    const fromBare = resolveHookRepository(bare);
    expect(fromBare).toMatchObject({ commonDir: bare, bare: true });
    installPostCheckoutHook(fromBare, { spec: spec() });
    expect(fs.readFileSync(path.join(bare, "config"), "utf-8")).toContain(`[hook "${HOOK_CONFIG_NAME}"]`);
    const fromWorktree = resolveHookRepository(worktree);
    expect(fromWorktree.commonDir).toBe(bare);
    expect(installPostCheckoutHook(fromWorktree, { spec: spec() }).changed).toBe(false);
    expect(getPostCheckoutHookStatus(fromWorktree, CBI, true).installed).toBe(true);
  });

  it("warns about the shell hook it replaces", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    git(repo.repo, "config", "--local", "hook.ocbi-prewarm.event", "post-checkout");
    git(repo.repo, "config", "--local", "hook.ocbi-prewarm.command", "/somewhere/ocbi-post-checkout.sh");
    const result = installPostCheckoutHook(repo, { spec: spec() });
    expect(result.warnings.join("\n")).toContain("hook.ocbi-prewarm; remove it with");
    expect(getPostCheckoutHookStatus(repo, CBI, true).legacy).toEqual([{ name: "ocbi-prewarm", command: "/somewhere/ocbi-post-checkout.sh" }]);
  });

  it("fails open when the node binary it names is gone", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    installPostCheckoutHook(repo, { spec: spec({ nodePath: path.join(tempDir, "removed-node") }) });
    expect(getPostCheckoutHookStatus(repo, CBI, true).config?.report?.state).toBe("stale");
    const checkout = spawnSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo.repo, env: gitEnv, encoding: "utf-8" });
    expect(checkout.status, checkout.stderr).toBe(0);
  });

  it("leaves a same-name hook it did not write alone", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    git(repo.repo, "config", "--local", `hook.${HOOK_CONFIG_NAME}.command`, "/usr/local/bin/mine");
    git(repo.repo, "config", "--local", `hook.${HOOK_CONFIG_NAME}.event`, "post-checkout");
    expect(() => installPostCheckoutHook(repo, { spec: spec() })).toThrow(/did not write/);
    expect(() => installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: true })).toThrow(/did not write/);
    expect(fs.existsSync(path.join(repo.commonDir, "hooks", "post-checkout"))).toBe(false);
    expect(uninstallPostCheckoutHook(repo).actions.join("\n")).toContain("left hook.ocbi-post-checkout alone");
    expect(git(repo.repo, "config", "--local", "--get", `hook.${HOOK_CONFIG_NAME}.command`).trim()).toBe("/usr/local/bin/mine");
  });

  it("replaces a managed hook file left by an install on an older git", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    installPostCheckoutHook(repo, { method: "file", spec: spec() });
    const result = installPostCheckoutHook(repo, { spec: spec() });
    expect(result.actions.join("\n")).toContain("removed managed hook");
    expect(fs.existsSync(path.join(repo.commonDir, "hooks", "post-checkout"))).toBe(false);
  });
});

describe("hook file install", () => {
  it("writes a managed hook once and removes it again", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    const hookFile = path.join(repo.commonDir, "hooks", "post-checkout");
    expect(installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false }).changed).toBe(true);
    expect(fs.statSync(hookFile).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(hookFile, "utf-8").startsWith("#!/bin/sh\n")).toBe(true);
    expect(installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false }).changed).toBe(false);
    const status = getPostCheckoutHookStatus(repo, CBI, false);
    expect(status).toMatchObject({ installed: true, file: { managed: true, chained: null } });
    expect(status.file?.report?.state).toBe("current");
    expect(uninstallPostCheckoutHook(repo).changed).toBe(true);
    expect(fs.existsSync(hookFile)).toBe(false);
    expect(uninstallPostCheckoutHook(repo).changed).toBe(false);
  });

  it("chains an existing hook, keeps its failure and restores it on uninstall", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    const hookFile = path.join(repo.commonDir, "hooks", "post-checkout");
    const original = `#!/bin/sh\necho "earlier hook $3" >> "${path.join(tempDir, "earlier.log")}"\nexit 3\n`;
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, original, { mode: 0o755 });

    const result = installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false });
    expect(result.actions.join("\n")).toContain(`moved the existing hook to ${path.join(repo.commonDir, "hooks", CHAINED_HOOK_NAME)}`);
    expect(installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false }).changed).toBe(false);

    const checkout = spawnSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo.repo, env: { ...gitEnv, OCBI_PREWARM: "0" }, encoding: "utf-8" });
    // git reports a failing post-checkout hook as its own failure, whatever the hook's code.
    expect(checkout.status).not.toBe(0);
    expect(fs.readFileSync(path.join(tempDir, "earlier.log"), "utf-8")).toBe("earlier hook 1\n");

    uninstallPostCheckoutHook(repo);
    expect(fs.readFileSync(hookFile, "utf-8")).toBe(original);
    expect(fs.existsSync(path.join(repo.commonDir, "hooks", CHAINED_HOOK_NAME))).toBe(false);
  });

  it("refuses to overwrite when a chained hook is already parked", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    const hooks = path.join(repo.commonDir, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(hooks, CHAINED_HOOK_NAME), "#!/bin/sh\n", { mode: 0o755 });
    expect(() => installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false })).toThrow(/is not managed by ocbi/);
    expect(fs.readFileSync(path.join(hooks, "post-checkout"), "utf-8")).toBe("#!/bin/sh\n");
  });

  it("uses a repository-private core.hooksPath and refuses a shared one", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    git(repo.repo, "config", "--local", "core.hooksPath", ".repo-hooks");
    const privateHooks = path.join(repo.repo, ".repo-hooks");
    fs.mkdirSync(privateHooks);
    fs.writeFileSync(path.join(privateHooks, "post-checkout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false });
    expect(result.actions.join("\n")).toContain(`moved the existing hook to ${path.join(privateHooks, CHAINED_HOOK_NAME)}`);
    expect(result.warnings.join("\n")).toContain("is inside the working tree");
    expect(getPostCheckoutHookStatus(repo, CBI, false)).toMatchObject({ installed: true, file: { path: path.join(privateHooks, "post-checkout") } });
    uninstallPostCheckoutHook(repo);
    expect(fs.readFileSync(path.join(privateHooks, "post-checkout"), "utf-8")).toBe("#!/bin/sh\nexit 0\n");

    const inGitDir = path.join(repo.commonDir, "custom-hooks");
    git(repo.repo, "config", "--local", "core.hooksPath", inGitDir);
    expect(installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false }).warnings).toEqual([]);
    expect(fs.existsSync(path.join(inGitDir, "post-checkout"))).toBe(true);
    uninstallPostCheckoutHook(repo);

    const shared = path.join(tempDir, "shared-hooks");
    git(repo.repo, "config", "--local", "core.hooksPath", shared);
    expect(() => installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false })).toThrow(/outside this repository/);
    expect(fs.existsSync(shared)).toBe(false);
    expect(uninstallPostCheckoutHook(repo).changed).toBe(false);
  });

  it("writes to a hooks path that ends in spaces, where git looks", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    git(repo.repo, "config", "--local", "core.hooksPath", ".repo-hooks  ");
    const spaced = path.join(repo.repo, ".repo-hooks  ");
    fs.mkdirSync(spaced);
    const marker = path.join(tempDir, "ran");
    fs.writeFileSync(path.join(spaced, "post-checkout"), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false });
    expect(getPostCheckoutHookStatus(repo, CBI, false).file?.path).toBe(path.join(spaced, "post-checkout"));
    expect(fs.existsSync(path.join(spaced, CHAINED_HOOK_NAME))).toBe(true);
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo.repo, env: { ...gitEnv, OCBI_PREWARM: "0" } });
    expect(fs.readFileSync(marker, "utf-8")).toBe("ran\n");
  });

  it("parks and restores a hook symlink whose target is missing", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    const hooks = path.join(repo.commonDir, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const target = path.join(tempDir, "elsewhere", "post-checkout");
    fs.symlinkSync(target, path.join(hooks, "post-checkout"));
    const result = installPostCheckoutHook(repo, { method: "file", spec: spec(), configHooksSupported: false });
    expect(result.actions.join("\n")).toContain("moved the existing hook");
    expect(fs.readlinkSync(path.join(hooks, CHAINED_HOOK_NAME))).toBe(target);
    uninstallPostCheckoutHook(repo);
    expect(fs.readlinkSync(path.join(hooks, "post-checkout"))).toBe(target);
  });

  it("refuses the config method on a git without config-based hooks", () => {
    const repo = resolveHookRepository(createRepository(path.join(tempDir, "repo")));
    expect(() => installPostCheckoutHook(repo, { method: "config", spec: spec(), configHooksSupported: false })).toThrow(/use --method file/);
  });
});

describe("ocbi hooks CLI", () => {
  it("says Windows is unsupported", async () => {
    const cli = captureCli();
    expect(await runHooksCli(["status"], tempDir, { ...cli.deps, platform: "win32" })).toBe(1);
    expect(cli.err.join("\n")).toContain("Windows is not supported");
  });

  it("installs, reports and uninstalls with --repo", async () => {
    const repo = createRepository(path.join(tempDir, "repo"));
    const cli = captureCli();
    expect(await runHooksCli(["install", "--repo", repo, "--host", "claude", "--method", "file"], tempDir, cli.deps)).toBe(0);
    expect(await runHooksCli(["install", "--repo", repo, "--method", "file"], tempDir, cli.deps)).toBe(0);
    expect(cli.out.at(-1)).toBe("Already installed (file).");
    expect(await runHooksCli(["status", "--repo", repo, "--json"], tempDir, cli.deps)).toBe(0);
    const status = JSON.parse(cli.out.at(-1) ?? "{}");
    expect(status).toMatchObject({ installed: true, repositoryConfig: { exists: false } });
    expect(status.file.report).toMatchObject({ state: "current", host: "claude" });
    expect(await runHooksCli(["uninstall", "--repo", repo], tempDir, cli.deps)).toBe(0);
    expect(await runHooksCli(["uninstall", "--repo", repo], tempDir, cli.deps)).toBe(0);
    expect(cli.out.at(-1)).toBe("Nothing to uninstall.");
  });

  it("rejects an unknown method", async () => {
    const cli = captureCli();
    expect(await runHooksCli(["install", "--repo", createRepository(path.join(tempDir, "r")), "--method", "symlink"], tempDir, cli.deps)).toBe(1);
    expect(cli.err.join("\n")).toContain("--method must be config or file");
  });
});

describe("post-checkout through git", () => {
  let server: Server;
  let baseUrl: string;
  let held: Array<() => void> | null = null;

  beforeAll(async () => {
    if (!fs.existsSync(CBI)) throw new Error("dist/cbi.js is missing; run npm run build:ts first");
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { input?: unknown };
        const inputs = Array.isArray(parsed.input) ? parsed.input.map(String) : [String(parsed.input ?? "")];
        const data = inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: Array.from({ length: 8 }, (_, dimension) => ((input.length + dimension * 17) % 97) / 97),
        }));
        const respond = () => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data, usage: { total_tokens: inputs.length } }));
        };
        if (held) held.push(respond);
        else respond();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function writeRepositoryConfig(commonDir: string): void {
    fs.mkdirSync(path.join(commonDir, "codebase-index"), { recursive: true });
    fs.writeFileSync(path.join(commonDir, "codebase-index", "config.json"), JSON.stringify({
      embeddingProvider: "custom",
      customProvider: { baseUrl, model: "hook-test", dimensions: 8, timeoutMs: 5000, concurrency: 1, requestIntervalMs: 0 },
      include: ["**/*.ts"],
      indexing: { autoGc: false, retries: 0 },
    }));
  }

  function install(repo: string, method: "config" | "file"): void {
    const result = spawnSync(process.execPath, [CBI, "hooks", "install", "--repo", repo, "--host", "codex", "--method", method], { env: gitEnv, encoding: "utf-8" });
    expect(result.status, result.stderr).toBe(0);
  }

  async function waitForRefresh(commonDir: string, checkout: string, passes = 1): Promise<string> {
    const paths = getCheckoutStatePaths(commonDir, checkout);
    await vi.waitFor(() => {
      const log = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, "utf-8") : "";
      expect(log.match(/^== (exit|busy)/gm)?.length ?? 0).toBeGreaterThanOrEqual(passes);
      expect(isRefreshLockHeld(paths.lock)).toBe(false);
    }, { timeout: 60_000, interval: 100 });
    return fs.readFileSync(paths.log, "utf-8");
  }

  it.each(CONFIG_HOOKS ? ["config", "file"] as const : ["file"] as const)(
    "refreshes after a branch checkout but not a file checkout or with OCBI_PREWARM=0 (%s)",
    async (method) => {
      const repo = createRepository(path.join(tempDir, "repo"));
      const commonDir = path.join(repo, ".git");
      writeRepositoryConfig(commonDir);
      install(repo, method);

      const { lock } = getCheckoutStatePaths(commonDir, repo);
      held = [];
      const pending = held;
      try {
        git(repo, "checkout", "-q", "-b", "feature");
        // git is back while the refresh still waits for its embeddings.
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0), { timeout: 30_000, interval: 50 });
        expect(isRefreshLockHeld(lock)).toBe(true);
      } finally {
        held = null;
        for (const respond of pending.splice(0)) respond();
      }
      const log = await waitForRefresh(commonDir, repo);
      expect(log).toMatch(new RegExp(`^== \\S+ ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} feature [0-9a-f]+$`, "m"));
      expect(log).toMatch(/^== exit 0 /m);

      const { log: logPath } = getCheckoutStatePaths(commonDir, repo);
      const before = fs.readFileSync(logPath, "utf-8");
      fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 2;\n");
      git(repo, "checkout", "-q", "--", "a.ts");
      execFileSync("git", ["checkout", "-q", "main"], { cwd: repo, env: { ...gitEnv, OCBI_PREWARM: "0" } });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.readFileSync(logPath, "utf-8")).toBe(before);
    },
    90_000,
  );

  it("refreshes a new worktree of a bare repository for its own branch, despite GIT_DIR", async () => {
    const { bare } = createBareLayout(tempDir);
    writeRepositoryConfig(bare);
    install(bare, CONFIG_HOOKS ? "config" : "file");
    const other = createRepository(path.join(tempDir, "other"));

    const worktree = path.join(tempDir, "checkouts", "topic");
    git(bare, "worktree", "add", "-q", "-b", "topic", worktree, "main");
    const realWorktree = fs.realpathSync(worktree);
    const log = await waitForRefresh(bare, realWorktree);
    expect(log).toContain(` ${realWorktree} topic `);
    expect(log).toMatch(/^== exit 0 /m);

    git(realWorktree, "checkout", "-q", "-b", "topic-2");
    // A GIT_DIR left over from the caller would point the refresh at another repository.
    execFileSync("git", ["checkout", "-q", "-b", "topic-3"], {
      cwd: realWorktree,
      env: { ...gitEnv, GIT_DIR: path.join(bare, "worktrees", "topic"), GIT_WORK_TREE: realWorktree },
    });
    const later = await waitForRefresh(bare, realWorktree, 2);
    expect(later).toMatch(/ topic-3 [0-9a-f]+$/m);
    expect(later).not.toContain(other);
  }, 120_000);
});
