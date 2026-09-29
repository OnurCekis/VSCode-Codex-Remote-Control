import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ProtocolLog } from "../../../apps/ipc-probe/src/protocol-log.js";
import { connectWebSocketPeer } from "../../../apps/ipc-probe/src/websocket-json-rpc.js";
import { AppServerCodexAdapter } from "../../codex-core/src/app-server-codex-adapter.js";
import { PocketCore } from "../../codex-core/src/pocket-core.js";
import type { PocketConnection } from "./connection-file.js";
import { FileWorkspaceRuntimeAdapter } from "./workspace-runtime-control.js";

export interface PocketClient {
  core: PocketCore;
  close(): Promise<void>;
}

export async function connectPocketClient(options: {
  connection: PocketConnection;
  clientName: string;
  logPath: string;
  defaultWorkspace?: string;
  workspaceStateFile?: string;
  extraWorkspaceBrowseRoots?: readonly string[];
}): Promise<PocketClient> {
  await mkdir(path.dirname(options.logPath), { recursive: true });
  const log = new ProtocolLog(options.logPath, [options.connection.token]);
  try {
    const transport = await connectWebSocketPeer({
      url: options.connection.endpoint,
      token: options.connection.token,
      name: options.clientName,
      log,
      timeoutMs: 30_000,
    });
    const core = new PocketCore(
      new AppServerCodexAdapter(transport.peer),
      {
        runtimeId: `app-server-${options.connection.ownerPid}`,
        ...(options.workspaceStateFile ? { workspaceStateFile: options.workspaceStateFile } : {}),
        ...(options.extraWorkspaceBrowseRoots ? { extraWorkspaceBrowseRoots: options.extraWorkspaceBrowseRoots } : {}),
        ...(options.connection.runtimeControl ? {
          runtimeAdapter: new FileWorkspaceRuntimeAdapter(options.connection.runtimeControl),
        } : {}),
      },
    );
    await core.workspaces.initialize(options.defaultWorkspace);
    return {
      core,
      close: async () => {
        await core.close();
        await log.close();
      },
    };
  } catch (error) {
    await log.close();
    throw error;
  }
}
