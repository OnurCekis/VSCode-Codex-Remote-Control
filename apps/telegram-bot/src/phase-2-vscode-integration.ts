import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectPocketClient } from "../../../packages/pocket-runtime/src/pocket-client.js";
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";
import { TelegramController } from "./telegram-controller.js";
import type { InlineButton, TelegramPort } from "./telegram-port.js";

const allowedUserId = 424242;
const runRoot = path.resolve(".codex-pocket", "phase-2");
const statusPath = path.join(runRoot, "integration-status.json");
const continuePath = path.join(runRoot, "integration-continue");
const approveMarker = path.join(runRoot, "approve-marker.txt");
const denyMarker = path.join(runRoot, "deny-marker.txt");
const connectionPath = path.resolve(".codex-pocket", "phase-1", "connection.json");

class MemoryTelegramPort implements TelegramPort {
  readonly messages: Array<{ text: string; buttons?: InlineButton[][]; messageId: number }> = [];
  readonly edits: Array<{ messageId: number; text: string }> = [];
  readonly callbacks: Array<{ id: string; text: string; alert: boolean }> = [];
  async sendMessage(_chatId: number, text: string, buttons?: InlineButton[][]): Promise<{ messageId: number }> {
    const messageId = this.messages.length + 1;
    this.messages.push({ text, ...(buttons ? { buttons } : {}), messageId });
    return { messageId };
  }
  async editMessage(_chatId: number, messageId: number, text: string): Promise<void> { this.edits.push({ messageId, text }); }
  async answerCallback(id: string, text: string, alert = false): Promise<void> { this.callbacks.push({ id, text, alert }); }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

await Promise.all([
  access(connectionPath), mkdir(runRoot, { recursive: true }),
  rm(statusPath, { force: true }), rm(continuePath, { force: true }),
  rm(approveMarker, { force: true }), rm(denyMarker, { force: true }),
]);
const connection = await readConnectionFile(connectionPath);
const client = await connectPocketClient({
  connection,
  clientName: "codex_pocket_phase_2_mock_telegram",
  logPath: path.join(runRoot, "logs", `mock-telegram-protocol-${Date.now()}.jsonl`),
  workspaceStateFile: path.resolve(".codex-pocket", "phase-2", "integration-workspace-state.json"),
  defaultWorkspace: path.resolve(".codex-pocket", "phase-1", "workspace"),
});
const port = new MemoryTelegramPort();
const errors: string[] = [];
const controller = new TelegramController({
  core: client.core, port, allowedUserId,
  secrets: [connection.token],
  cwd: path.resolve(".codex-pocket", "phase-1", "workspace"),
  onError: (error) => errors.push(error.message),
});
const completed: Array<{ turnId: string; status: string }> = [];
const unsubscribe = client.core.adapter.subscribe((event) => {
  if (event.type === "task.completed") completed.push({ turnId: event.turnId, status: event.status });
});

let sessionId: string | null = null;
try {
  await controller.handle({ type: "message", userId: 999, chatId: 999, text: "unauthorized task" });
  const selectedAfterUnauthorized = client.core.sessions.selected;
  if (port.messages.length || selectedAfterUnauthorized) throw new Error("Unauthorized update changed Telegram or core state.");

  await controller.handle({ type: "message", userId: allowedUserId, chatId: allowedUserId, text: "/sessions" });
  const match = port.messages.at(-1)?.text.match(/\b(01[a-z0-9-]{30,})\b/iu);
  sessionId = match?.[1] ?? null;
  if (!sessionId) throw new Error("Telegram /sessions did not discover a VS Code session.");
  await controller.handle({ type: "message", userId: allowedUserId, chatId: allowedUserId, text: `/use ${sessionId}` });
  if (client.core.sessions.selected?.id !== sessionId) {
    throw new Error(`Telegram /use did not select the discovered session: ${port.messages.at(-1)?.text ?? "no Telegram response"}`);
  }

  let completionOffset = completed.length;
  await controller.handle({ type: "message", userId: allowedUserId, chatId: allowedUserId, text: "Reply exactly PHASE_2_TELEGRAM_TASK." });
  await waitFor(() => completed.slice(completionOffset).find((event) => event.status === "completed"), 180_000, "Telegram task completion");

  await writeFile(statusPath, `${JSON.stringify({
    phase: 2, gate: 4, state: "awaiting_vscode_approval_prompt", sessionId,
    vscodePrompt: "Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath '..\\..\\phase-2\\approve-marker.txt' -Value 'phase-2-approved'\"",
  }, null, 2)}\n`, "utf8");

  const approvalMessage = await waitFor(
    () => port.messages.find((message) => message.buttons?.flat().some((button) => button.callbackData.startsWith("approval:approve:"))),
    10 * 60_000,
    "real VS Code approval in Telegram adapter",
  );
  const approveData = approvalMessage.buttons?.[0]?.find((button) => button.text === "Approve")?.callbackData;
  if (!approveData || approveData.includes("powershell") || approveData.length > 64) throw new Error("Approval callback was not opaque and bounded.");
  completionOffset = completed.length;
  await controller.handle({ type: "callback", userId: allowedUserId, chatId: allowedUserId, callbackId: "approve", data: approveData });
  await waitFor(() => completed.slice(completionOffset).find((event) => event.status === "completed"), 180_000, "approved VS Code turn continuation");
  if ((await readFile(approveMarker, "utf8")).trim() !== "phase-2-approved") throw new Error("Telegram-approved marker was not created.");
  await controller.handle({ type: "callback", userId: allowedUserId, chatId: allowedUserId, callbackId: "duplicate", data: approveData });
  if (!port.callbacks.some((callback) => callback.id === "duplicate" && callback.alert && callback.text.includes("already resolved"))) {
    throw new Error("Duplicate approval callback was not rejected as stale.");
  }

  const approvalCount = port.messages.filter((message) => message.buttons).length;
  completionOffset = completed.length;
  await controller.handle({
    type: "message", userId: allowedUserId, chatId: allowedUserId,
    text: "Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath '..\\..\\phase-2\\deny-marker.txt' -Value 'must-not-exist'\"",
  });
  const denyMessage = await waitFor(
    () => port.messages.filter((message) => message.buttons)[approvalCount],
    180_000,
    "Telegram denial approval",
  );
  const denyData = denyMessage.buttons?.[0]?.find((button) => button.text === "Deny")?.callbackData;
  if (!denyData) throw new Error("Deny callback was missing.");
  await controller.handle({ type: "callback", userId: allowedUserId, chatId: allowedUserId, callbackId: "deny", data: denyData });
  await waitFor(() => completed.slice(completionOffset)[0], 180_000, "denied turn completion");
  try { await access(denyMarker); throw new Error("Denied marker unexpectedly exists."); } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
  }

  completionOffset = completed.length;
  await controller.handle({
    type: "message", userId: allowedUserId, chatId: allowedUserId,
    text: "Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"",
  });
  await waitFor(() => port.messages.findLast((message) => message.text.startsWith("Task started:")), 30_000, "Telegram task-start notification");
  await delay(2_000);
  await controller.handle({ type: "message", userId: allowedUserId, chatId: allowedUserId, text: "/stop" });
  await waitFor(() => completed.slice(completionOffset).find((event) => event.status === "interrupted"), 30_000, "Telegram interrupted completion");
  if (!port.messages.some((message) => message.text.includes("interrupted"))) throw new Error("Telegram did not report interrupted state.");
  if (errors.length) throw new Error(`Telegram controller errors: ${JSON.stringify(errors)}`);

  await writeFile(statusPath, `${JSON.stringify({
    phase: 2, gate: 12, state: "passed_awaiting_ui_check", sessionId,
    messages: port.messages.length, approvalEdits: port.edits.length, completed,
  }, null, 2)}\n`, "utf8");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try { await access(continuePath); break; } catch { await delay(250); }
  }
  await writeFile(statusPath, `${JSON.stringify({ phase: 2, state: "complete", sessionId }, null, 2)}\n`, "utf8");
} catch (error) {
  const failure = error instanceof Error ? error.message : String(error);
  await writeFile(statusPath, `${JSON.stringify({ phase: 2, state: "failed", sessionId, failure }, null, 2)}\n`, "utf8");
  throw error;
} finally {
  unsubscribe();
  controller.close();
  await client.close();
}
