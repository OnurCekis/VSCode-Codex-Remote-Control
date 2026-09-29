import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessRecord {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine?: string | null;
}

export function phase3BrowserName(
  platform: NodeJS.Platform = process.platform,
  configured = process.env.CODEX_POCKET_PHASE3_BROWSER,
): string {
  const selected = configured?.trim() || (platform === "win32" ? "msedge" : "chromium");
  if (!/^[a-z0-9_-]+$/u.test(selected)) throw new Error("CODEX_POCKET_PHASE3_BROWSER has an invalid browser name.");
  return selected;
}

export function parsePosixProcessList(output: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const commandLine = match[3];
    if (!commandLine) continue;
    records.push({
      ProcessId: Number(match[1]),
      ParentProcessId: Number(match[2]),
      Name: commandLine,
      CommandLine: commandLine,
    });
  }
  return records;
}

export async function processSnapshot(platform: NodeJS.Platform = process.platform): Promise<ProcessRecord[]> {
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ], { windowsHide: true, timeout: 20_000 });
    const parsed = JSON.parse(stdout) as ProcessRecord | ProcessRecord[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const { stdout } = await execFileAsync("ps", ["-ww", "-axo", "pid=,ppid=,command="], { timeout: 20_000 });
  return parsePosixProcessList(stdout);
}

export function descendants(records: ProcessRecord[], rootPid: number): ProcessRecord[] {
  const result: ProcessRecord[] = [];
  const parents = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (parents.has(record.ParentProcessId) && !parents.has(record.ProcessId)) {
        parents.add(record.ProcessId);
        result.push(record);
        changed = true;
      }
    }
  }
  return result;
}

export async function stopOwnedBrowserProcesses(userDataDir: string, observedPids = new Set<number>()): Promise<number[]> {
  const normalizePath = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedProfile = normalizePath(path.resolve(userDataDir));
  const owned = (records: ProcessRecord[]) => records.filter((record) =>
    /msedge|chrome|chromium/iu.test(`${record.Name} ${record.CommandLine ?? ""}`) &&
    normalizePath(record.CommandLine ?? "").includes(normalizedProfile));
  const initial = owned(await processSnapshot());
  for (const record of initial) {
    observedPids.add(record.ProcessId);
    try { process.kill(record.ProcessId, "SIGTERM"); } catch (error) {
      if (!((error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  let remaining = owned(await processSnapshot());
  while (remaining.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = owned(await processSnapshot());
  }
  if (remaining.length && process.platform !== "win32") {
    for (const record of remaining) {
      try { process.kill(record.ProcessId, "SIGKILL"); } catch (error) {
        if (!((error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
      }
    }
    const killDeadline = Date.now() + 2_000;
    remaining = owned(await processSnapshot());
    while (remaining.length && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      remaining = owned(await processSnapshot());
    }
  }
  return remaining.map((record) => record.ProcessId);
}
