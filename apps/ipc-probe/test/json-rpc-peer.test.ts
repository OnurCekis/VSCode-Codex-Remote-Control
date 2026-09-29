import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonLineDecoder } from "../src/json-line-decoder.js";
import { JsonRpcPeer, rpcMessageCheckpoint } from "../src/json-rpc-peer.js";
import { RpcProtocolError, RpcRemoteError } from "../src/rpc-types.js";

function createPeer(timeout = 500): {
  peer: JsonRpcPeer;
  serverToClient: PassThrough;
  clientToServer: PassThrough;
} {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const peer = new JsonRpcPeer(serverToClient, clientToServer, { requestTimeoutMs: timeout });
  return { peer, serverToClient, clientToServer };
}

describe("JsonLineDecoder", () => {
  it("decodes fragmented and multiple frames", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"id":1,"res')).toEqual([]);
    expect(decoder.push('ult":{}}\n{"method":"turn/started"}\n')).toEqual([
      { id: 1, result: {} },
      { method: "turn/started" },
    ]);
  });

  it("rejects malformed and incomplete frames", () => {
    const malformed = new JsonLineDecoder();
    expect(() => malformed.push("{nope}\n")).toThrow(RpcProtocolError);
    const incomplete = new JsonLineDecoder();
    incomplete.push('{"id"');
    expect(() => incomplete.finish()).toThrow(RpcProtocolError);
  });
});

describe("JsonRpcPeer", () => {
  it("correlates request responses", async () => {
    const { peer, serverToClient, clientToServer } = createPeer();
    const outbound = new Promise<string>((resolve) => clientToServer.once("data", (chunk) => resolve(chunk.toString())));
    const result = peer.request("thread/list", { limit: 1 });
    expect(JSON.parse(await outbound)).toEqual({ method: "thread/list", id: 1, params: { limit: 1 } });
    serverToClient.write('{"id":1,"result":{"data":[]}}\n');
    await expect(result).resolves.toEqual({ data: [] });
    await peer.close();
  });

  it("exposes an inbound response checkpoint for race-free snapshot reconciliation", async () => {
    const { peer, serverToClient } = createPeer();
    const iterator = peer.messages()[Symbol.asyncIterator]();
    const result = peer.requestWithCheckpoint("thread/turns/list", {});
    serverToClient.write('{"method":"item/agentMessage/delta","params":{"delta":"before"}}\n');
    serverToClient.write('{"id":1,"result":{"data":[]}}\n');
    const notification = await iterator.next();
    expect(notification.done).toBe(false);
    expect(rpcMessageCheckpoint(notification.value!)).toBe(1);
    await expect(result).resolves.toEqual({ result: { data: [] }, checkpoint: 2 });
    await peer.close();
  });

  it("surfaces remote errors", async () => {
    const { peer, serverToClient } = createPeer();
    const result = peer.request("thread/read", {});
    serverToClient.write('{"id":1,"error":{"code":-1,"message":"no thread"}}\n');
    await expect(result).rejects.toBeInstanceOf(RpcRemoteError);
    await peer.close();
  });

  it("reports duplicate response IDs", async () => {
    const protocolError = vi.fn();
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const peer = new JsonRpcPeer(serverToClient, clientToServer, { onProtocolError: protocolError });
    const result = peer.request("thread/list", {});
    serverToClient.write('{"id":1,"result":{}}\n');
    await result;
    serverToClient.write('{"id":1,"result":{}}\n');
    await vi.waitFor(() => expect(protocolError).toHaveBeenCalled());
    expect(protocolError.mock.calls[0]?.[0]).toBeInstanceOf(RpcProtocolError);
    await peer.close();
  });

  it("times out unanswered requests", async () => {
    const { peer } = createPeer(10);
    await expect(peer.request("thread/list", {})).rejects.toThrow("timed out");
    await peer.close();
  });

  it("rejects pending requests when the transport exits", async () => {
    const { peer, serverToClient } = createPeer();
    const result = peer.request("thread/list", {});
    serverToClient.end();
    await expect(result).rejects.toThrow("transport ended");
  });

  it("yields server requests and notifications", async () => {
    const { peer, serverToClient } = createPeer();
    const iterator = peer.messages()[Symbol.asyncIterator]();
    serverToClient.write('{"id":"apr_1","method":"item/fileChange/requestApproval","params":{}}\n');
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { id: "apr_1", method: "item/fileChange/requestApproval", params: {} },
    });
    await peer.close();
  });
});
