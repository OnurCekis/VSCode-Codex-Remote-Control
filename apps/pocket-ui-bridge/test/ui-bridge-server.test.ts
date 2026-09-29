import { afterEach, describe, expect, it } from "vitest";
import { UiBridgeServer, type UiBridgeFacade } from "../src/ui-bridge-server.js";

function fakeFacade(): UiBridgeFacade & { calls: string[]; emit(event: unknown): void } {
  const listeners = new Set<(event: unknown) => void>();
  const calls: string[] = [];
  return {
    calls,
    state: async () => ({ pocket: "ready", workspaces: [], conversations: [] }),
    openWorkspace: async (path) => { calls.push(`open:${path}`); return { path }; },
    workspaceRoots: async () => ({ roots: [] }),
    workspaceDirectory: async (path, page) => ({ path, page, directories: [] }),
    selectBrowsableWorkspace: async (path) => ({ path }),
    createConversation: async (model, effort) => { calls.push(`create:${model}:${effort}`); return { id: "new-thread" }; },
    selectConversation: async (id) => { calls.push(`select:${id}`); return { id }; },
    sendTask: async (prompt) => { calls.push(`task:${prompt}`); return { turnId: "turn-1" }; },
    stopTask: async () => { calls.push("stop"); return { turnId: "turn-1" }; },
    decideApproval: async (id, decision) => { calls.push(`${decision}:${id}`); return { id, decision }; },
    history: async () => ({ task: "task", output: "output" }),
    checkUpdates: async () => ({ state: "upToDate" }),
    startPairing: async () => ({ code: "ABCD1234" }), pairingStatus: async () => ({ state: "waiting" }),
    revokePairing: async () => ({ state: "unpaired" }),
    telegramBot: async () => ({ botUsername: "pocket_bot", botUrl: "https://t.me/pocket_bot" }),
    discoverTelegram: async () => ({ userId: 42, displayName: "Pocket User" }),
    configureTelegram: async (_token, userId) => ({ configured: true, restartRequired: true, userId }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: (event) => listeners.forEach((listener) => listener(event)),
  };
}

describe("Flutter UI bridge", () => {
  const testToken = ["123456", "abcdefghijklmnopqrstuvwxyzABCDE"].join(":");
  const servers: UiBridgeServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(async (server) => await server.close())); });

  it("binds loopback, rejects invalid clients, and returns real facade state", async () => {
    const facade = fakeFacade(); const server = new UiBridgeServer(facade, "secret"); servers.push(server);
    const started = await server.start();
    expect(started.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    expect((await fetch(`${started.endpoint}/v1/state`)).status).toBe(401);
    expect((await fetch(`${started.endpoint}/v1/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const response = await fetch(`${started.endpoint}/v1/state`, { headers: { authorization: "Bearer secret" } });
    expect(await response.json()).toMatchObject({ pocket: "ready" });
  });

  it("exposes only bounded workspace, conversation, task, approval and stop operations", async () => {
    const facade = fakeFacade(); const server = new UiBridgeServer(facade, "secret"); servers.push(server);
    const { endpoint } = await server.start();
    const post = async (route: string, value: unknown = {}) => await fetch(`${endpoint}${route}`, {
      method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify(value),
    });
    expect((await post("/v1/workspaces/open", { path: "/work" })).status).toBe(200);
    expect((await post("/v1/workspaces/roots")).status).toBe(200);
    expect((await post("/v1/workspaces/directory", { path: "/work", page: 1 })).status).toBe(200);
    expect((await post("/v1/workspaces/select-browsable", { path: "/work" })).status).toBe(200);
    expect((await post("/v1/conversations", { model: "gpt-5.6-sol", reasoningEffort: "medium" })).status).toBe(200);
    expect((await post("/v1/conversations/select", { id: "thread" })).status).toBe(200);
    expect((await post("/v1/tasks", { prompt: "hello" })).status).toBe(200);
    expect((await post("/v1/approvals/approval-1/approve")).status).toBe(200);
    expect((await post("/v1/approvals/approval-2/deny")).status).toBe(200);
    expect((await post("/v1/tasks/stop")).status).toBe(200);
    expect((await post("/v1/history")).status).toBe(200);
    expect((await post("/v1/updates/check")).status).toBe(200);
    expect((await post("/v1/onboarding/telegram/bot", { token: testToken })).status).toBe(200);
    expect((await post("/v1/onboarding/telegram/discover", { token: testToken })).status).toBe(200);
    expect((await post("/v1/onboarding/telegram/configure", {
      token: testToken, userId: "42",
    })).status).toBe(200);
    expect((await post("/v1/raw-rpc", { method: "turn/start" })).status).toBe(404);
    expect(facade.calls).toEqual([
      "open:/work", "create:gpt-5.6-sol:medium", "select:thread", "task:hello",
      "approve:approval-1", "deny:approval-2", "stop",
    ]);
  });

  it("propagates canonical live-output events over authenticated SSE", async () => {
    const facade = fakeFacade(); const server = new UiBridgeServer(facade, "secret"); servers.push(server);
    const { endpoint } = await server.start();
    const response = await fetch(`${endpoint}/v1/events`, { headers: { authorization: "Bearer secret" } });
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("bridge.connected");
    facade.emit({ type: "liveOutput", event: { type: "assistant.delta", text: "First.\n\nSecond." } });
    expect(decoder.decode((await reader.read()).value)).toContain("First.\\n\\nSecond.");
    await reader.cancel();
  });
});
