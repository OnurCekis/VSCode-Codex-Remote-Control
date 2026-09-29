import { describe, expect, it } from "vitest";
import { isolatedVscodeEnvironment } from "../src/vscode-launch-environment.js";

describe("isolatedVscodeEnvironment", () => {
  it("removes a parent Codex conversation descriptor and installs only Pocket-owned values", () => {
    const result = isolatedVscodeEnvironment({
      PATH: "C:\\Windows\\System32",
      CODEX_CI: "1",
      CODEX_SESSION_ID: "foreign-session",
      CODEX_THREAD_ID: "foreign-thread",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode",
      CODEX_PERMISSION_PROFILE: ":danger-full-access",
      CODEX_HOME: "C:\\foreign-home",
      CODEX_POCKET_STALE_VALUE: "foreign",
    }, {
      codexHome: "C:\\pocket-home",
      codexPath: "C:\\pinned\\codex.exe",
      endpoint: "ws://127.0.0.1:43210",
      token: "pocket-capability-token",
      launcherLog: "C:\\pocket\\proxy.jsonl",
    });

    expect(result.PATH).toBe("C:\\Windows\\System32");
    expect(result.CODEX_CI).toBeUndefined();
    expect(result.CODEX_SESSION_ID).toBeUndefined();
    expect(result.CODEX_THREAD_ID).toBeUndefined();
    expect(result.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
    expect(result.CODEX_PERMISSION_PROFILE).toBeUndefined();
    expect(result.CODEX_POCKET_STALE_VALUE).toBeUndefined();
    expect(result).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_HOME: "C:\\pocket-home",
      CODEX_POCKET_CODEX_EXE: "C:\\pinned\\codex.exe",
      CODEX_POCKET_WS_URL: "ws://127.0.0.1:43210",
      CODEX_POCKET_WS_TOKEN: "pocket-capability-token",
      CODEX_POCKET_PROXY_LOG: "C:\\pocket\\proxy.jsonl",
    });
  });

  it("supports direct macOS Electron launch without inherited Node mode", () => {
    const environment = isolatedVscodeEnvironment(
      { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" },
      {
        codexHome: "/tmp/pocket-codex-home",
        codexPath: "/tmp/pocket-codex",
        endpoint: "ws://127.0.0.1:43123",
        token: "t".repeat(43),
        launcherLog: "/tmp/pocket-proxy.jsonl",
        electronRunAsNode: false,
      },
    );
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(environment.PATH).toBe("/usr/bin");
  });
});
