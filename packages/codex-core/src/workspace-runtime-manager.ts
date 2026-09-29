import type { CodexSession } from "./domain-events.js";
import type { Workspace, WorkspaceManager } from "./workspace-manager.js";

export type WorkspaceRuntimeState = "connected" | "disconnected" | "opening";

export interface WorkspaceRuntime {
  id: string;
  workspace: Workspace;
  state: WorkspaceRuntimeState;
  appServerPid: number;
  bridgePid: number;
}

export interface PocketUpdateStatus {
  state: "idle" | "checking" | "upToDate" | "updateAvailable" | "downloading" | "staged" |
    "waitingForIdle" | "applying" | "restarting" | "ready" | "rollingBack" | "failed" | "incompatible";
  currentVersion: string;
  availableVersion: string | null;
  checkedAt: string;
  source: "visualStudioMarketplace";
  restartRequired: boolean;
  candidateSha256?: string | undefined;
  candidateCliVersion?: string | undefined;
  previousVersion?: string | undefined;
  rollbackSucceeded?: boolean | undefined;
  detail?: string | undefined;
  error?: string | undefined;
}

export interface WorkspaceRuntimeAdapter {
  listRuntimes(): Promise<WorkspaceRuntime[]>;
  openWorkspace(workspace: Workspace): Promise<WorkspaceRuntime>;
  checkForUpdates?(): Promise<PocketUpdateStatus>;
  applyUpdate?(): Promise<PocketUpdateStatus>;
}

export class WorkspaceRuntimeManager {
  readonly #adapter: WorkspaceRuntimeAdapter;
  readonly #workspaces: WorkspaceManager;
  #runtimes: WorkspaceRuntime[] = [];

  constructor(adapter: WorkspaceRuntimeAdapter, workspaces: WorkspaceManager) {
    this.#adapter = adapter;
    this.#workspaces = workspaces;
  }

  get known(): WorkspaceRuntime[] {
    return structuredClone(this.#runtimes);
  }

  async listRuntimes(): Promise<WorkspaceRuntime[]> {
    this.#runtimes = await this.#adapter.listRuntimes();
    return this.known;
  }

  async findRuntimeForWorkspace(workspace: Workspace | string): Promise<WorkspaceRuntime | null> {
    const target = typeof workspace === "string" ? workspace : workspace.path;
    let canonicalTarget: string;
    try {
      canonicalTarget = (await this.#workspaces.validate(target)).path;
    } catch {
      return null;
    }
    const runtimes = await this.listRuntimes();
    return runtimes.find((runtime) => this.#workspaces.matches(canonicalTarget, runtime.workspace)) ?? null;
  }

  async findRuntimeForThread(session: CodexSession): Promise<WorkspaceRuntime | null> {
    if (session.topology !== "sharedLive") return null;
    return await this.findRuntimeForWorkspace(session.cwd);
  }

  async openWorkspace(target: string): Promise<WorkspaceRuntime> {
    const workspace = await this.#workspaces.validate(target);
    const existing = await this.findRuntimeForWorkspace(workspace);
    if (existing?.state === "connected") return existing;
    const opened = await this.#adapter.openWorkspace(workspace);
    this.#runtimes = [opened, ...this.#runtimes.filter((runtime) =>
      !this.#workspaces.matches(runtime.workspace.path, workspace))];
    return structuredClone(opened);
  }

  async checkForUpdates(): Promise<PocketUpdateStatus> {
    if (!this.#adapter.checkForUpdates) throw new Error("Update checks are not available on this Pocket host.");
    return await this.#adapter.checkForUpdates();
  }

  async applyUpdate(): Promise<PocketUpdateStatus> {
    if (!this.#adapter.applyUpdate) throw new Error("Updates cannot be installed on this Pocket host.");
    return await this.#adapter.applyUpdate();
  }
}
