/** Default state manager shared by Windows in one script generation. */
import { world } from "@minecraft/server";
import { BedrockWorldStateStore } from "./bedrock-store.js";
import { StateManager } from "./state.js";
import type { StateStore } from "./state.js";

export let defaultStateManager: StateManager | undefined;

/**
 * Store for `defaultManager()`. The real Bedrock world exposes dynamic
 * properties, so a Window that asks for `persistent` lifetime works without
 * any setup. A test double or a reduced world that lacks them keeps the
 * previous in-memory default manager (`persistent` then still needs an
 * injected `StateManager`), and a world whose property access throws falls
 * back instead of breaking every Window. The dynamic-property path has not
 * been verified on a real device.
 */
export function defaultStateStore(): StateStore | undefined {
  try {
    if (
      typeof world.getDynamicProperty === "function" &&
      typeof world.setDynamicProperty === "function"
    ) {
      return new BedrockWorldStateStore(world);
    }
  } catch (error) {
    console.error(
      "InvUI: world dynamic properties are unavailable; the default StateManager cannot persist state.",
      error,
    );
  }
  return undefined;
}

export function defaultManager(): StateManager {
  defaultStateManager ??= new StateManager(defaultStateStore());
  return defaultStateManager;
}
