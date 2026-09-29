import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  PocketUpdateStatus,
  WorkspaceRuntime,
  WorkspaceRuntimeAdapter,
} from "../../codex-core/src/workspace-runtime-manager.js";
import type { Workspace } from "../../codex-core/src/workspace-manager.js";
import type { ProfileSyncStatus } from "./profile-sync-service.js";

const runtimeSchema = z.object({
  id: z.string(),
  workspace: z.object({ path: z.string(), displayName: z.string() }),
  state: z.enum(["connected", "disconnected", "opening"]),
  appServerPid: z.number().int().positive(),
  bridgePid: z.number().int().positive(),
});
const statusSchema = z.object({
  state: z.literal("ready"),
  verifiedAtMs: z.number(),
  runtimes: z.array(runtimeSchema),
  profileSync: z.object({
    state: z.enum(["upToDate", "changed", "warning", "failed"]),
    settings: z.enum(["synced", "unchanged", "failed"]),
    keybindings: z.enum(["synced", "unchanged", "missing", "failed"]),
    snippetsSynced: z.number().int().nonnegative(),
    extensionsSynced: z.number().int().nonnegative(),
    extensionsSkipped: z.array(z.object({ id: z.string(), version: z.string(), reason: z.string() })),
    extensionsDeferred: z.boolean(),
    lastSuccessfulSync: z.string().nullable(),
    warnings: z.array(z.string()),
  }).optional(),
  update: z.object({
    state: z.enum(["idle", "checking", "upToDate", "updateAvailable", "downloading", "staged", "waitingForIdle",
      "applying", "restarting", "ready", "rollingBack", "failed", "incompatible"]),
    currentVersion: z.string(),
    availableVersion: z.string().nullable(),
    checkedAt: z.string(),
    source: z.literal("visualStudioMarketplace"),
    restartRequired: z.boolean(),
    candidateSha256: z.string().optional(),
    candidateCliVersion: z.string().optional(),
    previousVersion: z.string().optional(),
    rollbackSucceeded: z.boolean().optional(),
    detail: z.string().optional(),
    error: z.string().optional(),
  }).optional(),
});
const resultSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  ok: z.boolean(),
  runtime: runtimeSchema.optional(),
  update: statusSchema.shape.update,
  error: z.string().optional(),
});

export interface RuntimeControlPaths {
  requestsDir: string;
  resultsDir: string;
  statusFile: string;
}

export class FileWorkspaceRuntimeAdapter implements WorkspaceRuntimeAdapter {
  readonly #paths: RuntimeControlPaths;
  readonly #timeoutMs: number;

  constructor(paths: RuntimeControlPaths, options: { timeoutMs?: number } = {}) {
    this.#paths = paths;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async listRuntimes(): Promise<WorkspaceRuntime[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const status = statusSchema.parse(JSON.parse(await readFile(this.#paths.statusFile, "utf8")));
        if (Date.now() - status.verifiedAtMs > 5_000) return [];
        return status.runtimes;
      } catch {
        if (attempt < 2) await delay(25);
      }
    }
    return [];
  }

  async getProfileSyncStatus(): Promise<ProfileSyncStatus | null> {
    try {
      const status = statusSchema.parse(JSON.parse(await readFile(this.#paths.statusFile, "utf8")));
      if (Date.now() - status.verifiedAtMs > 5_000) return null;
      return status.profileSync ?? null;
    } catch {
      return null;
    }
  }

  async openWorkspace(workspace: Workspace): Promise<WorkspaceRuntime> {
    const result = await this.#request({ workspace: workspace.path });
    if (!result.ok || !result.runtime) throw new Error(result.error ?? "Pocket VS Code could not open this workspace.");
    return result.runtime;
  }

  async checkForUpdates(): Promise<PocketUpdateStatus> {
    const result = await this.#request({ action: "checkUpdates" });
    if (!result.ok || !result.update) throw new Error(result.error ?? "Pocket update check failed.");
    const { error, ...status } = result.update;
    return { ...status, ...(error ? { error } : {}) };
  }

  async applyUpdate(): Promise<PocketUpdateStatus> {
    const result = await this.#request({ action: "applyUpdate" });
    if (!result.ok || !result.update) throw new Error(result.error ?? "Pocket update installation failed.");
    return { ...result.update };
  }

  async #request(payload: { workspace: string } | { action: "checkUpdates" | "applyUpdate" }): Promise<z.infer<typeof resultSchema>> {
    const id = randomUUID();
    await Promise.all([mkdir(this.#paths.requestsDir, { recursive: true }), mkdir(this.#paths.resultsDir, { recursive: true })]);
    const requestPath = path.join(this.#paths.requestsDir, `${id}.json`);
    const temporaryPath = `${requestPath}.${process.pid}.tmp`;
    const resultPath = path.join(this.#paths.resultsDir, `${id}.json`);
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, id, ...payload })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, requestPath);
    const deadline = Date.now() + this.#timeoutMs;
    try {
      while (Date.now() < deadline) {
        try {
          const result = resultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
          return result;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            await delay(200);
            continue;
          }
          throw error;
        }
      }
      throw new Error("Timed out waiting for the Pocket VS Code workspace runtime.");
    } finally {
      await Promise.all([rm(requestPath, { force: true }), rm(resultPath, { force: true }), rm(temporaryPath, { force: true })]);
    }
  }
}
