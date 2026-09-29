import { Bot } from "grammy";
import type { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";
import { GrammyTelegramPort } from "./grammy-port.js";
import { TelegramController } from "./telegram-controller.js";
import type { TelegramAuditEvent } from "./telegram-controller.js";

export function createTelegramBot(options: {
  token: string;
  allowedUserId: number;
  core: PocketCore;
  cwd?: string;
  onError?: (error: Error) => void;
  onAudit?: (event: TelegramAuditEvent) => void;
  secrets?: readonly string[];
  pairing?: {
    complete(code: string, identity: { userId: number; chatId: number; privateChat: boolean }): Promise<boolean>;
    onPaired(userId: number): Promise<void>;
  };
}): { bot: Bot; controller: TelegramController } {
  const bot = new Bot(options.token);
  const controller = new TelegramController({
    core: options.core,
    port: new GrammyTelegramPort(bot),
    allowedUserId: options.allowedUserId,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });

  bot.on("message:text", async (context) => {
    const pairing = context.message.text.match(/^(?:\/pair(?:@[A-Za-z0-9_]+)?\s+|\/start(?:@[A-Za-z0-9_]+)?\s+p_)([A-Fa-f0-9]{8})\s*$/u);
    if (pairing && options.pairing) {
      const userId = context.from?.id;
      const privateChat = context.chat.type === "private";
      const paired = userId !== undefined && await options.pairing.complete(pairing[1]!, {
        userId, chatId: context.chat.id, privateChat,
      });
      if (paired && userId !== undefined) {
        controller.setAllowedUserId(userId);
        await options.pairing.onPaired(userId);
        await context.reply("Codex Pocket eşleştirildi. Masaüstü uygulamasında bağlantıyı yenileyin.");
      } else {
        await context.reply("Eşleştirme kodu geçersiz, kullanılmış veya süresi dolmuş.");
      }
      return;
    }
    await controller.handle({
      type: "message",
      userId: context.from?.id,
      chatId: context.chat.id,
      text: context.message.text,
    });
  });
  bot.on("callback_query:data", async (context) => {
    await controller.handle({
      type: "callback",
      userId: context.from.id,
      chatId: context.chat?.id ?? context.from.id,
      callbackId: context.callbackQuery.id,
      data: context.callbackQuery.data,
      ...(context.callbackQuery.message ? { messageId: context.callbackQuery.message.message_id } : {}),
    });
  });
  return { bot, controller };
}
