import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface SecureEnvelope { version: 1; direction: "desktop" | "mobile"; sequence: number; messageId: string; iv: string; ciphertext: string; tag: string; }

export class MobileSecureChannel {
  readonly #key: Buffer;
  readonly #sendDirection: SecureEnvelope["direction"];
  #sendSequence = 0;
  #receiveSequence = 0;

  constructor(sharedSecret: Uint8Array, context: string, sendDirection: SecureEnvelope["direction"]) {
    if (sharedSecret.byteLength < 32) throw new Error("Shared secret is too short.");
    this.#key = Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.from("codex-pocket-mobile-v1"), Buffer.from(context), 32));
    this.#sendDirection = sendDirection;
  }

  seal(value: unknown): SecureEnvelope {
    const sequence = ++this.#sendSequence; const messageId = randomBytes(16).toString("base64url"); const iv = randomBytes(12);
    const aad = Buffer.from(`1:${this.#sendDirection}:${sequence}:${messageId}`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { version: 1, direction: this.#sendDirection, sequence, messageId, iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
  }

  open(envelope: SecureEnvelope): unknown {
    const expectedDirection = this.#sendDirection === "desktop" ? "mobile" : "desktop";
    if (envelope.version !== 1 || envelope.direction !== expectedDirection || envelope.sequence !== this.#receiveSequence + 1) {
      throw new Error("Secure envelope sequence or direction was rejected.");
    }
    const aad = Buffer.from(`1:${envelope.direction}:${envelope.sequence}:${envelope.messageId}`, "utf8");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
    this.#receiveSequence = envelope.sequence;
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  }
}
