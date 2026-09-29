import { z } from "zod";
import type { JsonRpcPeer } from "./json-rpc-peer.js";
import type { RpcId, RpcMessage } from "./rpc-types.js";

const baseApprovalSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  startedAtMs: z.number(),
  reason: z.string().nullable().optional(),
});

const commandApprovalSchema = baseApprovalSchema.extend({
  command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  availableDecisions: z.array(z.unknown()).nullable().optional(),
});

const fileApprovalSchema = baseApprovalSchema.extend({
  grantRoot: z.string().nullable().optional(),
});

const resolvedSchema = z.object({
  threadId: z.string(),
  requestId: z.union([z.string(), z.number()]),
});

const turnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string() }).passthrough(),
});

export interface PendingApproval {
  requestId: RpcId;
  kind: "command" | "file";
  threadId: string;
  turnId: string;
  itemId: string;
  status: "pending" | "resolved";
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
}

function key(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

export class ApprovalManager {
  readonly #peer: JsonRpcPeer;
  readonly #approvals = new Map<string, PendingApproval>();

  constructor(peer: JsonRpcPeer) {
    this.#peer = peer;
  }

  observe(message: RpcMessage): PendingApproval | null {
    if (!("id" in message)) {
      if (message.method === "serverRequest/resolved") {
        const parsed = resolvedSchema.safeParse(message.params);
        if (parsed.success) this.resolve(parsed.data.requestId);
      } else if (message.method === "turn/completed") {
        const parsed = turnCompletedSchema.safeParse(message.params);
        if (parsed.success) this.resolveTurn(parsed.data.threadId, parsed.data.turn.id);
      }
      return null;
    }

    if (message.method === "item/commandExecution/requestApproval") {
      const params = commandApprovalSchema.parse(message.params);
      return this.#add({
        requestId: message.id,
        kind: "command",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        status: "pending",
        ...(params.command !== undefined ? { command: params.command } : {}),
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      });
    }

    if (message.method === "item/fileChange/requestApproval") {
      const params = fileApprovalSchema.parse(message.params);
      return this.#add({
        requestId: message.id,
        kind: "file",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        status: "pending",
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
        ...(params.grantRoot !== undefined ? { grantRoot: params.grantRoot } : {}),
      });
    }
    return null;
  }

  pending(): PendingApproval[] {
    return [...this.#approvals.values()].filter((approval) => approval.status === "pending");
  }

  decide(requestId: RpcId, decision: "accept" | "decline"): void {
    const approval = this.#approvals.get(key(requestId));
    if (!approval || approval.status !== "pending") {
      throw new Error(`Approval ${String(requestId)} is stale, resolved, or unknown.`);
    }
    approval.status = "resolved";
    this.#peer.respond(requestId, { decision });
  }

  resolve(requestId: RpcId): void {
    const approval = this.#approvals.get(key(requestId));
    if (approval) approval.status = "resolved";
  }

  resolveTurn(threadId: string, turnId: string): void {
    for (const approval of this.#approvals.values()) {
      if (approval.threadId === threadId && approval.turnId === turnId) approval.status = "resolved";
    }
  }

  resolveAll(): void {
    for (const approval of this.#approvals.values()) approval.status = "resolved";
  }

  #add(approval: PendingApproval): PendingApproval {
    const approvalKey = key(approval.requestId);
    const existing = this.#approvals.get(approvalKey);
    if (existing?.status === "pending") {
      throw new Error(`Duplicate pending approval request: ${String(approval.requestId)}`);
    }
    this.#approvals.set(approvalKey, approval);
    return approval;
  }
}
