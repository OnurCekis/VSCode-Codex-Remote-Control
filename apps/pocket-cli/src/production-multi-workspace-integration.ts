import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ClientEventLog } from "../../ipc-probe/src/client-event-log.js";
import { ProtocolLog } from "../../ipc-probe/src/protocol-log.js";
import { listLoadedThreadIds } from "../../ipc-probe/src/session-discovery.js";
import type { RpcMessage } from "../../ipc-probe/src/rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "../../ipc-probe/src/websocket-json-rpc.js";
import { connectPocketClient, type PocketClient } from "../../../packages/pocket-runtime/src/pocket-client.js";
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";

const runtimeSchema = z.object({
  id: z.string(), workspace: z.object({ path: z.string(), displayName: z.string() }), state: z.literal("connected"),
  appServerPid: z.number().int().positive(), bridgePid: z.number().int().positive(),
});
const statusSchema = z.object({
  state: z.literal("ready"), topology: z.literal("sharedAppServer"), verifiedAtMs: z.number(),
  appServerPid: z.number().int().positive(), runtimes: z.array(runtimeSchema),
});
const threadSchema = z.object({ thread: z.object({ id: z.string(), cwd: z.string() }).passthrough() });
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });

function eventFor(message: RpcMessage, threadId: string, turnId?: string): boolean {
  if (message.method !== "turn/completed" || typeof message.params !== "object" || message.params === null ||
    !("threadId" in message.params) || message.params.threadId !== threadId) return false;
  if (!turnId) return true;
  return "turn" in message.params && typeof message.params.turn === "object" && message.params.turn !== null &&
    "id" in message.params.turn && message.params.turn.id === turnId;
}

async function waitForPersisted(client: PocketClient, ids: Set<string>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sessions = await client.core.sessions.discover();
    if ([...ids].every((id) => sessions.some((session) => session.id === id && session.topology === "sharedLive"))) return;
    await delay(150);
  }
  throw new Error("Both exact live threads did not become discoverable.");
}

const runRoot = path.resolve(".codex-pocket", "phase-1");
const workspaceA = path.resolve(".");
const workspaceB = path.resolve(".codex-pocket", "fixtures", "workspace-B");
const logs = path.join(runRoot, "logs");
await mkdir(workspaceB, { recursive: true });
const timestamp = Date.now();
const reportPath = path.join(logs, `production-multi-workspace-${timestamp}-report.json`);
const connection = await readConnectionFile(path.join(runRoot, "connection.json"));
const protocol = new ProtocolLog(path.join(logs, `production-multi-workspace-${timestamp}-protocol.jsonl`), [connection.token]);
let pocket: PocketClient | null = null;
let ownerA: WebSocketPeerConnection | null = null;
let ownerB: WebSocketPeerConnection | null = null;
let threadA: string | null = null;
let threadB: string | null = null;
const report: Record<string, unknown> = { phase: "production-multi-workspace", passed: false };
try {
  pocket = await connectPocketClient({
    connection, clientName: "codex_pocket_multi_workspace_client",
    logPath: path.join(logs, `production-multi-workspace-${timestamp}-pocket.jsonl`),
  });
  if (!pocket.core.runtimes) throw new Error("Production connection does not expose workspace runtime control.");
  await pocket.core.workspaces.select(workspaceA);
  const runtimeA = await pocket.core.runtimes.findRuntimeForWorkspace(workspaceA);
  if (!runtimeA) throw new Error("Workspace A runtime is not connected.");
  const runtimeB = await pocket.core.runtimes.openWorkspace(workspaceB);
  const status = statusSchema.parse(JSON.parse(await readFile(path.join(runRoot, "host-status.json"), "utf8")));
  if (Date.now() - status.verifiedAtMs > 5_000) throw new Error("Production runtime status is stale.");
  if (runtimeA.appServerPid !== runtimeB.appServerPid || runtimeA.appServerPid !== status.appServerPid) {
    throw new Error("The two workspaces did not use the same Pocket App Server process.");
  }
  if (runtimeA.bridgePid === runtimeB.bridgePid) throw new Error("The two VS Code windows did not have distinct proxy bridges.");

  ownerA = await connectWebSocketPeer({ url: connection.endpoint, token: connection.token, name: "VS Code", log: protocol });
  ownerB = await connectWebSocketPeer({ url: connection.endpoint, token: connection.token, name: "VS Code", log: protocol });
  const eventsA = new ClientEventLog(ownerA.peer.messages());
  const eventsB = new ClientEventLog(ownerB.peer.messages());
  const startedA = threadSchema.parse(await ownerA.peer.request("thread/start", {
    cwd: workspaceA, ephemeral: false, approvalPolicy: "never", sandbox: "workspace-write",
  }));
  const startedB = threadSchema.parse(await ownerB.peer.request("thread/start", {
    cwd: workspaceB, ephemeral: false, approvalPolicy: "never", sandbox: "workspace-write",
  }));
  threadA = startedA.thread.id;
  threadB = startedB.thread.id;
  if (path.resolve(startedA.thread.cwd) !== workspaceA || path.resolve(startedB.thread.cwd) !== workspaceB) {
    throw new Error("App Server returned an incorrect workspace CWD.");
  }
  const seedA = turnSchema.parse(await ownerA.peer.request("turn/start", {
    threadId: threadA, cwd: workspaceA, input: [{ type: "text", text: "Reply exactly WORKSPACE_A_LIVE." }],
    approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  }));
  const seedB = turnSchema.parse(await ownerB.peer.request("turn/start", {
    threadId: threadB, cwd: workspaceB, input: [{ type: "text", text: "Reply exactly WORKSPACE_B_LIVE." }],
    approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  }));
  await Promise.all([
    eventsA.waitFor((message) => eventFor(message, threadA!, seedA.turn.id), 180_000, "workspace A seed completion"),
    eventsB.waitFor((message) => eventFor(message, threadB!, seedB.turn.id), 180_000, "workspace B seed completion"),
  ]);
  const loaded = await listLoadedThreadIds(ownerA.peer);
  if (!loaded.has(threadA) || !loaded.has(threadB)) throw new Error("Both exact thread IDs were not loaded on the shared server.");
  await waitForPersisted(pocket, new Set([threadA, threadB]));
  const sessionA = pocket.core.sessions.known.find((session) => session.id === threadA)!;
  const sessionB = pocket.core.sessions.known.find((session) => session.id === threadB)!;
  const mappedA = await pocket.core.runtimes.findRuntimeForThread(sessionA);
  const mappedB = await pocket.core.runtimes.findRuntimeForThread(sessionB);
  if (mappedA?.id !== runtimeA.id || mappedB?.id !== runtimeB.id) {
    throw new Error(`Exact thread-to-workspace-runtime mapping failed: ${JSON.stringify({
      expected: [runtimeA.id, runtimeB.id], actual: [mappedA?.id ?? null, mappedB?.id ?? null],
      cwd: [sessionA.cwd, sessionB.cwd], topology: [sessionA.topology, sessionB.topology],
    })}`);
  }

  await pocket.core.workspaces.select(workspaceA);
  await pocket.core.conversations.select(threadA);
  const pocketTurnA = await pocket.core.tasks.send("Reply exactly WORKSPACE_A_POCKET_OK.");
  await eventsA.waitFor((message) => eventFor(message, threadA!, pocketTurnA), 180_000, "Pocket turn A completion");
  await pocket.core.workspaces.select(workspaceB);
  await pocket.core.conversations.select(threadB);
  const pocketTurnB = await pocket.core.tasks.send("Reply exactly WORKSPACE_B_POCKET_OK.");
  await eventsB.waitFor((message) => eventFor(message, threadB!, pocketTurnB), 180_000, "Pocket turn B completion");
  await pocket.core.workspaces.select(workspaceA);
  await pocket.core.conversations.select(threadA);
  const returnTurnA = await pocket.core.tasks.send("Reply exactly WORKSPACE_A_RETURN_OK.");
  await eventsA.waitFor((message) => eventFor(message, threadA!, returnTurnA), 180_000, "Pocket return turn A completion");
  await delay(250);
  if (eventsB.messages.some((message) => eventFor(message, threadA!, pocketTurnA) || eventFor(message, threadA!, returnTurnA)) ||
      eventsA.messages.some((message) => eventFor(message, threadB!, pocketTurnB))) {
    throw new Error("A workspace owner received another workspace's Pocket turn.");
  }
  const finalRuntimes = await pocket.core.runtimes.listRuntimes();
  if (!finalRuntimes.some((runtime) => runtime.id === runtimeA.id) || !finalRuntimes.some((runtime) => runtime.id === runtimeB.id)) {
    throw new Error(`Workspace switching replaced a live runtime: ${JSON.stringify({
      expected: [runtimeA.id, runtimeB.id], actual: finalRuntimes.map((runtime) => runtime.id),
    })}`);
  }
  Object.assign(report, {
    passed: true, oneSharedAppServer: true, appServerPid: status.appServerPid,
    runtimeA: { workspace: runtimeA.workspace.displayName, bridgePid: runtimeA.bridgePid },
    runtimeB: { workspace: runtimeB.workspace.displayName, bridgePid: runtimeB.bridgePid },
    exactThreadRuntimeMapping: true, bothLoaded: true, switchingPreservedBoth: true,
    cwdIsolation: true, noCrossRouting: true, returnToA: true,
  });
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  if (threadA && ownerA) await ownerA.peer.request("thread/delete", { threadId: threadA }).catch(() => undefined);
  if (threadB && ownerB) await ownerB.peer.request("thread/delete", { threadId: threadB }).catch(() => undefined);
  await pocket?.close().catch(() => undefined);
  await Promise.all([ownerA?.close().catch(() => undefined), ownerB?.close().catch(() => undefined)]);
  await protocol.close();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ ...report, report: path.relative(process.cwd(), reportPath) })}\n`);
if (!report.passed) process.exitCode = 1;
