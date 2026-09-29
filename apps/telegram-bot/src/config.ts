import path from "node:path";
import { z } from "zod";

export interface TelegramConfig {
  botToken: string;
  allowedUserId: number;
  connectionFile: string;
  cwd?: string;
  extraWorkspaceRoots: string[];
}

const tokenSchema = z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/u, "TELEGRAM_BOT_TOKEN is not a valid bot token shape.");

export function loadTelegramConfig(environment: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = tokenSchema.parse(environment.TELEGRAM_BOT_TOKEN);
  const rawUserId = environment.TELEGRAM_ALLOWED_USER_ID;
  if (!rawUserId || !/^[1-9]\d*$/u.test(rawUserId)) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be a positive numeric Telegram user ID.");
  }
  const allowedUserId = Number(rawUserId);
  if (!Number.isSafeInteger(allowedUserId)) throw new Error("TELEGRAM_ALLOWED_USER_ID exceeds the safe integer range.");
  const cwd = environment.CODEX_POCKET_CWD?.trim();
  const extraWorkspaceRoots = (environment.CODEX_POCKET_EXTRA_WORKSPACE_ROOTS ?? "")
    .split(";").map((value) => value.trim()).filter(Boolean);
  for (const root of extraWorkspaceRoots) {
    if (!path.win32.isAbsolute(root) || root.startsWith("\\\\")) {
      throw new Error("CODEX_POCKET_EXTRA_WORKSPACE_ROOTS accepts only absolute local Windows paths separated by semicolons.");
    }
  }
  return {
    botToken: token,
    allowedUserId,
    connectionFile: path.resolve(environment.CODEX_POCKET_CONNECTION_FILE ?? ".codex-pocket/phase-1/connection.json"),
    extraWorkspaceRoots: [...new Set(extraWorkspaceRoots.map((root) => path.win32.normalize(root)))],
    ...(cwd ? { cwd: path.resolve(cwd) } : {}),
  };
}
