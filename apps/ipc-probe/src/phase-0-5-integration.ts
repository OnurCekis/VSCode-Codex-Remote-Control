import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { ApprovalManager } from "./approvals.js";
import { ClientEventLog } from "./client-event-log.js";
import { NativeSocketSupervisor, type NativeSocketConnection } from "./native-socket-supervisor.js";
import { resolvePinnedCodexExecutable } from "./pinned-vscode-runtime.js";
import type { RpcMessage } from "./rpc-types.js";

const threadResponseSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const turnResponseSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });

function isMethod(method: string, threadId?: string): (message: RpcMessage) => boolean {
  return (message) => {
    if (message.method !== method) return false;
    if (!threadId) return true;
    const params = message.params;
    return typeof params === "object" && params !== null && "threadId" in params && params.threadId === threadId;
  };
}

async function createSupervisor(mode: "transport" | "approval"): Promise<NativeSocketSupervisor> {
  const codexPath = await resolvePinnedCodexExecutable(process.cwd());
  const codexHome = mode === "approval"
    ? (process.env.CODEX_POCKET_INTEGRATION_CODEX_HOME ?? path.join(os.homedir(), ".codex"))
    : path.resolve(".codex-pocket", "phase-0-5-home");
  await mkdir(codexHome, { recursive: true });
  const supervisor = new NativeSocketSupervisor({
    codexPath,
    codexHome,
    socketPath: path.join(os.tmpdir(), `cp-p05-${process.pid}.sock`),
  });
  await supervisor.start();
  return supervisor;
}

async function transportTest(supervisor: NativeSocketSupervisor): Promise<void> {
  const first = await supervisor.connect("codex_pocket_transport_a");
  const second = await supervisor.connect("codex_pocket_transport_b");
  const secondLog = new ClientEventLog(second.peer.messages());
  try {
    const started = threadResponseSchema.parse(await first.peer.request("thread/start", {
      cwd: path.resolve(".codex-pocket"),
      ephemeral: true,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    }));
    await second.peer.request("thread/resume", { threadId: started.thread.id, excludeTurns: true });
    await first.peer.request("thread/name/set", {
      threadId: started.thread.id,
      name: "phase-0-5-transport",
    });
    await secondLog.waitFor(
      isMethod("thread/name/updated", started.thread.id),
      10_000,
      "cross-client thread/name/updated",
    );
    const loaded = z.object({ data: z.array(z.string()) }).parse(
      await second.peer.request("thread/loaded/list", { limit: 100 }),
    );
    if (!loaded.data.includes(started.thread.id)) {
      throw new Error("Second client did not observe the shared loaded thread.");
    }
    console.log(JSON.stringify({
      gate: "native-transport",
      passed: true,
      clients: 2,
      sharedThread: true,
      crossClientNotification: "thread/name/updated",
      socket: supervisor.socketArgument,
    }));
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

async function approvalTest(supervisor: NativeSocketSupervisor): Promise<void> {
  const fixture = path.resolve(".codex-pocket", "phase-0-5-fixture");
  const marker = path.join(fixture, "approval-proof.txt");
  await mkdir(fixture, { recursive: true });
  const first = await supervisor.connect("codex_pocket_approval_owner", 30_000);
  const second = await supervisor.connect("codex_pocket_approval_follower", 30_000);
  await runApprovalScenario(first, second, fixture, marker);
}

async function runApprovalScenario(
  first: NativeSocketConnection,
  second: NativeSocketConnection,
  fixture: string,
  marker: string,
): Promise<void> {
  const firstLog = new ClientEventLog(first.peer.messages());
  const secondLog = new ClientEventLog(second.peer.messages());
  const secondApprovals = new ApprovalManager(second.peer);
  let threadId: string | null = null;
  let turnId: string | null = null;

  try {
    const thread = threadResponseSchema.parse(await first.peer.request("thread/start", {
      cwd: fixture,
      ephemeral: true,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    }));
    threadId = thread.thread.id;
    const escapedMarker = marker.replaceAll("'", "''");
    const command = `powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${escapedMarker}' -Value 'approved'"`;
    const turn = turnResponseSchema.parse(await first.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `Run exactly this shell command and do nothing else: ${command}` }],
      cwd: fixture,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly" },
    }));
    turnId = turn.turn.id;

    await second.peer.request("thread/resume", { threadId, excludeTurns: true });
    const approvalMessage = await secondLog.waitFor(
      isMethod("item/commandExecution/requestApproval", threadId),
      120_000,
      "follower command approval",
    );
    const approval = secondApprovals.observe(approvalMessage);
    if (!approval) throw new Error("Follower approval message failed validation.");
    if (approval.threadId !== threadId || approval.turnId !== turnId) {
      throw new Error("Follower received an approval for a different running thread/turn.");
    }
    secondApprovals.decide(approval.requestId, "accept");

    await Promise.all([
      firstLog.waitFor(isMethod("turn/completed", threadId), 120_000, "owner turn/completed"),
      secondLog.waitFor(isMethod("turn/completed", threadId), 120_000, "follower turn/completed"),
      firstLog.waitFor(isMethod("serverRequest/resolved", threadId), 30_000, "owner serverRequest/resolved"),
      secondLog.waitFor(isMethod("serverRequest/resolved", threadId), 30_000, "follower serverRequest/resolved"),
    ]);

    const markerContents = (await readFile(marker, "utf8")).trim();
    if (markerContents !== "approved") {
      throw new Error("Approved command did not create the expected marker.");
    }
    console.log(JSON.stringify({
      gate: "cross-client-approval",
      passed: true,
      ownerStartedTurn: true,
      followerJoinedRunningThread: true,
      followerReceivedApproval: true,
      followerDecisionApplied: true,
      bothClientsSawCompletion: true,
      bothClientsSawResolution: true,
    }));
  } catch (error) {
    if (threadId && turnId) {
      await first.peer.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    }
    throw error;
  } finally {
    secondApprovals.resolveAll();
    await Promise.all([first.close(), second.close()]);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "transport" && mode !== "approval") {
    throw new Error("Usage: phase-0-5-integration.ts <transport|approval>");
  }
  const supervisor = await createSupervisor(mode);
  try {
    if (mode === "transport") await transportTest(supervisor);
    else await approvalTest(supervisor);
  } finally {
    await supervisor.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
