import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";
import { ApprovalManager, type PendingApproval } from "./approvals.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import type { RpcMessage } from "./rpc-types.js";
import { discoverVscodeThreads, formatThread, type DiscoveredThread } from "./session-discovery.js";

interface CliOptions {
  codex: string;
  socket: string;
  cwd?: string;
  threadId?: string;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error("Usage: pnpm probe -- --codex <path> --sock <path> [--cwd <path>] [--thread <id>]");
    }
    values.set(flag, value);
  }
  const codex = values.get("--codex") ?? process.env.CODEX_POCKET_CODEX_EXE;
  if (!codex) throw new Error("--codex or CODEX_POCKET_CODEX_EXE is required.");
  const socket = values.get("--sock") ?? process.env.CODEX_POCKET_SOCKET_PATH;
  if (!socket) throw new Error("--sock or CODEX_POCKET_SOCKET_PATH is required; managed-daemon fallback is disabled.");
  const cwd = values.get("--cwd");
  const threadId = values.get("--thread");
  return {
    codex,
    socket,
    ...(cwd ? { cwd } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

async function chooseThread(
  threads: DiscoveredThread[],
  requestedId: string | undefined,
  terminal: readline.Interface,
): Promise<DiscoveredThread> {
  if (requestedId) {
    const requested = threads.find((thread) => thread.id === requestedId);
    if (!requested) throw new Error(`Requested VS Code thread was not found: ${requestedId}`);
    return requested;
  }
  if (threads.length === 0) throw new Error("No matching VS Code threads were found.");
  if (threads.length === 1) return threads[0]!;
  for (const [index, thread] of threads.entries()) console.log(formatThread(thread, index));
  const answer = await terminal.question("Select a thread number: ");
  const selected = Number.parseInt(answer, 10) - 1;
  if (!Number.isInteger(selected) || !threads[selected]) throw new Error("Invalid thread selection.");
  return threads[selected];
}

function printApproval(approval: PendingApproval): void {
  console.log("\n⚠ Codex approval required");
  console.log(`Type: ${approval.kind}`);
  if (approval.command) console.log(`Command: ${approval.command}`);
  if (approval.cwd) console.log(`CWD: ${approval.cwd}`);
  if (approval.grantRoot) console.log(`Grant root: ${approval.grantRoot}`);
  if (approval.reason) console.log(`Reason: ${approval.reason}`);
  console.log(`Request: ${String(approval.requestId)} — use 'y' or 'n'`);
}

function observeRuntime(message: RpcMessage, state: { activeTurnId: string | null }): void {
  if (message.method === "turn/started") {
    const parsed = z.object({ turn: z.object({ id: z.string() }).passthrough() }).safeParse(message.params);
    if (parsed.success) state.activeTurnId = parsed.data.turn.id;
  } else if (message.method === "turn/completed") {
    state.activeTurnId = null;
  }
}

async function runCommands(
  terminal: readline.Interface,
  peer: JsonRpcPeer,
  approvals: ApprovalManager,
  threadId: string,
  state: { activeTurnId: string | null },
): Promise<void> {
  console.log("Commands: y, n, send <task>, steer <text>, stop, status, quit");
  while (true) {
    const line = (await terminal.question("pocket> ")).trim();
    if (line === "quit") return;
    if (line === "status") {
      console.log(`thread=${threadId} activeTurn=${state.activeTurnId ?? "none"} pending=${approvals.pending().length}`);
      continue;
    }
    if (line === "y" || line === "n") {
      const pending = approvals.pending();
      if (pending.length !== 1) {
        console.log(`Expected exactly one pending approval; found ${pending.length}.`);
        continue;
      }
      approvals.decide(pending[0]!.requestId, line === "y" ? "accept" : "decline");
      continue;
    }
    if (line.startsWith("send ")) {
      if (state.activeTurnId) {
        console.log("A turn is active. Use 'steer <text>' explicitly.");
        continue;
      }
      const result = await peer.request("turn/start", {
        threadId,
        input: [{ type: "text", text: line.slice(5) }],
      });
      const parsed = z.object({ turn: z.object({ id: z.string() }).passthrough() }).parse(result);
      state.activeTurnId = parsed.turn.id;
      continue;
    }
    if (line.startsWith("steer ")) {
      if (!state.activeTurnId) {
        console.log("No active turn to steer.");
        continue;
      }
      await peer.request("turn/steer", {
        threadId,
        expectedTurnId: state.activeTurnId,
        input: [{ type: "text", text: line.slice(6) }],
      });
      continue;
    }
    if (line === "stop") {
      if (!state.activeTurnId) {
        console.log("No active turn to interrupt.");
        continue;
      }
      await peer.request("turn/interrupt", { threadId, turnId: state.activeTurnId });
      continue;
    }
    console.log("Unknown command.");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await access(options.codex);
  process.env.CODEX_HOME ??= path.resolve(".codex-pocket", "codex-home");
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  const child: ChildProcessWithoutNullStreams = spawn(options.codex, ["app-server", "proxy", "--sock", options.socket], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => process.stderr.write(`[app-server] ${chunk}`));

  const peer = new JsonRpcPeer(child.stdout, child.stdin, {
    requestTimeoutMs: 30_000,
    onProtocolError: (error) => console.error(`[protocol] ${error.message}`),
    closeTransport: async () => {
      if (!child.killed) child.kill();
    },
  });
  const terminal = readline.createInterface({ input, output });
  const approvals = new ApprovalManager(peer);
  const state = { activeTurnId: null as string | null };

  try {
    await peer.request("initialize", {
      clientInfo: { name: "codex_pocket", title: "Codex Pocket IPC Probe", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    peer.notify("initialized", {});

    const threads = await discoverVscodeThreads(peer, options.cwd);
    const selected = await chooseThread(threads, options.threadId, terminal);
    const resumed = await peer.request("thread/resume", { threadId: selected.id, excludeTurns: false });
    const resumedThread = z.object({
      thread: z.object({ id: z.string(), turns: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) }).passthrough(),
    }).parse(resumed).thread;
    if (resumedThread.id !== selected.id) throw new Error("App Server resumed a different thread ID.");
    const activeTurn = [...resumedThread.turns].reverse().find((turn) => turn.status === "inProgress");
    state.activeTurnId = activeTurn?.id ?? null;
    console.log(`Attached to existing VS Code thread: ${selected.id}`);

    const eventLoop = (async () => {
      for await (const message of peer.messages()) {
        observeRuntime(message, state);
        try {
          const approval = approvals.observe(message);
          if (approval) printApproval(approval);
        } catch (error) {
          console.error(`[approval] ${error instanceof Error ? error.message : String(error)}`);
        }
        if (message.method === "thread/status/changed" || message.method === "turn/completed") {
          console.log(`[event] ${message.method} ${JSON.stringify(message.params)}`);
        }
      }
    })();

    await runCommands(terminal, peer, approvals, selected.id, state);
    await peer.close();
    await eventLoop;
  } finally {
    approvals.resolveAll();
    terminal.close();
    await peer.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
