import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ClientEventLog } from "./client-event-log.js";
import { ProtocolLog } from "./protocol-log.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "./websocket-json-rpc.js";

const connectionSchema = z.object({ endpoint: z.string(), token: z.string() });
const threadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });
const unsubscribeSchema = z.object({ status: z.enum(["notLoaded", "notSubscribed", "unsubscribed"]) });

function approval(threadId: string): (message: RpcMessage) => boolean {
  return (message) => "id" in message && message.method === "item/commandExecution/requestApproval" &&
    typeof message.params === "object" && message.params !== null && "threadId" in message.params &&
    message.params.threadId === threadId;
}

function resolved(threadId: string): (message: RpcMessage) => boolean {
  return (message) => message.method === "serverRequest/resolved" && typeof message.params === "object" &&
    message.params !== null && "threadId" in message.params && message.params.threadId === threadId;
}

function completed(threadId: string, turnId: string): (message: RpcMessage) => boolean {
  return (message) => message.method === "turn/completed" && typeof message.params === "object" &&
    message.params !== null && "threadId" in message.params && message.params.threadId === threadId &&
    "turn" in message.params && typeof message.params.turn === "object" && message.params.turn !== null &&
    "id" in message.params.turn && message.params.turn.id === turnId;
}

async function runTurn(
  connection: WebSocketPeerConnection,
  events: ClientEventLog,
  threadId: string,
  text: string,
): Promise<string> {
  const result = turnSchema.parse(await connection.peer.request("turn/start", {
    threadId,
    input: [{ type: "text", text: `Reply exactly ${text}. Do not use tools.` }],
  }));
  await events.waitFor(completed(threadId, result.turn.id), 180_000, `${text} completion`);
  return result.turn.id;
}

async function attempt(operation: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const connectionPath = path.resolve(".codex-pocket", "phase-1", "connection.json");
  const descriptor = connectionSchema.parse(JSON.parse(await readFile(connectionPath, "utf8")));
  const logs = path.resolve(".codex-pocket", "phase-2-3", "writer-model");
  await mkdir(logs, { recursive: true });
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const protocolPath = path.join(logs, `${runId}-protocol.jsonl`);
  const reportPath = path.join(logs, `${runId}-report.json`);
  const protocol = new ProtocolLog(protocolPath, [descriptor.token]);
  const report: Record<string, unknown> = { phase: "2.3-writer-model", passed: false };
  let a: WebSocketPeerConnection | null = null;
  let b: WebSocketPeerConnection | null = null;
  let threadId: string | null = null;
  try {
    a = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "writer_model_a", log: protocol });
    b = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "writer_model_b", log: protocol });
    const aEvents = new ClientEventLog(a.peer.messages());
    const bEvents = new ClientEventLog(b.peer.messages());
    const started = threadSchema.parse(await a.peer.request("thread/start", { cwd: process.cwd(), ephemeral: false }));
    threadId = started.thread.id;

    await runTurn(a, aEvents, threadId, "WRITER_BASELINE_A");
    await b.peer.request("thread/read", { threadId, includeTurns: true });
    report.aAfterBRead = await attempt(async () => { await runTurn(a!, aEvents, threadId!, "WRITER_AFTER_READ_A"); });

    await b.peer.request("thread/resume", { threadId, excludeTurns: true });
    report.aAfterBResume = await attempt(async () => { await runTurn(a!, aEvents, threadId!, "WRITER_AFTER_RESUME_A"); });
    report.unsubscribe = unsubscribeSchema.parse(await b.peer.request("thread/unsubscribe", { threadId })).status;
    report.aAfterBUnsubscribe = await attempt(async () => { await runTurn(a!, aEvents, threadId!, "WRITER_AFTER_UNSUBSCRIBE_A"); });

    await b.peer.request("thread/resume", { threadId, excludeTurns: true });
    await b.close();
    b = null;
    report.aAfterBDisconnect = await attempt(async () => { await runTurn(a!, aEvents, threadId!, "WRITER_AFTER_DISCONNECT_A"); });

    b = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "writer_model_b_direct", log: protocol });
    void new ClientEventLog(b.peer.messages());
    report.bDirectTurnWithoutResume = await attempt(async () => { await runTurn(b!, aEvents, threadId!, "WRITER_DIRECT_B"); });
    await b.close();
    b = null;
    report.aAfterDirectBDisconnect = await attempt(async () => { await runTurn(a!, aEvents, threadId!, "WRITER_AFTER_DIRECT_B_A"); });

    b = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "writer_model_b_approval", log: protocol });
    const approvalEvents = new ClientEventLog(b.peer.messages());
    const escaped = path.join(process.cwd(), ".codex-pocket", "phase-2-3", "approval-marker.txt").replaceAll("'", "''");
    const approvalTurn = turnSchema.parse(await a.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `Run exactly this command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath '${escaped}' -Value approved\"` }],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }));
    const ownerRequest = await aEvents.waitFor(approval(threadId), 180_000, "owner approval");
    report.approvalVisibleWithoutResume = await attempt(async () => {
      await approvalEvents.waitFor(approval(threadId!), 2_000, "unsubscribed follower approval");
    });
    await b.peer.request("thread/resume", { threadId, excludeTurns: true });
    const replay = await approvalEvents.waitFor(approval(threadId), 15_000, "approval replay after resume");
    if (!("id" in replay)) throw new Error("Replayed approval lacked an RPC ID.");
    b.peer.respond(replay.id, { decision: "decline" });
    await approvalEvents.waitFor(resolved(threadId), 30_000, "follower approval resolution");
    report.approvalUnsubscribe = unsubscribeSchema.parse(await b.peer.request("thread/unsubscribe", { threadId })).status;
    await aEvents.waitFor(completed(threadId, approvalTurn.turn.id), 180_000, "declined approval turn completion");
    report.aAfterApprovalRelease = await attempt(async () => { await runTurn(a!, aEvents, threadId!, "WRITER_AFTER_APPROVAL_A"); });

    const interruptTurn = turnSchema.parse(await a.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Think silently for a long time before answering with INTERRUPT_TARGET." }],
    }));
    await aEvents.waitFor((message) => message.method === "turn/started" && typeof message.params === "object" &&
      message.params !== null && "threadId" in message.params && message.params.threadId === threadId &&
      "turn" in message.params && typeof message.params.turn === "object" && message.params.turn !== null &&
      "id" in message.params.turn && message.params.turn.id === interruptTurn.turn.id, 30_000, "interrupt target start");
    await b.peer.request("turn/interrupt", { threadId, turnId: interruptTurn.turn.id });
    await aEvents.waitFor(completed(threadId, interruptTurn.turn.id), 30_000, "interrupted turn completion");
    report.aAfterFollowerInterrupt = await attempt(async () => { await runTurn(a!, aEvents, threadId!, "WRITER_AFTER_INTERRUPT_A"); });

    if (!("id" in ownerRequest)) throw new Error("Owner approval lacked an RPC ID.");

    report.passed = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (threadId && a) await a.peer.request("thread/delete", { threadId }).catch(() => undefined);
    await Promise.all([a?.close().catch(() => undefined), b?.close().catch(() => undefined)]);
    protocol.write("harness", "meta", report);
    await protocol.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ ...report, report: path.relative(process.cwd(), reportPath) }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
