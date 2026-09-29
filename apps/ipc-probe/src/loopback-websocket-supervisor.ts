import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import process from "node:process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { verifyPinnedCodexBinary } from "./native-socket-supervisor.js";

const execFileAsync = promisify(execFile);
const LOOPBACK = "127.0.0.1";

async function reserveDynamicPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback TCP port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export interface LoopbackWebSocketSupervisorOptions {
  codexPath: string;
  codexHome: string;
  expectedCodexSha256?: string;
  startupTimeoutMs?: number;
}

export function parseLsofListenerAddresses(output: string): string[] {
  return output.split(/\r?\n/u)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1).replace(/ \(LISTEN\)$/u, ""))
    .map((endpoint) => {
      if (endpoint.startsWith("[")) return endpoint.slice(1, endpoint.indexOf("]"));
      return endpoint.slice(0, endpoint.lastIndexOf(":"));
    })
    .filter(Boolean);
}

export class LoopbackWebSocketSupervisor {
  readonly #options: LoopbackWebSocketSupervisorOptions;
  readonly token = randomBytes(32).toString("base64url");
  #server: ChildProcessWithoutNullStreams | null = null;
  #port: number | null = null;
  #stderr = "";

  constructor(options: LoopbackWebSocketSupervisorOptions) {
    this.#options = options;
  }

  get endpoint(): string {
    if (this.#port === null) throw new Error("Loopback App Server has not started.");
    return `ws://${LOOPBACK}:${this.#port}`;
  }

  get healthEndpoint(): string {
    if (this.#port === null) throw new Error("Loopback App Server has not started.");
    return `http://${LOOPBACK}:${this.#port}/readyz`;
  }

  get stderr(): string {
    return this.#stderr;
  }

  get pid(): number {
    const pid = this.#server?.pid;
    if (!pid) throw new Error("Loopback App Server PID is unavailable.");
    return pid;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error("Loopback App Server supervisor is already running.");
    await verifyPinnedCodexBinary(this.#options.codexPath, this.#options.expectedCodexSha256);
    const port = await reserveDynamicPort();
    this.#port = port;
    const tokenHash = createHash("sha256").update(this.token).digest("hex");
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.toUpperCase().startsWith("CODEX_")) environment[key] = value;
    }
    environment.CODEX_HOME = this.#options.codexHome;
    const child = spawn(this.#options.codexPath, [
      "app-server",
      "--listen", `ws://${LOOPBACK}:${port}`,
      "--ws-auth", "capability-token",
      "--ws-token-sha256", tokenHash,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: environment,
    });
    this.#server = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-65_536);
    });
    await this.#waitUntilReady();
    await this.assertReady();
  }

  async assertReady(): Promise<void> {
    const child = this.#server;
    if (!child || child.exitCode !== null || this.#port === null) {
      throw new Error("Loopback App Server is not running.");
    }
    const response = await fetch(this.healthEndpoint, { signal: AbortSignal.timeout(1_000) });
    if (response.status !== 200) {
      throw new Error(`Loopback App Server readiness check failed: ${response.status} ${response.statusText}`);
    }
    await this.#assertLoopbackOnly(child.pid, this.#port);
  }

  async stop(): Promise<void> {
    const child = this.#server;
    this.#server = null;
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(3_000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async #waitUntilReady(): Promise<void> {
    const child = this.#server;
    if (!child) throw new Error("Loopback App Server is not running.");
    const deadline = Date.now() + (this.#options.startupTimeoutMs ?? 20_000);
    let lastStatus: string = "not attempted";
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Loopback App Server exited during startup (${child.exitCode}): ${this.#stderr.trim()}`);
      }
      try {
        const response = await fetch(this.healthEndpoint, { signal: AbortSignal.timeout(1_000) });
        lastStatus = `${response.status} ${response.statusText}`;
        if (response.status === 200) return;
      } catch (error) {
        lastStatus = error instanceof Error ? error.message : String(error);
      }
      await delay(50);
    }
    throw new Error(`Loopback App Server /readyz did not become ready: ${lastStatus}\n${this.#stderr.trim()}`);
  }

  async #assertLoopbackOnly(pid: number | undefined, port: number): Promise<void> {
    if (!pid) throw new Error("Loopback App Server PID is unavailable.");
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/usr/sbin/lsof", [
        "-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn",
      ], { timeout: 5_000 });
      const addresses = parseLsofListenerAddresses(stdout);
      if (addresses.length === 0 || addresses.some((address) => address !== LOOPBACK)) {
        throw new Error(`App Server listener is not exclusively bound to ${LOOPBACK}: ${JSON.stringify(addresses)}`);
      }
      return;
    }
    if (process.platform !== "win32") {
      throw new Error(`App Server listener inspection is not implemented for ${process.platform}.`);
    }
    const script = [
      `$rows = Get-NetTCPConnection -State Listen -LocalPort ${port} -OwningProcess ${pid} -ErrorAction Stop`,
      "$rows | ForEach-Object { $_.LocalAddress }",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 5_000,
    });
    const addresses = stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
    if (addresses.length === 0 || addresses.some((address) => address !== LOOPBACK)) {
      throw new Error(`App Server listener is not exclusively bound to ${LOOPBACK}: ${JSON.stringify(addresses)}`);
    }
  }
}
