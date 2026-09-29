export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface SentTelegramMessage {
  messageId: number;
}

export interface TelegramPort {
  sendMessage(chatId: number, text: string, buttons?: InlineButton[][]): Promise<SentTelegramMessage>;
  editMessage(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<void>;
  answerCallback(callbackId: string, text: string, showAlert?: boolean): Promise<void>;
}

export type TelegramUpdate =
  | { type: "message"; userId: number | undefined; chatId: number; text: string }
  | { type: "callback"; userId: number | undefined; chatId: number; callbackId: string; data: string; messageId?: number };
