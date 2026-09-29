import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function bridgeDescriptorPaths(repoRoot: string): string[] {
  const local = path.join(repoRoot, ".codex-pocket", "ui-bridge", "connection.json");
  if (process.platform !== "darwin") return [local];
  return [local, path.join(os.homedir(), "Library", "Application Support", "Codex Pocket", "connection.json")];
}

export async function writeBridgeDescriptors(repoRoot: string, value: unknown): Promise<string[]> {
  const descriptors = bridgeDescriptorPaths(repoRoot);
  for (const descriptor of descriptors) {
    await mkdir(path.dirname(descriptor), { recursive: true, mode: 0o700 });
    const temporary = `${descriptor}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, descriptor);
  }
  return descriptors;
}

export async function removeBridgeDescriptors(descriptors: readonly string[]): Promise<void> {
  await Promise.all(descriptors.map(async (descriptor) => await rm(descriptor, { force: true })));
}
