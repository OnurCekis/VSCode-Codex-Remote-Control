import type { CodexAdapter } from "./codex-adapter.js";
import type { ActiveTurnSnapshot, AdapterApproval, CodexEvent } from "./domain-events.js";

export interface LiveTurnIdentity { runtimeId: string; threadId: string; turnId: string }
interface SequencedLiveEvent extends LiveTurnIdentity { sequence: number }

export type LiveOutputEvent =
  | (SequencedLiveEvent & { type: "turn.started" })
  | (SequencedLiveEvent & { type: "assistant.delta"; itemId: string; text: string })
  | (SequencedLiveEvent & { type: "assistant.snapshot"; text: string })
  | (SequencedLiveEvent & { type: "approval.requested"; approval: AdapterApproval })
  | (SequencedLiveEvent & { type: "turn.finished"; outcome: "completed" | "interrupted" | "failed"; protocolStatus: string; error: unknown; text: string });

export type LiveOutputListener = (event: LiveOutputEvent) => void;

interface ItemDelta { text: string; protocolSequence: number | null }
interface LiveItemState { itemId: string; itemType: string; text: string; deltas: ItemDelta[] }
interface TerminalState { status: string; error: unknown }
interface LiveTurnState {
  identity: LiveTurnIdentity;
  sequence: number;
  text: string;
  started: boolean;
  bootstrapping: boolean;
  terminal: TerminalState | null;
  lastSnapshotCheckpoint: number;
  itemOrder: string[];
  items: Map<string, LiveItemState>;
}

function key(identity: LiveTurnIdentity): string {
  return `${identity.runtimeId}\u0000${identity.threadId}\u0000${identity.turnId}`;
}

/** Transport-independent canonical output for turns observed from start or joined late. */
export class LiveOutputManager {
  readonly #adapter: CodexAdapter;
  readonly #runtimeId: string;
  readonly #listeners = new Set<LiveOutputListener>();
  readonly #turnListeners = new Map<string, Set<LiveOutputListener>>();
  readonly #turns = new Map<string, LiveTurnState>();
  readonly #bootstraps = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(adapter: CodexAdapter, runtimeId = "primary") {
    this.#adapter = adapter;
    this.#runtimeId = runtimeId;
    this.#unsubscribe = adapter.subscribe((event) => this.#consume(event));
  }

  subscribe(listener: LiveOutputListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeToTurn(identity: LiveTurnIdentity, listener: LiveOutputListener, options: { replayCurrent?: boolean } = { replayCurrent: true }): () => void {
    const turnKey = key(identity);
    const listeners = this.#turnListeners.get(turnKey) ?? new Set<LiveOutputListener>();
    listeners.add(listener);
    this.#turnListeners.set(turnKey, listeners);
    const state = this.#turns.get(turnKey);
    if (options.replayCurrent !== false && state?.text) listener({ ...state.identity, type: "assistant.snapshot", sequence: state.sequence, text: state.text });
    return () => { listeners.delete(listener); if (!listeners.size) this.#turnListeners.delete(turnKey); };
  }

  async observeActiveTurn(identity: LiveTurnIdentity): Promise<void> {
    const turnKey = key(identity);
    const existing = this.#bootstraps.get(turnKey);
    if (existing) return await existing;
    const bootstrap = this.#bootstrap(identity).finally(() => this.#bootstraps.delete(turnKey));
    this.#bootstraps.set(turnKey, bootstrap);
    return await bootstrap;
  }

  snapshot(identity: LiveTurnIdentity): string | null { return this.#turns.get(key(identity))?.text ?? null; }

  close(): void {
    this.#unsubscribe();
    this.#listeners.clear();
    this.#turnListeners.clear();
    this.#turns.clear();
    this.#bootstraps.clear();
  }

  async #bootstrap(identity: LiveTurnIdentity): Promise<void> {
    const state = this.#state(identity.threadId, identity.turnId);
    state.bootstrapping = true;
    let snapshot: ActiveTurnSnapshot | null = null;
    try {
      snapshot = await this.#adapter.observeActiveTurn?.(identity.threadId, identity.turnId) ?? null;
      if (state.terminal && this.#adapter.readTurnSnapshot) snapshot = await this.#adapter.readTurnSnapshot(identity.threadId, identity.turnId) ?? snapshot;
      if (snapshot) this.#applySnapshot(state, snapshot);
      if (!state.started) {
        state.started = true;
        this.#emit({ ...state.identity, type: "turn.started", sequence: state.sequence });
      }
      if (state.text) this.#emit({ ...state.identity, type: "assistant.snapshot", sequence: state.sequence, text: state.text });
    } finally {
      state.bootstrapping = false;
    }
    const terminal = state.terminal ?? (snapshot && snapshot.status !== "inProgress" ? { status: snapshot.status, error: null } : null);
    if (terminal) this.#finish(state, terminal);
  }

  #consume(event: CodexEvent): void {
    if (event.type === "task.started") {
      const state = this.#state(event.sessionId, event.turnId);
      if (state.started) return;
      state.started = true;
      if (!state.bootstrapping) this.#emit({ ...state.identity, type: "turn.started", sequence: state.sequence });
      return;
    }
    if (event.type === "item.started" || event.type === "item.completed") {
      if (event.itemType === "agentMessage") this.#item(this.#state(event.sessionId, event.turnId), event.itemId, event.itemType);
      return;
    }
    if (event.type === "message.delta") {
      const state = this.#state(event.sessionId, event.turnId);
      const before = state.text;
      const item = this.#item(state, event.itemId, "agentMessage");
      item.text += event.text;
      item.deltas.push({ text: event.text, protocolSequence: event.protocolSequence ?? null });
      state.text = this.#combinedText(state);
      state.sequence += 1;
      if (!state.bootstrapping) {
        const appended = state.text.startsWith(before) ? state.text.slice(before.length) : event.text;
        this.#emit({ ...state.identity, type: "assistant.delta", sequence: state.sequence, itemId: event.itemId, text: appended });
      }
      return;
    }
    if (event.type === "message.snapshot") {
      const state = this.#state(event.snapshot.sessionId, event.snapshot.turnId);
      this.#applySnapshot(state, event.snapshot);
      if (!state.bootstrapping && state.text) this.#emit({ ...state.identity, type: "assistant.snapshot", sequence: state.sequence, text: state.text });
      return;
    }
    if (event.type === "approval.pending") {
      const state = this.#state(event.approval.sessionId, event.approval.turnId);
      state.sequence += 1;
      this.#emit({ ...state.identity, type: "approval.requested", sequence: state.sequence, approval: event.approval });
      return;
    }
    if (event.type === "task.completed") {
      const state = this.#state(event.sessionId, event.turnId);
      const terminal = { status: event.status, error: event.error };
      if (state.bootstrapping) state.terminal = terminal;
      else this.#finish(state, terminal);
    }
  }

  #applySnapshot(state: LiveTurnState, snapshot: ActiveTurnSnapshot): void {
    if (snapshot.checkpoint < state.lastSnapshotCheckpoint) return;
    state.lastSnapshotCheckpoint = snapshot.checkpoint;
    const authoritativeIds = new Set(snapshot.items.map((item) => item.itemId));
    const nextOrder = snapshot.items.map((item) => item.itemId);
    for (const snapshotItem of snapshot.items) {
      const existing = state.items.get(snapshotItem.itemId);
      const later = existing?.deltas.filter((delta) => delta.protocolSequence !== null && delta.protocolSequence > snapshot.checkpoint) ?? [];
      state.items.set(snapshotItem.itemId, { itemId: snapshotItem.itemId, itemType: existing?.itemType ?? "agentMessage",
        text: `${snapshotItem.text}${later.map((delta) => delta.text).join("")}`, deltas: later });
    }
    for (const itemId of state.itemOrder) {
      if (authoritativeIds.has(itemId)) continue;
      const existing = state.items.get(itemId);
      if (!existing) continue;
      const later = existing.deltas.filter((delta) => delta.protocolSequence !== null && delta.protocolSequence > snapshot.checkpoint);
      if (!later.length) { state.items.delete(itemId); continue; }
      existing.text = later.map((delta) => delta.text).join("");
      existing.deltas = later;
      nextOrder.push(itemId);
    }
    state.itemOrder = nextOrder;
    state.text = this.#combinedText(state);
    state.sequence += 1;
  }

  #finish(state: LiveTurnState, terminal: TerminalState): void {
    state.sequence += 1;
    const outcome = terminal.status === "completed" ? "completed" : terminal.status === "interrupted" ? "interrupted" : "failed";
    this.#emit({ ...state.identity, type: "turn.finished", sequence: state.sequence, outcome, protocolStatus: terminal.status, error: terminal.error, text: state.text });
    this.#turns.delete(key(state.identity));
  }

  #state(threadId: string, turnId: string): LiveTurnState {
    const identity = { runtimeId: this.#runtimeId, threadId, turnId };
    const turnKey = key(identity);
    let state = this.#turns.get(turnKey);
    if (!state) {
      state = { identity, sequence: 0, text: "", started: false, bootstrapping: false, terminal: null, lastSnapshotCheckpoint: -1, itemOrder: [], items: new Map() };
      this.#turns.set(turnKey, state);
    }
    return state;
  }

  #item(state: LiveTurnState, itemId: string, itemType = "agentMessage"): LiveItemState {
    let item = state.items.get(itemId);
    if (!item) { item = { itemId, itemType, text: "", deltas: [] }; state.items.set(itemId, item); state.itemOrder.push(itemId); }
    return item;
  }

  #combinedText(state: LiveTurnState): string {
    return state.itemOrder.map((itemId) => state.items.get(itemId)).filter((item) => item?.itemType === "agentMessage" && item.text)
      .map((item) => item!.text).join("\n\n");
  }

  #emit(event: LiveOutputEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
    const listeners = this.#turnListeners.get(key(event));
    if (listeners) for (const listener of [...listeners]) listener(event);
  }
}
