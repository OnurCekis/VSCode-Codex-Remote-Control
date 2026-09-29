import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileSyncService, supportsVscodeEngine, type ProfileSyncOptions } from "../src/profile-sync-service.js";

const roots: string[] = [];
async function fixture(): Promise<{ root: string; options: ProfileSyncOptions }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocket-profile-sync-"));
  roots.push(root);
  const dailyUserDir = path.join(root, "daily", "User");
  const dailyExtensionsDir = path.join(root, "daily-extensions");
  const pocketUserDir = path.join(root, "pocket", "User");
  const pocketExtensionsDir = path.join(root, "pocket-extensions");
  await Promise.all([mkdir(path.join(dailyUserDir, "snippets"), { recursive: true }), mkdir(dailyExtensionsDir, { recursive: true }), mkdir(pocketUserDir, { recursive: true })]);
  await writeFile(path.join(dailyUserDir, "settings.json"), JSON.stringify({ "editor.fontSize": 15, "chatgpt.cliExecutable": "daily", "workbench.colorTheme": "Dark Modern" }));
  await writeFile(path.join(dailyUserDir, "keybindings.json"), JSON.stringify([{ key: "ctrl+k", command: "fixture" }]));
  await writeFile(path.join(dailyUserDir, "snippets", "typescript.json"), JSON.stringify({ fixture: { prefix: "fx", body: ["value"] } }));
  await extension(pocketExtensionsDir, "openai", "chatgpt", "26.814.41407", "^1.90.0", "openai.chatgpt-26.814.41407");
  return {
    root,
    options: {
      paths: { dailyUserDir, dailyExtensionsDir, pocketUserDir, pocketExtensionsDir, stateFile: path.join(root, "state", "profile-sync-state.json") },
      protectedSettings: { "chatgpt.cliExecutable": "pocket-proxy", "extensions.autoUpdate": false },
      pinnedVscodeVersion: "1.133.0",
      pinnedCodexExtension: { id: "openai.chatgpt", version: "26.814.41407", directoryName: "openai.chatgpt-26.814.41407" },
    },
  };
}

async function extension(root: string, publisher: string, name: string, version: string, engine: string, directory = `${publisher}.${name}-${version}`, contributes?: object): Promise<void> {
  const target = path.join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "package.json"), JSON.stringify({ publisher, name, version, engines: { vscode: engine }, ...(contributes ? { contributes } : {}) }));
  await writeFile(path.join(target, "payload.txt"), `${publisher}.${name}`);
}

function transactionsRoot(options: ProfileSyncOptions): string {
  return path.join(path.dirname(options.paths.stateFile), "profile-sync-transactions-v1");
}

async function transactionDirectories(options: ProfileSyncOptions): Promise<string[]> {
  return await readdir(transactionsRoot(options)).catch(() => []);
}

async function leaveVerifiedTransaction(options: ProfileSyncOptions): Promise<string> {
  const service = new ProfileSyncService({
    ...options,
    lifecycle: { removeTransactionDirectory: async () => { throw new Error("fixture cleanup denied"); } },
  });
  const status = await service.apply();
  expect(status.warnings.join(" ")).toContain("cleanup failed");
  const entries = await transactionDirectories(options);
  expect(entries).toHaveLength(1);
  return path.join(transactionsRoot(options), entries[0]!);
}

async function updateMetadata(transaction: string, update: (metadata: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(transaction, "transaction.json");
  const metadata = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  update(metadata);
  await writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("ProfileSyncService", () => {
  it("copies daily settings while protected Pocket settings always win", async () => {
    const { options } = await fixture();
    const status = await new ProfileSyncService(options).apply();
    const result = JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8"));
    expect(result["editor.fontSize"]).toBe(15);
    expect(result["chatgpt.cliExecutable"]).toBe("pocket-proxy");
    expect(result["extensions.autoUpdate"]).toBe(false);
    expect(status.settings).toBe("synced");
    expect(await transactionDirectories(options)).toEqual([]);
  });

  it("synchronizes keybindings and snippets and removes deleted source snippets", async () => {
    const { options } = await fixture();
    const service = new ProfileSyncService(options);
    await service.apply();
    expect(JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "keybindings.json"), "utf8"))).toHaveLength(1);
    expect(await readFile(path.join(options.paths.pocketUserDir, "snippets", "typescript.json"), "utf8")).toContain("fixture");
    await rm(path.join(options.paths.dailyUserDir, "snippets", "typescript.json"));
    await service.apply();
    await expect(stat(path.join(options.paths.pocketUserDir, "snippets", "typescript.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses hashes to skip unchanged sources and reacts to changes", async () => {
    const { options } = await fixture();
    const service = new ProfileSyncService(options);
    await service.apply();
    expect((await service.plan()).changed).toBe(false);
    await writeFile(path.join(options.paths.dailyUserDir, "settings.json"), JSON.stringify({ "editor.fontSize": 17 }));
    expect((await service.plan()).changed).toBe(true);
  });

  it("keeps the previous Pocket profile intact when validation or invariant verification fails", async () => {
    const { options } = await fixture();
    await writeFile(path.join(options.paths.pocketUserDir, "settings.json"), JSON.stringify({ knownGood: true }));
    const broken = new ProfileSyncService({ ...options, verifyProtectedInvariants: async () => { throw new Error("pin mismatch"); } });
    await expect(broken.apply()).rejects.toThrow("pin mismatch");
    expect(JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8"))).toEqual({ knownGood: true });
    expect(await readFile(path.join(options.paths.dailyUserDir, "settings.json"), "utf8")).toContain("editor.fontSize");
    expect(await transactionDirectories(options)).toEqual([]);
  });

  it("fails safely on invalid settings or snippet JSON without changing Pocket", async () => {
    const { options } = await fixture();
    await writeFile(path.join(options.paths.pocketUserDir, "settings.json"), JSON.stringify({ knownGood: true }));
    await writeFile(path.join(options.paths.dailyUserDir, "settings.json"), "{");
    await expect(new ProfileSyncService(options).apply()).rejects.toThrow("Invalid daily settings JSON");
    expect(JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8"))).toEqual({ knownGood: true });
  });

  it("handles missing optional source categories", async () => {
    const { options } = await fixture();
    await rm(path.join(options.paths.dailyUserDir, "keybindings.json"));
    await rm(path.join(options.paths.dailyUserDir, "snippets"), { recursive: true });
    const status = await new ProfileSyncService(options).apply();
    expect(status.keybindings).toBe("missing");
    expect(status.snippetsSynced).toBe(0);
  });

  it("accepts VS Code JSONC comments and trailing commas", async () => {
    const { options } = await fixture();
    await writeFile(path.join(options.paths.dailyUserDir, "settings.json"), '{\n // user setting\n "editor.fontSize": 16,\n "fixture.text": "keep // inside string,}",\n}\n');
    await new ProfileSyncService(options).apply();
    const settings = JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8"));
    expect(settings["editor.fontSize"]).toBe(16);
    expect(settings["fixture.text"]).toBe("keep // inside string,}");
  });

  it("copies compatible extensions, skips incompatible ones, and never replaces pinned Codex", async () => {
    const { options } = await fixture();
    await extension(options.paths.dailyExtensionsDir, "fixture", "good", "1.2.3", "^1.100.0");
    await extension(options.paths.dailyExtensionsDir, "fixture", "future", "2.0.0", "^1.140.0");
    await extension(options.paths.dailyExtensionsDir, "openai", "chatgpt", "99.0.0", "^1.100.0");
    const status = await new ProfileSyncService(options).apply();
    expect(await readFile(path.join(options.paths.pocketExtensionsDir, "fixture.good-1.2.3", "payload.txt"), "utf8")).toBe("fixture.good");
    await expect(stat(path.join(options.paths.pocketExtensionsDir, "fixture.future-2.0.0"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(options.paths.pocketExtensionsDir, "openai.chatgpt-26.814.41407", "package.json"), "utf8")).version).toBe("26.814.41407");
    expect(status.extensionsSkipped.map((item) => item.id)).toEqual(expect.arrayContaining(["fixture.future", "openai.chatgpt"]));
  });

  it("evaluates engines against pinned VS Code conservatively", () => {
    expect(supportsVscodeEngine("^1.100.0", "1.133.0").compatible).toBe(true);
    expect(supportsVscodeEngine(">=1.133.0", "1.133.0").compatible).toBe(true);
    expect(supportsVscodeEngine("^1.140.0", "1.133.0").compatible).toBe(false);
    expect(supportsVscodeEngine("not-a-range", "1.133.0").compatible).toBe(false);
  });

  it("skips extension payloads whose manifest excludes Windows x64", async () => {
    const { options } = await fixture();
    const target = path.join(options.paths.dailyExtensionsDir, "fixture.wrong-platform-1.0.0");
    await mkdir(target);
    await writeFile(path.join(target, "package.json"), JSON.stringify({ publisher: "fixture", name: "wrong-platform", version: "1.0.0", engines: { vscode: "^1.100.0" }, os: ["linux"], cpu: ["arm64"] }));
    const status = await new ProfileSyncService(options).apply();
    expect(status.extensionsSkipped.find((item) => item.id === "fixture.wrong-platform")?.reason).toContain("architecture excludes x64");
  });

  it("selects Darwin ARM64 extensions for a macOS Pocket profile", async () => {
    const { options } = await fixture();
    for (const [directory, osName, cpu] of [
      ["fixture.native-1.0.0.darwin-arm64", "darwin", "arm64"],
      ["fixture.foreign-1.0.0.win32-x64", "win32", "x64"],
    ] as const) {
      const target = path.join(options.paths.dailyExtensionsDir, directory);
      await mkdir(target);
      await writeFile(path.join(target, "package.json"), JSON.stringify({ publisher: "fixture", name: directory.includes("native") ? "native" : "foreign",
        version: "1.0.0", engines: { vscode: "^1.100.0" }, os: [osName], cpu: [cpu] }));
      await writeFile(path.join(target, "payload.txt"), directory);
    }
    const status = await new ProfileSyncService({ ...options, targetPlatform: "darwin", targetArchitecture: "arm64" }).apply();
    expect(await readFile(path.join(options.paths.pocketExtensionsDir, "fixture.native-1.0.0.darwin-arm64", "payload.txt"), "utf8")).toContain("native");
    expect(status.extensionsSkipped.find((item) => item.id === "fixture.foreign")?.reason).toContain("installed payload targets win32-x64");
  });

  it("falls back safely when a requested theme extension is unavailable", async () => {
    const { options } = await fixture();
    await writeFile(path.join(options.paths.dailyUserDir, "settings.json"), JSON.stringify({ "workbench.colorTheme": "Future Theme", "workbench.iconTheme": "future-icons" }));
    await extension(options.paths.dailyExtensionsDir, "fixture", "theme", "1.0.0", "^1.140.0", undefined, { themes: [{ label: "Future Theme" }], iconThemes: [{ id: "future-icons" }] });
    const status = await new ProfileSyncService(options).apply();
    const settings = JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8"));
    expect(settings["workbench.colorTheme"]).toBe("Dark Modern");
    expect(settings["workbench.iconTheme"]).toBe("vs-seti");
    expect(status.warnings).toHaveLength(2);
  });

  it("defers extension changes while keeping them pending for a later safe apply", async () => {
    const { options } = await fixture();
    await extension(options.paths.dailyExtensionsDir, "fixture", "good", "1.0.0", "^1.100.0");
    const service = new ProfileSyncService(options);
    expect((await service.apply({ allowExtensionChanges: false })).extensionsDeferred).toBe(true);
    expect((await service.plan()).changed).toBe(true);
    await service.apply({ allowExtensionChanges: true });
    expect((await service.plan()).changed).toBe(false);
  });

  it("does not defer when only safe settings changed while windows are active", async () => {
    const { options } = await fixture();
    const service = new ProfileSyncService(options);
    await service.apply();
    await writeFile(path.join(options.paths.dailyUserDir, "settings.json"), JSON.stringify({ "editor.fontSize": 19 }));
    const status = await service.apply({ allowExtensionChanges: false });
    expect(status.extensionsDeferred).toBe(false);
    expect((await service.plan()).changed).toBe(false);
  });

  it("writes hash-only state without profile values or source paths", async () => {
    const { options, root } = await fixture();
    await new ProfileSyncService(options).apply();
    const state = await readFile(options.paths.stateFile, "utf8");
    expect(state).not.toContain(root);
    expect(state).not.toContain("pocket-proxy");
    expect(state).not.toContain("editor.fontSize");
  });

  it("detects and safely removes a proven dead-owner transaction", async () => {
    const { options } = await fixture();
    const transaction = await leaveVerifiedTransaction(options);
    await updateMetadata(transaction, (metadata) => { metadata.ownerPid = 2_147_483_647; metadata.phase = "prepared"; });
    const cleanup = await new ProfileSyncService(options).cleanupAbandonedTransactions();
    expect(cleanup.removed).toHaveLength(1);
    expect(cleanup.warnings).toEqual([]);
    expect(await transactionDirectories(options)).toEqual([]);
  });

  it("rolls back an interrupted applying transaction before stale removal", async () => {
    const { options } = await fixture();
    await writeFile(path.join(options.paths.pocketUserDir, "settings.json"), JSON.stringify({ knownGood: true }));
    const transaction = await leaveVerifiedTransaction(options);
    await writeFile(path.join(options.paths.pocketUserDir, "settings.json"), JSON.stringify({ partialCrash: true }));
    await updateMetadata(transaction, (metadata) => { metadata.ownerPid = 2_147_483_647; metadata.phase = "applying"; });
    const cleanup = await new ProfileSyncService(options).cleanupAbandonedTransactions();
    expect(cleanup.removed).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8"))).toEqual({ knownGood: true });
  });

  it("preserves a transaction whose owner process is alive", async () => {
    const { options } = await fixture();
    const transaction = await leaveVerifiedTransaction(options);
    await updateMetadata(transaction, (metadata) => { metadata.phase = "prepared"; });
    const cleanup = await new ProfileSyncService(options).cleanupAbandonedTransactions();
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.preserved).toHaveLength(1);
    expect(cleanup.warnings.join(" ")).toContain("Live Pocket");
    expect(await stat(transaction)).toBeDefined();
  });

  it("preserves the current transaction during a concurrent cleanup observation", async () => {
    const { options } = await fixture();
    const observations: Array<Awaited<ReturnType<ProfileSyncService["cleanupAbandonedTransactions"]>>> = [];
    let service: ProfileSyncService;
    service = new ProfileSyncService({
      ...options,
      lifecycle: {
        removeTransactionDirectory: async (directory) => {
          observations.push(await service.cleanupAbandonedTransactions());
          await rm(directory, { recursive: true, force: true });
        },
      },
    });
    await service.apply();
    expect(observations[0]?.removed).toEqual([]);
    expect(observations[0]?.preserved).toHaveLength(1);
    expect(observations[0]?.warnings).toEqual([]);
  });

  it("does not inspect or remove a similar-looking directory outside the managed root", async () => {
    const { options, root } = await fixture();
    const outside = path.join(root, "profile-sync-transactions-v1", "..", `transaction-${randomUUID()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "marker.txt"), "keep");
    await new ProfileSyncService(options).cleanupAbandonedTransactions();
    expect(await readFile(path.join(outside, "marker.txt"), "utf8")).toBe("keep");
  });

  it("rejects a junction escape instead of deleting through it", async () => {
    const { options, root } = await fixture();
    const transaction = await leaveVerifiedTransaction(options);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "marker.txt"), "keep");
    await symlink(outside, path.join(transaction, "escape"), "junction");
    const cleanup = await new ProfileSyncService(options).cleanupAbandonedTransactions();
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.warnings.join(" ")).toContain("symlink or junction");
    expect(await readFile(path.join(outside, "marker.txt"), "utf8")).toBe("keep");
  });

  it("preserves invalid ownership metadata without destructive guessing", async () => {
    const { options } = await fixture();
    const invalid = path.join(transactionsRoot(options), `transaction-${randomUUID()}`);
    await mkdir(invalid, { recursive: true });
    await writeFile(path.join(invalid, "transaction.json"), JSON.stringify({ version: 1, ownerPid: 999999 }));
    const cleanup = await new ProfileSyncService(options).cleanupAbandonedTransactions();
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.warnings.join(" ")).toContain("ownership metadata");
    expect(await stat(invalid)).toBeDefined();
  });

  it("leaves the active profile untouched when stale cleanup fails", async () => {
    const { options } = await fixture();
    await leaveVerifiedTransaction(options);
    const knownGood = await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8");
    const blocked = new ProfileSyncService({
      ...options,
      lifecycle: { removeTransactionDirectory: async () => { throw new Error("fixture stale cleanup denied"); } },
    });
    await expect(blocked.apply()).rejects.toThrow("cleanup could not safely proceed");
    expect(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8")).toBe(knownGood);
  });

  it("allows the next sync after verified stale cleanup", async () => {
    const { options } = await fixture();
    await leaveVerifiedTransaction(options);
    await writeFile(path.join(options.paths.dailyUserDir, "settings.json"), JSON.stringify({ "editor.fontSize": 23 }));
    const status = await new ProfileSyncService(options).apply();
    expect(status.settings).toBe("synced");
    const settings = JSON.parse(await readFile(path.join(options.paths.pocketUserDir, "settings.json"), "utf8"));
    expect(settings["editor.fontSize"]).toBe(23);
    expect(await transactionDirectories(options)).toEqual([]);
  });
});
