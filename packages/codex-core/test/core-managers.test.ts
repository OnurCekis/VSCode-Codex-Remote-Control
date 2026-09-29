import { describe, expect, it } from "vitest";
import type { RpcId } from "../../../apps/ipc-probe/src/rpc-types.js";
import { ApprovalManager } from "../src/approval-manager.js";
import type { CodexAdapter, SessionAttachMode, SessionQuery } from "../src/codex-adapter.js";
import type { ActiveTurnSnapshot, CodexEvent, CodexEventListener, CodexSession, ConversationPreview } from "../src/domain-events.js";
import { PocketCore } from "../src/pocket-core.js";
import { SessionManager } from "../src/session-manager.js";
import { TaskManager } from "../src/task-manager.js";

const session: CodexSession = {
  id: "thread-1", cwd: "C:\\fixture", title: "Fixture", preview: "Fixture",
  updatedAt: 1, loaded: true, status: { type: "active", activeFlags: [] },
  topology: "sharedLive", canAcceptDirectInput: true,
  turns: [{ id: "old", status: "completed" }, { id: "running", status: "inProgress" }],
};

class FakeAdapter implements CodexAdapter {
  listeners = new Set<CodexEventListener>();
  decisions: Array<{ id: RpcId; decision: "accept" | "decline" }> = [];
  interrupted: Array<{ sessionId: string; turnId: string }> = [];
  started: string[] = [];
  attachModes: SessionAttachMode[] = [];
  observedActiveTurns: Array<{ sessionId: string; turnId: string }> = [];
  async listSessions(_query?: SessionQuery): Promise<CodexSession[]> { return [{ ...session, turns: [] }]; }
  observeSession(_sessionId: string | null): void {}
  async observeActiveTurn(sessionId: string, turnId: string): Promise<ActiveTurnSnapshot> {
    this.observedActiveTurns.push({ sessionId, turnId });
    return { sessionId, turnId, status: "inProgress", checkpoint: 1, items: [{ itemId: "answer", text: "CURRENT_OUTPUT" }] };
  }
  async attach(id: string, mode: SessionAttachMode): Promise<CodexSession> {
    this.attachModes.push(mode);
    if (id !== session.id) throw new Error("unknown");
    return structuredClone(session);
  }
  async readConversationPreview(sessionId: string): Promise<ConversationPreview> {
    return { sessionId, messages: [{ role: "user", text: "Hello" }], recentTurnCount: 1, hasOlder: false };
  }
  async startTask(_sessionId: string, prompt: string): Promise<string> { this.started.push(prompt); return "new-turn"; }
  async interruptTask(sessionId: string, turnId: string): Promise<void> { this.interrupted.push({ sessionId, turnId }); }
  resolveApproval(id: RpcId, decision: "accept" | "decline"): void { this.decisions.push({ id, decision }); }
  subscribe(listener: CodexEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> {}
  emit(event: CodexEvent): void { for (const listener of [...this.listeners]) listener(event); }
}

describe("Phase 1 core managers", () => {
  it("bootstraps the existing active turn as part of selecting a live session", async () => {
    const adapter = new FakeAdapter();
    const core = new PocketCore(adapter, { runtimeId: "runtime-a" });
    await core.sessions.discover();
    await core.sessions.use(session.id);
    expect(adapter.observedActiveTurns).toEqual([{ sessionId: session.id, turnId: "running" }]);
    expect(core.liveOutput.snapshot({ runtimeId: "runtime-a", threadId: session.id, turnId: "running" })).toBe("CURRENT_OUTPUT");
    await core.close();
  });

  it("discovers, attaches with history, starts after idle, and interrupts", async () => {
    const adapter = new FakeAdapter();
    const sessions = new SessionManager(adapter);
    expect((await sessions.discover())[0]?.id).toBe("thread-1");
    expect((await sessions.use("thread-1")).activeTurnId).toBe("running");
    expect(sessions.controlState("thread-1")).toBe("turnObserved");
    expect(adapter.attachModes).toEqual(["joinLive"]);
    const tasks = new TaskManager(adapter, sessions);
    await expect(tasks.send("blocked")).rejects.toThrow("active turn");
    adapter.emit({ type: "task.completed", sessionId: "thread-1", turnId: "running", status: "completed", error: null });
    adapter.emit({ type: "session.status.changed", sessionId: "thread-1", status: { type: "idle" } });
    expect(await tasks.send("hello")).toBe("new-turn");
    expect(sessions.controlState("thread-1")).toBe("telegramTurnActive");
    expect(await tasks.stop()).toBe("new-turn");
    expect(adapter.interrupted).toEqual([{ sessionId: "thread-1", turnId: "new-turn" }]);
  });

  it("assigns opaque approval IDs and rejects stale duplicate decisions", () => {
    const adapter = new FakeAdapter();
    const approvals = new ApprovalManager(adapter);
    const event: CodexEvent = {
      type: "approval.pending",
      approval: { requestId: 7, kind: "command", sessionId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    };
    adapter.emit(event);
    adapter.emit(event);
    expect(approvals.pending()).toHaveLength(1);
    approvals.approve("approval-1");
    expect(adapter.decisions).toEqual([{ id: 7, decision: "accept" }]);
    expect(() => approvals.deny("approval-1")).toThrow("stale");
  });

  it("resolves pending approvals on protocol resolution, turn completion, and disconnect", () => {
    const adapter = new FakeAdapter();
    const approvals = new ApprovalManager(adapter);
    adapter.emit({ type: "approval.pending", approval: { requestId: "a", kind: "file", sessionId: "thread-1", turnId: "turn-1", itemId: "item-1" } });
    adapter.emit({ type: "approval.resolved", sessionId: "thread-1", requestId: "a" });
    expect(approvals.pending()).toHaveLength(0);
    adapter.emit({ type: "approval.pending", approval: { requestId: "b", kind: "command", sessionId: "thread-1", turnId: "turn-2", itemId: "item-2" } });
    adapter.emit({ type: "task.completed", sessionId: "thread-1", turnId: "turn-2", status: "completed", error: null });
    expect(approvals.pending()).toHaveLength(0);
    adapter.emit({ type: "approval.pending", approval: { requestId: "c", kind: "command", sessionId: "thread-1", turnId: "turn-3", itemId: "item-3" } });
    adapter.emit({ type: "connection.closed" });
    expect(approvals.pending()).toHaveLength(0);
  });
});
