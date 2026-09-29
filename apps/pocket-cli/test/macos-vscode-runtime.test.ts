import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  MACOS_VSCODE_COMMIT,
  MACOS_VSCODE_VERSION,
  MACOS_EXTENSION_VERSION,
  compareNumericVersions,
  cleanupStaleMacosUpdateCandidates,
  ensureExactArtifact,
  extensionTreeSha256,
  isPocketUpdateCheckDue,
  latestStableDarwinArm64Version,
  promoteMacosExtensionCandidate,
  readActiveMacosVscodeExtension,
  stageMacosCodexUpdate,
  synchronizePinnedMacosExtensionRegistration,
  validateMacosCodesignDetails,
  validateMacosVscodeProduct,
} from "../src/macos-vscode-runtime.js";

const execFileAsync = promisify(execFile);

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))); });

describe("macOS pinned VS Code identity", () => {
  it("accepts only the exact version and commit", () => {
    expect(() => validateMacosVscodeProduct({
      version: MACOS_VSCODE_VERSION, commit: MACOS_VSCODE_COMMIT,
    })).not.toThrow();
    expect(() => validateMacosVscodeProduct({
      version: "1.135.0", commit: MACOS_VSCODE_COMMIT,
    })).toThrow("product mismatch");
  });

  it("requires the Microsoft Developer ID team", () => {
    expect(() => validateMacosCodesignDetails([
      "Authority=Developer ID Application: Microsoft Corporation (UBF8T346G9)",
      "TeamIdentifier=UBF8T346G9",
    ].join("\n"))).not.toThrow();
    expect(() => validateMacosCodesignDetails("TeamIdentifier=UNTRUSTED"))
      .toThrow("signature identity mismatch");
  });
});

describe("macOS exact artifact cache", () => {
  it("downloads a missing artifact through staging and then reuses the verified cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-artifact-"));
    temporaryRoots.push(root);
    const destination = path.join(root, "nested", "artifact.zip");
    const bytes = new TextEncoder().encode("exact official payload");
    const expected = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    let calls = 0;
    const downloader = async (): Promise<Uint8Array> => { calls += 1; return bytes; };
    await expect(ensureExactArtifact({ destination, url: "https://official.invalid/exact", sha256: expected,
      label: "test artifact", downloader })).resolves.toBe("downloaded");
    await expect(ensureExactArtifact({ destination, url: "https://official.invalid/exact", sha256: expected,
      label: "test artifact", downloader })).resolves.toBe("cached");
    expect(calls).toBe(1);
    expect(await readFile(destination, "utf8")).toBe("exact official payload");
  });

  it("fails closed without replacing a mismatched cache or keeping a bad staging file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-artifact-"));
    temporaryRoots.push(root);
    const destination = path.join(root, "artifact.vsix");
    await writeFile(destination, "tampered");
    await expect(ensureExactArtifact({ destination, url: "https://official.invalid/exact", sha256: "0".repeat(64),
      label: "test artifact", downloader: async () => new TextEncoder().encode("replacement") })).rejects.toThrow("SHA-256 mismatch");
    expect(await readFile(destination, "utf8")).toBe("tampered");
  });
});

describe("macOS Codex update discovery", () => {
  it("selects only the newest validated stable Darwin ARM64 artifact and its published hash", () => {
    const sha = "ab".repeat(32);
    const selected = latestStableDarwinArm64Version({ results: [{ extensions: [{ versions: [
      { version: "26.904.2", targetPlatform: "darwin-arm64", flags: "validated, prerelease",
        properties: [{ key: "Microsoft.VisualStudio.Services.VsixSha256", value: sha }] },
      { version: "26.903.8", targetPlatform: "win32-x64", flags: "validated",
        properties: [{ key: "Microsoft.VisualStudio.Services.VsixSha256", value: sha }] },
      { version: "26.903.7", targetPlatform: "darwin-arm64", flags: "validated",
        properties: [{ key: "Microsoft.VisualStudio.Services.VsixSha256", value: sha }] },
      { version: "26.902.9", targetPlatform: "darwin-arm64", flags: "validated",
        properties: [{ key: "Microsoft.VisualStudio.Services.VsixSha256", value: sha }] },
    ] }] }] });
    expect(selected).toEqual({ version: "26.903.7", sha256: sha.toUpperCase() });
    expect(compareNumericVersions("26.903.7", "26.902.99")).toBeGreaterThan(0);
  });

  it("fails closed when Marketplace omits a validated hash", () => {
    expect(() => latestStableDarwinArm64Version({ results: [] })).toThrow("no validated stable");
  });

  it("checks once per 24 hours and treats invalid state as due", () => {
    const now = Date.parse("2026-09-09T12:00:00.000Z");
    expect(isPocketUpdateCheckDue("2026-09-08T12:00:00.001Z", now)).toBe(false);
    expect(isPocketUpdateCheckDue("2026-09-08T12:00:00.000Z", now)).toBe(true);
    expect(isPocketUpdateCheckDue("not-a-date", now)).toBe(true);
  });
});

describe("macOS pinned extension registration", () => {
  it("atomically selects the pinned version and removes only stale Pocket Codex directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-extension-registration-"));
    temporaryRoots.push(root);
    const current = path.join(root, `openai.chatgpt-${MACOS_EXTENSION_VERSION}`);
    const stale = path.join(root, "openai.chatgpt-26.903.61454");
    const other = path.join(root, "example.safe-1.0.0");
    await Promise.all([mkdir(current), mkdir(stale), mkdir(other)]);
    await writeFile(path.join(root, "extensions.json"), JSON.stringify([
      { identifier: { id: "openai.chatgpt" }, version: "26.903.61454", relativeLocation: path.basename(stale) },
      { identifier: { id: "example.safe" }, version: "1.0.0", relativeLocation: path.basename(other) },
    ]));

    await synchronizePinnedMacosExtensionRegistration(root, current);

    const registrations = JSON.parse(await readFile(path.join(root, "extensions.json"), "utf8")) as Array<{
      identifier?: { id?: string };
      version?: string;
      relativeLocation?: string;
      location?: { fsPath?: string; scheme?: string };
    }>;
    expect(registrations.filter((item) => item.identifier?.id === "openai.chatgpt")).toHaveLength(1);
    expect(registrations.find((item) => item.identifier?.id === "openai.chatgpt")).toMatchObject({
      version: MACOS_EXTENSION_VERSION,
      relativeLocation: path.basename(current),
      location: { fsPath: current, scheme: "file" },
    });
    expect(registrations.some((item) => item.identifier?.id === "example.safe")).toBe(true);
    await expect(access(stale)).rejects.toThrow();
    await expect(access(other)).resolves.toBeUndefined();
  });

  it("refuses a stale symlink before changing registration metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-extension-registration-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "pocket-extension-registration-outside-"));
    temporaryRoots.push(root, outside);
    const current = path.join(root, `openai.chatgpt-${MACOS_EXTENSION_VERSION}`);
    await mkdir(current);
    await symlink(outside, path.join(root, "openai.chatgpt-26.903.61454"));
    await writeFile(path.join(root, "extensions.json"), "[]\n");
    await expect(synchronizePinnedMacosExtensionRegistration(root, current)).rejects.toThrow("unsafe stale");
    expect(await readFile(path.join(root, "extensions.json"), "utf8")).toBe("[]\n");
  });
});

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("macOS staged Codex update", () => {
  async function fixtureRuntime(root: string, version: string) {
    const installer = path.join(root, "install-extension.sh");
    await writeFile(installer, `#!/bin/sh
set -eu
extensions=""
vsix=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --extensions-dir) extensions="$2"; shift 2 ;;
    --install-extension) vsix="$2"; shift 2 ;;
    *) shift ;;
  esac
done
target="$extensions/openai.chatgpt-${version}"
mkdir -p "$target"
/usr/bin/unzip -q "$vsix" 'extension/*' -d "$target.tmp"
cp -R "$target.tmp/extension/." "$target/"
rm -rf "$target.tmp"
`, { mode: 0o700 });
    return { app: root, codeExecutable: "/bin/sh", codeCli: installer, root,
      version: MACOS_VSCODE_VERSION, commit: MACOS_VSCODE_COMMIT };
  }

  async function manifestVsix(identity: { publisher?: string; id?: string; version?: string; platform?: string }): Promise<Uint8Array> {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-vsix-fixture-"));
    temporaryRoots.push(root);
    await writeFile(path.join(root, "extension.vsixmanifest"), [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<PackageManifest><Metadata><Identity Publisher="${identity.publisher ?? "openai"}" Id="${identity.id ?? "chatgpt"}" Version="${identity.version ?? "26.999.1"}" TargetPlatform="${identity.platform ?? "darwin-arm64"}"/></Metadata></PackageManifest>`,
    ].join("\n"));
    await mkdir(path.join(root, "extension"));
    await writeFile(path.join(root, "extension", "package.json"), "{}\n");
    const archive = path.join(root, "fixture.vsix");
    await execFileAsync("/usr/bin/zip", ["-q", "-r", archive, "extension.vsixmanifest", "extension"], { cwd: root });
    return new Uint8Array(await readFile(archive));
  }

  async function validVsix(version: string): Promise<Uint8Array> {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-vsix-valid-"));
    temporaryRoots.push(root);
    const extension = path.join(root, "extension");
    const binaryDirectory = path.join(extension, "bin", "macos-aarch64");
    await mkdir(binaryDirectory, { recursive: true });
    await writeFile(path.join(root, "extension.vsixmanifest"), [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<PackageManifest><Metadata><Identity Publisher="openai" Id="chatgpt" Version="${version}" TargetPlatform="darwin-arm64"/></Metadata></PackageManifest>`,
    ].join("\n"));
    await writeFile(path.join(extension, "package.json"), JSON.stringify({
      publisher: "openai", name: "chatgpt", version, engines: { vscode: "^1.100.0" },
    }));
    const source = path.join(root, "codex.c");
    const binary = path.join(binaryDirectory, "codex");
    await writeFile(source, '#include <stdio.h>\nint main(void) { puts("codex-cli 0.153.4"); return 0; }\n');
    await execFileAsync("/usr/bin/clang", ["-arch", "arm64", source, "-o", binary]);
    const archive = path.join(root, "fixture.vsix");
    await execFileAsync("/usr/bin/zip", ["-q", "-r", archive, "extension.vsixmanifest", "extension"], { cwd: root });
    return new Uint8Array(await readFile(archive));
  }

  it("stages and re-reads the exact known-good VSIX through the production validation path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-update-real-"));
    temporaryRoots.push(root);
    const bytes = await validVsix(MACOS_EXTENSION_VERSION);
    const expectedHash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    const runtime = await fixtureRuntime(root, MACOS_EXTENSION_VERSION);
    const staged = await stageMacosCodexUpdate({ repoRoot: root, runtime, version: MACOS_EXTENSION_VERSION,
      sha256: expectedHash, downloader: async () => bytes });
    expect(staged).toMatchObject({ version: MACOS_EXTENSION_VERSION, vsixSha256: expectedHash,
      cliVersion: "0.153.4" });
    await promoteMacosExtensionCandidate(root, staged);
    const active = await readActiveMacosVscodeExtension(root, runtime);
    expect(active).toMatchObject({ version: MACOS_EXTENSION_VERSION, cliVersion: "0.153.4",
      candidateId: staged.candidateId });
  }, 180_000);

  it.each([
    [{ publisher: "other" }, "identity"],
    [{ platform: "win32-x64" }, "target platform"],
  ] as const)("rejects invalid VSIX metadata %j", async (identity, expected) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-update-invalid-"));
    temporaryRoots.push(root);
    const bytes = await manifestVsix(identity);
    const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    const runtime = await fixtureRuntime(root, identity.version ?? "26.999.1");
    await expect(stageMacosCodexUpdate({ repoRoot: root, runtime, version: identity.version ?? "26.999.1",
      sha256: hash, downloader: async () => bytes })).rejects.toThrow(expected);
  }, 30_000);

  it("rejects a published hash mismatch before VSIX inspection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-update-corrupt-"));
    temporaryRoots.push(root);
    const runtime = await fixtureRuntime(root, "26.999.1");
    const bytes = new TextEncoder().encode("not a vsix");
    await expect(stageMacosCodexUpdate({ repoRoot: root, runtime, version: "26.999.1", sha256: "0".repeat(64),
      downloader: async () => bytes })).rejects.toThrow("SHA-256 mismatch");
  }, 30_000);

  it("rejects a corrupt VSIX even when its expected hash matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-update-corrupt-"));
    temporaryRoots.push(root);
    const runtime = await fixtureRuntime(root, "26.999.1");
    const bytes = new TextEncoder().encode("not a vsix");
    const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    await expect(stageMacosCodexUpdate({ repoRoot: root, runtime, version: "26.999.1", sha256: hash,
      downloader: async () => bytes })).rejects.toThrow("archive is corrupt");
  }, 30_000);

  it("rejects symlinks from extension tree validation and a symlinked Pocket update root", async () => {
    const tree = await mkdtemp(path.join(os.tmpdir(), "pocket-update-tree-"));
    temporaryRoots.push(tree);
    await writeFile(path.join(tree, "payload"), "safe");
    await symlink("payload", path.join(tree, "escape"));
    await expect(extensionTreeSha256(tree)).rejects.toThrow("contains a symlink");

    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-update-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "pocket-update-outside-"));
    temporaryRoots.push(root, outside);
    await mkdir(path.join(root, ".codex-pocket"));
    await symlink(outside, path.join(root, ".codex-pocket", "updates"));
    const runtime = await fixtureRuntime(root, "26.999.1");
    await expect(stageMacosCodexUpdate({ repoRoot: root, runtime, version: "26.999.1", sha256: "0".repeat(64),
      downloader: async () => new Uint8Array() })).rejects.toThrow("non-symlink");
  }, 30_000);

  it("cleans interrupted staging and bounds inactive candidate/download accumulation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-update-cleanup-"));
    temporaryRoots.push(root);
    const candidates = path.join(root, ".codex-pocket", "updates", "candidates");
    const downloads = path.join(root, ".codex-pocket", "updates", "downloads");
    await Promise.all([mkdir(candidates, { recursive: true }), mkdir(downloads, { recursive: true })]);
    await mkdir(path.join(candidates, ".staging-interrupted"));
    const ids = [1, 2, 3, 4].map((value) => `26.90${value}.1-${String(value).repeat(16)}`);
    for (const [index, id] of ids.entries()) {
      const directory = path.join(candidates, id);
      const download = path.join(downloads, `openai.chatgpt-${id}-darwin-arm64.vsix`);
      await mkdir(directory);
      await writeFile(download, id);
      await Promise.all([utimes(directory, index + 1, index + 1), utimes(download, index + 1, index + 1)]);
    }
    await writeFile(path.join(downloads, "orphan.download-999"), "partial");
    await cleanupStaleMacosUpdateCandidates(root, ids[0]);
    await expect(access(path.join(candidates, ".staging-interrupted"))).rejects.toThrow();
    await expect(access(path.join(downloads, "orphan.download-999"))).rejects.toThrow();
    await expect(access(path.join(candidates, ids[1]!))).rejects.toThrow();
    await expect(access(path.join(downloads, `openai.chatgpt-${ids[1]}-darwin-arm64.vsix`))).rejects.toThrow();
    await expect(access(path.join(candidates, ids[0]!))).resolves.toBeUndefined();
    await expect(access(path.join(candidates, ids[3]!))).resolves.toBeUndefined();
  });
});
