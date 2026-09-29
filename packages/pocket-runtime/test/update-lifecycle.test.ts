import { describe, expect, it } from "vitest";
import { UpdateLifecycleManager, type DiscoveredUpdate, type StagedUpdate,
  type UpdateLifecycleDependencies, type UpdateLifecycleRecord } from "../src/update-lifecycle.js";

const discovery: DiscoveredUpdate = {
  version: "26.904.1", sha256: "A".repeat(64), source: "visualStudioMarketplace", compatible: true, updateAvailable: true,
};
const candidate: StagedUpdate = {
  version: discovery.version, vsixSha256: discovery.sha256, cliVersion: "0.154.0", cliSha256: "B".repeat(64),
  treeSha256: "C".repeat(64), candidateId: "26.904.1-aaaaaaaaaaaaaaaa",
};

function fixture(overrides: Partial<UpdateLifecycleDependencies> = {}): {
  manager: UpdateLifecycleManager;
  calls: { discover: number; stage: number; idle: number; promote: number; restart: number; rollback: number; cleanup: number };
  record: () => UpdateLifecycleRecord | null;
} {
  let saved: UpdateLifecycleRecord | null = null;
  const calls = { discover: 0, stage: 0, idle: 0, promote: 0, restart: 0, rollback: 0, cleanup: 0 };
  const dependencies: UpdateLifecycleDependencies = {
    currentVersion: async () => "26.903.1",
    discover: async () => { calls.discover += 1; return discovery; },
    stage: async () => { calls.stage += 1; return candidate; },
    isIdle: async () => { calls.idle += 1; return { idle: true }; },
    promote: async () => { calls.promote += 1; return { previousVersion: "26.903.1" }; },
    requestRestart: async () => { calls.restart += 1; },
    rollbackPromotion: async () => { calls.rollback += 1; },
    readRecord: async () => structuredClone(saved),
    writeRecord: async (record) => { saved = structuredClone(record); },
    cleanupStale: async () => { calls.cleanup += 1; },
    now: () => new Date("2026-09-09T12:00:00.000Z"),
    ...overrides,
  };
  return { manager: new UpdateLifecycleManager(dependencies), calls, record: () => structuredClone(saved) };
}

describe("UpdateLifecycleManager", () => {
  it("marks a missing lifecycle record due for the initial automatic check", async () => {
    const setup = fixture();
    expect((await setup.manager.status()).checkedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("reports no update without downloading", async () => {
    const setup = fixture({ discover: async () => ({ ...discovery, version: "26.903.1", updateAvailable: false }) });
    expect((await setup.manager.downloadAndApply()).state).toBe("upToDate");
    expect(setup.calls.stage).toBe(0);
  });

  it("downloads, stages, promotes, and requests one restart for a valid idle update", async () => {
    const setup = fixture();
    const status = await setup.manager.downloadAndApply();
    expect(status).toMatchObject({ state: "restarting", availableVersion: candidate.version,
      candidateSha256: candidate.vsixSha256, candidateCliVersion: candidate.cliVersion, previousVersion: "26.903.1" });
    expect(setup.calls).toMatchObject({ stage: 1, promote: 1, restart: 1 });
  });

  it.each([
    "official download failed", "published SHA-256 mismatch", "corrupt VSIX", "wrong extension identity",
    "wrong target platform", "invalid bundled CLI", "staging publication failed",
  ])("fails closed when staging reports: %s", async (failure) => {
    const setup = fixture({ stage: async () => { throw new Error(failure); } });
    const status = await setup.manager.downloadAndApply();
    expect(status.state).toBe("failed");
    expect(status.error).toContain(failure);
    expect(setup.calls.promote).toBe(0);
    expect(setup.calls.restart).toBe(0);
  });

  it("redacts local paths from presentation-independent failure state", async () => {
    const setup = fixture({ stage: async () => { throw new Error("failed at /Users/person/private/update/file.vsix"); } });
    const status = await setup.manager.downloadAndApply();
    expect(status.error).toContain("<PATH>");
    expect(status.error).not.toContain("person");
  });

  it("keeps a verified candidate staged while a task is active", async () => {
    const setup = fixture({ isIdle: async () => ({ idle: false, reason: "A Codex turn is active." }) });
    expect(await setup.manager.downloadAndApply()).toMatchObject({ state: "waitingForIdle", detail: "A Codex turn is active." });
    expect(setup.calls.promote).toBe(0);
  });

  it("keeps a verified candidate staged while approval is pending", async () => {
    const setup = fixture({ isIdle: async () => ({ idle: false, reason: "A Codex approval is pending." }) });
    expect(await setup.manager.downloadAndApply()).toMatchObject({ state: "waitingForIdle", detail: "A Codex approval is pending." });
    expect(setup.calls.restart).toBe(0);
  });

  it("treats uncertain ownership/state as busy", async () => {
    const setup = fixture({ isIdle: async () => { throw new Error("probe disconnected"); } });
    expect(await setup.manager.downloadAndApply()).toMatchObject({ state: "waitingForIdle" });
    expect(setup.record()?.status.detail).toContain("uncertain");
  });

  it("applies exactly once after an idle transition", async () => {
    let idle = false;
    const setup = fixture({ isIdle: async () => ({ idle, ...(!idle ? { reason: "active" } : {}) }) });
    expect((await setup.manager.downloadAndApply()).state).toBe("waitingForIdle");
    idle = true;
    expect((await setup.manager.tick()).state).toBe("restarting");
    expect(setup.calls.restart).toBe(1);
  });

  it("deduplicates concurrent and repeated explicit update requests", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const setup = fixture({ stage: async () => { setup.calls.stage += 1; await blocked; return candidate; } });
    const first = setup.manager.downloadAndApply();
    const second = setup.manager.downloadAndApply();
    release();
    await Promise.all([first, second]);
    expect(setup.calls.stage).toBe(1);
    expect((await setup.manager.downloadAndApply()).state).toBe("restarting");
    expect(setup.calls.restart).toBe(1);
  });

  it("recovers a stale staged candidate and applies it after restart", async () => {
    let saved: UpdateLifecycleRecord | null = { candidate, status: {
      state: "staged", currentVersion: "26.903.1", availableVersion: candidate.version,
      checkedAt: "2026-09-09T12:00:00.000Z", source: "visualStudioMarketplace", restartRequired: true,
    } };
    const setup = fixture({ readRecord: async () => structuredClone(saved), writeRecord: async (value) => { saved = structuredClone(value); } });
    expect((await setup.manager.recover()).state).toBe("restarting");
    expect(setup.calls.stage).toBe(0);
    expect(setup.calls.restart).toBe(1);
  });

  it("fails closed when a process dies during a transient apply state", async () => {
    const transient: UpdateLifecycleRecord = { candidate, status: {
      state: "applying", currentVersion: "26.903.1", availableVersion: candidate.version,
      checkedAt: "2026-09-09T12:00:00.000Z", source: "visualStudioMarketplace", restartRequired: true,
    } };
    let saved: UpdateLifecycleRecord | null = transient;
    const setup = fixture({ readRecord: async () => structuredClone(saved), writeRecord: async (value) => { saved = structuredClone(value); } });
    expect(await setup.manager.recover()).toMatchObject({ state: "failed", error: expect.stringContaining("Interrupted") });
  });

  it("recreates an interrupted restart request from persisted promotion metadata", async () => {
    const restarting: UpdateLifecycleRecord = { candidate, promotion: { previousVersion: "26.903.1", rollbackToken: null }, status: {
      state: "restarting", currentVersion: "26.903.1", availableVersion: candidate.version,
      checkedAt: "2026-09-09T12:00:00.000Z", source: "visualStudioMarketplace", restartRequired: true,
    } };
    const setup = fixture({ readRecord: async () => structuredClone(restarting) });
    expect((await setup.manager.recover()).state).toBe("restarting");
    expect(setup.calls.restart).toBe(1);
  });

  it("restores the previous pointer if restart request publication fails", async () => {
    const setup = fixture({ requestRestart: async () => { throw new Error("restart request failed"); } });
    expect(await setup.manager.downloadAndApply()).toMatchObject({ state: "failed", error: "restart request failed" });
    expect(setup.calls.rollback).toBe(1);
  });

  it("blocks an extension incompatible with the pinned VS Code baseline", async () => {
    const setup = fixture({ discover: async () => ({ ...discovery, compatible: false, incompatibility: "requires VS Code 2.0.0" }) });
    expect(await setup.manager.downloadAndApply()).toMatchObject({ state: "incompatible", detail: "requires VS Code 2.0.0" });
    expect(setup.calls.stage).toBe(0);
  });

  it("check-only preserves a staged candidate and does not duplicate work", async () => {
    let saved: UpdateLifecycleRecord | null = { candidate, status: {
      state: "waitingForIdle", currentVersion: "26.903.1", availableVersion: candidate.version,
      checkedAt: "2026-09-09T12:00:00.000Z", source: "visualStudioMarketplace", restartRequired: true,
    } };
    const setup = fixture({ readRecord: async () => structuredClone(saved), writeRecord: async (value) => { saved = structuredClone(value); } });
    expect((await setup.manager.checkOnly()).state).toBe("waitingForIdle");
    expect(setup.calls.discover).toBe(0);
  });
});
