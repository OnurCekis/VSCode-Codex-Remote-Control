import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientEventLog } from "./client-event-log.js";
import { LoopbackWebSocketSupervisor } from "./loopback-websocket-supervisor.js";
import {
  PINNED_VSCODE_COMMIT,
  PINNED_VSCODE_VERSION,
  preparePinnedVscodeExtension,
  preparePinnedVscodeRuntime,
} from "./pinned-vscode-runtime.js";
import { callText, connectClient, freePort, startFixture } from "./phase-3-browser-copresence.js";
import { stopOwnedBrowserProcesses } from "./phase-3-platform-runtime.js";
import { ProtocolLog } from "./protocol-log.js";
import type { RpcMessage } from "./rpc-types.js";
import { connectWebSocketPeer, type WebSocketPeerConnection } from "./websocket-json-rpc.js";

const execFileAsync = promisify(execFile);
const threadSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() }).passthrough();
const turnSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() }).passthrough();
const threadListSchema = z.object({ data: z.array(z.object({ id: z.string(), cwd: z.string(), status: z.unknown() }).passthrough()) }).passthrough();
const mcpStatusSchema = z.object({ data: z.array(z.object({
  name: z.string(),
  tools: z.record(z.string(), z.unknown()),
  authStatus: z.unknown(),
}).passthrough()) }).passthrough();

interface LauncherRow {
  direction: "in" | "out";
  message: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
}

class ManualGateBlockedError extends Error {}

async function launcherRows(file: string): Promise<LauncherRow[]> {
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as LauncherRow);
}

async function waitForExtensionInitialize(logPath: string, code: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (code.exitCode !== null && code.exitCode !== 0) throw new Error(`Pinned VS Code CLI exited before extension initialize (${code.exitCode}).`);
    try {
      const rows = await launcherRows(logPath);
      const request = rows.find((row) => row.direction === "out" && row.message.method === "initialize");
      if (request) {
        const clientInfo = (request.message.params as { clientInfo?: { name?: string; title?: string; version?: string } } | undefined)?.clientInfo;
        if (clientInfo?.name !== "VS Code" || clientInfo.title !== "Codex Extension" || clientInfo.version !== "26.814.41407") {
          throw new Error(`Unexpected extension identity: ${JSON.stringify(clientInfo)}`);
        }
        const response = rows.find((row) => row.direction === "in" && row.message.id === request.message.id);
        if (response?.message.error) throw new Error(`Extension initialize failed: ${JSON.stringify(response.message.error)}`);
        if (response?.message.result) return;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message.includes("ENOENT"))) throw error;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the real pinned VS Code Codex extension initialize exchange.");
}

function threadItem(message: RpcMessage): Record<string, unknown> | null {
  if (typeof message.params !== "object" || message.params === null || !("item" in message.params)) return null;
  const item = message.params.item;
  return typeof item === "object" && item !== null ? item as Record<string, unknown> : null;
}

function eventThreadId(message: RpcMessage): string | null {
  return typeof message.params === "object" && message.params !== null && "threadId" in message.params &&
    typeof message.params.threadId === "string" ? message.params.threadId : null;
}

async function stopCodeProfile(profile: string): Promise<void> {
  const escaped = profile.replaceAll("'", "''");
  const script = `$p='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like ('*' + $p + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000 });
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const marker = randomBytes(8).toString("hex");
  const runRoot = path.resolve(".codex-pocket", "phase-3", "gate-2", `${Date.now()}-${process.pid}`);
  const workspace = path.join(runRoot, "workspace");
  const profile = path.join(runRoot, "vscode-profile");
  const codexHome = path.join(runRoot, "codex-home");
  const browserProfile = path.join(runRoot, "browser-profile");
  const mcpOutput = path.join(runRoot, "mcp-output");
  const settingsDirectory = path.join(profile, "User");
  const launcherLog = path.join(runRoot, "vscode-protocol.jsonl");
  const pocketLogPath = path.join(runRoot, "pocket-protocol.jsonl");
  const screenshotPath = path.join(runRoot, "pocket-observer.png");
  const manualOwner = process.argv.includes("--manual-owner");
  const manualStatusPath = path.join(runRoot, "manual-status.json");
  const manualStopPath = path.join(runRoot, "manual-stop");
  let manualPrompt: string | undefined;
  await Promise.all([
    mkdir(workspace, { recursive: true }), mkdir(settingsDirectory, { recursive: true }), mkdir(codexHome, { recursive: true }),
    mkdir(browserProfile, { recursive: true }), mkdir(mcpOutput, { recursive: true }),
  ]);

  const fixture = await startFixture(marker);
  const mcpPort = await freePort();
  const mcpEndpoint = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
  const mcpCli = path.resolve("node_modules", "@playwright", "mcp", "cli.js");
  const mcp = spawn(process.execPath, [mcpCli,
    "--browser", "msedge", "--headless",
    "--host", "127.0.0.1", "--allowed-hosts", `127.0.0.1:${mcpPort}`, "--port", String(mcpPort),
    "--shared-browser-context", "--user-data-dir", browserProfile, "--output-dir", mcpOutput, "--console-level", "debug",
  ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env } });
  let mcpOutputText = "";
  mcp.stdout?.on("data", (chunk) => { mcpOutputText = `${mcpOutputText}${String(chunk)}`.slice(-32_000); });
  mcp.stderr?.on("data", (chunk) => { mcpOutputText = `${mcpOutputText}${String(chunk)}`.slice(-32_000); });

  let observer: Client | undefined;
  let supervisor: LoopbackWebSocketSupervisor | undefined;
  let pocket: WebSocketPeerConnection | undefined;
  let pocketLog: ProtocolLog | undefined;
  let codeProcess: ChildProcess | undefined;
  const report: Record<string, unknown> = {
    phase: "3-gate-2",
    packages: { mcp: "0.0.79", playwright: "1.63.0-alpha-2026-08-05", playwrightCore: "1.63.0-alpha-2026-08-05", mcpSdk: "1.30.0" },
    mcpEndpoint: { host: "127.0.0.1", dynamicPort: true, path: "/mcp" },
  };
  try {
    observer = await connectClient("codex-pocket-gate2-observer", mcpEndpoint);
    await copyFile(path.join(os.homedir(), ".codex", "auth.json"), path.join(codexHome, "auth.json"));
    await writeFile(path.join(codexHome, "config.toml"), `[mcp_servers.playwright]\nurl = "${mcpEndpoint.href}"\ndefault_tools_approval_mode = "approve"\n`, { encoding: "utf8", mode: 0o600 });

    const runtime = await preparePinnedVscodeRuntime({ repoRoot });
    const extension = await preparePinnedVscodeExtension({ repoRoot, runtime });
    if (runtime.version !== PINNED_VSCODE_VERSION || runtime.commit !== PINNED_VSCODE_COMMIT) throw new Error("Pinned VS Code baseline changed.");
    const launcher = path.resolve("tools", "vscode-proxy", "dist", "codex-pocket-proxy.exe");
    await writeFile(path.join(settingsDirectory, "settings.json"), `${JSON.stringify({
      "chatgpt.cliExecutable": launcher,
      "chatgpt.openOnStartup": true,
      "chatgpt.runCodexInWindowsSubsystemForLinux": false,
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "security.workspace.trust.enabled": false,
    }, null, 2)}\n`);

    supervisor = new LoopbackWebSocketSupervisor({ codexPath: extension.codexExecutable, codexHome });
    await supervisor.start();
    codeProcess = spawn(runtime.codeExecutable, [runtime.codeCli,
      "--user-data-dir", profile, "--extensions-dir", extension.root, "--new-window", "--log", "trace", workspace,
    ], {
      stdio: "ignore", windowsHide: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CODEX_HOME: codexHome,
        CODEX_POCKET_CODEX_EXE: extension.codexExecutable,
        CODEX_POCKET_WS_URL: supervisor.endpoint,
        CODEX_POCKET_WS_TOKEN: supervisor.token,
        CODEX_POCKET_PROXY_LOG: launcherLog,
      },
    });
    await waitForExtensionInitialize(launcherLog, codeProcess);

    pocketLog = new ProtocolLog(pocketLogPath, [supervisor.token]);
    pocket = await connectWebSocketPeer({
      url: supervisor.endpoint, token: supervisor.token, name: "codex_pocket_phase_3_gate_2", log: pocketLog, timeoutMs: 30_000,
    });
    const events = new ClientEventLog(pocket.peer.messages());
    if (manualOwner) {
      const prompt = `Use only the Playwright MCP server. Navigate to ${fixture.baseUrl}, click the button named "Change deterministic state", inspect the resulting page, and reply with the exact visible state marker.`;
      manualPrompt = prompt;
      await writeFile(manualStatusPath, `${JSON.stringify({
        phase: "3-gate-2", state: "awaiting_real_vscode_owner_prompt", workspace, prompt, stopFile: manualStopPath,
      }, null, 2)}\n`);
      process.stdout.write(`\nGate 2 manual owner prompt (paste into the opened pinned VS Code Codex composer):\n\n${prompt}\n\n`);
      const deadline = Date.now() + 10 * 60_000;
      let threadId: string | undefined;
      while (Date.now() < deadline && !threadId) {
        if (await access(manualStopPath).then(() => true).catch(() => false)) {
          throw new ManualGateBlockedError("BLOCKED — awaiting real VS Code composer interaction");
        }
        const listed = threadListSchema.parse(await pocket.peer.request("thread/list", {
          limit: 20, sortDirection: "desc", sourceKinds: ["vscode"], cwd: workspace,
        }));
        threadId = listed.data.find((entry) => path.resolve(entry.cwd) === path.resolve(workspace))?.id;
        if (!threadId) await delay(250);
      }
      if (!threadId) throw new Error("Timed out waiting for a real VS Code-owned Codex thread in the isolated Phase 3 workspace.");
      await pocket.peer.request("thread/resume", { threadId, excludeTurns: false });
      try {
        const stateChange = await events.waitFor((message) => {
          const item = threadItem(message);
          return message.method === "item/completed" && eventThreadId(message) === threadId && item?.type === "mcpToolCall" &&
            item.server === "playwright" && ["browser_click", "browser_evaluate"].includes(String(item.tool)) && item.status === "completed";
        }, 300_000, "real VS Code-owned completed Playwright state-changing tool");
        const turnCompleted = await events.waitFor((message) => message.method === "turn/completed" && eventThreadId(message) === threadId,
          300_000, "real VS Code-owned browser turn completion");
        const observed = await callText(observer, "browser_snapshot");
        if (!observed.includes(`AFTER_${marker}`)) throw new Error("Pocket did not observe the exact DOM marker produced by the real VS Code-owned turn.");
        const tabs = await callText(observer, "browser_tabs", { action: "list" });
        if (!tabs.includes(fixture.baseUrl)) throw new Error("Pocket did not observe the exact real VS Code-owned page URL.");
        const screenshot = await observer.callTool({ name: "browser_take_screenshot", arguments: { type: "png" } });
        const content = typeof screenshot === "object" && screenshot !== null && "content" in screenshot && Array.isArray(screenshot.content) ? screenshot.content : [];
        const image = content.find((entry): entry is { type: "image"; data: string; mimeType: string } =>
          typeof entry === "object" && entry !== null && "type" in entry && entry.type === "image" && "data" in entry && typeof entry.data === "string" &&
          "mimeType" in entry && entry.mimeType === "image/png");
        if (!image) throw new Error("Pocket did not receive a screenshot of the real VS Code-owned page.");
        await writeFile(screenshotPath, Buffer.from(image.data, "base64"));
        const extensionRows = await launcherRows(launcherLog);
        const extensionSawMcp = extensionRows.some((row) => row.direction === "in" && ["item/started", "item/completed"].includes(row.message.method ?? "") &&
          JSON.stringify(row.message.params).includes("mcpToolCall") && JSON.stringify(row.message.params).includes("playwright"));
        if (!extensionSawMcp) throw new Error("The owning VS Code extension did not receive its own structured MCP lifecycle.");
        const turnId = typeof turnCompleted.params === "object" && turnCompleted.params !== null && "turn" in turnCompleted.params &&
          typeof turnCompleted.params.turn === "object" && turnCompleted.params.turn !== null && "id" in turnCompleted.params.turn &&
          typeof turnCompleted.params.turn.id === "string" ? turnCompleted.params.turn.id : null;
        report.passed = true;
        report.realExtension = { initialized: true, version: "26.814.41407", ownsThread: true, sawMcpToolLifecycle: true };
        report.codexTurn = { threadId, turnId, stateChangingTool: threadItem(stateChange)?.tool, status: threadItem(stateChange)?.status };
        report.pocketEvidence = { exactMarker: true, exactUrl: true, screenshot: path.relative(repoRoot, screenshotPath) };
        report.identity = { runtime: "isolated-phase-3-app-server", threadId, turnId, mcpServer: "playwright", contextIdExposed: false, pageIdExposed: false };
        await writeFile(path.join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
        await writeFile(manualStatusPath, `${JSON.stringify({ phase: "3-gate-2", state: "passed", threadId, turnId }, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify({ ...report, runRoot: path.relative(repoRoot, runRoot) }, null, 2)}\n`);
      } finally {
        await pocket.peer.request("thread/unsubscribe", { threadId }).catch(() => undefined);
      }
      return;
    }
    const started = threadSchema.parse(await pocket.peer.request("thread/start", {
      cwd: workspace, ephemeral: false, threadSource: "vscode", approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write",
    }));
    const threadId = started.thread.id;
    const status = mcpStatusSchema.parse(await pocket.peer.request("mcpServerStatus/list", { limit: 20, detail: "full", threadId }));
    const playwrightStatus = status.data.find((entry) => entry.name === "playwright");
    if (!playwrightStatus) throw new Error("Pinned App Server did not load the isolated Playwright MCP config.");
    for (const tool of ["browser_navigate", "browser_snapshot", "browser_click", "browser_take_screenshot"]) {
      if (!(tool in playwrightStatus.tools)) throw new Error(`App Server Playwright MCP inventory is missing ${tool}.`);
    }

    await pocket.peer.request("mcpServer/tool/call", { threadId, server: "playwright", tool: "browser_navigate", arguments: { url: fixture.baseUrl } });
    const directSnapshot = await callText(observer, "browser_snapshot");
    if (!directSnapshot.includes(`BEFORE_${marker}`)) throw new Error("Pocket observer did not see the App Server MCP client's exact initial page.");

    const turn = turnSchema.parse(await pocket.peer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `Use only the Playwright MCP server. Navigate to ${fixture.baseUrl}, click the button named "Change deterministic state", inspect the resulting page, and reply with the exact visible state marker.` }],
      cwd: workspace,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }));
    const turnId = turn.turn.id;
    const mcpStarted = await events.waitFor((message) => {
      const item = threadItem(message);
      return message.method === "item/started" && eventThreadId(message) === threadId && item?.type === "mcpToolCall" && item.server === "playwright";
    }, 240_000, "Codex Playwright MCP tool start");
    const mcpCompleted = await events.waitFor((message) => {
      const item = threadItem(message);
      return message.method === "item/completed" && eventThreadId(message) === threadId && item?.type === "mcpToolCall" &&
        item.server === "playwright" && ["browser_click", "browser_evaluate"].includes(String(item.tool)) && item.status === "completed";
    }, 240_000, "completed Codex Playwright state-changing tool");
    await events.waitFor((message) => message.method === "turn/completed" && eventThreadId(message) === threadId &&
      typeof message.params === "object" && message.params !== null && "turn" in message.params &&
      typeof message.params.turn === "object" && message.params.turn !== null && "id" in message.params.turn && message.params.turn.id === turnId,
    300_000, "Codex browser turn completion");

    const observed = await callText(observer, "browser_snapshot");
    if (!observed.includes(`AFTER_${marker}`)) throw new Error("Pocket did not observe the exact DOM state produced by the Codex MCP turn.");
    const tabs = await callText(observer, "browser_tabs", { action: "list" });
    if (!tabs.includes(fixture.baseUrl)) throw new Error("Pocket did not observe the exact Codex-driven URL.");
    const screenshot = await observer.callTool({ name: "browser_take_screenshot", arguments: { type: "png" } });
    const content = typeof screenshot === "object" && screenshot !== null && "content" in screenshot && Array.isArray(screenshot.content) ? screenshot.content : [];
    const image = content.find((entry): entry is { type: "image"; data: string; mimeType: string } =>
      typeof entry === "object" && entry !== null && "type" in entry && entry.type === "image" && "data" in entry && typeof entry.data === "string" &&
      "mimeType" in entry && entry.mimeType === "image/png");
    if (!image) throw new Error("Pocket observer did not receive the Codex-driven page screenshot.");
    await writeFile(screenshotPath, Buffer.from(image.data, "base64"));

    const extensionRows = await launcherRows(launcherLog);
    const extensionSawMcp = extensionRows.some((row) => row.direction === "in" && ["item/started", "item/completed"].includes(row.message.method ?? "") &&
      JSON.stringify(row.message.params).includes("mcpToolCall") && JSON.stringify(row.message.params).includes("playwright"));
    const extensionSawTurn = extensionRows.some((row) => row.direction === "in" && row.message.method === "turn/completed" &&
      JSON.stringify(row.message.params).includes(turnId));
    if (!extensionSawMcp || !extensionSawTurn) throw new Error("The real pinned VS Code extension bridge did not observe the Codex MCP turn lifecycle.");

    report.passed = true;
    report.realExtension = { initialized: true, version: "26.814.41407", sawMcpToolLifecycle: true, sawTurnCompletion: true };
    report.appServerMcp = { configuredFromIsolatedCodexHome: true, statusListed: true, directCallSharedPage: true };
    report.codexTurn = { threadId, turnId, structuredStartStatus: threadItem(mcpStarted)?.status, structuredCompletionStatus: threadItem(mcpCompleted)?.status };
    report.pocketEvidence = { exactMarker: true, exactUrl: true, screenshot: path.relative(repoRoot, screenshotPath) };
    report.identity = { runtime: "isolated-phase-3-app-server", threadId, turnId, mcpServer: "playwright", contextIdExposed: false, pageIdExposed: false };
    await writeFile(path.join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...report, runRoot: path.relative(repoRoot, runRoot) }, null, 2)}\n`);
  } catch (error) {
    if (manualOwner) {
      const blocked = error instanceof ManualGateBlockedError;
      await writeFile(manualStatusPath, `${JSON.stringify({
        phase: "3-gate-2", state: blocked ? "blocked" : "failed",
        ...(blocked ? { reason: error.message } : { error: error instanceof Error ? error.message : String(error) }),
        ...(manualPrompt ? { prompt: manualPrompt } : {}),
        resume: "Run npm run phase3:vscode-browser:manual on the Windows PC, then paste that run's newly printed prompt into its isolated pinned VS Code Codex composer.",
      }, null, 2)}\n`).catch(() => undefined);
    }
    await writeFile(path.join(runRoot, "failure.json"), `${JSON.stringify({
      ...report, error: error instanceof Error ? error.message : String(error), mcpOutput: mcpOutputText,
    }, null, 2)}\n`).catch(() => undefined);
    throw error;
  } finally {
    await observer?.close().catch(() => undefined);
    await pocket?.close().catch(() => undefined);
    await pocketLog?.close().catch(() => undefined);
    await stopCodeProfile(profile).catch(() => undefined);
    await supervisor?.stop().catch(() => undefined);
    if (mcp.exitCode === null && mcp.signalCode === null) {
      mcp.kill();
      await Promise.race([new Promise((resolve) => mcp.once("exit", resolve)), delay(3_000)]);
    }
    const leakedBrowserPids = await stopOwnedBrowserProcesses(browserProfile);
    await fixture.close().catch(() => undefined);
    await Promise.all([
      rm(browserProfile, { recursive: true, force: true }), rm(profile, { recursive: true, force: true }), rm(codexHome, { recursive: true, force: true }),
    ]).catch(() => undefined);
    if (leakedBrowserPids.length) throw new Error(`Phase 3 Gate 2 browser cleanup failed: ${leakedBrowserPids.join(",")}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
