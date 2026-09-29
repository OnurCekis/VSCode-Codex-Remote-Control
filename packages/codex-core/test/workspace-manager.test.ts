import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceManager,
  defaultWorkspaceBrowseRootCandidates,
  workspacePathKey,
  workspacePathWithin,
  workspacePathsEqual,
  type WorkspaceFileSystem,
} from "../src/workspace-manager.js";

const temporaryRoots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pocket-workspace-"));
  temporaryRoots.push(root);
  return await realpath(root);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceManager", () => {
  it("uses a valid default, persists selection, restores it, and deduplicates canonical recents", async () => {
    const root = await fixture();
    const first = path.join(root, "First");
    const second = path.join(root, "Second");
    const stateFile = path.join(root, "runtime", "workspace-state.json");
    await Promise.all([mkdir(first), mkdir(second)]);
    const manager = new WorkspaceManager({ stateFile });
    expect((await manager.initialize(path.join(first, "."))).activeWorkspace?.path).toBe(await realpath(first));
    await manager.select(second);
    await manager.select(`${second}${path.sep}`);
    expect(manager.recent.filter((entry) => workspacePathsEqual(entry.path, second))).toHaveLength(1);

    const restarted = new WorkspaceManager({ stateFile });
    await restarted.initialize(first);
    expect(restarted.active?.path).toBe(await realpath(second));
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(["activePath", "recentPaths", "version"]);
  });

  it("falls back from invalid saved state and ignores malformed state", async () => {
    const root = await fixture();
    const fallback = path.join(root, "Fallback");
    const stateFile = path.join(root, "state.json");
    await mkdir(fallback);
    await writeFile(stateFile, JSON.stringify({ version: 1, activePath: path.join(root, "gone"), recentPaths: [path.join(root, "gone")] }));
    const manager = new WorkspaceManager({ stateFile });
    expect((await manager.initialize(fallback)).activeWorkspace?.path).toBe(await realpath(fallback));
    await writeFile(stateFile, "not-json");
    const malformed = new WorkspaceManager({ stateFile });
    expect((await malformed.initialize()).activeWorkspace).toBeNull();
  });

  it("normalizes Windows identity case, separators, dot segments, and trailing separators", () => {
    expect(workspacePathsEqual("C:\\Projects\\Foo\\..\\App\\", "c:/projects/app")).toBe(true);
    expect(workspacePathKey("C:\\")).toBe("c:\\");
    expect(workspacePathWithin("C:\\Projects\\App", "c:/projects")).toBe(true);
    expect(workspacePathWithin("C:\\Projects-Private", "C:\\Projects")).toBe(false);
  });

  it("offers standard project locations without exposing drive roots or Downloads", () => {
    const candidates = defaultWorkspaceBrowseRootCandidates({
      homeDir: "C:\\Users\\Person",
      environment: { OneDrive: "D:\\Cloud" },
      extraRoots: ["E:\\Team Projects", "\\\\server\\share"],
    });
    expect(candidates).toContain("C:\\Users\\Person\\Desktop");
    expect(candidates).toContain("C:\\Users\\Person\\Documents");
    expect(candidates).toContain("C:\\Users\\Person\\Projects");
    expect(candidates).toContain("D:\\Cloud\\Desktop");
    expect(candidates).toContain("D:\\Projects");
    expect(candidates).toContain("E:\\Team Projects");
    expect(candidates).not.toContain("C:\\");
    expect(candidates.some((candidate) => candidate.endsWith("\\Downloads"))).toBe(false);
    expect(candidates.some((candidate) => candidate.startsWith("\\\\"))).toBe(false);
  });

  it("lists accessible roots and one directory level with folders only, pagination, parent and empty state", async () => {
    const root = await fixture();
    const other = await fixture();
    for (let index = 0; index < 12; index += 1) await mkdir(path.join(root, `Folder-${String(index).padStart(2, "0")}`));
    await writeFile(path.join(root, "normal-file.txt"), "not a workspace button");
    const manager = new WorkspaceManager({ rootCandidates: () => [root, other] });
    expect(await manager.listRoots()).toHaveLength(2);
    const first = await manager.listDirectory(root, 0, 10);
    expect(first.directories).toHaveLength(10);
    expect(first.pages).toBe(2);
    expect(first.parent).toBeNull();
    expect(first.browseRoot.path).toBe(await realpath(root));
    expect(first.directories.some((entry) => entry.displayName === "normal-file.txt")).toBe(false);
    expect((await manager.listDirectory(root, 1, 10)).directories).toHaveLength(2);
    expect((await manager.listDirectory(other)).directories).toHaveLength(0);
  });

  it("disambiguates duplicate project-location names without exposing a user profile name", async () => {
    const first = await fixture();
    const second = await fixture();
    const desktopA = path.join(first, "Desktop");
    const desktopB = path.join(second, "Desktop");
    await Promise.all([mkdir(desktopA), mkdir(desktopB)]);
    const roots = await new WorkspaceManager({ rootCandidates: () => [desktopA, desktopB] }).listRoots();
    expect(roots).toHaveLength(2);
    expect(roots.every((root) => root.displayName.startsWith("Desktop ("))).toBe(true);
    expect(roots.every((root) => !root.displayName.includes(os.userInfo().username))).toBe(true);
  });

  it("fails safely for access denial and deletion between rendering and selection", async () => {
    const root = await fixture();
    const denied = path.join(root, "Denied");
    const deleted = path.join(root, "Deleted");
    await Promise.all([mkdir(denied), mkdir(deleted)]);
    const fileSystem: WorkspaceFileSystem = {
      realpath, stat, access,
      readdir: async (target, options) => {
        if (workspacePathsEqual(target, denied)) throw Object.assign(new Error("access denied"), { code: "EACCES" });
        return await readdir(target, options);
      },
      readFile: async (target, encoding) => await readFile(target, encoding),
      mkdir: async (target, options) => await mkdir(target, options),
      writeFile: async (target, data, encoding) => await writeFile(target, data, encoding),
    };
    const manager = new WorkspaceManager({ fileSystem, rootCandidates: () => [root] });
    await expect(manager.listDirectory(denied)).rejects.toThrow("access denied");
    const rendered = await manager.validate(deleted);
    await rm(deleted, { recursive: true });
    await expect(manager.select(rendered.path)).rejects.toThrow();
    expect(manager.active).toBeNull();
  });

  it("excludes directory junctions from browsing and canonicalizes direct targets", async () => {
    const root = await fixture();
    const target = path.join(root, "Target");
    const link = path.join(root, "Junction");
    await mkdir(target);
    await symlink(target, link, "junction");
    const manager = new WorkspaceManager({ rootCandidates: () => [root] });
    const listing = await manager.listDirectory(root);
    expect(listing.directories.map((entry) => entry.displayName)).toContain("Target");
    expect(listing.directories.map((entry) => entry.displayName)).not.toContain("Junction");
    expect((await manager.validate(link)).path).toBe(await realpath(target));
  });

  it("prevents browsing, parent navigation, and browsed selection outside an allowed root", async () => {
    const allowed = await fixture();
    const child = path.join(allowed, "Child");
    const outside = await fixture();
    await mkdir(child);
    const manager = new WorkspaceManager({ rootCandidates: () => [allowed] });
    const rootPage = await manager.listDirectory(allowed);
    expect(rootPage.parent).toBeNull();
    const childPage = await manager.listDirectory(child);
    expect(childPage.parent).toBe(await realpath(allowed));
    await expect(manager.listDirectory(outside)).rejects.toThrow("outside the allowed Telegram browsing roots");
    await expect(manager.selectBrowsable(outside)).rejects.toThrow("outside the allowed Telegram browsing roots");
    expect((await manager.select(outside)).path).toBe(await realpath(outside));
  });

  it("rechecks canonical identity when a browsed folder is replaced by a junction", async () => {
    const allowed = await fixture();
    const outside = await fixture();
    const candidate = path.join(allowed, "Candidate");
    await mkdir(candidate);
    const manager = new WorkspaceManager({ rootCandidates: () => [allowed] });
    expect((await manager.listDirectory(allowed)).directories.map((entry) => entry.displayName)).toContain("Candidate");
    await rm(candidate, { recursive: true });
    await symlink(outside, candidate, "junction");
    await expect(manager.selectBrowsable(candidate)).rejects.toThrow("outside the allowed Telegram browsing roots");
  });
});
