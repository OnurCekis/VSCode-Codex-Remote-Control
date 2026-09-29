import type { Bot, Context } from "grammy";
import type { TelegramPort } from "./telegram-port.js";

export class GrammyTelegramPort implements TelegramPort {
  readonly #bot: Bot<Context>;

  constructor(bot: Bot<Context>) {
    this.#bot = bot;
  }

  async sendMessage(chatId: number, text: string, buttons?: Parameters<TelegramPort["sendMessage"]>[2]): Promise<{ messageId: number }> {
    const message = await this.#bot.api.sendMessage(chatId, text, buttons ? {
      reply_markup: {
        inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))),
      },
    } : undefined);
    return { messageId: message.message_id };
  }

  async editMessage(chatId: number, messageId: number, text: string, buttons?: Parameters<TelegramPort["editMessage"]>[3]): Promise<void> {
    await this.#bot.api.editMessageText(chatId, messageId, text, {
      reply_markup: {
        inline_keyboard: buttons?.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) ?? [],
      },
    });
  }

  async answerCallback(callbackId: string, text: string, showAlert = false): Promise<void> {
    await this.#bot.api.answerCallbackQuery(callbackId, { text, show_alert: showAlert });
  }
}
