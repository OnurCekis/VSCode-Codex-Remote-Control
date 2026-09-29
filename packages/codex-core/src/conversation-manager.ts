import type { ManagedSession, SessionManager } from "./session-manager.js";
import type { CodexAdapter, NewConversationOptions } from "./codex-adapter.js";
import type { WorkspaceManager } from "./workspace-manager.js";

export class ConversationWorkspaceMismatchError extends Error {
  readonly session: ManagedSession;

  constructor(session: ManagedSession) {
    super("This conversation belongs to a different workspace.");
    this.session = session;
  }
}

export class ConversationManager {
  readonly #sessions: SessionManager;
  readonly #workspaces: WorkspaceManager;
  readonly #adapter: CodexAdapter;

  constructor(sessions: SessionManager, workspaces: WorkspaceManager, adapter: CodexAdapter) {
    this.#sessions = sessions;
    this.#workspaces = workspaces;
    this.#adapter = adapter;
  }

  async create(options: NewConversationOptions): Promise<ManagedSession> {
    const workspace = this.#workspaces.active;
    if (!workspace) throw new Error("Select a workspace before creating a conversation.");
    if (!this.#adapter.createSession) throw new Error("This Codex runtime cannot create conversations.");
    const created = await this.#adapter.createSession(workspace.path, options);
    if (!this.#workspaces.matches(created.cwd, workspace)) throw new ConversationWorkspaceMismatchError({ ...created, activeTurnId: null });
    const managed = { ...created, activeTurnId: null };
    await this.#sessions.commitSelection(managed);
    return managed;
  }

  async list(scope: "workspace" | "all" = "workspace"): Promise<ManagedSession[]> {
    const sessions = await this.#sessions.discover();
    const active = this.#workspaces.active;
    const visible = scope === "all" || !active ? sessions : sessions.filter((session) => this.#workspaces.matches(session.cwd, active));
    const selected = this.#sessions.selected;
    if (selected && !visible.some((session) => session.id === selected.id) &&
        (scope === "all" || !active || this.#workspaces.matches(selected.cwd, active))) visible.unshift(selected);
    return visible;
  }

  relation(session: ManagedSession): "same" | "different" | "unselected" {
    const active = this.#workspaces.active;
    if (!active) return "unselected";
    return this.#workspaces.matches(session.cwd, active) ? "same" : "different";
  }

  async select(sessionId: string, options: { switchWorkspace?: boolean } = {}): Promise<ManagedSession> {
    const session = this.#sessions.known.find((entry) => entry.id === sessionId);
    if (!session) throw new Error(`Session is not discovered: ${sessionId}`);
    const relation = this.relation(session);
    if (relation === "different" && !options.switchWorkspace) throw new ConversationWorkspaceMismatchError(session);
    if (relation === "unselected") return await this.#sessions.use(sessionId);
    if (relation === "same") {
      const attached = await this.#sessions.attachCandidate(sessionId);
      if (!this.#workspaces.matches(attached.cwd)) throw new ConversationWorkspaceMismatchError(attached);
      await this.#sessions.commitSelection(attached);
      return attached;
    }

    // Validate before attach, but commit neither selection until the exact existing thread attaches successfully.
    await this.#workspaces.validate(session.cwd);
    const attached = await this.#sessions.attachCandidate(sessionId);
    const runtimeWorkspace = await this.#workspaces.validate(attached.cwd);
    await this.#workspaces.activate(runtimeWorkspace);
    await this.#sessions.commitSelection(attached);
    return attached;
  }
}
