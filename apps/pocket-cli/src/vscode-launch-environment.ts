export interface IsolatedVscodeEnvironmentOptions {
  codexHome: string;
  codexPath: string;
  endpoint: string;
  token: string;
  launcherLog: string;
  electronRunAsNode?: boolean;
}

/**
 * A VS Code process launched from a Codex terminal can inherit the parent
 * conversation descriptor.  The extension treats those variables as an
 * instruction to join that parent runtime, bypassing chatgpt.cliExecutable.
 * Keep ordinary tool/runtime variables, but remove every inherited CODEX_*
 * value before installing the small, explicit Pocket connection descriptor.
 */
export function isolatedVscodeEnvironment(
  inherited: NodeJS.ProcessEnv,
  options: IsolatedVscodeEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.toUpperCase().startsWith("CODEX_")) environment[key] = value;
  }
  const isolated: NodeJS.ProcessEnv = {
    ...environment,
    CODEX_HOME: options.codexHome,
    CODEX_POCKET_CODEX_EXE: options.codexPath,
    CODEX_POCKET_WS_URL: options.endpoint,
    CODEX_POCKET_WS_TOKEN: options.token,
    CODEX_POCKET_PROXY_LOG: options.launcherLog,
  };
  if (options.electronRunAsNode !== false) isolated.ELECTRON_RUN_AS_NODE = "1";
  else delete isolated.ELECTRON_RUN_AS_NODE;
  return isolated;
}
