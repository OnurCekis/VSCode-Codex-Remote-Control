import { readFile, rename, writeFile } from "node:fs/promises";

const TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/u;
const USER_ID = /^[1-9]\d*$/u;

interface TelegramEnvelope {
  ok?: boolean;
  result?: unknown;
  description?: string;
}

export interface TelegramSetupResult {
  botUsername: string;
  userId: number;
  delivered: true;
}

export async function telegramBotIdentity(token: string, fetcher: typeof fetch = fetch): Promise<{
  botUsername: string;
  botUrl: string;
}> {
  const identity = await telegramCall(token, "getMe", undefined, fetcher);
  const bot = identity.result as { username?: unknown } | undefined;
  if (!bot || typeof bot.username !== "string" || !bot.username) throw new Error("Telegram bot identity is invalid.");
  return { botUsername: bot.username, botUrl: `https://t.me/${bot.username}` };
}

function validUserId(raw: string): number {
  if (!USER_ID.test(raw)) throw new Error("Telegram user ID must be a positive number.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("Telegram user ID is outside the supported range.");
  return value;
}

function validToken(token: string): void {
  if (!TOKEN.test(token)) throw new Error("BotFather token format is invalid.");
}

async function telegramCall(
  token: string,
  method: string,
  body: Record<string, unknown> | undefined,
  fetcher: typeof fetch,
): Promise<TelegramEnvelope> {
  validToken(token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const options: RequestInit = {
      method: body ? "POST" : "GET",
      signal: controller.signal,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    };
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, options);
    const envelope = await response.json() as TelegramEnvelope;
    if (!response.ok || envelope.ok !== true) {
      throw new Error(`Telegram rejected ${method}: ${(envelope.description ?? "request failed").slice(0, 160)}`);
    }
    return envelope;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Telegram rejected")) throw error;
    throw new Error(`Telegram ${method} connection failed.`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverTelegramIdentity(token: string, fetcher: typeof fetch = fetch): Promise<{
  userId: number;
  displayName: string;
}> {
  const envelope = await telegramCall(token, "getUpdates", undefined, fetcher);
  const updates = Array.isArray(envelope.result) ? envelope.result : [];
  for (const update of updates.toReversed()) {
    if (!update || typeof update !== "object") continue;
    const message = (update as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const value = message as { chat?: unknown; from?: unknown };
    const chat = value.chat as { id?: unknown; type?: unknown } | undefined;
    const from = value.from as { id?: unknown; first_name?: unknown; username?: unknown } | undefined;
    if (chat?.type !== "private" || typeof chat.id !== "number" || from?.id !== chat.id || !Number.isSafeInteger(chat.id)) continue;
    const name = typeof from.username === "string" ? `@${from.username}` :
      typeof from.first_name === "string" ? from.first_name : "Telegram user";
    return { userId: chat.id, displayName: name.slice(0, 120) };
  }
  throw new Error("No private message was found. Send /start to your bot, then try again.");
}

export async function testTelegramSetup(
  token: string,
  rawUserId: string,
  fetcher: typeof fetch = fetch,
): Promise<TelegramSetupResult> {
  const userId = validUserId(rawUserId);
  const bot = await telegramBotIdentity(token, fetcher);
  await telegramCall(token, "sendMessage", {
    chat_id: userId,
    text: "Codex Pocket bağlantı testi başarılı. Bu bot artık yalnızca doğrulanan Telegram hesabınızla kullanılacak.",
  }, fetcher);
  return { botUsername: bot.botUsername, userId, delivered: true };
}

export async function persistTelegramSetup(envFile: string, token: string, userId: number): Promise<void> {
  validToken(token);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Telegram user ID is invalid.");
  const existing = await readFile(envFile, "utf8").catch(() => "");
  const lines = existing.split(/\r?\n/u).filter((line) => line &&
    !/^\s*TELEGRAM_BOT_TOKEN\s*=/u.test(line) && !/^\s*TELEGRAM_ALLOWED_USER_ID\s*=/u.test(line));
  lines.push(`TELEGRAM_BOT_TOKEN=${token}`, `TELEGRAM_ALLOWED_USER_ID=${userId}`);
  const temporary = `${envFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, envFile);
}

export async function telegramConfigurationPresent(envFile: string): Promise<boolean> {
  const existing = await readFile(envFile, "utf8").catch(() => "");
  const token = existing.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*([^\s#]+)\s*$/mu)?.[1] ?? "";
  const user = existing.match(/^\s*TELEGRAM_ALLOWED_USER_ID\s*=\s*([^\s#]+)\s*$/mu)?.[1] ?? "";
  try { validToken(token); validUserId(user); return true; } catch { return false; }
}
