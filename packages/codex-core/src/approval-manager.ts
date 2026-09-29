import type { RpcId } from "../../../apps/ipc-probe/src/rpc-types.js";
import type { CodexAdapter } from "./codex-adapter.js";

export interface PendingApproval {
  id: string;
  kind: "command" | "file";
  sessionId: string;
  turnId: string;
  itemId: string;
  status: "pending" | "resolved";
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
}

interface ApprovalRecord extends PendingApproval {
  requestId: RpcId;
}

function requestKey(sessionId: string, requestId: RpcId): string {
  return `${sessionId}:${typeof requestId}:${String(requestId)}`;
}

export class ApprovalManager {
  readonly #adapter: CodexAdapter;
  readonly #approvals = new Map<string, ApprovalRecord>();
  readonly #byRequest = new Map<string, string>();
  readonly #unsubscribe: () => void;
  #nextId = 1;

  constructor(adapter: CodexAdapter) {
    this.#adapter = adapter;
    this.#unsubscribe = adapter.subscribe((event) => {
      if (event.type === "approval.pending") {
        const key = requestKey(event.approval.sessionId, event.approval.requestId);
        const existingId = this.#byRequest.get(key);
        if (existingId && this.#approvals.get(existingId)?.status === "pending") return;
        const id = `approval-${this.#nextId++}`;
        const record: ApprovalRecord = {
          id,
          requestId: event.approval.requestId,
          kind: event.approval.kind,
          sessionId: event.approval.sessionId,
          turnId: event.approval.turnId,
          itemId: event.approval.itemId,
          status: "pending",
          ...(event.approval.command !== undefined ? { command: event.approval.command } : {}),
          ...(event.approval.cwd !== undefined ? { cwd: event.approval.cwd } : {}),
          ...(event.approval.reason !== undefined ? { reason: event.approval.reason } : {}),
          ...(event.approval.grantRoot !== undefined ? { grantRoot: event.approval.grantRoot } : {}),
        };
        this.#approvals.set(id, record);
        this.#byRequest.set(key, id);
      } else if (event.type === "approval.resolved") {
        const id = this.#byRequest.get(requestKey(event.sessionId, event.requestId));
        const approval = id ? this.#approvals.get(id) : undefined;
        if (approval) approval.status = "resolved";
      } else if (event.type === "task.completed") {
        for (const approval of this.#approvals.values()) {
          if (approval.sessionId === event.sessionId && approval.turnId === event.turnId) approval.status = "resolved";
        }
      } else if (event.type === "connection.closed") {
        for (const approval of this.#approvals.values()) approval.status = "resolved";
      }
    });
  }

  pending(sessionId?: string): PendingApproval[] {
    return [...this.#approvals.values()]
      .filter((approval) => approval.status === "pending" && (!sessionId || approval.sessionId === sessionId))
      .map(({ requestId: _requestId, ...approval }) => approval);
  }

  approve(id: string): void {
    this.#decide(id, "accept");
  }

  deny(id: string): void {
    this.#decide(id, "decline");
  }

  close(): void {
    this.#unsubscribe();
    for (const approval of this.#approvals.values()) approval.status = "resolved";
  }

  #decide(id: string, decision: "accept" | "decline"): void {
    const approval = this.#approvals.get(id);
    if (!approval || approval.status !== "pending") throw new Error(`Approval is stale, resolved, or unknown: ${id}`);
    approval.status = "resolved";
    this.#adapter.resolveApproval(approval.requestId, decision);
  }
}
