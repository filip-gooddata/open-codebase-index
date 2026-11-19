// Runs the ocbi MCP server as a child and relays newline-delimited JSON-RPC between it and the
// client. An index_codebase call with force=true is answered here and never reaches the server:
// a forced rebuild wipes the index that every worktree of a shared-store project shares. Hosts without hooks
// (Codex runs plugin hooks only after the user trusts them) are covered the same way as Claude.
import { spawn } from "node:child_process";
import readline from "node:readline";

const BLOCKED =
  "Blocked: index_codebase force=true wipes the shared index for every worktree and re-embeds " +
  "everything. Call index_codebase without force for a normal refresh. If a full rebuild is " +
  "really needed, ask the user to run one from a terminal (`ocbi-rebuild`, when installed).";

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

const isForcedIndex = (message) =>
  message?.method === "tools/call" &&
  message.params?.name === "index_codebase" &&
  message.params.arguments?.force === true;

readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }
    if (isForcedIndex(message)) {
      const result = { content: [{ type: "text", text: BLOCKED }], isError: true };
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      return;
    }
    child.stdin.write(`${line}\n`);
  })
  .on("close", () => child.stdin.end());

readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  .on("line", (line) => process.stdout.write(`${line}\n`));

child.stdin.on("error", () => {});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
// "close" fires after the child's stdout is drained. Exit then, even while the client keeps
// stdin open: a guard without a server would otherwise linger and ignore signals.
child.on("close", (code, signal) => {
  const status = signal ? 1 : (code ?? 0);
  process.stdout.end(() => process.exit(status));
});
