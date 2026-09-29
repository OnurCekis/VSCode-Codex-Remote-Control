import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProfileSyncPaths {
  dailyUserDir: string;
  dailyExtensionsDir: string;
  pocketUserDir: string;
  pocketExtensionsDir: string;
  stateFile: string;
}

export interface ProfileSyncOptions {
  paths: ProfileSyncPaths;
  protectedSettings: Record<string, JsonValue>;
  pinnedVscodeVersion: string;
  pinnedCodexExtension: { id: string; version: string; directoryName: string };
  targetPlatform?: "win32" | "darwin";
  targetArchitecture?: "x64" | "arm64";
  verifyProtectedInvariants?: () => Promise<void>;
  lifecycle?: ProfileSyncLifecycle;
}

export interface ProfileSyncLifecycle {
  isProcessAlive?: (pid: number) => boolean;
  removeTransactionDirectory?: (directory: string) => Promise<void>;
}

export interface ExtensionSyncResult {
  id: string;
  version: string;
  sourceDirectory: string;
  compatible: boolean;
  reason?: string;
  themes: string[];
  iconThemes: string[];
}

export interface ProfileSyncPlan {
  sourceHash: string;
  previousHash: string | null;
  changed: boolean;
  settings: Record<string, JsonValue>;
  keybindings: JsonValue | null;
  snippets: Array<{ name: string; content: string }>;
  extensions: ExtensionSyncResult[];
  warnings: string[];
  hashes: { settings: string; keybindings: string | null; snippets: string; extensions: string };
}

export interface ProfileSyncStatus {
  state: "upToDate" | "changed" | "warning" | "failed";
  settings: "synced" | "unchanged" | "failed";
  keybindings: "synced" | "unchanged" | "missing" | "failed";
  snippetsSynced: number;
  extensionsSynced: number;
  extensionsSkipped: Array<{ id: string; version: string; reason: string }>;
  extensionsDeferred: boolean;
  lastSuccessfulSync: string | null;
  warnings: string[];
}

interface StoredState {
  version: 1;
  sourceHash: string;
  lastSuccessfulSync: string;
  settingsHash: string;
  keybindingsHash: string | null;
  snippetsHash: string;
  extensionsHash: string;
  extensionsSynced: number;
  extensionsSkipped: Array<{ id: string; version: string; reason: string }>;
  extensionsDeferred?: boolean;
}

type TransactionPhase = "prepared" | "applying" | "committed" | "cleanupPending";

interface TransactionMetadata {
  version: 1;
  kind: "codex-pocket-profile-sync";
  id: string;
  ownerPid: number;
  createdAt: string;
  serviceId: string;
  phase: TransactionPhase;
  originals: {
    settings: boolean;
    keybindings: boolean;
    snippets: boolean;
    extensions: boolean;
  };
}

export interface ProfileSyncCleanupResult {
  removed: string[];
  preserved: string[];
  warnings: string[];
}

const TRANSACTION_DIRECTORY = "profile-sync-transactions-v1";
const TRANSACTION_METADATA = "transaction.json";
const TRANSACTION_NAME = /^transaction-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

const BUILTIN_THEMES = new Set(["Dark Modern", "Light Modern", "Dark+ (default dark)", "Light+ (default light)", "Default Dark+", "Default Light+"]);
const BUILTIN_ICON_THEMES = new Set(["vs-seti", "vs-minimal", "none", "Seti (Visual Studio Code)", "Minimal (Visual Studio Code)"]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

async function readJsonFile(target: string, category: string): Promise<JsonValue> {
  try {
    const source = await readFile(target, "utf8");
    let output = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
      const current = source[index]!;
      const next = source[index + 1];
      if (inString) {
        output += current;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') { inString = true; output += current; continue; }
      if (current === "/" && next === "/") {
        while (index < source.length && source[index] !== "\n") index += 1;
        output += "\n";
        continue;
      }
      if (current === "/" && next === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
        index += 1;
        output += " ";
        continue;
      }
      output += current;
    }
    let normalized = "";
    inString = false;
    escaped = false;
    for (let index = 0; index < output.length; index += 1) {
      const current = output[index]!;
      if (inString) {
        normalized += current;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') { inString = true; normalized += current; continue; }
      if (current === ",") {
        let lookahead = index + 1;
        while (/\s/u.test(output[lookahead] ?? "")) lookahead += 1;
        if (output[lookahead] === "}" || output[lookahead] === "]") continue;
      }
      normalized += current;
    }
    return JSON.parse(normalized) as JsonValue;
  } catch (error) {
    throw new Error(`Invalid ${category} JSON at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function objectValue(value: JsonValue, category: string): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${category} must contain a JSON object.`);
  return value;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}

export function supportsVscodeEngine(engine: string, vscodeVersion: string): { compatible: boolean; reason?: string } {
  const target = parseVersion(vscodeVersion);
  if (!target) return { compatible: false, reason: `invalid pinned VS Code version ${vscodeVersion}` };
  const value = engine.trim();
  if (value === "*" || value === "") return { compatible: true };
  const alternatives = value.split("||").map((item) => item.trim());
  for (const alternative of alternatives) {
    const match = /^(\^|>=|>|~)?\s*(\d+\.\d+(?:\.\d+)?)/u.exec(alternative);
    if (!match) continue;
    const required = parseVersion(match[2]!);
    if (!required) continue;
    const operator = match[1] ?? "=";
    const comparison = compareVersion(target, required);
    if ((operator === ">" && comparison > 0) || (["^", ">=", "~"].includes(operator) && comparison >= 0) || (operator === "=" && comparison === 0)) {
      return { compatible: true };
    }
  }
  return { compatible: false, reason: `requires VS Code ${engine}; Pocket is ${vscodeVersion}` };
}

async function snippetInventory(root: string): Promise<Array<{ name: string; content: string }>> {
  if (!(await exists(root))) return [];
  const result: Array<{ name: string; content: string }> = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const source = path.join(root, entry.name);
    const content = await readFile(source, "utf8");
    if (entry.name.endsWith(".json") || entry.name.endsWith(".code-snippets")) await readJsonFile(source, `snippet ${entry.name}`);
    result.push({ name: entry.name, content });
  }
  return result;
}

function contributionNames(value: unknown, kind: "themes" | "iconThemes"): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const candidate = kind === "themes" ? (record.label ?? record.id) : (record.id ?? record.label);
    return typeof candidate === "string" ? [candidate] : [];
  });
}

async function extensionInventory(options: ProfileSyncOptions): Promise<ExtensionSyncResult[]> {
  if (!(await exists(options.paths.dailyExtensionsDir))) return [];
  const byId = new Map<string, ExtensionSyncResult>();
  for (const entry of await readdir(options.paths.dailyExtensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const sourceDirectory = path.join(options.paths.dailyExtensionsDir, entry.name);
    const manifestPath = path.join(sourceDirectory, "package.json");
    if (!(await exists(manifestPath))) continue;
    let manifest: Record<string, unknown>;
    try {
      manifest = objectValue(await readJsonFile(manifestPath, `extension manifest ${entry.name}`), "Extension manifest");
    } catch (error) {
      byId.set(entry.name.toLowerCase(), { id: entry.name.toLowerCase(), version: "unknown", sourceDirectory, compatible: false, reason: error instanceof Error ? error.message : String(error), themes: [], iconThemes: [] });
      continue;
    }
    const publisher = typeof manifest.publisher === "string" ? manifest.publisher : "";
    const name = typeof manifest.name === "string" ? manifest.name : "";
    const version = typeof manifest.version === "string" ? manifest.version : "unknown";
    const id = `${publisher}.${name}`.toLowerCase();
    const engines = manifest.engines && typeof manifest.engines === "object" ? manifest.engines as Record<string, unknown> : {};
    const engine = typeof engines.vscode === "string" ? engines.vscode : "";
    const contributes = manifest.contributes && typeof manifest.contributes === "object" ? manifest.contributes as Record<string, unknown> : {};
    let compatibility = supportsVscodeEngine(engine, options.pinnedVscodeVersion);
    if (!publisher || !name || version === "unknown") compatibility = { compatible: false, reason: "manifest identity is incomplete" };
    const supportedOs = typeof manifest.os === "string" ? [manifest.os] : Array.isArray(manifest.os) ? manifest.os.filter((item): item is string => typeof item === "string") : [];
    const supportedCpu = typeof manifest.cpu === "string" ? [manifest.cpu] : Array.isArray(manifest.cpu) ? manifest.cpu.filter((item): item is string => typeof item === "string") : [];
    const targetPlatform = options.targetPlatform ?? "win32";
    const targetArchitecture = options.targetArchitecture ?? "x64";
    if (supportedOs.length && !supportedOs.includes(targetPlatform) && !supportedOs.includes("any")) compatibility = { compatible: false, reason: `platform excludes ${targetPlatform} (${supportedOs.join(", ")})` };
    if (supportedCpu.length && !supportedCpu.includes(targetArchitecture) && !supportedCpu.includes("any")) compatibility = { compatible: false, reason: `architecture excludes ${targetArchitecture} (${supportedCpu.join(", ")})` };
    const payload = /(?:^|[.-])(win32|darwin|linux)-(x64|arm64)(?:$|[.-])/iu.exec(entry.name);
    if (payload && (payload[1]?.toLowerCase() !== targetPlatform || payload[2]?.toLowerCase() !== targetArchitecture)) {
      compatibility = { compatible: false, reason: `installed payload targets ${payload[1]?.toLowerCase()}-${payload[2]?.toLowerCase()}` };
    }
    if (id === options.pinnedCodexExtension.id.toLowerCase()) compatibility = { compatible: false, reason: "Pocket Codex extension is pinned and excluded" };
    const candidate: ExtensionSyncResult = {
      id, version, sourceDirectory, compatible: compatibility.compatible,
      ...(compatibility.reason ? { reason: compatibility.reason } : {}),
      themes: contributionNames(contributes.themes, "themes"), iconThemes: contributionNames(contributes.iconThemes, "iconThemes"),
    };
    const existing = byId.get(id);
    if (!existing || existing.version.localeCompare(version, undefined, { numeric: true }) < 0) byId.set(id, candidate);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function safeThemeSettings(settings: Record<string, JsonValue>, extensions: ExtensionSyncResult[], warnings: string[]): void {
  const themes = new Set([...BUILTIN_THEMES, ...extensions.filter((item) => item.compatible).flatMap((item) => item.themes)]);
  const icons = new Set([...BUILTIN_ICON_THEMES, ...extensions.filter((item) => item.compatible).flatMap((item) => item.iconThemes)]);
  const theme = settings["workbench.colorTheme"];
  if (typeof theme === "string" && !themes.has(theme)) {
    warnings.push(`Requested theme ${theme} is unavailable in compatible Pocket extensions; using Dark Modern.`);
    settings["workbench.colorTheme"] = "Dark Modern";
  }
  const icon = settings["workbench.iconTheme"];
  if (typeof icon === "string" && !icons.has(icon)) {
    warnings.push(`Requested icon theme ${icon} is unavailable in compatible Pocket extensions; using Seti.`);
    settings["workbench.iconTheme"] = "vs-seti";
  }
}

async function readState(file: string): Promise<StoredState | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as StoredState;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function pathKey(target: string): string {
  return path.resolve(target).replace(/[\\/]+$/u, "").toLowerCase();
}

function directChildOf(candidate: string, parent: string): boolean {
  return pathKey(path.dirname(candidate)) === pathKey(parent);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function transactionRootFor(paths: ProfileSyncPaths): string {
  return path.join(path.dirname(path.resolve(paths.stateFile)), TRANSACTION_DIRECTORY);
}

function serviceIdentity(paths: ProfileSyncPaths): string {
  return hash(stable({
    stateFile: pathKey(paths.stateFile),
    pocketUserDir: pathKey(paths.pocketUserDir),
    pocketExtensionsDir: pathKey(paths.pocketExtensionsDir),
  }));
}

function parseTransactionMetadata(value: unknown): TransactionMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const originals = item.originals;
  if (!originals || typeof originals !== "object" || Array.isArray(originals)) return null;
  const originalRecord = originals as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const phase = item.phase;
  const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
  if (item.version !== 1 || item.kind !== "codex-pocket-profile-sync" || !TRANSACTION_NAME.test(`transaction-${id}`) ||
    !Number.isInteger(item.ownerPid) || (item.ownerPid as number) <= 0 || !Number.isFinite(Date.parse(createdAt)) ||
    typeof item.serviceId !== "string" || !["prepared", "applying", "committed", "cleanupPending"].includes(String(phase)) ||
    !["settings", "keybindings", "snippets", "extensions"].every((key) => typeof originalRecord[key] === "boolean")) return null;
  return {
    version: 1,
    kind: "codex-pocket-profile-sync",
    id,
    ownerPid: item.ownerPid as number,
    createdAt,
    serviceId: item.serviceId,
    phase: phase as TransactionPhase,
    originals: {
      settings: originalRecord.settings as boolean,
      keybindings: originalRecord.keybindings as boolean,
      snippets: originalRecord.snippets as boolean,
      extensions: originalRecord.extensions as boolean,
    },
  };
}

async function assertTreeDoesNotEscape(root: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`transaction contains a symlink or junction: ${entry.name}`);
      const canonical = await realpath(candidate);
      const relative = path.relative(canonicalRoot, canonical);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`transaction entry escapes its managed directory: ${entry.name}`);
      if (info.isDirectory()) await visit(candidate);
    }
  };
  await visit(canonicalRoot);
}

export class ProfileSyncService {
  readonly #options: ProfileSyncOptions;
  #currentTransactionId: string | null = null;
  #status: ProfileSyncStatus = {
    state: "changed", settings: "unchanged", keybindings: "missing", snippetsSynced: 0,
    extensionsSynced: 0, extensionsSkipped: [], extensionsDeferred: false, lastSuccessfulSync: null, warnings: [],
  };

  constructor(options: ProfileSyncOptions) {
    this.#options = options;
  }

  async cleanupAbandonedTransactions(): Promise<ProfileSyncCleanupResult> {
    const managedRoot = transactionRootFor(this.#options.paths);
    const result: ProfileSyncCleanupResult = { removed: [], preserved: [], warnings: [] };
    if (!(await exists(managedRoot))) return result;
    const rootInfo = await lstat(managedRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      result.warnings.push("Pocket profile-sync transaction root is not a normal local directory; cleanup was refused.");
      return result;
    }
    const canonicalRoot = await realpath(managedRoot);
    const expectedService = serviceIdentity(this.#options.paths);
    const isAlive = this.#options.lifecycle?.isProcessAlive ?? processAlive;
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      const match = TRANSACTION_NAME.exec(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !match) {
        result.preserved.push(entry.name);
        result.warnings.push(`Unrecognized entry in the Pocket profile-sync transaction root was preserved: ${entry.name}`);
        continue;
      }
      const candidate = path.join(canonicalRoot, entry.name);
      try {
        const candidateInfo = await lstat(candidate);
        const canonicalCandidate = await realpath(candidate);
        if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink() || !directChildOf(canonicalCandidate, canonicalRoot)) {
          throw new Error("candidate is not a direct normal child of the managed transaction root");
        }
        const metadata = parseTransactionMetadata(JSON.parse(await readFile(path.join(canonicalCandidate, TRANSACTION_METADATA), "utf8")));
        if (!metadata || metadata.id !== match[1] || metadata.serviceId !== expectedService) {
          throw new Error("ownership metadata is missing, invalid, or belongs to another profile-sync service");
        }
        if (metadata.id === this.#currentTransactionId) {
          result.preserved.push(entry.name);
          continue;
        }
        const activePaths = [this.#options.paths.pocketUserDir, this.#options.paths.pocketExtensionsDir].map(pathKey);
        const candidateKey = pathKey(canonicalCandidate);
        if (activePaths.some((active) => active === candidateKey || active.startsWith(`${candidateKey}${path.sep}`) || candidateKey.startsWith(`${active}${path.sep}`))) {
          throw new Error("candidate contains an active Pocket profile path");
        }
        const ownerAlive = isAlive(metadata.ownerPid);
        const provablyComplete = metadata.phase === "committed" || metadata.phase === "cleanupPending";
        if (ownerAlive && !provablyComplete) {
          result.preserved.push(entry.name);
          result.warnings.push(`Live Pocket profile-sync transaction was preserved: ${entry.name}`);
          continue;
        }
        if (!ownerAlive && metadata.phase === "applying") await this.#restoreTransaction(canonicalCandidate, metadata);
        await this.#removeProvenTransaction(canonicalCandidate);
        result.removed.push(entry.name);
      } catch (error) {
        result.preserved.push(entry.name);
        result.warnings.push(`Pocket profile-sync cleanup preserved ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  async #writeTransactionMetadata(transactionRoot: string, metadata: TransactionMetadata): Promise<void> {
    await atomicWrite(path.join(transactionRoot, TRANSACTION_METADATA), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  async #removeProvenTransaction(transactionRoot: string): Promise<void> {
    const managedRoot = await realpath(transactionRootFor(this.#options.paths));
    const canonical = await realpath(transactionRoot);
    if (!directChildOf(canonical, managedRoot)) throw new Error("transaction deletion target escaped the managed root");
    await assertTreeDoesNotEscape(canonical);
    const remove = this.#options.lifecycle?.removeTransactionDirectory ?? (async (directory: string) => {
      await rm(directory, { recursive: true, force: true });
    });
    await remove(canonical);
  }

  async #restoreTransaction(transactionRoot: string, metadata: TransactionMetadata): Promise<void> {
    const backupRoot = path.join(transactionRoot, "backup");
    const targets = [
      { key: "settings" as const, name: "settings.json" },
      { key: "keybindings" as const, name: "keybindings.json" },
      { key: "snippets" as const, name: "snippets" },
    ];
    for (const target of targets) {
      const destination = path.join(this.#options.paths.pocketUserDir, target.name);
      const backup = path.join(backupRoot, target.name);
      if (metadata.originals[target.key]) {
        if (await exists(backup)) {
          await rm(destination, { recursive: true, force: true });
          await mkdir(path.dirname(destination), { recursive: true });
          await rename(backup, destination);
        } else if (!(await exists(destination))) {
          throw new Error(`cannot recover missing original ${target.name}`);
        }
      } else {
        await rm(destination, { recursive: true, force: true });
      }
    }
    const extensionBackup = path.join(transactionRoot, "extensions-backup");
    if (metadata.originals.extensions) {
      if (await exists(extensionBackup)) {
        await rm(this.#options.paths.pocketExtensionsDir, { recursive: true, force: true });
        await mkdir(path.dirname(this.#options.paths.pocketExtensionsDir), { recursive: true });
        await rename(extensionBackup, this.#options.paths.pocketExtensionsDir);
      } else if (!(await exists(this.#options.paths.pocketExtensionsDir))) {
        throw new Error("cannot recover missing original extension profile");
      }
    } else {
      await rm(this.#options.paths.pocketExtensionsDir, { recursive: true, force: true });
    }
  }

  async inspect(): Promise<ProfileSyncPlan> {
    const dailyUser = await realpath(this.#options.paths.dailyUserDir).catch(() => this.#options.paths.dailyUserDir);
    const settingsPath = path.join(dailyUser, "settings.json");
    const dailySettings = await exists(settingsPath) ? objectValue(await readJsonFile(settingsPath, "daily settings"), "Daily settings") : {};
    const settings: Record<string, JsonValue> = { ...dailySettings, ...this.#options.protectedSettings };
    const keybindingsPath = path.join(dailyUser, "keybindings.json");
    const keybindings = await exists(keybindingsPath) ? await readJsonFile(keybindingsPath, "daily keybindings") : null;
    if (keybindings !== null && !Array.isArray(keybindings)) throw new Error("Daily keybindings must contain a JSON array.");
    const snippets = await snippetInventory(path.join(dailyUser, "snippets"));
    const extensions = await extensionInventory(this.#options);
    const warnings: string[] = [];
    safeThemeSettings(settings, extensions, warnings);
    const hashes = {
      settings: hash(stable(settings)),
      keybindings: keybindings === null ? null : hash(stable(keybindings)),
      snippets: hash(stable(snippets.map((item) => ({ name: item.name, hash: hash(item.content) })))),
      extensions: hash(stable(extensions.map((item) => ({
        id: item.id, version: item.version, compatible: item.compatible, reason: item.reason ?? null,
      })))),
    };
    const source = {
      settings, keybindings, snippets: snippets.map((item) => ({ name: item.name, hash: hash(item.content) })),
      extensions: extensions.map((item) => ({ id: item.id, version: item.version, compatible: item.compatible, reason: item.reason ?? null })),
    };
    const sourceHash = hash(stable(source));
    const previous = await readState(this.#options.paths.stateFile);
    return { sourceHash, previousHash: previous?.sourceHash ?? null, changed: previous?.sourceHash !== sourceHash || previous.extensionsDeferred === true, settings, keybindings, snippets, extensions, warnings, hashes };
  }

  async plan(): Promise<ProfileSyncPlan> { return await this.inspect(); }

  async apply(options: { allowExtensionChanges: boolean } = { allowExtensionChanges: true }): Promise<ProfileSyncStatus> {
    const cleanup = await this.cleanupAbandonedTransactions();
    if (cleanup.warnings.length) {
      this.#status = { ...this.#status, state: "warning", warnings: cleanup.warnings };
      throw new Error(`Profile-sync cleanup could not safely proceed: ${cleanup.warnings.join(" ")}`);
    }
    const plan = await this.plan();
    const previous = await readState(this.#options.paths.stateFile);
    if (!plan.changed) {
      const previousSkipped = previous?.extensionsSkipped ?? [];
      this.#status = {
        state: plan.warnings.length || previousSkipped.length ? "warning" : "upToDate", settings: "unchanged",
        keybindings: plan.keybindings === null ? "missing" : "unchanged", snippetsSynced: plan.snippets.length,
        extensionsSynced: previous?.extensionsSynced ?? 0, extensionsSkipped: previousSkipped,
        extensionsDeferred: false, lastSuccessfulSync: previous?.lastSuccessfulSync ?? null, warnings: plan.warnings,
      };
      await this.#options.verifyProtectedInvariants?.();
      return this.getStatus();
    }

    const managedRoot = transactionRootFor(this.#options.paths);
    await mkdir(managedRoot, { recursive: true });
    const managedInfo = await lstat(managedRoot);
    if (!managedInfo.isDirectory() || managedInfo.isSymbolicLink()) throw new Error("Pocket profile-sync transaction root must be a normal local directory.");
    const transactionId = randomUUID();
    const transactionRoot = path.join(await realpath(managedRoot), `transaction-${transactionId}`);
    const stagedUser = path.join(transactionRoot, "User");
    const stagedExtensions = path.join(transactionRoot, "extensions");
    const backupRoot = path.join(transactionRoot, "backup");
    const compatible = plan.extensions.filter((item) => item.compatible);
    const skipped = plan.extensions.filter((item) => !item.compatible).map((item) => ({ id: item.id, version: item.version, reason: item.reason ?? "incompatible" }));
    let extensionsDeferred = false;
    const extensionsChanged = previous?.extensionsHash !== plan.hashes.extensions || previous?.extensionsDeferred === true;
    const extensionBackup = path.join(transactionRoot, "extensions-backup");
    const metadata: TransactionMetadata = {
      version: 1,
      kind: "codex-pocket-profile-sync",
      id: transactionId,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      serviceId: serviceIdentity(this.#options.paths),
      phase: "prepared",
      originals: {
        settings: await exists(path.join(this.#options.paths.pocketUserDir, "settings.json")),
        keybindings: await exists(path.join(this.#options.paths.pocketUserDir, "keybindings.json")),
        snippets: await exists(path.join(this.#options.paths.pocketUserDir, "snippets")),
        extensions: await exists(this.#options.paths.pocketExtensionsDir),
      },
    };
    let failure: unknown = null;
    this.#currentTransactionId = transactionId;
    try {
      await mkdir(transactionRoot);
      await this.#writeTransactionMetadata(transactionRoot, metadata);
      await mkdir(path.join(stagedUser, "snippets"), { recursive: true });
      await writeFile(path.join(stagedUser, "settings.json"), `${JSON.stringify(plan.settings, null, 2)}\n`, "utf8");
      if (plan.keybindings !== null) await writeFile(path.join(stagedUser, "keybindings.json"), `${JSON.stringify(plan.keybindings, null, 2)}\n`, "utf8");
      for (const snippet of plan.snippets) await writeFile(path.join(stagedUser, "snippets", snippet.name), snippet.content, "utf8");

      if (options.allowExtensionChanges && extensionsChanged) {
        await mkdir(stagedExtensions, { recursive: true });
        const pinnedSource = path.join(this.#options.paths.pocketExtensionsDir, this.#options.pinnedCodexExtension.directoryName);
        if (!(await exists(pinnedSource))) throw new Error("Pinned Pocket Codex extension is missing before profile sync.");
        await cp(pinnedSource, path.join(stagedExtensions, this.#options.pinnedCodexExtension.directoryName), { recursive: true, errorOnExist: true });
        for (const extension of compatible) {
          const destination = path.join(stagedExtensions, path.basename(extension.sourceDirectory));
          await cp(extension.sourceDirectory, destination, { recursive: true, errorOnExist: true });
        }
      } else if (extensionsChanged) {
        extensionsDeferred = true;
      }

      await mkdir(backupRoot, { recursive: true });
      metadata.phase = "applying";
      await this.#writeTransactionMetadata(transactionRoot, metadata);
      const targets = ["settings.json", "keybindings.json", "snippets"];
      for (const name of targets) {
        const destination = path.join(this.#options.paths.pocketUserDir, name);
        if (await exists(destination)) await rename(destination, path.join(backupRoot, name));
      }
      await mkdir(this.#options.paths.pocketUserDir, { recursive: true });
      for (const name of targets) {
        const source = path.join(stagedUser, name);
        if (await exists(source)) await rename(source, path.join(this.#options.paths.pocketUserDir, name));
      }

      if (options.allowExtensionChanges && extensionsChanged) {
        if (await exists(this.#options.paths.pocketExtensionsDir)) await rename(this.#options.paths.pocketExtensionsDir, extensionBackup);
        try {
          await rename(stagedExtensions, this.#options.paths.pocketExtensionsDir);
          await this.#options.verifyProtectedInvariants?.();
        } catch (error) {
          await rm(this.#options.paths.pocketExtensionsDir, { recursive: true, force: true });
          if (await exists(extensionBackup)) await rename(extensionBackup, this.#options.paths.pocketExtensionsDir);
          throw error;
        }
      } else {
        await this.#options.verifyProtectedInvariants?.();
      }

      metadata.phase = "committed";
      await this.#writeTransactionMetadata(transactionRoot, metadata);
      const now = new Date().toISOString();
      const state: StoredState = {
        version: 1, sourceHash: plan.sourceHash, lastSuccessfulSync: now,
        settingsHash: plan.hashes.settings, keybindingsHash: plan.hashes.keybindings,
        snippetsHash: plan.hashes.snippets,
        extensionsHash: plan.hashes.extensions,
        extensionsSynced: options.allowExtensionChanges && extensionsChanged ? compatible.length : (previous?.extensionsSynced ?? 0), extensionsSkipped: skipped,
        extensionsDeferred,
      };
      await atomicWrite(this.#options.paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
      await rm(extensionBackup, { recursive: true, force: true });
      this.#status = {
        state: plan.warnings.length || skipped.length || extensionsDeferred ? "warning" : "changed",
        settings: "synced", keybindings: plan.keybindings === null ? "missing" : "synced", snippetsSynced: plan.snippets.length,
        extensionsSynced: state.extensionsSynced, extensionsSkipped: skipped, extensionsDeferred,
        lastSuccessfulSync: now, warnings: [...plan.warnings, ...(extensionsDeferred ? ["Extension changes were deferred because Pocket VS Code windows are active."] : [])],
      };
    } catch (error) {
      failure = error;
      try {
        if (await exists(transactionRoot)) {
          if (metadata.phase === "applying") await this.#restoreTransaction(transactionRoot, metadata);
          metadata.phase = "cleanupPending";
          await this.#writeTransactionMetadata(transactionRoot, metadata);
        }
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError], "Profile sync failed and rollback could not be completed safely.");
      }
      this.#status = { ...this.#status, state: "failed", settings: "failed", keybindings: "failed", warnings: [error instanceof Error ? error.message : String(error)] };
    } finally {
      if (await exists(transactionRoot)) {
        try {
          if (metadata.phase === "applying") throw new Error("transaction recovery is incomplete; backups were preserved");
          if (metadata.phase === "committed") {
            metadata.phase = "cleanupPending";
            await this.#writeTransactionMetadata(transactionRoot, metadata);
          }
          await this.#removeProvenTransaction(transactionRoot);
        } catch (cleanupError) {
          const warning = `Pocket profile-sync transaction cleanup failed and was left for verified recovery: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          this.#status = { ...this.#status, state: failure ? "failed" : "warning", warnings: [...this.#status.warnings, warning] };
        }
      }
      this.#currentTransactionId = null;
    }
    if (failure) throw failure;
    return this.getStatus();
  }

  getStatus(): ProfileSyncStatus { return structuredClone(this.#status); }
}
