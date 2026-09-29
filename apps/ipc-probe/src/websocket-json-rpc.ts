import { PassThrough, Writable } from "node:stream";
import WebSocket, { type RawData } from "ws";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import type { ProtocolLog } from "./protocol-log.js";

export interface WebSocketPeerConnection {
  peer: JsonRpcPeer;
  close(): Promise<void>;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export async function expectWebSocketRejected(
  url: string,
  token: string | undefined,
  timeoutMs = 5_000,
): Promise<number | "network-error"> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for WebSocket authentication rejection."));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("WebSocket authentication unexpectedly succeeded."));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      const status = response.statusCode ?? "network-error";
      response.resume();
      socket.terminate();
      resolve(status);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve("network-error");
    });
  });
}

export async function connectWebSocketPeer(options: {
  url: string;
  token: string;
  name: string;
  log: ProtocolLog;
  timeoutMs?: number;
}): Promise<WebSocketPeerConnection> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const socket = new WebSocket(options.url, {
    handshakeTimeout: timeoutMs,
    headers: { Authorization: `Bearer ${options.token}` },
    maxPayload: 16 * 1024 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out opening authenticated WebSocket for ${options.name}.`));
    }, timeoutMs);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });

  const input = new PassThrough();
  let outgoing = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outgoing += chunk.toString("utf8");
      const lines = outgoing.split("\n");
      outgoing = lines.pop() ?? "";
      try {
        for (const line of lines) {
          if (!line) continue;
          const parsed: unknown = JSON.parse(line);
          options.log.write(options.name, "out", parsed);
          socket.send(line);
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      input.destroy(new Error("App Server sent an unexpected binary WebSocket frame."));
      return;
    }
    const text = rawDataToString(data);
    try {
      options.log.write(options.name, "in", JSON.parse(text) as unknown);
      input.write(`${text}\n`, "utf8");
    } catch (error) {
      input.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("close", () => input.end());
  socket.on("error", (error) => input.destroy(error));

  const closeSocket = async (): Promise<void> => {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_000);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.close();
    });
  };
  const peer = new JsonRpcPeer(input, output, {
    requestTimeoutMs: timeoutMs,
    closeTransport: closeSocket,
  });
  await peer.request("initialize", {
    clientInfo: { name: options.name, title: options.name, version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  peer.notify("initialized", {});
  return { peer, close: async () => { await peer.close(); } };
}
