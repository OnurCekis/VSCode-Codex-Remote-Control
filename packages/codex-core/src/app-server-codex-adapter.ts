import { z } from "zod";
import type { JsonRpcPeer } from "../../../apps/ipc-probe/src/json-rpc-peer.js";
import { rpcMessageCheckpoint } from "../../../apps/ipc-probe/src/json-rpc-peer.js";
import type { RpcMessage } from "../../../apps/ipc-probe/src/rpc-types.js";
import { discoverVscodeThreads, listLoadedThreadIds } from "../../../apps/ipc-probe/src/session-discovery.js";
import {
  ForeignActiveSessionError,
  SessionNoLongerLiveError,
  type CodexAdapter,
  type CodexModel,
  type NewConversationOptions,
  type SessionAttachMode,
  type SessionQuery,
} from "./codex-adapter.js";
import type {
  AdapterApproval,
  ActiveTurnSnapshot,
  CodexEvent,
  CodexEventListener,
  CodexSession,
  ConversationMessage,
  ConversationPreview,
  SessionRuntimeStatus,
} from "./domain-events.js";

const resumeSchema = z.object({
  thread: z.object({
    id: z.string(),
    cwd: z.string(),
    name: z.string().nullable(),
    preview: z.string(),
    updatedAt: z.number(),
    status: z.unknown(),
    turns: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
    canAcceptDirectInput: z.boolean().nullable(),
  }).passthrough(),
});
const turnStartSchema = z.object({ turn: z.object({ id: z.string() }).passthrough() });
const threadStartSchema = z.object({ thread: z.object({ id: z.string() }).passthrough() });
const modelListSchema = z.object({
  data: z.array(z.object({
    id: z.string(), model: z.string(), displayName: z.string(),
    defaultReasoningEffort: z.string().nullable().optional(),
    supportedReasoningEfforts: z.array(z.object({
      reasoningEffort: z.string(), description: z.string().optional().default(""),
    })).optional().default([]),
    isDefault: z.boolean().optional().default(false),
  }).passthrough()),
  nextCursor: z.string().nullable().optional().default(null),
});
const turnsListSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    status: z.string().optional(),
    items: z.array(z.object({ type: z.string() }).passthrough()),
  }).passthrough()),
  nextCursor: z.string().nullable(),
});
const unsubscribeSchema = z.object({ status: z.enum(["notLoaded", "notSubscribed", "unsubscribed"]) });
const statusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({ type: z.literal("active"), activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])) }),
]);
const approvalBaseSchema = z.object({
  threadId: z.string(), turnId: z.string(), itemId: z.string(),
  reason: z.string().nullable().optional(),
});

function title(name: string | null, preview: string): string {
  return name?.trim() || preview.split(/\r?\n/u, 1)[0]?.trim() || "Untitled";
}

function normalize(message: RpcMessage): CodexEvent | null {
  if (message.method === "thread/status/changed") {
    const parsed = z.object({ threadId: z.string(), status: statusSchema }).safeParse(message.params);
    return parsed.success ? { type: "session.status.changed", sessionId: parsed.data.threadId, status: parsed.data.status } : null;
  }
  if (message.method === "turn/started") {
    const parsed = z.object({ threadId: z.string(), turn: z.object({ id: z.string() }).passthrough() }).safeParse(message.params);
    return parsed.success ? { type: "task.started", sessionId: parsed.data.threadId, turnId: parsed.data.turn.id } : null;
  }
  if (message.method === "turn/completed") {
    const parsed = z.object({
      threadId: z.string(),
      turn: z.object({ id: z.string(), status: z.string(), error: z.unknown().nullable().optional() }).passthrough(),
    }).safeParse(message.params);
    return parsed.success ? {
      type: "task.completed", sessionId: parsed.data.threadId, turnId: parsed.data.turn.id,
      status: parsed.data.turn.status, error: parsed.data.turn.error ?? null,
    } : null;
  }
  if (message.method === "item/started" || message.method === "item/completed") {
    const parsed = z.object({
      threadId: z.string(), turnId: z.string(),
      item: z.object({ id: z.string(), type: z.string() }).passthrough(),
    }).safeParse(message.params);
    return parsed.success ? {
      type: message.method === "item/started" ? "item.started" : "item.completed",
      sessionId: parsed.data.threadId, turnId: parsed.data.turnId,
      itemId: parsed.data.item.id, itemType: parsed.data.item.type,
    } : null;
  }
  if (message.method === "item/agentMessage/delta") {
    const parsed = z.object({ threadId: z.string(), turnId: z.string(), itemId: z.string(), delta: z.string() }).safeParse(message.params);
    return parsed.success ? {
      type: "message.delta", sessionId: parsed.data.threadId, turnId: parsed.data.turnId,
      itemId: parsed.data.itemId, text: parsed.data.delta,
      ...(rpcMessageCheckpoint(message) !== null ? { protocolSequence: rpcMessageCheckpoint(message)! } : {}),
    } : null;
  }
  if ("id" in message && message.method === "item/commandExecution/requestApproval") {
    const parsed = approvalBaseSchema.extend({
      command: z.string().nullable().optional(), cwd: z.string().nullable().optional(),
    }).safeParse(message.params);
    if (!parsed.success) return null;
    const approval: AdapterApproval = {
      requestId: message.id, kind: "command", sessionId: parsed.data.threadId,
      turnId: parsed.data.turnId, itemId: parsed.data.itemId,
      ...(parsed.data.command !== undefined ? { command: parsed.data.command } : {}),
      ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    };
    return { type: "approval.pending", approval };
  }
  if ("id" in message && message.method === "item/fileChange/requestApproval") {
    const parsed = approvalBaseSchema.extend({ grantRoot: z.string().nullable().optional() }).safeParse(message.params);
    if (!parsed.success) return null;
    const approval: AdapterApproval = {
      requestId: message.id, kind: "file", sessionId: parsed.data.threadId,
      turnId: parsed.data.turnId, itemId: parsed.data.itemId,
      ...(parsed.data.grantRoot !== undefined ? { grantRoot: parsed.data.grantRoot } : {}),
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    };
    return { type: "approval.pending", approval };
  }
  if (message.method === "serverRequest/resolved") {
    const parsed = z.object({ threadId: z.string(), requestId: z.union([z.string(), z.number()]) }).safeParse(message.params);
    return parsed.success ? { type: "approval.resolved", sessionId: parsed.data.threadId, requestId: parsed.data.requestId } : null;
  }
  return null;
}

export class AppServerCodexAdapter implements CodexAdapter {
  readonly #peer: JsonRpcPeer;
  readonly #listeners = new Set<CodexEventListener>();
  readonly #eventLoop: Promise<void>;
  readonly #trackedTurns = new Map<string, string>();
  readonly #approvalCaptures = new Set<string>();
  readonly #approvalCaptureTimers = new Map<string, NodeJS.Timeout>();
  readonly #approvalSubscriptions = new Map<string, string>();
  readonly #liveTurnSubscriptions = new Set<string>();
  readonly #subscribedSessions = new Set<string>();
  readonly #subscriptionRequests = new Map<string, Promise<void>>();
  readonly #sessionDefaults = new Map<string, NewConversationOptions>();
  #modelCache: CodexModel[] | null = null;
  #observedSessionId: string | null = null;
  #closed = false;

  constructor(peer: JsonRpcPeer) {
    this.#peer = peer;
    this.#eventLoop = this.#consume();
  }

  async listSessions(query: SessionQuery = {}): Promise<CodexSession[]> {
    const threads = await discoverVscodeThreads(this.#peer, query.cwd);
    return threads.map((thread) => ({
      id: thread.id, cwd: thread.cwd, title: title(thread.name, thread.preview), preview: thread.preview,
      updatedAt: thread.updatedAt, loaded: thread.loaded,
      topology: thread.loaded ? "sharedLive" : "historical",
      canAcceptDirectInput: thread.canAcceptDirectInput,
      status: thread.status, turns: [],
    }));
  }

  async listModels(): Promise<CodexModel[]> {
    if (this.#modelCache) return this.#modelCache;
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const result = modelListSchema.parse(await this.#peer.request("model/list", {
        limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
      }));
      models.push(...result.data.map((entry) => ({
        id: entry.id, model: entry.model, displayName: entry.displayName,
        defaultReasoningEffort: entry.defaultReasoningEffort ?? null,
        supportedReasoningEfforts: entry.supportedReasoningEfforts,
        isDefault: entry.isDefault,
      })));
      cursor = result.nextCursor;
    } while (cursor);
    if (models.length === 0) throw new Error("Codex returned no picker-visible models.");
    this.#modelCache = models;
    return models;
  }

  async createSession(cwd: string, options: NewConversationOptions): Promise<CodexSession> {
    const model = (await this.listModels()).find((entry) => entry.model === options.model || entry.id === options.model);
    if (!model) throw new Error("The selected Codex model is not available for this account.");
    if (!model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === options.reasoningEffort)) {
      throw new Error("The selected reasoning effort is not supported by this model.");
    }
    const started = threadStartSchema.parse(await this.#peer.request("thread/start", {
      cwd, model: model.model, approvalPolicy: "on-request", sandbox: "workspace-write",
      serviceName: "codex_pocket",
    }));
    this.#sessionDefaults.set(started.thread.id, { model: model.model, reasoningEffort: options.reasoningEffort });
    return {
      id: started.thread.id, cwd, title: "Untitled", preview: "", updatedAt: Math.floor(Date.now() / 1_000),
      loaded: true, topology: "sharedLive", canAcceptDirectInput: true, status: { type: "idle" }, turns: [],
    };
  }

  async attach(sessionId: string, mode: SessionAttachMode): Promise<CodexSession> {
    if (mode === "joinLive" && !(await listLoadedThreadIds(this.#peer)).has(sessionId)) {
      throw new SessionNoLongerLiveError();
    }
    let raw: unknown;
    try {
      raw = mode === "joinLive"
        ? await this.#peer.request("thread/read", { threadId: sessionId, includeTurns: false })
        : await this.#peer.request("thread/resume", { threadId: sessionId, excludeTurns: false });
    } catch (error) {
      if (/active writer/iu.test(error instanceof Error ? error.message : String(error))) throw new ForeignActiveSessionError();
      throw error;
    }
    const result = resumeSchema.parse(raw);
    if (mode === "resumeHistorical") this.#subscribedSessions.add(sessionId);
    const thread = result.thread;
    if (thread.id !== sessionId) throw new Error("App Server resumed a different thread ID.");
    const status = statusSchema.parse(thread.status);
    let turns = thread.turns.map((turn) => ({ id: turn.id, status: turn.status }));
    if (mode === "joinLive") {
      const liveTurns = turnsListSchema.parse(await this.#peer.request("thread/turns/list", {
        threadId: sessionId, limit: 20, sortDirection: "desc", itemsView: "summary",
      }));
      turns = liveTurns.data.map((turn) => ({ id: turn.id, status: turn.status ?? "unknown" }));
    }
    return {
      id: thread.id, cwd: thread.cwd, title: title(thread.name, thread.preview), preview: thread.preview,
      updatedAt: thread.updatedAt, loaded: true,
      topology: mode === "joinLive" ? "sharedLive" : "historical",
      canAcceptDirectInput: thread.canAcceptDirectInput, status, turns,
    };
  }

  async readConversationPreview(sessionId: string, turnLimit: number): Promise<ConversationPreview> {
    const result = turnsListSchema.parse(await this.#peer.request("thread/turns/list", {
      threadId: sessionId,
      limit: Math.max(1, Math.min(20, turnLimit)),
      sortDirection: "desc",
      itemsView: "full",
    }));
    const messages: ConversationMessage[] = [];
    for (const turn of [...result.data].reverse()) {
      for (const item of turn.items) {
        if (item.type === "userMessage" && Array.isArray(item.content)) {
          const text = item.content
            .filter((content): content is { type: "text"; text: string } =>
              typeof content === "object" && content !== null && "type" in content && content.type === "text" &&
              "text" in content && typeof content.text === "string")
            .map((content) => content.text).join("\n").trim();
          if (text) messages.push({ role: "user", text });
        } else if (item.type === "agentMessage" && typeof item.text === "string" && item.phase !== "commentary") {
          const text = item.text.trim();
          if (text) messages.push({ role: "assistant", text });
        }
      }
    }
    return {
      sessionId,
      messages: messages.slice(-6),
      recentTurnCount: result.data.length,
      hasOlder: result.nextCursor !== null,
    };
  }

  observeSession(sessionId: string | null): void {
    const previous = this.#observedSessionId;
    this.#observedSessionId = sessionId;
    if (previous && previous !== sessionId && this.#liveTurnSubscriptions.delete(previous)) {
      void this.#releaseIfUnused(previous);
    }
  }

  async observeActiveTurn(sessionId: string, turnId: string): Promise<ActiveTurnSnapshot | null> {
    if (this.#closed) return null;
    this.#liveTurnSubscriptions.add(sessionId);
    try {
      await this.#ensureSubscribed(sessionId);
      return await this.readTurnSnapshot(sessionId, turnId);
    } catch (error) {
      this.#liveTurnSubscriptions.delete(sessionId);
      await this.#releaseIfUnused(sessionId);
      throw error;
    }
  }

  async readTurnSnapshot(sessionId: string, turnId: string): Promise<ActiveTurnSnapshot | null> {
    const response = await this.#peer.requestWithCheckpoint("thread/turns/list", {
      threadId: sessionId, limit: 20, sortDirection: "desc", itemsView: "full",
    });
    const turns = turnsListSchema.parse(response.result);
    const turn = turns.data.find((candidate) => candidate.id === turnId);
    if (!turn) return null;
    return {
      sessionId,
      turnId,
      status: turn.status ?? "unknown",
      checkpoint: response.checkpoint,
      items: turn.items.flatMap((item) => item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string"
        ? [{ itemId: item.id, text: item.text }] : []),
    };
  }

  async startTask(sessionId: string, prompt: string, cwd?: string): Promise<string> {
    const defaults = this.#sessionDefaults.get(sessionId);
    const result = turnStartSchema.parse(await this.#peer.request("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: prompt }],
      ...(cwd ? { cwd } : {}),
      ...(defaults ? { model: defaults.model, effort: defaults.reasoningEffort } : {}),
    }));
    this.#trackedTurns.set(sessionId, result.turn.id);
    this.#emit({ type: "task.started", sessionId, turnId: result.turn.id });
    return result.turn.id;
  }

  async interruptTask(sessionId: string, turnId: string): Promise<void> {
    await this.#peer.request("turn/interrupt", { threadId: sessionId, turnId });
  }

  resolveApproval(requestId: string | number, decision: "accept" | "decline"): void {
    this.#peer.respond(requestId, { decision });
    const sessionId = this.#approvalSubscriptions.get(this.#requestKey(requestId));
    if (sessionId) {
      this.#approvalSubscriptions.delete(this.#requestKey(requestId));
      void this.#releaseIfUnused(sessionId);
    }
  }

  subscribe(listener: CodexEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#approvalCaptureTimers.values()) clearTimeout(timer);
    this.#approvalCaptureTimers.clear();
    await this.#peer.close();
    await this.#eventLoop;
  }

  async #consume(): Promise<void> {
    try {
      for await (const message of this.#peer.messages()) {
        const event = normalize(message);
        if (!event) continue;
        if (event.type === "task.started") {
          if (this.#trackedTurns.get(event.sessionId) === event.turnId) continue;
          this.#trackedTurns.set(event.sessionId, event.turnId);
        } else if (event.type === "task.completed") {
          const finalSnapshot = this.#liveTurnSubscriptions.has(event.sessionId)
            ? await this.readTurnSnapshot(event.sessionId, event.turnId).catch(() => null) : null;
          if (finalSnapshot) this.#emit({ type: "message.snapshot", snapshot: finalSnapshot });
          if (this.#trackedTurns.get(event.sessionId) === event.turnId) this.#trackedTurns.delete(event.sessionId);
          if (this.#liveTurnSubscriptions.delete(event.sessionId)) void this.#releaseIfUnused(event.sessionId);
        } else if (event.type === "session.status.changed") {
          if (event.status.type === "active") {
            if (event.sessionId === this.#observedSessionId) void this.#observeLiveTurn(event.sessionId);
            void this.#discoverActiveTurn(event.sessionId);
            if (event.status.activeFlags.includes("waitingOnApproval")) void this.#captureApproval(event.sessionId);
          } else if (event.status.type === "idle") {
            void this.#completeTrackedTurn(event.sessionId);
          }
        } else if (event.type === "approval.pending" && this.#approvalCaptures.has(event.approval.sessionId)) {
          this.#finishApprovalCapture(event.approval.sessionId);
          this.#approvalSubscriptions.set(this.#requestKey(event.approval.requestId), event.approval.sessionId);
        } else if (event.type === "approval.resolved") {
          const key = this.#requestKey(event.requestId);
          const sessionId = this.#approvalSubscriptions.get(key);
          if (sessionId) {
            this.#approvalSubscriptions.delete(key);
            void this.#releaseIfUnused(sessionId);
          } else if (this.#approvalCaptures.has(event.sessionId)) {
            this.#finishApprovalCapture(event.sessionId);
            void this.#releaseIfUnused(event.sessionId);
          }
        }
        this.#emit(event);
      }
      for (const listener of [...this.#listeners]) listener({ type: "connection.closed" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      for (const listener of [...this.#listeners]) listener({ type: "connection.closed", error: detail });
    }
  }

  #emit(event: CodexEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  async #discoverActiveTurn(sessionId: string): Promise<void> {
    if (this.#trackedTurns.has(sessionId) || this.#closed) return;
    try {
      const turns = turnsListSchema.parse(await this.#peer.request("thread/turns/list", {
        threadId: sessionId, limit: 5, sortDirection: "desc", itemsView: "summary",
      }));
      const active = turns.data.find((turn) => turn.status === "inProgress");
      if (!active || this.#trackedTurns.has(sessionId)) return;
      this.#trackedTurns.set(sessionId, active.id);
      this.#emit({ type: "task.started", sessionId, turnId: active.id });
    } catch {
      // Status remains authoritative; a later status event may retry discovery.
    }
  }

  async #completeTrackedTurn(sessionId: string): Promise<void> {
    const turnId = this.#trackedTurns.get(sessionId);
    if (!turnId || this.#closed) return;
    try {
      const turns = turnsListSchema.parse(await this.#peer.request("thread/turns/list", {
        threadId: sessionId, limit: 20, sortDirection: "desc", itemsView: "summary",
      }));
      const turn = turns.data.find((candidate) => candidate.id === turnId);
      if (!turn || turn.status === "inProgress") return;
      if (this.#trackedTurns.get(sessionId) !== turnId) return;
      if (this.#liveTurnSubscriptions.has(sessionId)) {
        const finalSnapshot = await this.readTurnSnapshot(sessionId, turnId).catch(() => null);
        if (finalSnapshot) this.#emit({ type: "message.snapshot", snapshot: finalSnapshot });
      }
      this.#trackedTurns.delete(sessionId);
      this.#emit({ type: "task.completed", sessionId, turnId, status: turn.status ?? "unknown", error: null });
    } catch {
      // Fail closed: do not invent a terminal task state without protocol evidence.
    }
  }

  async #captureApproval(sessionId: string): Promise<void> {
    if (this.#approvalCaptures.has(sessionId) || this.#closed) return;
    this.#approvalCaptures.add(sessionId);
    this.#approvalCaptureTimers.set(sessionId, setTimeout(() => {
      if (!this.#approvalCaptures.has(sessionId)) return;
      this.#finishApprovalCapture(sessionId);
      void this.#releaseIfUnused(sessionId);
    }, 10_000));
    try {
      await this.#ensureSubscribed(sessionId);
    } catch {
      this.#finishApprovalCapture(sessionId);
    }
  }

  async #releaseSubscription(sessionId: string): Promise<void> {
    try {
      unsubscribeSchema.parse(await this.#peer.request("thread/unsubscribe", { threadId: sessionId }));
      this.#subscribedSessions.delete(sessionId);
    } catch {
      // A failed release is safety-significant: close the Pocket connection so it cannot retain control.
      await this.close().catch(() => undefined);
    }
  }

  async #observeLiveTurn(sessionId: string): Promise<void> {
    if (this.#liveTurnSubscriptions.has(sessionId) || this.#closed) return;
    this.#liveTurnSubscriptions.add(sessionId);
    try {
      await this.#ensureSubscribed(sessionId);
    } catch {
      this.#liveTurnSubscriptions.delete(sessionId);
    }
  }

  async #ensureSubscribed(sessionId: string): Promise<void> {
    if (this.#subscribedSessions.has(sessionId)) return;
    const existing = this.#subscriptionRequests.get(sessionId);
    if (existing) return await existing;
    const request = this.#peer.request("thread/resume", { threadId: sessionId, excludeTurns: true }).then(() => undefined);
    this.#subscriptionRequests.set(sessionId, request);
    try {
      await request;
      this.#subscribedSessions.add(sessionId);
    } finally {
      this.#subscriptionRequests.delete(sessionId);
    }
  }

  async #releaseIfUnused(sessionId: string): Promise<void> {
    if (this.#liveTurnSubscriptions.has(sessionId) ||
      [...this.#approvalSubscriptions.values()].some((candidate) => candidate === sessionId) ||
      this.#approvalCaptures.has(sessionId)) return;
    await this.#releaseSubscription(sessionId);
  }

  #requestKey(requestId: string | number): string {
    return `${typeof requestId}:${String(requestId)}`;
  }

  #finishApprovalCapture(sessionId: string): void {
    this.#approvalCaptures.delete(sessionId);
    const timer = this.#approvalCaptureTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.#approvalCaptureTimers.delete(sessionId);
  }
}
