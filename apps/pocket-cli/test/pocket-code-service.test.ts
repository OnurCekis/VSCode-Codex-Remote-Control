import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../packages/codex-core/src/workspace-manager.js";
import type { WorkspaceRuntime } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import type { ProfileSyncStatus } from "../../../packages/pocket-runtime/src/profile-sync-service.js";
import { PocketCodeService, type PocketCodeGateway } from "../src/pocket-code-service.js";

const roots: string[] = [];
const sync: ProfileSyncStatus = {
  state: "upToDate", settings: "unchanged", keybindings: "unchanged", snippetsSynced: 1,
  extensionsSynced: 2, extensionsSkipped: [], extensionsDeferred: false,
  lastSuccessfulSync: "2026-08-23T00:00:00.000Z", warnings: [],
};

class Gateway implements PocketCodeGateway {
  supervisor: "started" | "reused" = "reused";
  ensureCalls: string[] = [];
  openCalls: Workspace[] = [];
  existing = false;
  appServerPid = 77;
  failStartup = false;
  async ensureSupervisor(workspace: string): Promise<"started" | "reused"> {
    this.ensureCalls.push(workspace);
    if (this.failStartup) throw new Error("startup failed");
    return this.supervisor;
  }
  async openWorkspace(workspace: Workspace): Promise<{ runtime: WorkspaceRuntime; alreadyConnected: boolean }> {
    this.openCalls.push(workspace);
    return { runtime: { id: `runtime:${workspace.displayName}`, workspace, state: "connected", appServerPid: this.appServerPid, bridgePid: this.openCalls.length + 100 }, alreadyConnected: this.existing };
  }
  async getProfileSyncStatus(): Promise<ProfileSyncStatus> { return sync; }
}

async function folder(name = "workspace"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocket-code-"));
  roots.push(root);
  const target = path.join(root, name);
  await mkdir(target);
  return target;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("PocketCodeService", () => {
  it("resolves dot from the current directory", async () => {
    const target = await folder();
    const gateway = new Gateway();
    const result = await new PocketCodeService(gateway, { cwd: () => target }).open(".");
    expect(result.workspace.path).toBe(await realpath(target));
  });

  it("accepts explicit directories including spaces", async () => {
    const target = await folder("workspace with spaces");
    const gateway = new Gateway();
    const result = await new PocketCodeService(gateway).open(target);
    expect(result.workspace.path).toBe(await realpath(target));
    expect(gateway.ensureCalls).toEqual([result.workspace.path]);
  });

  it("rejects nonexistent paths, files, and inaccessible validation failures before supervisor startup", async () => {
    const target = await folder();
    const gateway = new Gateway();
    await expect(new PocketCodeService(gateway).open(path.join(target, "missing"))).rejects.toThrow();
    const file = path.join(target, "file.txt");
    await writeFile(file, "fixture");
    await expect(new PocketCodeService(gateway).open(file)).rejects.toThrow("not a directory");
    expect(gateway.ensureCalls).toHaveLength(0);
  });

  it("reuses a healthy supervisor and reports an existing canonical runtime", async () => {
    const target = await folder();
    const gateway = new Gateway();
    gateway.existing = true;
    const result = await new PocketCodeService(gateway).open(target);
    expect(result.supervisor).toBe("reused");
    expect(result.alreadyConnected).toBe(true);
    expect(result.profileSync).toEqual(sync);
  });

  it("starts an absent supervisor before opening and propagates startup failure without launch", async () => {
    const target = await folder();
    const started = new Gateway();
    started.supervisor = "started";
    expect((await new PocketCodeService(started).open(target)).supervisor).toBe("started");
    const failed = new Gateway();
    failed.failStartup = true;
    await expect(new PocketCodeService(failed).open(target)).rejects.toThrow("startup failed");
    expect(failed.openCalls).toHaveLength(0);
  });

  it("opens different workspaces on one App Server without disturbing the first", async () => {
    const first = await folder("a");
    const second = await folder("b");
    const gateway = new Gateway();
    const service = new PocketCodeService(gateway);
    const a = await service.open(first);
    const b = await service.open(second);
    expect(a.runtime.appServerPid).toBe(b.runtime.appServerPid);
    expect(gateway.openCalls.map((item) => item.path)).toEqual([await realpath(first), await realpath(second)]);
  });
});
