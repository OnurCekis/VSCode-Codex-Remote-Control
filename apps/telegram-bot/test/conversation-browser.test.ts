import { describe, expect, it } from "vitest";
import type { ManagedSession } from "../../../packages/codex-core/src/session-manager.js";
import {
  ConversationCallbackRegistry,
  renderConversationPage,
  renderConversationPreview,
  TELEGRAM_TEXT_LIMIT,
} from "../src/conversation-browser.js";

function session(index: number): ManagedSession {
  return {
    id: `01private-thread-${index}`,
    cwd: `C:\\projects\\project-${index}`,
    title: `Human conversation ${index}`,
    preview: "preview",
    updatedAt: index,
    loaded: false,
    topology: "historical",
    canAcceptDirectInput: null,
    status: { type: "notLoaded" },
    turns: [],
    activeTurnId: null,
  };
}

describe("Telegram conversation browser", () => {
  it("renders five human-readable entries per page without exposing thread IDs", () => {
    let sequence = 0;
    const result = renderConversationPage({
      sessions: Array.from({ length: 7 }, (_, index) => session(index + 1)),
      page: 0,
      callback: () => `chat:opaque_${++sequence}`,
    });
    expect(result.page).toBe(0);
    expect(result.pages).toBe(2);
    expect(result.text).toContain("Human conversation 7");
    expect(result.text).not.toContain("Human conversation 2");
    expect(result.text).not.toContain("01private-thread");
    expect(result.buttons.flat()).toHaveLength(6);
    expect(result.buttons.flat().every((button) => button.callbackData.startsWith("chat:opaque_"))).toBe(true);

    const second = renderConversationPage({
      sessions: Array.from({ length: 7 }, (_, index) => session(index + 1)),
      page: 1,
      callback: () => `chat:opaque_${++sequence}`,
    });
    expect(second.text).toContain("Human conversation 2");
    expect(second.text).toContain("Human conversation 1");
    expect(second.text).not.toContain("Human conversation 7");
    expect(second.text).toContain("Page 2/2");
  });

  it("renders an explicit empty state", () => {
    const result = renderConversationPage({ sessions: [], page: 0, callback: () => "unused" });
    expect(result).toMatchObject({ text: "All conversations\n\nNo recent VS Code Codex conversations found.", buttons: [] });
  });

  it("bounds long preview output to Telegram's text limit", () => {
    const result = renderConversationPreview({
      session: session(1),
      preview: {
        sessionId: session(1).id,
        messages: Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 ? "assistant" as const : "user" as const,
          text: "x".repeat(2_000),
        })),
        recentTurnCount: 6,
        hasOlder: true,
      },
      page: 0,
      callback: () => "chat:opaque",
    });
    expect(result.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(result.text).not.toContain(session(1).id);
  });

  it("scopes opaque callbacks to one user/chat and makes them single-use", () => {
    let sequence = 0;
    const registry = new ConversationCallbackRegistry({ handle: () => `secure_${++sequence}` });
    const callback = registry.create({ type: "use", threadId: "private-thread", page: 0, scope: "all" }, 42, 42);
    expect(callback).not.toContain("private-thread");
    expect(registry.consume(callback, 7, 7)).toBeNull();
    expect(registry.consume(callback, 42, 42)).toEqual({ type: "use", threadId: "private-thread", page: 0, scope: "all" });
    expect(registry.consume(callback, 42, 42)).toBeNull();
  });
});
