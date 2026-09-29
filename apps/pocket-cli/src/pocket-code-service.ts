import path from "node:path";
import { WorkspaceManager, type Workspace } from "../../../packages/codex-core/src/workspace-manager.js";
import type { WorkspaceRuntime } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import type { ProfileSyncStatus } from "../../../packages/pocket-runtime/src/profile-sync-service.js";

export interface PocketCodeGateway {
  ensureSupervisor(initialWorkspace: string): Promise<"started" | "reused">;
  openWorkspace(workspace: Workspace): Promise<{ runtime: WorkspaceRuntime; alreadyConnected: boolean }>;
  getProfileSyncStatus(): Promise<ProfileSyncStatus | null>;
}

export interface PocketCodeOpenResult {
  workspace: Workspace;
  supervisor: "started" | "reused";
  runtime: WorkspaceRuntime;
  alreadyConnected: boolean;
  profileSync: ProfileSyncStatus | null;
}

export class PocketCodeService {
  readonly #gateway: PocketCodeGateway;
  readonly #workspaces: WorkspaceManager;
  readonly #cwd: () => string;

  constructor(gateway: PocketCodeGateway, options: { workspaces?: WorkspaceManager; cwd?: () => string } = {}) {
    this.#gateway = gateway;
    this.#workspaces = options.workspaces ?? new WorkspaceManager();
    this.#cwd = options.cwd ?? process.cwd;
  }

  async resolveTarget(argument?: string): Promise<Workspace> {
    const target = !argument || argument === "." ? this.#cwd() : path.resolve(this.#cwd(), argument);
    return await this.#workspaces.validate(target);
  }

  async open(argument?: string): Promise<PocketCodeOpenResult> {
    const workspace = await this.resolveTarget(argument);
    const supervisor = await this.#gateway.ensureSupervisor(workspace.path);
    const opened = await this.#gateway.openWorkspace(workspace);
    const profileSync = await this.#gateway.getProfileSyncStatus();
    return { workspace, supervisor, runtime: opened.runtime, alreadyConnected: opened.alreadyConnected, profileSync };
  }
}
