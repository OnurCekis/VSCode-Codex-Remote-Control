import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<PocketRoom>;
  CONNECTION_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  ENVIRONMENT: string;
  MAX_FRAME_BYTES: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
}

const ROOM_METADATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function reply(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

async function credentialHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(digest);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return reply(200, { state: "ready", environment: env.ENVIRONMENT });
    const match = url.pathname.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{20,80})\/connect$/u);
    if (!match || request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return reply(404, { error: "Not found." });
    }
    const connectingIp = request.headers.get("cf-connecting-ip")
      ?? (env.ENVIRONMENT === "development" ? "local-development" : null);
    if (!connectingIp) return reply(429, { error: "Connection rate limit unavailable." });
    const rateLimit = await env.CONNECTION_RATE_LIMITER.limit({ key: connectingIp });
    if (!rateLimit.success) return reply(429, { error: "Too many connection attempts." });
    const id = env.ROOMS.idFromName(match[1]!);
    return env.ROOMS.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

type Role = "desktop" | "mobile";

export class PocketRoom extends DurableObject<Env> {
  readonly #sockets = new Map<WebSocket, Role>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    for (const socket of state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { role?: Role } | null;
      if (attachment?.role) this.#sockets.set(socket, attachment.role);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const role = request.headers.get("x-pocket-role");
    if (role !== "desktop" && role !== "mobile") return reply(400, { error: "Invalid role." });
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length < 50) return reply(401, { error: "Unauthorized." });

    const credential = authorization.slice(7);
    if (role === "desktop") {
      const credentialDigest = await credentialHash(credential);
      const stored = await this.ctx.storage.get<string>("desktopCredentialDigest");
      if (stored && stored !== credentialDigest) return reply(403, { error: "Desktop credential rejected." });
      if (!stored) await this.ctx.storage.put("desktopCredentialDigest", credentialDigest);
      for (const [socket, socketRole] of this.#sockets) if (socketRole === "desktop") socket.close(4001, "Desktop replaced");
    } else {
      for (const [socket, socketRole] of this.#sockets) if (socketRole === "mobile") socket.close(4002, "Mobile replaced");
    }

    const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
    server.serializeAttachment({ role }); this.ctx.acceptWebSocket(server); this.#sockets.set(server, role);
    await this.#extendMetadataLifetime();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const maximum = Number(this.env.MAX_FRAME_BYTES || "131072");
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > maximum) { socket.close(1009, "Frame too large"); return; }
    const source = this.#sockets.get(socket); if (!source) { socket.close(1008, "Unknown socket"); return; }
    if (source === "desktop" && typeof message === "string") {
      let control: { type?: string; operation?: string; token?: string; event?: string } | null = null;
      try { control = JSON.parse(message) as typeof control; } catch { /* opaque encrypted frame */ }
      if (control?.type === "relay.control") {
        if (control.operation === "push.register" && typeof control.token === "string" && control.token.length >= 40 && control.token.length <= 4096) {
          await this.ctx.storage.put("fcmToken", control.token); return;
        }
        if (control.operation === "push.notify" && (control.event === "taskCompleted" || control.event === "approvalRequired")) {
          await this.#push(control.event); return;
        }
        socket.close(1008, "Invalid relay control"); return;
      }
    }
    await this.#extendMetadataLifetime();
    const target: Role = source === "desktop" ? "mobile" : "desktop";
    const peers = [...this.#sockets].filter(([, role]) => role === target);
    if (peers.length === 0) { socket.send(JSON.stringify({ type: "relay.offline", target })); return; }
    for (const [peer] of peers) {
      try { peer.send(message); } catch { this.#sockets.delete(peer); }
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.#sockets.delete(socket); try { socket.close(code, reason); } catch { /* already closed */ }
  }

  webSocketError(socket: WebSocket): void { this.#sockets.delete(socket); try { socket.close(1011, "Socket error"); } catch { /* closed */ } }

  async alarm(): Promise<void> {
    if (this.#sockets.size > 0) {
      await this.#extendMetadataLifetime();
      return;
    }
    await this.ctx.storage.deleteAll();
  }

  async #extendMetadataLifetime(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ROOM_METADATA_TTL_MS);
  }

  async #push(event: "taskCompleted" | "approvalRequired"): Promise<void> {
    const token = await this.ctx.storage.get<string>("fcmToken");
    if (!token || !this.env.FIREBASE_PROJECT_ID || !this.env.FIREBASE_CLIENT_EMAIL || !this.env.FIREBASE_PRIVATE_KEY) return;
    const accessToken = await googleAccessToken(this.env.FIREBASE_CLIENT_EMAIL, this.env.FIREBASE_PRIVATE_KEY);
    await fetch(`https://fcm.googleapis.com/v1/projects/${this.env.FIREBASE_PROJECT_ID}/messages:send`, {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token, data: { event }, notification: {
        title: "VS Code Codex Remote Control", body: event === "approvalRequired" ? "Codex onayınızı bekliyor." : "Codex görevi tamamladı.",
      }, android: { priority: "high" } } }),
    });
  }
}

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function googleAccessToken(email: string, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000); const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/gu, "").replace(/\s/gu, "")), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  const assertion = `${header}.${payload}.${base64Url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const result = await response.json<{ access_token?: string }>();
  if (!response.ok || !result.access_token) throw new Error("FCM OAuth token request failed.");
  return result.access_token;
}
