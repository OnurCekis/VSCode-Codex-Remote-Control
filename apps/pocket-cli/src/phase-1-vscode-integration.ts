import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const runRoot = path.resolve(".codex-pocket", "phase-1");
const workspace = path.join(runRoot, "workspace");
const statusPath = path.join(runRoot, "integration-status.json");
const continuePath = path.join(runRoot, "integration-continue");
const approveMarker = path.join(runRoot, "phase-1-approve.txt");
const denyMarker = path.join(runRoot, "phase-1-deny.txt");
const transcriptPath = path.join(runRoot, "logs", `cli-integration-${Date.now()}.log`);
const cliEntry = path.resolve("apps", "pocket-cli", "src", "cli.ts");
const tsxEntry = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
const home = os.homedir();

function redact(text: string): string {
  return text.replaceAll(home, "<HOME>").replace(/Bearer\s+[^\s"']+/giu, "Bearer <REDACTED>");
}

class CliDriver {
  readonly child: ChildProcessWithoutNullStreams;
  output = "";
  readonly #logWrites: Promise<void>[] = [];

  constructor(name: string) {
    this.child = spawn(process.execPath, [tsxEntry, cliEntry, "--cwd", workspace], {
      cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, CODEX_POCKET_CONNECTION_FILE: path.join(runRoot, "connection.json") },
    });
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      this.output += text;
      this.#logWrites.push(appendFile(transcriptPath, `[${name}:${stream}] ${redact(text)}`, "utf8"));
    };
    this.child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    this.child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  }

  send(command: string): void {
    this.#logWrites.push(appendFile(transcriptPath, `[driver] ${redact(command)}\n`, "utf8"));
    this.child.stdin.write(`${command}\n`);
  }

  async waitFor(pattern: RegExp, timeoutMs: number, description: string, startAt = 0): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.output.slice(startAt).match(pattern);
      if (match) return match;
      if (this.child.exitCode !== null) throw new Error(`CLI exited (${this.child.exitCode}) while waiting for ${description}.\n${this.output}`);
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${description}.\n${this.output}`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) this.send("quit");
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      delay(5_000).then(() => { if (this.child.exitCode === null) this.child.kill(); }),
    ]);
    await Promise.all(this.#logWrites);
  }
}

await Promise.all([
  access(path.join(runRoot, "connection.json")),
  mkdir(path.dirname(transcriptPath), { recursive: true }),
  rm(statusPath, { force: true }), rm(continuePath, { force: true }),
  rm(approveMarker, { force: true }), rm(denyMarker, { force: true }),
]);
await writeFile(transcriptPath, "", "utf8");

let first: CliDriver | null = null;
let second: CliDriver | null = null;
let sessionId: string | null = null;
try {
  first = new CliDriver("pocket-1");
  await first.waitFor(/Codex Pocket Core CLI connected/u, 30_000, "first CLI connection");
  first.send("sessions");
  const sessionMatch = await first.waitFor(/\b(01[a-z0-9-]{30,}) \[.*loaded.*\]/iu, 30_000, "VS Code session discovery");
  sessionId = sessionMatch[1] ?? null;
  if (!sessionId) throw new Error("Discovered session ID was missing.");
  first.send(`use ${sessionId}`);
  await first.waitFor(new RegExp(`Attached ${sessionId.replaceAll("-", "\\-")}; historyTurns=\\d+\\.`), 30_000, "hot attachment");

  let offset = first.output.length;
  first.send("send Reply exactly PHASE_1_CLI_TASK.");
  await first.waitFor(/Started turn /u, 30_000, "CLI task start", offset);
  await first.waitFor(/\[task\.completed\].*status=completed/u, 180_000, "CLI task completion", offset);

  await writeFile(statusPath, `${JSON.stringify({
    phase: 1, gate: 4, state: "awaiting_vscode_approval_prompt", sessionId,
    vscodePrompt: "Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath '..\\phase-1-approve.txt' -Value 'phase-1-approved'\"",
    transcript: transcriptPath,
  }, null, 2)}\n`, "utf8");

  offset = first.output.length;
  const pending = await first.waitFor(/\[approval\.pending\] (approval-\d+) command/u, 10 * 60_000, "normalized VS Code approval", offset);
  const approvalId = pending[1];
  if (!approvalId) throw new Error("Normalized approval ID was missing.");
  first.send(`approve ${approvalId}`);
  await first.waitFor(new RegExp(`Approved ${approvalId}\\.`), 30_000, "CLI approval response", offset);
  await first.waitFor(/\[task\.completed\].*status=completed/u, 180_000, "VS Code-owned turn continuation", offset);
  if ((await readFile(approveMarker, "utf8")).trim() !== "phase-1-approved") throw new Error("Approved marker was not created.");

  offset = first.output.length;
  first.send("send Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath '..\\phase-1-deny.txt' -Value 'must-not-exist'\"");
  const deniedPending = await first.waitFor(/\[approval\.pending\] (approval-\d+) command/u, 180_000, "denial approval", offset);
  const denialId = deniedPending[1];
  if (!denialId) throw new Error("Denial approval ID was missing.");
  first.send(`deny ${denialId}`);
  await first.waitFor(new RegExp(`Denied ${denialId}\\.`), 30_000, "CLI denial response", offset);
  await first.waitFor(/\[task\.completed\]/u, 180_000, "denied turn completion", offset);
  await access(denyMarker).then(() => { throw new Error("Denied marker unexpectedly exists."); }).catch((error: unknown) => {
    if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
  });

  offset = first.output.length;
  first.send("send Run exactly this shell command and do nothing else: powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"");
  await first.waitFor(/\[task\.started\]/u, 30_000, "controlled active turn", offset);
  await delay(2_000);
  first.send("stop");
  await first.waitFor(/Interrupt requested/u, 30_000, "CLI interrupt request", offset);
  await first.waitFor(/\[task\.completed\].*status=interrupted/u, 30_000, "interrupted terminal status", offset);
  await first.close();
  first = null;

  await access(path.join(runRoot, "connection.json"));
  second = new CliDriver("pocket-2");
  await second.waitFor(/Codex Pocket Core CLI connected/u, 30_000, "restarted CLI connection");
  second.send("sessions");
  await second.waitFor(new RegExp(sessionId), 30_000, "same session after restart");
  second.send(`use ${sessionId}`);
  const restored = await second.waitFor(/historyTurns=(\d+)\./u, 30_000, "history-preserving reattachment");
  if (Number(restored[1]) < 4) throw new Error(`Expected at least four history turns after restart; found ${restored[1]}.`);
  second.send("status");
  await second.waitFor(new RegExp(`session=${sessionId}`), 30_000, "restored CLI status");
  await second.close();
  second = null;

  await writeFile(statusPath, `${JSON.stringify({
    phase: 1, gate: 9, state: "all_cli_gates_passed_awaiting_ui_check", sessionId,
    transcript: transcriptPath, approveMarker,
  }, null, 2)}\n`, "utf8");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try { await access(continuePath); break; } catch { await delay(250); }
  }
  await writeFile(statusPath, `${JSON.stringify({ phase: 1, gate: 9, state: "complete", sessionId, transcript: transcriptPath }, null, 2)}\n`, "utf8");
} catch (error) {
  const failure = error instanceof Error ? error.message : String(error);
  await writeFile(statusPath, `${JSON.stringify({ phase: 1, state: "failed", sessionId, failure }, null, 2)}\n`, "utf8");
  throw error;
} finally {
  await first?.close().catch(() => undefined);
  await second?.close().catch(() => undefined);
}
