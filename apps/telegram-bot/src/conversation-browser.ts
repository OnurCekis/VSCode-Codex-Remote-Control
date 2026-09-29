import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ConversationPreview } from "../../../packages/codex-core/src/domain-events.js";
import type { ManagedSession } from "../../../packages/codex-core/src/session-manager.js";
import type { InlineButton } from "./telegram-port.js";

export const CHAT_PAGE_SIZE = 5;
export const TELEGRAM_TEXT_LIMIT = 4_000;
export type ConversationScope = "workspace" | "all";

export type ConversationAction =
  | { type: "open"; threadId: string; page: number; scope: ConversationScope }
  | { type: "use" | "switchUse"; threadId: string; page: number; scope: ConversationScope }
  | { type: "page"; page: number; scope: ConversationScope };

interface CallbackEntry { action: ConversationAction; userId: number; chatId: number; expiresAt: number }

export class ConversationCallbackRegistry {
  readonly #entries = new Map<string, CallbackEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #handle: () => string;

  constructor(options: { ttlMs?: number; now?: () => number; handle?: () => string } = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#handle = options.handle ?? (() => randomBytes(9).toString("base64url"));
  }

  create(action: ConversationAction, userId: number, chatId: number): string {
    this.#purge();
    let handle: string;
    do handle = this.#handle(); while (this.#entries.has(handle));
    this.#entries.set(handle, { action, userId, chatId, expiresAt: this.#now() + this.#ttlMs });
    return `chat:${handle}`;
  }

  consume(data: string, userId: number, chatId: number): ConversationAction | null {
    if (!/^chat:[A-Za-z0-9_-]{4,48}$/u.test(data)) return null;
    const handle = data.slice(5);
    const entry = this.#entries.get(handle);
    if (!entry || entry.userId !== userId || entry.chatId !== chatId || entry.expiresAt <= this.#now()) {
      if (entry && entry.expiresAt <= this.#now()) this.#entries.delete(handle);
      return null;
    }
    this.#entries.delete(handle);
    return entry.action;
  }

  #purge(): void {
    const now = this.#now();
    for (const [handle, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(handle);
  }
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp * 1_000);
  const now = new Date();
  const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const nowKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (dateKey === nowKey) return `Today ${time}`;
  if (dateKey === yesterdayKey) return `Yesterday ${time}`;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function status(session: ManagedSession): string {
  return session.status.type === "active"
    ? `active${session.status.activeFlags.length ? `:${session.status.activeFlags.join(",")}` : ""}`
    : session.status.type;
}

function topology(session: ManagedSession): string {
  if (session.topology === "sharedLive") return "live on Pocket shared server";
  if (session.topology === "foreignActive") return "history only; foreign active owner";
  return "historical";
}

function short(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

export function renderConversationPage(options: {
  sessions: ManagedSession[];
  page: number;
  scope?: ConversationScope;
  workspaceName?: string;
  callback: (action: ConversationAction) => string;
}): { text: string; buttons: InlineButton[][]; page: number; pages: number } {
  const scope = options.scope ?? "all";
  const heading = scope === "workspace" && options.workspaceName ? options.workspaceName : "All conversations";
  const sorted = [...options.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const pages = Math.max(1, Math.ceil(sorted.length / CHAT_PAGE_SIZE));
  const page = Math.max(0, Math.min(options.page, pages - 1));
  const visible = sorted.slice(page * CHAT_PAGE_SIZE, (page + 1) * CHAT_PAGE_SIZE);
  const buttons: InlineButton[][] = [];
  if (!visible.length) {
    if (scope === "workspace") buttons.push([{
      text: "All conversations", callbackData: options.callback({ type: "page", page: 0, scope: "all" }),
    }]);
    return { text: `${heading}\n\nNo recent VS Code Codex conversations found.`, buttons, page, pages };
  }
  const lines = [heading, "", "Recent Codex conversations", ""];
  visible.forEach((session, index) => {
    lines.push(`${page * CHAT_PAGE_SIZE + index + 1}. ${short(session.title, 70)}`);
    lines.push(`   ${localDay(session.updatedAt)} · ${status(session)} · ${topology(session)}`, "");
    buttons.push([{
      text: short(session.title, 48), callbackData: options.callback({ type: "open", threadId: session.id, page, scope }),
    }]);
  });
  const navigation: InlineButton[] = [];
  if (page > 0) navigation.push({
    text: "‹ Previous", callbackData: options.callback({ type: "page", page: page - 1, scope }),
  });
  if (page + 1 < pages) navigation.push({
    text: "Next ›", callbackData: options.callback({ type: "page", page: page + 1, scope }),
  });
  if (navigation.length) buttons.push(navigation);
  if (scope === "workspace") buttons.push([{
    text: "All conversations", callbackData: options.callback({ type: "page", page: 0, scope: "all" }),
  }]);
  lines.push(`Page ${page + 1}/${pages}`);
  return { text: lines.join("\n").slice(0, TELEGRAM_TEXT_LIMIT), buttons, page, pages };
}

export function renderConversationPreview(options: {
  session: ManagedSession;
  preview: ConversationPreview | null;
  page: number;
  scope?: ConversationScope;
  relation?: "same" | "different" | "unselected";
  callback: (action: ConversationAction) => string;
}): { text: string; buttons: InlineButton[][] } {
  const { session, preview } = options;
  const scope = options.scope ?? "all";
  const relation = options.relation ?? "same";
  const lines = [
    short(session.title, 120), "", `Workspace: ${short(path.basename(session.cwd), 100)}`,
    `Status: ${status(session)}`, `Runtime: ${topology(session)}`,
    `Last activity: ${localDay(session.updatedAt)}`, "", "Recent conversation:", "",
  ];
  if (!preview) lines.push("History preview is unavailable without attaching this conversation.");
  else if (!preview.messages.length) lines.push("No user/assistant messages were returned by the App Server.");
  else {
    for (const message of preview.messages) {
      lines.push(message.role === "user" ? "You:" : "Codex:");
      lines.push(short(message.text, 520), "");
    }
    if (preview.hasOlder) lines.push("Older messages are available.");
  }
  if (relation === "different") lines.push("", "This conversation belongs to another workspace.");
  if (session.topology === "foreignActive") {
    lines.push("", "Pocket can read stored history, but the live writer belongs to another App Server and cannot be controlled safely.");
  }
  return {
    text: lines.join("\n").slice(0, TELEGRAM_TEXT_LIMIT),
    buttons: [
      [{
        text: relation === "different" ? "Switch workspace & use chat" :
          session.topology === "sharedLive" ? "Use live chat" :
            session.topology === "foreignActive" ? "Retry safe control" : "✓ Use this chat",
        callbackData: options.callback({
          type: relation === "different" ? "switchUse" : "use", threadId: session.id, page: options.page, scope,
        }),
      }],
      [{ text: "‹ Back", callbackData: options.callback({ type: "page", page: options.page, scope }) }],
    ],
  };
}
