import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { connectPocketClient } from "../../../packages/pocket-runtime/src/pocket-client.js";
import { readConnectionFile } from "../../../packages/pocket-runtime/src/connection-file.js";

const scoped = process.argv.includes("--cwd");
const cwd = process.env.CODEX_POCKET_CWD?.trim();
if (scoped && !cwd) throw new Error("CODEX_POCKET_CWD is required for the scoped count.");
const connectionPath = path.resolve(".codex-pocket", "phase-1", "connection.json");
const logDirectory = path.resolve(".codex-pocket", "phase-2-1", "logs");
const logPath = path.join(logDirectory, `conversation-count-${scoped ? "cwd" : "all"}-${Date.now()}.jsonl`);
await mkdir(logDirectory, { recursive: true });
const connection = await readConnectionFile(connectionPath);
const client = await connectPocketClient({
  connection,
  clientName: "codex_pocket_phase_2_1_count",
  logPath,
});
try {
  const sessions = await client.core.sessions.discover(scoped ? { cwd: path.resolve(cwd!) } : {});
  await client.close();
  const rows = (await readFile(logPath, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
    direction?: string;
    message?: { method?: string };
  });
  const protocolPages = rows.filter((row) => row.direction === "out" && row.message?.method === "thread/list").length;
  process.stdout.write(`${JSON.stringify({
    scope: scoped ? "configured-cwd" : "all-vscode",
    conversations: sessions.length,
    protocolPages,
    telegramPages: Math.ceil(sessions.length / 5),
  })}\n`);
} finally {
  await client.close().catch(() => undefined);
  await rm(logPath, { force: true });
}
