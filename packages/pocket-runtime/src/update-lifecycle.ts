import type { PocketUpdateStatus } from "../../codex-core/src/workspace-runtime-manager.js";

export class IncompatibleUpdateError extends Error {
  constructor(message: string) { super(message); this.name = "IncompatibleUpdateError"; }
}

export interface DiscoveredUpdate {
  version: string;
  sha256: string;
  source: "visualStudioMarketplace";
  compatible: boolean;
  updateAvailable: boolean;
  incompatibility?: string;
}

export interface StagedUpdate {
  version: string;
  vsixSha256: string;
  cliVersion: string;
  cliSha256: string;
  treeSha256: string;
  candidateId: string;
}

export interface UpdatePromotion {
  previousVersion: string;
  rollbackToken?: unknown;
}

export interface UpdateLifecycleRecord {
  status: PocketUpdateStatus;
  candidate?: StagedUpdate;
  promotion?: UpdatePromotion;
}

export interface UpdateLifecycleDependencies {
  currentVersion(): Promise<string>;
  discover(): Promise<DiscoveredUpdate>;
  stage(update: DiscoveredUpdate): Promise<StagedUpdate>;
  isIdle(): Promise<{ idle: boolean; reason?: string }>;
  promote(candidate: StagedUpdate): Promise<UpdatePromotion>;
  requestRestart(candidate: StagedUpdate, promotion: UpdatePromotion): Promise<void>;
  rollbackPromotion(promotion: UpdatePromotion): Promise<void>;
  readRecord(): Promise<UpdateLifecycleRecord | null>;
  writeRecord(record: UpdateLifecycleRecord): Promise<void>;
  cleanupStale(candidate?: StagedUpdate): Promise<void>;
  now?: () => Date;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Za-z]:\\(?:[^\s"']+\\)*[^\s"']*/gu, "<PATH>")
    .replace(/\/(?:Users|private|var|tmp|home)\/(?:[^\s"']+\/?)+/gu, "<PATH>")
    .slice(0, 500);
}

export class UpdateLifecycleManager {
  readonly #dependencies: UpdateLifecycleDependencies;
  #operation: Promise<PocketUpdateStatus> | null = null;

  constructor(dependencies: UpdateLifecycleDependencies) {
    this.#dependencies = dependencies;
  }

  async status(): Promise<PocketUpdateStatus> {
    const record = await this.#dependencies.readRecord();
    if (record) return structuredClone(record.status);
    return { ...this.#base("idle", await this.#dependencies.currentVersion(), null, false), checkedAt: new Date(0).toISOString() };
  }

  async recover(): Promise<PocketUpdateStatus> {
    const record = await this.#dependencies.readRecord();
    if (!record) {
      await this.#dependencies.cleanupStale();
      return await this.status();
    }
    if ((record.status.state === "staged" || record.status.state === "waitingForIdle") && record.candidate) {
      await this.#dependencies.cleanupStale(record.candidate);
      return await this.#attemptApply(record);
    }
    if (record.status.state === "restarting" && record.candidate && record.promotion) {
      try {
        await this.#dependencies.requestRestart(record.candidate, record.promotion);
        return structuredClone(record.status);
      } catch (error) {
        await this.#dependencies.rollbackPromotion(record.promotion).catch(() => undefined);
        return await this.#fail(record.status, `Restart recovery failed: ${message(error)}`);
      }
    }
    if (["checking", "downloading", "applying"].includes(record.status.state)) {
      return await this.#fail(record.status, "Interrupted updater operation recovered fail-closed.");
    }
    await this.#dependencies.cleanupStale(record.candidate);
    return structuredClone(record.status);
  }

  async checkOnly(): Promise<PocketUpdateStatus> {
    return await this.#exclusive(async () => {
      const existing = await this.#dependencies.readRecord();
      if (existing?.candidate && ["downloading", "staged", "waitingForIdle", "applying", "restarting", "rollingBack"].includes(existing.status.state)) {
        return structuredClone(existing.status);
      }
      const current = await this.#dependencies.currentVersion();
      await this.#save({ status: this.#base("checking", current, null, false) });
      try {
        const update = await this.#dependencies.discover();
        if (!update.compatible) {
          return await this.#save({ status: {
            ...this.#base("incompatible", current, update.version, false),
            candidateSha256: update.sha256,
            detail: update.incompatibility ?? "The update is incompatible with the pinned VS Code baseline.",
          } });
        }
        if (!update.updateAvailable) return await this.#save({ status: this.#base("upToDate", current, update.version, false) });
        return await this.#save({ status: {
          ...this.#base("updateAvailable", current, update.version, true), candidateSha256: update.sha256,
        } });
      } catch (error) {
        return await this.#fail(this.#base("checking", current, null, false), message(error));
      }
    });
  }

  async downloadAndApply(): Promise<PocketUpdateStatus> {
    return await this.#exclusive(async () => {
      const existing = await this.#dependencies.readRecord();
      if (existing?.candidate && ["staged", "waitingForIdle"].includes(existing.status.state)) {
        return await this.#attemptApply(existing);
      }
      if (existing && ["applying", "restarting", "rollingBack"].includes(existing.status.state)) {
        return structuredClone(existing.status);
      }
      const current = await this.#dependencies.currentVersion();
      await this.#save({ status: this.#base("checking", current, null, false) });
      let update: DiscoveredUpdate;
      try {
        update = await this.#dependencies.discover();
      } catch (error) {
        return await this.#fail(this.#base("checking", current, null, false), message(error));
      }
      if (!update.compatible) {
        return await this.#save({ status: {
          ...this.#base("incompatible", current, update.version, false), candidateSha256: update.sha256,
          detail: update.incompatibility ?? "The update is incompatible with the pinned VS Code baseline.",
        } });
      }
      if (!update.updateAvailable) return await this.#save({ status: this.#base("upToDate", current, update.version, false) });
      await this.#save({ status: {
        ...this.#base("downloading", current, update.version, true), candidateSha256: update.sha256,
      } });
      let candidate: StagedUpdate;
      try {
        candidate = await this.#dependencies.stage(update);
      } catch (error) {
        if (error instanceof IncompatibleUpdateError) {
          return await this.#save({ status: {
            ...this.#base("incompatible", current, update.version, false), candidateSha256: update.sha256,
            detail: message(error),
          } });
        }
        return await this.#fail({
          ...this.#base("downloading", current, update.version, true), candidateSha256: update.sha256,
        }, message(error));
      }
      const staged: UpdateLifecycleRecord = { candidate, status: {
        ...this.#base("staged", current, candidate.version, true),
        candidateSha256: candidate.vsixSha256, candidateCliVersion: candidate.cliVersion,
      } };
      await this.#save(staged);
      await this.#dependencies.cleanupStale(candidate);
      return await this.#attemptApply(staged);
    });
  }

  async tick(): Promise<PocketUpdateStatus> {
    const record = await this.#dependencies.readRecord();
    if (!record?.candidate || !["staged", "waitingForIdle"].includes(record.status.state)) return await this.status();
    return await this.#exclusive(async () => await this.#attemptApply(record));
  }

  async #attemptApply(record: UpdateLifecycleRecord): Promise<PocketUpdateStatus> {
    const candidate = record.candidate;
    if (!candidate) return await this.#fail(record.status, "Staged updater metadata is missing.");
    let idle: { idle: boolean; reason?: string };
    try {
      idle = await this.#dependencies.isIdle();
    } catch (error) {
      idle = { idle: false, reason: `Runtime ownership/state is uncertain: ${message(error)}` };
    }
    if (!idle.idle) {
      return await this.#save({ candidate, status: {
        ...record.status, state: "waitingForIdle", detail: idle.reason ?? "Pocket is waiting for all work and approvals to become idle.",
      } });
    }
    const applying = { candidate, status: { ...record.status, state: "applying" as const, detail: undefined } };
    await this.#save(applying);
    let promotion: UpdatePromotion | null = null;
    try {
      promotion = await this.#dependencies.promote(candidate);
      const restarting: UpdateLifecycleRecord = { candidate, promotion, status: {
        ...applying.status, state: "restarting", previousVersion: promotion.previousVersion,
      } };
      await this.#save(restarting);
      await this.#dependencies.requestRestart(candidate, promotion);
      return structuredClone(restarting.status);
    } catch (error) {
      if (promotion) await this.#dependencies.rollbackPromotion(promotion).catch(() => undefined);
      return await this.#fail(applying.status, message(error));
    }
  }

  async #exclusive(operation: () => Promise<PocketUpdateStatus>): Promise<PocketUpdateStatus> {
    if (this.#operation) return await this.#operation;
    this.#operation = operation().finally(() => { this.#operation = null; });
    return await this.#operation;
  }

  #base(state: PocketUpdateStatus["state"], currentVersion: string, availableVersion: string | null,
    restartRequired: boolean): PocketUpdateStatus {
    return { state, currentVersion, availableVersion, checkedAt: (this.#dependencies.now?.() ?? new Date()).toISOString(),
      source: "visualStudioMarketplace", restartRequired };
  }

  async #fail(previous: PocketUpdateStatus, error: string): Promise<PocketUpdateStatus> {
    return await this.#save({ status: { ...previous, state: "failed", error, detail: undefined } });
  }

  async #save(record: UpdateLifecycleRecord): Promise<PocketUpdateStatus> {
    await this.#dependencies.writeRecord(record);
    return structuredClone(record.status);
  }
}
