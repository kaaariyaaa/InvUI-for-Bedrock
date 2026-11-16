/** Minecraft VirtualContainer adapter and its event subscriptions. */
import { world } from "@minecraft/server";
import type {
  Player,
  ItemStack,
  VirtualContainer,
  VirtualContainerCloseAfterEvent,
  VirtualContainerCloseReason,
  VirtualContainerItemChangeAfterEvent,
  VirtualContainerOptions,
} from "@minecraft/server";
import type {
  WindowCloseReason,
  WindowContainerCloseHandler,
  WindowContainerItemChangeHandler,
} from "./window-types.js";

/**
 * The boundary between Window and the Bedrock screen API.
 *
 * `canOpenScreens` is the adapter's explicit opt-in: true means
 * `openContainer`/`closeContainer` are implemented against a real screen.
 * `Window.open()` refuses to run when it is false.
 */
export interface WindowContainerAdapter {
  readonly canOpenScreens: boolean;
  createContainer(options: VirtualContainerOptions): VirtualContainer;
  openContainer(container: VirtualContainer, viewer: Player): void;
  closeContainer(container: VirtualContainer, viewer: Player): void;
  /**
   * True when the event hooks below apply the official
   * `{ containers: [container] }` filter to every subscription. The Window then
   * subscribes once per container and attributes an event to the container it
   * passed in, so the event's `container` does not have to be the same object
   * returned by `createContainer()`. Adapters that leave this off (the default
   * for custom adapters) receive the old hook call shape and their events are
   * matched by the event's `container` reference.
   */
  readonly filtersContainerEvents?: boolean;
  /**
   * Optional event hooks. The Window subscribes before it opens the screen and
   * unsubscribes on close or on a failed open. Both return an unsubscribe
   * function; the Window removes a subscription that succeeded even when the
   * other one throws. The second argument is provided only when
   * `filtersContainerEvents` is true; it is the container the subscription
   * must be limited to.
   */
  subscribeClose?(
    handler: WindowContainerCloseHandler,
    container?: VirtualContainer,
  ): () => void;
  subscribeItemChange?(
    handler: WindowContainerItemChangeHandler,
    container?: VirtualContainer,
  ): () => void;
}

/**
 * Translate Bedrock's close reason into the Window's. The pinned
 * @minecraft/server beta mirrors `WindowCloseReason` member for member, but the
 * two string enums are not assignable to each other, so map explicitly.
 * An unknown future reason is reported as `ServerClosed`: the Window still
 * closes and the close handlers get a defined reason.
 */
function toWindowCloseReason(reason: VirtualContainerCloseReason): WindowCloseReason {
  switch (reason as string) {
    case "PlayerClosed":
      return "PlayerClosed";
    case "PlayerDied":
      return "PlayerDied";
    case "PlayerLeft":
      return "PlayerLeft";
    case "PlayerSpectating":
      return "PlayerSpectating";
    case "UserBusy":
      return "UserBusy";
    case "ServerClosed":
      return "ServerClosed";
    default:
      return "ServerClosed";
  }
}

/**
 * Default VirtualContainer adapter. The Window restores changed screen slots
 * and reconciles matching player-side after-events.
 */
export class MinecraftVirtualContainerAdapter implements WindowContainerAdapter {
  readonly canOpenScreens = true;
  /**
   * The beta `subscribe` options `{ containers: [...] }` make the engine fire
   * only for the listed containers. This is what lets the Window trust a
   * subscription instead of comparing `event.container` by reference.
   */
  readonly filtersContainerEvents = true;

  createContainer(options: VirtualContainerOptions): VirtualContainer {
    return world.virtualContainerManager.create(options);
  }

  /**
   * Shows `container` to `viewer`. Not throwing only means the request was
   * sent; the client can still decline it (the screen then closes with
   * `UserBusy`).
   */
  openContainer(container: VirtualContainer, viewer: Player): void {
    container.open(viewer);
  }

  /**
   * Requests the close of `viewer`'s screen. The close event may arrive on a
   * later tick.
   */
  closeContainer(container: VirtualContainer, viewer: Player): void {
    container.close(viewer);
  }

  /**
   * Forwards this container's close events. When `container` is provided the
   * engine subscription is limited to it with the official beta
   * `{ containers: [container] }` option; without one (a direct call from an
   * application or a test) it keeps the unfiltered global behavior.
   */
  subscribeClose(
    handler: WindowContainerCloseHandler,
    container?: VirtualContainer,
  ): () => void {
    const signal = world.afterEvents.virtualContainerClose;
    const callback = (event: VirtualContainerCloseAfterEvent): void => {
      handler({
        container: event.container,
        player: event.player,
        reason: toWindowCloseReason(event.reason),
      });
    };
    if (container) {
      signal.subscribe(callback, { containers: [container] });
    } else {
      signal.subscribe(callback);
    }
    return () => signal.unsubscribe(callback);
  }

  /**
   * Forwards this container's item-change events, including both stacks, so
   * the Window can restore the slot. This is an `after` event: the slot was
   * already changed through the screen. The optional `container` filters the
   * subscription like {@link subscribeClose}.
   */
  subscribeItemChange(
    handler: WindowContainerItemChangeHandler,
    container?: VirtualContainer,
  ): () => void {
    const signal = world.afterEvents.virtualContainerItemChange;
    const callback = (event: VirtualContainerItemChangeAfterEvent): void => {
      handler({
        container: event.container,
        player: event.player,
        slot: event.slot,
        beforeItemStack: event.beforeItemStack,
        itemStack: event.itemStack,
      });
    };
    if (container) {
      signal.subscribe(callback, { containers: [container] });
    } else {
      signal.subscribe(callback);
    }
    return () => signal.unsubscribe(callback);
  }
}

export const minecraftVirtualContainerAdapter = new MinecraftVirtualContainerAdapter();
