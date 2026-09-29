import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MobilePairingService } from "../src/mobile-pairing.js";
import { MobileSecureChannel } from "../src/mobile-secure-channel.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("mobile pairing", () => {
  it("binds a one-time WSS QR claim to one verified private Telegram identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-mobile-pair-")); roots.push(root);
    const service = new MobilePairingService(path.join(root, "state.json"));
    const started = await service.start({ relayUrl: "wss://relay.example.test/connect", roomId: "room_identity_1234567890", desktopPublicKey: "desktop-key", botUsername: "pocket_bot" });
    expect(JSON.stringify(started.qr)).not.toContain(started.telegramCode);
    await service.registerDevice({ pairingId: started.qr.pairingId, claimSecret: started.qr.claimSecret,
      deviceName: "Pixel", devicePublicKey: "pixel-key" });
    await expect(service.completeTelegram(started.telegramCode, { userId: 42, chatId: -42, privateChat: false })).resolves.toBe(false);
    await expect(service.completeTelegram("00000000", { userId: 42, chatId: 42, privateChat: true })).resolves.toBe(false);
    await expect(service.completeTelegram(started.telegramCode, { userId: 42, chatId: 42, privateChat: true })).resolves.toBe(true);
    await expect(service.status()).resolves.toMatchObject({ state: "paired", userId: 42, deviceName: "Pixel", devicePublicKey: "pixel-key" });
  });

  it("rejects a reused or expired claim", async () => {
    let now = 1000; const root = await mkdtemp(path.join(os.tmpdir(), "pocket-mobile-pair-")); roots.push(root);
    const service = new MobilePairingService(path.join(root, "state.json"), { now: () => now, ttlMs: 10 });
    const started = await service.start({ relayUrl: "wss://relay.example.test", roomId: "room_identity_1234567890", desktopPublicKey: "desktop-key", botUsername: "pocket_bot" });
    now = 1011;
    await expect(service.registerDevice({ pairingId: started.qr.pairingId, claimSecret: started.qr.claimSecret,
      deviceName: "Pixel", devicePublicKey: "pixel-key" })).rejects.toThrow("expired");
  });
});

describe("mobile secure channel", () => {
  it("encrypts both directions and rejects replay and tampering", () => {
    const secret = Buffer.alloc(32, 7); const desktop = new MobileSecureChannel(secret, "pair-1", "desktop");
    const mobile = new MobileSecureChannel(secret, "pair-1", "mobile");
    const envelope = desktop.seal({ type: "state", secret: "not visible" });
    expect(JSON.stringify(envelope)).not.toContain("not visible");
    expect(mobile.open(envelope)).toEqual({ type: "state", secret: "not visible" });
    expect(() => mobile.open(envelope)).toThrow("sequence");
    const reply = mobile.seal({ type: "task", prompt: "hello" });
    expect(desktop.open(reply)).toEqual({ type: "task", prompt: "hello" });
    const changed = desktop.seal({ type: "status" }); changed.ciphertext = `${changed.ciphertext[0] === "A" ? "B" : "A"}${changed.ciphertext.slice(1)}`;
    expect(() => mobile.open(changed)).toThrow();
  });
});
