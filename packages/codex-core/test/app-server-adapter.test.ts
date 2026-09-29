import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcPeer } from "../../../apps/ipc-probe/src/json-rpc-peer.js";
import { AppServerCodexAdapter } from "../src/app-server-codex-adapter.js";
import { ForeignActiveSessionError } from "../src/codex-adapter.js";
import type { CodexEvent } from "../src/domain-events.js";

async function nextRequest(output: PassThrough): Promise<{ id: number; method: string; params: Record<string, unknown> }> {
  return await new Promise((resolve) => output.once("data", (chunk) => resolve(JSON.parse(chunk.toString()) as {
    id: number; method: string; params: Record<string, unknown>;
  })));
}

describe("AppServerCodexAdapter normalized events", () => {
  it("normalizes approval, status, task, and resolution protocol messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    input.write(`${JSON.stringify({ method: "thread/status/changed", params: { threadId: "t", status: { type: "active", activeFlags: ["waitingOnApproval"] } } })}\n`);
    input.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "t", turn: { id: "turn" } } })}\n`);
    input.write(`${JSON.stringify({ id: 9, method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "turn", itemId: "item", reason: "safe" } })}\n`);
    input.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "t", requestId: 9 } })}\n`);
    input.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn", status: "completed", error: null } } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([
      "session.status.changed", "task.started", "approval.pending", "approval.resolved", "task.completed",
    ]);
    await adapter.close();
  });

  it("reads a bounded conversation preview through the pinned thread/turns/list contract", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const outbound = new Promise<string>((resolve) => output.once("data", (chunk) => resolve(chunk.toString())));
    const pending = adapter.readConversationPreview("thread-existing", 6);
    const request = JSON.parse(await outbound) as { id: number; method: string; params: Record<string, unknown> };
    expect(request).toMatchObject({
      method: "thread/turns/list",
      params: { threadId: "thread-existing", limit: 6, sortDirection: "desc", itemsView: "full" },
    });
    input.write(`${JSON.stringify({
      id: request.id,
      result: {
        data: [
          { id: "newer", items: [
            { type: "agentMessage", text: "Final result", phase: "final_answer" },
            { type: "commandExecution", command: "must not be exposed" },
          ] },
          { id: "older", items: [
            { type: "userMessage", content: [{ type: "text", text: "Original request" }] },
            { type: "agentMessage", text: "internal progress", phase: "commentary" },
          ] },
        ],
        nextCursor: "older-page",
        backwardsCursor: null,
      },
    })}\n`);
    await expect(pending).resolves.toEqual({
      sessionId: "thread-existing",
      messages: [
        { role: "user", text: "Original request" },
        { role: "assistant", text: "Final result" },
      ],
      recentTurnCount: 2,
      hasOlder: true,
    });
    await adapter.close();
  });

  it("passes the verified active workspace through the pinned turn/start cwd field", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const outbound = new Promise<string>((resolve) => output.once("data", (chunk) => resolve(chunk.toString())));
    const pending = adapter.startTask("thread-existing", "Continue safely", "C:\\Exact\\Workspace");
    const request = JSON.parse(await outbound) as { id: number; method: string; params: Record<string, unknown> };
    expect(request).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-existing",
        cwd: "C:\\Exact\\Workspace",
        input: [{ type: "text", text: "Continue safely" }],
      },
    });
    input.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-new" } } })}\n`);
    await expect(pending).resolves.toBe("turn-new");
    await adapter.close();
  });

  it("discovers model capabilities and carries the selected model and effort into the first turn", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const adapter = new AppServerCodexAdapter(new JsonRpcPeer(input, output));
    const modelRequest = nextRequest(output);
    const creating = adapter.createSession("/exact/workspace", { model: "gpt-5.6-sol", reasoningEffort: "high" });
    const models = await modelRequest;
    expect(models).toMatchObject({ method: "model/list", params: { includeHidden: false } });
    const startRequest = nextRequest(output);
    input.write(`${JSON.stringify({ id: models.id, result: { data: [{
      id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deeper" },
      ],
    }], nextCursor: null } })}\n`);
    const start = await startRequest;
    expect(start).toMatchObject({ method: "thread/start", params: {
      cwd: "/exact/workspace", model: "gpt-5.6-sol", approvalPolicy: "on-request", sandbox: "workspace-write",
    } });
    input.write(`${JSON.stringify({ id: start.id, result: { thread: { id: "thread-new" } } })}\n`);
    await expect(creating).resolves.toMatchObject({ id: "thread-new", cwd: "/exact/workspace" });

    const turnRequest = nextRequest(output);
    const sending = adapter.startTask("thread-new", "Start work", "/exact/workspace");
    const turn = await turnRequest;
    expect(turn).toMatchObject({ method: "turn/start", params: {
      threadId: "thread-new", model: "gpt-5.6-sol", effort: "high",
    } });
    input.write(`${JSON.stringify({ id: turn.id, result: { turn: { id: "turn-new" } } })}\n`);
    await expect(sending).resolves.toBe("turn-new");
    await adapter.close();
  });

  it("selects a same-server loaded thread through read-only protocol calls and hydrates active turns", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const loadedRequest = nextRequest(output);
    const pending = adapter.attach("thread-live", "joinLive");
    const loaded = await loadedRequest;
    expect(loaded).toMatchObject({ method: "thread/loaded/list", params: { limit: 1_000 } });
    const readRequest = nextRequest(output);
    input.write(`${JSON.stringify({ id: loaded.id, result: { data: ["thread-live"], nextCursor: null } })}\n`);

    const read = await readRequest;
    expect(read).toMatchObject({ method: "thread/read", params: { threadId: "thread-live", includeTurns: false } });
    const turnsRequest = nextRequest(output);
    input.write(`${JSON.stringify({
      id: read.id,
      result: { thread: {
        id: "thread-live", cwd: "C:\\Fixture", name: "Live", preview: "Live", updatedAt: 1,
        status: { type: "active", activeFlags: [] }, turns: [], canAcceptDirectInput: true,
      } },
    })}\n`);

    const turns = await turnsRequest;
    expect(turns).toMatchObject({
      method: "thread/turns/list",
      params: { threadId: "thread-live", limit: 20, sortDirection: "desc", itemsView: "summary" },
    });
    input.write(`${JSON.stringify({
      id: turns.id,
      result: { data: [{ id: "turn-running", status: "inProgress", items: [] }], nextCursor: null },
    })}\n`);
    await expect(pending).resolves.toMatchObject({
      id: "thread-live", topology: "sharedLive", loaded: true, canAcceptDirectInput: true,
      turns: [{ id: "turn-running", status: "inProgress" }],
    });
    await adapter.close();
  });

  it("temporarily resumes to replay an approval and unsubscribes immediately after the decision", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));

    input.write(`${JSON.stringify({ method: "turn/started", params: {
      threadId: "thread-live", turn: { id: "turn-live" },
    } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumePromise = nextRequest(output);
    input.write(`${JSON.stringify({ method: "thread/status/changed", params: {
      threadId: "thread-live", status: { type: "active", activeFlags: ["waitingOnApproval"] },
    } })}\n`);
    const resume = await resumePromise;
    expect(resume).toMatchObject({ method: "thread/resume", params: { threadId: "thread-live", excludeTurns: true } });
    input.write(`${JSON.stringify({ id: resume.id, result: { thread: { id: "thread-live" } } })}\n`);

    input.write(`${JSON.stringify({ id: 91, method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-live", turnId: "turn-live", itemId: "item-live", command: "safe command",
    } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toContain("approval.pending");

    const writes: Array<{ id: number; method?: string; params?: unknown; result?: unknown }> = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) if (line) writes.push(JSON.parse(line));
    });
    adapter.resolveApproval(91, "accept");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const decision = writes.find((entry) => entry.id === 91);
    expect(decision).toMatchObject({ id: 91, result: { decision: "accept" } });
    const unsubscribe = writes.find((entry) => entry.method === "thread/unsubscribe")!;
    expect(unsubscribe).toMatchObject({ method: "thread/unsubscribe", params: { threadId: "thread-live" } });
    input.write(`${JSON.stringify({ id: unsubscribe.id, result: { status: "unsubscribed" } })}\n`);
    await adapter.close();
  });

  it("subscribes only while the selected live turn is active and releases after completion", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const events: CodexEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    adapter.observeSession("thread-live");

    input.write(`${JSON.stringify({ method: "turn/started", params: {
      threadId: "thread-live", turn: { id: "turn-live" },
    } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumePromise = nextRequest(output);
    input.write(`${JSON.stringify({ method: "thread/status/changed", params: {
      threadId: "thread-live", status: { type: "active", activeFlags: [] },
    } })}\n`);
    const resume = await resumePromise;
    expect(resume).toMatchObject({ method: "thread/resume", params: { threadId: "thread-live", excludeTurns: true } });
    input.write(`${JSON.stringify({ id: resume.id, result: { thread: { id: "thread-live" } } })}\n`);
    input.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: {
      threadId: "thread-live", turnId: "turn-live", itemId: "message-live", delta: "Visible output",
    } })}\n`);

    const finalSnapshotPromise = nextRequest(output);
    input.write(`${JSON.stringify({ method: "turn/completed", params: {
      threadId: "thread-live", turn: { id: "turn-live", status: "completed", error: null },
    } })}\n`);
    const finalSnapshot = await finalSnapshotPromise;
    expect(finalSnapshot).toMatchObject({ method: "thread/turns/list", params: {
      threadId: "thread-live", itemsView: "full",
    } });
    const unsubscribePromise = nextRequest(output);
    input.write(`${JSON.stringify({ id: finalSnapshot.id, result: {
      data: [{ id: "turn-live", status: "completed", items: [{ type: "agentMessage", id: "message-live", text: "Visible output" }] }],
      nextCursor: null,
    } })}\n`);
    const unsubscribe = await unsubscribePromise;
    expect(unsubscribe).toMatchObject({ method: "thread/unsubscribe", params: { threadId: "thread-live" } });
    input.write(`${JSON.stringify({ id: unsubscribe.id, result: { status: "unsubscribed" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toContainEqual(expect.objectContaining({
      type: "message.delta", sessionId: "thread-live", turnId: "turn-live", itemId: "message-live", text: "Visible output",
    }));
    await adapter.close();
  });

  it("immediately subscribes and snapshots an already-active selected turn", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const events: CodexEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    adapter.observeSession("thread-live");
    const resumePromise = nextRequest(output);
    const observing = adapter.observeActiveTurn("thread-live", "turn-live");
    const resume = await resumePromise;
    expect(resume).toMatchObject({ method: "thread/resume", params: { threadId: "thread-live", excludeTurns: true } });
    const snapshotPromise = nextRequest(output);
    input.write(`${JSON.stringify({ id: resume.id, result: { thread: { id: "thread-live" } } })}\n`);
    const snapshot = await snapshotPromise;
    expect(snapshot).toMatchObject({ method: "thread/turns/list", params: { threadId: "thread-live", itemsView: "full" } });
    input.write(`${JSON.stringify({ id: snapshot.id, result: {
      data: [{ id: "turn-live", status: "inProgress", items: [{ type: "agentMessage", id: "answer", text: "BEFORE_JOIN_MARKER" }] }],
      nextCursor: null,
    } })}\n`);
    await expect(observing).resolves.toMatchObject({
      sessionId: "thread-live", turnId: "turn-live", status: "inProgress",
      items: [{ itemId: "answer", text: "BEFORE_JOIN_MARKER" }],
    });
    input.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: {
      threadId: "thread-live", turnId: "turn-live", itemId: "answer", delta: "AFTER_JOIN_MARKER",
    } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toContainEqual(expect.objectContaining({
      type: "message.delta", sessionId: "thread-live", turnId: "turn-live", text: "AFTER_JOIN_MARKER",
    }));
    await adapter.close();
  });

  it("classifies an active-writer failure on an unloaded stored thread as foreign App Server ownership", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const adapter = new AppServerCodexAdapter(peer);
    const outbound = nextRequest(output);
    const pending = adapter.attach("thread-foreign", "resumeHistorical");
    const resume = await outbound;
    expect(resume).toMatchObject({
      method: "thread/resume", params: { threadId: "thread-foreign", excludeTurns: false },
    });
    input.write(`${JSON.stringify({ id: resume.id, error: { code: -32000, message: "thread already has an active writer" } })}\n`);
    await expect(pending).rejects.toBeInstanceOf(ForeignActiveSessionError);
    await adapter.close();
  });
});
