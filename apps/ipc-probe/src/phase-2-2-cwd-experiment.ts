import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { ClientEventLog } from "./client-event-log.js";
import { LoopbackWebSocketSupervisor } from "./loopback-websocket-supervisor.js";
import { ProtocolLog } from "./protocol-log.js";
import { resolvePinnedCodexExecutable } from "./pinned-vscode-runtime.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "./websocket-json-rpc.js";

const threadSchema = z.object({ thread: z.object({ id: z.string(), cwd: z.string() }).passthrough() });
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });
const listSchema = z.object({ data: z.array(z.object({ id: z.string(), cwd: z.string() }).passthrough()) });
const allSources = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

function turnCompleted(threadId: string, turnId: string): (message: RpcMessage) => boolean {
  return (message) => message.method === "turn/completed" && typeof message.params === "object" && message.params !== null &&
    "threadId" in message.params && message.params.threadId === threadId && "turn" in message.params &&
    typeof message.params.turn === "object" && message.params.turn !== null && "id" in message.params.turn &&
    message.params.turn.id === turnId;
}

async function close(connection: WebSocketPeerConnection | null): Promise<void> {
  await connection?.close().catch(() => undefined);
}

async function main(): Promise<void> {
  const root = path.resolve(".codex-pocket", "phase-2-2", "cwd-experiment");
  const workspaceA = path.join(root, "workspace-A");
  const workspaceB = path.join(root, "workspace-B");
  const logs = path.join(root, "logs");
  await Promise.all([mkdir(workspaceA, { recursive: true }), mkdir(workspaceB, { recursive: true }), mkdir(logs, { recursive: true })]);
  const codexPath = await resolvePinnedCodexExecutable(process.cwd());
  const supervisor = new LoopbackWebSocketSupervisor({
    codexPath,
    codexHome: process.env.CODEX_POCKET_INTEGRATION_CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  });
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const logPath = path.join(logs, `${runId}-protocol.jsonl`);
  const reportPath = path.join(logs, `${runId}-report.json`);
  const protocolLog = new ProtocolLog(logPath, [supervisor.token]);
  let first: WebSocketPeerConnection | null = null;
  let second: WebSocketPeerConnection | null = null;
  let threadId: string | null = null;
  const report: Record<string, unknown> = { phase: "2.2-cwd", passed: false };
  try {
    await supervisor.start();
    first = await connectWebSocketPeer({ url: supervisor.endpoint, token: supervisor.token, name: "cwd_a", log: protocolLog });
    second = await connectWebSocketPeer({ url: supervisor.endpoint, token: supervisor.token, name: "cwd_b", log: protocolLog });
    const firstEvents = new ClientEventLog(first.peer.messages());
    const secondEvents = new ClientEventLog(second.peer.messages());
    const started = threadSchema.parse(await first.peer.request("thread/start", { cwd: workspaceA, ephemeral: false }));
    threadId = started.thread.id;

    const turnA = turnSchema.parse(await first.peer.request("turn/start", {
      threadId, cwd: workspaceA, input: [{ type: "text", text: "Reply exactly CWD_EXPERIMENT_A." }],
    }));
    await firstEvents.waitFor(turnCompleted(threadId, turnA.turn.id), 180_000, "workspace-A turn completion");
    const afterTurnA = threadSchema.parse(await first.peer.request("thread/resume", { threadId, excludeTurns: true }));
    const resumedInB = threadSchema.parse(await second.peer.request("thread/resume", {
      threadId, cwd: workspaceB, excludeTurns: true,
    }));

    const turnB = turnSchema.parse(await second.peer.request("turn/start", {
      threadId, cwd: workspaceB, input: [{ type: "text", text: "Reply exactly CWD_EXPERIMENT_B." }],
    }));
    await secondEvents.waitFor(turnCompleted(threadId, turnB.turn.id), 180_000, "workspace-B turn completion");
    const afterTurnB = threadSchema.parse(await second.peer.request("thread/resume", { threadId, excludeTurns: true }));
    const listedInA = listSchema.parse(await second.peer.request("thread/list", {
      cwd: workspaceA, sourceKinds: allSources, limit: 100,
    }));
    const listedInB = listSchema.parse(await second.peer.request("thread/list", {
      cwd: workspaceB, sourceKinds: allSources, limit: 100,
    }));
    const listedGlobally = listSchema.parse(await second.peer.request("thread/list", { sourceKinds: allSources, limit: 100 }));

    report.passed = true;
    report.sameThreadId = [started.thread.id, resumedInB.thread.id, afterTurnA.thread.id, afterTurnB.thread.id]
      .every((id) => id === threadId);
    report.threadStartCwd = path.basename(started.thread.cwd);
    report.resumeOverrideCwd = path.basename(resumedInB.thread.cwd);
    report.afterTurnA = path.basename(afterTurnA.thread.cwd);
    report.afterTurnB = path.basename(afterTurnB.thread.cwd);
    report.threadListedUnderAAfterTurnB = listedInA.data.some((thread) => thread.id === threadId);
    report.threadListedUnderBAfterTurnB = listedInB.data.some((thread) => thread.id === threadId);
    report.threadListCwd = path.basename(listedGlobally.data.find((thread) => thread.id === threadId)?.cwd ?? "not-found");
    report.finding = "thread/resume cwd did not mutate the thread; turn/start cwd changed runtime cwd on the same thread ID, while thread/list kept the creation-workspace cwd association";
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (threadId && first) await first.peer.request("thread/delete", { threadId }).catch(() => undefined);
    await Promise.all([close(first), close(second)]);
    await supervisor.stop();
    protocolLog.write("harness", "meta", report);
    await protocolLog.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await Promise.all([rm(workspaceA, { recursive: true, force: true }), rm(workspaceB, { recursive: true, force: true })]);
  }
  process.stdout.write(`${JSON.stringify({ ...report, report: path.relative(process.cwd(), reportPath) })}\n`);
  if (!report.passed || !report.sameThreadId) process.exitCode = 1;
}

await main();
