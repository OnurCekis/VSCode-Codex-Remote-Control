import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcId } from "../../../apps/ipc-probe/src/rpc-types.js";
import { ForeignActiveSessionError, type CodexAdapter, type SessionAttachMode, type SessionQuery } from "../src/codex-adapter.js";
import { ConversationWorkspaceMismatchError } from "../src/conversation-manager.js";
import type { CodexEventListener, CodexSession, ConversationPreview } from "../src/domain-events.js";
import { PocketCore } from "../src/pocket-core.js";

const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class WorkspaceAdapter implements CodexAdapter {
  sessions: CodexSession[] = [];
  attachFailure = new Set<string>();
  starts: Array<{ sessionId: string; prompt: string; cwd?: string }> = [];
  attachModes: SessionAttachMode[] = [];
  async listSessions(_query?: SessionQuery): Promise<CodexSession[]> { return structuredClone(this.sessions); }
  observeSession(_sessionId: string | null): void {}
  async attach(sessionId: string, mode: SessionAttachMode): Promise<CodexSession> {
    this.attachModes.push(mode);
    if (this.attachFailure.has(sessionId)) throw new ForeignActiveSessionError();
    const session = this.sessions.find((entry) => entry.id === sessionId);
    if (!session) throw new Error("unknown");
    return structuredClone({
      ...session,
      loaded: true,
      status: mode === "joinLive" ? session.status : { type: "idle" },
      topology: mode === "joinLive" ? "sharedLive" : "historical",
      canAcceptDirectInput: true,
    });
  }
  async readConversationPreview(sessionId: string): Promise<ConversationPreview> {
    return { sessionId, messages: [], recentTurnCount: 0, hasOlder: false };
  }
  async startTask(sessionId: string, prompt: string, cwd?: string): Promise<string> {
    this.starts.push({ sessionId, prompt, ...(cwd ? { cwd } : {}) });
    return "turn-1";
  }
  async interruptTask(): Promise<void> {}
  resolveApproval(_requestId: RpcId): void {}
  subscribe(_listener: CodexEventListener): () => void { return () => undefined; }
  async close(): Promise<void> {}
}

function session(id: string, cwd: string, title: string): CodexSession {
  return {
    id, cwd, title, preview: title, updatedAt: 1, loaded: false, topology: "historical",
    canAcceptDirectInput: null, status: { type: "notLoaded" }, turns: [],
  };
}

async function twoWorkspaces(): Promise<{ first: string; second: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pocket-conversations-"));
  temporaryRoots.push(root);
  const first = path.join(root, "First");
  const second = path.join(root, "Second");
  await Promise.all([mkdir(first), mkdir(second)]);
  return { first: await realpath(first), second: await realpath(second) };
}

describe("workspace and conversation integration", () => {
  it("filters by canonical thread cwd metadata, not title", async () => {
    const { first, second } = await twoWorkspaces();
    const adapter = new WorkspaceAdapter();
    const firstIdentityVariant = process.platform === "win32" ? first.toUpperCase() : first;
    adapter.sessions = [session("one", firstIdentityVariant, "Second project by title"), session("two", second, "First project by title")];
    const core = new PocketCore(adapter);
    await core.workspaces.select(first);
    expect((await core.conversations.list("workspace")).map((entry) => entry.id)).toEqual(["one"]);
    expect(await core.conversations.list("all")).toHaveLength(2);
  });

  it("selects the exact same-workspace thread and sends with the active canonical cwd", async () => {
    const { first } = await twoWorkspaces();
    const adapter = new WorkspaceAdapter();
    adapter.sessions = [session("exact", first, "Exact")];
    const core = new PocketCore(adapter);
    await core.workspaces.select(first);
    await core.conversations.list("workspace");
    expect((await core.conversations.select("exact")).id).toBe("exact");
    expect(adapter.attachModes).toEqual(["resumeHistorical"]);
    await core.tasks.send("same thread");
    expect(adapter.starts).toEqual([{ sessionId: "exact", prompt: "same thread", cwd: core.workspaces.active!.path }]);
  });

  it("joins an already-loaded same-server conversation through the live co-presence mode", async () => {
    const { first } = await twoWorkspaces();
    const adapter = new WorkspaceAdapter();
    adapter.sessions = [{
      ...session("live", first, "Live"), loaded: true, topology: "sharedLive",
      canAcceptDirectInput: true, status: { type: "idle" },
    }];
    const core = new PocketCore(adapter);
    await core.workspaces.select(first);
    await core.conversations.list("workspace");
    const joined = await core.conversations.select("live");
    expect(joined.id).toBe("live");
    expect(joined.topology).toBe("sharedLive");
    expect(adapter.attachModes).toEqual(["joinLive"]);
  });

  it("requires an explicit cross-workspace transition and switches both states together", async () => {
    const { first, second } = await twoWorkspaces();
    const adapter = new WorkspaceAdapter();
    adapter.sessions = [session("first", first, "First"), session("second", second, "Second")];
    const core = new PocketCore(adapter);
    await core.workspaces.select(first);
    await core.conversations.list("all");
    await core.conversations.select("first");
    await expect(core.conversations.select("second")).rejects.toBeInstanceOf(ConversationWorkspaceMismatchError);
    expect(core.sessions.selected?.id).toBe("first");
    expect(core.workspaces.matches(first)).toBe(true);
    const selected = await core.conversations.select("second", { switchWorkspace: true });
    expect(selected.id).toBe("second");
    expect(core.workspaces.matches(second)).toBe(true);
  });

  it("preserves the previous workspace and conversation if cross-workspace attachment fails", async () => {
    const { first, second } = await twoWorkspaces();
    const adapter = new WorkspaceAdapter();
    adapter.sessions = [session("first", first, "First"), session("blocked", second, "Blocked")];
    adapter.attachFailure.add("blocked");
    const core = new PocketCore(adapter);
    await core.workspaces.select(first);
    await core.conversations.list("all");
    await core.conversations.select("first");
    await expect(core.conversations.select("blocked", { switchWorkspace: true })).rejects.toBeInstanceOf(ForeignActiveSessionError);
    expect(core.sessions.selected?.id).toBe("first");
    expect(core.workspaces.matches(first)).toBe(true);
    expect(core.sessions.known.find((entry) => entry.id === "blocked")?.topology).toBe("foreignActive");
    await core.conversations.list("all");
    expect(core.sessions.known.find((entry) => entry.id === "blocked")?.topology).toBe("foreignActive");
  });

  it("blocks a task when workspace selection changed but the conversation did not", async () => {
    const { first, second } = await twoWorkspaces();
    const adapter = new WorkspaceAdapter();
    adapter.sessions = [session("first", first, "First")];
    const core = new PocketCore(adapter);
    await core.workspaces.select(first);
    await core.conversations.list("all");
    await core.conversations.select("first");
    await core.workspaces.select(second);
    await expect(core.tasks.send("must not cross projects")).rejects.toThrow("different workspace");
    expect(adapter.starts).toHaveLength(0);
  });
});
