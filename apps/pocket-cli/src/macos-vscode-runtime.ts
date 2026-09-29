import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { PocketUpdateStatus } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import { IncompatibleUpdateError } from "../../../packages/pocket-runtime/src/update-lifecycle.js";

const execFileAsync = promisify(execFile);

export const MACOS_VSCODE_VERSION = "1.133.0";
export const MACOS_VSCODE_COMMIT = "a5b500951314efd502d07465bd138dfbd714a960";
export const MACOS_VSCODE_ARCHIVE_SHA256 = "2B13FF21F640AF3B1BE9CF2C267FD5F0175F67004EC6E1263535600F382BF42D";
export const MACOS_VSCODE_EXECUTABLE_SHA256 = "33FE4C45B9DA4BD51758CC4DD7F8176DA9FC9357C6BA0D36EBA4C5F00470AE2C";
export const MACOS_EXTENSION_VERSION = "26.903.71938";
export const MACOS_EXTENSION_VSIX_SHA256 = "ED51674D8F2AF772A9D2401F3F09B60358DE938AF933F436AA9DB29F3F6D4E1C";
export const MACOS_CODEX_SHA256 = "B973D440ACAC501FD2594A43E7CA9CE41E0A65B9DFB28D0D7A7837C99E1261E3";
export const MACOS_EXTENSION_TREE_SHA256 = "5AEC6A4EA1191522AA78521A5BDB31573BDF1598AE029ED30D0E8A0E8CA14E59";
export const MACOS_PROXY_SHA256 = "2C5E3014D749CED6B88AD1BC4807DE2676DF4ACA3EEF74D6CEA3C1A917033389";
export const MACOS_DENO_VERSION = "2.9.6";
export const MACOS_DENO_SHA256 = "B3AC3BD206E48C26026CADD80C1367E96C149F9C66130952382A642B09FA8A71";
export const MACOS_VSCODE_DOWNLOAD_URL = `https://update.code.visualstudio.com/${MACOS_VSCODE_VERSION}/darwin-arm64/stable`;
export const MACOS_EXTENSION_DOWNLOAD_URL = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/openai/vsextensions/chatgpt/${MACOS_EXTENSION_VERSION}/vspackage?targetPlatform=darwin-arm64`;
const MICROSOFT_TEAM_ID = "UBF8T346G9";
const MARKETPLACE_QUERY_URL = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
export const POCKET_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function isPocketUpdateCheckDue(checkedAt: string, nowMs = Date.now()): boolean {
  const checkedAtMs = Date.parse(checkedAt);
  return !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs >= POCKET_UPDATE_INTERVAL_MS;
}

export interface MacosVscodeRuntime {
  app: string;
  codeExecutable: string;
  codeCli: string;
  root: string;
  version: string;
  commit: string;
}

export interface MacosVscodeExtension {
  root: string;
  extensionDirectory: string;
  codexExecutable: string;
}

interface MarketplaceVersion {
  version?: unknown;
  targetPlatform?: unknown;
  flags?: unknown;
  properties?: Array<{ key?: unknown; value?: unknown }>;
}

export function compareNumericVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  if ([...a, ...b].some((part) => !Number.isSafeInteger(part) || part < 0)) throw new Error("Invalid numeric version.");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function latestStableDarwinArm64Version(payload: unknown): { version: string; sha256: string } {
  const extensions = (payload as { results?: Array<{ extensions?: Array<{ versions?: MarketplaceVersion[] }> }> })
    ?.results?.flatMap((result) => result.extensions ?? []) ?? [];
  const candidates = extensions.flatMap((extension) => extension.versions ?? []).filter((version) =>
    version.targetPlatform === "darwin-arm64" && typeof version.version === "string" &&
    typeof version.flags === "string" && version.flags.split(/,\s*/u).includes("validated") &&
    !version.flags.split(/,\s*/u).includes("prerelease"));
  candidates.sort((left, right) => compareNumericVersions(right.version as string, left.version as string));
  const selected = candidates[0];
  const sha256 = selected?.properties?.find((property) =>
    property.key === "Microsoft.VisualStudio.Services.VsixSha256")?.value;
  if (!selected || typeof selected.version !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/iu.test(sha256)) {
    throw new Error("Official Marketplace returned no validated stable Darwin ARM64 Codex artifact.");
  }
  return { version: selected.version, sha256: sha256.toUpperCase() };
}

export async function checkMacosCodexUpdate(
  fetcher: typeof fetch = fetch,
  now = new Date(),
  currentVersion = MACOS_EXTENSION_VERSION,
): Promise<PocketUpdateStatus & { marketplaceSha256: string }> {
  const response = await fetcher(MARKETPLACE_QUERY_URL, {
    method: "POST",
    headers: {
      accept: "application/json;api-version=7.2-preview.1",
      "content-type": "application/json",
      "user-agent": "Codex-Pocket-update-check/1",
    },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: "openai.chatgpt" }], pageNumber: 1, pageSize: 1, sortBy: 0, sortOrder: 0 }],
      assetTypes: [],
      flags: 65_713,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Official Marketplace update check failed with HTTP ${response.status}.`);
  const latest = latestStableDarwinArm64Version(await response.json());
  const updateAvailable = compareNumericVersions(latest.version, currentVersion) > 0;
  return {
    state: updateAvailable ? "updateAvailable" : "upToDate",
    currentVersion,
    availableVersion: latest.version,
    checkedAt: now.toISOString(),
    source: "visualStudioMarketplace",
    restartRequired: updateAvailable,
    marketplaceSha256: latest.sha256,
  };
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

async function assertHash(file: string, expected: string, label: string): Promise<void> {
  const actual = await sha256(file);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: ${JSON.stringify({ expected, actual })}`);
}

export type ExactArtifactDownloader = (url: string) => Promise<Uint8Array>;

async function officialDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "Codex-Pocket-artifact-bootstrap/1" } });
  if (!response.ok) throw new Error(`Official artifact download failed with HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Populate a missing cache entry without ever replacing an existing file. */
export async function ensureExactArtifact(options: {
  destination: string; url: string; sha256: string; label: string; downloader?: ExactArtifactDownloader;
}): Promise<"cached" | "downloaded"> {
  if (await exists(options.destination)) {
    await assertHash(options.destination, options.sha256, options.label);
    return "cached";
  }
  await mkdir(path.dirname(options.destination), { recursive: true, mode: 0o700 });
  const staging = `${options.destination}.download-${process.pid}`;
  await rm(staging, { force: true });
  try {
    const bytes = await (options.downloader ?? officialDownload)(options.url);
    await writeFile(staging, bytes, { flag: "wx", mode: 0o600 });
    await assertHash(staging, options.sha256, options.label);
    await rename(staging, options.destination);
    return "downloaded";
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function bootstrapMacosArtifacts(repoRoot: string): Promise<{
  vscode: "cached" | "downloaded"; extension: "cached" | "downloaded"; deno: "cached" | "installed";
}> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The macOS artifact bootstrap supports Apple Silicon only.");
  }
  const downloads = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", "macos-downloads");
  const vscodeArchive = path.join(downloads, `VSCode-darwin-arm64-${MACOS_VSCODE_VERSION}.zip`);
  const extensionVsix = path.join(downloads, `openai.chatgpt-${MACOS_EXTENSION_VERSION}-darwin-arm64.payload.vsix`);
  const vscode = await ensureExactArtifact({ destination: vscodeArchive, url: MACOS_VSCODE_DOWNLOAD_URL,
    sha256: MACOS_VSCODE_ARCHIVE_SHA256, label: "Pinned macOS VS Code archive" });
  const extension = await ensureExactArtifact({ destination: extensionVsix, url: MACOS_EXTENSION_DOWNLOAD_URL,
    sha256: MACOS_EXTENSION_VSIX_SHA256, label: "Pinned macOS Codex extension VSIX" });
  const denoCache = path.join(downloads, `deno-${MACOS_DENO_VERSION}-darwin-arm64`);
  let deno: "cached" | "installed" = "cached";
  if (await exists(denoCache)) {
    await assertHash(denoCache, MACOS_DENO_SHA256, "Pinned macOS Deno executable");
  } else {
    const packageDeno = path.resolve(repoRoot, "node_modules", ".pnpm", `@deno+darwin-arm64@${MACOS_DENO_VERSION}`,
      "node_modules", "@deno", "darwin-arm64", "deno");
    await access(packageDeno).catch(() => { throw new Error(`Pinned Deno ${MACOS_DENO_VERSION} is missing; run the exact lockfile install first.`); });
    await assertHash(packageDeno, MACOS_DENO_SHA256, "Pinned macOS Deno package executable");
    const staging = `${denoCache}.install-${process.pid}`;
    await copyFile(packageDeno, staging, 0);
    try {
      await chmod(staging, 0o700);
      await assertHash(staging, MACOS_DENO_SHA256, "Staged macOS Deno executable");
      await rename(staging, denoCache);
      deno = "installed";
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return { vscode, extension, deno };
}

export async function extensionTreeSha256(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (directory === root && entry.name === ".vsixmanifest") continue;
      if (entry.isSymbolicLink()) throw new Error(`Pinned macOS Codex extension contains a symlink: ${candidate}`);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(root);
  files.sort();
  const tree = createHash("sha256");
  for (const file of files) {
    const relative = `./${path.relative(root, file).split(path.sep).join("/")}`;
    let fileHash: string;
    if (file === path.join(root, "package.json")) {
      // VS Code rewrites package.json formatting and adds volatile install
      // metadata. Hash the signed payload semantics, not installer timestamps.
      const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      delete manifest.__metadata;
      fileHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    } else {
      fileHash = (await sha256(file)).toLowerCase();
    }
    tree.update(`${fileHash}  ${relative}\n`);
  }
  return tree.digest("hex").toUpperCase();
}

export function validateMacosVscodeProduct(product: { version?: unknown; commit?: unknown }): void {
  if (product.version !== MACOS_VSCODE_VERSION || product.commit !== MACOS_VSCODE_COMMIT) {
    throw new Error(`Pinned macOS VS Code product mismatch: ${JSON.stringify({
      expectedVersion: MACOS_VSCODE_VERSION,
      expectedCommit: MACOS_VSCODE_COMMIT,
      version: product.version,
      commit: product.commit,
    })}`);
  }
}

export function validateMacosCodesignDetails(details: string): void {
  if (!details.includes(`TeamIdentifier=${MICROSOFT_TEAM_ID}`) ||
    !details.includes(`Authority=Developer ID Application: Microsoft Corporation (${MICROSOFT_TEAM_ID})`)) {
    throw new Error("Pinned macOS VS Code signature identity mismatch.");
  }
}

async function verifyRuntime(root: string): Promise<MacosVscodeRuntime> {
  const app = path.join(root, "Visual Studio Code.app");
  const codeExecutable = path.join(app, "Contents", "MacOS", "Code");
  const codeCli = path.join(app, "Contents", "Resources", "app", "out", "cli.js");
  const productPath = path.join(app, "Contents", "Resources", "app", "product.json");
  await Promise.all([access(codeExecutable), access(codeCli), access(productPath)]).catch((error: unknown) => {
    throw new Error(`Pinned macOS VS Code runtime is incomplete at ${root}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const product = JSON.parse(await readFile(productPath, "utf8")) as { version?: unknown; commit?: unknown };
  validateMacosVscodeProduct(product);
  await assertHash(codeExecutable, MACOS_VSCODE_EXECUTABLE_SHA256, "Pinned macOS VS Code executable");
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 30_000 });
  const signature = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=2", app], { timeout: 30_000 });
  validateMacosCodesignDetails(signature.stderr);
  await execFileAsync("/usr/sbin/spctl", ["-a", "-t", "execute", app], { timeout: 30_000 });
  const { stdout } = await execFileAsync(codeExecutable, [codeCli, "--version"], {
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const [version, commit, architecture] = stdout.trim().split(/\r?\n/u);
  if (version !== MACOS_VSCODE_VERSION || commit !== MACOS_VSCODE_COMMIT || architecture !== "arm64") {
    throw new Error(`Pinned macOS VS Code CLI mismatch: ${JSON.stringify({ version, commit, architecture })}`);
  }
  return { app, codeExecutable, codeCli, root, version, commit };
}

export async function prepareMacosVscodeRuntime(repoRoot: string): Promise<MacosVscodeRuntime> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The pinned macOS VS Code runtime requires Apple Silicon.");
  }
  const fixtureRoot = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", `vscode-runtime-macos-${MACOS_VSCODE_VERSION}`);
  if (await exists(path.join(fixtureRoot, "Visual Studio Code.app"))) return verifyRuntime(fixtureRoot);
  const archive = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", "macos-downloads", `VSCode-darwin-arm64-${MACOS_VSCODE_VERSION}.zip`);
  if (!(await exists(archive))) await ensureExactArtifact({ destination: archive, url: MACOS_VSCODE_DOWNLOAD_URL,
    sha256: MACOS_VSCODE_ARCHIVE_SHA256, label: "Pinned macOS VS Code archive" });
  await assertHash(archive, MACOS_VSCODE_ARCHIVE_SHA256, "Pinned macOS VS Code archive");
  const stagingRoot = `${fixtureRoot}.staging-${process.pid}`;
  if (await exists(stagingRoot)) throw new Error(`Refusing existing macOS VS Code staging directory: ${stagingRoot}`);
  await mkdir(stagingRoot, { recursive: true });
  try {
    await execFileAsync("/usr/bin/ditto", ["-x", "-k", archive, stagingRoot], { timeout: 180_000 });
    const verified = await verifyRuntime(stagingRoot);
    await rename(stagingRoot, fixtureRoot);
    return { ...verified, app: path.join(fixtureRoot, path.basename(verified.app)), root: fixtureRoot,
      codeExecutable: verified.codeExecutable.replace(stagingRoot, fixtureRoot),
      codeCli: verified.codeCli.replace(stagingRoot, fixtureRoot) };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function verifyExtension(root: string): Promise<MacosVscodeExtension> {
  const extensionDirectory = path.join(root, `openai.chatgpt-${MACOS_EXTENSION_VERSION}`);
  const manifestPath = path.join(extensionDirectory, "package.json");
  const codexExecutable = path.join(extensionDirectory, "bin", "macos-aarch64", "codex");
  await Promise.all([access(manifestPath), access(codexExecutable)]).catch((error: unknown) => {
    throw new Error(`Pinned macOS Codex extension is incomplete at ${extensionDirectory}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    publisher?: unknown; name?: unknown; version?: unknown;
  };
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt" || manifest.version !== MACOS_EXTENSION_VERSION) {
    throw new Error(`Pinned macOS Codex extension manifest mismatch: ${JSON.stringify(manifest)}`);
  }
  await assertHash(codexExecutable, MACOS_CODEX_SHA256, "Pinned macOS Codex CLI");
  const treeHash = await extensionTreeSha256(extensionDirectory);
  if (treeHash !== MACOS_EXTENSION_TREE_SHA256) {
    throw new Error(`Pinned macOS Codex extension tree SHA-256 mismatch: ${JSON.stringify({
      expected: MACOS_EXTENSION_TREE_SHA256, actual: treeHash,
    })}`);
  }
  if (((await stat(codexExecutable)).mode & 0o111) === 0) throw new Error("Pinned macOS Codex CLI is not executable.");
  return { root, extensionDirectory, codexExecutable };
}

export async function synchronizePinnedMacosExtensionRegistration(
  root: string,
  extensionDirectory: string,
  version = MACOS_EXTENSION_VERSION,
): Promise<void> {
  const canonicalRoot = path.resolve(root);
  const canonicalExtension = path.resolve(extensionDirectory);
  if (path.dirname(canonicalExtension) !== canonicalRoot || path.basename(canonicalExtension) !== `openai.chatgpt-${version}`) {
    throw new Error("Pinned macOS Codex extension registration escaped its Pocket-owned root.");
  }
  const extensionInfo = await lstat(canonicalExtension);
  if (!extensionInfo.isDirectory() || extensionInfo.isSymbolicLink()) {
    throw new Error("Pinned macOS Codex extension must be a normal local directory.");
  }

  const staleDirectories: string[] = [];
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith("openai.chatgpt-") || entry.name === path.basename(canonicalExtension)) continue;
    const candidate = path.join(canonicalRoot, entry.name);
    const info = await lstat(candidate);
    if (!entry.isDirectory() || info.isSymbolicLink() || path.dirname(path.resolve(candidate)) !== canonicalRoot) {
      throw new Error(`Refusing unsafe stale Pocket Codex extension entry: ${entry.name}`);
    }
    staleDirectories.push(candidate);
  }

  const registrationsPath = path.join(canonicalRoot, "extensions.json");
  const registrations = await readFile(registrationsPath, "utf8")
    .then((value) => JSON.parse(value) as Array<{ identifier?: { id?: string } }>, () => []);
  if (!Array.isArray(registrations)) throw new Error("Pocket extension registration file must contain an array.");
  const retained = registrations.filter((item) => item?.identifier?.id?.toLowerCase() !== "openai.chatgpt");
  retained.push({
    identifier: { id: "openai.chatgpt" },
    version,
    location: {
      $mid: 1,
      fsPath: canonicalExtension,
      external: pathToFileURL(canonicalExtension).href,
      path: canonicalExtension,
      scheme: "file",
    },
    relativeLocation: path.basename(canonicalExtension),
    metadata: { installedTimestamp: Date.now(), pinned: true, source: "vsix" },
  } as unknown as { identifier?: { id?: string } });
  const temporary = `${registrationsPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(retained)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, registrationsPath);
  for (const stale of staleDirectories) await rm(stale, { recursive: true, force: true });
}

export async function prepareMacosVscodeExtension(
  repoRoot: string,
  runtime: MacosVscodeRuntime,
): Promise<MacosVscodeExtension> {
  const root = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", "vscode-extensions-macos");
  if (await exists(path.join(root, `openai.chatgpt-${MACOS_EXTENSION_VERSION}`))) {
    const verified = await verifyExtension(root);
    await synchronizePinnedMacosExtensionRegistration(root, verified.extensionDirectory);
    return verified;
  }
  const vsix = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", "macos-downloads",
    `openai.chatgpt-${MACOS_EXTENSION_VERSION}-darwin-arm64.payload.vsix`);
  if (!(await exists(vsix))) await ensureExactArtifact({ destination: vsix, url: MACOS_EXTENSION_DOWNLOAD_URL,
    sha256: MACOS_EXTENSION_VSIX_SHA256, label: "Pinned macOS Codex extension VSIX" });
  await assertHash(vsix, MACOS_EXTENSION_VSIX_SHA256, "Pinned macOS Codex extension VSIX");
  const stagingRoot = `${root}.staging-${process.pid}`;
  if (await exists(stagingRoot)) throw new Error(`Refusing existing macOS extension staging directory: ${stagingRoot}`);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    await execFileAsync(runtime.codeExecutable, [runtime.codeCli,
      "--extensions-dir", stagingRoot,
      "--install-extension", vsix,
      "--force",
    ], { timeout: 180_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const verified = await verifyExtension(stagingRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await rename(verified.extensionDirectory, path.join(root, path.basename(verified.extensionDirectory)));
    await rm(stagingRoot, { recursive: true, force: true });
    const published = await verifyExtension(root);
    await synchronizePinnedMacosExtensionRegistration(root, published.extensionDirectory);
    return published;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function prepareMacosProxy(repoRoot: string): Promise<string> {
  const outputRoot = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", "macos-proxy");
  const output = path.join(outputRoot, "codex-pocket-proxy");
  if (!(await exists(output))) {
    const cachedDeno = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", "macos-downloads", `deno-${MACOS_DENO_VERSION}-darwin-arm64`);
    if (!(await exists(cachedDeno))) await bootstrapMacosArtifacts(repoRoot);
    const deno = cachedDeno;
    const source = path.resolve(repoRoot, "tools", "vscode-proxy", "main.ts");
    await Promise.all([access(deno), access(source), mkdir(outputRoot, { recursive: true })]);
    await execFileAsync(deno, ["compile", "--quiet", "--no-config", "--node-modules-dir=none",
      "--allow-env", "--allow-read", "--allow-write", "--allow-run", "--allow-net=127.0.0.1",
      "--output", output, source,
    ], { cwd: repoRoot, timeout: 180_000 });
  }
  await assertHash(output, MACOS_PROXY_SHA256, "Pinned macOS Pocket proxy");
  if (((await stat(output)).mode & 0o111) === 0) throw new Error("Pinned macOS Pocket proxy is not executable.");
  return output;
}

export interface MacosExtensionCandidate {
  version: string;
  vsixSha256: string;
  cliVersion: string;
  cliSha256: string;
  treeSha256: string;
  candidateId: string;
  root: string;
  extensionDirectory: string;
  codexExecutable: string;
}

export interface ActiveExtensionPointer {
  version: 1;
  source: "visualStudioMarketplace";
  targetPlatform: "darwin-arm64";
  stableValidated: true;
  candidateId: string;
  extensionVersion: string;
  vsixSha256: string;
  cliVersion: string;
  cliSha256: string;
  treeSha256: string;
}

function updatesRoot(repoRoot: string): string {
  return path.resolve(repoRoot, ".codex-pocket", "updates");
}

export function activeMacosExtensionPointerPath(repoRoot: string): string {
  return path.join(updatesRoot(repoRoot), "active-extension.json");
}

function candidateId(version: string, sha: string): string {
  if (!/^\d+(?:\.\d+)+$/u.test(version) || !/^[0-9a-f]{64}$/iu.test(sha)) throw new Error("Invalid update candidate identity.");
  return `${version}-${sha.slice(0, 16).toLowerCase()}`;
}

async function assertPocketOwnedRoot(root: string, repoRoot: string): Promise<void> {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(root));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Pocket update path is outside the repository-owned data root.");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  let current = path.resolve(repoRoot);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error("Pocket update root must be a canonical non-symlink directory.");
    }
  }
  await chmod(root, 0o700);
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Update candidate path escapes the Pocket-owned update root.");
  }
}

function parseVsixIdentity(xml: string): { publisher: string; id: string; version: string; targetPlatform: string } {
  const identity = /<Identity\b([^>]+)\/>/u.exec(xml)?.[1] ?? "";
  const value = (name: string): string => new RegExp(`\\b${name}="([^"]+)"`, "u").exec(identity)?.[1] ?? "";
  return { publisher: value("Publisher"), id: value("Id"), version: value("Version"), targetPlatform: value("TargetPlatform") };
}

function minimumVscodeVersion(range: string): string | null {
  return /(?:\^|>=|~)?\s*(\d+\.\d+\.\d+)/u.exec(range)?.[1] ?? null;
}

async function assertSafeVsixEntries(vsix: string): Promise<void> {
  let listing: string;
  try {
    listing = (await execFileAsync("/usr/bin/zipinfo", ["-1", vsix], { timeout: 30_000 })).stdout;
  } catch {
    throw new Error("VSIX integrity check failed: archive is corrupt.");
  }
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (!entries.includes("extension.vsixmanifest") || !entries.some((entry) => entry === "extension/package.json")) {
    throw new Error("VSIX integrity check failed: required manifest entries are missing.");
  }
  for (const entry of entries) {
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const parts = normalized.split("/");
    if (entry.startsWith("/") || entry.includes("\\") || parts.includes("..") || parts.includes("")) {
      throw new Error("VSIX integrity check failed: archive path escapes staging.");
    }
  }
}

async function verifyDynamicExtension(root: string, version: string, expectedVsixSha256: string,
  candidate: string): Promise<MacosExtensionCandidate> {
  assertWithin(updatesRoot(root), candidate);
  const extensionRoot = path.join(candidate, "extensions");
  const extensionDirectory = path.join(extensionRoot, `openai.chatgpt-${version}`);
  const manifestPath = path.join(extensionDirectory, "package.json");
  const codexExecutable = path.join(extensionDirectory, "bin", "macos-aarch64", "codex");
  for (const directory of [candidate, extensionRoot, extensionDirectory]) {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Staged extension path contains a symlink escape.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    publisher?: unknown; name?: unknown; version?: unknown; engines?: { vscode?: unknown };
  };
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt" || manifest.version !== version) {
    throw new Error("Staged extension metadata identity/version mismatch.");
  }
  const engine = typeof manifest.engines?.vscode === "string" ? minimumVscodeVersion(manifest.engines.vscode) : null;
  if (!engine || compareNumericVersions(engine, MACOS_VSCODE_VERSION) > 0) {
    throw new IncompatibleUpdateError(`Codex update is incompatible with pinned VS Code ${MACOS_VSCODE_VERSION}.`);
  }
  const fileResult = await execFileAsync("/usr/bin/file", [codexExecutable], { timeout: 15_000 });
  if (!/Mach-O 64-bit executable arm64/u.test(fileResult.stdout)) throw new Error("Bundled Codex CLI is not a Darwin ARM64 executable.");
  if (((await stat(codexExecutable)).mode & 0o111) === 0) throw new Error("Bundled Codex CLI is not executable.");
  const cliResult = await execFileAsync(codexExecutable, ["--version"], { timeout: 15_000 });
  const cliVersion = /^codex-cli\s+(\S+)$/u.exec(cliResult.stdout.trim())?.[1];
  if (!cliVersion) throw new Error("Bundled Codex CLI returned an invalid version.");
  return {
    version, vsixSha256: expectedVsixSha256.toUpperCase(), cliVersion,
    cliSha256: await sha256(codexExecutable), treeSha256: await extensionTreeSha256(extensionDirectory),
    candidateId: path.basename(candidate), root: extensionRoot, extensionDirectory, codexExecutable,
  };
}

export async function stageMacosCodexUpdate(options: {
  repoRoot: string;
  runtime: MacosVscodeRuntime;
  version: string;
  sha256: string;
  downloader?: ExactArtifactDownloader;
}): Promise<MacosExtensionCandidate> {
  const root = updatesRoot(options.repoRoot);
  await assertPocketOwnedRoot(root, options.repoRoot);
  const id = candidateId(options.version, options.sha256);
  const candidatesRoot = path.join(root, "candidates");
  const downloadsRoot = path.join(root, "downloads");
  await Promise.all([assertPocketOwnedRoot(candidatesRoot, options.repoRoot), assertPocketOwnedRoot(downloadsRoot, options.repoRoot)]);
  const finalRoot = path.join(candidatesRoot, id);
  assertWithin(root, finalRoot);
  if (await exists(path.join(finalRoot, "candidate.json"))) {
    return await readMacosExtensionCandidate(options.repoRoot, id);
  }
  if (await exists(finalRoot)) throw new Error("Refusing an incomplete existing update candidate directory.");
  const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/openai/vsextensions/chatgpt/${options.version}/vspackage?targetPlatform=darwin-arm64`;
  const vsix = path.join(downloadsRoot, `openai.chatgpt-${id}-darwin-arm64.vsix`);
  await ensureExactArtifact({ destination: vsix, url, sha256: options.sha256,
    label: "macOS Codex update VSIX", ...(options.downloader ? { downloader: options.downloader } : {}) });
  await assertSafeVsixEntries(vsix);
  const manifestXml = (await execFileAsync("/usr/bin/unzip", ["-p", vsix, "extension.vsixmanifest"], { timeout: 30_000 })).stdout;
  const identity = parseVsixIdentity(manifestXml);
  if (identity.publisher !== "openai" || identity.id !== "chatgpt" || identity.version !== options.version ||
    identity.targetPlatform !== "darwin-arm64") throw new Error("Official VSIX identity or target platform mismatch.");
  const stagingRoot = path.join(candidatesRoot, `.staging-${id}-${process.pid}`);
  if (await exists(stagingRoot)) throw new Error("Refusing an existing update staging directory.");
  await mkdir(path.join(stagingRoot, "extensions"), { recursive: true, mode: 0o700 });
  try {
    await execFileAsync(options.runtime.codeExecutable, [options.runtime.codeCli, "--extensions-dir", path.join(stagingRoot, "extensions"),
      "--install-extension", vsix, "--force"], { timeout: 180_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const verified = await verifyDynamicExtension(options.repoRoot, options.version, options.sha256, stagingRoot);
    const metadata: ActiveExtensionPointer = { version: 1, source: "visualStudioMarketplace", targetPlatform: "darwin-arm64",
      stableValidated: true, candidateId: id, extensionVersion: verified.version,
      vsixSha256: verified.vsixSha256, cliVersion: verified.cliVersion, cliSha256: verified.cliSha256, treeSha256: verified.treeSha256 };
    await writeFile(path.join(stagingRoot, "candidate.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(stagingRoot, finalRoot);
    return await readMacosExtensionCandidate(options.repoRoot, id);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readMacosExtensionCandidate(repoRoot: string, id: string): Promise<MacosExtensionCandidate> {
  const root = updatesRoot(repoRoot);
  await assertPocketOwnedRoot(root, repoRoot);
  if (!/^\d+(?:\.\d+)+-[0-9a-f]{16}$/u.test(id)) throw new Error("Invalid staged candidate identifier.");
  const candidateRoot = path.join(root, "candidates", id);
  assertWithin(root, candidateRoot);
  const metadataPath = path.join(candidateRoot, "candidate.json");
  if ((await lstat(metadataPath)).isSymbolicLink()) throw new Error("Staged candidate metadata must not be a symlink.");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ActiveExtensionPointer;
  if (metadata.version !== 1 || metadata.source !== "visualStudioMarketplace" || metadata.targetPlatform !== "darwin-arm64" ||
    metadata.stableValidated !== true || metadata.candidateId !== id || candidateId(metadata.extensionVersion, metadata.vsixSha256) !== id) {
    throw new Error("Staged candidate metadata mismatch.");
  }
  const verified = await verifyDynamicExtension(repoRoot, metadata.extensionVersion, metadata.vsixSha256, candidateRoot);
  if (verified.cliVersion !== metadata.cliVersion || verified.cliSha256 !== metadata.cliSha256 || verified.treeSha256 !== metadata.treeSha256) {
    throw new Error("Staged candidate content no longer matches its verified metadata.");
  }
  return verified;
}

export async function readActiveMacosVscodeExtension(repoRoot: string, runtime: MacosVscodeRuntime): Promise<
  MacosVscodeExtension & { version: string; vsixSha256: string; cliVersion: string; cliSha256: string; treeSha256: string; candidateId?: string }
> {
  const pointerPath = activeMacosExtensionPointerPath(repoRoot);
  if (!(await exists(pointerPath))) {
    const extension = await prepareMacosVscodeExtension(repoRoot, runtime);
    return { ...extension, version: MACOS_EXTENSION_VERSION, vsixSha256: MACOS_EXTENSION_VSIX_SHA256,
      cliVersion: "0.153.4", cliSha256: MACOS_CODEX_SHA256,
      treeSha256: MACOS_EXTENSION_TREE_SHA256 };
  }
  if ((await lstat(pointerPath)).isSymbolicLink()) throw new Error("Active extension pointer must not be a symlink.");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as ActiveExtensionPointer;
  const candidate = await readMacosExtensionCandidate(repoRoot, pointer.candidateId);
  if (pointer.extensionVersion !== candidate.version || pointer.vsixSha256 !== candidate.vsixSha256 ||
    pointer.cliVersion !== candidate.cliVersion || pointer.cliSha256 !== candidate.cliSha256 || pointer.treeSha256 !== candidate.treeSha256) {
    throw new Error("Active extension pointer does not match the validated candidate.");
  }
  return { root: candidate.root, extensionDirectory: candidate.extensionDirectory, codexExecutable: candidate.codexExecutable,
    version: candidate.version, vsixSha256: candidate.vsixSha256, cliVersion: candidate.cliVersion, cliSha256: candidate.cliSha256,
    treeSha256: candidate.treeSha256, candidateId: candidate.candidateId };
}

export async function promoteMacosExtensionCandidate(repoRoot: string, candidate: MacosExtensionCandidate): Promise<{
  previousVersion: string; previousPointer: ActiveExtensionPointer | null;
}> {
  const root = updatesRoot(repoRoot);
  await assertPocketOwnedRoot(root, repoRoot);
  const pointerPath = activeMacosExtensionPointerPath(repoRoot);
  if (await exists(pointerPath) && (await lstat(pointerPath)).isSymbolicLink()) throw new Error("Active extension pointer must not be a symlink.");
  const previousPointer = await readFile(pointerPath, "utf8").then((value) => JSON.parse(value) as ActiveExtensionPointer, () => null);
  const pointer: ActiveExtensionPointer = { version: 1, source: "visualStudioMarketplace", targetPlatform: "darwin-arm64",
    stableValidated: true, candidateId: candidate.candidateId, extensionVersion: candidate.version,
    vsixSha256: candidate.vsixSha256, cliVersion: candidate.cliVersion, cliSha256: candidate.cliSha256, treeSha256: candidate.treeSha256 };
  const temporary = `${pointerPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, pointerPath);
  return { previousVersion: previousPointer?.extensionVersion ?? MACOS_EXTENSION_VERSION, previousPointer };
}

export async function restoreMacosExtensionPointer(repoRoot: string, pointer: ActiveExtensionPointer | null): Promise<void> {
  const root = updatesRoot(repoRoot);
  await assertPocketOwnedRoot(root, repoRoot);
  const destination = activeMacosExtensionPointerPath(repoRoot);
  if (!pointer) { await rm(destination, { force: true }); return; }
  const candidate = await readMacosExtensionCandidate(repoRoot, pointer.candidateId);
  if (pointer.version !== 1 || pointer.extensionVersion !== candidate.version || pointer.vsixSha256 !== candidate.vsixSha256 ||
    pointer.cliVersion !== candidate.cliVersion || pointer.cliSha256 !== candidate.cliSha256 || pointer.treeSha256 !== candidate.treeSha256) {
    throw new Error("Rollback extension pointer does not match its validated candidate.");
  }
  const temporary = `${destination}.${process.pid}.rollback.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
}

export async function cleanupStaleMacosUpdateCandidates(repoRoot: string, protectedCandidateId?: string): Promise<void> {
  const root = updatesRoot(repoRoot);
  await assertPocketOwnedRoot(root, repoRoot);
  const candidatesRoot = path.join(root, "candidates");
  await assertPocketOwnedRoot(candidatesRoot, repoRoot);
  const active = await readFile(activeMacosExtensionPointerPath(repoRoot), "utf8")
    .then((value) => (JSON.parse(value) as ActiveExtensionPointer).candidateId, () => null);
  const candidates: Array<{ name: string; modified: number }> = [];
  for (const entry of await readdir(candidatesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(candidatesRoot, entry.name);
    if (entry.name.startsWith(".staging-")) { await rm(target, { recursive: true, force: true }); continue; }
    if (/^\d+(?:\.\d+)+-[0-9a-f]{16}$/u.test(entry.name)) candidates.push({ name: entry.name, modified: (await stat(target)).mtimeMs });
  }
  const keep = new Set([active, protectedCandidateId].filter((value): value is string => Boolean(value)));
  for (const candidate of candidates.sort((left, right) => right.modified - left.modified).slice(0, 2)) keep.add(candidate.name);
  for (const candidate of candidates) if (!keep.has(candidate.name)) {
    await rm(path.join(candidatesRoot, candidate.name), { recursive: true, force: true });
  }
  const downloadsRoot = path.join(root, "downloads");
  await assertPocketOwnedRoot(downloadsRoot, repoRoot);
  const downloads: Array<{ name: string; modified: number }> = [];
  for (const entry of await readdir(downloadsRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = path.join(downloadsRoot, entry.name);
    if (entry.name.includes(".download-")) { await rm(target, { force: true }); continue; }
    if (/^openai\.chatgpt-\d+(?:\.\d+)+-[0-9a-f]{16}-darwin-arm64\.vsix$/u.test(entry.name)) {
      downloads.push({ name: entry.name, modified: (await stat(target)).mtimeMs });
    }
  }
  const downloadKeep = new Set(downloads.sort((left, right) => right.modified - left.modified).slice(0, 2).map((item) => item.name));
  for (const download of downloads) {
    if (protectedCandidateId && download.name.includes(`-${protectedCandidateId}-`)) downloadKeep.add(download.name);
    if (active && download.name.includes(`-${active}-`)) downloadKeep.add(download.name);
  }
  for (const download of downloads) if (!downloadKeep.has(download.name)) await rm(path.join(downloadsRoot, download.name), { force: true });
}
