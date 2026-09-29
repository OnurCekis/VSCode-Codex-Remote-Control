import { createWriteStream, type WriteStream } from "node:fs";
import os from "node:os";

type Direction = "in" | "out" | "meta";

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value.replaceAll(os.homedir(), "<HOME>");
    for (const secret of secrets) {
      if (secret) result = result.replaceAll(secret, "<REDACTED>");
    }
    return result.replace(/Bearer\s+[^\s"']+/giu, "Bearer <REDACTED>");
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = /(?:token|secret|password|authorization)/iu.test(key)
        ? "<REDACTED>"
        : redact(entry, secrets);
    }
    return output;
  }
  return value;
}

export class ProtocolLog {
  readonly #stream: WriteStream;
  readonly #secrets: readonly string[];

  constructor(path: string, secrets: readonly string[]) {
    this.#stream = createWriteStream(path, { flags: "wx", encoding: "utf8", mode: 0o600 });
    this.#secrets = secrets;
  }

  write(client: string, direction: Direction, message: unknown): void {
    this.#stream.write(`${JSON.stringify({
      at: new Date().toISOString(),
      client,
      direction,
      message: redact(message, this.#secrets),
    })}\n`);
  }

  async close(): Promise<void> {
    if (this.#stream.closed) return;
    await new Promise<void>((resolve, reject) => {
      this.#stream.once("error", reject);
      this.#stream.end(resolve);
    });
  }
}

export function redactForReport(value: unknown, secrets: readonly string[]): unknown {
  return redact(value, secrets);
}
