import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ApprovalManager } from "./approvals.js";
import { ClientEventLog } from "./client-event-log.js";
import { LoopbackWebSocketSupervisor } from "./loopback-websocket-supervisor.js";
import { ProtocolLog } from "./protocol-log.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "./websocket-json-rpc.js";
import {
  PINNED_VSCODE_COMMIT,
  PINNED_VSCODE_VERSION,
  preparePinnedVscodeExtension,
  preparePinnedVscodeRuntime,
} from "./pinned-vscode-runtime.js";

const execFileAsync = promisify(execFile);
const threadListSchema = z.object({ data: z.array(z.object({
  id: z.string(),
  cwd: z.string(),
  status: z.unknown(),
}).passthrough()) }).passthrough();
const turnResponseSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() }).passthrough();

interface LauncherRow {
  direction: string;
  message: { id?: string | number; method?: string; result?: unknown; error?: unknown; params?: unknown };
}

async function launcherRows(logPath: string): Promise<LauncherRow[]> {
  return (await readFile(logPath, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as LauncherRow);
}

function hasThreadId(message: RpcMessage, threadId: string): boolean {
  const params = message.params;
  return typeof params === "object" && params !== null && "threadId" in params && params.threadId === threadId;
}

function hasTurnId(message: RpcMessage, turnId: string): boolean {
  const params = message.params;
  if (typeof params !== "object" || params === null || !("turn" in params)) return false;
  const turn = params.turn;
  return typeof turn === "object" && turn !== null && "id" in turn && turn.id === turnId;
}

async function waitForVscodeInitialize(logPath: string, cli: ChildProcess, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cli.exitCode !== null && cli.exitCode !== 0) throw new Error(`VS Code CLI exited before Codex initialized (${cli.exitCode}).`);
    try {
      const rows = await launcherRows(logPath);
      const request = rows.find((row) => row.direction === "out" && row.message.method === "initialize");
      if (request) {
        const clientInfo = (request.message.params as { clientInfo?: { name?: string; title?: string; version?: string } } | undefined)?.clientInfo;
        if (clientInfo?.name !== "VS Code" || clientInfo.title !== "Codex Extension" || clientInfo.version !== "26.814.41407") {
          throw new Error(`Unexpected pinned extension client info: ${JSON.stringify(clientInfo)}`);
        }
        const response = rows.find((row) => row.direction === "in" && row.message.id === request.message.id);
        if (response?.message.error) throw new Error(`VS Code initialize failed: ${JSON.stringify(response.message.error)}`);
        if (response?.message.result) return;
      }
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message.includes("ENOENT"))) {
        // The append-only launcher log may not exist yet or may end in a partial line.
      } else {
        throw error;
      }
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the real codex_vscode initialize exchange.");
}

const repoRoot = process.cwd();
const runRoot = path.resolve(".codex-pocket", "phase-0-7");
const profile = path.join(runRoot, "vscode-profile");
const workspace = path.join(runRoot, "workspace");
const logDirectory = path.join(runRoot, "logs");
const statusPath = path.join(runRoot, "session-status.json");
const stopPath = path.join(runRoot, "session-stop");
const launcherLog = path.join(logDirectory, `vscode-protocol-${Date.now()}.jsonl`);
const pocketLogPath = path.join(logDirectory, `pocket-protocol-${Date.now()}.jsonl`);
const restartedPocketLogPath = path.join(logDirectory, `pocket-restarted-protocol-${Date.now()}.jsonl`);
const marker = path.join(runRoot, "approval-marker.txt");
const settingsDirectory = path.join(profile, "User");
const settingsPath = path.join(settingsDirectory, "settings.json");
const launcher = path.resolve("tools", "vscode-proxy", "dist", "codex-pocket-proxy.exe");
const vscodeRuntime = await preparePinnedVscodeRuntime({
  repoRoot,
  ...(process.env.CODEX_POCKET_CODE_EXE ? { explicitCodeExecutable: process.env.CODEX_POCKET_CODE_EXE } : {}),
});
const { codeExecutable, codeCli } = vscodeRuntime;
const vscodeExtension = await preparePinnedVscodeExtension({ repoRoot, runtime: vscodeRuntime });
const codexPath = process.env.CODEX_POCKET_CODEX_EXE ?? vscodeExtension.codexExecutable;
const codexHome = process.env.CODEX_POCKET_INTEGRATION_CODEX_HOME ?? path.join(os.homedir(), ".codex");

const { stdout: vscodeVersionOutput } = await execFileAsync(codeExecutable, [codeCli, "--version"], {
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
const [vscodeVersion, vscodeCommit] = vscodeVersionOutput.trim().split(/\r?\n/u);
if (vscodeVersion !== PINNED_VSCODE_VERSION || vscodeCommit !== PINNED_VSCODE_COMMIT) {
  throw new Error(`Pinned VS Code mismatch: ${JSON.stringify({ vscodeVersion, vscodeCommit })}`);
}

await Promise.all([
  mkdir(settingsDirectory, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(logDirectory, { recursive: true }),
  rm(stopPath, { force: true }),
  rm(statusPath, { force: true }),
  rm(marker, { force: true }),
]);
await writeFile(settingsPath, `${JSON.stringify({
  "chatgpt.cliExecutable": launcher,
  "chatgpt.openOnStartup": true,
  "chatgpt.runCodexInWindowsSubsystemForLinux": false,
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "security.workspace.trust.enabled": false,
}, null, 2)}\n`, "utf8");

const supervisor = new LoopbackWebSocketSupervisor({ codexPath, codexHome });
let codeCliProcess: ChildProcess | null = null;
let pocket: WebSocketPeerConnection | null = null;
let pocketLog: ProtocolLog | null = null;
let createdThreadId: string | null = null;
let failure: string | undefined;
try {
  await supervisor.start();
  codeCliProcess = spawn(codeExecutable, [codeCli,
    "--user-data-dir", profile,
    "--extensions-dir", vscodeExtension.root,
    "--new-window",
    "--log", "trace",
    workspace,
  ], {
    stdio: "ignore",
    windowsHide: false,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_HOME: codexHome,
      CODEX_POCKET_CODEX_EXE: codexPath,
      CODEX_POCKET_WS_URL: supervisor.endpoint,
      CODEX_POCKET_WS_TOKEN: supervisor.token,
      CODEX_POCKET_PROXY_LOG: launcherLog,
    },
  });
  await waitForVscodeInitialize(launcherLog, codeCliProcess);
  const processScript = `$profile = '${profile.replaceAll("'", "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like ('*' + $profile + '*') } | ForEach-Object { $_.ProcessId }`;
  const { stdout: processOutput } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processScript], { windowsHide: true });
  const codePids = processOutput.split(/\r?\n/u).map((entry) => Number.parseInt(entry.trim(), 10)).filter(Number.isFinite);
  if (codePids.length === 0) throw new Error("Could not identify the isolated VS Code process tree.");
  pocketLog = new ProtocolLog(pocketLogPath, [supervisor.token]);
  pocket = await connectWebSocketPeer({
    url: supervisor.endpoint,
    token: supervisor.token,
    name: "codex_pocket_phase_0_7",
    log: pocketLog,
    timeoutMs: 30_000,
  });
  const pocketEvents = new ClientEventLog(pocket.peer.messages());
  const vscodePrompt = "Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath '..\\approval-marker.txt' -Value 'phase-0-7-approved'\"";
  await writeFile(statusPath, `${JSON.stringify({
    phase: "0.7",
    gate: 1,
    state: "awaiting_vscode_prompt",
    codePids,
    workspace,
    profile,
    launcherLog,
    pocketLog: pocketLogPath,
    vscodePrompt,
  }, null, 2)}\n`, "utf8");

  const promptDeadline = Date.now() + 10 * 60_000;
  let pendingRequestSeen = false;
  while (Date.now() < promptDeadline && !pendingRequestSeen) {
    const listed = threadListSchema.parse(await pocket.peer.request("thread/list", {
      limit: 10,
      sortDirection: "desc",
      sourceKinds: ["vscode"],
      cwd: workspace,
    }));
    const candidate = listed.data[0];
    if (candidate) {
      createdThreadId = candidate.id;
      try {
        const rows = await launcherRows(launcherLog);
        pendingRequestSeen = rows.some((row) => row.direction === "in" &&
          row.message.method === "item/commandExecution/requestApproval" &&
          typeof row.message.params === "object" && row.message.params !== null &&
          "threadId" in row.message.params && row.message.params.threadId === createdThreadId);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (!pendingRequestSeen) await delay(250);
  }
  if (!createdThreadId) throw new Error("Gate 2 failed: Pocket did not discover a VS Code-created thread.");
  if (!pendingRequestSeen) throw new Error("Gate 5 failed: VS Code-owned turn did not produce the controlled approval request.");

  const loaded = z.object({ data: z.array(z.string()) }).parse(await pocket.peer.request("thread/loaded/list", { limit: 100 }));
  if (!loaded.data.includes(createdThreadId)) throw new Error("Gate 3 failed: VS Code-owned running thread was not loaded.");
  const resumed = z.object({ thread: z.object({ id: z.string() }).passthrough() }).parse(await pocket.peer.request("thread/resume", {
    threadId: createdThreadId,
    excludeTurns: true,
  }));
  if (resumed.thread.id !== createdThreadId) throw new Error("Gate 3 failed: Pocket resumed a different thread.");

  const approvalMessage = await pocketEvents.waitFor(
    (message) => "id" in message && message.method === "item/commandExecution/requestApproval" && hasThreadId(message, createdThreadId!),
    30_000,
    "late-replayed VS Code approval",
  );
  const approvals = new ApprovalManager(pocket.peer);
  const approval = approvals.observe(approvalMessage);
  if (!approval) throw new Error("Gate 6 failed: replayed approval did not match the pinned schema.");
  approvals.decide(approval.requestId, "accept");
  await pocketEvents.waitFor(
    (message) => message.method === "serverRequest/resolved" && hasThreadId(message, createdThreadId!),
    30_000,
    "Pocket serverRequest/resolved",
  );
  await pocketEvents.waitFor(
    (message) => message.method === "turn/completed" && hasThreadId(message, createdThreadId!),
    180_000,
    "VS Code-owned turn completion",
  );
  const markerContents = (await readFile(marker, "utf8")).trim();
  if (markerContents !== "phase-0-7-approved") throw new Error("Gate 7 failed: accepted VS Code-owned command did not create its marker.");
  const extensionRows = await launcherRows(launcherLog);
  const extensionSawResolution = extensionRows.some((row) => row.direction === "in" && row.message.method === "serverRequest/resolved" &&
    typeof row.message.params === "object" && row.message.params !== null && "threadId" in row.message.params && row.message.params.threadId === createdThreadId);
  const extensionSawCompletion = extensionRows.some((row) => row.direction === "in" && row.message.method === "turn/completed" &&
    typeof row.message.params === "object" && row.message.params !== null && "threadId" in row.message.params && row.message.params.threadId === createdThreadId);
  if (!extensionSawResolution || !extensionSawCompletion) throw new Error("Gate 7 failed: extension connection did not receive approval resolution and turn completion.");

  const pocketTurn = turnResponseSchema.parse(await pocket.peer.request("turn/start", {
    threadId: createdThreadId,
    input: [{ type: "text", text: "Reply exactly PHASE_0_7_POCKET_TURN." }],
    cwd: workspace,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  }));
  await pocketEvents.waitFor(
    (message) => message.method === "turn/completed" && hasTurnId(message, pocketTurn.turn.id),
    180_000,
    "Pocket-started turn completion",
  );
  const extensionRowsAfterPocketTurn = await launcherRows(launcherLog);
  const extensionSawPocketTurn = extensionRowsAfterPocketTurn.some((row) => row.direction === "in" &&
    JSON.stringify(row.message).includes("PHASE_0_7_POCKET_TURN"));
  if (!extensionSawPocketTurn) throw new Error("Gate 8 failed: extension connection did not receive the Pocket-started turn.");

  await writeFile(statusPath, `${JSON.stringify({
    phase: "0.7",
    gate: 8,
    state: "pocket_turn_completed_awaiting_ui_check",
    codePids,
    workspace,
    profile,
    launcherLog,
    pocketLog: pocketLogPath,
    threadId: createdThreadId,
    marker,
  }, null, 2)}\n`, "utf8");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try { await readFile(stopPath); break; } catch { /* keep the verified session visible */ }
    await delay(250);
  }

  const interruptTurn = turnResponseSchema.parse(await pocket.peer.request("turn/start", {
    threadId: createdThreadId,
    input: [{ type: "text", text: "Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"" }],
    cwd: workspace,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  }));
  await pocketEvents.waitFor(
    (message) => message.method === "item/started" && hasThreadId(message, createdThreadId!) &&
      typeof message.params === "object" && message.params !== null && "turnId" in message.params &&
      message.params.turnId === interruptTurn.turn.id && "item" in message.params &&
      typeof message.params.item === "object" && message.params.item !== null && "type" in message.params.item &&
      message.params.item.type === "commandExecution",
    120_000,
    "controlled command before interrupt",
  );
  await pocket.peer.request("turn/interrupt", { threadId: createdThreadId, turnId: interruptTurn.turn.id });
  const interrupted = await pocketEvents.waitFor(
    (message) => message.method === "turn/completed" && hasTurnId(message, interruptTurn.turn.id),
    30_000,
    "interrupted turn completion",
  );
  const interruptedTurn = typeof interrupted.params === "object" && interrupted.params !== null && "turn" in interrupted.params
    ? interrupted.params.turn : null;
  if (typeof interruptedTurn !== "object" || interruptedTurn === null || !("status" in interruptedTurn) || interruptedTurn.status !== "interrupted") {
    throw new Error(`Gate 9 failed: interrupted turn ended with ${JSON.stringify(interruptedTurn)}.`);
  }

  await pocket.close();
  await pocketLog.close();
  pocket = null;
  pocketLog = new ProtocolLog(restartedPocketLogPath, [supervisor.token]);
  pocket = await connectWebSocketPeer({
    url: supervisor.endpoint,
    token: supervisor.token,
    name: "codex_pocket_phase_0_7_restarted",
    log: pocketLog,
    timeoutMs: 30_000,
  });
  const loadedAfterRestart = z.object({ data: z.array(z.string()) }).parse(
    await pocket.peer.request("thread/loaded/list", { limit: 100 }),
  );
  if (!loadedAfterRestart.data.includes(createdThreadId)) throw new Error("Gate 10 failed: restarted Pocket did not find the loaded VS Code thread.");
  const resumedAfterRestart = z.object({ thread: z.object({ id: z.string(), turns: z.array(z.unknown()).optional() }).passthrough() }).parse(
    await pocket.peer.request("thread/resume", { threadId: createdThreadId, excludeTurns: false }),
  );
  if (resumedAfterRestart.thread.id !== createdThreadId || !resumedAfterRestart.thread.turns?.length) {
    throw new Error("Gate 10 failed: restarted Pocket could not hot-attach with history to the same thread.");
  }
  await writeFile(statusPath, `${JSON.stringify({
    phase: "0.7",
    gate: 10,
    state: "all_protocol_gates_passed",
    codePids,
    threadId: createdThreadId,
    launcherLog,
    pocketLog: pocketLogPath,
    restartedPocketLog: restartedPocketLogPath,
  }, null, 2)}\n`, "utf8");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  await writeFile(statusPath, `${JSON.stringify({ phase: "0.7", state: "failed", failure, threadId: createdThreadId }, null, 2)}\n`, "utf8");
} finally {
  await pocket?.close().catch(() => undefined);
  await pocketLog?.close().catch(() => undefined);
  const stopScript = `$profile = '${profile.replaceAll("'", "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like ('*' + $profile + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopScript], { windowsHide: true }).catch(() => undefined);
  await supervisor.stop();
}

if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
