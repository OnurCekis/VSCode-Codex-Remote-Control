import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { LoopbackWebSocketSupervisor } from "./loopback-websocket-supervisor.js";
import { preparePinnedVscodeExtension, preparePinnedVscodeRuntime } from "./pinned-vscode-runtime.js";

const initializeSchema = z.object({ platformOs: z.string(), userAgent: z.string() }).passthrough();

const runtime = await preparePinnedVscodeRuntime({ repoRoot: process.cwd() });
const extension = await preparePinnedVscodeExtension({ repoRoot: process.cwd(), runtime });
const codexPath = process.env.CODEX_POCKET_CODEX_EXE ?? extension.codexExecutable;
const launcher = path.resolve("tools", "vscode-proxy", "dist", "codex-pocket-proxy.exe");
const codexHome = path.resolve(".codex-pocket", "phase-0-7-smoke-home");
const logDirectory = path.resolve(".codex-pocket", "phase-0-7-logs");
await Promise.all([access(codexPath), access(launcher), mkdir(codexHome, { recursive: true }), mkdir(logDirectory, { recursive: true })]);
const logPath = path.join(logDirectory, `launcher-smoke-${Date.now()}.jsonl`);
const supervisor = new LoopbackWebSocketSupervisor({ codexPath, codexHome });
let child: ReturnType<typeof spawn> | null = null;
try {
  await supervisor.start();
  child = spawn(launcher, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_POCKET_CODEX_EXE: codexPath,
      CODEX_POCKET_WS_URL: supervisor.endpoint,
      CODEX_POCKET_WS_TOKEN: supervisor.token,
      CODEX_POCKET_PROXY_LOG: logPath,
    },
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Launcher stdio was not piped.");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const peer = new JsonRpcPeer(child.stdout, child.stdin, {
    requestTimeoutMs: 30_000,
    closeTransport: () => { if (child && !child.killed) child.kill(); },
  });
  const initialized = initializeSchema.parse(await peer.request("initialize", {
    clientInfo: { name: "codex_vscode", title: "Phase 0.7 Launcher Smoke", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  }));
  peer.notify("initialized", {});
  await peer.request("thread/loaded/list", { limit: 1 });
  await peer.close();
  console.log(JSON.stringify({
    passed: true,
    bridge: "extension-stdio-to-authenticated-loopback-websocket",
    platformOs: initialized.platformOs,
    log: path.relative(process.cwd(), logPath),
  }));
  if (stderr.trim()) console.error(stderr.trim());
} finally {
  if (child && !child.killed) child.kill();
  await supervisor.stop();
}
