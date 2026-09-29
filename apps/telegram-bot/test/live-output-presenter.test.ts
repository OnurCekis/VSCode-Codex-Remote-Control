import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcId } from "../../ipc-probe/src/rpc-types.js";
import type { CodexAdapter, SessionAttachMode, SessionQuery } from "../../../packages/codex-core/src/codex-adapter.js";
import type { CodexEvent, CodexEventListener, CodexSession, ConversationPreview } from "../../../packages/codex-core/src/domain-events.js";
import { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";
import { TelegramLiveOutputPresenter, TELEGRAM_STREAM_MESSAGE_LIMIT } from "../src/live-output-presenter.js";
import type { InlineButton, TelegramPort } from "../src/telegram-port.js";

const sessionA: CodexSession = {
  id: "thread-a", cwd: "C:\\workspace-a", title: "A", preview: "A", updatedAt: 1, loaded: true,
  topology: "sharedLive", canAcceptDirectInput: true, status: { type: "idle" }, turns: [],
};
const sessionB: CodexSession = { ...sessionA, id: "thread-b", cwd: "C:\\workspace-b", title: "B" };

class FakeAdapter implements CodexAdapter {
  readonly listeners = new Set<CodexEventListener>();
  readonly sessions = new Map([[sessionA.id, sessionA], [sessionB.id, sessionB]]);
  async listSessions(_query?: SessionQuery): Promise<CodexSession[]> { return [...this.sessions.values()]; }
  async attach(sessionId: string, _mode: SessionAttachMode): Promise<CodexSession> { return structuredClone(this.sessions.get(sessionId)!); }
  observeSession(_sessionId: string | null): void {}
  async readConversationPreview(_sessionId: string, _turnLimit: number): Promise<ConversationPreview> { throw new Error("unused"); }
  async startTask(_sessionId: string, _prompt: string): Promise<string> { return "turn"; }
  async interruptTask(_sessionId: string, _turnId: string): Promise<void> {}
  resolveApproval(_requestId: RpcId, _decision: "accept" | "decline"): void {}
  subscribe(listener: CodexEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> {}
  emit(event: CodexEvent): void { for (const listener of [...this.listeners]) listener(event); }
}

class FakePort implements TelegramPort {
  readonly messages: Array<{ messageId: number; text: string }> = [];
  readonly edits: Array<{ messageId: number; text: string }> = [];
  failNext = false;
  async sendMessage(_chatId: number, text: string, _buttons?: InlineButton[][]): Promise<{ messageId: number }> {
    if (this.failNext) { this.failNext = false; throw new Error("Telegram unavailable"); }
    const messageId = this.messages.length + 1;
    this.messages.push({ messageId, text });
    return { messageId };
  }
  async editMessage(_chatId: number, messageId: number, text: string, _buttons?: InlineButton[][]): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error("Telegram unavailable"); }
    this.edits.push({ messageId, text });
  }
  async answerCallback(_callbackId: string, _text: string, _showAlert?: boolean): Promise<void> {}
}

async function setup(updateMs = 0): Promise<{ adapter: FakeAdapter; core: PocketCore; port: FakePort; presenter: TelegramLiveOutputPresenter; errors: Error[] }> {
  const adapter = new FakeAdapter();
  const core = new PocketCore(adapter, { runtimeId: "runtime-test" });
  await core.sessions.discover();
  await core.sessions.use(sessionA.id);
  const port = new FakePort();
  const errors: Error[] = [];
  const presenter = new TelegramLiveOutputPresenter({
    core, port, chatId: 42, userId: 42, updateMs, onError: (error) => errors.push(error),
  });
  return { adapter, core, port, presenter, errors };
}

function emittedText(port: FakePort): string {
  const finalById = new Map(port.messages.map((message) => [message.messageId, message.text]));
  for (const edit of port.edits) finalById.set(edit.messageId, edit.text);
  return [...finalById.values()].map((text) => text.replace(/^🤖 Codex(?: · \d+)?\n\n/u, "").replace(/\n\n(?:✅ Tamamlandı|⏹ Durduruldu|❌ Hata)$/u, "")).join("");
}

afterEach(() => vi.useRealTimers());

describe("TelegramLiveOutputPresenter", () => {
  it.each([
    ["two paragraphs", "First paragraph.\n\nSecond paragraph."],
    ["three paragraphs", "One.\n\nTwo.\n\nThree."],
    ["bullet newlines", "Intro.\n\n- Item one\n- Item two\n\nFinal."],
    ["fenced multiline code", "Example:\n\n```ts\nconst one = 1;\nconst two = 2;\n```\n\nDone."],
  ])("preserves %s exactly", async (_label, original) => {
    const { adapter, port, presenter } = await setup();
    adapter.emit({ type: "task.started", sessionId: sessionA.id, turnId: "paragraphs" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "paragraphs", itemId: "answer", text: original });
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "paragraphs", status: "completed", error: null });
    await presenter.settled();
    expect(emittedText(port)).toBe(original);
  });

  it("preserves a paragraph boundary split across live deltas", async () => {
    const { adapter, port, presenter } = await setup();
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "split-break", itemId: "answer", text: "First paragraph.\n" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "split-break", itemId: "answer", text: "\nSecond paragraph." });
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "split-break", status: "completed", error: null });
    await presenter.settled();
    expect(emittedText(port)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("renders consecutive App Server agent-message items as separate Telegram paragraphs", async () => {
    const { adapter, port, presenter } = await setup();
    adapter.emit({ type: "item.started", sessionId: sessionA.id, turnId: "message-items", itemId: "first", itemType: "agentMessage" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "message-items", itemId: "first", text: "First paragraph." });
    adapter.emit({ type: "item.completed", sessionId: sessionA.id, turnId: "message-items", itemId: "first", itemType: "agentMessage" });
    adapter.emit({ type: "item.started", sessionId: sessionA.id, turnId: "message-items", itemId: "second", itemType: "agentMessage" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "message-items", itemId: "second", text: "Second paragraph." });
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "message-items", status: "completed", error: null });
    await presenter.settled();
    expect(emittedText(port)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("does not collapse leading, trailing, or repeated whitespace during completion flush", async () => {
    const { adapter, port, presenter } = await setup();
    const original = "  indented first\n\nsecond with trailing spaces  \n";
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "flush-space", itemId: "answer", text: original });
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "flush-space", status: "completed", error: null });
    await presenter.settled();
    expect(emittedText(port)).toBe(original);
  });

  it("renders an authoritative late-join snapshot immediately and continues the same active turn", async () => {
    const { adapter, port, presenter } = await setup();
    adapter.emit({ type: "message.snapshot", snapshot: {
      sessionId: sessionA.id, turnId: "late", status: "inProgress", checkpoint: 10,
      items: [{ itemId: "answer", text: "BEFORE_JOIN_MARKER" }],
    } });
    await presenter.settled();
    expect(port.messages.at(-1)?.text).toContain("BEFORE_JOIN_MARKER");
    adapter.emit({
      type: "message.delta", sessionId: sessionA.id, turnId: "late", itemId: "answer",
      text: "AFTER_JOIN_MARKER", protocolSequence: 11,
    });
    await presenter.settled();
    const active = port.edits.at(-1)?.text ?? port.messages.at(-1)?.text;
    expect(active).toContain("BEFORE_JOIN_MARKERAFTER_JOIN_MARKER");
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "late", status: "completed", error: null });
    await presenter.settled();
    expect(port.edits.at(-1)?.text).toMatch(/Tamamland/u);
  });

  it("segments a large late-join snapshot without losing its beginning or middle", async () => {
    const { adapter, port, presenter } = await setup();
    const existing = `BEFORE:${"x".repeat(7_000)}:MIDDLE`;
    adapter.emit({ type: "message.snapshot", snapshot: {
      sessionId: sessionA.id, turnId: "late-large", status: "inProgress", checkpoint: 20,
      items: [{ itemId: "answer", text: existing }],
    } });
    await presenter.settled();
    expect(port.messages.length).toBeGreaterThan(1);
    expect(emittedText(port)).toBe(existing);
  });

  it("preserves paragraphs across Telegram continuation messages", async () => {
    const { adapter, port, presenter } = await setup();
    const original = `${"First paragraph sentence. ".repeat(160)}\n\n${"Second paragraph sentence. ".repeat(160)}\n\nFinal paragraph.`;
    for (let offset = 0; offset < original.length; offset += 101) {
      adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "continued-paragraphs", itemId: "answer", text: original.slice(offset, offset + 101) });
    }
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "continued-paragraphs", status: "completed", error: null });
    await presenter.settled();
    expect(port.messages.length).toBeGreaterThan(1);
    expect(emittedText(port)).toBe(original);
  });

  it("preserves paragraph structure in a late-join snapshot", async () => {
    const { adapter, port, presenter } = await setup();
    const original = "Before join.\n\nSecond paragraph.\n\n- one\n- two";
    adapter.emit({ type: "message.snapshot", snapshot: {
      sessionId: sessionA.id, turnId: "late-paragraphs", status: "inProgress", checkpoint: 7,
      items: [{ itemId: "answer", text: original }],
    } });
    await presenter.settled();
    expect(emittedText(port)).toBe(original);
  });

  it("segments a real-phone-sized response without losing its beginning, middle, or end", async () => {
    const { adapter, port, presenter } = await setup();
    const beginning = "BEGIN: takip edebilmek;\n\n";
    const middle = `MIDDLE:${"m".repeat(4_200)}\n`;
    const ending = "END: complete";
    const original = `${beginning}${middle}${ending}`;
    adapter.emit({ type: "task.started", sessionId: sessionA.id, turnId: "long" });
    for (let offset = 0; offset < original.length; offset += 137) {
      adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "long", itemId: "answer", text: original.slice(offset, offset + 137) });
    }
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "long", status: "completed", error: null });
    await presenter.settled();
    expect(port.messages.length).toBeGreaterThan(1);
    expect(port.messages[0]?.text).toContain(beginning);
    expect(emittedText(port)).toBe(original);
    expect(port.messages.at(-1)?.text).toMatch(/^🤖 Codex · 2/u);
    expect(port.edits.at(-1)?.text).toContain("✅ Tamamlandı");
    expect([...port.messages, ...port.edits].every((message) => message.text.length <= TELEGRAM_STREAM_MESSAGE_LIMIT)).toBe(true);
  });

  it("freezes previous segments and edits only the current segment", async () => {
    const { adapter, port, presenter } = await setup();
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "segments", itemId: "answer", text: "a".repeat(3_500) });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "segments", itemId: "answer", text: "b".repeat(3_500) });
    await presenter.settled();
    expect(port.messages.length).toBe(3);
    const secondCreated = port.messages[1]!.messageId;
    const editsAfterSecond = port.edits.filter((edit) => edit.messageId === port.messages[0]!.messageId);
    expect(editsAfterSecond).toHaveLength(0);
    expect(port.edits.every((edit) => edit.messageId !== secondCreated || edit.text.startsWith("🤖 Codex · 2"))).toBe(true);
  });

  it("coalesces edits and performs an immediate terminal flush", async () => {
    vi.useFakeTimers();
    const { adapter, port, presenter } = await setup(750);
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "throttle", itemId: "answer", text: "one" });
    await presenter.settled();
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "throttle", itemId: "answer", text: " two" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "throttle", itemId: "answer", text: " three" });
    await presenter.settled();
    expect(port.edits).toHaveLength(0);
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "throttle", status: "interrupted", error: null });
    await presenter.settled();
    expect(port.edits).toHaveLength(1);
    expect(port.edits[0]?.text).toContain("one two three\n\n⏹ Durduruldu");
  });

  it("flushes immediately for an approval and continues the same turn stream", async () => {
    vi.useFakeTimers();
    const { adapter, port, presenter } = await setup(750);
    adapter.emit({ type: "task.started", sessionId: sessionA.id, turnId: "approval-turn" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "approval-turn", itemId: "answer", text: "before approval" });
    await presenter.settled();
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "approval-turn", itemId: "answer", text: " pending" });
    adapter.emit({
      type: "approval.pending",
      approval: { requestId: 1, kind: "command", sessionId: sessionA.id, turnId: "approval-turn", itemId: "command" },
    });
    await presenter.settled();
    expect(port.edits.at(-1)?.text).toContain("before approval pending");
    adapter.emit({ type: "approval.resolved", sessionId: sessionA.id, requestId: 1 });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "approval-turn", itemId: "answer", text: " after approval" });
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "approval-turn", status: "completed", error: null });
    await presenter.settled();
    const final = port.edits.at(-1)?.text ?? port.messages.at(-1)?.text;
    expect(final).toContain("before approval pending after approval");
    expect(final).toContain("✅ Tamamlandı");
    expect(port.messages).toHaveLength(1);
  });

  it("keeps two workspace turns separate and does not redirect after selection changes", async () => {
    const { adapter, core, port, presenter } = await setup();
    adapter.emit({ type: "task.started", sessionId: sessionA.id, turnId: "same-id" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "same-id", itemId: "a", text: "A1" });
    await core.sessions.use(sessionB.id);
    adapter.emit({ type: "task.started", sessionId: sessionB.id, turnId: "same-id" });
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "same-id", itemId: "a", text: "A2" });
    adapter.emit({ type: "message.delta", sessionId: sessionB.id, turnId: "same-id", itemId: "b", text: "B1" });
    adapter.emit({ type: "task.completed", sessionId: sessionA.id, turnId: "same-id", status: "completed", error: null });
    adapter.emit({ type: "task.completed", sessionId: sessionB.id, turnId: "same-id", status: "failed", error: null });
    await presenter.settled();
    expect(port.messages).toHaveLength(2);
    const final = port.messages.map((message) => port.edits.filter((edit) => edit.messageId === message.messageId).at(-1)?.text ?? message.text);
    expect(final.some((text) => text.includes("A1A2") && text.includes("✅ Tamamlandı"))).toBe(true);
    expect(final.some((text) => text.includes("B1") && text.includes("❌ Hata"))).toBe(true);
    expect(final.every((text) => !(text.includes("A1") && text.includes("B1")))).toBe(true);
  });

  it("isolates Telegram failures from the core turn and can continue on a later delta", async () => {
    const { adapter, port, presenter, errors, core } = await setup();
    port.failNext = true;
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "failure", itemId: "a", text: "first" });
    await presenter.settled();
    expect(errors).toHaveLength(1);
    expect(core.liveOutput.snapshot({ runtimeId: "runtime-test", threadId: sessionA.id, turnId: "failure" })).toBe("first");
    adapter.emit({ type: "message.delta", sessionId: sessionA.id, turnId: "failure", itemId: "a", text: " second" });
    await presenter.settled();
    expect(port.messages.at(-1)?.text).toContain("first second");
  });
});
