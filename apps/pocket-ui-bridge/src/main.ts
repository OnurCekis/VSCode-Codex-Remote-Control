import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { connectPocketClient } from "../../../packages/pocket-runtime/src/pocket-client.js";
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";
import { MobilePairingService } from "../../../packages/pocket-runtime/src/mobile-pairing.js";
import { loadOrCreateDesktopMobileIdentity } from "../../../packages/pocket-runtime/src/mobile-identity.js";
import { UiBridgeServer, type UiBridgeFacade } from "./ui-bridge-server.js";
import { removeBridgeDescriptors, writeBridgeDescriptors } from "./bridge-descriptor.js";
import { MobileGateway } from "./mobile-gateway.js";
import {
  discoverTelegramIdentity,
  persistTelegramSetup,
  telegramConfigurationPresent,
  telegramBotIdentity,
  testTelegramSetup,
} from "./telegram-setup.js";

const repoRoot = path.resolve(process.env.CODEX_POCKET_ROOT ?? ".");
const runRoot = path.join(repoRoot, ".codex-pocket", "ui-bridge");
const connection = await readConnectionFile(path.join(repoRoot, ".codex-pocket", "phase-1", "connection.json"));
const client = await connectPocketClient({
  connection, clientName: "codex_pocket_flutter_bridge",
  logPath: path.join(runRoot, `protocol-${Date.now()}.jsonl`),
  workspaceStateFile: path.join(repoRoot, ".codex-pocket", "workspace-state.json"),
});
const mobilePairing = new MobilePairingService(path.join(repoRoot, ".codex-pocket", "pairing", "mobile-state.json"));
const listeners = new Set<(event: unknown) => void>();
let mobileGateway: MobileGateway | null = null;
const emit = (event: unknown): void => { for (const listener of listeners) listener(event); void mobileGateway?.sendEvent(event); mobileGateway?.notifyForEvent(event); };
const subscriptions = [
  client.core.liveOutput.subscribe((event) => emit({ type: "liveOutput", event })),
  client.core.adapter.subscribe((event) => emit({ type: "core", event })),
];

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; } catch { return null; }
}

const facade: UiBridgeFacade = {
  state: async () => {
    const sessions = await client.core.conversations.list("workspace");
    const models = await client.core.models();
    const selected = client.core.sessions.selected;
    const preview = selected ? await client.core.sessions.preview(selected.id).catch(() => null) : null;
    const host = await readJson(path.join(repoRoot, ".codex-pocket", "phase-1", "host-status.json"));
    const bot = await readJson(path.join(repoRoot, ".codex-pocket", "phase-2", "bot-status.json"));
    return {
      pocket: host?.state === "ready" ? "ready" : "disconnected",
      codex: host ? { state: host.state, version: host.extensionVersion, cliVersion: host.codexCliVersion, topology: host.topology } : null,
      telegram: bot ? { state: bot.state, connectedToHost: bot.hostOwnerPid === host?.ownerPid } : { state: "disconnected" },
      onboarding: { telegramConfigured: await telegramConfigurationPresent(path.join(repoRoot, ".env")), runtimeReady: true },
      profile: host?.profileSync ?? null,
      pairing: await mobilePairing.status(),
      browser: { state: "unavailable", reason: "Phase 3 Gate 2 requires real Windows acceptance." },
      workspaces: client.core.workspaces.state,
      runtimes: client.core.runtimes ? await client.core.runtimes.listRuntimes() : [],
      conversations: sessions,
      models,
      selectedConversationId: selected?.id ?? null,
      preview,
      approvals: client.core.approvals.pending(selected?.id),
    };
  },
  openWorkspace: async (workspacePath) => {
    const workspace = await client.core.workspaces.validate(workspacePath);
    const runtime = await client.core.runtimes?.openWorkspace(workspace.path);
    await client.core.workspaces.activate(workspace);
    emit({ type: "state.changed" }); return { workspace, runtime };
  },
  workspaceRoots: async () => ({ roots: await client.core.workspaces.listRoots() }),
  workspaceDirectory: async (workspacePath, page) => await client.core.workspaces.listDirectory(workspacePath, page),
  selectBrowsableWorkspace: async (workspacePath) => {
    const workspace = await client.core.workspaces.selectBrowsable(workspacePath);
    const runtime = await client.core.runtimes?.openWorkspace(workspace.path);
    emit({ type: "state.changed" }); return { workspace, runtime };
  },
  createConversation: async (model, reasoningEffort) => {
    const session = await client.core.conversations.create({ model, reasoningEffort });
    emit({ type: "state.changed" }); return { session };
  },
  selectConversation: async (id, switchWorkspace) => {
    const session = await client.core.conversations.select(id, { switchWorkspace });
    emit({ type: "state.changed" }); return { session };
  },
  sendTask: async (prompt) => ({ turnId: await client.core.tasks.send(prompt) }),
  stopTask: async () => ({ turnId: await client.core.tasks.stop() }),
  decideApproval: async (id, decision) => { decision === "approve" ? client.core.approvals.approve(id) : client.core.approvals.deny(id); return { id, decision }; },
  history: async () => {
    const selected = client.core.sessions.selected;
    if (!selected) throw new Error("Select a conversation first.");
    const preview = await client.core.sessions.preview(selected.id, 1);
    const lastUser = preview.messages.findLastIndex((message) => message.role === "user");
    return { task: lastUser >= 0 ? preview.messages[lastUser]!.text : null,
      output: (lastUser >= 0 ? preview.messages.slice(lastUser + 1) : preview.messages)
        .filter((message) => message.role === "assistant").map((message) => message.text).join("\n\n") };
  },
  checkUpdates: async () => {
    if (!client.core.runtimes) throw new Error("Update checks are unavailable.");
    return await client.core.runtimes.checkForUpdates();
  },
  startPairing: async () => {
    if (!mobileGateway) throw new Error("Pocket Relay is not configured for this build.");
    return await mobileGateway.startPairing();
  },
  pairingStatus: async () => await mobilePairing.status(),
  revokePairing: async () => { await mobilePairing.revoke(); return { state: "unpaired" }; },
  telegramBot: async (token) => await telegramBotIdentity(token),
  discoverTelegram: async (token) => await discoverTelegramIdentity(token),
  configureTelegram: async (token, userId) => {
    const tested = await testTelegramSetup(token, userId);
    await persistTelegramSetup(path.join(repoRoot, ".env"), token, tested.userId);
    return { configured: true, restartRequired: true, botUsername: tested.botUsername, userId: tested.userId, delivered: true };
  },
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
};

const relayUrl = process.env.CODEX_POCKET_RELAY_URL;
if (relayUrl) {
  const identity = await loadOrCreateDesktopMobileIdentity(path.join(repoRoot, ".codex-pocket", "pairing", "desktop-identity.json"));
  const botUsername = async (): Promise<string> => {
    const bot = await readJson(path.join(repoRoot, ".codex-pocket", "phase-2", "bot-status.json"));
    if (typeof bot?.botUsername !== "string") throw new Error("Telegram bot identity is not ready.");
    return bot.botUsername;
  };
  const allowed = new Set(["state", "workspaceRoots", "workspaceDirectory", "selectBrowsableWorkspace", "openWorkspace", "createConversation", "selectConversation", "sendTask", "stopTask", "decideApproval", "history", "checkUpdates", "registerPush"]);
  mobileGateway = new MobileGateway({ relayUrl, identity, pairing: mobilePairing, botUsername, handle: async (request) => {
    if (!allowed.has(request.method)) throw new Error("Unsupported mobile operation.");
    const params = request.params ?? {};
    if (request.method === "state") return await facade.state();
    if (request.method === "workspaceRoots") return await facade.workspaceRoots();
    if (request.method === "workspaceDirectory" && typeof params.path === "string") return await facade.workspaceDirectory(params.path, typeof params.page === "number" ? params.page : 0);
    if (request.method === "selectBrowsableWorkspace" && typeof params.path === "string") return await facade.selectBrowsableWorkspace(params.path);
    if (request.method === "openWorkspace" && typeof params.path === "string") return await facade.openWorkspace(params.path);
    if (request.method === "createConversation" && typeof params.model === "string" && typeof params.reasoningEffort === "string") return await facade.createConversation(params.model, params.reasoningEffort);
    if (request.method === "selectConversation" && typeof params.id === "string") return await facade.selectConversation(params.id, params.switchWorkspace === true);
    if (request.method === "sendTask" && typeof params.prompt === "string") return await facade.sendTask(params.prompt);
    if (request.method === "stopTask") return await facade.stopTask();
    if (request.method === "decideApproval" && typeof params.id === "string" && (params.decision === "approve" || params.decision === "deny")) return await facade.decideApproval(params.id, params.decision);
    if (request.method === "history") return await facade.history();
    if (request.method === "checkUpdates") return await facade.checkUpdates();
    if (request.method === "registerPush" && typeof params.token === "string") { mobileGateway?.registerPush(params.token); return { registered: true }; }
    throw new Error("Invalid mobile operation parameters.");
  } });
  void mobileGateway.connect().catch(() => undefined);
}

const server = new UiBridgeServer(facade);
const started = await server.start();
const descriptors = await writeBridgeDescriptors(repoRoot, {
  version: 1, endpoint: started.endpoint, token: server.token, ownerPid: process.pid,
});
process.stdout.write(`Pocket UI bridge READY on 127.0.0.1:${started.port}.\n`);
let closing = false;
const close = async (): Promise<void> => {
  if (closing) return; closing = true;
  subscriptions.forEach((unsubscribe) => unsubscribe());
  mobileGateway?.close();
  await server.close(); await client.close(); await removeBridgeDescriptors(descriptors);
};
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
