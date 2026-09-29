import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverTelegramIdentity,
  persistTelegramSetup,
  telegramConfigurationPresent,
  testTelegramSetup,
  telegramBotIdentity,
} from "../src/telegram-setup.js";

const roots: string[] = [];
const testToken = ["123456", "abcdefghijklmnopqrstuvwxyzABCDE"].join(":");
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function response(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Telegram onboarding", () => {
  it("discovers only the newest matching private identity", async () => {
    const fetcher = vi.fn(async () => response([
      { message: { chat: { id: -100, type: "group" }, from: { id: 7 } } },
      { message: { chat: { id: 42, type: "private" }, from: { id: 42, username: "pocket_user" } } },
    ])) as unknown as typeof fetch;
    await expect(discoverTelegramIdentity(testToken, fetcher))
      .resolves.toEqual({ userId: 42, displayName: "@pocket_user" });
  });

  it("proves bot identity and test-message delivery before persisting", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ username: "codex_pocket_bot" }))
      .mockResolvedValueOnce(response({ message_id: 1 })) as unknown as typeof fetch;
    await expect(testTelegramSetup(testToken, "42", fetcher)).resolves.toEqual({
      botUsername: "codex_pocket_bot", userId: 42, delivered: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("resolves the user's own bot shortcut from official identity", async () => {
    const fetcher = vi.fn(async () => response({ username: "codex_pocket_bot" })) as unknown as typeof fetch;
    await expect(telegramBotIdentity(testToken, fetcher)).resolves.toEqual({
      botUsername: "codex_pocket_bot", botUrl: "https://t.me/codex_pocket_bot",
    });
  });

  it("atomically replaces Telegram values without exposing them through status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-telegram-")); roots.push(root);
    const env = path.join(root, ".env");
    await persistTelegramSetup(env, testToken, 42);
    expect(await telegramConfigurationPresent(env)).toBe(true);
    expect(await readFile(env, "utf8")).toContain("TELEGRAM_ALLOWED_USER_ID=42");
  });

  it("fails closed for invalid IDs and Telegram rejection", async () => {
    await expect(testTelegramSetup(testToken, "not-an-id"))
      .rejects.toThrow("positive number");
    const rejected = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Forbidden" }), { status: 403 })) as unknown as typeof fetch;
    await expect(testTelegramSetup(testToken, "42", rejected)).rejects.toThrow("Telegram rejected");
  });
});
