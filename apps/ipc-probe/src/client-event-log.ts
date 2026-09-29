import type { RpcMessage } from "./rpc-types.js";

interface Waiter {
  predicate(message: RpcMessage): boolean;
  resolve(message: RpcMessage): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class ClientEventLog {
  readonly messages: RpcMessage[] = [];
  readonly #waiters: Waiter[] = [];

  constructor(messages: AsyncIterable<RpcMessage>) {
    void this.#consume(messages);
  }

  async waitFor(
    predicate: (message: RpcMessage) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<RpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return await new Promise<RpcMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${description}.`));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  async #consume(messages: AsyncIterable<RpcMessage>): Promise<void> {
    for await (const message of messages) {
      this.messages.push(message);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timeout);
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Client event stream ended."));
    }
  }
}
