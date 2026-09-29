import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PairingStatus {
  state: "unpaired" | "waiting" | "paired" | "expired";
  expiresAt?: string;
  userId?: number;
  chatId?: number;
}

interface PairingRecord extends PairingStatus {
  version: 1;
  codeHash?: string;
}

function hash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export class PairingService {
  readonly #stateFile: string;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(stateFile: string, options: { now?: () => number; ttlMs?: number } = {}) {
    this.#stateFile = path.resolve(stateFile);
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
  }

  async start(): Promise<{ code: string; status: PairingStatus }> {
    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(this.#now() + this.#ttlMs).toISOString();
    await this.#write({ version: 1, state: "waiting", expiresAt, codeHash: hash(code) });
    return { code, status: { state: "waiting", expiresAt } };
  }

  async status(): Promise<PairingStatus> {
    const record = await this.#read();
    if (!record) return { state: "unpaired" };
    if (record.state === "waiting" && (!record.expiresAt || Date.parse(record.expiresAt) <= this.#now())) {
      await this.#write({ version: 1, state: "expired" });
      return { state: "expired" };
    }
    return {
      state: record.state,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.chatId ? { chatId: record.chatId } : {}),
    };
  }

  async complete(code: string, identity: { userId: number; chatId: number; privateChat: boolean }): Promise<boolean> {
    if (!identity.privateChat || !Number.isSafeInteger(identity.userId) || identity.userId <= 0 || identity.chatId !== identity.userId) return false;
    const claim = `${this.#stateFile}.${process.pid}.${randomBytes(4).toString("hex")}.claim`;
    try { await rename(this.#stateFile, claim); } catch { return false; }
    try {
      const record = JSON.parse(await readFile(claim, "utf8")) as PairingRecord;
      if (record.version !== 1 || record.state !== "waiting" || !record.expiresAt || Date.parse(record.expiresAt) <= this.#now() ||
        !record.codeHash || hash(code.trim().toUpperCase()) !== record.codeHash) {
        if (record.state === "paired" || (record.state === "waiting" && record.expiresAt && Date.parse(record.expiresAt) > this.#now())) {
          await rename(claim, this.#stateFile);
        } else {
          await this.#write({ version: 1, state: "expired" });
        }
        return false;
      }
      await this.#write({ version: 1, state: "paired", userId: identity.userId, chatId: identity.chatId });
      return true;
    } finally {
      await rm(claim, { force: true });
    }
  }

  async #read(): Promise<PairingRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.#stateFile, "utf8")) as PairingRecord;
      return value.version === 1 ? value : null;
    } catch { return null; }
  }

  async #write(value: PairingRecord): Promise<void> {
    await mkdir(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.#stateFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#stateFile);
  }
}
