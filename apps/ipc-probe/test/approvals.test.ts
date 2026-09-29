import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/approvals.js";
import { JsonRpcPeer } from "../src/json-rpc-peer.js";

function setup(): { approvals: ApprovalManager; output: PassThrough; peer: JsonRpcPeer } {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonRpcPeer(input, output);
  return { approvals: new ApprovalManager(peer), output, peer };
}

const commandRequest = {
  id: "apr_1",
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "item_1",
    startedAtMs: 1,
    command: "echo safe",
  },
} as const;

describe("ApprovalManager", () => {
  it("responds once with the generated decision wire shape", async () => {
    const { approvals, output, peer } = setup();
    approvals.observe(commandRequest);
    const response = new Promise<string>((resolve) => output.once("data", (chunk) => resolve(chunk.toString())));
    approvals.decide("apr_1", "accept");
    expect(JSON.parse(await response)).toEqual({ id: "apr_1", result: { decision: "accept" } });
    expect(() => approvals.decide("apr_1", "accept")).toThrow("stale, resolved, or unknown");
    await peer.close();
  });

  it("marks approvals stale when a turn completes", async () => {
    const { approvals, peer } = setup();
    approvals.observe(commandRequest);
    approvals.observe({
      method: "turn/completed",
      params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } },
    });
    expect(approvals.pending()).toEqual([]);
    await peer.close();
  });

  it("marks approvals resolved from server notifications", async () => {
    const { approvals, peer } = setup();
    approvals.observe(commandRequest);
    approvals.observe({
      method: "serverRequest/resolved",
      params: { threadId: "thr_1", requestId: "apr_1" },
    });
    expect(approvals.pending()).toEqual([]);
    await peer.close();
  });

  it("rejects duplicate pending request IDs", async () => {
    const { approvals, peer } = setup();
    approvals.observe(commandRequest);
    expect(() => approvals.observe(commandRequest)).toThrow("Duplicate pending approval request");
    await peer.close();
  });
});
