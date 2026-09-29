import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { NativeSocketSupervisor } from "./native-socket-supervisor.js";

const codexPath = process.env.CODEX_POCKET_CODEX_EXE;
if (!codexPath) throw new Error("CODEX_POCKET_CODEX_EXE is required.");
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const socketPath = process.env.CODEX_POCKET_NATIVE_SOCKET ?? path.join(os.tmpdir(), `cp-${process.pid}.sock`);
await mkdir(codexHome, { recursive: true });

const supervisor = new NativeSocketSupervisor({ codexPath, codexHome, socketPath });
await supervisor.start();
console.log(JSON.stringify({ ready: true, socketArgument: supervisor.socketArgument }));

const shutdown = async () => {
  await supervisor.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
