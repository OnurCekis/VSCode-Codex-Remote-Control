import { describe, expect, it } from "vitest";
import type {
  BrowserAdapter,
  BrowserAdapterEvent,
  BrowserAdapterListener,
  BrowserConsoleError,
  BrowserObservationState,
  BrowserRouteIdentity,
  BrowserScreenshot,
} from "../src/browser-adapter.js";
import { BrowserManager, MAX_BROWSER_CONSOLE_ERRORS } from "../src/browser-manager.js";

const route: BrowserRouteIdentity = { runtimeId: "runtime-a", threadId: "thread-a", turnId: "turn-a" };
const identity = {
  mcpEndpointId: "mcp-runtime-a",
  browserContextId: null,
  pageId: null,
  pageIndex: 0,
  evidence: "empiricalSharedContext" as const,
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

class FakeBrowserAdapter implements BrowserAdapter {
  listeners = new Set<BrowserAdapterListener>();
  screenshotCalls = 0;
  closeCalls = 0;
  errors: BrowserConsoleError[] = [];
  current: BrowserObservationState = {
    route,
    connection: "connected",
    page: { identity, url: "http://127.0.0.1/fixture", viewport: { width: 1280, height: 720 } },
  };

  state(): BrowserObservationState { return structuredClone(this.current); }
  async screenshot(): Promise<BrowserScreenshot> {
    this.screenshotCalls += 1;
    if (!this.current.page) throw new Error("no page");
    return { route: structuredClone(this.current.route), page: structuredClone(this.current.page), mimeType: "image/png", data: structuredClone(png) };
  }
  consoleErrors(): readonly BrowserConsoleError[] { return structuredClone(this.errors); }
  subscribe(listener: BrowserAdapterListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.closeCalls += 1; }
  emit(event: BrowserAdapterEvent): void { for (const listener of [...this.listeners]) listener(event); }
}

describe("BrowserManager", () => {
  it("routes only by exact runtime/thread/turn identity and never by URL", async () => {
    const adapter = new FakeBrowserAdapter();
    const manager = new BrowserManager();
    manager.register(route, adapter);
    expect(manager.currentPage(route)?.url).toBe("http://127.0.0.1/fixture");
    const otherRoute = { ...route, threadId: "thread-b" };
    expect(() => manager.currentPage(otherRoute)).toThrow(/No browser observer/u);
    await expect(manager.screenshot(otherRoute)).rejects.toThrow(/No browser observer/u);
    expect(adapter.screenshotCalls).toBe(0);
    await manager.close();
  });

  it("returns screenshot, URL, nullable viewport and bounded adapter console state without launching a fallback", async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.errors.push({ text: "fixture error", url: adapter.current.page!.url, timestamp: 1 });
    const manager = new BrowserManager();
    manager.register(route, adapter);
    const screenshot = await manager.screenshot(route);
    expect([...screenshot.data]).toEqual([...png]);
    expect(screenshot.page.url).toBe(adapter.current.page!.url);
    expect(screenshot.page.viewport).toEqual({ width: 1280, height: 720 });
    expect(manager.consoleErrors(route)).toEqual(adapter.errors);
    expect(adapter.screenshotCalls).toBe(1);
    await manager.close();
  });

  it("fails clearly for disconnected or disappeared pages and forwards lifecycle events", async () => {
    const adapter = new FakeBrowserAdapter();
    const manager = new BrowserManager();
    const events: BrowserAdapterEvent[] = [];
    manager.subscribe((event) => events.push(event));
    manager.register(route, adapter);
    const oldIdentity = adapter.current.page!.identity;
    adapter.current = { ...adapter.current, page: null };
    adapter.emit({ type: "page.disappeared", state: adapter.state(), identity: oldIdentity });
    await expect(manager.screenshot(route)).rejects.toThrow(/No exact observed browser page/u);
    adapter.current = { ...adapter.current, connection: "disconnected" };
    adapter.emit({ type: "connection.changed", state: adapter.state() });
    expect(() => manager.currentPage(route)).toThrow(/disconnected/u);
    expect(events.map((event) => event.type)).toEqual(["page.disappeared", "connection.changed"]);
    await manager.unregister(route);
    expect(adapter.closeCalls).toBe(1);
  });

  it("prevents duplicate observers and closes every adapter exactly once", async () => {
    const first = new FakeBrowserAdapter();
    const second = new FakeBrowserAdapter();
    const manager = new BrowserManager();
    manager.register(route, first);
    expect(() => manager.register(route, second)).toThrow(/already registered/u);
    first.current = { ...first.current, route: { ...route, threadId: "thread-b" } };
    expect(() => manager.register(first.current.route, first)).toThrow(/already registered/u);
    await Promise.all([manager.close(), manager.close()]);
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(0);
    expect(() => manager.register(route, second)).toThrow(/closed/u);
    expect(() => manager.subscribe(() => undefined)).toThrow(/closed/u);
  });

  it("validates identity, viewport, PNG data, and bounds immutable console errors", async () => {
    const adapter = new FakeBrowserAdapter();
    const manager = new BrowserManager();
    manager.register(route, adapter);
    adapter.errors = Array.from({ length: MAX_BROWSER_CONSOLE_ERRORS + 5 }, (_, index) => ({ text: `error-${index}`, url: null, timestamp: index }));
    const errors = manager.consoleErrors(route);
    expect(errors).toHaveLength(MAX_BROWSER_CONSOLE_ERRORS);
    expect(errors[0]?.text).toBe("error-5");
    adapter.errors[5]!.text = "mutated";
    expect(errors[0]?.text).toBe("error-5");

    adapter.screenshot = async () => ({ route, page: adapter.current.page!, mimeType: "image/png", data: new Uint8Array([1, 2, 3]) });
    await expect(manager.screenshot(route)).rejects.toThrow(/valid PNG/u);
    adapter.current = { ...adapter.current, page: { ...adapter.current.page!, viewport: { width: 0, height: 720 } } };
    expect(() => manager.state(route)).toThrow(/viewport/u);
    await manager.close();
  });

  it("rejects mismatched registration and identity changes during capture", async () => {
    const mismatched = new FakeBrowserAdapter();
    mismatched.current = { ...mismatched.current, route: { ...route, runtimeId: "other" } };
    const manager = new BrowserManager();
    expect(() => manager.register(route, mismatched)).toThrow(/does not match/u);

    const adapter = new FakeBrowserAdapter();
    const originalScreenshot = adapter.screenshot.bind(adapter);
    adapter.screenshot = async () => {
      const screenshot = await originalScreenshot();
      return { ...screenshot, page: { ...screenshot.page, identity: { ...screenshot.page.identity, pageIndex: 1 } } };
    };
    manager.register(route, adapter);
    await expect(manager.screenshot(route)).rejects.toThrow(/identity changed/u);
    const wrongState = { ...adapter.state(), route: { ...route, threadId: "wrong" } };
    expect(() => adapter.emit({ type: "connection.changed", state: wrongState })).toThrow(/different Pocket context/u);
    await manager.close();
  });
});
