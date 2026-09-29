import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface MobilePairingQr {
  version: 1;
  relayUrl: string;
  roomId: string;
  pairingId: string;
  claimSecret: string;
  expiresAt: string;
  desktopPublicKey: string;
  botUsername: string;
}

export interface MobilePairingStatus {
  state: "unpaired" | "waitingForDevice" | "waitingForTelegram" | "paired" | "expired";
  expiresAt?: string;
  deviceName?: string;
  devicePublicKey?: string;
  userId?: number;
  pairedAt?: string;
}

interface MobilePairingRecord extends MobilePairingStatus {
  version: 1;
  pairingId?: string;
  claimHash?: string;
  telegramCodeHash?: string;
}

function digest(value: string): Buffer { return createHash("sha256").update(value, "utf8").digest(); }
function sameDigest(value: string, expected: string): boolean {
  const actual = digest(value); const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export class MobilePairingService {
  readonly #file: string;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(file: string, options: { now?: () => number; ttlMs?: number } = {}) {
    this.#file = path.resolve(file); this.#now = options.now ?? Date.now; this.#ttlMs = options.ttlMs ?? 5 * 60_000;
  }

  async start(input: { relayUrl: string; roomId: string; desktopPublicKey: string; botUsername: string }): Promise<{ qr: MobilePairingQr; telegramCode: string }> {
    const relay = new URL(input.relayUrl);
    if (relay.protocol !== "wss:") throw new Error("Mobile relay must use WSS.");
    if (!/^[A-Za-z0-9_]{5,32}$/u.test(input.botUsername)) throw new Error("Telegram bot username is invalid.");
    if (!input.desktopPublicKey) throw new Error("Desktop public key is required.");
    const pairingId = randomBytes(16).toString("base64url");
    const claimSecret = randomBytes(32).toString("base64url");
    const telegramCode = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(this.#now() + this.#ttlMs).toISOString();
    if (!/^[A-Za-z0-9_-]{20,80}$/u.test(input.roomId)) throw new Error("Mobile relay room identity is invalid.");
    await this.#write({ version: 1, state: "waitingForDevice", pairingId, claimHash: digest(claimSecret).toString("hex"),
      telegramCodeHash: digest(telegramCode).toString("hex"), expiresAt });
    return { qr: { version: 1, relayUrl: relay.toString(), roomId: input.roomId, pairingId, claimSecret, expiresAt,
      desktopPublicKey: input.desktopPublicKey, botUsername: input.botUsername }, telegramCode };
  }

  async registerDevice(input: { pairingId: string; claimSecret: string; deviceName: string; devicePublicKey: string }): Promise<void> {
    const record = await this.#claim();
    let replaced = false;
    try {
      this.#assertLive(record);
      if (record.state !== "waitingForDevice" || record.pairingId !== input.pairingId || !record.claimHash || !sameDigest(input.claimSecret, record.claimHash)) {
        throw new Error("Mobile pairing claim was rejected.");
      }
      if (!input.devicePublicKey || input.deviceName.trim().length < 1 || input.deviceName.length > 80) throw new Error("Mobile device identity is invalid.");
      const { claimHash: _claimHash, claimFile: _claimFile, ...waiting } = record;
      await this.#write({ ...waiting, state: "waitingForTelegram", deviceName: input.deviceName.trim(),
        devicePublicKey: input.devicePublicKey });
      replaced = true;
    } finally {
      if (!replaced) await rename(record.claimFile, this.#file).catch(() => undefined);
      else await rm(record.claimFile, { force: true });
    }
  }

  async completeTelegram(code: string, identity: { userId: number; chatId: number; privateChat: boolean }): Promise<boolean> {
    if (!identity.privateChat || identity.chatId !== identity.userId || !Number.isSafeInteger(identity.userId) || identity.userId <= 0) return false;
    const record = await this.#claim().catch(() => null);
    if (!record) return false;
    let replaced = false;
    try {
      this.#assertLive(record);
      if (record.state !== "waitingForTelegram" || !record.devicePublicKey || !record.telegramCodeHash ||
          !sameDigest(code.trim().toUpperCase(), record.telegramCodeHash)) return false;
      await this.#write({ version: 1, state: "paired", ...(record.deviceName ? { deviceName: record.deviceName } : {}),
        devicePublicKey: record.devicePublicKey, userId: identity.userId, pairedAt: new Date(this.#now()).toISOString() });
      replaced = true;
      return true;
    } finally {
      if (!replaced) await rename(record.claimFile, this.#file).catch(() => undefined);
      else await rm(record.claimFile, { force: true });
    }
  }

  async status(): Promise<MobilePairingStatus> {
    const record = await this.#read();
    if (!record) return { state: "unpaired" };
    if ((record.state === "waitingForDevice" || record.state === "waitingForTelegram") && (!record.expiresAt || Date.parse(record.expiresAt) <= this.#now())) {
      await this.#write({ version: 1, state: "expired" }); return { state: "expired" };
    }
    return { state: record.state, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(record.deviceName ? { deviceName: record.deviceName } : {}),
      ...(record.devicePublicKey ? { devicePublicKey: record.devicePublicKey } : {}),
      ...(record.userId ? { userId: record.userId } : {}), ...(record.pairedAt ? { pairedAt: record.pairedAt } : {}) };
  }

  async revoke(): Promise<void> { await this.#write({ version: 1, state: "unpaired" }); }

  #assertLive(record: MobilePairingRecord): void {
    if (!record.expiresAt || Date.parse(record.expiresAt) <= this.#now()) throw new Error("Mobile pairing has expired.");
  }
  async #read(): Promise<MobilePairingRecord | null> {
    try { const value = JSON.parse(await readFile(this.#file, "utf8")) as MobilePairingRecord; return value.version === 1 ? value : null; }
    catch { return null; }
  }
  async #claim(): Promise<MobilePairingRecord & { claimFile: string }> {
    const claimFile = `${this.#file}.${process.pid}.${randomBytes(4).toString("hex")}.claim`;
    await rename(this.#file, claimFile);
    const record = JSON.parse(await readFile(claimFile, "utf8")) as MobilePairingRecord;
    return { ...record, claimFile };
  }
  async #write(value: MobilePairingRecord): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const clean = JSON.parse(JSON.stringify(value)) as MobilePairingRecord;
    await writeFile(temporary, `${JSON.stringify(clean)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#file);
  }
}
