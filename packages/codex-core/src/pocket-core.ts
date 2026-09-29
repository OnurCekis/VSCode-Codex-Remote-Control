import type { CodexAdapter } from "./codex-adapter.js";
import { ApprovalManager } from "./approval-manager.js";
import { SessionManager } from "./session-manager.js";
import { TaskManager } from "./task-manager.js";
import { ConversationManager } from "./conversation-manager.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceRuntimeManager, type WorkspaceRuntimeAdapter } from "./workspace-runtime-manager.js";
import { LiveOutputManager } from "./live-output-manager.js";

export class PocketCore {
  readonly adapter: CodexAdapter;
  readonly sessions: SessionManager;
  readonly approvals: ApprovalManager;
  readonly tasks: TaskManager;
  readonly workspaces: WorkspaceManager;
  readonly conversations: ConversationManager;
  readonly runtimes: WorkspaceRuntimeManager | null;
  readonly liveOutput: LiveOutputManager;

  constructor(adapter: CodexAdapter, options: {
    workspaceStateFile?: string;
    runtimeAdapter?: WorkspaceRuntimeAdapter;
    runtimeId?: string;
    extraWorkspaceBrowseRoots?: readonly string[];
  } = {}) {
    this.adapter = adapter;
    this.liveOutput = new LiveOutputManager(adapter, options.runtimeId);
    this.sessions = new SessionManager(adapter, async (session) => {
      if (session.topology === "sharedLive" && session.activeTurnId) {
        await this.liveOutput.observeActiveTurn({
          runtimeId: options.runtimeId ?? "primary",
          threadId: session.id,
          turnId: session.activeTurnId,
        });
      }
    });
    this.approvals = new ApprovalManager(adapter);
    this.workspaces = new WorkspaceManager({
      ...(options.workspaceStateFile ? { stateFile: options.workspaceStateFile } : {}),
      ...(options.extraWorkspaceBrowseRoots ? { extraRootCandidates: options.extraWorkspaceBrowseRoots } : {}),
    });
    this.conversations = new ConversationManager(this.sessions, this.workspaces, adapter);
    this.tasks = new TaskManager(adapter, this.sessions, this.workspaces);
    this.runtimes = options.runtimeAdapter ? new WorkspaceRuntimeManager(options.runtimeAdapter, this.workspaces) : null;
  }

  async models() {
    if (!this.adapter.listModels) throw new Error("This Codex runtime does not expose a model catalog.");
    return await this.adapter.listModels();
  }

  async close(): Promise<void> {
    this.liveOutput.close();
    this.approvals.close();
    this.sessions.close();
    await this.adapter.close();
  }
}
