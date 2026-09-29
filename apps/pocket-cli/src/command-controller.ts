import type { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";
import type { ManagedSession } from "../../../packages/codex-core/src/session-manager.js";

export interface CommandResult {
  lines: string[];
  quit?: boolean;
}

function sessionLine(session: ManagedSession, selectedId: string | null): string {
  const selected = session.id === selectedId ? "*" : " ";
  const flags = session.status.type === "active" ? `:${session.status.activeFlags.join(",") || "working"}` : "";
  return `${selected} ${session.id} [${session.status.type}${flags}${session.loaded ? ",loaded" : ""}] ${session.title}`;
}

export class CommandController {
  readonly #core: PocketCore;
  readonly #cwd: string | undefined;
  #lastSessions: ManagedSession[] = [];

  constructor(core: PocketCore, cwd?: string) {
    this.#core = core;
    this.#cwd = cwd;
  }

  async execute(raw: string): Promise<CommandResult> {
    const line = raw.trim();
    if (!line) return { lines: [] };
    const separator = line.indexOf(" ");
    const command = separator < 0 ? line : line.slice(0, separator);
    const argument = separator < 0 ? "" : line.slice(separator + 1).trim();

    if (command === "sessions") {
      this.#lastSessions = await this.#core.sessions.discover(this.#cwd ? { cwd: this.#cwd } : {});
      const selected = this.#core.sessions.selected?.id ?? null;
      return { lines: this.#lastSessions.length ? this.#lastSessions.map((session) => sessionLine(session, selected)) : ["No VS Code sessions found."] };
    }
    if (command === "status") {
      const session = this.#core.sessions.selected;
      if (!session) return { lines: ["No session selected."] };
      return { lines: [
        `session=${session.id}`,
        `status=${session.status.type}`,
        `activeTurn=${session.activeTurnId ?? "none"}`,
        `pendingApprovals=${this.#core.approvals.pending(session.id).length}`,
        `historyTurns=${session.turns.length}`,
      ] };
    }
    if (command === "use") {
      if (!argument) throw new Error("Usage: use <session>");
      if (!this.#lastSessions.length) this.#lastSessions = await this.#core.sessions.discover(this.#cwd ? { cwd: this.#cwd } : {});
      const exact = this.#lastSessions.find((session) => session.id === argument);
      const prefix = this.#lastSessions.filter((session) => session.id.startsWith(argument));
      const selected = exact ?? (prefix.length === 1 ? prefix[0] : undefined);
      if (!selected) throw new Error(prefix.length > 1 ? `Ambiguous session prefix: ${argument}` : `Unknown VS Code session: ${argument}`);
      const attached = await this.#core.sessions.use(selected.id);
      return { lines: [`Attached ${attached.id}; historyTurns=${attached.turns.length}.`] };
    }
    if (command === "send") {
      if (!argument) throw new Error("Usage: send <prompt>");
      const turnId = await this.#core.tasks.send(argument);
      return { lines: [`Started turn ${turnId}.`] };
    }
    if (command === "approve" || command === "deny") {
      if (!argument) throw new Error(`Usage: ${command} <approval-id>`);
      if (command === "approve") this.#core.approvals.approve(argument);
      else this.#core.approvals.deny(argument);
      return { lines: [`${command === "approve" ? "Approved" : "Denied"} ${argument}.`] };
    }
    if (command === "stop") {
      const turnId = await this.#core.tasks.stop();
      return { lines: [`Interrupt requested for ${turnId}.`] };
    }
    if (command === "help") {
      return { lines: ["Commands: sessions, status, use <session>, send <prompt>, approve <approval-id>, deny <approval-id>, stop, quit"] };
    }
    if (command === "quit" || command === "exit") return { lines: [], quit: true };
    throw new Error(`Unknown command: ${command}`);
  }
}
