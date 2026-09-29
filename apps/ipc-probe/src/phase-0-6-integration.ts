import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { ApprovalManager } from "./approvals.js";
import { ClientEventLog } from "./client-event-log.js";
import { LoopbackWebSocketSupervisor } from "./loopback-websocket-supervisor.js";
import { ProtocolLog } from "./protocol-log.js";
import { resolvePinnedCodexExecutable } from "./pinned-vscode-runtime.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, expectWebSocketRejected, type WebSocketPeerConnection } from "./websocket-json-rpc.js";

const threadResponseSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const turnResponseSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });
const loadedListSchema = z.object({ data: z.array(z.string()), nextCursor: z.string().nullable() });

interface GateReport {
  phase: "0.6";
  passed: boolean;
  failure?: string;
  transport: {
    readyz: boolean;
    loopbackOnly: boolean;
    noTokenRejected: boolean;
    incorrectTokenRejected: boolean;
    correctTokenInitialized: boolean;
    clientAConnected: boolean;
    clientBConnected: boolean;
  };
  thread: {
    discoveredByB: boolean;
    resumedByB: boolean;
    threadId?: string;
    turnId?: string;
    clientAEvents: string[];
    clientBEvents: string[];
  };
  approval: {
    visibleToA: boolean;
    visibleToB: boolean;
    replayedAfterBAttach: boolean;
    bAllowedToAnswer: boolean;
    originalTurnResumed: boolean;
    markerCreated: boolean;
  };
  protocolLog: string;
}

function threadMethod(method: string, threadId: string): (message: RpcMessage) => boolean {
  return (message) => {
    if (message.method !== method) return false;
    const params = message.params;
    return typeof params === "object" && params !== null && "threadId" in params && params.threadId === threadId;
  };
}

function approvalMethod(threadId: string): (message: RpcMessage) => boolean {
  return (message) => "id" in message &&
    message.method === "item/commandExecution/requestApproval" &&
    threadMethod(message.method, threadId)(message);
}

function relevantEvents(log: ClientEventLog, threadId: string): string[] {
  const methods = log.messages
    .filter((message) => {
      if (!/^(?:thread|turn|item|serverRequest)\//u.test(message.method)) return false;
      const params = message.params;
      return typeof params === "object" && params !== null && "threadId" in params && params.threadId === threadId;
    })
    .map((message) => message.method);
  return [...new Set(methods)].sort();
}

async function closeConnection(connection: WebSocketPeerConnection | null): Promise<void> {
  await connection?.close().catch(() => undefined);
}

async function main(): Promise<void> {
  const codexPath = await resolvePinnedCodexExecutable(process.cwd());
  const codexHome = process.env.CODEX_POCKET_INTEGRATION_CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const fixture = path.resolve(".codex-pocket", "phase-0-6-fixture");
  const logDirectory = path.resolve(".codex-pocket", "phase-0-6-logs");
  await Promise.all([mkdir(fixture, { recursive: true }), mkdir(logDirectory, { recursive: true })]);
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const protocolLogPath = path.join(logDirectory, `${runId}-protocol.jsonl`);
  const reportPath = path.join(logDirectory, `${runId}-report.json`);
  const marker = path.join(fixture, "cross-client-approved.txt");
  await rm(marker, { force: true });

  const supervisor = new LoopbackWebSocketSupervisor({ codexPath, codexHome });
  const protocolLog = new ProtocolLog(protocolLogPath, [supervisor.token]);
  const report: GateReport = {
    phase: "0.6",
    passed: false,
    transport: {
      readyz: false,
      loopbackOnly: false,
      noTokenRejected: false,
      incorrectTokenRejected: false,
      correctTokenInitialized: false,
      clientAConnected: false,
      clientBConnected: false,
    },
    thread: {
      discoveredByB: false,
      resumedByB: false,
      clientAEvents: [],
      clientBEvents: [],
    },
    approval: {
      visibleToA: false,
      visibleToB: false,
      replayedAfterBAttach: false,
      bAllowedToAnswer: false,
      originalTurnResumed: false,
      markerCreated: false,
    },
    protocolLog: path.relative(process.cwd(), protocolLogPath),
  };
  let clientA: WebSocketPeerConnection | null = null;
  let clientB: WebSocketPeerConnection | null = null;
  let aLog: ClientEventLog | null = null;
  let bLog: ClientEventLog | null = null;
  let aApprovals: ApprovalManager | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let ownerApprovalRequestId: string | number | null = null;
  let createdThread = false;

  try {
    await supervisor.start();
    report.transport.readyz = true;
    report.transport.loopbackOnly = true;

    const noTokenStatus = await expectWebSocketRejected(supervisor.endpoint, undefined);
    if (noTokenStatus !== 401 && noTokenStatus !== 403) {
      throw new Error(`No-token WebSocket was not rejected with HTTP 401/403 (observed ${String(noTokenStatus)}).`);
    }
    report.transport.noTokenRejected = true;

    const wrongTokenStatus = await expectWebSocketRejected(supervisor.endpoint, "incorrect-phase-0-6-token");
    if (wrongTokenStatus !== 401 && wrongTokenStatus !== 403) {
      throw new Error(`Incorrect-token WebSocket was not rejected with HTTP 401/403 (observed ${String(wrongTokenStatus)}).`);
    }
    report.transport.incorrectTokenRejected = true;

    clientA = await connectWebSocketPeer({
      url: supervisor.endpoint,
      token: supervisor.token,
      name: "codex_pocket_phase_0_6_a",
      log: protocolLog,
      timeoutMs: 30_000,
    });
    report.transport.correctTokenInitialized = true;
    report.transport.clientAConnected = true;
    aLog = new ClientEventLog(clientA.peer.messages());
    aApprovals = new ApprovalManager(clientA.peer);

    clientB = await connectWebSocketPeer({
      url: supervisor.endpoint,
      token: supervisor.token,
      name: "codex_pocket_phase_0_6_b",
      log: protocolLog,
      timeoutMs: 30_000,
    });
    report.transport.clientBConnected = true;
    bLog = new ClientEventLog(clientB.peer.messages());

    // A successful request after B initializes proves A remained live during co-presence.
    loadedListSchema.parse(await clientA.peer.request("thread/loaded/list", { limit: 100 }));

    const started = threadResponseSchema.parse(await clientA.peer.request("thread/start", {
      cwd: fixture,
      ephemeral: false,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    }));
    threadId = started.thread.id;
    createdThread = true;
    report.thread.threadId = threadId;

    const escapedMarker = marker.replaceAll("'", "''");
    const command = `powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${escapedMarker}' -Value 'phase-0-6-approved'"`;
    const turn = turnResponseSchema.parse(await clientA.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `Run exactly this shell command and do nothing else: ${command}` }],
      cwd: fixture,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [fixture],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    }));
    turnId = turn.turn.id;
    report.thread.turnId = turnId;

    const ownerApprovalMessage = await aLog.waitFor(
      approvalMethod(threadId),
      180_000,
      "Client A command approval",
    );
    const ownerApproval = aApprovals.observe(ownerApprovalMessage);
    if (!ownerApproval) throw new Error("Client A approval failed exact protocol validation.");
    ownerApprovalRequestId = ownerApproval.requestId;
    report.approval.visibleToA = true;

    // B is intentionally attached only after A's approval is already pending.
    const loaded = loadedListSchema.parse(await clientB.peer.request("thread/loaded/list", { limit: 100 }));
    if (!loaded.data.includes(threadId)) throw new Error("Client B could not discover A's running thread via thread/loaded/list.");
    report.thread.discoveredByB = true;
    const resumed = threadResponseSchema.parse(await clientB.peer.request("thread/resume", {
      threadId,
      excludeTurns: true,
    }));
    if (resumed.thread.id !== threadId) throw new Error("Client B resumed a different thread ID.");
    report.thread.resumedByB = true;

    let followerApprovalMessage: RpcMessage;
    try {
      followerApprovalMessage = await bLog.waitFor(
        approvalMethod(threadId),
        15_000,
        "approval replay to late-attaching Client B",
      );
    } catch {
      aApprovals.decide(ownerApproval.requestId, "decline");
      throw new Error("WebSocket co-presence succeeded, but the pending approval was not replayed to late-attaching Client B.");
    }
    report.approval.visibleToB = true;
    report.approval.replayedAfterBAttach = true;
    const bApprovals = new ApprovalManager(clientB.peer);
    const followerApproval = bApprovals.observe(followerApprovalMessage);
    if (!followerApproval) throw new Error("Client B approval failed exact protocol validation.");
    bApprovals.decide(followerApproval.requestId, "accept");

    await Promise.all([
      aLog.waitFor(threadMethod("serverRequest/resolved", threadId), 30_000, "A serverRequest/resolved"),
      bLog.waitFor(threadMethod("serverRequest/resolved", threadId), 30_000, "B serverRequest/resolved"),
    ]);
    report.approval.bAllowedToAnswer = true;

    await Promise.all([
      aLog.waitFor(threadMethod("turn/completed", threadId), 180_000, "A original turn/completed"),
      bLog.waitFor(threadMethod("turn/completed", threadId), 180_000, "B original turn/completed"),
    ]);
    report.approval.originalTurnResumed = true;
    const markerContents = (await readFile(marker, "utf8")).trim();
    if (markerContents !== "phase-0-6-approved") {
      throw new Error("Client B's approval decision did not produce the controlled marker.");
    }
    report.approval.markerCreated = true;
    report.passed = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    if (threadId && turnId && clientA) {
      if (ownerApprovalRequestId !== null && aApprovals?.pending().length) {
        try { aApprovals.decide(ownerApprovalRequestId, "decline"); } catch { /* already resolved */ }
      }
      await clientA.peer.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    }
  } finally {
    if (threadId) {
      if (aLog) report.thread.clientAEvents = relevantEvents(aLog, threadId);
      if (bLog) report.thread.clientBEvents = relevantEvents(bLog, threadId);
    }
    if (createdThread && threadId && clientA) {
      await clientA.peer.request("thread/delete", { threadId }).catch(() => undefined);
    }
    await Promise.all([closeConnection(clientA), closeConnection(clientB)]);
    await supervisor.stop();
    protocolLog.write("harness", "meta", report);
    await protocolLog.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  console.log(JSON.stringify({ ...report, protocolLog: report.protocolLog, report: path.relative(process.cwd(), reportPath) }));
  if (!report.passed) process.exitCode = 1;
}

await main();
