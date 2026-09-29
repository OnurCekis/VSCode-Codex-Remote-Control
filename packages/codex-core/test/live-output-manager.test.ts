import { describe, expect, it } from "vitest";
import type { RpcId } from "../../../apps/ipc-probe/src/rpc-types.js";
import type { CodexAdapter, SessionAttachMode, SessionQuery } from "../src/codex-adapter.js";
import type { ActiveTurnSnapshot, CodexEvent, CodexEventListener, CodexSession, ConversationPreview } from "../src/domain-events.js";
import { LiveOutputManager, type LiveOutputEvent } from "../src/live-output-manager.js";

class FakeAdapter implements CodexAdapter {
  readonly listeners = new Set<CodexEventListener>();
  observeSnapshot: ActiveTurnSnapshot | null = null;
  finalSnapshot: ActiveTurnSnapshot | null = null;
  onObserve: (() => void) | null = null;
  async listSessions(_query?: SessionQuery): Promise<CodexSession[]> { return []; }
  async attach(_sessionId: string, _mode: SessionAttachMode): Promise<CodexSession> { throw new Error("unused"); }
  observeSession(_sessionId: string | null): void {}
  async observeActiveTurn(_sessionId: string, _turnId: string): Promise<ActiveTurnSnapshot | null> {
    this.onObserve?.();
    return this.observeSnapshot;
  }
  async readTurnSnapshot(_sessionId: string, _turnId: string): Promise<ActiveTurnSnapshot | null> { return this.finalSnapshot; }
  async readConversationPreview(_sessionId: string, _turnLimit: number): Promise<ConversationPreview> { throw new Error("unused"); }
  async startTask(_sessionId: string, _prompt: string): Promise<string> { throw new Error("unused"); }
  async interruptTask(_sessionId: string, _turnId: string): Promise<void> {}
  resolveApproval(_requestId: RpcId, _decision: "accept" | "decline"): void {}
  subscribe(listener: CodexEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> {}
  emit(event: CodexEvent): void { for (const listener of [...this.listeners]) listener(event); }
}

describe("LiveOutputManager", () => {
  it("preserves raw assistant deltas in exact order and exposes a current snapshot", () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const events: LiveOutputEvent[] = [];
    output.subscribe((event) => events.push(event));
    adapter.emit({ type: "task.started", sessionId: "thread-a", turnId: "turn-a" });
    adapter.emit({ type: "message.delta", sessionId: "thread-a", turnId: "turn-a", itemId: "item-a", text: "**begin**\n" });
    adapter.emit({ type: "message.delta", sessionId: "thread-a", turnId: "turn-a", itemId: "item-a", text: "| middle |\n" });
    adapter.emit({ type: "message.delta", sessionId: "thread-a", turnId: "turn-a", itemId: "item-a", text: "end" });

    const deltas = events.filter((event): event is Extract<LiveOutputEvent, { type: "assistant.delta" }> =>
      event.type === "assistant.delta");
    expect(deltas.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(deltas.map((event) => event.text).join("")).toBe("**begin**\n| middle |\nend");
    expect(output.snapshot({ runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" }))
      .toBe("**begin**\n| middle |\nend");
    expect(deltas[0]).not.toHaveProperty("messageId");
    expect(deltas[0]).not.toHaveProperty("telegram");
    output.close();
  });

  it("preserves App Server agent-message item boundaries as paragraphs", () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const deltas: string[] = [];
    output.subscribe((event) => { if (event.type === "assistant.delta") deltas.push(event.text); });
    adapter.emit({ type: "item.started", sessionId: "thread-a", turnId: "turn-a", itemId: "first", itemType: "agentMessage" });
    adapter.emit({ type: "message.delta", sessionId: "thread-a", turnId: "turn-a", itemId: "first", text: "First paragraph." });
    adapter.emit({ type: "item.completed", sessionId: "thread-a", turnId: "turn-a", itemId: "first", itemType: "agentMessage" });
    adapter.emit({ type: "item.started", sessionId: "thread-a", turnId: "turn-a", itemId: "second", itemType: "agentMessage" });
    adapter.emit({ type: "message.delta", sessionId: "thread-a", turnId: "turn-a", itemId: "second", text: "Second paragraph." });
    expect(deltas.join("")).toBe("First paragraph.\n\nSecond paragraph.");
    expect(output.snapshot({ runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" }))
      .toBe("First paragraph.\n\nSecond paragraph.");
    output.close();
  });

  it("preserves multiple agent-message items in an authoritative late snapshot", async () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const identity = { runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" };
    adapter.observeSnapshot = { sessionId: identity.threadId, turnId: identity.turnId, status: "inProgress", checkpoint: 4,
      items: [{ itemId: "first", text: "First paragraph." }, { itemId: "second", text: "Second paragraph." }] };
    await output.observeActiveTurn(identity);
    expect(output.snapshot(identity)).toBe("First paragraph.\n\nSecond paragraph.");
    output.close();
  });

  it("replays canonical active output to a late turn subscriber and releases it after completion", () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const identity = { runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" };
    adapter.emit({ type: "message.delta", sessionId: identity.threadId, turnId: identity.turnId, itemId: "item-a", text: "before attach" });
    const replay: LiveOutputEvent[] = [];
    const unsubscribe = output.subscribeToTurn(identity, (event) => replay.push(event));
    expect(replay).toEqual([{ ...identity, type: "assistant.snapshot", sequence: 1, text: "before attach" }]);
    adapter.emit({ type: "message.delta", sessionId: identity.threadId, turnId: identity.turnId, itemId: "item-a", text: " after" });
    adapter.emit({ type: "task.completed", sessionId: identity.threadId, turnId: identity.turnId, status: "completed", error: null });
    expect(replay.at(-1)).toMatchObject({ type: "turn.finished", outcome: "completed", text: "before attach after" });
    expect(output.snapshot(identity)).toBeNull();
    unsubscribe();
    output.close();
  });

  it("keeps runtime, thread, and turn identities separate and normalizes terminal outcomes", () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-shared");
    const events: LiveOutputEvent[] = [];
    output.subscribe((event) => events.push(event));
    adapter.emit({ type: "message.delta", sessionId: "workspace-a", turnId: "turn-1", itemId: "a", text: "A" });
    adapter.emit({ type: "message.delta", sessionId: "workspace-b", turnId: "turn-1", itemId: "b", text: "B" });
    adapter.emit({ type: "task.completed", sessionId: "workspace-a", turnId: "turn-1", status: "interrupted", error: null });
    adapter.emit({ type: "task.completed", sessionId: "workspace-b", turnId: "turn-1", status: "failed", error: { message: "fixture" } });
    const finished = events.filter((event): event is Extract<LiveOutputEvent, { type: "turn.finished" }> =>
      event.type === "turn.finished");
    expect(finished.map((event) => [event.runtimeId, event.threadId, event.turnId, event.outcome, event.text])).toEqual([
      ["runtime-shared", "workspace-a", "turn-1", "interrupted", "A"],
      ["runtime-shared", "workspace-b", "turn-1", "failed", "B"],
    ]);
    output.close();
  });

  it("bootstraps an already-active exact turn and reconciles post-checkpoint deltas before completion", async () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const identity = { runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" };
    const events: LiveOutputEvent[] = [];
    output.subscribe((event) => events.push(event));
    adapter.observeSnapshot = {
      sessionId: identity.threadId, turnId: identity.turnId, status: "inProgress", checkpoint: 10,
      items: [{ itemId: "answer", text: "BEFORE_JOIN_MARKER" }],
    };
    adapter.onObserve = () => {
      adapter.emit({
        type: "message.delta", sessionId: identity.threadId, turnId: identity.turnId,
        itemId: "answer", text: "AFTER_JOIN_MARKER", protocolSequence: 11,
      });
    };
    await output.observeActiveTurn(identity);
    expect(output.snapshot(identity)).toBe("BEFORE_JOIN_MARKERAFTER_JOIN_MARKER");
    expect(events.filter((event) => event.type === "assistant.snapshot")).toEqual([
      expect.objectContaining({ text: "BEFORE_JOIN_MARKERAFTER_JOIN_MARKER" }),
    ]);
    expect(events.some((event) => event.type === "assistant.delta")).toBe(false);
    adapter.emit({ type: "task.completed", sessionId: identity.threadId, turnId: identity.turnId, status: "completed", error: null });
    expect(events.at(-1)).toMatchObject({ type: "turn.finished", text: "BEFORE_JOIN_MARKERAFTER_JOIN_MARKER" });
    output.close();
  });

  it("does not duplicate a buffered delta already covered by the authoritative checkpoint", async () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const identity = { runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" };
    adapter.observeSnapshot = {
      sessionId: identity.threadId, turnId: identity.turnId, status: "inProgress", checkpoint: 10,
      items: [{ itemId: "answer", text: "REPEATEDREPEATED" }],
    };
    adapter.onObserve = () => adapter.emit({
      type: "message.delta", sessionId: identity.threadId, turnId: identity.turnId,
      itemId: "answer", text: "REPEATED", protocolSequence: 9,
    });
    await output.observeActiveTurn(identity);
    expect(output.snapshot(identity)).toBe("REPEATEDREPEATED");
    output.close();
  });

  it("obtains a final authoritative snapshot when completion races bootstrap", async () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const identity = { runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" };
    const events: LiveOutputEvent[] = [];
    output.subscribe((event) => events.push(event));
    adapter.observeSnapshot = {
      sessionId: identity.threadId, turnId: identity.turnId, status: "inProgress", checkpoint: 5,
      items: [{ itemId: "answer", text: "BEFORE_JOIN_MARKER" }],
    };
    adapter.finalSnapshot = {
      sessionId: identity.threadId, turnId: identity.turnId, status: "completed", checkpoint: 8,
      items: [{ itemId: "answer", text: "BEFORE_JOIN_MARKERAFTER_JOIN_MARKER" }],
    };
    adapter.onObserve = () => adapter.emit({ type: "task.completed", sessionId: identity.threadId, turnId: identity.turnId, status: "completed", error: null });
    await output.observeActiveTurn(identity);
    expect(events.map((event) => event.type)).toEqual(["turn.started", "assistant.snapshot", "turn.finished"]);
    expect(events[1]).toMatchObject({ text: "BEFORE_JOIN_MARKERAFTER_JOIN_MARKER" });
    expect(events[2]).toMatchObject({ text: "BEFORE_JOIN_MARKERAFTER_JOIN_MARKER", outcome: "completed" });
    output.close();
  });

  it("finishes an exact turn that completed immediately before bootstrap without merging a later turn", async () => {
    const adapter = new FakeAdapter();
    const output = new LiveOutputManager(adapter, "runtime-a");
    const first = { runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" };
    const events: LiveOutputEvent[] = [];
    output.subscribe((event) => events.push(event));
    adapter.observeSnapshot = {
      sessionId: first.threadId, turnId: first.turnId, status: "completed", checkpoint: 12,
      items: [{ itemId: "first", text: "FIRST_FINAL" }],
    };
    await output.observeActiveTurn(first);
    adapter.emit({ type: "task.started", sessionId: first.threadId, turnId: "turn-b" });
    adapter.emit({ type: "message.delta", sessionId: first.threadId, turnId: "turn-b", itemId: "second", text: "SECOND" });
    const finished = events.find((event) => event.type === "turn.finished");
    expect(finished).toMatchObject({ turnId: "turn-a", text: "FIRST_FINAL" });
    expect(output.snapshot({ ...first, turnId: "turn-b" })).toBe("SECOND");
    output.close();
  });
});
