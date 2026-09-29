import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexSession } from "../src/domain-events.js";
import { WorkspaceManager } from "../src/workspace-manager.js";
import {
  WorkspaceRuntimeManager,
  type WorkspaceRuntime,
  type WorkspaceRuntimeAdapter,
} from "../src/workspace-runtime-manager.js";

class FakeRuntimeAdapter implements WorkspaceRuntimeAdapter {
  runtimes: WorkspaceRuntime[] = [];
  opens: string[] = [];
  async listRuntimes(): Promise<WorkspaceRuntime[]> { return structuredClone(this.runtimes); }
  async openWorkspace(workspace: WorkspaceRuntime["workspace"]): Promise<WorkspaceRuntime> {
    this.opens.push(workspace.path);
    const runtime: WorkspaceRuntime = {
      id: `runtime-${this.opens.length}`, workspace, state: "connected", appServerPid: 10, bridgePid: 20 + this.opens.length,
    };
    this.runtimes.push(runtime);
    return structuredClone(runtime);
  }
}

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("WorkspaceRuntimeManager", () => {
  it("maps exact live thread CWDs to distinct workspace runtimes on one shared App Server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-runtime-manager-"));
    roots.push(root);
    const firstCandidate = path.join(root, "A");
    const secondCandidate = path.join(root, "B");
    await Promise.all([mkdir(firstCandidate), mkdir(secondCandidate)]);
    const first = await realpath(firstCandidate);
    const second = await realpath(secondCandidate);
    const workspaces = new WorkspaceManager();
    const a = await workspaces.validate(first);
    const b = await workspaces.validate(second);
    const adapter = new FakeRuntimeAdapter();
    adapter.runtimes = [
      { id: "runtime-a", workspace: a, state: "connected", appServerPid: 77, bridgePid: 101 },
      { id: "runtime-b", workspace: b, state: "connected", appServerPid: 77, bridgePid: 102 },
    ];
    const manager = new WorkspaceRuntimeManager(adapter, workspaces);
    const session = (id: string, cwd: string, topology: CodexSession["topology"]): CodexSession => ({
      id, cwd, topology, title: id, preview: id, updatedAt: 1, loaded: topology === "sharedLive",
      canAcceptDirectInput: true, status: { type: "idle" }, turns: [],
    });

    expect((await manager.findRuntimeForThread(session("thread-a", first, "sharedLive")))?.id).toBe("runtime-a");
    expect((await manager.findRuntimeForThread(session("thread-b", second, "sharedLive")))?.id).toBe("runtime-b");
    expect(await manager.findRuntimeForThread(session("thread-history", first, "historical"))).toBeNull();
    expect(adapter.runtimes.every((runtime) => runtime.appServerPid === 77)).toBe(true);
  });

  it("does not duplicate a connected workspace and isolates one disappearing runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-runtime-lifecycle-"));
    roots.push(root);
    const firstCandidate = path.join(root, "A");
    const secondCandidate = path.join(root, "B");
    await Promise.all([mkdir(firstCandidate), mkdir(secondCandidate)]);
    const first = await realpath(firstCandidate);
    const second = await realpath(secondCandidate);
    const workspaces = new WorkspaceManager();
    const adapter = new FakeRuntimeAdapter();
    const manager = new WorkspaceRuntimeManager(adapter, workspaces);
    const runtimeA = await manager.openWorkspace(first);
    expect((await manager.openWorkspace(first)).id).toBe(runtimeA.id);
    expect(adapter.opens).toHaveLength(1);
    const runtimeB = await manager.openWorkspace(second);
    adapter.runtimes = adapter.runtimes.filter((runtime) => runtime.id !== runtimeB.id);
    expect(await manager.findRuntimeForWorkspace(second)).toBeNull();
    expect((await manager.findRuntimeForWorkspace(first))?.id).toBe(runtimeA.id);
  });
});
