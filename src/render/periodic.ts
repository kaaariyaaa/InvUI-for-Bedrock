import * as server from "@minecraft/server";

/** Schedule repeated game-tick work and return a cancellation function. */
export interface PeriodicScheduler {
  schedule(callback: () => void, ticks: number): () => void;
}

/** Default scheduler: `system.runInterval` is already aligned to safe tick time. */
export const minecraftPeriodicScheduler: PeriodicScheduler = {
  schedule(callback, ticks) {
    // Namespace import keeps test doubles that omit `system` linkable; the
    // real game always provides it.
    const gameSystem: typeof server.system | undefined = server.system;
    if (!gameSystem) {
      throw new Error("InvUI: @minecraft/server system API is unavailable.");
    }
    const runId = gameSystem.runInterval(callback, ticks);
    return () => gameSystem.clearRun(runId);
  },
};
