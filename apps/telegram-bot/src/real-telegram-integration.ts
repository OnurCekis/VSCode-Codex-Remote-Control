import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectPocketClient } from "../../../packages/pocket-runtime/src/pocket-client.js";
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";
import { createTelegramBot } from "./bot.js";
import { loadTelegramConfig } from "./config.js";
import type { TelegramAuditEvent } from "./telegram-controller.js";

const config = loadTelegramConfig();
const runRoot = path.resolve(".codex-pocket", "phase-2");
const statusPath = path.join(runRoot, "real-telegram-status.json");
const stopPath = path.join(runRoot, "real-telegram-stop");
await Promise.all([mkdir(runRoot, { recursive: true }), rm(statusPath, { force: true }), rm(stopPath, { force: true })]);

const connection = await readConnectionFile(config.connectionFile);
const client = await connectPocketClient({
  connection,
  clientName: "codex_pocket_telegram_e2e",
  logPath: path.join(runRoot, "logs", `real-telegram-protocol-${Date.now()}.jsonl`),
  workspaceStateFile: path.resolve(".codex-pocket", "workspace-state.json"),
  extraWorkspaceBrowseRoots: config.extraWorkspaceRoots,
  ...(config.cwd ? { defaultWorkspace: config.cwd } : {}),
});
const audit: TelegramAuditEvent[] = [];
const completedStatuses: string[] = [];
const unsubscribe = client.core.adapter.subscribe((event) => {
  if (event.type === "task.completed") completedStatuses.push(event.status);
});
const { bot, controller } = createTelegramBot({
  token: config.botToken,
  allowedUserId: config.allowedUserId,
  core: client.core,
  secrets: [config.botToken, connection.token],
  ...(config.cwd ? { cwd: config.cwd } : {}),
  onAudit: (event) => audit.push(event),
  onError: (error) => { void writeFile(statusPath, `${JSON.stringify({ state: "failed", error: error.message }, null, 2)}\n`, "utf8"); },
});
bot.catch((error) => { void writeFile(statusPath, `${JSON.stringify({ state: "failed", error: error.error instanceof Error ? error.error.message : String(error.error) }, null, 2)}\n`, "utf8"); });

try {
  const polling = bot.start({
    drop_pending_updates: true,
    onStart: async (info) => {
      await writeFile(statusPath, `${JSON.stringify({
        state: "awaiting_phone_gates",
        bot: `@${info.username}`,
        instructions: [
          "Send /workspaces and select the controlled Pocket-owned VS Code workspace.",
          "Send /chats, open the loaded conversation, and tap Join live chat.",
          "Send a normal task and verify it in the same visible VS Code conversation.",
          "Trigger a VS Code-owned controlled approval, then tap Approve.",
          "Trigger another controlled approval and tap Deny.",
          "Start a controlled long turn, then send /stop.",
        ],
      }, null, 2)}\n`, "utf8");
    },
  });
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const types = new Set(audit.map((event) => event.type));
    const decisions = audit.filter((event): event is Extract<TelegramAuditEvent, { type: "approval.decided" }> => event.type === "approval.decided");
    const liveJoin = audit.some((event) => event.type === "session.selected" && event.topology === "sharedLive");
    const passed = types.has("session.selected") && types.has("task.submitted") &&
      liveJoin &&
      types.has("approval.presented") && decisions.some((event) => event.decision === "approve") &&
      decisions.some((event) => event.decision === "deny") && types.has("task.stopRequested") &&
      completedStatuses.includes("completed") && completedStatuses.includes("interrupted");
    if (passed) {
      await writeFile(statusPath, `${JSON.stringify({ state: "passed", audit, completedStatuses }, null, 2)}\n`, "utf8");
      bot.stop();
      break;
    }
    try { await access(stopPath); bot.stop(); break; } catch { await delay(500); }
  }
  if (bot.isRunning()) bot.stop();
  await polling;
} finally {
  unsubscribe();
  controller.close();
  await client.close();
  await rm(stopPath, { force: true });
}
