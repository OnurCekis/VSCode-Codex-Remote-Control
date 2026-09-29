import os from "node:os";
import type { LiveOutputEvent } from "../../../packages/codex-core/src/live-output-manager.js";
import type { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";
import type { TelegramPort } from "./telegram-port.js";

export const TELEGRAM_STREAM_MESSAGE_LIMIT = 3_500;
const STREAM_BODY_LIMIT = 3_380;

interface TelegramTurnStream {
  runtimeId: string;
  threadId: string;
  turnId: string;
  chatId: number;
  userId: number;
  segment: number;
  messageId: number | null;
  canonicalText: string;
  frozenLength: number;
  buffer: string;
  rendered: string;
  timer: ReturnType<typeof setTimeout> | null;
}

function streamKey(event: Pick<LiveOutputEvent, "runtimeId" | "threadId" | "turnId">): string {
  return `${event.runtimeId}\u0000${event.threadId}\u0000${event.turnId}`;
}

function redact(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "<REDACTED>");
  return safe
    .replaceAll(os.homedir(), "<HOME>")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer <REDACTED>")
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*[^\s"']+/giu, "$1=<REDACTED>");
}

function preferredSplit(text: string): number {
  if (text.length <= STREAM_BODY_LIMIT) return text.length;
  const window = text.slice(0, STREAM_BODY_LIMIT + 1);
  const minimum = Math.floor(STREAM_BODY_LIMIT * 0.6);
  const candidates: Array<[string, number]> = [["\n\n", 2], ["\n", 1], [" ", 1]];
  for (const [boundary, width] of candidates) {
    const found = window.lastIndexOf(boundary);
    if (found >= minimum) return found + width;
  }
  let split = STREAM_BODY_LIMIT;
  const previous = text.charCodeAt(split - 1);
  const next = text.charCodeAt(split);
  if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) split -= 1;
  return split;
}

function header(segment: number): string {
  return segment === 1 ? "🤖 Codex\n\n" : `🤖 Codex · ${segment}\n\n`;
}

/** Telegram-only rendering, routing, throttling, and message segmentation. */
export class TelegramLiveOutputPresenter {
  readonly #core: PocketCore;
  readonly #port: TelegramPort;
  readonly #chatId: number;
  readonly #userId: number;
  readonly #secrets: readonly string[];
  readonly #updateMs: number;
  readonly #onError: (error: Error) => void;
  readonly #streams = new Map<string, TelegramTurnStream>();
  readonly #unsubscribe: () => void;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: {
    core: PocketCore;
    port: TelegramPort;
    chatId: number;
    userId: number;
    secrets?: readonly string[];
    updateMs?: number;
    onError?: (error: Error) => void;
  }) {
    this.#core = options.core;
    this.#port = options.port;
    this.#chatId = options.chatId;
    this.#userId = options.userId;
    this.#secrets = options.secrets ?? [];
    this.#updateMs = Math.max(0, options.updateMs ?? 750);
    this.#onError = options.onError ?? (() => undefined);
    this.#unsubscribe = this.#core.liveOutput.subscribe((event) => this.#enqueue(event));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    for (const stream of this.#streams.values()) if (stream.timer) clearTimeout(stream.timer);
    this.#streams.clear();
  }

  async settled(): Promise<void> {
    await this.#queue;
  }

  #enqueue(event: LiveOutputEvent): void {
    if (this.#closed) return;
    this.#queue = this.#queue
      .then(async () => this.#handle(event))
      .catch((error: unknown) => this.#onError(error instanceof Error ? error : new Error(String(error))));
  }

  async #handle(event: LiveOutputEvent): Promise<void> {
    const key = streamKey(event);
    if (event.type === "turn.started") {
      this.#bindIfSelected(key, event);
      return;
    }
    if (event.type === "assistant.delta") {
      const stream = this.#streams.get(key) ?? this.#bindIfSelected(key, event);
      if (!stream) return;
      const text = redact(event.text, this.#secrets);
      stream.canonicalText += text;
      stream.buffer += text;
      await this.#segment(stream);
      return;
    }
    if (event.type === "assistant.snapshot") {
      const stream = this.#streams.get(key) ?? this.#bindIfSelected(key, event);
      if (!stream) return;
      const canonical = redact(event.text, this.#secrets);
      this.#reconcileCanonical(stream, canonical);
      await this.#segment(stream);
      return;
    }
    if (event.type === "approval.requested") {
      const stream = this.#streams.get(key);
      if (stream) await this.#flush(stream);
      return;
    }
    if (event.type === "turn.finished") {
      const stream = this.#streams.get(key);
      if (!stream) return;
      if (stream.timer) clearTimeout(stream.timer);
      stream.timer = null;
      this.#reconcileCanonical(stream, redact(event.text, this.#secrets));
      await this.#segment(stream);
      const status = event.outcome === "completed" ? "✅ Tamamlandı" :
        event.outcome === "interrupted" ? "⏹ Durduruldu" : "❌ Hata";
      await this.#flush(stream, status);
      this.#streams.delete(key);
    }
  }

  #bindIfSelected(
    key: string,
    event: Pick<LiveOutputEvent, "runtimeId" | "threadId" | "turnId">,
  ): TelegramTurnStream | null {
    const selected = this.#core.sessions.selected;
    if (!selected || selected.id !== event.threadId) return null;
    const stream: TelegramTurnStream = {
      runtimeId: event.runtimeId,
      threadId: event.threadId,
      turnId: event.turnId,
      chatId: this.#chatId,
      userId: this.#userId,
      segment: 1,
      messageId: null,
      canonicalText: "",
      frozenLength: 0,
      buffer: "",
      rendered: "",
      timer: null,
    };
    this.#streams.set(key, stream);
    return stream;
  }

  async #segment(stream: TelegramTurnStream): Promise<void> {
    while (stream.buffer.length > STREAM_BODY_LIMIT) {
      const split = preferredSplit(stream.buffer);
      const frozen = stream.buffer.slice(0, split);
      stream.buffer = stream.buffer.slice(split);
      await this.#write(stream, frozen);
      stream.frozenLength += split;
      stream.segment += 1;
      stream.messageId = null;
      stream.rendered = "";
    }
    if (stream.messageId === null) {
      if (stream.buffer) await this.#write(stream, stream.buffer);
      return;
    }
    if (this.#updateMs === 0) {
      await this.#flush(stream);
      return;
    }
    if (!stream.timer) {
      stream.timer = setTimeout(() => {
        stream.timer = null;
        this.#queue = this.#queue
          .then(async () => this.#flush(stream))
          .catch((error: unknown) => this.#onError(error instanceof Error ? error : new Error(String(error))));
      }, this.#updateMs);
    }
  }

  #reconcileCanonical(stream: TelegramTurnStream, canonical: string): void {
    if (canonical === stream.canonicalText) return;
    const frozenBefore = stream.canonicalText.slice(0, stream.frozenLength);
    if (canonical.slice(0, stream.frozenLength) !== frozenBefore) {
      throw new Error("Canonical live-output snapshot diverged from an immutable Telegram continuation segment.");
    }
    stream.canonicalText = canonical;
    stream.buffer = canonical.slice(stream.frozenLength);
  }

  async #flush(stream: TelegramTurnStream, status?: string): Promise<void> {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    const body = `${stream.buffer}${status ? `${stream.buffer ? "\n\n" : ""}${status}` : ""}`;
    await this.#write(stream, body);
  }

  async #write(stream: TelegramTurnStream, body: string): Promise<void> {
    const rendered = `${header(stream.segment)}${body}`;
    if (rendered.length > TELEGRAM_STREAM_MESSAGE_LIMIT) {
      throw new Error("Telegram live-output segment exceeded the safe message limit.");
    }
    if (stream.messageId === null) {
      const sent = await this.#port.sendMessage(stream.chatId, rendered);
      stream.messageId = sent.messageId;
      stream.rendered = rendered;
    } else if (rendered !== stream.rendered) {
      await this.#port.editMessage(stream.chatId, stream.messageId, rendered);
      stream.rendered = rendered;
    }
  }
}
