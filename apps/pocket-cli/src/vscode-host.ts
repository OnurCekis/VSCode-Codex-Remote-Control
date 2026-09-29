import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { LoopbackWebSocketSupervisor } from "../../ipc-probe/src/loopback-websocket-supervisor.js";
import { ProtocolLog } from "../../ipc-probe/src/protocol-log.js";
import { connectWebSocketPeer } from "../../ipc-probe/src/websocket-json-rpc.js";
import {
  PINNED_VSCODE_COMMIT,
  PINNED_VSCODE_VERSION,
  preparePinnedVscodeExtension,
  preparePinnedVscodeRuntime,
} from "../../ipc-probe/src/pinned-vscode-runtime.js";
import { ProfileSyncService, type JsonValue } from "../../../packages/pocket-runtime/src/profile-sync-service.js";
import { isolatedVscodeEnvironment } from "./vscode-launch-environment.js";

const execFileAsync = promisify(execFile);
const PINNED_EXTENSION_VERSION = "26.814.41407";

const repoRoot = process.cwd();
const runRoot = path.resolve(".codex-pocket", "phase-1");
const connectionPath = path.join(runRoot, "connection.json");
const statusPath = path.join(runRoot, "host-status.json");
const stopPath = path.join(runRoot, "host-stop");
const requestsDir = path.join(runRoot, "runtime-requests");
const resultsDir = path.join(runRoot, "runtime-results");
const initialWorkspace = await realpath(path.resolve(process.env.CODEX_POCKET_INITIAL_WORKSPACE ?? repoRoot));
const profile = path.resolve(".codex-pocket", "phase-0-7", "vscode-profile");
const settingsDirectory = path.join(profile, "User");
const dailyUserDirectory = path.resolve(process.env.CODEX_POCKET_DAILY_USER_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Code", "User"));
const dailyExtensionsDirectory = path.resolve(process.env.CODEX_POCKET_DAILY_EXTENSIONS_DIR ?? path.join(os.homedir(), ".vscode", "extensions"));
const launcher = path.resolve("tools", "vscode-proxy", "dist", "codex-pocket-proxy.exe");
const vscodeRuntime = await preparePinnedVscodeRuntime({
  repoRoot,
  ...(process.env.CODEX_POCKET_CODE_EXE ? { explicitCodeExecutable: process.env.CODEX_POCKET_CODE_EXE } : {}),
});
const { codeExecutable, codeCli } = vscodeRuntime;
const vscodeExtension = await preparePinnedVscodeExtension({ repoRoot, runtime: vscodeRuntime });
const codexPath = process.env.CODEX_POCKET_CODEX_EXE ?? vscodeExtension.codexExecutable;
const codexHome = process.env.CODEX_POCKET_INTEGRATION_CODEX_HOME ?? path.join(os.homedir(), ".codex");
const launcherLog = path.join(runRoot, "logs", `vscode-${Date.now()}.jsonl`);
const protectedSettings: Record<string, JsonValue> = {
  "chatgpt.cliExecutable": launcher,
  "chatgpt.openOnStartup": true,
  "chatgpt.runCodexInWindowsSubsystemForLinux": false,
  "extensions.autoUpdate": "off",
  "extensions.autoCheckUpdates": false,
  "security.workspace.trust.enabled": false,
};

interface ExtensionEvidence { bridgePid: number }
interface RuntimeRecord { id: string; workspace: string; bridgePid: number }

function workspaceKey(value: string): string {
  return path.win32.normalize(value).replace(/[\\/]+$/u, "").toLowerCase();
}

async function waitForExtensionInitialize(
  codeProcess: ChildProcess | null,
  endpoint: string,
  excludedPids: ReadonlySet<number> = new Set(),
): Promise<ExtensionEvidence> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (codeProcess?.exitCode !== null && codeProcess?.exitCode !== undefined && codeProcess.exitCode !== 0) {
      throw new Error(`VS Code CLI exited with ${codeProcess.exitCode}.`);
    }
    try {
      const rows = (await readFile(launcherLog, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
        bridgePid?: number;
        direction: string; message: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown; pid?: number };
      });
      const bridge = rows.find((row) => row.direction === "meta" &&
        (row.message as { event?: string }).event === "bridge/start" &&
        Number.isSafeInteger(row.message.pid) && !excludedPids.has(row.message.pid as number)) as
        ({ message: { endpoint?: string; pid?: number } } | undefined);
      const request = bridge ? rows.find((row) => row.bridgePid === bridge.message.pid && row.direction === "out" && row.message.method === "initialize") : undefined;
      if (request && bridge) {
        if (bridge.message.endpoint !== `${endpoint}/` && bridge.message.endpoint !== endpoint) {
          throw new Error("Extension proxy connected to an unexpected App Server endpoint.");
        }
        if (!Number.isSafeInteger(bridge.message.pid) || (bridge.message.pid ?? 0) <= 0) {
          throw new Error("Extension proxy did not report a valid process ID.");
        }
        const client = (request.message.params as { clientInfo?: { name?: string; title?: string; version?: string } }).clientInfo;
        if (client?.name !== "VS Code" || client.title !== "Codex Extension" || client.version !== PINNED_EXTENSION_VERSION) {
          throw new Error(`Unexpected extension identity: ${JSON.stringify(client)}`);
        }
        const response = rows.find((row) => row.bridgePid === bridge.message.pid && row.direction === "in" && row.message.id === request.message.id);
        if (response?.message.error) throw new Error(`Extension initialize failed: ${JSON.stringify(response.message.error)}`);
        if (response?.message.result) return { bridgePid: bridge.message.pid as number };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message.includes("ENOENT"))) throw error;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the pinned Codex extension initialize exchange.");
}

async function powershellJson<T>(script: string): Promise<T> {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 10_000,
  });
  return JSON.parse(stdout.trim()) as T;
}

async function assertProcessTopology(options: {
  codeExecutable: string; profile: string; launcher: string; bridgePid: number; endpoint: string;
}): Promise<number[]> {
  const escape = (value: string): string => value.replaceAll("'", "''");
  const port = Number.parseInt(new URL(options.endpoint).port, 10);
  const script = [
    `$profile='${escape(options.profile)}'`,
    `$code='${escape(path.resolve(options.codeExecutable))}'`,
    `$launcher='${escape(path.resolve(options.launcher))}'`,
    `$bridge=Get-CimInstance Win32_Process -Filter \"ProcessId = ${options.bridgePid}\" -ErrorAction SilentlyContinue`,
    `$codes=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.ExecutablePath -eq $code -and $_.CommandLine -like ('*'+$profile+'*') } | ForEach-Object { $_.ProcessId })`,
    `$tcp=@(Get-NetTCPConnection -State Established -OwningProcess ${options.bridgePid} -RemoteAddress '127.0.0.1' -RemotePort ${port} -ErrorAction SilentlyContinue)`,
    `[pscustomobject]@{ bridgeOk=[bool]($bridge -and $bridge.ExecutablePath -eq $launcher); codePids=$codes; tcpOk=($tcp.Count -gt 0) } | ConvertTo-Json -Compress`,
  ].join("; ");
  const result = await powershellJson<{ bridgeOk: boolean; codePids: number | number[] | null; tcpOk: boolean }>(script);
  const codePids = result.codePids === null ? [] : Array.isArray(result.codePids) ? result.codePids : [result.codePids];
  if (!result.bridgeOk) throw new Error("Pinned VS Code proxy process is not running from the owned launcher.");
  if (codePids.length === 0) throw new Error("Pinned isolated VS Code process is not running with the owned profile.");
  if (!result.tcpOk) throw new Error("VS Code proxy is not connected to the Pocket-owned App Server endpoint.");
  return codePids;
}

async function assertPocketClientB(supervisor: LoopbackWebSocketSupervisor): Promise<void> {
  const log = new ProtocolLog(path.join(runRoot, "logs", `topology-${Date.now()}.jsonl`), [supervisor.token]);
  const connection = await connectWebSocketPeer({
    url: supervisor.endpoint, token: supervisor.token, name: "codex_pocket_topology_probe", log, timeoutMs: 15_000,
  });
  try {
    await connection.peer.request("thread/loaded/list", { limit: 1 });
  } finally {
    await connection.close();
  }
}

async function restrictOwnerOnly(file: string): Promise<void> {
  const escaped = file.replaceAll("'", "''");
  const script = `$p='${escaped}'; $id=[Security.Principal.WindowsIdentity]::GetCurrent().Name; & icacls.exe $p /inheritance:r /grant:r ($id + ':(R,W)') | Out-Null; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}

async function bridgePidsFromLog(): Promise<Set<number>> {
  const pids = new Set<number>();
  try {
    for (const line of (await readFile(launcherLog, "utf8")).split(/\r?\n/u)) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { direction?: string; message?: { event?: string; pid?: number } };
        if (row.direction === "meta" && row.message?.event === "bridge/start" &&
          Number.isSafeInteger(row.message.pid) && (row.message.pid ?? 0) > 0) pids.add(row.message.pid!);
      } catch { /* A concurrently appended trailing row is retried on the next pass. */ }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return pids;
}

function runtimeView(runtime: RuntimeRecord, appServerPid: number): {
  id: string; workspace: { path: string; displayName: string }; state: "connected";
  appServerPid: number; bridgePid: number;
} {
  return {
    id: runtime.id,
    workspace: { path: runtime.workspace, displayName: path.basename(runtime.workspace) || runtime.workspace },
    state: "connected",
    appServerPid,
    bridgePid: runtime.bridgePid,
  };
}

async function clearControlDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:json|tmp)$/u.test(entry.name)) await rm(path.join(directory, entry.name), { force: true });
  }
  await restrictOwnerOnly(directory);
}

await Promise.all([
  access(launcher), access(codexPath), access(codeExecutable), access(codeCli),
  mkdir(settingsDirectory, { recursive: true }), mkdir(path.dirname(launcherLog), { recursive: true }),
  rm(connectionPath, { force: true }), rm(statusPath, { force: true }), rm(stopPath, { force: true }),
]);
await Promise.all([clearControlDirectory(requestsDir), clearControlDirectory(resultsDir)]);
const { stdout: versionOutput } = await execFileAsync(codeExecutable, [codeCli, "--version"], {
  windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
const [version, commit] = versionOutput.trim().split(/\r?\n/u);
if (version !== PINNED_VSCODE_VERSION || commit !== PINNED_VSCODE_COMMIT) {
  throw new Error(`Pinned VS Code mismatch: ${JSON.stringify({ version, commit })}`);
}
async function verifyProfileInvariants(): Promise<void> {
  const effective = JSON.parse(await readFile(path.join(settingsDirectory, "settings.json"), "utf8")) as Record<string, unknown>;
  for (const [key, expected] of Object.entries(protectedSettings)) {
    if (JSON.stringify(effective[key]) !== JSON.stringify(expected)) throw new Error(`Protected Pocket setting mismatch: ${key}`);
  }
  await access(launcher);
  await preparePinnedVscodeRuntime({ repoRoot, explicitCodeExecutable: codeExecutable });
  await preparePinnedVscodeExtension({ repoRoot, runtime: vscodeRuntime });
}

const profileSync = new ProfileSyncService({
  paths: {
    dailyUserDir: dailyUserDirectory,
    dailyExtensionsDir: dailyExtensionsDirectory,
    pocketUserDir: settingsDirectory,
    pocketExtensionsDir: vscodeExtension.root,
    stateFile: path.join(runRoot, "profile-sync-state.json"),
  },
  protectedSettings,
  pinnedVscodeVersion: PINNED_VSCODE_VERSION,
  pinnedCodexExtension: { id: "openai.chatgpt", version: PINNED_EXTENSION_VERSION, directoryName: path.basename(vscodeExtension.extensionDirectory) },
  verifyProtectedInvariants: verifyProfileInvariants,
});
let profileSyncStatus = await profileSync.apply({ allowExtensionChanges: true });

const supervisor = new LoopbackWebSocketSupervisor({ codexPath, codexHome });
let codeProcess: ChildProcess | null = null;
let stopping = false;
const runtimes = new Map<string, RuntimeRecord>();
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

async function writeStatus(codePids: number[]): Promise<void> {
  const runtimeList = [...runtimes.values()];
  const primary = runtimeList[0] ?? null;
  const temporaryStatusPath = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporaryStatusPath, `${JSON.stringify({
    state: "ready", ownerPid: process.pid, connectionFile: connectionPath,
    workspace: primary?.workspace ?? null, profile, vscodeVersion: version, vscodeCommit: commit,
    extensionVersion: PINNED_EXTENSION_VERSION, topology: "sharedAppServer",
    appServerPid: supervisor.pid, bridgePid: primary?.bridgePid ?? null, codePids, launcherLog,
    profileSync: profileSyncStatus,
    runtimes: runtimeList.map((runtime) => runtimeView(runtime, supervisor.pid!)),
    verifiedAtMs: Date.now(),
  }, null, 2)}\n`, "utf8");
  await rename(temporaryStatusPath, statusPath);
}

async function processRuntimeRequest(fileName: string): Promise<void> {
  if (!/^[0-9a-f-]{36}\.json$/iu.test(fileName)) return;
  const requestPath = path.join(requestsDir, fileName);
  const id = fileName.slice(0, -5);
  const resultPath = path.join(resultsDir, fileName);
  let result: Record<string, unknown>;
  let refreshedCodePids: number[] | null = null;
  try {
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { version?: unknown; id?: unknown; workspace?: unknown };
    if (request.version !== 1 || request.id !== id || typeof request.workspace !== "string" || !request.workspace.trim()) {
      throw new Error("Invalid Pocket workspace runtime request.");
    }
    const canonical = path.win32.normalize(await realpath(path.resolve(request.workspace)));
    if (!(await stat(canonical)).isDirectory()) throw new Error("Workspace path is not a directory.");
    const key = workspaceKey(canonical);
    profileSyncStatus = await profileSync.apply({ allowExtensionChanges: runtimes.size === 0 });
    const existing = runtimes.get(key);
    if (existing) {
      refreshedCodePids = await assertProcessTopology({ codeExecutable, profile, launcher, bridgePid: existing.bridgePid, endpoint: supervisor.endpoint });
      result = { version: 1, id, ok: true, runtime: runtimeView(existing, supervisor.pid!) };
    } else {
      const existingBridgePids = await bridgePidsFromLog();
      const launch = spawn(codeExecutable, [codeCli,
        "--user-data-dir", profile,
        "--extensions-dir", vscodeExtension.root,
        "--new-window", "--log", "trace", canonical,
      ], {
        stdio: "ignore", windowsHide: false,
        env: isolatedVscodeEnvironment(process.env, {
          codexHome, codexPath, endpoint: supervisor.endpoint, token: supervisor.token, launcherLog,
        }),
      });
      const evidence = await waitForExtensionInitialize(launch, supervisor.endpoint, existingBridgePids);
      refreshedCodePids = await assertProcessTopology({ codeExecutable, profile, launcher, bridgePid: evidence.bridgePid, endpoint: supervisor.endpoint });
      const runtime: RuntimeRecord = { id: `workspace:${evidence.bridgePid}`, workspace: canonical, bridgePid: evidence.bridgePid };
      runtimes.set(key, runtime);
      result = { version: 1, id, ok: true, runtime: runtimeView(runtime, supervisor.pid!) };
    }
  } catch (error) {
    result = { version: 1, id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (refreshedCodePids) await writeStatus(refreshedCodePids);
  await writeFile(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
  await rm(requestPath, { force: true });
}

try {
  await supervisor.start();
  await writeFile(connectionPath, `${JSON.stringify({
    version: 1, endpoint: supervisor.endpoint, token: supervisor.token,
    createdAt: new Date().toISOString(), ownerPid: process.pid,
    runtimeControl: { requestsDir, resultsDir, statusFile: statusPath },
  })}\n`, { encoding: "utf8", mode: 0o600 });
  await restrictOwnerOnly(connectionPath);
  codeProcess = spawn(codeExecutable, [codeCli,
    "--user-data-dir", profile,
    "--extensions-dir", vscodeExtension.root,
    "--new-window", "--log", "trace", initialWorkspace,
  ], {
    stdio: "ignore", windowsHide: false,
    env: isolatedVscodeEnvironment(process.env, {
      codexHome, codexPath, endpoint: supervisor.endpoint, token: supervisor.token, launcherLog,
    }),
  });
  const { bridgePid } = await waitForExtensionInitialize(codeProcess, supervisor.endpoint);
  const codePids = await assertProcessTopology({ codeExecutable, profile, launcher, bridgePid, endpoint: supervisor.endpoint });
  await assertPocketClientB(supervisor);
  runtimes.set(workspaceKey(initialWorkspace), { id: `workspace:${bridgePid}`, workspace: initialWorkspace, bridgePid });
  await writeStatus(codePids);
  process.stdout.write(`Phase 1 host ready. Connection file: ${connectionPath}\n`);
  await Promise.race([
    stopSignal,
    (async () => {
      while (!stopping) {
        await delay(1_000);
        let liveCodePids: number[] = [];
        const checks = await Promise.all([...runtimes].map(async ([key, runtime]) => {
          try {
            return { key, codePids: await assertProcessTopology({
              codeExecutable, profile, launcher, bridgePid: runtime.bridgePid, endpoint: supervisor.endpoint,
            }) };
          } catch {
            return { key, codePids: null };
          }
        }));
        for (const check of checks) {
          if (check.codePids) liveCodePids = check.codePids;
          else runtimes.delete(check.key);
        }
        for (const entry of await readdir(requestsDir, { withFileTypes: true })) {
          if (entry.isFile()) await processRuntimeRequest(entry.name);
        }
        if (runtimes.size > 0 && liveCodePids.length === 0) {
          const first = [...runtimes.values()][0]!;
          liveCodePids = await assertProcessTopology({ codeExecutable, profile, launcher, bridgePid: first.bridgePid, endpoint: supervisor.endpoint });
        }
        await writeStatus(liveCodePids);
      }
    })(),
  ]);
} finally {
  await rm(connectionPath, { force: true });
  await rm(stopPath, { force: true });
  const escapedProfile = profile.replaceAll("'", "''");
  const stopScript = `$p='${escapedProfile}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like ('*'+$p+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopScript], { windowsHide: true }).catch(() => undefined);
  await supervisor.stop();
  await writeFile(statusPath, `${JSON.stringify({ state: "stopped", ownerPid: process.pid }, null, 2)}\n`, "utf8").catch(() => undefined);
}
