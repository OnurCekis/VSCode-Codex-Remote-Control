import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcPeer } from "../src/json-rpc-peer.js";
import { discoverVscodeThreads } from "../src/session-discovery.js";

function thread(id: string, updatedAt: number): Record<string, unknown> {
  return {
    id,
    preview: `Conversation ${id}`,
    name: `Title ${id}`,
    cwd: "C:\\workspace",
    updatedAt,
    status: { type: "notLoaded" },
    source: "vscode",
    canAcceptDirectInput: null,
  };
}

describe("VS Code thread discovery pagination", () => {
  it("follows exact thread/list and loaded/list cursors without duplicates", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let buffered = "";
    output.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        requests.push({ method: request.method, params: request.params });
        if (request.method === "thread/list") {
          const cursor = request.params.cursor;
          const data = cursor === undefined
            ? Array.from({ length: 7 }, (_, index) => thread(`thread-${12 - index}`, 20 - index))
            : [thread("thread-5", 13), thread("thread-4", 12), thread("thread-3", 11), thread("thread-2", 10), thread("thread-1", 9), thread("thread-6", 8)];
          input.write(`${JSON.stringify({ id: request.id, result: { data, nextCursor: cursor === undefined ? "threads-next" : null, backwardsCursor: null } })}\n`);
        } else {
          const cursor = request.params.cursor;
          input.write(`${JSON.stringify({ id: request.id, result: {
            data: cursor === undefined ? ["thread-12"] : ["thread-1"],
            nextCursor: cursor === undefined ? "loaded-next" : null,
          } })}\n`);
        }
      }
    });

    const sessions = await discoverVscodeThreads(peer);
    expect(sessions).toHaveLength(12);
    expect(sessions.map((session) => session.id)).toEqual(Array.from({ length: 12 }, (_, index) => `thread-${12 - index}`));
    expect(sessions.find((session) => session.id === "thread-12")?.loaded).toBe(true);
    expect(sessions.find((session) => session.id === "thread-1")?.loaded).toBe(true);
    expect(sessions.find((session) => session.id === "thread-6")?.updatedAt).toBe(14);
    expect(requests.filter((request) => request.method === "thread/list")).toHaveLength(2);
    expect(requests.find((request) => request.params.cursor === "threads-next")?.params).toMatchObject({
      cursor: "threads-next", limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds: ["vscode"],
    });
    expect(requests.filter((request) => request.method === "thread/loaded/list")).toHaveLength(2);
    await peer.close();
  });
});
