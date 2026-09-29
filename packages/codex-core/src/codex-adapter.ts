import type { RpcId } from "../../../apps/ipc-probe/src/rpc-types.js";
import type { ActiveTurnSnapshot, CodexEventListener, CodexSession, ConversationPreview } from "./domain-events.js";

export interface SessionQuery {
  cwd?: string;
}

export type SessionAttachMode = "joinLive" | "resumeHistorical";

export interface CodexModelReasoningEffort {
  reasoningEffort: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: CodexModelReasoningEffort[];
  isDefault: boolean;
}

export interface NewConversationOptions {
  model: string;
  reasoningEffort: string;
}

export class ForeignActiveSessionError extends Error {
  constructor() {
    super("The conversation has an active writer on a different App Server.");
  }
}

export class SessionNoLongerLiveError extends Error {
  constructor() {
    super("The conversation is no longer loaded on the shared App Server.");
  }
}

export interface CodexAdapter {
  listSessions(query?: SessionQuery): Promise<CodexSession[]>;
  listModels?(): Promise<CodexModel[]>;
  createSession?(cwd: string, options: NewConversationOptions): Promise<CodexSession>;
  attach(sessionId: string, mode: SessionAttachMode): Promise<CodexSession>;
  observeSession(sessionId: string | null): void;
  observeActiveTurn?(sessionId: string, turnId: string): Promise<ActiveTurnSnapshot | null>;
  readTurnSnapshot?(sessionId: string, turnId: string): Promise<ActiveTurnSnapshot | null>;
  readConversationPreview(sessionId: string, turnLimit: number): Promise<ConversationPreview>;
  startTask(sessionId: string, prompt: string, cwd?: string): Promise<string>;
  interruptTask(sessionId: string, turnId: string): Promise<void>;
  resolveApproval(requestId: RpcId, decision: "accept" | "decline"): void;
  subscribe(listener: CodexEventListener): () => void;
  close(): Promise<void>;
}
