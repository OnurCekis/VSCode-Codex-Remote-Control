import path from "node:path";
import process from "node:process";
import * as readline from "node:readline/promises";
import { connectPocketClient } from "../../../packages/pocket-runtime/src/pocket-client.js";
import { CommandController } from "./command-controller.js";
import { readConnectionFile } from "./connection-file.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const connectionPath = path.resolve(option("--connection") ?? process.env.CODEX_POCKET_CONNECTION_FILE ?? ".codex-pocket/phase-1/connection.json");
const cwd = option("--cwd");
const connection = await readConnectionFile(connectionPath);
const client = await connectPocketClient({
  connection,
  clientName: "codex_pocket_cli",
  logPath: path.resolve(".codex-pocket", "phase-1", "logs", `cli-${Date.now()}.jsonl`),
});
const core = client.core;
const adapter = core.adapter;
const controller = new CommandController(core, cwd);
const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

const unsubscribe = adapter.subscribe((event) => {
  if (event.type === "approval.pending") {
    const pending = core.approvals.pending(event.approval.sessionId).find((approval) => approval.itemId === event.approval.itemId);
    if (pending) {
      process.stdout.write(`\n[approval.pending] ${pending.id} ${pending.kind}${pending.reason ? ` reason=${pending.reason}` : ""}\n`);
      if (pending.command) process.stdout.write(`command=${pending.command}\n`);
    }
  } else if (event.type === "approval.resolved") {
    process.stdout.write(`\n[approval.resolved] session=${event.sessionId}\n`);
  } else if (event.type === "task.started") {
    process.stdout.write(`\n[task.started] ${event.turnId}\n`);
  } else if (event.type === "task.completed") {
    process.stdout.write(`\n[task.completed] ${event.turnId} status=${event.status}\n`);
  } else if (event.type === "session.status.changed") {
    process.stdout.write(`\n[session.status] ${event.status.type}\n`);
  }
});

try {
  process.stdout.write("Codex Pocket Core CLI connected. Type 'help'.\n");
  while (true) {
    let line: string;
    try {
      line = await terminal.question("pocket> ");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE") break;
      throw error;
    }
    try {
      const result = await controller.execute(line);
      for (const output of result.lines) process.stdout.write(`${output}\n`);
      if (result.quit) break;
    } catch (error) {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
} finally {
  unsubscribe();
  terminal.close();
  await client.close();
}
