import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { FileWorkspaceRuntimeAdapter } from "../../../packages/pocket-runtime/src/workspace-runtime-control.js";
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";
import type { Workspace } from "../../../packages/codex-core/src/workspace-manager.js";
import type { WorkspaceRuntime } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import type { ProfileSyncStatus } from "../../../packages/pocket-runtime/src/profile-sync-service.js";
import { PocketCodeService, type PocketCodeGateway } from "./pocket-code-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const connectionFile = path.join(repoRoot, ".codex-pocket", "phase-1", "connection.json");
const statusFile = path.join(repoRoot, ".codex-pocket", "phase-1", "host-status.json");

async function healthyAdapter(): Promise<FileWorkspaceRuntimeAdapter | null> {
  try {
    const connection = await readConnectionFile(connectionFile);
    if (!connection.runtimeControl) return null;
    const status = JSON.parse(await readFile(statusFile, "utf8")) as { state?: unknown; topology?: unknown; verifiedAtMs?: unknown };
    if (status.state !== "ready" || status.topology !== "sharedAppServer" || typeof status.verifiedAtMs !== "number" || Date.now() - status.verifiedAtMs > 5_000) return null;
    return new FileWorkspaceRuntimeAdapter(connection.runtimeControl);
  } catch {
    return null;
  }
}

class ProductionGateway implements PocketCodeGateway {
  #adapter: FileWorkspaceRuntimeAdapter | null = null;

  async ensureSupervisor(initialWorkspace: string): Promise<"started" | "reused"> {
    this.#adapter = await healthyAdapter();
    if (this.#adapter) return "reused";
    await access(path.join(repoRoot, "main.py"));
    const python = process.env.CODEX_POCKET_PYTHON_EXE ?? (process.platform === "win32" ? "python.exe" : "python3");
    const child = spawn(python, [path.join(repoRoot, "main.py")], {
      cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", CODEX_POCKET_INITIAL_WORKSPACE: initialWorkspace },
    });
    child.unref();
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      this.#adapter = await healthyAdapter();
      if (this.#adapter) return "started";
      if (child.exitCode !== null) throw new Error("Codex Pocket supervisor exited before reaching READY.");
      await delay(250);
    }
    throw new Error("Timed out waiting for the Codex Pocket shared topology READY state.");
  }

  async openWorkspace(workspace: Workspace): Promise<{ runtime: WorkspaceRuntime; alreadyConnected: boolean }> {
    if (!this.#adapter) throw new Error("Pocket supervisor is not ready.");
    const key = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
    const existing = (await this.#adapter.listRuntimes()).find((runtime) => key(runtime.workspace.path) === key(workspace.path));
    return existing ? { runtime: existing, alreadyConnected: true } : { runtime: await this.#adapter.openWorkspace(workspace), alreadyConnected: false };
  }

  async getProfileSyncStatus(): Promise<ProfileSyncStatus | null> {
    return await this.#adapter?.getProfileSyncStatus() ?? null;
  }
}

function profileLine(status: ProfileSyncStatus | null): string {
  if (!status) return "UNKNOWN";
  if (status.extensionsDeferred) return "WARNING (extensions deferred)";
  if (status.state === "upToDate") return "UP TO DATE";
  return status.state.toUpperCase();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "status") {
    const adapter = await healthyAdapter();
    if (!adapter) throw new Error("Codex Pocket supervisor is not READY.");
    const runtimes = await adapter.listRuntimes();
    process.stdout.write(`Codex Pocket\n\nSupervisor ............ READY\nProfile sync .......... ${profileLine(await adapter.getProfileSyncStatus())}\nWorkspaces ............ ${runtimes.length}\n`);
    for (const runtime of runtimes) process.stdout.write(`- ${runtime.workspace.path} [${runtime.state}]\n`);
    return;
  }
  const target = args[0] === "open" ? args[1] : args[0];
  if (args[0] === "open" && !target) throw new Error("Usage: pocket-code open <workspace>");
  if (args.length > (args[0] === "open" ? 2 : 1)) throw new Error("Usage: pocket-code [open] <workspace>");
  const invocationCwd = process.env.CODEX_POCKET_INVOKE_CWD;
  const result = await new PocketCodeService(new ProductionGateway(), invocationCwd ? { cwd: () => invocationCwd } : {}).open(target);
  process.stdout.write([
    "Codex Pocket", "", `Workspace:\n${result.workspace.path}`, "",
    `Supervisor ............ ${result.supervisor === "started" ? "STARTED / READY" : "READY"}`,
    `Profile sync .......... ${profileLine(result.profileSync)}`,
    `VS Code runtime ....... ${result.alreadyConnected ? "ALREADY CONNECTED" : "CONNECTED"}`,
    "", "Ready for remote access.", "",
  ].join("\n"));
}

main().catch((error: unknown) => {
  process.stderr.write(`pocket-code: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
