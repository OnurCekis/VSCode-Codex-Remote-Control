import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PairingService } from "../src/pairing-service.js";

describe("PairingService", () => {
  const roots: string[] = [];
  afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("accepts one real private-chat identity exactly once without storing the code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-pairing-")); roots.push(root);
    const file = path.join(root, "state.json"); const service = new PairingService(file);
    const started = await service.start();
    expect(await readFile(file, "utf8")).not.toContain(started.code);
    expect(await service.complete(started.code, { userId: 42, chatId: 42, privateChat: true })).toBe(true);
    expect(await service.complete(started.code, { userId: 42, chatId: 42, privateChat: true })).toBe(false);
    expect(await service.status()).toEqual({ state: "paired", userId: 42, chatId: 42 });
  });

  it("rejects group chats, mismatched identity, wrong codes and expired codes", async () => {
    let now = 1_000; const root = await mkdtemp(path.join(os.tmpdir(), "pocket-pairing-")); roots.push(root);
    const service = new PairingService(path.join(root, "state.json"), { now: () => now, ttlMs: 100 });
    const first = await service.start();
    expect(await service.complete(first.code, { userId: 42, chatId: -10, privateChat: false })).toBe(false);
    expect(await service.complete("00000000", { userId: 42, chatId: 42, privateChat: true })).toBe(false);
    now = 1_101;
    expect(await service.complete(first.code, { userId: 42, chatId: 42, privateChat: true })).toBe(false);
    expect((await service.status()).state).toBe("expired");
  });
});
