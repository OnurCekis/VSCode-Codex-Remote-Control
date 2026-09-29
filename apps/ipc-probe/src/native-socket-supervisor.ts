import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcPeer } from "./json-rpc-peer.js";

export const PINNED_CODEX_SHA256 = "17E4FED6D6676AE0B894A7C39821DD1C50C1A786EEFB05362A3F9FDA678AF466";

export interface NativeSocketConnection {
  peer: JsonRpcPeer;
  close(): Promise<void>;
}

export interface NativeSocketSupervisorOptions {
  codexPath: string;
  socketPath: string;
  codexHome: string;
  verifyBinaryHash?: boolean;
}

export function windowsPathToSocketArgument(socketPath: string): string {
  const absolute = path.win32.resolve(socketPath).replaceAll("\\", "/");
  if (!/^[A-Za-z]:\//u.test(absolute)) {
    throw new Error(`Windows socket path must be drive-absolute: ${socketPath}`);
  }
  const argument = `/${absolute}`;
  if (Buffer.byteLength(argument, "utf8") > 107) {
    throw new Error("Windows AF_UNIX socket path exceeds the 107-byte sockaddr_un limit.");
  }
  return argument;
}

export function socketArgumentToListenUrl(socketArgument: string): string {
  if (!/^\/[A-Za-z]:\//u.test(socketArgument)) {
    throw new Error(`Invalid normalized Windows socket argument: ${socketArgument}`);
  }
  return `unix://${socketArgument}`;
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();
}

export async function verifyPinnedCodexBinary(
  filePath: string,
  expectedSha256: string = PINNED_CODEX_SHA256,
): Promise<void> {
  const binary = await stat(filePath);
  if (!binary.isFile()) throw new Error("Pinned Codex path is not a file.");
  const actualHash = await sha256(filePath);
  if (actualHash !== expectedSha256.toUpperCase()) {
    throw new Error(`Pinned Codex SHA-256 mismatch: ${actualHash}`);
  }
}

export class NativeSocketSupervisor {
  readonly #options: NativeSocketSupervisorOptions;
  readonly socketArgument: string;
  readonly listenUrl: string;
  #server: ChildProcessWithoutNullStreams | null = null;
  #stderr = "";

  constructor(options: NativeSocketSupervisorOptions) {
    this.#options = options;
    this.socketArgument = windowsPathToSocketArgument(options.socketPath);
    this.listenUrl = socketArgumentToListenUrl(this.socketArgument);
  }

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error("Native App Server supervisor is already running.");
    if (this.#options.verifyBinaryHash !== false) {
      await verifyPinnedCodexBinary(this.#options.codexPath);
    } else {
      const binary = await stat(this.#options.codexPath);
      if (!binary.isFile()) throw new Error("Pinned Codex path is not a file.");
    }

    const child = spawn(this.#options.codexPath, ["app-server", "--listen", this.listenUrl], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_HOME: this.#options.codexHome,
        RUST_LOG: process.env.RUST_LOG ?? "codex_app_server_transport::transport::unix_socket=info",
      },
    });
    this.#server = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-32_768);
    });
    await delay(250);
    if (child.exitCode !== null) {
      throw new Error(`Native App Server exited during startup (${child.exitCode}): ${this.#stderr.trim()}`);
    }
  }

  async connect(name: string, timeoutMs = 15_000): Promise<NativeSocketConnection> {
    if (!this.#server || this.#server.exitCode !== null) {
      throw new Error("Native App Server is not running.");
    }

    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    do {
      const proxy = spawn(
        this.#options.codexPath,
        ["app-server", "proxy", "--sock", this.socketArgument],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            CODEX_HOME: this.#options.codexHome,
            RUST_LOG: process.env.RUST_LOG ?? "codex_app_server_transport::transport::unix_socket=info",
          },
        },
      );
      let proxyStderr = "";
      proxy.stderr.setEncoding("utf8");
      proxy.stderr.on("data", (chunk: string) => { proxyStderr += chunk; });
      const peer = new JsonRpcPeer(proxy.stdout, proxy.stdin, {
        requestTimeoutMs: 2_000,
        closeTransport: () => {
          if (!proxy.killed) proxy.kill();
        },
      });

      try {
        await peer.request("initialize", {
          clientInfo: { name, title: name, version: "0.0.0" },
          capabilities: { experimentalApi: true },
        });
        peer.notify("initialized", {});
        return { peer, close: async () => { await peer.close(); } };
      } catch (error) {
        lastError = proxyStderr.trim() ? new Error(`${String(error)}: ${proxyStderr.trim()}`) : error;
        await peer.close();
        await delay(100);
      }
    } while (Date.now() < deadline);

    const serverLog = this.#stderr.trim();
    const incompatibility = serverLog.includes("failed to upgrade control socket websocket connection")
      ? "Pinned CLI native-socket incompatibility: proxy reached the listener but did not perform a valid WebSocket upgrade."
      : "Could not connect to native App Server socket.";
    throw new Error(
      `${incompatibility} ${String(lastError)}` +
      (serverLog ? `\nApp Server stderr:\n${serverLog}` : ""),
    );
  }

  async stop(): Promise<void> {
    const child = this.#server;
    this.#server = null;
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(3_000).then(() => undefined),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
