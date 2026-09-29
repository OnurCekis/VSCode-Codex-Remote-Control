import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { LoopbackWebSocketSupervisor } from "../../ipc-probe/src/loopback-websocket-supervisor.js";
import { ProtocolLog } from "../../ipc-probe/src/protocol-log.js";
import { connectWebSocketPeer } from "../../ipc-probe/src/websocket-json-rpc.js";
import { discoverVscodeThreads } from "../../ipc-probe/src/session-discovery.js";
import { assertMacosVscodeTopology, stopMacosProfileProcesses } from "./macos-process-inspection.js";
import {
  checkMacosCodexUpdate,
  cleanupStaleMacosUpdateCandidates,
  isPocketUpdateCheckDue,
  promoteMacosExtensionCandidate,
  prepareMacosProxy,
  prepareMacosVscodeRuntime,
  readActiveMacosVscodeExtension,
  readMacosExtensionCandidate,
  restoreMacosExtensionPointer,
  stageMacosCodexUpdate,
  type ActiveExtensionPointer,
} from "./macos-vscode-runtime.js";
import type { PocketUpdateStatus } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import { isolatedVscodeEnvironment } from "./vscode-launch-environment.js";
import { ProfileSyncService, type JsonValue } from "../../../packages/pocket-runtime/src/profile-sync-service.js";
import { UpdateLifecycleManager, type UpdateLifecycleRecord } from "../../../packages/pocket-runtime/src/update-lifecycle.js";

const repoRoot = process.cwd();
const runRoot = path.resolve(process.env.CODEX_POCKET_TEST_RUN_ROOT ?? path.join(".codex-pocket", "phase-1"));
const connectionPath = path.join(runRoot, "connection.json");
const statusPath = path.join(runRoot, "host-status.json");
const stopPath = path.join(runRoot, "host-stop");
const requestsDir = path.join(runRoot, "runtime-requests");
const resultsDir = path.join(runRoot, "runtime-results");
const logsRoot = path.join(runRoot, "logs");
const updateRoot = path.resolve(".codex-pocket", "updates");
const updateStatusPath = path.join(updateRoot, "status.json");
const updateRestartPath = path.join(updateRoot, "restart-request.json");
const profile = path.resolve(process.env.CODEX_POCKET_TEST_PROFILE ??
  path.join(os.tmpdir(), `codex-pocket-${process.getuid?.() ?? "user"}`, "vscode-profile"));
const settingsDirectory = path.join(profile, "User");
const dailyUserDirectory = path.resolve(process.env.CODEX_POCKET_DAILY_USER_DIR ?? path.join(os.homedir(), "Library", "Application Support", "Code", "User"));
const dailyExtensionsDirectory = path.resolve(process.env.CODEX_POCKET_DAILY_EXTENSIONS_DIR ?? path.join(os.homedir(), ".vscode", "extensions"));
const initialWorkspace = await realpath(path.resolve(process.env.CODEX_POCKET_INITIAL_WORKSPACE ?? repoRoot));
const vscodeRuntime = await prepareMacosVscodeRuntime(repoRoot);
const vscodeExtension = await readActiveMacosVscodeExtension(repoRoot, vscodeRuntime);
const launcher = await prepareMacosProxy(repoRoot);
const codexPath = vscodeExtension.codexExecutable;
const codexHome = process.env.CODEX_POCKET_INTEGRATION_CODEX_HOME ?? path.join(os.homedir(), ".codex");
const launcherLog = path.join(logsRoot, `vscode-macos-${Date.now()}.jsonl`);
const supervisor = new LoopbackWebSocketSupervisor({
  codexPath,
  codexHome,
  expectedCodexSha256: vscodeExtension.cliSha256,
});

interface ExtensionEvidence { bridgePid: number }
interface RuntimeRecord { id: string; workspace: string; bridgePid: number }

function workspaceKey(value: string): string { return path.normalize(value).replace(/\/+$/u, ""); }

async function waitForExtensionInitialize(codeProcess: ChildProcess | null, excludedPids: ReadonlySet<number> = new Set()): Promise<ExtensionEvidence> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (codeProcess?.exitCode !== null && codeProcess?.exitCode !== undefined && codeProcess.exitCode !== 0) {
      throw new Error(`macOS VS Code exited with ${codeProcess.exitCode}.`);
    }
    try {
      const rows = (await readFile(launcherLog, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
        bridgePid?: number;
        direction: string;
        message: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown; pid?: number; endpoint?: string };
      });
      const bridge = rows.find((row) => row.direction === "meta" &&
        (row.message as { event?: string }).event === "bridge/start" && Number.isSafeInteger(row.message.pid) &&
        !excludedPids.has(row.message.pid as number));
      const request = bridge ? rows.find((row) => row.bridgePid === bridge.message.pid && row.direction === "out" && row.message.method === "initialize") : undefined;
      if (request && bridge) {
        if (bridge.message.endpoint !== `${supervisor.endpoint}/` && bridge.message.endpoint !== supervisor.endpoint) {
          throw new Error("macOS extension proxy connected to an unexpected App Server endpoint.");
        }
        const bridgePid = bridge.message.pid;
        if (!Number.isSafeInteger(bridgePid) || (bridgePid ?? 0) <= 0) throw new Error("macOS extension proxy did not report a valid PID.");
        const client = (request.message.params as { clientInfo?: { name?: string; title?: string; version?: string } }).clientInfo;
        if (client?.name !== "VS Code" || client.title !== "Codex Extension" || client.version !== vscodeExtension.version) {
          throw new Error(`Unexpected macOS extension identity: ${JSON.stringify(client)}`);
        }
        const response = rows.find((row) => row.bridgePid === bridgePid && row.direction === "in" && row.message.id === request.message.id);
        if (response?.message.error) throw new Error(`macOS extension initialize failed: ${JSON.stringify(response.message.error)}`);
        if (response?.message.result) return { bridgePid: bridgePid as number };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the pinned macOS Codex extension initialize exchange.");
}

async function verifyPocketClient(): Promise<void> {
  const log = new ProtocolLog(path.join(logsRoot, `macos-topology-${Date.now()}.jsonl`), [supervisor.token]);
  let connection: Awaited<ReturnType<typeof connectWebSocketPeer>> | null = null;
  try {
    connection = await connectWebSocketPeer({
      url: supervisor.endpoint,
      token: supervisor.token,
      name: "codex_pocket_macos_topology_probe",
      log,
      timeoutMs: 15_000,
    });
    await connection.peer.request("thread/loaded/list", { limit: 1 });
  } finally {
    await connection?.close();
    await log.close();
  }
}

let stopping = false;
const runtimes = new Map<string, RuntimeRecord>();
let profileSyncStatus: Awaited<ReturnType<ProfileSyncService["apply"]>>;
let updateStatus: PocketUpdateStatus = {
  state: "idle", currentVersion: vscodeExtension.version, availableVersion: null,
  checkedAt: new Date(0).toISOString(), source: "visualStudioMarketplace", restartRequired: false,
};

function runtimeView(runtime: RuntimeRecord): {
  id: string; workspace: { path: string; displayName: string }; state: "connected"; appServerPid: number; bridgePid: number;
} {
  return { id: runtime.id, workspace: { path: runtime.workspace, displayName: path.basename(runtime.workspace) || runtime.workspace },
    state: "connected", appServerPid: supervisor.pid!, bridgePid: runtime.bridgePid };
}

async function writeStatus(codePids: number[]): Promise<void> {
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  const runtimeList = [...runtimes.values()];
  const primary = runtimeList[0] ?? null;
  await writeFile(temporaryPath, `${JSON.stringify({
    state: "ready",
    ownerPid: process.pid,
    connectionFile: connectionPath,
    workspace: primary?.workspace ?? null,
    profile,
    vscodeVersion: vscodeRuntime.version,
    vscodeCommit: vscodeRuntime.commit,
    extensionVersion: vscodeExtension.version,
    codexCliVersion: vscodeExtension.cliVersion,
    extensionVsixSha256: vscodeExtension.vsixSha256,
    extensionTreeSha256: vscodeExtension.treeSha256,
    codexCliSha256: vscodeExtension.cliSha256,
    topology: "sharedAppServer",
    platform: "darwin-arm64",
    appServerPid: supervisor.pid,
    bridgePid: primary?.bridgePid ?? null,
    codePids,
    launcherLog,
    profileSync: profileSyncStatus,
    update: updateStatus,
    runtimes: runtimeList.map(runtimeView),
    verifiedAtMs: Date.now(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, statusPath);
}

async function bridgePidsFromLog(): Promise<Set<number>> {
  const pids = new Set<number>();
  try {
    for (const line of (await readFile(launcherLog, "utf8")).split(/\r?\n/u)) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { direction?: string; message?: { event?: string; pid?: number } };
        if (row.direction === "meta" && row.message?.event === "bridge/start" && Number.isSafeInteger(row.message.pid)) pids.add(row.message.pid!);
      } catch { /* retry a concurrently appended row later */ }
    }
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  return pids;
}

async function clearControlDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:json|tmp)$/u.test(entry.name)) await rm(path.join(directory, entry.name), { force: true });
  }
  await chmod(directory, 0o700);
}

await Promise.all([
  mkdir(runRoot, { recursive: true, mode: 0o700 }),
  mkdir(logsRoot, { recursive: true, mode: 0o700 }),
  mkdir(updateRoot, { recursive: true, mode: 0o700 }),
  mkdir(settingsDirectory, { recursive: true, mode: 0o700 }),
]);
await Promise.all([chmod(runRoot, 0o700), chmod(logsRoot, 0o700), chmod(updateRoot, 0o700), chmod(profile, 0o700)]);
await Promise.all([rm(connectionPath, { force: true }), rm(statusPath, { force: true }), rm(stopPath, { force: true })]);
await Promise.all([clearControlDirectory(requestsDir), clearControlDirectory(resultsDir)]);
const stopSignal = new Promise<void>((resolve) => {
  const stop = (): void => { if (!stopping) { stopping = true; resolve(); } };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  void (async () => {
    while (!stopping) {
      try { await access(stopPath); stop(); } catch { await delay(250); }
    }
  })();
});
const protectedSettings: Record<string, JsonValue> = {
  "chatgpt.cliExecutable": launcher,
  "chatgpt.openOnStartup": true,
  "extensions.autoUpdate": "off",
  "extensions.autoCheckUpdates": false,
  "update.mode": "none",
  "security.workspace.trust.enabled": false,
};
const profileSync = new ProfileSyncService({
  paths: { dailyUserDir: dailyUserDirectory, dailyExtensionsDir: dailyExtensionsDirectory,
    pocketUserDir: settingsDirectory, pocketExtensionsDir: vscodeExtension.root,
    stateFile: path.join(runRoot, "profile-sync-state.json") },
  protectedSettings,
  pinnedVscodeVersion: vscodeRuntime.version,
  pinnedCodexExtension: { id: "openai.chatgpt", version: vscodeExtension.version,
    directoryName: path.basename(vscodeExtension.extensionDirectory) },
  targetPlatform: "darwin", targetArchitecture: "arm64",
  verifyProtectedInvariants: async () => {
    const effective = JSON.parse(await readFile(path.join(settingsDirectory, "settings.json"), "utf8")) as Record<string, unknown>;
    for (const [key, expected] of Object.entries(protectedSettings)) {
      if (JSON.stringify(effective[key]) !== JSON.stringify(expected)) throw new Error(`Protected Pocket setting mismatch: ${key}`);
    }
    const active = await readActiveMacosVscodeExtension(repoRoot, vscodeRuntime);
    if (active.version !== vscodeExtension.version || active.cliSha256 !== vscodeExtension.cliSha256) {
      throw new Error("Active Pocket extension changed while the runtime was running.");
    }
    await Promise.all([prepareMacosVscodeRuntime(repoRoot), access(launcher)]);
  },
});
profileSyncStatus = await profileSync.apply({ allowExtensionChanges: true });

async function writeAtomicJson(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
}

async function updaterIdleState(): Promise<{ idle: boolean; reason?: string }> {
  await supervisor.assertReady();
  for (const runtime of runtimes.values()) {
    await assertMacosVscodeTopology({ app: vscodeRuntime.app, profile, launcher,
      bridgePid: runtime.bridgePid, endpoint: supervisor.endpoint });
  }
  const log = new ProtocolLog(path.join(logsRoot, `update-idle-${Date.now()}.jsonl`), [supervisor.token]);
  let connection: Awaited<ReturnType<typeof connectWebSocketPeer>> | null = null;
  try {
    connection = await connectWebSocketPeer({ url: supervisor.endpoint, token: supervisor.token,
      name: "codex_pocket_update_idle_probe", log, timeoutMs: 15_000 });
    const threads = await discoverVscodeThreads(connection.peer);
    const active = threads.filter((thread) => thread.status.type === "active");
    return active.length === 0
      ? { idle: true }
      : { idle: false, reason: active.some((thread) => thread.status.type === "active" && thread.status.activeFlags.includes("waitingOnApproval"))
        ? "A Codex approval is pending." : "A Codex turn is active." };
  } finally {
    await connection?.close();
    await log.close();
  }
}

const updater = new UpdateLifecycleManager({
  currentVersion: async () => vscodeExtension.version,
  discover: async () => {
    const status = await checkMacosCodexUpdate(fetch, new Date(), vscodeExtension.version);
    return { version: status.availableVersion!, sha256: status.marketplaceSha256,
      source: "visualStudioMarketplace", compatible: true, updateAvailable: status.state === "updateAvailable" };
  },
  stage: async (update) => await stageMacosCodexUpdate({ repoRoot, runtime: vscodeRuntime,
    version: update.version, sha256: update.sha256 }),
  isIdle: updaterIdleState,
  promote: async (candidate) => {
    const staged = await readMacosExtensionCandidate(repoRoot, candidate.candidateId);
    const promotion = await promoteMacosExtensionCandidate(repoRoot, staged);
    return { previousVersion: promotion.previousVersion, rollbackToken: promotion.previousPointer };
  },
  requestRestart: async (candidate, promotion) => {
    await writeAtomicJson(updateRestartPath, {
      version: 1, requestedByPid: process.pid, candidateVersion: candidate.version,
      candidateId: candidate.candidateId, previousVersion: promotion.previousVersion,
      notBeforeMs: Date.now() + 2_000,
      previousPointer: (promotion.rollbackToken ?? null) as ActiveExtensionPointer | null,
    });
  },
  rollbackPromotion: async (promotion) => {
    await restoreMacosExtensionPointer(repoRoot, (promotion.rollbackToken ?? null) as ActiveExtensionPointer | null);
  },
  readRecord: async () => await readFile(updateStatusPath, "utf8")
    .then((value) => JSON.parse(value) as UpdateLifecycleRecord, () => null),
  writeRecord: async (record) => { await writeAtomicJson(updateStatusPath, record); updateStatus = record.status; },
  cleanupStale: async (candidate) => await cleanupStaleMacosUpdateCandidates(repoRoot, candidate?.candidateId),
});

async function processRuntimeRequest(fileName: string): Promise<void> {
  if (!/^[0-9a-f-]{36}\.json$/iu.test(fileName)) return;
  const requestPath = path.join(requestsDir, fileName);
  const id = fileName.slice(0, -5);
  const resultPath = path.join(resultsDir, fileName);
  let result: Record<string, unknown>;
  let refreshedCodePids: number[] | null = null;
  try {
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      version?: unknown; id?: unknown; workspace?: unknown; action?: unknown;
    };
    if (request.version !== 1 || request.id !== id) {
      throw new Error("Invalid Pocket workspace runtime request.");
    }
    if ((request.action === "checkUpdates" || request.action === "applyUpdate") && request.workspace === undefined) {
      updateStatus = request.action === "applyUpdate" ? await updater.downloadAndApply() : await updater.checkOnly();
      result = { version: 1, id, ok: true, update: updateStatus };
      await writeFile(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
      await rm(requestPath, { force: true });
      return;
    }
    if (typeof request.workspace !== "string" || !request.workspace.trim() || request.action !== undefined) {
      throw new Error("Invalid Pocket workspace runtime request.");
    }
    const canonical = await realpath(path.resolve(request.workspace));
    if (!(await stat(canonical)).isDirectory()) throw new Error("Workspace path is not a directory.");
    const key = workspaceKey(canonical);
    profileSyncStatus = await profileSync.apply({ allowExtensionChanges: runtimes.size === 0 });
    const existing = runtimes.get(key);
    if (existing) {
      refreshedCodePids = await assertMacosVscodeTopology({ app: vscodeRuntime.app, profile, launcher,
        bridgePid: existing.bridgePid, endpoint: supervisor.endpoint });
      result = { version: 1, id, ok: true, runtime: runtimeView(existing) };
    } else {
      const excluded = await bridgePidsFromLog();
      const launch = spawn(vscodeRuntime.codeExecutable, ["--user-data-dir", profile, "--extensions-dir", vscodeExtension.root,
        "--new-window", "--log", "trace", canonical], { stdio: "ignore", env: isolatedVscodeEnvironment(process.env, {
          codexHome, codexPath, endpoint: supervisor.endpoint, token: supervisor.token, launcherLog, electronRunAsNode: false,
        }) });
      const evidence = await waitForExtensionInitialize(launch, excluded);
      refreshedCodePids = await assertMacosVscodeTopology({ app: vscodeRuntime.app, profile, launcher,
        bridgePid: evidence.bridgePid, endpoint: supervisor.endpoint });
      const runtime = { id: `workspace:${evidence.bridgePid}`, workspace: canonical, bridgePid: evidence.bridgePid };
      runtimes.set(key, runtime);
      result = { version: 1, id, ok: true, runtime: runtimeView(runtime) };
    }
  } catch (error) { result = { version: 1, id, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (refreshedCodePids) await writeStatus(refreshedCodePids);
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
  await rm(requestPath, { force: true });
}

let codeProcess: ChildProcess | null = null;
try {
  const staleProfilePids = await stopMacosProfileProcesses(profile, vscodeRuntime.app);
  if (staleProfilePids.length > 0) {
    throw new Error(`macOS Pocket profile cleanup left owned PIDs: ${JSON.stringify(staleProfilePids)}`);
  }
  await supervisor.start();
  await writeFile(connectionPath, `${JSON.stringify({
    version: 1,
    endpoint: supervisor.endpoint,
    token: supervisor.token,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    runtimeControl: { requestsDir, resultsDir, statusFile: statusPath },
  })}\n`, { encoding: "utf8", mode: 0o600 });
  codeProcess = spawn(vscodeRuntime.codeExecutable, [
    "--user-data-dir", profile,
    "--extensions-dir", vscodeExtension.root,
    "--new-window",
    "--log", "trace",
    initialWorkspace,
  ], {
    stdio: "ignore",
    env: isolatedVscodeEnvironment(process.env, {
      codexHome,
      codexPath,
      endpoint: supervisor.endpoint,
      token: supervisor.token,
      launcherLog,
      electronRunAsNode: false,
    }),
  });
  const { bridgePid } = await waitForExtensionInitialize(codeProcess);
  let codePids = await assertMacosVscodeTopology({
    app: vscodeRuntime.app, profile, launcher, bridgePid, endpoint: supervisor.endpoint,
  });
  await verifyPocketClient();
  updateStatus = await updater.recover();
  runtimes.set(workspaceKey(initialWorkspace), { id: `workspace:${bridgePid}`, workspace: initialWorkspace, bridgePid });
  await writeStatus(codePids);
  process.stdout.write(`macOS Pocket Host and pinned VS Code ready. Connection file: ${connectionPath}\n`);
  await Promise.race([
    stopSignal,
    (async () => {
      while (!stopping) {
        await delay(1_000);
        await supervisor.assertReady();
        if (process.env.CODEX_POCKET_TEST_DISABLE_AUTOMATIC_UPDATES !== "1" && isPocketUpdateCheckDue(updateStatus.checkedAt)) {
          updateStatus = await updater.downloadAndApply();
        }
        else if (updateStatus.state === "staged" || updateStatus.state === "waitingForIdle") updateStatus = await updater.tick();
        else updateStatus = await updater.status();
        let liveCodePids: number[] = [];
        const checks = await Promise.all([...runtimes].map(async ([key, runtime]) => {
          try { return { key, codePids: await assertMacosVscodeTopology({ app: vscodeRuntime.app, profile, launcher,
            bridgePid: runtime.bridgePid, endpoint: supervisor.endpoint }) }; }
          catch { return { key, codePids: null }; }
        }));
        for (const check of checks) { if (check.codePids) liveCodePids = check.codePids; else runtimes.delete(check.key); }
        for (const entry of await readdir(requestsDir, { withFileTypes: true })) if (entry.isFile()) await processRuntimeRequest(entry.name);
        if (runtimes.size > 0 && liveCodePids.length === 0) {
          const first = [...runtimes.values()][0]!;
          liveCodePids = await assertMacosVscodeTopology({ app: vscodeRuntime.app, profile, launcher,
            bridgePid: first.bridgePid, endpoint: supervisor.endpoint });
        }
        await writeStatus(liveCodePids);
      }
    })(),
  ]);
} finally {
  stopping = true;
  await Promise.all([rm(connectionPath, { force: true }), rm(stopPath, { force: true })]);
  const leaked = await stopMacosProfileProcesses(profile, vscodeRuntime.app).catch(() => [-1]);
  if (leaked.length > 0) process.stderr.write(`macOS VS Code cleanup left owned PIDs: ${JSON.stringify(leaked)}\n`);
  await supervisor.stop();
  await writeFile(statusPath, `${JSON.stringify({ state: "stopped", ownerPid: process.pid }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
}
