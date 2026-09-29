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
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";
import { AppServerCodexAdapter } from "../../../packages/codex-core/src/app-server-codex-adapter.js";
import { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";

const statusSchema = z.object({
  state: z.literal("ready"),
  topology: z.literal("sharedAppServer"),
  verifiedAtMs: z.number(),
  launcherLog: z.string(),
  workspace: z.string().nullable(),
  appServerPid: z.number().int().positive(),
  bridgePid: z.number().int().positive().nullable(),
  runtimes: z.array(z.object({
    workspace: z.object({ path: z.string() }), bridgePid: z.number().int().positive(), state: z.string(),
  })).optional(),
});
const threadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });

function hasThread(message: RpcMessage, threadId: string): boolean {
  if (typeof message.params !== "object" || message.params === null) return false;
  return "threadId" in message.params && message.params.threadId === threadId;
}

async function launcherBridgeInitialized(logPath: string, bridgePid: number): Promise<boolean> {
  const rows = (await readFile(logPath, "utf8")).split(/\r?\n/u).filter(Boolean);
  let bridge = false;
  let initialized = false;
  for (const line of rows) {
    try {
      const row = JSON.parse(line) as {
        bridgePid?: number;
        direction?: string;
        message?: RpcMessage & { event?: string; pid?: number };
      };
      if (row.direction === "meta" && row.message?.event === "bridge/start" && row.message.pid === bridgePid) bridge = true;
      if (row.bridgePid === bridgePid && row.direction === "in" && row.message && "id" in row.message &&
        row.message.id === "1" && "result" in row.message) initialized = true;
    } catch { /* Ignore a trailing partial append-only row. */ }
  }
  return bridge && initialized;
}

async function launcherRows(logPath: string): Promise<Array<{
  direction?: string;
  message?: RpcMessage & { event?: string; pid?: number };
}>> {
  return (await readFile(logPath, "utf8")).split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as { direction?: string; message?: RpcMessage & { event?: string; pid?: number } }]; }
    catch { return []; }
  });
}

async function liveBridgePid(logPath: string, status: z.infer<typeof statusSchema>): Promise<number> {
  const candidates = [
    ...(status.runtimes ?? []).filter((runtime) => runtime.state === "connected").map((runtime) => runtime.bridgePid),
    ...(status.bridgePid ? [status.bridgePid] : []),
  ];
  const rows = await launcherRows(logPath);
  for (const row of [...rows].reverse()) {
    const message = row.message;
    if (row.direction === "meta" && message?.event === "bridge/start" && typeof message.pid === "number") {
      candidates.push(message.pid);
    }
  }
  for (const pid of [...new Set(candidates)]) {
    try {
      process.kill(pid, 0);
      if (await launcherBridgeInitialized(logPath, pid)) return pid;
    } catch { /* Try the next verified bridge. */ }
  }
  throw new Error("No live initialized pinned extension bridge was found.");
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function close(connection: WebSocketPeerConnection | null): Promise<void> {
  await connection?.close().catch(() => undefined);
}

const runRoot = path.resolve(".codex-pocket", "phase-1");
const logRoot = path.join(runRoot, "logs");
await mkdir(logRoot, { recursive: true });
const reportPath = path.join(logRoot, `production-topology-${Date.now()}-report.json`);
const protocolPath = path.join(logRoot, `production-topology-${Date.now()}-protocol.jsonl`);
const status = statusSchema.parse(JSON.parse(await readFile(path.join(runRoot, "host-status.json"), "utf8")));
if (Date.now() - status.verifiedAtMs > 5_000) throw new Error("Production VS Code topology heartbeat is stale.");
const bridgePid = await liveBridgePid(status.launcherLog, status);
const workspace = status.runtimes?.find((runtime) => runtime.bridgePid === bridgePid)?.workspace.path ?? status.workspace ?? process.cwd();
const connection = await readConnectionFile(path.join(runRoot, "connection.json"));
const log = new ProtocolLog(protocolPath, [connection.token]);
let owner: WebSocketPeerConnection | null = null;
let pocketConnection: WebSocketPeerConnection | null = null;
let core: PocketCore | null = null;
let threadId: string | null = null;
const report: Record<string, unknown> = {
  phase: "production-shared-topology", passed: false,
  appServerPid: status.appServerPid, bridgePid,
};
try {
  // This controlled owner uses the same public VS Code protocol identity while
  // the real pinned extension remains connected through the production bridge.
  owner = await connectWebSocketPeer({ url: connection.endpoint, token: connection.token, name: "VS Code", log });
  const ownerEvents = new ClientEventLog(owner.peer.messages());
  const started = threadSchema.parse(await owner.peer.request("thread/start", {
    cwd: workspace, ephemeral: false, approvalPolicy: "never", sandbox: "workspace-write",
  }));
  threadId = started.thread.id;
  const firstTurn = turnSchema.parse(await owner.peer.request("turn/start", {
    threadId, cwd: workspace,
    input: [{ type: "text", text: "Reply exactly PRODUCTION_TOPOLOGY_OWNER_OK." }],
    approvalPolicy: "never", sandboxPolicy: {
      type: "workspaceWrite", writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
  }));

  pocketConnection = await connectWebSocketPeer({
    url: connection.endpoint, token: connection.token, name: "codex_pocket_production_client_b", log,
  });
  core = new PocketCore(new AppServerCodexAdapter(pocketConnection.peer));
  if (!(await listLoadedThreadIds(pocketConnection.peer)).has(threadId)) {
    throw new Error("Production Client B did not observe the exact owner thread in thread/loaded/list.");
  }
  await waitFor(async () => {
    const discovered = await core!.sessions.discover({ cwd: workspace });
    return discovered.some((session) => session.id === threadId && session.topology === "sharedLive");
  }, 10_000, "the new owner thread becoming visible in persisted thread/list");
  const joined = await core.sessions.use(threadId);
  if (joined.id !== threadId || joined.topology !== "sharedLive") throw new Error("Production Client B did not join the exact live thread.");
  await ownerEvents.waitFor(
    (message) => message.method === "turn/completed" && hasThread(message, threadId!),
    180_000, "controlled owner turn completion",
  );
  await waitFor(async () => core!.sessions.selected?.activeTurnId === null, 5_000, "Pocket observing owner turn completion");
  const ownerAfterSelection = turnSchema.parse(await owner.peer.request("turn/start", {
    threadId, cwd: workspace, input: [{ type: "text", text: "Reply exactly OWNER_AFTER_POCKET_SELECTION_OK." }],
    approvalPolicy: "never",
  }));
  await ownerEvents.waitFor(
    (message) => message.method === "turn/completed" && hasThread(message, threadId!) &&
      typeof message.params === "object" && message.params !== null && "turn" in message.params &&
      typeof message.params.turn === "object" && message.params.turn !== null && "id" in message.params.turn &&
      message.params.turn.id === ownerAfterSelection.turn.id,
    180_000, "owner turn after Pocket selection",
  );
  await waitFor(async () => core!.sessions.selected?.activeTurnId === null, 10_000, "Pocket observing post-selection owner completion");
  const pocketTurnId = await core.tasks.send("Reply exactly PRODUCTION_TOPOLOGY_POCKET_OK.");
  await ownerEvents.waitFor(
    (message) => message.method === "turn/completed" && hasThread(message, threadId!) &&
      typeof message.params === "object" && message.params !== null && "turn" in message.params &&
      typeof message.params.turn === "object" && message.params.turn !== null && "id" in message.params.turn &&
      message.params.turn.id === pocketTurnId,
    180_000, "Pocket-originated turn on owner connection",
  );
  await waitFor(async () => core!.sessions.selected?.activeTurnId === null, 10_000, "Pocket-originated task terminal state");
  const ownerAfterPocket = turnSchema.parse(await owner.peer.request("turn/start", {
    threadId, cwd: workspace, input: [{ type: "text", text: "Reply exactly OWNER_AFTER_POCKET_TURN_OK." }],
    approvalPolicy: "never",
  }));
  await ownerEvents.waitFor(
    (message) => message.method === "turn/completed" && hasThread(message, threadId!) &&
      typeof message.params === "object" && message.params !== null && "turn" in message.params &&
      typeof message.params.turn === "object" && message.params.turn !== null && "id" in message.params.turn &&
      message.params.turn.id === ownerAfterPocket.turn.id,
    180_000, "owner turn after Pocket-originated turn",
  );
  const finalStatus = statusSchema.parse(JSON.parse(await readFile(path.join(runRoot, "host-status.json"), "utf8")));
  if (Date.now() - finalStatus.verifiedAtMs > 5_000 || !(await launcherBridgeInitialized(finalStatus.launcherLog, bridgePid))) {
    throw new Error("Real pinned extension bridge did not remain continuously verified during the production test.");
  }
  report.passed = true;
  report.sameThreadId = true;
  report.loadedOnClientB = true;
  report.liveJoin = joined.topology;
  report.ownerSawPocketTurn = true;
  report.ownerWritableAfterPocketSelection = true;
  report.ownerWritableAfterPocketTurn = true;
  report.realExtensionBridgeContinuouslyVerified = true;
  report.ownerTurnId = firstTurn.turn.id;
  report.pocketTurnId = pocketTurnId;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  if (threadId && owner) await owner.peer.request("thread/delete", { threadId }).catch(() => undefined);
  await core?.close().catch(() => undefined);
  await Promise.all([close(owner), close(pocketConnection)]);
  log.write("integration", "meta", report);
  await log.close();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ ...report, report: path.relative(process.cwd(), reportPath) })}\n`);
if (!report.passed) process.exitCode = 1;
