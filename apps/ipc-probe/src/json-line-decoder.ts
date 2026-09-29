import { StringDecoder } from "node:string_decoder";
import { RpcProtocolError } from "./rpc-types.js";

export class JsonLineDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: Buffer | string): unknown[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    return this.#drain(false);
  }

  finish(): unknown[] {
    this.#buffer += this.#decoder.end();
    return this.#drain(true);
  }

  #drain(flush: boolean): unknown[] {
    const values: unknown[] = [];
    const lines = this.#buffer.split(/\r?\n/u);
    this.#buffer = flush ? "" : (lines.pop() ?? "");

    if (flush && lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        values.push(JSON.parse(line));
      } catch (error) {
        throw new RpcProtocolError("App Server emitted malformed JSONL.", { cause: error });
      }
    }

    if (flush && this.#buffer.trim().length > 0) {
      throw new RpcProtocolError("App Server stream ended with an incomplete JSONL frame.");
    }
    return values;
  }
}
