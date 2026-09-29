import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ClientEventLog } from "./client-event-log.js";
import { ProtocolLog } from "./protocol-log.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "./websocket-json-rpc.js";

const connectionSchema = z.object({ endpoint: z.string(), token: z.string() });
const threadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });

function delta(threadId: string, turnId: string): (message: RpcMessage) => boolean {
  return (message) => message.method === "item/agentMessage/delta" && typeof message.params === "object" &&
    message.params !== null && "threadId" in message.params && message.params.threadId === threadId &&
    "turnId" in message.params && message.params.turnId === turnId;
}

function completed(threadId: string, turnId: string): (message: RpcMessage) => boolean {
  return (message) => message.method === "turn/completed" && typeof message.params === "object" &&
    message.params !== null && "threadId" in message.params && message.params.threadId === threadId &&
    "turn" in message.params && typeof message.params.turn === "object" && message.params.turn !== null &&
    "id" in message.params.turn && message.params.turn.id === turnId;
}

function agentText(snapshot: unknown, turnId: string): string {
  if (!snapshot || typeof snapshot !== "object") return "";
  const record = snapshot as Record<string, unknown>;
  const turns = Array.isArray(record.data) ? record.data :
    record.thread && typeof record.thread === "object" && Array.isArray((record.thread as Record<string, unknown>).turns)
      ? (record.thread as Record<string, unknown>).turns as unknown[] : [];
  const turn = turns.find((candidate) => candidate && typeof candidate === "object" &&
    (candidate as Record<string, unknown>).id === turnId) as Record<string, unknown> | undefined;
  if (!turn || !Array.isArray(turn.items)) return "";
  return turn.items.flatMap((item) => item && typeof item === "object" &&
    (item as Record<string, unknown>).type === "agentMessage" && typeof (item as Record<string, unknown>).text === "string"
    ? [(item as Record<string, unknown>).text as string] : []).join("");
}

function accumulatedDeltas(events: ClientEventLog, threadId: string, turnId: string): string {
  return events.messages.filter(delta(threadId, turnId)).flatMap((message) =>
    typeof message.params === "object" && message.params !== null && "delta" in message.params && typeof message.params.delta === "string"
      ? [message.params.delta] : []).join("");
}

async function waitForAccumulatedMarker(
  events: ClientEventLog,
  threadId: string,
  turnId: string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (accumulatedDeltas(events, threadId, turnId).includes(marker)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for accumulated ${marker}.`);
}

async function main(): Promise<void> {
  const descriptor = connectionSchema.parse(JSON.parse(await readFile(path.resolve(".codex-pocket", "phase-1", "connection.json"), "utf8")));
  const outputRoot = path.resolve(".codex-pocket", "phase-2-3", "late-join-protocol");
  await mkdir(outputRoot, { recursive: true });
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const reportPath = path.join(outputRoot, `${runId}-report.json`);
  const protocol = new ProtocolLog(path.join(outputRoot, `${runId}-protocol.jsonl`), [descriptor.token]);
  const report: Record<string, unknown> = { phase: "2.3-late-join-protocol", passed: false };
  let owner: WebSocketPeerConnection | null = null;
  let follower: WebSocketPeerConnection | null = null;
  let threadId: string | null = null;
  try {
    owner = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "late_join_owner", log: protocol });
    follower = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "late_join_follower", log: protocol });
    const ownerEvents = new ClientEventLog(owner.peer.messages());
    const followerEvents = new ClientEventLog(follower.peer.messages());
    const started = threadSchema.parse(await owner.peer.request("thread/start", { cwd: process.cwd(), ephemeral: false }));
    threadId = started.thread.id;
    const turn = turnSchema.parse(await owner.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Output exactly BEFORE_JOIN_MARKER on its own line. Then run exactly this command: powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 15\". After it finishes, output exactly AFTER_JOIN_MARKER on its own line." }],
      cwd: process.cwd(),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }));
    report.threadId = threadId;
    report.turnId = turn.turn.id;
    await waitForAccumulatedMarker(ownerEvents, threadId, turn.turn.id, "BEFORE_JOIN_MARKER", 180_000);
    await delay(1_000);
    report.followerBeforeJoinMethods = [...new Set(followerEvents.messages.map((message) => message.method))];

    await follower.peer.request("thread/resume", { threadId, excludeTurns: true });
    const turnsDuring = await follower.peer.request("thread/turns/list", {
      threadId, limit: 20, sortDirection: "desc", itemsView: "full",
    });
    const readDuring = await follower.peer.request("thread/read", { threadId, includeTurns: true });
    const turnsText = agentText(turnsDuring, turn.turn.id);
    const readText = agentText(readDuring, turn.turn.id);
    report.turnsListDuring = { hasBefore: turnsText.includes("BEFORE_JOIN_MARKER"), length: turnsText.length };
    report.threadReadDuring = { hasBefore: readText.includes("BEFORE_JOIN_MARKER"), length: readText.length };

    await waitForAccumulatedMarker(followerEvents, threadId, turn.turn.id, "AFTER_JOIN_MARKER", 180_000);
    await followerEvents.waitFor(completed(threadId, turn.turn.id), 180_000, "follower completion");
    const afterJoinText = accumulatedDeltas(followerEvents, threadId, turn.turn.id);
    const finalSnapshot = await follower.peer.request("thread/turns/list", {
      threadId, limit: 20, sortDirection: "desc", itemsView: "full",
    });
    const finalText = agentText(finalSnapshot, turn.turn.id);
    report.followerAfterJoin = {
      hasBeforeDelta: afterJoinText.includes("BEFORE_JOIN_MARKER"),
      hasAfterDelta: afterJoinText.includes("AFTER_JOIN_MARKER"),
      completed: true,
    };
    report.finalSnapshot = {
      hasBefore: finalText.includes("BEFORE_JOIN_MARKER"),
      hasAfter: finalText.includes("AFTER_JOIN_MARKER"),
      length: finalText.length,
    };
    report.unsubscribe = await follower.peer.request("thread/unsubscribe", { threadId });
    report.passed = (turnsText.includes("BEFORE_JOIN_MARKER") || readText.includes("BEFORE_JOIN_MARKER")) &&
      afterJoinText.includes("AFTER_JOIN_MARKER") && finalText.includes("BEFORE_JOIN_MARKER") && finalText.includes("AFTER_JOIN_MARKER");
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (threadId && owner) await owner.peer.request("thread/delete", { threadId }).catch(() => undefined);
    await Promise.all([owner?.close().catch(() => undefined), follower?.close().catch(() => undefined)]);
    protocol.write("harness", "meta", report);
    await protocol.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ ...report, report: path.relative(process.cwd(), reportPath) }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
