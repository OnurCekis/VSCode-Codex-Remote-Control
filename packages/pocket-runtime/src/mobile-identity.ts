import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DesktopMobileIdentity { version: 1; roomId: string; relayCredential: string; publicKey: string; privateKey: string; }

export async function loadOrCreateDesktopMobileIdentity(file: string): Promise<DesktopMobileIdentity> {
  const target = path.resolve(file);
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as DesktopMobileIdentity;
    if (value.version === 1 && value.roomId && value.relayCredential && value.publicKey && value.privateKey) return value;
  } catch { /* create below */ }
  const pair = generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" }); const privateJwk = pair.privateKey.export({ format: "jwk" });
  if (!publicJwk.x || !privateJwk.d) throw new Error("X25519 key export failed.");
  const value: DesktopMobileIdentity = { version: 1, roomId: randomBytes(24).toString("base64url"),
    relayCredential: randomBytes(32).toString("base64url"),
    publicKey: publicJwk.x, privateKey: privateJwk.d };
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, target); return value;
}
