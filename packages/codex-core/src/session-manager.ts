import { ForeignActiveSessionError, type CodexAdapter, type SessionQuery } from "./codex-adapter.js";
import type { CodexSession, ConversationPreview } from "./domain-events.js";

export interface ManagedSession extends CodexSession {
  activeTurnId: string | null;
}

export class SessionManager {
  readonly #adapter: CodexAdapter;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #pocketTurns = new Map<string, string>();
  #selectedId: string | null = null;
  readonly #unsubscribe: () => void;
  readonly #onSelection: ((session: ManagedSession) => Promise<void>) | undefined;

  constructor(adapter: CodexAdapter, onSelection?: (session: ManagedSession) => Promise<void>) {
    this.#adapter = adapter;
    this.#onSelection = onSelection;
    this.#unsubscribe = adapter.subscribe((event) => {
      if (event.type === "session.status.changed") {
        const session = this.#sessions.get(event.sessionId);
        if (session) session.status = event.status;
      } else if (event.type === "task.started") {
        const session = this.#sessions.get(event.sessionId);
        if (session) session.activeTurnId = event.turnId;
      } else if (event.type === "approval.pending") {
        const session = this.#sessions.get(event.approval.sessionId);
        if (session) session.activeTurnId = event.approval.turnId;
      } else if (event.type === "task.completed") {
        const session = this.#sessions.get(event.sessionId);
        if (session?.activeTurnId === event.turnId) session.activeTurnId = null;
        if (this.#pocketTurns.get(event.sessionId) === event.turnId) this.#pocketTurns.delete(event.sessionId);
      }
    });
  }

  get selected(): ManagedSession | null {
    return this.#selectedId ? this.#sessions.get(this.#selectedId) ?? null : null;
  }

  get known(): ManagedSession[] {
    return [...this.#sessions.values()];
  }

  resolve(reference: string): ManagedSession[] {
    const exactId = this.#sessions.get(reference);
    if (exactId) return [exactId];
    const sessions = this.known;
    const caseSensitive = sessions.filter((session) => session.title === reference);
    if (caseSensitive.length) return caseSensitive;
    const folded = reference.toLowerCase();
    const caseInsensitive = sessions.filter((session) => session.title.toLowerCase() === folded);
    if (caseInsensitive.length) return caseInsensitive;
    return sessions.filter((session) => session.title.toLowerCase().startsWith(folded));
  }

  async discover(query: SessionQuery = {}): Promise<ManagedSession[]> {
    const discovered = await this.#adapter.listSessions(query);
    for (const session of discovered) {
      const existing = this.#sessions.get(session.id);
      this.#sessions.set(session.id, {
        ...session,
        topology: session.topology === "sharedLive" ? "sharedLive" :
          existing?.topology === "foreignActive" ? "foreignActive" : "historical",
        activeTurnId: existing?.activeTurnId ?? null,
      });
    }
    return discovered.map((session) => this.#sessions.get(session.id)!);
  }

  async use(sessionId: string): Promise<ManagedSession> {
    const managed = await this.attachCandidate(sessionId);
    await this.commitSelection(managed);
    return managed;
  }

  async attachCandidate(sessionId: string): Promise<ManagedSession> {
    const discovered = this.#sessions.get(sessionId);
    let attached: CodexSession;
    try {
      attached = await this.#adapter.attach(
        sessionId,
        discovered?.topology === "sharedLive" ? "joinLive" : "resumeHistorical",
      );
    } catch (error) {
      if (error instanceof ForeignActiveSessionError && discovered) discovered.topology = "foreignActive";
      throw error;
    }
    const activeTurn = [...attached.turns].reverse().find((turn) => turn.status === "inProgress");
    return { ...attached, activeTurnId: activeTurn?.id ?? null };
  }

  async commitSelection(managed: ManagedSession): Promise<void> {
    const previousId = this.#selectedId;
    this.#sessions.set(managed.id, managed);
    this.#selectedId = managed.id;
    this.#adapter.observeSession(managed.id);
    try {
      await this.#onSelection?.(managed);
    } catch (error) {
      this.#selectedId = previousId;
      this.#adapter.observeSession(previousId);
      throw error;
    }
  }

  async preview(sessionId: string, turnLimit = 6): Promise<ConversationPreview> {
    if (!this.#sessions.has(sessionId)) throw new Error(`Session is not discovered: ${sessionId}`);
    return this.#adapter.readConversationPreview(sessionId, turnLimit);
  }

  setActiveTurn(sessionId: string, turnId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Session is not attached: ${sessionId}`);
    session.activeTurnId = turnId;
    this.#pocketTurns.set(sessionId, turnId);
  }

  controlState(sessionId: string): "observerIdle" | "turnObserved" | "telegramTurnActive" {
    const session = this.#sessions.get(sessionId);
    if (!session?.activeTurnId) return "observerIdle";
    return this.#pocketTurns.get(sessionId) === session.activeTurnId ? "telegramTurnActive" : "turnObserved";
  }

  close(): void {
    this.#adapter.observeSession(null);
    this.#unsubscribe();
    this.#pocketTurns.clear();
  }
}
