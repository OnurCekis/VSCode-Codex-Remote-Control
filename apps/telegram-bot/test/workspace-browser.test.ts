import { describe, expect, it } from "vitest";
import type { WorkspaceDirectoryPage, WorkspaceState } from "../../../packages/codex-core/src/workspace-manager.js";
import {
  renderWorkspaceDirectory,
  renderWorkspaceHome,
  renderWorkspaceRoots,
  WorkspaceCallbackRegistry,
} from "../src/workspace-browser.js";

describe("Telegram workspace browser", () => {
  it("renders recent workspaces and roots with opaque callbacks that contain no paths", () => {
    let sequence = 0;
    const registry = new WorkspaceCallbackRegistry({ handle: () => `opaque_${++sequence}` });
    const state: WorkspaceState = {
      activeWorkspace: { path: "C:\\private\\Project", displayName: "Project" },
      recentWorkspaces: [{ path: "C:\\private\\Project", displayName: "Project" }],
    };
    const rendered = renderWorkspaceHome(state, (action) => registry.create(action, 42, 42));
    expect(rendered.text).toContain("Project");
    expect(rendered.text).not.toContain("C:\\private");
    expect(rendered.buttons.flat().every((button) => /^workspace:opaque_\d+$/u.test(button.callbackData))).toBe(true);
    expect(rendered.buttons.flat().some((button) => button.callbackData.includes("private"))).toBe(false);
    const roots = renderWorkspaceRoots(
      [{ path: "C:\\Users\\Person\\Desktop", displayName: "Desktop" }, { path: "D:\\Projects", displayName: "Projects" }],
      (action) => registry.create(action, 42, 42),
    );
    expect(roots.buttons.flat().map((button) => button.text)).toEqual(["Desktop", "Projects", "Back"]);
    expect(roots.text).toContain("allowed location");
  });

  it("renders directory pagination, parent, selection, and empty folders", () => {
    const listing: WorkspaceDirectoryPage = {
      directory: { path: "C:\\Parent", displayName: "Parent" },
      browseRoot: { path: "C:\\Parent", displayName: "Desktop" },
      parent: "C:\\",
      directories: [{ path: "C:\\Parent\\Child", displayName: "Child" }],
      page: 1,
      pages: 3,
    };
    const rendered = renderWorkspaceDirectory(listing, () => "workspace:opaque");
    expect(rendered.buttons.flat().map((button) => button.text)).toEqual([
      "Child", "‹ Previous", "Next ›", "↑ Parent", "✓ Use this folder", "Cancel",
    ]);
    expect(rendered.text).toContain("Desktop");
    expect(rendered.text).not.toContain("C:\\Parent");
    const empty = renderWorkspaceDirectory({ ...listing, directories: [], page: 0, pages: 1, parent: null }, () => "workspace:opaque");
    expect(empty.text).toContain("no browsable subdirectories");
  });

  it("scopes short-lived exact-path mappings to one user and private chat", () => {
    let now = 1_000;
    let sequence = 0;
    const registry = new WorkspaceCallbackRegistry({ ttlMs: 10, now: () => now, handle: () => `secure_${++sequence}` });
    const action = { type: "directory" as const, path: "C:\\Exact\\Folder", page: 0 };
    const first = registry.create(action, 42, 42);
    expect(registry.consume(first, 7, 42)).toBeNull();
    expect(registry.consume(first, 42, 7)).toBeNull();
    expect(registry.consume(first, 42, 42)).toEqual(action);
    expect(registry.consume(first, 42, 42)).toBeNull();
    const expired = registry.create(action, 42, 42);
    now += 11;
    expect(registry.consume(expired, 42, 42)).toBeNull();
    expect(registry.consume("workspace:unknown", 42, 42)).toBeNull();
  });

  it("maps an exact path rather than a mutable folder position", () => {
    const registry = new WorkspaceCallbackRegistry({ handle: () => "position_safe" });
    const callback = registry.create({ type: "select", path: "C:\\Original", }, 42, 42);
    expect(registry.consume(callback, 42, 42)).toEqual({ type: "select", path: "C:\\Original" });
  });
});
