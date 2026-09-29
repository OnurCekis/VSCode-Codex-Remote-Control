import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const connectionSchema = z.object({
  version: z.literal(1),
  endpoint: z.string().url(),
  token: z.string().min(32),
  createdAt: z.string(),
  ownerPid: z.number().int().positive(),
  runtimeControl: z.object({
    requestsDir: z.string().min(1),
    resultsDir: z.string().min(1),
    statusFile: z.string().min(1),
  }).optional(),
});

export type PocketConnection = z.infer<typeof connectionSchema>;

export async function readConnectionFile(filePath: string): Promise<PocketConnection> {
  const parsed = connectionSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  const endpoint = new URL(parsed.endpoint);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port ||
    endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Connection file endpoint must be exactly ws://127.0.0.1:<port>/.");
  }
  if (parsed.runtimeControl) {
    const ownedRoot = `${path.resolve(path.dirname(filePath))}${path.sep}`.toLowerCase();
    for (const candidate of Object.values(parsed.runtimeControl)) {
      const resolved = path.resolve(candidate).toLowerCase();
      if (!resolved.startsWith(ownedRoot)) throw new Error("Runtime control paths must stay inside the Pocket run directory.");
    }
  }
  try {
    process.kill(parsed.ownerPid, 0);
  } catch {
    throw new Error(`Connection file owner process is not alive: ${parsed.ownerPid}`);
  }
  return parsed;
}
