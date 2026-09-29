import type { Readable, Writable } from "node:stream";
import { AsyncQueue } from "./async-queue.js";
import { JsonLineDecoder } from "./json-line-decoder.js";
import {
  RpcProtocolError,
  RpcRemoteError,
  rpcNotificationSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  type RpcId,
  type RpcMessage,
} from "./rpc-types.js";

interface PendingRequest {
  resolve(value: RpcCheckpointedResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface RpcCheckpointedResult {
  result: unknown;
  checkpoint: number;
}

const messageCheckpoints = new WeakMap<object, number>();

export function rpcMessageCheckpoint(message: RpcMessage): number | null {
  return messageCheckpoints.get(message) ?? null;
}

export interface JsonRpcPeerOptions {
  requestTimeoutMs?: number;
  onProtocolError?: (error: Error) => void;
  closeTransport?: () => Promise<void> | void;
}

export class JsonRpcPeer {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #decoder = new JsonLineDecoder();
  readonly #messages = new AsyncQueue<RpcMessage>();
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #seenResponseIds = new Set<RpcId>();
  readonly #timeoutMs: number;
  readonly #onProtocolError: (error: Error) => void;
  readonly #closeTransport: (() => Promise<void> | void) | undefined;
  #nextId = 1;
  #inboundSequence = 0;
  #closed = false;

  constructor(input: Readable, output: Writable, options: JsonRpcPeerOptions = {}) {
    this.#input = input;
    this.#output = output;
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#onProtocolError = options.onProtocolError ?? (() => undefined);
    this.#closeTransport = options.closeTransport;

    input.on("data", (chunk: Buffer | string) => this.#consume(chunk));
    input.on("end", () => this.#end());
    input.on("error", (error) => this.#fail(error));
    output.on("error", (error) => this.#fail(error));
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return (await this.requestWithCheckpoint(method, params)).result;
  }

  async requestWithCheckpoint(method: string, params?: unknown): Promise<RpcCheckpointedResult> {
    this.#assertOpen();
    const id = this.#nextId++;
    const result = new Promise<RpcCheckpointedResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcProtocolError(`Request timed out: ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    try {
      this.#write(params === undefined ? { method, id } : { method, id, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return await result;
  }

  notify(method: string, params?: unknown): void {
    this.#assertOpen();
    this.#write(params === undefined ? { method } : { method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.#assertOpen();
    this.#write({ id, result });
  }

  messages(): AsyncIterable<RpcMessage> {
    return this.#messages;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#output.end();
    this.#messages.close();
    this.#rejectPending(new RpcProtocolError("JSON-RPC peer closed."));
    await this.#closeTransport?.();
  }

  #write(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.#output.write(line, "utf8")) {
      this.#output.once("drain", () => undefined);
    }
  }

  #consume(chunk: Buffer | string): void {
    try {
      for (const value of this.#decoder.push(chunk)) this.#route(value);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #route(value: unknown): void {
    const checkpoint = ++this.#inboundSequence;
    const response = rpcResponseSchema.safeParse(value);
    if (response.success) {
      if (this.#seenResponseIds.has(response.data.id)) {
        this.#onProtocolError(new RpcProtocolError(`Duplicate response id: ${String(response.data.id)}`));
        return;
      }
      const pending = this.#pending.get(response.data.id);
      if (!pending) {
        this.#onProtocolError(new RpcProtocolError(`Unexpected response id: ${String(response.data.id)}`));
        return;
      }
      this.#seenResponseIds.add(response.data.id);
      this.#pending.delete(response.data.id);
      clearTimeout(pending.timeout);
      if (response.data.error) {
        pending.reject(new RpcRemoteError(
          response.data.error.code,
          response.data.error.message,
          response.data.error.data,
        ));
      } else {
        pending.resolve({ result: response.data.result, checkpoint });
      }
      return;
    }

    const request = rpcRequestSchema.safeParse(value);
    if (request.success) {
      messageCheckpoints.set(request.data, checkpoint);
      this.#messages.push(request.data);
      return;
    }
    const notification = rpcNotificationSchema.safeParse(value);
    if (notification.success) {
      messageCheckpoints.set(notification.data, checkpoint);
      this.#messages.push(notification.data);
      return;
    }
    throw new RpcProtocolError("Unknown JSON-RPC message shape.");
  }

  #end(): void {
    try {
      for (const value of this.#decoder.finish()) this.#route(value);
    } catch (error) {
      this.#onProtocolError(error instanceof Error ? error : new Error(String(error)));
    }
    this.#fail(new RpcProtocolError("App Server transport ended."));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onProtocolError(error);
    this.#messages.close();
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new RpcProtocolError("JSON-RPC peer is closed.");
  }
}
