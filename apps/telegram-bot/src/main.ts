import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { connectPocketClient } from "../../../packages/pocket-runtime/src/pocket-client.js";
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";
import { PairingService } from "../../../packages/pocket-runtime/src/pairing-service.js";
import { MobilePairingService } from "../../../packages/pocket-runtime/src/mobile-pairing.js";
import { createTelegramBot } from "./bot.js";
import { loadTelegramConfig } from "./config.js";

const config = loadTelegramConfig();
const runRoot = path.resolve(".codex-pocket", "phase-2");
const statusPath = path.join(runRoot, "bot-status.json");
const stopPath = path.join(runRoot, "bot-stop");
const pairing = new PairingService(path.resolve(".codex-pocket", "pairing", "state.json"));
const mobilePairing = new MobilePairingService(path.resolve(".codex-pocket", "pairing", "mobile-state.json"));

async function persistPairedUser(userId: number): Promise<void> {
  const envPath = path.resolve(".env");
  const existing = await readFile(envPath, "utf8");
  const lines = existing.split(/\r?\n/u).filter((line) => line && !/^\s*TELEGRAM_ALLOWED_USER_ID\s*=/u.test(line));
  lines.push(`TELEGRAM_ALLOWED_USER_ID=${userId}`);
  const temporary = `${envPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, envPath);
}

await mkdir(runRoot, { recursive: true });
try {
  const existing = JSON.parse(await readFile(statusPath, "utf8")) as { state?: string; ownerPid?: number };
  if (existing.state === "ready" && existing.ownerPid && existing.ownerPid !== process.pid) {
    try {
      process.kill(existing.ownerPid, 0);
      throw new Error("Codex Pocket Telegram bot is already running.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("already running")) throw error;
    }
  }
} catch (error) {
  if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
await Promise.all([rm(statusPath, { force: true }), rm(stopPath, { force: true })]);
const connection = await readConnectionFile(config.connectionFile);
const client = await connectPocketClient({
  connection,
  clientName: "codex_pocket_telegram",
  logPath: path.resolve(".codex-pocket", "phase-2", "logs", `telegram-protocol-${Date.now()}.jsonl`),
  workspaceStateFile: path.resolve(".codex-pocket", "workspace-state.json"),
  extraWorkspaceBrowseRoots: config.extraWorkspaceRoots,
  ...(config.cwd ? { defaultWorkspace: config.cwd } : {}),
});
const { bot, controller } = createTelegramBot({
  token: config.botToken,
  allowedUserId: config.allowedUserId,
  core: client.core,
  secrets: [config.botToken, connection.token],
  pairing: { complete: async (code, identity) =>
    await pairing.complete(code, identity) ||
      (identity.userId === config.allowedUserId && await mobilePairing.completeTelegram(code, identity)), onPaired: persistPairedUser },
  ...(config.cwd ? { cwd: config.cwd } : {}),
  onError: (error) => process.stderr.write(`[telegram] ${error.message}\n`),
});
bot.catch((error) => process.stderr.write(`[telegram] update failed: ${error.error instanceof Error ? error.error.message : String(error.error)}\n`));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  bot.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const stopWatcher = (async (): Promise<void> => {
  while (!stopping) {
    try { await access(stopPath); stop(); return; } catch { await delay(250); }
  }
})();
let updateNotificationWatcher: Promise<void> | null = null;

function startUpdateNotificationWatcher(): Promise<void> {
  return (async () => {
    const hostStatusPath = path.resolve(".codex-pocket", "phase-1", "host-status.json");
    let previous: string | null = null;
    while (!stopping) {
      try {
        const host = JSON.parse(await readFile(hostStatusPath, "utf8")) as {
          update?: { state?: string; currentVersion?: string; rollbackSucceeded?: boolean };
        };
        const update = host.update;
        const state = update?.state ?? null;
        if ((previous === "restarting" || previous === "rollingBack") && state === "ready") {
          await bot.api.sendMessage(config.allowedUserId, `Pocket başarıyla güncellendi.\nKurulu Codex uzantısı: ${update?.currentVersion ?? "doğrulandı"}`);
        } else if ((previous === "restarting" || previous === "rollingBack") && state === "failed") {
          await bot.api.sendMessage(config.allowedUserId, update?.rollbackSucceeded
            ? "Pocket güncellemesi başarısız oldu; önceki bilinen iyi sürüm geri yüklendi."
            : "Pocket güncellemesi ve rollback doğrulaması başarısız oldu; elle kurtarma gerekiyor.");
        }
        previous = state;
      } catch { /* host status is atomically replaced during restart */ }
      await delay(500);
    }
  })();
}

try {
  await bot.start({
    drop_pending_updates: true,
    onStart: async (info) => {
      await writeFile(statusPath, `${JSON.stringify({
        state: "ready", ownerPid: process.pid, hostOwnerPid: connection.ownerPid, botUsername: info.username,
      })}\n`, "utf8");
      updateNotificationWatcher = startUpdateNotificationWatcher();
      process.stdout.write(`Codex Pocket Telegram bot @${info.username} started with long polling.\n`);
    },
  });
} finally {
  stopping = true;
  await stopWatcher;
  await updateNotificationWatcher;
  controller.close();
  await client.close();
  await Promise.all([rm(statusPath, { force: true }), rm(stopPath, { force: true })]);
}
