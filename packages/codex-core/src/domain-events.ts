import type { RpcId } from "../../../apps/ipc-probe/src/rpc-types.js";

export type SessionRuntimeStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | { type: "active"; activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput"> };

export interface CodexSession {
  id: string;
  cwd: string;
  title: string;
  preview: string;
  updatedAt: number;
  loaded: boolean;
  topology: "sharedLive" | "historical" | "foreignActive";
  canAcceptDirectInput: boolean | null;
  status: SessionRuntimeStatus;
  turns: Array<{ id: string; status: string }>;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ConversationPreview {
  sessionId: string;
  messages: ConversationMessage[];
  recentTurnCount: number;
  hasOlder: boolean;
}

export interface ActiveTurnSnapshot {
  sessionId: string;
  turnId: string;
  status: string;
  checkpoint: number;
  items: Array<{ itemId: string; text: string }>;
}

export interface AdapterApproval {
  requestId: RpcId;
  kind: "command" | "file";
  sessionId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
}

export type CodexEvent =
  | { type: "session.status.changed"; sessionId: string; status: SessionRuntimeStatus }
  | { type: "task.started"; sessionId: string; turnId: string }
  | { type: "task.completed"; sessionId: string; turnId: string; status: string; error: unknown }
  | { type: "item.started" | "item.completed"; sessionId: string; turnId: string; itemId: string; itemType: string }
  | { type: "message.delta"; sessionId: string; turnId: string; itemId: string; text: string; protocolSequence?: number }
  | { type: "message.snapshot"; snapshot: ActiveTurnSnapshot }
  | { type: "approval.pending"; approval: AdapterApproval }
  | { type: "approval.resolved"; sessionId: string; requestId: RpcId }
  | { type: "connection.closed"; error?: string };

export type CodexEventListener = (event: CodexEvent) => void;
