import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RpcId } from "../../ipc-probe/src/rpc-types.js";
import {
  ForeignActiveSessionError,
  type CodexAdapter,
  type SessionAttachMode,
  type SessionQuery,
} from "../../../packages/codex-core/src/codex-adapter.js";
import type { CodexEvent, CodexEventListener, CodexSession, ConversationPreview } from "../../../packages/codex-core/src/domain-events.js";
import { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";
import type { PocketUpdateStatus, WorkspaceRuntime, WorkspaceRuntimeAdapter } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import type { Workspace } from "../../../packages/codex-core/src/workspace-manager.js";
import { ConversationCallbackRegistry } from "../src/conversation-browser.js";
import { TelegramController } from "../src/telegram-controller.js";
import { WorkspaceCallbackRegistry } from "../src/workspace-browser.js";
import type { InlineButton, TelegramPort } from "../src/telegram-port.js";

const allowed = 424242;
const fixtureSession: CodexSession = {
  id: "01telegram-session", cwd: path.join(path.parse(process.cwd()).root, "fixture", "project"), title: "Real VS Code session", preview: "Real",
  updatedAt: 1, loaded: true, status: { type: "idle" }, turns: [{ id: "history", status: "completed" }],
  topology: "sharedLive", canAcceptDirectInput: true,
};

class FakeAdapter implements CodexAdapter {
  readonly listeners = new Set<CodexEventListener>();
  readonly decisions: Array<{ id: RpcId; decision: "accept" | "decline" }> = [];
  readonly starts: string[] = [];
  readonly startSessions: string[] = [];
  readonly attachCalls: string[] = [];
  readonly attachModes: SessionAttachMode[] = [];
  readonly interrupts: string[] = [];
  readonly listResponses: CodexSession[][] = [];
  readonly sessionsById = new Map<string, CodexSession>([[fixtureSession.id, fixtureSession]]);
  readonly attachErrors = new Map<string, Error>();
  readonly previewCalls: string[] = [];
  previewMessages: ConversationPreview["messages"] | null = null;
  previewSecret = "";
  listCalls = 0;
  async listSessions(_query?: SessionQuery): Promise<CodexSession[]> {
    this.listCalls += 1;
    const sessions = this.listResponses.shift() ?? [{ ...fixtureSession, turns: [] }];
    for (const session of sessions) this.sessionsById.set(session.id, session);
    return structuredClone(sessions);
  }
  observeSession(_sessionId: string | null): void {}
  async attach(id: string, mode: SessionAttachMode): Promise<CodexSession> {
    this.attachCalls.push(id);
    this.attachModes.push(mode);
    const failure = this.attachErrors.get(id);
    if (failure) throw failure;
    const session = this.sessionsById.get(id);
    if (!session) throw new Error("unknown");
    return structuredClone({
      ...session, loaded: true, status: { type: "idle" }, turns: fixtureSession.turns,
      topology: mode === "joinLive" ? "sharedLive" : "historical",
      canAcceptDirectInput: true,
    });
  }
  async readConversationPreview(sessionId: string): Promise<ConversationPreview> {
    this.previewCalls.push(sessionId);
    return {
      sessionId,
      messages: [
        ...(this.previewMessages ?? [
          { role: "user" as const, text: `Please inspect the fixture ${this.previewSecret}`.trim() },
          { role: "assistant" as const, text: "The fixture is ready." },
        ]),
      ],
      recentTurnCount: 2,
      hasOlder: false,
    };
  }
  async startTask(sessionId: string, prompt: string): Promise<string> {
    this.startSessions.push(sessionId);
    this.starts.push(prompt);
    return `turn-${this.starts.length}`;
  }
  async interruptTask(_sessionId: string, turnId: string): Promise<void> { this.interrupts.push(turnId); }
  resolveApproval(id: RpcId, decision: "accept" | "decline"): void { this.decisions.push({ id, decision }); }
  subscribe(listener: CodexEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> {}
  emit(event: CodexEvent): void { for (const listener of [...this.listeners]) listener(event); }
}

class FakeTelegramPort implements TelegramPort {
  readonly messages: Array<{ chatId: number; text: string; buttons?: InlineButton[][]; messageId: number }> = [];
  readonly edits: Array<{ chatId: number; messageId: number; text: string; buttons?: InlineButton[][] }> = [];
  readonly callbacks: Array<{ id: string; text: string; alert: boolean }> = [];
  async sendMessage(chatId: number, text: string, buttons?: InlineButton[][]): Promise<{ messageId: number }> {
    const messageId = this.messages.length + 1;
    this.messages.push({ chatId, text, ...(buttons ? { buttons } : {}), messageId });
    return { messageId };
  }
  async editMessage(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    this.edits.push({ chatId, messageId, text, ...(buttons ? { buttons } : {}) });
  }
  async answerCallback(id: string, text: string, alert = false): Promise<void> { this.callbacks.push({ id, text, alert }); }
}

class FakeWorkspaceRuntimeAdapter implements WorkspaceRuntimeAdapter {
  runtimes: WorkspaceRuntime[] = [];
  opens: string[] = [];
  updateChecks = 0;
  updateApplies = 0;
  updateStatus: PocketUpdateStatus = { state: "upToDate", currentVersion: "26.903.61454", availableVersion: "26.903.61454",
    checkedAt: "2026-09-09T12:00:00.000Z", source: "visualStudioMarketplace", restartRequired: false };
  async listRuntimes(): Promise<WorkspaceRuntime[]> { return structuredClone(this.runtimes); }
  async openWorkspace(workspace: Workspace): Promise<WorkspaceRuntime> {
    this.opens.push(workspace.path);
    const runtime: WorkspaceRuntime = {
      id: `runtime-${this.opens.length}`, workspace, state: "connected", appServerPid: 10, bridgePid: 20 + this.opens.length,
    };
    this.runtimes.push(runtime);
    return structuredClone(runtime);
  }
  async checkForUpdates(): Promise<PocketUpdateStatus> {
    this.updateChecks += 1;
    return structuredClone(this.updateStatus);
  }
  async applyUpdate(): Promise<PocketUpdateStatus> { this.updateApplies += 1; return structuredClone(this.updateStatus); }
}

function setup(secrets: readonly string[] = [], conversationCallbacks?: ConversationCallbackRegistry): { adapter: FakeAdapter; core: PocketCore; port: FakeTelegramPort; controller: TelegramController } {
  const adapter = new FakeAdapter();
  const core = new PocketCore(adapter);
  const port = new FakeTelegramPort();
  const controller = new TelegramController({
    core, port, allowedUserId: allowed, secrets, streamUpdateMs: 0,
    ...(conversationCallbacks ? { conversationCallbacks } : {}),
  });
  return { adapter, core, port, controller };
}

const tick = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 0));

describe("TelegramController", () => {
  it("runs a fresh official update check with /updates", async () => {
    const adapter = new FakeAdapter();
    const runtimeAdapter = new FakeWorkspaceRuntimeAdapter();
    const core = new PocketCore(adapter, { runtimeAdapter });
    const port = new FakeTelegramPort();
    const controller = new TelegramController({ core, port, allowedUserId: allowed });
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/updates" });
    expect(runtimeAdapter.updateChecks).toBe(1);
    expect(port.messages.at(-1)?.text).toContain("Pocket güncel");
    expect(port.messages.at(-1)?.text).toContain("26.903.61454");
    controller.close();
    await core.close();
  });

  it("starts safe staging with /update and renders waiting-for-idle without private paths", async () => {
    const adapter = new FakeAdapter();
    const runtimeAdapter = new FakeWorkspaceRuntimeAdapter();
    runtimeAdapter.updateStatus = { state: "waitingForIdle", currentVersion: "26.903.61454", availableVersion: "26.904.1",
      checkedAt: "2026-09-10T12:00:00.000Z", source: "visualStudioMarketplace", restartRequired: true,
      candidateCliVersion: "0.154.0", detail: "A Codex turn is active." };
    const core = new PocketCore(adapter, { runtimeAdapter });
    const port = new FakeTelegramPort();
    const controller = new TelegramController({ core, port, allowedUserId: allowed });
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/update" });
    expect(runtimeAdapter.updateApplies).toBe(1);
    expect(runtimeAdapter.updateChecks).toBe(0);
    expect(port.messages.at(-1)?.text).toContain("boşta kalması bekleniyor");
    expect(port.messages.at(-1)?.text).toContain("0.154.0");
    expect(port.messages.at(-1)?.text).not.toContain(os.homedir());
    controller.close();
    await core.close();
  });

  it("shows the last task and all of its output paragraphs with /history", async () => {
    const { adapter, port, controller } = setup();
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/sessions" });
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: `/use ${fixtureSession.id}` });
    adapter.previewMessages = [
      { role: "user", text: "Önceki task" },
      { role: "assistant", text: "Önceki output" },
      { role: "user", text: "Son task\nikinci satır" },
      { role: "assistant", text: "Birinci paragraf.\n\nİkinci paragraf." },
      { role: "assistant", text: "- Madde bir\n- Madde iki" },
    ];
    const before = port.messages.length;
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/history" });
    const history = port.messages.slice(before).map((message) => message.text).join("");
    expect(adapter.previewCalls.at(-1)).toBe(fixtureSession.id);
    expect(history).toBe([
      "Son task", "", "Son task\nikinci satır", "", "Son output", "",
      "Birinci paragraf.\n\nİkinci paragraf.\n\n- Madde bir\n- Madde iki",
    ].join("\n"));
  });

  it("requires an active conversation for /history", async () => {
    const { adapter, port, controller } = setup();
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/history" });
    expect(adapter.previewCalls).toHaveLength(0);
    expect(port.messages.at(-1)?.text).toContain("No active conversation");
  });

  it("continues a long /history response without silent truncation", async () => {
    const { adapter, port, controller } = setup();
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/sessions" });
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: `/use ${fixtureSession.id}` });
    const output = `Başlangıç.\n\n${"uzun çıktı ".repeat(900)}\n\nBitiş.`;
    adapter.previewMessages = [{ role: "user", text: "Uzun task" }, { role: "assistant", text: output }];
    const before = port.messages.length;
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/history" });
    const segments = port.messages.slice(before);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((message) => message.text.length <= 4_000)).toBe(true);
    expect(segments.map((message) => message.text).join("")).toBe(`Son task\n\nUzun task\n\nSon output\n\n${output}`);
  });

  it("shows runtime state and explicitly opens a disconnected workspace without replacing another runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-pocket-telegram-runtime-"));
    try {
      const firstCandidate = path.join(root, "First");
      const secondCandidate = path.join(root, "Second");
      await Promise.all([mkdir(firstCandidate), mkdir(secondCandidate)]);
      const first = await realpath(firstCandidate);
      const second = await realpath(secondCandidate);
      const adapter = new FakeAdapter();
      const runtimeAdapter = new FakeWorkspaceRuntimeAdapter();
      const core = new PocketCore(adapter, { runtimeAdapter });
      const firstWorkspace = await core.workspaces.select(first);
      runtimeAdapter.runtimes.push({
        id: "runtime-first", workspace: firstWorkspace, state: "connected", appServerPid: 10, bridgePid: 20,
      });
      const port = new FakeTelegramPort();
      let sequence = 0;
      const callbacks = new WorkspaceCallbackRegistry({ handle: () => `runtime_${++sequence}` });
      const controller = new TelegramController({ core, port, allowedUserId: allowed, workspaceCallbacks: callbacks });
      await core.workspaces.select(second);
      await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/workspaces" });
      const home = port.messages.at(-1)!;
      expect(home.buttons?.flat().find((button) => button.text.includes("First"))?.text).toContain("●");
      expect(home.buttons?.flat().find((button) => button.text.includes("Second"))?.text).toContain("○");
      const selectSecond = home.buttons?.flat().find((button) => button.text.includes("Second"))?.callbackData;
      await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "select", data: selectSecond!, messageId: home.messageId });
      const selected = port.edits.at(-1)!;
      expect(selected.text).toContain("VS Code runtime: not connected");
      const open = selected.buttons?.flat().find((button) => button.text === "Open in Pocket VS Code")?.callbackData;
      await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "open", data: open!, messageId: home.messageId });
      expect(runtimeAdapter.opens).toEqual([await core.workspaces.validate(second).then((workspace) => workspace.path)]);
      expect(runtimeAdapter.runtimes.some((runtime) => runtime.id === "runtime-first")).toBe(true);
      expect(port.edits.at(-1)?.text).toContain("Pocket VS Code connected");
      controller.close();
      await core.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects a workspace, filters /chats by canonical cwd, preserves All conversations, and switches explicitly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-pocket-telegram-workspaces-"));
    try {
      const firstCandidate = path.join(root, "First");
      const secondCandidate = path.join(root, "Second");
      await Promise.all([mkdir(firstCandidate), mkdir(secondCandidate)]);
      const first = await realpath(firstCandidate);
      const second = await realpath(secondCandidate);
      let workspaceSequence = 0;
      let conversationSequence = 0;
      const workspaceCallbacks = new WorkspaceCallbackRegistry({ handle: () => `workspace_${++workspaceSequence}` });
      const conversationCallbacks = new ConversationCallbackRegistry({ handle: () => `conversation_${++conversationSequence}` });
      const { adapter, core, port } = setup();
      const controller = new TelegramController({
        core, port, allowedUserId: allowed, workspaceCallbacks, conversationCallbacks,
      });
      const firstSession = { ...fixtureSession, id: "thread-first", cwd: first, title: "First chat" };
      const secondSession = { ...fixtureSession, id: "thread-second", cwd: second, title: "Second chat" };
      adapter.listResponses.push([firstSession, secondSession], [firstSession, secondSession], [firstSession, secondSession], [firstSession, secondSession]);
      await core.workspaces.select(first);

      await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/workspaces" });
      expect(port.messages.at(-1)?.text).toContain("First");
      await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
      const scoped = port.messages.at(-1)!;
      expect(scoped.text).toContain("First chat");
      expect(scoped.text).not.toContain("Second chat");
      const all = scoped.buttons?.flat().find((button) => button.text === "All conversations")?.callbackData;
      await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "all", data: all!, messageId: scoped.messageId });
      const global = port.edits.at(-1)!;
      expect(global.text).toContain("First chat");
      expect(global.text).toContain("Second chat");
      const openSecond = global.buttons?.flat().find((button) => button.text === "Second chat")?.callbackData;
      await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "preview", data: openSecond!, messageId: scoped.messageId });
      const preview = port.edits.at(-1)!;
      expect(preview.text).toContain("belongs to another workspace");
      const switchAndUse = preview.buttons?.flat().find((button) => button.text === "Switch workspace & use chat")?.callbackData;
      await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "switch", data: switchAndUse!, messageId: scoped.messageId });
      expect(core.sessions.selected?.id).toBe("thread-second");
      expect(core.workspaces.matches(second)).toBe(true);
      await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "same switched conversation" });
      expect(adapter.startSessions.at(-1)).toBe("thread-second");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores unauthorized messages and private-chat mismatches", async () => {
    const { adapter, port, controller } = setup();
    await controller.handle({ type: "message", userId: 999, chatId: 999, text: "/sessions" });
    await controller.handle({ type: "message", userId: allowed, chatId: -1001, text: "/sessions" });
    expect(adapter.listCalls).toBe(0);
    expect(port.messages).toHaveLength(0);
    await controller.handle({ type: "callback", userId: 999, chatId: 999, callbackId: "x", data: "approval:approve:approval-1" });
    expect(port.callbacks).toEqual([{ id: "x", text: "Unauthorized.", alert: true }]);
  });

  it("adopts a newly paired Telegram identity for commands and output", async () => {
    const { adapter, port, controller } = setup();
    controller.setAllowedUserId(999);
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/sessions" });
    expect(adapter.listCalls).toBe(0);
    await controller.handle({ type: "message", userId: 999, chatId: 999, text: "/sessions" });
    expect(adapter.listCalls).toBe(1);
    expect(port.messages.at(-1)?.chatId).toBe(999);
  });

  it("discovers, selects, reports status, and sends normal text through core managers", async () => {
    const { adapter, port, controller } = setup();
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "hello before selection" });
    expect(port.messages.at(-1)?.text).toContain("will not guess");
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/sessions" });
    expect(port.messages.at(-1)?.text).toContain(fixtureSession.id);
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: `/use ${fixtureSession.id}` });
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/status" });
    expect(port.messages.at(-1)?.text).toContain("Status: idle");
    expect(port.messages.at(-1)?.text).not.toContain("C:\\fixture");
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "do the task" });
    expect(adapter.starts).toEqual(["do the task"]);
    expect(port.messages.at(-1)?.text).toBe("Task submitted: turn-1.");
  });

  it("uses the exact notLoaded thread exposed by /sessions and starts the task on that same thread", async () => {
    const { adapter, core, port, controller } = setup();
    adapter.listResponses.push(
      [{ ...fixtureSession, loaded: false, topology: "historical", canAcceptDirectInput: null, status: { type: "notLoaded" }, turns: [] }],
      [],
    );

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/sessions" });
    expect(port.messages.at(-1)?.text).toContain(`${fixtureSession.id}\n`);
    expect(port.messages.at(-1)?.text).toContain("[notLoaded]");
    expect(port.messages.at(-1)?.text).toContain(`Use: /use ${fixtureSession.id}`);

    await controller.handle({
      type: "message", userId: allowed, chatId: allowed,
      text: `/use ${fixtureSession.id}`,
    });
    expect(adapter.listCalls).toBe(1);
    expect(adapter.attachCalls).toEqual([fixtureSession.id]);
    expect(core.sessions.selected?.id).toBe(fixtureSession.id);
    expect(core.sessions.selected?.loaded).toBe(true);

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "same conversation task" });
    expect(adapter.startSessions).toEqual([fixtureSession.id]);
    expect(adapter.starts).toEqual(["same conversation task"]);
  });

  it("uses opaque approval callbacks and rejects a duplicate decision", async () => {
    const capability = "capability-secret-value-123456789";
    const { adapter, core, port, controller } = setup([capability]);
    await core.sessions.use(fixtureSession.id);
    adapter.emit({
      type: "approval.pending",
      approval: {
        requestId: 91, kind: "command", sessionId: fixtureSession.id, turnId: "turn-a", itemId: "item-a",
        command: `powershell.exe Set-Content safe.txt ${capability}`, reason: "write fixture",
      },
    });
    await tick();
    const approvalMessage = port.messages.at(-1)!;
    expect(approvalMessage.text).toContain("powershell.exe");
    expect(approvalMessage.text).not.toContain(capability);
    expect(approvalMessage.text).toContain("<REDACTED>");
    const callbackData = approvalMessage.buttons?.[0]?.[0]?.callbackData;
    expect(callbackData).toBe("approval:approve:approval-1");
    expect(callbackData).not.toContain("powershell");
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "cb1", data: callbackData! });
    expect(adapter.decisions).toEqual([{ id: 91, decision: "accept" }]);
    expect(port.edits.at(-1)?.text).toContain("Approved.");
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "cb2", data: callbackData! });
    expect(adapter.decisions).toHaveLength(1);
    expect(port.callbacks.at(-1)).toEqual({ id: "cb2", text: "Approval expired or already resolved.", alert: true });
  });

  it("denies approvals, interrupts, and renders selected-conversation output in one live Telegram message", async () => {
    const { adapter, core, port, controller } = setup();
    await core.sessions.use(fixtureSession.id);
    adapter.emit({ type: "approval.pending", approval: { requestId: "f", kind: "file", sessionId: fixtureSession.id, turnId: "turn-b", itemId: "item-b", grantRoot: "C:\\fixture" } });
    await tick();
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "deny", data: "approval:deny:approval-1" });
    expect(adapter.decisions).toEqual([{ id: "f", decision: "decline" }]);
    adapter.emit({ type: "task.started", sessionId: fixtureSession.id, turnId: "active" });
    await tick();
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/stop" });
    expect(adapter.interrupts).toEqual(["active"]);
    adapter.emit({ type: "message.delta", sessionId: fixtureSession.id, turnId: "active", itemId: "m", text: "Live " });
    adapter.emit({ type: "message.delta", sessionId: fixtureSession.id, turnId: "active", itemId: "m", text: "answer" });
    adapter.emit({ type: "task.completed", sessionId: fixtureSession.id, turnId: "active", status: "interrupted", error: null });
    await tick();
    await tick();
    expect(port.messages.some((message) => message.text.includes("Task started: active"))).toBe(true);
    const live = port.messages.find((message) => message.text.includes("🤖 Codex\n\nLive"));
    expect(live).toBeDefined();
    expect(port.edits.filter((edit) => edit.messageId === live!.messageId).at(-1)?.text)
      .toContain("Live answer\n\n⏹ Durduruldu");
  });

  it("redacts secrets from live output and ignores output from an unselected conversation", async () => {
    const secret = "live-capability-secret-value";
    const { adapter, core, port } = setup([secret]);
    await core.sessions.use(fixtureSession.id);
    adapter.emit({
      type: "message.delta", sessionId: fixtureSession.id, turnId: "selected-turn", itemId: "selected-item",
      text: `Result ${secret}`,
    });
    adapter.emit({
      type: "message.delta", sessionId: "another-thread", turnId: "foreign-turn", itemId: "foreign-item",
      text: "must-not-appear",
    });
    await tick();
    expect(port.messages.some((message) => message.text.includes("Result <REDACTED>"))).toBe(true);
    expect(port.messages.some((message) => message.text.includes(secret) || message.text.includes("must-not-appear"))).toBe(false);
  });

  it("browses, previews, and selects an existing notLoaded conversation using opaque callbacks", async () => {
    let sequence = 0;
    const capability = "conversation-capability-secret";
    const callbacks = new ConversationCallbackRegistry({ handle: () => `handle_${++sequence}` });
    const { adapter, core, port, controller } = setup([capability], callbacks);
    adapter.previewSecret = capability;
    const sessions = Array.from({ length: 6 }, (_, index): CodexSession => ({
      ...fixtureSession,
      id: `01conversation-${index}`,
      title: index === 0 ? "Fix launcher regression" : `Conversation ${index + 1}`,
      updatedAt: 100 - index,
      loaded: false,
      topology: "historical",
      canAcceptDirectInput: null,
      status: { type: "notLoaded" },
      turns: [],
    }));
    adapter.listResponses.push(sessions, sessions, sessions);

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
    const listing = port.messages.at(-1)!;
    expect(listing.text).toContain("Fix launcher regression");
    expect(listing.text).toContain("Page 1/2");
    expect(listing.text).not.toContain(sessions[0]!.id);
    const openData = listing.buttons?.[0]?.[0]?.callbackData;
    expect(openData).toMatch(/^chat:handle_\d+$/u);
    expect(openData).not.toContain(sessions[0]!.id);

    await controller.handle({
      type: "callback", userId: allowed, chatId: allowed, callbackId: "open",
      data: openData!, messageId: listing.messageId,
    });
    const preview = port.edits.at(-1)!;
    expect(adapter.previewCalls).toEqual([sessions[0]!.id]);
    expect(preview.text).toContain("Fix launcher regression");
    expect(preview.text).toContain("Please inspect the fixture");
    expect(preview.text).not.toContain(capability);
    expect(preview.text).toContain("<REDACTED>");
    const useData = preview.buttons?.[0]?.[0]?.callbackData;
    expect(useData).toMatch(/^chat:handle_\d+$/u);
    expect(useData).not.toContain(sessions[0]!.id);

    await controller.handle({
      type: "callback", userId: allowed, chatId: allowed, callbackId: "use",
      data: useData!, messageId: listing.messageId,
    });
    expect(adapter.attachCalls.at(-1)).toBe(sessions[0]!.id);
    expect(core.sessions.selected?.id).toBe(sessions[0]!.id);
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "continue this exact conversation" });
    expect(adapter.startSessions.at(-1)).toBe(sessions[0]!.id);
  });

  it("presents and joins an already-loaded shared-server VS Code conversation through live co-presence", async () => {
    let sequence = 0;
    const callbacks = new ConversationCallbackRegistry({ handle: () => `live_${++sequence}` });
    const { adapter, core, port, controller } = setup([], callbacks);
    adapter.listResponses.push([fixtureSession], [fixtureSession], [fixtureSession]);

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
    const listing = port.messages.at(-1)!;
    const open = listing.buttons?.flat().find((button) => button.text === fixtureSession.title)?.callbackData;
    await controller.handle({
      type: "callback", userId: allowed, chatId: allowed, callbackId: "open-live", data: open!, messageId: listing.messageId,
    });
    const preview = port.edits.at(-1)!;
    expect(preview.text).toContain("live on Pocket shared server");
    const join = preview.buttons?.flat().find((button) => button.text === "Use live chat")?.callbackData;
    await controller.handle({
      type: "callback", userId: allowed, chatId: allowed, callbackId: "join-live", data: join!, messageId: listing.messageId,
    });
    expect(adapter.attachModes.at(-1)).toBe("joinLive");
    expect(core.sessions.selected?.id).toBe(fixtureSession.id);
    expect(port.edits.at(-1)?.text).toContain("Active live conversation");
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "LIVE_COPRESENCE_OK" });
    expect(adapter.startSessions.at(-1)).toBe(fixtureSession.id);
  });

  it("resolves human titles deterministically and rejects ambiguous title prefixes", async () => {
    const { adapter, core, port, controller } = setup();
    const sessions: CodexSession[] = [
      { ...fixtureSession, id: "thread-alpha", title: "Launcher Repair" },
      { ...fixtureSession, id: "thread-beta", title: "Launcher Review" },
      { ...fixtureSession, id: "thread-gamma", title: "Telegram Acceptance" },
    ];
    adapter.listResponses.push(sessions, sessions, sessions, sessions);

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/use Telegram Acceptance" });
    expect(core.sessions.selected?.id).toBe("thread-gamma");
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/use telegram acceptance" });
    expect(adapter.attachCalls.at(-1)).toBe("thread-gamma");
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/use Telegram Acc" });
    expect(adapter.attachCalls.at(-1)).toBe("thread-gamma");
    const before = adapter.attachCalls.length;
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/use Launcher" });
    expect(adapter.attachCalls).toHaveLength(before);
    expect(port.messages.at(-1)?.text).toContain("Multiple conversations match");
  });

  it("keeps the previous selection when an active writer blocks attachment", async () => {
    const { adapter, core, port, controller } = setup();
    await core.sessions.use(fixtureSession.id);
    const blocked = {
      ...fixtureSession, id: "thread-blocked", title: "Owned elsewhere", loaded: false,
      topology: "historical" as const, canAcceptDirectInput: null, status: { type: "notLoaded" as const },
    };
    adapter.listResponses.push([blocked]);
    adapter.attachErrors.set(blocked.id, new ForeignActiveSessionError());

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/use Owned elsewhere" });
    expect(core.sessions.selected?.id).toBe(fixtureSession.id);
    expect(port.messages.at(-1)?.text).toContain("not connected through Codex Pocket");
    expect(core.sessions.known.find((session) => session.id === blocked.id)?.topology).toBe("foreignActive");
  });

  it("rejects expired and replayed conversation callbacks without changing selection", async () => {
    let now = 1_000;
    let sequence = 0;
    const callbacks = new ConversationCallbackRegistry({ ttlMs: 50, now: () => now, handle: () => `expiry_${++sequence}` });
    const { adapter, core, port, controller } = setup([], callbacks);
    adapter.listResponses.push([{
      ...fixtureSession, loaded: false, topology: "historical", canAcceptDirectInput: null, status: { type: "notLoaded" },
    }]);
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
    const data = port.messages.at(-1)?.buttons?.[0]?.[0]?.callbackData;
    now += 51;
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "expired", data: data! });
    expect(core.sessions.selected).toBeNull();
    expect(port.callbacks.at(-1)).toEqual({ id: "expired", text: "This conversation action expired. Open /chats again.", alert: true });
    expect(adapter.attachCalls).toHaveLength(0);
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "unknown", data: "chat:unknown_handle" });
    expect(core.sessions.selected).toBeNull();
    expect(port.callbacks.at(-1)?.id).toBe("unknown");
    expect(adapter.attachCalls).toHaveLength(0);
  });

  it("navigates twelve conversations, returns to Previous, and /chats resets to newest", async () => {
    let sequence = 0;
    const callbacks = new ConversationCallbackRegistry({ handle: () => `paging_${++sequence}` });
    const { adapter, port, controller } = setup([], callbacks);
    const sessions = Array.from({ length: 12 }, (_, index): CodexSession => ({
      ...fixtureSession,
      id: `thread-page-${12 - index}`,
      title: `Paged conversation ${12 - index}`,
      updatedAt: 12 - index,
      turns: [],
    }));
    adapter.listResponses.push(sessions, sessions, sessions, sessions);

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
    const initial = port.messages.at(-1)!;
    expect(initial.text).toContain("Paged conversation 12");
    expect(initial.text).toContain("Paged conversation 8");
    expect(initial.text).not.toContain("Paged conversation 7\n");
    expect(adapter.previewCalls).toHaveLength(0);
    const next = initial.buttons?.flat().find((button) => button.text === "Next ›")?.callbackData;

    await controller.handle({
      type: "callback", userId: allowed, chatId: allowed, callbackId: "next",
      data: next!, messageId: initial.messageId,
    });
    const secondPage = port.edits.at(-1)!;
    expect(secondPage.text).toContain("Paged conversation 7");
    expect(secondPage.text).toContain("Paged conversation 3");
    expect(secondPage.text).not.toContain("Paged conversation 8\n");
    const previous = secondPage.buttons?.flat().find((button) => button.text === "‹ Previous")?.callbackData;

    await controller.handle({
      type: "callback", userId: allowed, chatId: allowed, callbackId: "previous",
      data: previous!, messageId: initial.messageId,
    });
    expect(port.edits.at(-1)?.text).toContain("Paged conversation 12");

    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
    expect(port.messages.at(-1)?.text).toContain("Page 1/3");
    expect(port.messages.at(-1)?.text).toContain("Paged conversation 12");
    expect(adapter.previewCalls).toHaveLength(0);
  });

  it("selects the exact page-two thread and fails safely if a listed thread disappears", async () => {
    let sequence = 0;
    const callbacks = new ConversationCallbackRegistry({ handle: () => `exact_${++sequence}` });
    const { adapter, core, port, controller } = setup([], callbacks);
    const sessions = Array.from({ length: 10 }, (_, index): CodexSession => ({
      ...fixtureSession,
      id: `canonical-${10 - index}`,
      title: `Canonical ${10 - index}`,
      updatedAt: 10 - index,
      turns: [],
    }));
    adapter.listResponses.push(sessions, sessions, sessions, sessions);
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
    const listing = port.messages.at(-1)!;
    const next = listing.buttons?.flat().find((button) => button.text === "Next ›")?.callbackData;
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "next", data: next!, messageId: listing.messageId });
    const pageTwo = port.edits.at(-1)!;
    const openSixth = pageTwo.buttons?.[0]?.[0]?.callbackData;
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "open-sixth", data: openSixth!, messageId: listing.messageId });
    expect(adapter.previewCalls.at(-1)).toBe("canonical-5");
    const useSixth = port.edits.at(-1)?.buttons?.[0]?.[0]?.callbackData;
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "use-sixth", data: useSixth!, messageId: listing.messageId });
    expect(core.sessions.selected?.id).toBe("canonical-5");
    expect(adapter.attachCalls.at(-1)).toBe("canonical-5");

    adapter.listResponses.push(sessions, []);
    await controller.handle({ type: "message", userId: allowed, chatId: allowed, text: "/chats" });
    const disappearing = port.messages.at(-1)!;
    const openGone = disappearing.buttons?.[0]?.[0]?.callbackData;
    const attachCount = adapter.attachCalls.length;
    await controller.handle({ type: "callback", userId: allowed, chatId: allowed, callbackId: "gone", data: openGone! });
    expect(port.callbacks.at(-1)).toEqual({
      id: "gone", text: "Conversation no longer available. Open /chats again.", alert: true,
    });
    expect(adapter.attachCalls).toHaveLength(attachCount);
    expect(core.sessions.selected?.id).toBe("canonical-5");
  });
});
