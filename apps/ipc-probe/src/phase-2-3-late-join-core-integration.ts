import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppServerCodexAdapter } from "../../../packages/codex-core/src/app-server-codex-adapter.js";
import { LiveOutputManager, type LiveOutputEvent } from "../../../packages/codex-core/src/live-output-manager.js";
import { ClientEventLog } from "./client-event-log.js";
import { ProtocolLog } from "./protocol-log.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "./websocket-json-rpc.js";

const connectionSchema = z.object({ endpoint: z.string(), token: z.string() });
const threadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });

function deltaText(events: ClientEventLog, threadId: string, turnId: string): string {
  return events.messages.flatMap((message) => message.method === "item/agentMessage/delta" && typeof message.params === "object" &&
    message.params !== null && "threadId" in message.params && message.params.threadId === threadId &&
    "turnId" in message.params && message.params.turnId === turnId && "delta" in message.params && typeof message.params.delta === "string"
    ? [message.params.delta] : []).join("");
}

function completed(threadId: string, turnId: string): (message: RpcMessage) => boolean {
  return (message) => message.method === "turn/completed" && typeof message.params === "object" && message.params !== null &&
    "threadId" in message.params && message.params.threadId === threadId && "turn" in message.params &&
    typeof message.params.turn === "object" && message.params.turn !== null && "id" in message.params.turn && message.params.turn.id === turnId;
}

async function waitFor(check: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function main(): Promise<void> {
  const descriptor = connectionSchema.parse(JSON.parse(await readFile(path.resolve(".codex-pocket", "phase-1", "connection.json"), "utf8")));
  const outputRoot = path.resolve(".codex-pocket", "phase-2-3", "late-join-core");
  await mkdir(outputRoot, { recursive: true });
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const reportPath = path.join(outputRoot, `${runId}-report.json`);
  const protocol = new ProtocolLog(path.join(outputRoot, `${runId}-protocol.jsonl`), [descriptor.token]);
  const report: Record<string, unknown> = { phase: "2.3-late-join-core", passed: false };
  let owner: WebSocketPeerConnection | null = null;
  let follower: WebSocketPeerConnection | null = null;
  let adapter: AppServerCodexAdapter | null = null;
  let liveOutput: LiveOutputManager | null = null;
  let threadId: string | null = null;
  try {
    owner = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "late_join_core_owner", log: protocol });
    follower = await connectWebSocketPeer({ url: descriptor.endpoint, token: descriptor.token, name: "late_join_core_follower", log: protocol });
    const ownerEvents = new ClientEventLog(owner.peer.messages());
    adapter = new AppServerCodexAdapter(follower.peer);
    liveOutput = new LiveOutputManager(adapter, "late-join-runtime");
    const liveEvents: LiveOutputEvent[] = [];
    liveOutput.subscribe((event) => liveEvents.push(event));
    const thread = threadSchema.parse(await owner.peer.request("thread/start", { cwd: process.cwd(), ephemeral: false }));
    threadId = thread.thread.id;
    const turn = turnSchema.parse(await owner.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Output exactly BEFORE_JOIN_MARKER on its own line. Then run exactly this command: powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 15\". After it finishes, output exactly AFTER_JOIN_MARKER on its own line." }],
      cwd: process.cwd(), approvalPolicy: "never", approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }));
    report.threadId = threadId;
    report.turnId = turn.turn.id;
    await waitFor(() => deltaText(ownerEvents, threadId!, turn.turn.id).includes("BEFORE_JOIN_MARKER"), 180_000, "owner BEFORE_JOIN marker");
    await delay(1_000);
    const identity = { runtimeId: "late-join-runtime", threadId, turnId: turn.turn.id };
    await liveOutput.observeActiveTurn(identity);
    const bootstrapText = liveOutput.snapshot(identity) ?? "";
    report.bootstrapHasBefore = bootstrapText.includes("BEFORE_JOIN_MARKER");
    await waitFor(() => (liveOutput!.snapshot(identity) ?? "").includes("AFTER_JOIN_MARKER") &&
      !liveEvents.some((event) => event.type === "turn.finished" && event.turnId === turn.turn.id),
    180_000, "Core AFTER_JOIN marker while turn remains active");
    const afterVisibleBeforeCompletion = true;
    await waitFor(() => liveEvents.some((event) => event.type === "turn.finished" && event.turnId === turn.turn.id), 180_000, "Core terminal event");
    const finishedIndex = liveEvents.findIndex((event) => event.type === "turn.finished" && event.turnId === turn.turn.id);
    const finished = liveEvents[finishedIndex] as Extract<LiveOutputEvent, { type: "turn.finished" }>;
    report.coreStream = {
      before: finished.text.includes("BEFORE_JOIN_MARKER"),
      after: finished.text.includes("AFTER_JOIN_MARKER"),
      afterVisibleBeforeCompletion,
      outcome: finished.outcome,
    };
    await delay(250);
    const next = turnSchema.parse(await owner.peer.request("turn/start", {
      threadId, input: [{ type: "text", text: "Reply exactly OWNER_WRITABLE_AFTER_LATE_JOIN." }],
      approvalPolicy: "never",
    }));
    await ownerEvents.waitFor(completed(threadId, next.turn.id), 180_000, "owner next turn completion");
    report.ownerWritableAfterObserver = true;
    report.passed = report.bootstrapHasBefore === true && afterVisibleBeforeCompletion &&
      finished.text.includes("BEFORE_JOIN_MARKER") && finished.text.includes("AFTER_JOIN_MARKER") && finished.outcome === "completed";
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    liveOutput?.close();
    if (adapter) await adapter.close().catch(() => undefined);
    else await follower?.close().catch(() => undefined);
    if (threadId && owner) await owner.peer.request("thread/delete", { threadId }).catch(() => undefined);
    await owner?.close().catch(() => undefined);
    protocol.write("harness", "meta", report);
    await protocol.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ ...report, report: path.relative(process.cwd(), reportPath) }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
