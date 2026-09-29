import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);

export interface MacosProcessRecord {
  pid: number;
  ppid: number;
  command: string;
}

export function parseMacosProcessList(output: string): MacosProcessRecord[] {
  const records: MacosProcessRecord[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    records.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return records;
}

export function parseLsofEstablishedEndpoints(output: string): string[] {
  return output.split(/\r?\n/u).filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

async function processList(): Promise<MacosProcessRecord[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="], { timeout: 10_000 });
  return parseMacosProcessList(stdout);
}

export function ownedProfileProcesses(
  records: readonly MacosProcessRecord[],
  profile: string,
  app: string,
): MacosProcessRecord[] {
  const canonicalProfile = path.resolve(profile);
  const appRoot = path.resolve(app);
  return records.filter((record) => record.command.includes(canonicalProfile) && record.command.includes(appRoot));
}

export async function assertMacosVscodeTopology(options: {
  app: string;
  profile: string;
  launcher: string;
  bridgePid: number;
  endpoint: string;
}): Promise<number[]> {
  const records = await processList();
  const codeProcesses = ownedProfileProcesses(records, options.profile, options.app);
  if (codeProcesses.length === 0) throw new Error("Pinned isolated macOS VS Code process is not running with the owned profile.");
  const bridge = records.find((record) => record.pid === options.bridgePid);
  if (!bridge || !bridge.command.startsWith(path.resolve(options.launcher))) {
    throw new Error("Pinned macOS proxy process is not running from the owned launcher.");
  }
  const port = Number.parseInt(new URL(options.endpoint).port, 10);
  const { stdout } = await execFileAsync("/usr/sbin/lsof", [
    "-nP", "-a", "-p", String(options.bridgePid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn",
  ], { timeout: 5_000 });
  const endpoints = parseLsofEstablishedEndpoints(stdout);
  if (!endpoints.some((entry) => entry.includes(`->127.0.0.1:${port}`))) {
    throw new Error("macOS VS Code proxy is not connected to the Pocket-owned App Server endpoint.");
  }
  return codeProcesses.map((record) => record.pid);
}

export async function stopMacosProfileProcesses(_profile: string, app: string): Promise<number[]> {
  const appRoot = path.resolve(app);
  // The pinned app bundle is Pocket-owned. VS Code can leave short-lived login-shell
  // environment probes behind without the profile argument, so cleanup must include
  // every process launched from that private bundle, not only profile-bearing children.
  const owned = (): Promise<MacosProcessRecord[]> => processList()
    .then((records) => records.filter((record) => record.command.includes(appRoot)));
  let remaining = await owned();
  for (const record of remaining) {
    try { process.kill(record.pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 10_000;
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(100);
    remaining = await owned();
  }
  const killDeadline = Date.now() + 5_000;
  while (remaining.length > 0 && Date.now() < killDeadline) {
    for (const record of remaining) {
      try { process.kill(record.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await delay(100);
    remaining = await owned();
  }
  return (await owned()).map((record) => record.pid);
}
