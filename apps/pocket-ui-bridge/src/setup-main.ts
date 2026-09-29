import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { removeBridgeDescriptors, writeBridgeDescriptors } from "./bridge-descriptor.js";
import {
  discoverTelegramIdentity,
  persistTelegramSetup,
  telegramConfigurationPresent,
  telegramBotIdentity,
  testTelegramSetup,
} from "./telegram-setup.js";
import { UiBridgeServer, type UiBridgeFacade } from "./ui-bridge-server.js";

const repoRoot = path.resolve(process.env.CODEX_POCKET_ROOT ?? ".");
const envFile = path.join(repoRoot, ".env");
const unavailable = async (): Promise<never> => { throw new Error("Complete setup, then start the Pocket host and full UI bridge."); };
async function desktopStatus(): Promise<unknown> {
  try { return JSON.parse(await readFile(path.join(repoRoot, "..", "desktop-runtime-status.json"), "utf8")); }
  catch { return { state: "setup", detail: "Waiting for verified Telegram configuration." }; }
}

const facade: UiBridgeFacade = {
  state: async () => ({
    pocket: "setupRequired",
    telegram: { state: "disconnected" },
    onboarding: { telegramConfigured: await telegramConfigurationPresent(envFile), runtimeReady: false },
    desktop: await desktopStatus(),
    browser: { state: "unavailable", reason: "Pocket runtime is not started." },
    workspaces: { activeWorkspace: null, recentWorkspaces: [] },
    conversations: [], approvals: [],
  }),
  openWorkspace: unavailable,
  workspaceRoots: unavailable,
  workspaceDirectory: unavailable,
  selectBrowsableWorkspace: unavailable,
  createConversation: unavailable,
  selectConversation: unavailable,
  sendTask: unavailable,
  stopTask: unavailable,
  decideApproval: unavailable,
  history: unavailable,
  checkUpdates: unavailable,
  startPairing: unavailable,
  pairingStatus: async () => ({ state: "unpaired" }),
  revokePairing: async () => ({ state: "unpaired" }),
  telegramBot: async (token) => await telegramBotIdentity(token),
  discoverTelegram: async (token) => await discoverTelegramIdentity(token),
  configureTelegram: async (token, userId) => {
    const tested = await testTelegramSetup(token, userId);
    await persistTelegramSetup(envFile, token, tested.userId);
    return { configured: true, restartRequired: true, botUsername: tested.botUsername, userId: tested.userId, delivered: true };
  },
  subscribe: () => () => undefined,
};

const server = new UiBridgeServer(facade);
const started = await server.start();
const descriptors = await writeBridgeDescriptors(repoRoot, {
  version: 1, endpoint: started.endpoint, token: server.token, ownerPid: process.pid, setupOnly: true,
});
process.stdout.write("Codex Pocket setup bridge READY. No Pocket runtime or Telegram bot has been started.\n");
let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await server.close();
  await removeBridgeDescriptors(descriptors);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
