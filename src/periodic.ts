import * as server from "@minecraft/server";

/**
 * Runs a callback every N game ticks and returns a cancel function.
 *
 * Item uses this to start/stop `updatePeriodically()` work as display
 * subscriptions come and go (design 6.3 / 11.5). Tests replace the Minecraft
 * `system` module to drive ticks deterministically.
 */
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
