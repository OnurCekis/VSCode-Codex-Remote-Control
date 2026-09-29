import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";
import { z } from "zod";
import { JsonRpcPeer } from "./json-rpc-peer.js";

const initializeResponseSchema = z.object({
  codexHome: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
  userAgent: z.string(),
});

const loadedListSchema = z.object({
  data: z.array(z.string()),
  nextCursor: z.string().nullable(),
});

async function connect(codex: string, name: string, childArgs: string[]): Promise<{
  peer: JsonRpcPeer;
  initialize: z.infer<typeof initializeResponseSchema>;
}> {
  const child = spawn(codex, childArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const peer = new JsonRpcPeer(child.stdout, child.stdin, {
    requestTimeoutMs: 15_000,
    closeTransport: () => {
      if (!child.killed) child.kill();
    },
    onProtocolError: (error) => {
      if (!child.killed) console.error(`[${name}] ${error.message}${stderr ? `: ${stderr.trim()}` : ""}`);
    },
  });
  const initialize = initializeResponseSchema.parse(await peer.request("initialize", {
    clientInfo: { name, title: name, version: "0.0.0" },
    capabilities: { experimentalApi: true },
  }));
  peer.notify("initialized", {});
  return { peer, initialize };
}

async function main(): Promise<void> {
  const codex = process.env.CODEX_POCKET_CODEX_EXE;
  if (!codex) throw new Error("CODEX_POCKET_CODEX_EXE is required.");
  await access(codex);

  const mode = process.argv[2] ?? "stdio";
  if (mode !== "stdio") throw new Error("Only stdio smoke mode is enabled; managed-daemon proxy fallback is disabled.");
  const childArgs = ["app-server"];
  const first = await connect(codex, "codex_pocket_smoke_a", childArgs);
  try {
    const firstLoaded = await first.peer.request("thread/loaded/list", { limit: 1_000 });
    loadedListSchema.parse(firstLoaded);
    await first.peer.request("thread/list", {
      limit: 1,
      sourceKinds: ["vscode"],
      sortDirection: "desc",
    });
    console.log(JSON.stringify({
      ok: true,
      mode,
      clients: 1,
      platform: first.initialize.platformOs,
    }));
  } finally {
    await first.peer.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
