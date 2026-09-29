import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { descendants, phase3BrowserName, processSnapshot, stopOwnedBrowserProcesses } from "./phase-3-platform-runtime.js";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Dynamic port allocation failed."));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function fixtureHtml(marker: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Codex Pocket Browser Fixture</title></head>
<body>
  <h1>Codex Pocket Browser Fixture</h1>
  <p id="state">BEFORE_${marker}</p>
  <button id="change" type="button">Change deterministic state</button>
  <script>
    document.querySelector('#change').addEventListener('click', async () => {
      document.querySelector('#state').textContent = 'AFTER_${marker}';
      console.error('POCKET_CONSOLE_${marker}');
      await fetch('/api/http-500').catch(() => undefined);
      await fetch('/api/network-failure').catch(() => undefined);
    });
  </script>
</body></html>`;
}

export async function startFixture(marker: string): Promise<{ baseUrl: string; close(): Promise<void> }> {
  if (!/^[A-Za-z0-9_-]+$/u.test(marker)) throw new Error("Fixture marker contains unsupported characters.");
  const sockets = new Set<net.Socket>();
  let closed = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/http-500") {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("intentional HTTP 500");
      return;
    }
    if (url.pathname === "/api/network-failure") {
      request.socket.destroy();
      return;
    }
    if (url.pathname === "/replacement") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<title>Replacement Page</title><h1 id="replacement">REPLACED_${marker}</h1>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml(marker));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      const completion = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      server.closeIdleConnections();
      server.closeAllConnections();
      await completion;
      if (server.listening) throw new Error("Fixture listener did not close.");
    },
  };
}

export async function connectClient(name: string, endpoint: URL): Promise<Client> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ name, version: "3.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint) as Parameters<Client["connect"]>[0]);
      return client;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out connecting ${name} to Playwright MCP: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

interface TextToolContent { type: "text"; text: string }
interface ImageToolContent { type: "image"; data: string; mimeType: string }

function isTextToolContent(value: unknown): value is TextToolContent {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string";
}

function isImageToolContent(value: unknown): value is ImageToolContent {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string" && typeof (value as { mimeType?: unknown }).mimeType === "string";
}

function textContent(result: unknown): string {
  const content = typeof result === "object" && result !== null ? (result as { content?: unknown }).content : undefined;
  return (Array.isArray(content) ? content : [])
    .filter(isTextToolContent)
    .map((entry) => entry.text)
    .join("\n");
}

export async function callText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${textContent(result)}`);
  return textContent(result);
}

async function main(): Promise<void> {
  const marker = randomBytes(8).toString("hex");
  const runRoot = path.resolve(".codex-pocket", "phase-3", "gate-1", `${Date.now()}-${process.pid}`);
  const userDataDir = path.join(runRoot, "browser-profile");
  const outputDir = path.join(runRoot, "mcp-output");
  await Promise.all([mkdir(userDataDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  const fixture = await startFixture(marker);
  const mcpPort = await freePort();
  const endpoint = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
  const cli = path.resolve("node_modules", "@playwright", "mcp", "cli.js");
  const child = await import("node:child_process").then(({ spawn }) => spawn(process.execPath, [cli,
    "--browser", phase3BrowserName(),
    "--headless",
    "--host", "127.0.0.1",
    "--allowed-hosts", `127.0.0.1:${mcpPort}`,
    "--port", String(mcpPort),
    "--shared-browser-context",
    "--user-data-dir", userDataDir,
    "--output-dir", outputDir,
    "--console-level", "debug",
  ], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  const serverOutput: string[] = [];
  child.stdout?.on("data", (chunk) => serverOutput.push(String(chunk)));
  child.stderr?.on("data", (chunk) => serverOutput.push(String(chunk)));
  let clientA: Client | undefined;
  let clientB: Client | undefined;
  const evidence: Record<string, unknown> = {
    phase: "3-gate-1",
    packages: {
      mcp: "0.0.79",
      playwright: "1.63.0-alpha-2026-08-05",
      playwrightCore: "1.63.0-alpha-2026-08-05",
      mcpSdk: "1.30.0",
    },
    endpoint: { host: endpoint.hostname, dynamicPort: true, path: endpoint.pathname },
  };
  const browserPids = new Set<number>();
  try {
    clientA = await connectClient("codex-pocket-gate1-a", endpoint);
    clientB = await connectClient("codex-pocket-gate1-b", endpoint);
    const tools = (await clientA.listTools()).tools.map((tool) => tool.name).sort();
    evidence.tools = tools;
    for (const required of ["browser_navigate", "browser_tabs", "browser_snapshot", "browser_evaluate", "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_close"]) {
      if (!tools.includes(required)) throw new Error(`Pinned Playwright MCP is missing required tool ${required}.`);
    }

    await callText(clientA, "browser_navigate", { url: fixture.baseUrl });
    const bInitial = await callText(clientB, "browser_snapshot");
    if (!bInitial.includes(`BEFORE_${marker}`)) throw new Error("Client B did not observe Client A's initial exact marker.");
    const initialScreenshot = await clientB.callTool({ name: "browser_take_screenshot", arguments: { type: "png" } });
    if (initialScreenshot.isError) throw new Error(`Client B initial screenshot failed: ${textContent(initialScreenshot)}`);
    const initialImage = (Array.isArray(initialScreenshot.content) ? initialScreenshot.content : []).find(isImageToolContent);
    if (!initialImage || initialImage.mimeType !== "image/png") throw new Error("Client B did not receive the initial PNG screenshot.");
    const initialPng = Buffer.from(initialImage.data, "base64");
    if (!initialPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error("Client B initial screenshot did not contain a PNG signature.");
    }

    await callText(clientA, "browser_evaluate", { function: "() => document.querySelector('#change').click()" });
    const bChanged = await callText(clientB, "browser_snapshot");
    if (!bChanged.includes(`AFTER_${marker}`)) throw new Error("Client B did not observe Client A's changed exact marker.");
    const bTabs = await callText(clientB, "browser_tabs", { action: "list" });
    if (!bTabs.includes(fixture.baseUrl)) throw new Error("Client B did not observe Client A's exact current URL.");

    const screenshot = await clientB.callTool({ name: "browser_take_screenshot", arguments: { type: "png" } });
    if (screenshot.isError) throw new Error(`Client B screenshot failed: ${textContent(screenshot)}`);
    const image = (Array.isArray(screenshot.content) ? screenshot.content : []).find(isImageToolContent);
    if (!image || image.mimeType !== "image/png" || image.data.length < 100) throw new Error("Client B did not receive a PNG screenshot.");
    const changedPng = Buffer.from(image.data, "base64");
    if (!changedPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error("Client B changed-state screenshot did not contain a PNG signature.");
    }
    if (createHash("sha256").update(initialPng).digest("hex") === createHash("sha256").update(changedPng).digest("hex")) {
      throw new Error("Client B screenshots did not change after Client A changed the visible DOM state.");
    }
    const screenshotPath = path.join(runRoot, "client-b-same-page.png");
    await writeFile(screenshotPath, changedPng);

    const consoleMessages = await callText(clientB, "browser_console_messages", { level: "error" });
    const network = await callText(clientB, "browser_network_requests", { includeStatic: false });
    await callText(clientA, "browser_navigate", { url: `${fixture.baseUrl}/replacement` });
    const bReplacement = await callText(clientB, "browser_snapshot");
    if (!bReplacement.includes(`REPLACED_${marker}`)) throw new Error("Client B did not observe Client A's replacement page.");

    const beforeClose = await processSnapshot();
    for (const record of descendants(beforeClose, child.pid ?? -1)) {
      if (/msedge|chrome|chromium/i.test(record.Name)) browserPids.add(record.ProcessId);
    }
    await callText(clientA, "browser_tabs", { action: "close", index: 0 });
    const afterCloseTabs = await callText(clientB, "browser_tabs", { action: "list" });
    const pageClosedObserved = !afterCloseTabs.includes(`REPLACED_${marker}`) && !afterCloseTabs.includes(`${fixture.baseUrl}/replacement`);
    if (!pageClosedObserved) throw new Error("Client B did not observe Client A closing the exact page.");

    evidence.sameContext = {
      clientBInitialMarker: true,
      clientBChangedMarker: true,
      clientBExactUrl: true,
      clientBScreenshot: true,
      screenshotChangedWithDom: true,
      replacementVisible: true,
      pageCloseVisible: true,
    };
    evidence.observability = {
      consoleErrorVisible: consoleMessages.includes(`POCKET_CONSOLE_${marker}`),
      http500Visible: /500/.test(network) && network.includes("/api/http-500"),
      networkFailureVisible: network.includes("/api/network-failure"),
      consoleExcerpt: consoleMessages.replaceAll(marker, "[MARKER]"),
      networkExcerpt: network.replaceAll(marker, "[MARKER]"),
    };
    evidence.screenshot = path.relative(process.cwd(), screenshotPath);
    evidence.stableIdentifiers = { mcpEndpoint: endpoint.origin + endpoint.pathname, browserContextIdExposed: false, pageIdExposed: false, pageIndexOnly: true };

    await clientA.close(); clientA = undefined;
    await clientB.close(); clientB = undefined;
    const disconnectedClient = new Client({ name: "closed-observer", version: "3.0.0" });
    let disconnected = false;
    try {
      await disconnectedClient.connect(new StreamableHTTPClientTransport(endpoint) as Parameters<Client["connect"]>[0]);
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      await disconnectedClient.listTools();
    } catch {
      disconnected = true;
    } finally {
      await disconnectedClient.close().catch(() => undefined);
    }
    if (!disconnected) throw new Error("Observer did not detect MCP/browser disappearance.");
    evidence.browserDisconnectObserved = true;

    const leakedBrowserPids = await stopOwnedBrowserProcesses(userDataDir, browserPids);
    if (leakedBrowserPids.length) throw new Error(`Pocket-owned browser processes leaked: ${leakedBrowserPids.join(",")}`);
    evidence.cleanup = { browserPidsObserved: browserPids.size, leakedBrowserProcesses: 0 };
    evidence.passed = true;
    await writeFile(path.join(runRoot, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...evidence, runRoot: path.relative(process.cwd(), runRoot) }, null, 2)}\n`);
  } finally {
    const cleanupStage = async (stage: string) => writeFile(path.join(runRoot, "cleanup-stage.txt"), `${stage}\n`);
    await cleanupStage("clients");
    await clientA?.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
    await cleanupStage("mcp-server");
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await stopOwnedBrowserProcesses(userDataDir, browserPids).catch(() => undefined);
    await cleanupStage("fixture");
    await fixture.close().catch(() => undefined);
    await cleanupStage("profile");
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    await cleanupStage("complete");
    if (!evidence.passed) {
      await writeFile(path.join(runRoot, "failure.json"), `${JSON.stringify({ ...evidence, serverOutput: serverOutput.join("").slice(-8_000) }, null, 2)}\n`).catch(() => undefined);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
