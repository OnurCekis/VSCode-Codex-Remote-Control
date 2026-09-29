import type {
  BrowserAdapter,
  BrowserAdapterEvent,
  BrowserAdapterListener,
  BrowserConsoleError,
  BrowserObservationState,
  BrowserRouteIdentity,
  BrowserScreenshot,
} from "./browser-adapter.js";

interface RegisteredBrowser {
  adapter: BrowserAdapter;
  unsubscribe: () => void;
}

export const MAX_BROWSER_CONSOLE_ERRORS = 100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function routeKey(route: BrowserRouteIdentity): string {
  return `${route.runtimeId}\u0000${route.threadId}\u0000${route.turnId}`;
}

function sameRoute(left: BrowserRouteIdentity, right: BrowserRouteIdentity): boolean {
  return left.runtimeId === right.runtimeId && left.threadId === right.threadId && left.turnId === right.turnId;
}

function samePageIdentity(left: BrowserObservationState["page"], right: BrowserObservationState["page"]): boolean {
  if (!left || !right) return left === right;
  return left.identity.mcpEndpointId === right.identity.mcpEndpointId &&
    left.identity.browserContextId === right.identity.browserContextId &&
    left.identity.pageId === right.identity.pageId &&
    left.identity.pageIndex === right.identity.pageIndex &&
    left.identity.evidence === right.identity.evidence;
}

function validateState(state: BrowserObservationState): void {
  if (!state.route.runtimeId || !state.route.threadId || !state.route.turnId) throw new Error("Browser route identity is incomplete.");
  if (state.connection === "disconnected" && state.page) throw new Error("A disconnected browser observer cannot expose a current page.");
  if (!state.page) return;
  const { identity, url, viewport } = state.page;
  if (!identity.mcpEndpointId) throw new Error("Browser MCP endpoint identity is missing.");
  if (identity.pageIndex !== null && (!Number.isInteger(identity.pageIndex) || identity.pageIndex < 0)) throw new Error("Browser page index is invalid.");
  if (identity.evidence === "protocolIds" && (!identity.browserContextId || !identity.pageId)) {
    throw new Error("Protocol browser identity requires context and page IDs.");
  }
  if (identity.evidence === "empiricalSharedContext" && identity.pageIndex === null) {
    throw new Error("Empirical shared-context identity requires the observed MCP page index.");
  }
  if (!url.trim()) throw new Error("Observed browser URL is empty.");
  if (viewport && (!Number.isInteger(viewport.width) || viewport.width <= 0 || !Number.isInteger(viewport.height) || viewport.height <= 0)) {
    throw new Error("Observed browser viewport is invalid.");
  }
}

function isPng(data: Uint8Array): boolean {
  return data.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

/** Exact runtime/thread/turn routing for browser observers; never routes by URL or title. */
export class BrowserManager {
  readonly #registered = new Map<string, RegisteredBrowser>();
  readonly #adapters = new Set<BrowserAdapter>();
  readonly #listeners = new Set<BrowserAdapterListener>();
  #closed = false;

  register(route: BrowserRouteIdentity, adapter: BrowserAdapter): void {
    this.#requireOpen();
    const state = adapter.state();
    validateState(state);
    if (!sameRoute(route, state.route)) throw new Error("Browser adapter route does not match the requested exact Pocket context.");
    const key = routeKey(route);
    if (this.#registered.has(key)) throw new Error("A browser adapter is already registered for this exact Pocket context.");
    if (this.#adapters.has(adapter)) throw new Error("This browser adapter is already registered to a Pocket context.");
    const unsubscribe = adapter.subscribe((event) => this.#emit(route, event));
    this.#registered.set(key, { adapter, unsubscribe });
    this.#adapters.add(adapter);
  }

  state(route: BrowserRouteIdentity): BrowserObservationState | null {
    const state = this.#registered.get(routeKey(route))?.adapter.state() ?? null;
    if (!state) return null;
    validateState(state);
    if (!sameRoute(route, state.route)) throw new Error("Browser adapter route changed unexpectedly.");
    return structuredClone(state);
  }

  currentPage(route: BrowserRouteIdentity): BrowserObservationState["page"] {
    const state = this.#requireObservable(route);
    return structuredClone(state.page);
  }

  async screenshot(route: BrowserRouteIdentity): Promise<BrowserScreenshot> {
    const registered = this.#registered.get(routeKey(route));
    const state = this.#requireObservable(route);
    if (!state.page) throw new Error("No exact observed browser page is available for this Pocket context.");
    const screenshot = await registered!.adapter.screenshot();
    if (!sameRoute(route, screenshot.route)) throw new Error("Browser adapter returned a screenshot for a different Pocket context.");
    const screenshotState: BrowserObservationState = { route: screenshot.route, connection: "connected", page: screenshot.page };
    validateState(screenshotState);
    if (!samePageIdentity(screenshot.page, state.page)) {
      throw new Error("Browser page identity changed while the screenshot was captured.");
    }
    if (screenshot.mimeType !== "image/png" || !isPng(screenshot.data)) throw new Error("Browser adapter did not return valid PNG screenshot data.");
    return structuredClone(screenshot);
  }

  consoleErrors(route: BrowserRouteIdentity): readonly BrowserConsoleError[] {
    this.#requireObservable(route);
    const errors = this.#registered.get(routeKey(route))!.adapter.consoleErrors().slice(-MAX_BROWSER_CONSOLE_ERRORS);
    for (const error of errors) {
      if (!error.text || !Number.isFinite(error.timestamp)) throw new Error("Browser adapter returned an invalid console error.");
    }
    return structuredClone(errors);
  }

  subscribe(listener: BrowserAdapterListener): () => void {
    this.#requireOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async unregister(route: BrowserRouteIdentity): Promise<void> {
    const key = routeKey(route);
    const registered = this.#registered.get(key);
    if (!registered) return;
    this.#registered.delete(key);
    this.#adapters.delete(registered.adapter);
    registered.unsubscribe();
    await registered.adapter.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const registered = [...this.#registered.values()];
    this.#registered.clear();
    this.#adapters.clear();
    this.#listeners.clear();
    for (const entry of registered) {
      entry.unsubscribe();
      await entry.adapter.close();
    }
  }

  #requireObservable(route: BrowserRouteIdentity): BrowserObservationState {
    const state = this.#registered.get(routeKey(route))?.adapter.state();
    if (!state) throw new Error("No browser observer is registered for this exact Pocket context.");
    validateState(state);
    if (!sameRoute(route, state.route)) throw new Error("Browser adapter route changed unexpectedly.");
    if (state.connection !== "connected") throw new Error("The exact observed browser is disconnected.");
    return state;
  }

  #emit(route: BrowserRouteIdentity, event: BrowserAdapterEvent): void {
    validateState(event.state);
    if (!sameRoute(route, event.state.route)) throw new Error("Browser adapter emitted an event for a different Pocket context.");
    for (const listener of [...this.#listeners]) listener(structuredClone(event));
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("BrowserManager is closed.");
  }
}
