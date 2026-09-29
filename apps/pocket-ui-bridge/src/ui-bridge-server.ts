import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface UiBridgeFacade {
  state(): Promise<unknown>;
  openWorkspace(path: string): Promise<unknown>;
  workspaceRoots(): Promise<unknown>;
  workspaceDirectory(path: string, page: number): Promise<unknown>;
  selectBrowsableWorkspace(path: string): Promise<unknown>;
  createConversation(model: string, reasoningEffort: string): Promise<unknown>;
  selectConversation(id: string, switchWorkspace: boolean): Promise<unknown>;
  sendTask(prompt: string): Promise<unknown>;
  stopTask(): Promise<unknown>;
  decideApproval(id: string, decision: "approve" | "deny"): Promise<unknown>;
  history(): Promise<unknown>;
  checkUpdates(): Promise<unknown>;
  startPairing(): Promise<unknown>;
  pairingStatus(): Promise<unknown>;
  revokePairing(): Promise<unknown>;
  telegramBot(token: string): Promise<unknown>;
  discoverTelegram(token: string): Promise<unknown>;
  configureTelegram(token: string, userId: string): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length; if (size > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(value);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required.");
  return parsed as Record<string, unknown>;
}

export class UiBridgeServer {
  readonly token: string;
  readonly #facade: UiBridgeFacade;
  readonly #server;
  readonly #clients = new Set<ServerResponse>();
  #unsubscribe: (() => void) | null = null;

  constructor(facade: UiBridgeFacade, token = randomBytes(32).toString("base64url")) {
    this.#facade = facade; this.token = token;
    this.#server = createServer((request, response) => void this.#handle(request, response));
  }

  async start(): Promise<{ endpoint: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => { this.#server.off("error", reject); resolve(); });
    });
    this.#unsubscribe = this.#facade.subscribe((event) => this.broadcast(event));
    const address = this.#server.address() as AddressInfo;
    return { endpoint: `http://127.0.0.1:${address.port}`, port: address.port };
  }

  broadcast(event: unknown): void {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...this.#clients]) { try { client.write(line); } catch { this.#clients.delete(client); } }
  }

  async close(): Promise<void> {
    this.#unsubscribe?.(); this.#unsubscribe = null;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("x-content-type-options", "nosniff");
    const remote = request.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1" && remote !== "::1") { json(response, 403, { error: "Local clients only." }); return; }
    const authorization = request.headers.authorization ?? "";
    if (!safeEqual(authorization, `Bearer ${this.token}`)) { json(response, 401, { error: "Unauthorized." }); return; }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/v1/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        response.write(`data: ${JSON.stringify({ type: "bridge.connected" })}\n\n`);
        this.#clients.add(response);
        request.once("close", () => this.#clients.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/state") { json(response, 200, await this.#facade.state()); return; }
      if (request.method === "GET" && url.pathname === "/v1/workspaces/roots") { json(response, 200, await this.#facade.workspaceRoots()); return; }
      if (request.method === "GET" && url.pathname === "/v1/pairing") { json(response, 200, await this.#facade.pairingStatus()); return; }
      if (request.method === "POST" && url.pathname === "/v1/pairing/start") { json(response, 200, await this.#facade.startPairing()); return; }
      if (request.method === "POST" && url.pathname === "/v1/pairing/revoke") { json(response, 200, await this.#facade.revokePairing()); return; }
      const input = request.method === "POST" ? await body(request) : {};
      if (request.method === "POST" && url.pathname === "/v1/workspaces/roots") { json(response, 200, await this.#facade.workspaceRoots()); return; }
      if (request.method === "POST" && url.pathname === "/v1/history") { json(response, 200, await this.#facade.history()); return; }
      if (request.method === "POST" && url.pathname === "/v1/onboarding/telegram/bot" && typeof input.token === "string") {
        json(response, 200, await this.#facade.telegramBot(input.token)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/workspaces/open" && typeof input.path === "string") {
        json(response, 200, await this.#facade.openWorkspace(input.path)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/workspaces/directory" && typeof input.path === "string") {
        json(response, 200, await this.#facade.workspaceDirectory(input.path, typeof input.page === "number" ? input.page : 0)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/workspaces/select-browsable" && typeof input.path === "string") {
        json(response, 200, await this.#facade.selectBrowsableWorkspace(input.path)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations" &&
          typeof input.model === "string" && typeof input.reasoningEffort === "string") {
        json(response, 200, await this.#facade.createConversation(input.model, input.reasoningEffort)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations/select" && typeof input.id === "string") {
        json(response, 200, await this.#facade.selectConversation(input.id, input.switchWorkspace === true)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks" && typeof input.prompt === "string") {
        json(response, 200, await this.#facade.sendTask(input.prompt)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks/stop") { json(response, 200, await this.#facade.stopTask()); return; }
      if (request.method === "GET" && url.pathname === "/v1/history") { json(response, 200, await this.#facade.history()); return; }
      if (request.method === "POST" && url.pathname === "/v1/updates/check") { json(response, 200, await this.#facade.checkUpdates()); return; }
      if (request.method === "POST" && url.pathname === "/v1/onboarding/telegram/discover" && typeof input.token === "string") {
        json(response, 200, await this.#facade.discoverTelegram(input.token)); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/onboarding/telegram/configure" &&
          typeof input.token === "string" && typeof input.userId === "string") {
        json(response, 200, await this.#facade.configureTelegram(input.token, input.userId)); return;
      }
      const approval = url.pathname.match(/^\/v1\/approvals\/([^/]+)\/(approve|deny)$/u);
      if (request.method === "POST" && approval) {
        json(response, 200, await this.#facade.decideApproval(decodeURIComponent(approval[1]!), approval[2] as "approve" | "deny")); return;
      }
      json(response, 404, { error: "Unknown operation." });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message.slice(0, 300) : "Request failed." });
    }
  }
}
