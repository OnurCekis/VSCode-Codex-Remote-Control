import { randomBytes } from "node:crypto";
import { workspacePathsEqual, type Workspace, type WorkspaceDirectoryPage, type WorkspaceState } from "../../../packages/codex-core/src/workspace-manager.js";
import type { WorkspaceRuntime } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import type { InlineButton } from "./telegram-port.js";

export type WorkspaceAction =
  | { type: "home" }
  | { type: "roots" }
  | { type: "directory"; path: string; page: number }
  | { type: "browseSelect"; path: string }
  | { type: "select"; path: string }
  | { type: "open"; path: string };

interface WorkspaceCallbackEntry {
  action: WorkspaceAction;
  userId: number;
  chatId: number;
  expiresAt: number;
}

export class WorkspaceCallbackRegistry {
  readonly #entries = new Map<string, WorkspaceCallbackEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #handle: () => string;

  constructor(options: { ttlMs?: number; now?: () => number; handle?: () => string } = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#handle = options.handle ?? (() => randomBytes(9).toString("base64url"));
  }

  create(action: WorkspaceAction, userId: number, chatId: number): string {
    this.#purge();
    let handle: string;
    do handle = this.#handle(); while (this.#entries.has(handle));
    this.#entries.set(handle, { action, userId, chatId, expiresAt: this.#now() + this.#ttlMs });
    return `workspace:${handle}`;
  }

  consume(data: string, userId: number, chatId: number): WorkspaceAction | null {
    if (!/^workspace:[A-Za-z0-9_-]{4,48}$/u.test(data)) return null;
    const handle = data.slice("workspace:".length);
    const entry = this.#entries.get(handle);
    if (!entry || entry.userId !== userId || entry.chatId !== chatId || entry.expiresAt <= this.#now()) {
      if (entry && entry.expiresAt <= this.#now()) this.#entries.delete(handle);
      return null;
    }
    this.#entries.delete(handle);
    return entry.action;
  }

  #purge(): void {
    const now = this.#now();
    for (const [handle, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(handle);
  }
}

function short(value: string, limit = 48): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function renderWorkspaceHome(
  state: WorkspaceState,
  callback: (action: WorkspaceAction) => string,
  display: (value: string) => string = (value) => value,
  runtimes: readonly WorkspaceRuntime[] = [],
): { text: string; buttons: InlineButton[][] } {
  const lines = ["Workspaces", "", "Active:", state.activeWorkspace ? display(state.activeWorkspace.displayName) : "No active workspace selected."];
  lines.push("", "Recent:");
  const buttons: InlineButton[][] = state.recentWorkspaces.map((workspace) => {
    const connected = runtimes.some((runtime) => runtime.state === "connected" &&
      workspacePathsEqual(runtime.workspace.path, workspace.path));
    return [{
      text: `${connected ? "●" : "○"} ${short(display(workspace.displayName), 44)}`,
      callbackData: callback({ type: "select", path: workspace.path }),
    }];
  });
  if (!state.recentWorkspaces.length) lines.push("No recent workspaces.");
  buttons.push([{ text: "Browse project locations...", callbackData: callback({ type: "roots" }) }]);
  return { text: lines.join("\n"), buttons };
}

export function renderWorkspaceRoots(
  roots: Workspace[],
  callback: (action: WorkspaceAction) => string,
  display: (value: string) => string = (value) => value,
): { text: string; buttons: InlineButton[][] } {
  const buttons: InlineButton[][] = roots.map((root) => [{
    text: display(root.displayName), callbackData: callback({ type: "directory", path: root.path, page: 0 }),
  }]);
  buttons.push([{ text: "Back", callbackData: callback({ type: "home" }) }]);
  return {
    text: roots.length ? "Project locations\n\nChoose an allowed location:" :
      "Project locations\n\nNo allowed project locations were found.",
    buttons,
  };
}

export function renderWorkspaceDirectory(
  listing: WorkspaceDirectoryPage,
  callback: (action: WorkspaceAction) => string,
  display: (value: string) => string = (value) => value,
): { text: string; buttons: InlineButton[][] } {
  const buttons: InlineButton[][] = listing.directories.map((directory) => [{
    text: short(display(directory.displayName)), callbackData: callback({ type: "directory", path: directory.path, page: 0 }),
  }]);
  const navigation: InlineButton[] = [];
  if (listing.page > 0) navigation.push({
    text: "‹ Previous", callbackData: callback({ type: "directory", path: listing.directory.path, page: listing.page - 1 }),
  });
  if (listing.page + 1 < listing.pages) navigation.push({
    text: "Next ›", callbackData: callback({ type: "directory", path: listing.directory.path, page: listing.page + 1 }),
  });
  if (navigation.length) buttons.push(navigation);
  if (listing.parent) buttons.push([{
    text: "↑ Parent", callbackData: callback({ type: "directory", path: listing.parent, page: 0 }),
  }]);
  buttons.push([{
    text: "✓ Use this folder", callbackData: callback({ type: "browseSelect", path: listing.directory.path }),
  }]);
  buttons.push([{ text: "Cancel", callbackData: callback({ type: "home" }) }]);
  const empty = listing.directories.length ? "" : "\nThis folder has no browsable subdirectories.\n";
  const relative = listing.directory.path.slice(listing.browseRoot.path.length).replace(/^[\\/]+/u, "");
  const location = relative ? `${display(listing.browseRoot.displayName)}\\${display(relative)}` :
    display(listing.browseRoot.displayName);
  return {
    text: `${location}\n${empty}\nFolders · Page ${listing.page + 1}/${listing.pages}`,
    buttons,
  };
}
