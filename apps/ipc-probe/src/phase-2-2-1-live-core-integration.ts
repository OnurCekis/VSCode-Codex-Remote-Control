import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppServerCodexAdapter } from "../../../packages/codex-core/src/app-server-codex-adapter.js";
import type { CodexEvent } from "../../../packages/codex-core/src/domain-events.js";
import { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";
import { ClientEventLog } from "./client-event-log.js";
import { LoopbackWebSocketSupervisor } from "./loopback-websocket-supervisor.js";
import { ProtocolLog } from "./protocol-log.js";
import { resolvePinnedCodexExecutable } from "./pinned-vscode-runtime.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "./websocket-json-rpc.js";

const threadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function approval(threadId: string): (message: RpcMessage) => boolean {
  return (message) => "id" in message && message.method === "item/commandExecution/requestApproval" &&
    typeof message.params === "object" && message.params !== null && "threadId" in message.params &&
    message.params.threadId === threadId;
}

async function close(connection: WebSocketPeerConnection | null): Promise<void> {
  await connection?.close().catch(() => undefined);
}

async function main(): Promise<void> {
  const codexPath = await resolvePinnedCodexExecutable(process.cwd());
  const root = path.resolve(".codex-pocket", "phase-2-2-1-live-core");
  const workspace = path.join(root, "workspace");
  const logs = path.join(root, "logs");
  const marker = path.join(workspace, "approved.txt");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(logs, { recursive: true }), rm(marker, { force: true })]);
  const supervisor = new LoopbackWebSocketSupervisor({
    codexPath,
    codexHome: process.env.CODEX_POCKET_INTEGRATION_CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  });
  const protocolPath = path.join(logs, `${Date.now()}-protocol.jsonl`);
  const reportPath = path.join(logs, `${Date.now()}-report.json`);
  const log = new ProtocolLog(protocolPath, [supervisor.token]);
  let vscode: WebSocketPeerConnection | null = null;
  let pocketConnection: WebSocketPeerConnection | null = null;
  let restartedConnection: WebSocketPeerConnection | null = null;
  let core: PocketCore | null = null;
  let restartedCore: PocketCore | null = null;
  let threadId: string | null = null;
  const report: Record<string, unknown> = { phase: "2.2.1-live-core", passed: false };
  try {
    await supervisor.start();
    vscode = await connectWebSocketPeer({ url: supervisor.endpoint, token: supervisor.token, name: "VS Code", log });
    const vscodeEvents = new ClientEventLog(vscode.peer.messages());
    const started = threadSchema.parse(await vscode.peer.request("thread/start", {
      cwd: workspace, ephemeral: false, approvalPolicy: "untrusted", approvalsReviewer: "user",
      sandbox: "workspace-write",
    }));
    threadId = started.thread.id;
    const escapedMarker = marker.replaceAll("'", "''");
    const command = `powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${escapedMarker}' -Value 'joined-live'"`;
    const ownerTurn = turnSchema.parse(await vscode.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `Run exactly this shell command and do nothing else: ${command}` }],
      cwd: workspace, approvalPolicy: "untrusted", approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite", writableRoots: [workspace], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    }));
    await vscodeEvents.waitFor(approval(threadId), 180_000, "VS Code-owned approval");

    pocketConnection = await connectWebSocketPeer({ url: supervisor.endpoint, token: supervisor.token, name: "codex_pocket_core", log });
    core = new PocketCore(new AppServerCodexAdapter(pocketConnection.peer));
    const completed: CodexEvent[] = [];
    core.adapter.subscribe((event) => { if (event.type === "task.completed") completed.push(event); });
    const discovered = await core.sessions.discover({ cwd: workspace });
    const live = discovered.find((session) => session.id === threadId);
    if (!live || live.topology !== "sharedLive") throw new Error("Pocket did not classify the loaded owner thread as sharedLive.");
    const joined = await core.sessions.use(threadId);
    if (joined.id !== threadId || joined.topology !== "sharedLive") throw new Error("Pocket did not join the exact live thread.");
    const pending = await waitFor(() => core!.approvals.pending(threadId!)[0], 30_000, "replayed approval in core");
    core.approvals.approve(pending.id);
    await waitFor(
      () => completed.find((event) => event.type === "task.completed" && event.turnId === ownerTurn.turn.id),
      180_000,
      "VS Code-owned turn completion after Pocket approval",
    );
    if ((await readFile(marker, "utf8")).trim() !== "joined-live") throw new Error("Joined Pocket approval did not resume the owner turn.");
    await waitFor(() => core!.sessions.selected?.status.type === "idle" ? true : undefined, 30_000, "joined thread idle status");

    const pocketTurn = await core.tasks.send("Reply exactly LIVE_CORE_COPRESENCE_OK. Do not modify files.");
    await waitFor(
      () => completed.find((event) => event.type === "task.completed" && event.turnId === pocketTurn),
      180_000,
      "Pocket-started turn completion",
    );
    await core.close();
    core = null;
    pocketConnection = null;

    restartedConnection = await connectWebSocketPeer({ url: supervisor.endpoint, token: supervisor.token, name: "codex_pocket_core_restarted", log });
    restartedCore = new PocketCore(new AppServerCodexAdapter(restartedConnection.peer));
    const rediscovered = await restartedCore.sessions.discover({ cwd: workspace });
    const rediscoveredLive = rediscovered.find((session) => session.id === threadId);
    if (!rediscoveredLive || rediscoveredLive.topology !== "sharedLive") throw new Error("Restarted Pocket did not rediscover the live thread.");
    const rejoined = await restartedCore.sessions.use(threadId);
    if (rejoined.id !== threadId || rejoined.turns.length < 2) throw new Error("Restarted Pocket did not rejoin exact history.");

    report.passed = true;
    report.sameThreadId = rejoined.id === threadId;
    report.liveJoin = joined.topology;
    report.approvalReplayAndDecision = true;
    report.pocketTurnCompleted = true;
    report.restartRejoinedWithTurns = rejoined.turns.length;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (threadId && vscode) await vscode.peer.request("thread/delete", { threadId }).catch(() => undefined);
    await restartedCore?.close().catch(() => undefined);
    await core?.close().catch(() => undefined);
    await Promise.all([close(vscode), close(pocketConnection), close(restartedConnection)]);
    await supervisor.stop();
    log.write("harness", "meta", report);
    await log.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await Promise.all([rm(marker, { force: true }), rm(workspace, { recursive: true, force: true })]);
  }
  process.stdout.write(`${JSON.stringify({ ...report, report: path.relative(process.cwd(), reportPath) })}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
