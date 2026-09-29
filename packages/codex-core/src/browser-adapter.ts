export interface BrowserRouteIdentity {
  runtimeId: string;
  threadId: string;
  turnId: string;
}

export interface BrowserProtocolIdentity {
  /** Opaque identity of the one configured MCP endpoint; never a URL-based routing hint. */
  mcpEndpointId: string;
  browserContextId: string | null;
  pageId: string | null;
  pageIndex: number | null;
  evidence: "protocolIds" | "empiricalSharedContext";
}

export interface BrowserViewport { width: number; height: number }

export interface BrowserPageState {
  identity: BrowserProtocolIdentity;
  url: string;
  viewport: BrowserViewport | null;
}

export interface BrowserConsoleError {
  text: string;
  url: string | null;
  timestamp: number;
}

export interface BrowserObservationState {
  route: BrowserRouteIdentity;
  connection: "connected" | "disconnected";
  page: BrowserPageState | null;
}

export interface BrowserScreenshot {
  route: BrowserRouteIdentity;
  page: BrowserPageState;
  mimeType: "image/png";
  data: Uint8Array;
}

export type BrowserAdapterEvent =
  | { type: "connection.changed"; state: BrowserObservationState }
  | { type: "page.changed"; state: BrowserObservationState }
  | { type: "page.disappeared"; state: BrowserObservationState; identity: BrowserProtocolIdentity }
  | { type: "console.error"; state: BrowserObservationState; error: BrowserConsoleError };

export type BrowserAdapterListener = (event: BrowserAdapterEvent) => void;

/**
 * Presentation-independent observation of one already-proven browser route.
 * Implementations observe an existing browser only; screenshot() must never launch one.
 */
export interface BrowserAdapter {
  state(): BrowserObservationState;
  screenshot(): Promise<BrowserScreenshot>;
  consoleErrors(): readonly BrowserConsoleError[];
  subscribe(listener: BrowserAdapterListener): () => void;
  close(): Promise<void>;
}
