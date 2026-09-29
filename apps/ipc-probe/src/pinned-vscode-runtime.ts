import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PINNED_VSCODE_VERSION = "1.133.0";
export const PINNED_VSCODE_COMMIT = "a5b500951314efd502d07465bd138dfbd714a960";
const PINNED_VSCODE_COMMIT_DIRECTORY = PINNED_VSCODE_COMMIT.slice(0, 10);
export const PINNED_EXTENSION_VERSION = "26.814.41407";
export const PINNED_CODEX_SHA256 = "17E4FED6D6676AE0B894A7C39821DD1C50C1A786EEFB05362A3F9FDA678AF466";
export const PINNED_EXTENSION_VSIX_SHA256 = "41E3E6BCCE0664E539618E3EA525BD0B62C9A2D0440364BBFC7A1773D600DD9C";
const PINNED_EXTENSION_DIRECTORY = `openai.chatgpt-${PINNED_EXTENSION_VERSION}`;
const PINNED_EXTENSION_GLOBAL_DIRECTORY = `${PINNED_EXTENSION_DIRECTORY}-win32-x64`;
const PINNED_EXTENSION_VSIX = `${PINNED_EXTENSION_GLOBAL_DIRECTORY}.vsix`;

export interface PinnedVscodeRuntime {
  codeExecutable: string;
  codeCli: string;
  root: string;
  version: string;
  commit: string;
  source: "explicit" | "fixture" | "installed-copy";
}

export interface PinnedVscodeExtension {
  root: string;
  extensionDirectory: string;
  codexExecutable: string;
  source: "fixture" | "global-copy" | "cached-vsix";
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

async function verifyExtension(
  extensionsRoot: string,
  source: PinnedVscodeExtension["source"],
): Promise<PinnedVscodeExtension> {
  const extensionDirectory = path.join(extensionsRoot, PINNED_EXTENSION_DIRECTORY);
  const packagePath = path.join(extensionDirectory, "package.json");
  const codexExecutable = path.join(extensionDirectory, "bin", "windows-x86_64", "codex.exe");
  await Promise.all([access(packagePath), access(codexExecutable)]).catch((error: unknown) => {
    throw new Error(`Pinned Codex extension fixture is incomplete at ${extensionDirectory}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { publisher?: unknown; name?: unknown; version?: unknown };
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt" || manifest.version !== PINNED_EXTENSION_VERSION) {
    throw new Error(`Pinned Codex extension manifest mismatch: ${JSON.stringify({
      publisher: manifest.publisher, name: manifest.name, version: manifest.version,
    })}`);
  }
  const actualHash = await sha256(codexExecutable);
  if (actualHash !== PINNED_CODEX_SHA256) {
    throw new Error(`Pinned Codex CLI SHA-256 mismatch: ${JSON.stringify({ expected: PINNED_CODEX_SHA256, actual: actualHash })}`);
  }
  return { root: extensionsRoot, extensionDirectory, codexExecutable, source };
}

async function verifyRuntime(root: string, source: PinnedVscodeRuntime["source"]): Promise<PinnedVscodeRuntime> {
  const codeExecutable = path.join(root, "Code.exe");
  const commitRoot = path.join(root, PINNED_VSCODE_COMMIT_DIRECTORY);
  const codeCli = path.join(commitRoot, "resources", "app", "out", "cli.js");
  const productPath = path.join(commitRoot, "resources", "app", "product.json");
  await Promise.all([access(codeExecutable), access(codeCli), access(productPath)]).catch((error: unknown) => {
    throw new Error(`Pinned VS Code runtime is incomplete at ${root}: ${error instanceof Error ? error.message : String(error)}`);
  });

  const product = JSON.parse(await readFile(productPath, "utf8")) as { version?: unknown; commit?: unknown };
  if (product.version !== PINNED_VSCODE_VERSION || product.commit !== PINNED_VSCODE_COMMIT) {
    throw new Error(`Pinned VS Code product mismatch at ${root}: ${JSON.stringify({ version: product.version, commit: product.commit })}`);
  }

  const { stdout } = await execFileAsync(codeExecutable, [codeCli, "--version"], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const [version, commit] = stdout.trim().split(/\r?\n/u);
  if (version !== PINNED_VSCODE_VERSION || commit !== PINNED_VSCODE_COMMIT) {
    throw new Error(`Pinned VS Code executable mismatch at ${root}: ${JSON.stringify({ version, commit })}`);
  }
  return { codeExecutable, codeCli, root, version, commit, source };
}

async function inspectInstalledRoot(root: string): Promise<string> {
  const codeExecutable = path.join(root, "Code.exe");
  await access(codeExecutable).catch(() => {
    throw new Error(`Installed VS Code executable does not exist: ${codeExecutable}`);
  });
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const observed: Array<{ directory: string; version?: unknown; commit?: unknown }> = [];
  for (const directory of directories) {
    const productPath = path.join(root, directory, "resources", "app", "product.json");
    if (!(await exists(productPath))) continue;
    try {
      const product = JSON.parse(await readFile(productPath, "utf8")) as { version?: unknown; commit?: unknown };
      observed.push({ directory, version: product.version, commit: product.commit });
      if (directory === PINNED_VSCODE_COMMIT_DIRECTORY &&
        product.version === PINNED_VSCODE_VERSION && product.commit === PINNED_VSCODE_COMMIT) {
        return root;
      }
    } catch {
      observed.push({ directory });
    }
  }
  throw new Error(`Installed VS Code does not match the pinned baseline: ${JSON.stringify({
    expectedVersion: PINNED_VSCODE_VERSION,
    expectedCommit: PINNED_VSCODE_COMMIT,
    observed,
  })}`);
}

export async function preparePinnedVscodeRuntime(options: {
  repoRoot: string;
  explicitCodeExecutable?: string;
}): Promise<PinnedVscodeRuntime> {
  if (process.platform !== "win32") throw new Error("The pinned VS Code fixture is Windows-only.");
  if (options.explicitCodeExecutable) {
    return verifyRuntime(path.dirname(path.resolve(options.explicitCodeExecutable)), "explicit");
  }

  const fixtureRoot = path.resolve(options.repoRoot, ".codex-pocket", "phase-0-7", `vscode-runtime-${PINNED_VSCODE_VERSION}`);
  if (await exists(fixtureRoot)) return verifyRuntime(fixtureRoot, "fixture");

  const installedRoot = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "Programs", "Microsoft VS Code",
  );
  await inspectInstalledRoot(installedRoot);
  await verifyRuntime(installedRoot, "explicit");

  const fixtureParent = path.dirname(fixtureRoot);
  const stagingRoot = path.join(fixtureParent, `.vscode-runtime-${PINNED_VSCODE_VERSION}.staging-${process.pid}`);
  await mkdir(fixtureParent, { recursive: true });
  if (await exists(stagingRoot)) {
    throw new Error(`Refusing to reuse an existing VS Code fixture staging directory: ${stagingRoot}`);
  }
  await mkdir(stagingRoot);
  try {
    await cp(path.join(installedRoot, "Code.exe"), path.join(stagingRoot, "Code.exe"));
    const manifest = "Code.VisualElementsManifest.xml";
    if (await exists(path.join(installedRoot, manifest))) {
      await cp(path.join(installedRoot, manifest), path.join(stagingRoot, manifest));
    }
    await cp(
      path.join(installedRoot, PINNED_VSCODE_COMMIT_DIRECTORY),
      path.join(stagingRoot, PINNED_VSCODE_COMMIT_DIRECTORY),
      { recursive: true, errorOnExist: true },
    );
    await verifyRuntime(stagingRoot, "installed-copy");
    await rename(stagingRoot, fixtureRoot);
    return verifyRuntime(fixtureRoot, "installed-copy");
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function preparePinnedVscodeExtension(options: {
  repoRoot: string;
  runtime: PinnedVscodeRuntime;
}): Promise<PinnedVscodeExtension> {
  const runRoot = path.resolve(options.repoRoot, ".codex-pocket", "phase-0-7");
  const extensionsRoot = path.join(runRoot, "vscode-extensions");
  const fixtureDirectory = path.join(extensionsRoot, PINNED_EXTENSION_DIRECTORY);
  if (await exists(fixtureDirectory)) return verifyExtension(extensionsRoot, "fixture");

  const globalDirectory = path.join(os.homedir(), ".vscode", "extensions", PINNED_EXTENSION_GLOBAL_DIRECTORY);
  const cachedVsix = path.join(runRoot, PINNED_EXTENSION_VSIX);
  await mkdir(extensionsRoot, { recursive: true });
  if (await exists(globalDirectory)) {
    await cp(globalDirectory, fixtureDirectory, { recursive: true, errorOnExist: true });
    return verifyExtension(extensionsRoot, "global-copy").catch(async (error: unknown) => {
      await rm(fixtureDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    });
  }
  if (!(await exists(cachedVsix))) {
    throw new Error(`Pinned Codex extension ${PINNED_EXTENSION_VERSION} is unavailable. Expected an exact global extension or verified cached VSIX at ${cachedVsix}.`);
  }
  const vsixHash = await sha256(cachedVsix);
  if (vsixHash !== PINNED_EXTENSION_VSIX_SHA256) {
    throw new Error(`Pinned Codex extension VSIX SHA-256 mismatch: ${JSON.stringify({
      expected: PINNED_EXTENSION_VSIX_SHA256, actual: vsixHash,
    })}`);
  }

  await execFileAsync(options.runtime.codeExecutable, [options.runtime.codeCli,
    "--extensions-dir", extensionsRoot,
    "--install-extension", cachedVsix,
    "--force",
  ], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 180_000,
  });
  return verifyExtension(extensionsRoot, "cached-vsix");
}

export async function resolvePinnedCodexExecutable(repoRoot: string): Promise<string> {
  const explicit = process.env.CODEX_POCKET_CODEX_EXE;
  const fixture = path.resolve(repoRoot, ".codex-pocket", "phase-0-7", "vscode-extensions",
    PINNED_EXTENSION_DIRECTORY, "bin", "windows-x86_64", "codex.exe");
  const global = path.join(os.homedir(), ".vscode", "extensions", PINNED_EXTENSION_GLOBAL_DIRECTORY,
    "bin", "windows-x86_64", "codex.exe");
  const candidate = explicit ? path.resolve(explicit) : (await exists(fixture) ? fixture : global);
  await access(candidate).catch(() => {
    throw new Error(`Pinned Codex executable does not exist: ${candidate}`);
  });
  const actualHash = await sha256(candidate);
  if (actualHash !== PINNED_CODEX_SHA256) {
    throw new Error(`Pinned Codex CLI SHA-256 mismatch: ${JSON.stringify({ expected: PINNED_CODEX_SHA256, actual: actualHash })}`);
  }
  return candidate;
}
