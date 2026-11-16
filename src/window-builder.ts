/** Fluent configuration for Window and merged Window construction. */
import type { Player } from "@minecraft/server";
import type { Gui } from "./gui.js";
import { StateManager } from "./state.js";
import type { StateScope, StateLifetime } from "./state.js";
import { minecraftVirtualContainerAdapter } from "./window-adapter.js";
import type { WindowContainerAdapter } from "./window-adapter.js";
import type { WindowOpenHandler, WindowCloseHandler, WindowErrorHandler } from "./window-types.js";
import { Window } from "./window.js";

function assertErrorHandler(handler: WindowErrorHandler): void {
  if (typeof handler !== "function") {
    throw new TypeError("InvUI: error handler must be a function.");
  }
}

export interface WindowConfig {
  readonly viewer: Player;
  readonly title: string;
  readonly upperGui: Gui;
  readonly lowerGui: Gui | undefined;
  readonly stateScope: StateScope;
  readonly stateKey: string | undefined;
  readonly stateLifetime: StateLifetime;
  readonly stateManager: StateManager | undefined;
  readonly adapter: WindowContainerAdapter;
  readonly openHandlers: readonly WindowOpenHandler[];
  readonly closeHandlers: readonly WindowCloseHandler[];
  readonly errorHandler: WindowErrorHandler | undefined;
}

export class WindowBuilder {
  #viewer: Player | undefined;
  #title = "";
  #upperGui: Gui | undefined;
  #lowerGui: Gui | undefined;
  #stateScope: StateScope = "player";
  #stateKey: string | undefined;
  #stateLifetime: StateLifetime = "window";
  #stateManager: StateManager | undefined;
  #adapter: WindowContainerAdapter = minecraftVirtualContainerAdapter;
  #openHandlers: WindowOpenHandler[] = [];
  #closeHandlers: WindowCloseHandler[] = [];
  #errorHandler: WindowErrorHandler | undefined;

  setViewer(viewer: Player): this {
    if (!viewer || typeof viewer !== "object") {
      throw new TypeError("InvUI: Window viewer must be a Player.");
    }
    this.#viewer = viewer;
    return this;
  }

  setTitle(title: string): this {
    if (typeof title !== "string") {
      throw new TypeError("InvUI: Window title must be a string.");
    }
    this.#title = title;
    return this;
  }

  setUpperGui(gui: Gui): this {
    this.#upperGui = gui;
    return this;
  }

  /** Accepted for API parity; Bedrock does not let us render into the lower area. */
  setLowerGui(gui: Gui): this {
    this.#lowerGui = gui;
    return this;
  }

  setStateScope(scope: StateScope): this {
    if (scope !== "player" && scope !== "shared") {
      throw new TypeError('InvUI: state scope must be "player" or "shared".');
    }
    this.#stateScope = scope;
    return this;
  }

  setStateKey(key: string): this {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("InvUI: state key must be a non-empty string.");
    }
    this.#stateKey = key;
    return this;
  }

  setStateLifetime(lifetime: StateLifetime): this {
    if (lifetime !== "window" && lifetime !== "session" && lifetime !== "persistent") {
      throw new TypeError('InvUI: state lifetime must be "window", "session", or "persistent".');
    }
    this.#stateLifetime = lifetime;
    return this;
  }

  /**
   * Share one StateManager between Windows. Defaults to a module-level manager
   * backed by the world's dynamic properties when the world exposes them, so
   * `persistent` state works without setup. Pass a manager with your own store
   * (or `onError`/`migrations` options) to override that.
   */
  setStateManager(manager: StateManager): this {
    if (!manager || typeof manager.acquire !== "function") {
      throw new TypeError("InvUI: state manager must be a StateManager.");
    }
    this.#stateManager = manager;
    return this;
  }

  /**
   * Replace the adapter that creates, shows, and closes the container. The
   * default adapter shows real screens; `canOpenScreens` is its opt-in, and an
   * adapter returning false makes `open()` throw WindowOpenRejectedError.
   */
  setContainerAdapter(adapter: WindowContainerAdapter): this {
    if (!adapter || typeof adapter.createContainer !== "function") {
      throw new TypeError("InvUI: container adapter must implement createContainer().");
    }
    this.#adapter = adapter;
    return this;
  }

  addOpenHandler(handler: WindowOpenHandler): this {
    if (typeof handler !== "function") {
      throw new TypeError("InvUI: open handler must be a function.");
    }
    this.#openHandlers.push(handler);
    return this;
  }

  addCloseHandler(handler: WindowCloseHandler): this {
    if (typeof handler !== "function") {
      throw new TypeError("InvUI: close handler must be a function.");
    }
    this.#closeHandlers.push(handler);
    return this;
  }

  setErrorHandler(handler: WindowErrorHandler): this {
    assertErrorHandler(handler);
    this.#errorHandler = handler;
    return this;
  }

  build(): Window {
    if (!this.#viewer) {
      throw new Error("InvUI: Window requires setViewer(player).");
    }
    if (!this.#upperGui) {
      throw new Error("InvUI: Window requires setUpperGui(gui).");
    }
    if (this.#stateScope === "shared" && this.#stateKey === undefined) {
      throw new Error("InvUI: shared state scope requires setStateKey(key).");
    }
    return new Window({
      viewer: this.#viewer,
      title: this.#title,
      upperGui: this.#upperGui,
      lowerGui: this.#lowerGui,
      stateScope: this.#stateScope,
      stateKey: this.#stateKey,
      stateLifetime: this.#stateLifetime,
      stateManager: this.#stateManager,
      adapter: this.#adapter,
      openHandlers: [...this.#openHandlers],
      closeHandlers: [...this.#closeHandlers],
      errorHandler: this.#errorHandler,
    });
  }
}

/** setGui() configures the upper GUI; lower player slots are not rendered. */
export class MergedWindowBuilder extends WindowBuilder {
  setGui(gui: Gui): this {
    return this.setUpperGui(gui);
  }
}
