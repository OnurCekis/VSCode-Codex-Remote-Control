import type { CodexAdapter } from "./codex-adapter.js";
import type { SessionManager } from "./session-manager.js";
import type { WorkspaceManager } from "./workspace-manager.js";

export class TaskManager {
  readonly #adapter: CodexAdapter;
  readonly #sessions: SessionManager;
  readonly #workspaces: WorkspaceManager | undefined;

  constructor(adapter: CodexAdapter, sessions: SessionManager, workspaces?: WorkspaceManager) {
    this.#adapter = adapter;
    this.#sessions = sessions;
    this.#workspaces = workspaces;
  }

  async send(prompt: string): Promise<string> {
    const session = this.#sessions.selected;
    if (!session) throw new Error("No session selected. Use 'sessions' and 'use <session>' first.");
    if (!prompt.trim()) throw new Error("Prompt must not be empty.");
    if (session.status.type === "active") throw new Error("Session already has an active turn.");
    if (session.activeTurnId) throw new Error(`Session already has an active turn: ${session.activeTurnId}`);
    if (session.canAcceptDirectInput === false) throw new Error("The shared App Server does not accept direct input for this conversation.");
    const workspace = this.#workspaces?.active;
    if (workspace && !this.#workspaces!.matches(session.cwd, workspace)) {
      throw new Error("Active conversation belongs to a different workspace. Select a matching conversation before sending a task.");
    }
    const turnId = await this.#adapter.startTask(session.id, prompt, workspace?.path);
    this.#sessions.setActiveTurn(session.id, turnId);
    return turnId;
  }

  async stop(): Promise<string> {
    const session = this.#sessions.selected;
    if (!session) throw new Error("No session selected.");
    if (!session.activeTurnId) throw new Error("The selected session has no active turn.");
    const turnId = session.activeTurnId;
    await this.#adapter.interruptTask(session.id, turnId);
    return turnId;
  }
}
