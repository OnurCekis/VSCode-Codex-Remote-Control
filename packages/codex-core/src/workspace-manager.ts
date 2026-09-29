import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Workspace {
  path: string;
  displayName: string;
}

export interface WorkspaceState {
  activeWorkspace: Workspace | null;
  recentWorkspaces: Workspace[];
}

export interface WorkspaceDirectoryPage {
  directory: Workspace;
  browseRoot: Workspace;
  parent: string | null;
  directories: Workspace[];
  page: number;
  pages: number;
}

export interface WorkspaceFileSystem {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<{ isDirectory(): boolean }>;
  access(target: string): Promise<void>;
  readdir(target: string, options: { withFileTypes: true }): Promise<Array<{
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>>;
  readFile(target: string, encoding: "utf8"): Promise<string>;
  mkdir(target: string, options: { recursive: true }): Promise<unknown>;
  writeFile(target: string, data: string, encoding: "utf8"): Promise<void>;
}

const nodeFileSystem: WorkspaceFileSystem = { realpath, stat, access, readdir, readFile, mkdir, writeFile };

interface PersistedWorkspaceState {
  version: 1;
  activePath: string | null;
  recentPaths: string[];
}

export function workspacePathKey(value: string): string {
  const windowsPath = process.platform === "win32" || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
  const implementation = windowsPath ? path.win32 : path.posix;
  const input = windowsPath ? value.replaceAll("/", "\\") : value;
  const resolved = implementation.resolve(input);
  const normalized = implementation.normalize(resolved);
  const root = implementation.parse(normalized).root;
  const withoutTrailing = normalized.length > root.length ? normalized.replace(/[\\/]+$/u, "") : normalized;
  return windowsPath ? withoutTrailing.toLowerCase() : withoutTrailing;
}

export function workspacePathsEqual(left: string, right: string): boolean {
  return workspacePathKey(left) === workspacePathKey(right);
}

export function workspacePathWithin(target: string, root: string): boolean {
  const targetKey = workspacePathKey(target);
  const rootKey = workspacePathKey(root);
  const separator = /^[a-z]:\\|^\\\\/u.test(rootKey) ? "\\" : "/";
  return targetKey === rootKey || targetKey.startsWith(rootKey.endsWith(separator) ? rootKey : `${rootKey}${separator}`);
}

const COMMON_PROJECT_DIRECTORIES = [
  "Projects", "Project", "Repos", "Repositories", "Source", "Sources", "Git", "GitHub",
  "Workspace", "Workspaces", "Development", "Dev", "Code",
] as const;

export function defaultWorkspaceBrowseRootCandidates(options: {
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
  extraRoots?: readonly string[];
} = {}): string[] {
  const environment = options.environment ?? process.env;
  const homeInput = options.homeDir ?? os.homedir();
  const windowsHome = process.platform === "win32" || /^[A-Za-z]:[\\/]/u.test(homeInput) || /^\\\\/u.test(homeInput);
  const implementation = windowsHome ? path.win32 : path.posix;
  const home = implementation.resolve(homeInput);
  const candidates = [implementation.join(home, "Desktop"), implementation.join(home, "Documents")];
  for (const name of COMMON_PROJECT_DIRECTORIES) candidates.push(implementation.join(home, name));
  for (const cloudRoot of [environment.OneDrive, environment.OneDriveConsumer, environment.OneDriveCommercial]) {
    if (!cloudRoot?.trim()) continue;
    const cloudImplementation = /^[A-Za-z]:[\\/]/u.test(cloudRoot) || /^\\\\/u.test(cloudRoot) ? path.win32 : implementation;
    candidates.push(cloudImplementation.join(cloudRoot, "Desktop"), cloudImplementation.join(cloudRoot, "Documents"));
    for (const name of COMMON_PROJECT_DIRECTORIES) candidates.push(cloudImplementation.join(cloudRoot, name));
  }
  if (windowsHome) {
    for (let index = 0; index < 26; index += 1) {
      const drive = `${String.fromCharCode(65 + index)}:\\`;
      for (const name of COMMON_PROJECT_DIRECTORIES) candidates.push(path.win32.join(drive, name));
    }
  }
  candidates.push(...(options.extraRoots ?? []));
  return candidates.filter((candidate, index, all) =>
    (path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)) && !candidate.startsWith("\\\\") &&
    all.findIndex((other) => workspacePathsEqual(candidate, other)) === index);
}

function workspaceFromPath(canonicalPath: string): Workspace {
  const implementation = process.platform === "win32" ? path.win32 : path.posix;
  const root = implementation.parse(canonicalPath).root;
  return {
    path: canonicalPath,
    displayName: canonicalPath === root ? root : implementation.basename(canonicalPath),
  };
}

export class WorkspaceManager {
  readonly #fileSystem: WorkspaceFileSystem;
  readonly #stateFile: string | null;
  readonly #recentLimit: number;
  readonly #rootCandidates: () => string[];
  #active: Workspace | null = null;
  #recent: Workspace[] = [];

  constructor(options: {
    stateFile?: string;
    recentLimit?: number;
    fileSystem?: WorkspaceFileSystem;
    rootCandidates?: () => string[];
    extraRootCandidates?: readonly string[];
  } = {}) {
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.#stateFile = options.stateFile ? path.resolve(options.stateFile) : null;
    this.#recentLimit = options.recentLimit ?? 15;
    this.#rootCandidates = options.rootCandidates ?? (() =>
      defaultWorkspaceBrowseRootCandidates(options.extraRootCandidates ? { extraRoots: options.extraRootCandidates } : {}));
  }

  get state(): WorkspaceState {
    return { activeWorkspace: this.#active, recentWorkspaces: [...this.#recent] };
  }

  get active(): Workspace | null {
    return this.#active;
  }

  get recent(): Workspace[] {
    return [...this.#recent];
  }

  async initialize(defaultPath?: string): Promise<WorkspaceState> {
    let persisted: PersistedWorkspaceState | null = null;
    if (this.#stateFile) {
      try {
        const parsed: unknown = JSON.parse(await this.#fileSystem.readFile(this.#stateFile, "utf8"));
        if (typeof parsed === "object" && parsed !== null && "version" in parsed && parsed.version === 1 &&
          "recentPaths" in parsed && Array.isArray(parsed.recentPaths)) {
          persisted = parsed as PersistedWorkspaceState;
        }
      } catch { /* Missing and malformed local state are intentionally ignored. */ }
    }

    const candidates = [persisted?.activePath, defaultPath].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      try { this.#active = await this.validate(candidate); break; } catch { /* Try the documented fallback. */ }
    }
    const recentCandidates = [this.#active?.path, ...(persisted?.recentPaths ?? [])]
      .filter((value): value is string => Boolean(value));
    this.#recent = [];
    for (const candidate of recentCandidates) {
      try {
        const workspace = await this.validate(candidate);
        if (!this.#recent.some((entry) => workspacePathsEqual(entry.path, workspace.path))) this.#recent.push(workspace);
      } catch { /* Stale/inaccessible recents do not fail startup. */ }
      if (this.#recent.length >= this.#recentLimit) break;
    }
    return this.state;
  }

  async validate(target: string): Promise<Workspace> {
    if (!target.trim()) throw new Error("Workspace path is empty.");
    const resolved = path.resolve(target);
    const canonical = path.normalize(await this.#fileSystem.realpath(resolved));
    const details = await this.#fileSystem.stat(canonical);
    if (!details.isDirectory()) throw new Error("Workspace path is not a directory.");
    await this.#fileSystem.access(canonical);
    await this.#fileSystem.readdir(canonical, { withFileTypes: true });
    return workspaceFromPath(canonical);
  }

  async select(target: string): Promise<Workspace> {
    const workspace = await this.validate(target);
    await this.activate(workspace);
    return workspace;
  }

  async selectBrowsable(target: string): Promise<Workspace> {
    const workspace = await this.validate(target);
    await this.#assertBrowsable(workspace.path);
    await this.activate(workspace);
    return workspace;
  }

  async activate(workspace: Workspace): Promise<void> {
    const recents = [workspace, ...this.#recent.filter((entry) => !workspacePathsEqual(entry.path, workspace.path))]
      .slice(0, this.#recentLimit);
    await this.#persist(workspace, recents);
    this.#active = workspace;
    this.#recent = recents;
  }

  matches(target: string, workspace = this.#active): boolean {
    return Boolean(workspace && workspacePathsEqual(workspace.path, target));
  }

  async listRoots(): Promise<Workspace[]> {
    return await this.#browseRoots();
  }

  async #browseRoots(): Promise<Workspace[]> {
    const roots = await Promise.all(this.#rootCandidates().map(async (candidate): Promise<Workspace | null> => {
      try { return await this.validate(candidate); } catch { return null; }
    }));
    const unique = roots.filter((entry): entry is Workspace => entry !== null)
      .filter((entry, index, all) => all.findIndex((other) => workspacePathsEqual(entry.path, other.path)) === index);
    return unique.map((entry) => {
      const duplicates = unique.filter((candidate) =>
        candidate.displayName.localeCompare(entry.displayName, undefined, { sensitivity: "base" }) === 0);
      if (duplicates.length < 2) return entry;
      const qualifier = /[\\/]OneDrive(?:[\\/]|$)/iu.test(entry.path)
        ? "OneDrive"
        : path.parse(entry.path).root.replace(/[\\/]+$/u, "");
      return { ...entry, displayName: `${entry.displayName} (${qualifier || "Local"})` };
    });
  }

  async listDirectory(target: string, page = 0, pageSize = 10): Promise<WorkspaceDirectoryPage> {
    if (!Number.isInteger(page) || page < 0) throw new Error("Directory page must be a non-negative integer.");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) throw new Error("Directory page size is invalid.");
    const directory = await this.validate(target);
    const browseRoot = await this.#assertBrowsable(directory.path);
    const entries = await this.#fileSystem.readdir(directory.path, { withFileTypes: true });
    const folders = entries
      // Windows junctions and directory symlinks are excluded from browsing. Direct selection still resolves real paths.
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => workspaceFromPath(path.join(directory.path, entry.name)))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }));
    const pages = Math.max(1, Math.ceil(folders.length / pageSize));
    const boundedPage = Math.min(page, pages - 1);
    return {
      directory,
      browseRoot,
      parent: workspacePathsEqual(directory.path, browseRoot.path) ? null : path.dirname(directory.path),
      directories: folders.slice(boundedPage * pageSize, (boundedPage + 1) * pageSize),
      page: boundedPage,
      pages,
    };
  }

  async #assertBrowsable(target: string): Promise<Workspace> {
    const roots = await this.#browseRoots();
    const matches = roots.filter((root) => workspacePathWithin(target, root.path))
      .sort((left, right) => workspacePathKey(right.path).length - workspacePathKey(left.path).length);
    if (!matches[0]) throw new Error("Workspace path is outside the allowed Telegram browsing roots.");
    return matches[0];
  }

  async #persist(active: Workspace, recents: Workspace[]): Promise<void> {
    if (!this.#stateFile) return;
    const state: PersistedWorkspaceState = { version: 1, activePath: active.path, recentPaths: recents.map((entry) => entry.path) };
    await this.#fileSystem.mkdir(path.dirname(this.#stateFile), { recursive: true });
    await this.#fileSystem.writeFile(this.#stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
