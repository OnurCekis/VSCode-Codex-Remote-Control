// @ts-types="npm:@types/ws@8.18.1"
import WebSocket, { type RawData } from "npm:ws@8.18.3";

const REAL_CODEX_ENV = "CODEX_POCKET_CODEX_EXE";
const WS_URL_ENV = "CODEX_POCKET_WS_URL";
const WS_TOKEN_ENV = "CODEX_POCKET_WS_TOKEN";
const LOG_PATH_ENV = "CODEX_POCKET_PROXY_LOG";
const PINNED_CODEX_SHA256 = Deno.build.os === "darwin"
  ? "B973D440ACAC501FD2594A43E7CA9CE41E0A65B9DFB28D0D7A7837C99E1261E3"
  : "17E4FED6D6676AE0B894A7C39821DD1C50C1A786EEFB05362A3F9FDA678AF466";

function fail(message: string): never {
  console.error(`[codex-pocket-proxy] ${redactText(message)}`);
  Deno.exit(2);
}

function redactText(value: string, token?: string): string {
  let result = value;
  const home = Deno.env.get(Deno.build.os === "windows" ? "USERPROFILE" : "HOME");
  if (home) result = result.replaceAll(home, "<HOME>");
  if (token) result = result.replaceAll(token, "<REDACTED>");
  return result.replace(/Bearer\s+[^\s"']+/giu, "Bearer <REDACTED>");
}

function redact(value: unknown, token: string): unknown {
  if (typeof value === "string") return redactText(value, token);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, token));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = /(?:token|secret|password|authorization)/iu.test(key)
        ? "<REDACTED>"
        : redact(entry, token);
    }
    return output;
  }
  return value;
}

async function writeLog(path: string, token: string, direction: "in" | "out" | "meta", message: unknown): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), bridgePid: Deno.pid, direction, message: redact(message, token) })}\n`;
  await Deno.writeTextFile(path, line, { append: true, create: true, mode: 0o600 });
}

async function assertPinnedExecutable(path: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    fail(`Cannot access ${REAL_CODEX_ENV}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!info.isFile) fail(`${REAL_CODEX_ENV} must point to a file.`);
  const [realBinary, realSelf] = await Promise.all([Deno.realPath(path), Deno.realPath(Deno.execPath())]);
  if (realBinary.toLocaleLowerCase() === realSelf.toLocaleLowerCase()) {
    fail(`${REAL_CODEX_ENV} points back to the proxy launcher.`);
  }
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(realBinary));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (actual !== PINNED_CODEX_SHA256) fail(`Pinned Codex SHA-256 mismatch: ${actual}`);
}

function isExpectedExtensionAppServerInvocation(args: string[]): boolean {
  const appServerIndex = args.indexOf("app-server");
  if (appServerIndex < 0) return false;
  const before = args.slice(0, appServerIndex);
  const after = args.slice(appServerIndex + 1);
  const validBefore = before.length === 0 ||
    (before.length === 2 && before[0] === "-c" && before[1] === "features.code_mode_host=true");
  const validAfter = after.length === 0 ||
    (after.length === 1 && after[0] === "--analytics-default-enabled");
  if (!validBefore || !validAfter) fail(`Refusing unexpected app-server invocation: ${JSON.stringify(args)}`);
  return true;
}

function validatedLoopbackEndpoint(raw: string | undefined): string {
  if (!raw) fail(`${WS_URL_ENV} is required.`);
  let url: URL;
  try { url = new URL(raw); } catch { fail(`${WS_URL_ENV} is not a valid URL.`); }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) {
    fail(`${WS_URL_ENV} must be exactly an unauthenticated ws://127.0.0.1:<port> endpoint.`);
  }
  if (url.pathname !== "/") fail(`${WS_URL_ENV} must not contain a path.`);
  return url.href;
}

async function runPassthrough(realCodex: string, args: string[]): Promise<never> {
  const child = new Deno.Command(realCodex, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: Deno.env.toObject(),
  }).spawn();
  Deno.exit((await child.status).code);
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    let length = 0;
    for (const part of data) length += part.byteLength;
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const part of data) { combined.set(part, offset); offset += part.byteLength; }
    return new TextDecoder().decode(combined);
  }
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return new TextDecoder().decode(data);
}

async function runBridge(endpoint: string, token: string, logPath: string): Promise<never> {
  if (token.length < 32) fail(`${WS_TOKEN_ENV} must contain a high-entropy capability token.`);
  await writeLog(logPath, token, "meta", { event: "bridge/start", endpoint, pid: Deno.pid, cwd: Deno.cwd() });
  const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 16 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode ?? "unknown"}.`));
    });
    socket.once("error", reject);
  }).catch((error) => fail(error instanceof Error ? error.message : String(error)));

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let inboundQueue = Promise.resolve();
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
  socket.on("message", (data, isBinary) => {
    inboundQueue = inboundQueue.then(async () => {
      if (isBinary) throw new Error("App Server sent an unexpected binary frame.");
      const text = rawDataToString(data);
      const parsed: unknown = JSON.parse(text);
      await writeLog(logPath, token, "in", parsed);
      await Deno.stdout.write(encoder.encode(`${text}\n`));
    }).catch((error) => fail(error instanceof Error ? error.message : String(error)));
  });
  socket.once("close", closedResolve);
  socket.once("error", (error) => fail(error.message));

  let buffered = "";
  for await (const chunk of Deno.stdin.readable) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed: unknown = JSON.parse(line);
      await writeLog(logPath, token, "out", parsed);
      await new Promise<void>((resolve, reject) => socket.send(line, (error) => error ? reject(error) : resolve()));
    }
  }
  if (buffered.trim()) fail("Extension closed stdin with an incomplete JSONL frame.");
  socket.close();
  await closed;
  await inboundQueue;
  await writeLog(logPath, token, "meta", { event: "bridge/stop" });
  Deno.exit(0);
}

const realCodex = Deno.env.get(REAL_CODEX_ENV);
if (!realCodex) fail(`${REAL_CODEX_ENV} is required.`);
await assertPinnedExecutable(realCodex);
const incomingArgs = [...Deno.args];
if (!isExpectedExtensionAppServerInvocation(incomingArgs)) await runPassthrough(realCodex, incomingArgs);
const endpoint = validatedLoopbackEndpoint(Deno.env.get(WS_URL_ENV));
const token = Deno.env.get(WS_TOKEN_ENV);
if (!token) fail(`${WS_TOKEN_ENV} is required.`);
const logPath = Deno.env.get(LOG_PATH_ENV);
if (!logPath) fail(`${LOG_PATH_ENV} is required.`);
await runBridge(endpoint, token, logPath);
