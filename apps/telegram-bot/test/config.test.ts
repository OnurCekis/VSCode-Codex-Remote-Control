import { describe, expect, it } from "vitest";
import { loadTelegramConfig } from "../src/config.js";

describe("Telegram configuration", () => {
  it("fails closed when required values are absent or invalid", () => {
    expect(() => loadTelegramConfig({})).toThrow();
    expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "bad", TELEGRAM_ALLOWED_USER_ID: "123" })).toThrow();
    expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: `123:${"a".repeat(35)}`, TELEGRAM_ALLOWED_USER_ID: "name" })).toThrow();
    expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: `123:${"a".repeat(35)}`, TELEGRAM_ALLOWED_USER_ID: "0" })).toThrow();
  });

  it("accepts only a numeric safe user ID and shaped bot token", () => {
    const config = loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: `123456:${"A".repeat(35)}`,
      TELEGRAM_ALLOWED_USER_ID: "424242",
      CODEX_POCKET_CONNECTION_FILE: ".runtime/connection.json",
      CODEX_POCKET_EXTRA_WORKSPACE_ROOTS: "D:\\Projects;E:\\Team Work;D:\\Projects",
    });
    expect(config.allowedUserId).toBe(424242);
    expect(config.connectionFile).toMatch(/connection\.json$/u);
    expect(config.extraWorkspaceRoots).toEqual(["D:\\Projects", "E:\\Team Work"]);
    expect(() => loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: `123456:${"A".repeat(35)}`,
      TELEGRAM_ALLOWED_USER_ID: "424242",
      CODEX_POCKET_EXTRA_WORKSPACE_ROOTS: "relative\\folder",
    })).toThrow("absolute local Windows paths");
  });
});
