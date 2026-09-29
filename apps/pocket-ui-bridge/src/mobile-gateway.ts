import { createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import WebSocket from "ws";
import type { DesktopMobileIdentity } from "../../../packages/pocket-runtime/src/mobile-identity.js";
import { MobilePairingService } from "../../../packages/pocket-runtime/src/mobile-pairing.js";
import { MobileSecureChannel, type SecureEnvelope } from "../../../packages/pocket-runtime/src/mobile-secure-channel.js";

interface MobileClaim { type: "pair.claim"; pairingId: string; deviceName: string; devicePublicKey: string; envelope: SecureEnvelope; }
interface MobileResume { type: "device.resume"; pairingId: string; devicePublicKey: string; envelope: SecureEnvelope; }
interface MobileRequest { type: "request"; id: string; method: string; params?: Record<string, unknown>; }

export class MobileGateway {
  readonly #relayUrl: string;
  readonly #identity: DesktopMobileIdentity;
  readonly #pairing: MobilePairingService;
  readonly #botUsername: () => Promise<string>;
  readonly #handle: (request: MobileRequest) => Promise<unknown>;
  #socket: WebSocket | null = null;
  #connecting: Promise<void> | null = null;
  #channel: MobileSecureChannel | null = null;
  #challenge: { pairingId: string; telegramCode: string } | null = null;
  #activeDevicePublicKey: string | null = null;
  #closed = false;

  constructor(input: { relayUrl: string; identity: DesktopMobileIdentity; pairing: MobilePairingService;
    botUsername(): Promise<string>; handle(request: MobileRequest): Promise<unknown> }) {
    this.#relayUrl = input.relayUrl; this.#identity = input.identity; this.#pairing = input.pairing;
    this.#botUsername = input.botUsername; this.#handle = input.handle;
  }

  async connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting) return await this.#connecting;
    this.#connecting = this.#connectOnce().finally(() => { this.#connecting = null; });
    return await this.#connecting;
  }

  async #connectOnce(): Promise<void> {
    const base = this.#relayUrl.replace(/\/$/u, "");
    const socket = new WebSocket(`${base}/v1/rooms/${this.#identity.roomId}/connect`, {
      headers: { authorization: `Bearer ${this.#identity.relayCredential}`, "x-pocket-role": "desktop" },
    });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    this.#socket = socket;
    socket.on("message", (data) => void this.#receive(data.toString()).catch(() => socket.close(1008, "Rejected")));
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = null;
      if (!this.#closed) setTimeout(() => void this.connect().catch(() => undefined), 2_000);
    });
  }

  async startPairing(): Promise<unknown> {
    await this.connect();
    const started = await this.#pairing.start({ relayUrl: this.#relayUrl, roomId: this.#identity.roomId,
      desktopPublicKey: this.#identity.publicKey, botUsername: await this.#botUsername() });
    this.#challenge = { pairingId: started.qr.pairingId, telegramCode: started.telegramCode };
    this.#channel = null; this.#activeDevicePublicKey = null;
    return started;
  }

  async sendEvent(event: unknown): Promise<void> { this.#sendEncrypted({ type: "event", event }); }
  registerPush(token: string): void {
    if (!/^[A-Za-z0-9_:\-.]{40,4096}$/u.test(token)) throw new Error("FCM token is invalid.");
    this.#socket?.send(JSON.stringify({ type: "relay.control", operation: "push.register", token }));
  }
  notifyForEvent(event: unknown): void {
    if (!event || typeof event !== "object" || !("event" in event) || !event.event || typeof event.event !== "object" || !("type" in event.event)) return;
    const type = event.event.type;
    const notification = type === "approval.requested" || type === "approval.pending" ? "approvalRequired"
      : type === "turn.finished" || type === "task.completed" ? "taskCompleted" : null;
    if (notification) this.#socket?.send(JSON.stringify({ type: "relay.control", operation: "push.notify", event: notification }));
  }
  close(): void { this.#closed = true; this.#socket?.close(1000, "Pocket closed"); this.#socket = null; }

  async #receive(text: string): Promise<void> {
    const value = JSON.parse(text) as MobileClaim | MobileResume | SecureEnvelope | { type?: string };
    if (value && "type" in value && value.type === "relay.offline") return;
    if (value && "type" in value && value.type === "pair.claim") { await this.#claim(value as MobileClaim); return; }
    if (value && "type" in value && value.type === "device.resume") { await this.#resume(value as MobileResume); return; }
    if (!this.#channel) throw new Error("Mobile channel is not paired.");
    const request = this.#channel.open(value as SecureEnvelope) as MobileRequest;
    if (request.type !== "request" || typeof request.id !== "string" || typeof request.method !== "string") throw new Error("Invalid mobile request.");
    const status = await this.#pairing.status();
    if (status.state !== "paired" || status.devicePublicKey !== this.#activeDevicePublicKey) throw new Error("Mobile device was revoked.");
    try { this.#sendEncrypted({ type: "response", id: request.id, result: await this.#handle(request) }); }
    catch (error) { this.#sendEncrypted({ type: "response", id: request.id, error: error instanceof Error ? error.message.slice(0, 300) : "Request failed." }); }
  }

  async #claim(claim: MobileClaim): Promise<void> {
    if (!this.#challenge || claim.pairingId !== this.#challenge.pairingId) throw new Error("Pairing session mismatch.");
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: this.#identity.publicKey, d: this.#identity.privateKey }, format: "jwk" });
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: claim.devicePublicKey }, format: "jwk" });
    const channel = new MobileSecureChannel(diffieHellman({ privateKey, publicKey }), claim.pairingId, "desktop");
    const payload = channel.open(claim.envelope) as { claimSecret?: string };
    if (typeof payload.claimSecret !== "string") throw new Error("Pairing claim is incomplete.");
    await this.#pairing.registerDevice({ pairingId: claim.pairingId, claimSecret: payload.claimSecret,
      deviceName: claim.deviceName, devicePublicKey: claim.devicePublicKey });
    this.#channel = channel;
    this.#activeDevicePublicKey = claim.devicePublicKey;
    this.#sendEncrypted({ type: "pair.challenge", botUsername: await this.#botUsername(), telegramCode: this.#challenge.telegramCode });
    const deadline = Date.now() + 5 * 60_000;
    while (!this.#closed && Date.now() < deadline) {
      const status = await this.#pairing.status();
      if (status.state === "paired") { this.#sendEncrypted({ type: "pair.accepted" }); this.#challenge = null; return; }
      if (status.state === "expired" || status.state === "unpaired") return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async #resume(resume: MobileResume): Promise<void> {
    const status = await this.#pairing.status();
    if (status.state !== "paired" || status.devicePublicKey !== resume.devicePublicKey) throw new Error("Mobile device was revoked.");
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: this.#identity.publicKey, d: this.#identity.privateKey }, format: "jwk" });
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: resume.devicePublicKey }, format: "jwk" });
    const channel = new MobileSecureChannel(diffieHellman({ privateKey, publicKey }), resume.pairingId, "desktop");
    const payload = channel.open(resume.envelope) as { resume?: boolean };
    if (payload.resume !== true) throw new Error("Mobile resume proof was rejected.");
    this.#channel = channel; this.#activeDevicePublicKey = resume.devicePublicKey; this.#sendEncrypted({ type: "pair.accepted" });
  }

  #sendEncrypted(value: unknown): void {
    if (!this.#channel || this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(this.#channel.seal(value)));
  }
}
