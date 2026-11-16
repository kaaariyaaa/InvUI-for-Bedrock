/** Own filtered and global adapter subscriptions for one Window. */
import type { VirtualContainer } from "@minecraft/server";
import type { WindowContainerAdapter } from "./window-adapter.js";
import type {
  WindowContainerCloseEvent,
  WindowContainerItemChangeEvent,
  WindowStatus,
} from "./window-types.js";

interface SubscriptionHost {
  generation(): number;
  status(): WindowStatus;
  owns(container: VirtualContainer): boolean;
  onClose(generation: number, event: WindowContainerCloseEvent, container: VirtualContainer): void;
  onItemChange(generation: number, event: WindowContainerItemChangeEvent, container: VirtualContainer): void;
  onUnsubscribeError(error: unknown): void;
}

export class WindowContainerSubscriptions {
  readonly filtersContainerEvents: boolean;
  readonly #adapter: WindowContainerAdapter;
  readonly #host: SubscriptionHost;
  #eventUnsubscribers: Array<() => void> = [];
  #containerEventUnsubscribers = new Map<VirtualContainer, Array<() => void>>();

  constructor(adapter: WindowContainerAdapter, host: SubscriptionHost) {
    this.#adapter = adapter;
    this.#host = host;
    this.filtersContainerEvents = adapter.filtersContainerEvents === true;
  }

  /**
   * Subscribes a filtered adapter to one container, or does nothing for an
   * adapter that cannot filter (the old global hook is installed by
   * {@link #subscribeToContainerEvents} instead).
   */
  subscribeFiltered(
    container: VirtualContainer,
    generation: number,
  ): boolean {
    if (!this.filtersContainerEvents) {
      return true;
    }
    return this.#subscribeContainerEvents(container, generation);
  }
  
  /**
   * Subscribes close/itemChange for exactly one container through the beta
   * `{ containers: [container] }` filter. The handler remembers `container`, so
   * a delivered event belongs to it even when `event.container` is a different
   * wrapper object. Returns false when an event delivered during subscription
   * already closed the Window; partial subscriptions are always removed.
   */
  #subscribeContainerEvents(
    container: VirtualContainer,
    generation: number,
  ): boolean {
    const unsubscribers: Array<() => void> = [];
    const track = (unsubscribe: unknown, kind: string): void => {
      if (typeof unsubscribe !== "function") {
        throw new TypeError(
          `InvUI: adapter ${kind} subscription must return an unsubscribe function.`,
        );
      }
      unsubscribers.push(unsubscribe as () => void);
    };
    // A title/size regeneration subscribes while already `open`, not only
    // while `opening`.
    const active = (): boolean =>
      generation === this.#host.generation() &&
      (this.#host.status() === "opening" || this.#host.status() === "open");
  
    try {
      if (this.#adapter.subscribeClose) {
        track(
          this.#adapter.subscribeClose(
            (event) => this.#host.onClose(generation, event, container),
            container,
          ),
          "close",
        );
      }
      // A handler may have closed the Window while the first subscription was
      // being installed; do not install the second one then.
      if (!active()) {
        this.dispose(unsubscribers);
        return false;
      }
      if (this.#adapter.subscribeItemChange) {
        track(
          this.#adapter.subscribeItemChange(
            (event) => this.#host.onItemChange(generation, event, container),
            container,
          ),
          "itemChange",
        );
      }
    } catch (error) {
      this.dispose(unsubscribers);
      throw error;
    }
  
    if (!active()) {
      this.dispose(unsubscribers);
      return false;
    }
    // Group by container so a container the Window stops owning can release
    // exactly its own subscriptions (see #releaseContainerEventSubscriptions).
    const existing = this.#containerEventUnsubscribers.get(container);
    if (existing) {
      existing.push(...unsubscribers);
    } else {
      this.#containerEventUnsubscribers.set(container, unsubscribers);
    }
    return true;
  }
  
  /**
   * Subscribes to the adapter's optional close/itemChange hooks before opening.
   * Returns false when an event delivered during subscription already closed
   * the Window. Subscriptions made before a failure are always removed.
   *
   * Used only for adapters without `filtersContainerEvents`: the global hooks
   * cannot be limited to a container, so the handlers fall back to comparing
   * the event's `container` reference.
   */
  subscribeGlobal(generation: number): boolean {
    const unsubscribers: Array<() => void> = [];
    const track = (unsubscribe: unknown, kind: string): void => {
      if (typeof unsubscribe !== "function") {
        throw new TypeError(
          `InvUI: adapter ${kind} subscription must return an unsubscribe function.`,
        );
      }
      unsubscribers.push(unsubscribe as () => void);
    };
  
    try {
      if (this.#adapter.subscribeClose) {
        track(
          this.#adapter.subscribeClose((event) =>
            this.#host.onClose(generation, event),
          ),
          "close",
        );
      }
      // A handler may have closed the Window while the first subscription was
      // being installed; do not install the second one then.
      if (generation !== this.#host.generation() || this.#host.status() !== "opening") {
        this.dispose(unsubscribers);
        return false;
      }
      if (this.#adapter.subscribeItemChange) {
        track(
          this.#adapter.subscribeItemChange((event) =>
            this.#host.onItemChange(generation, event),
          ),
          "itemChange",
        );
      }
    } catch (error) {
      this.dispose(unsubscribers);
      throw error;
    }
  
    if (generation !== this.#host.generation() || this.#host.status() !== "opening") {
      this.dispose(unsubscribers);
      return false;
    }
    this.#eventUnsubscribers = unsubscribers;
    return true;
  }
  
  unsubscribeAll(): void {
    const unsubscribers = this.#eventUnsubscribers;
    this.#eventUnsubscribers = [];
    const containerUnsubscribers = [
      ...this.#containerEventUnsubscribers.values(),
    ];
    this.#containerEventUnsubscribers.clear();
    this.dispose(unsubscribers);
    for (const perContainer of containerUnsubscribers) {
      this.dispose(perContainer);
    }
  }
  
  /**
   * Remove the close/itemChange subscriptions of one container the Window no
   * longer owns: a replacement discarded before it was shown, or the previous
   * screen of a finished regeneration. The handler ignores such a container's
   * events anyway (see #ownsContainer), so keeping the subscription would only
   * pin the container and its engine filter until the Window closes.
   *
   * A container that is still shown or still retiring is left alone: its
   * events still belong to this Window.
   */
  release(container: VirtualContainer): void {
    if (this.#host.owns(container)) {
      return;
    }
    const unsubscribers = this.#containerEventUnsubscribers.get(container);
    if (!unsubscribers) {
      return;
    }
    this.#containerEventUnsubscribers.delete(container);
    this.dispose(unsubscribers);
  }
  
  dispose(unsubscribers: Array<() => void>): void {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        // A broken unsubscribe must not keep the Window open or mask the
        // original open/close failure.
        this.#host.onUnsubscribeError(error);
      }
    }
  }
  

  clear(): void {
    this.detach(true);
  }

  detach(restricted: boolean): {
    eventUnsubscribers: Array<() => void>;
    containerEventUnsubscribers: Array<Array<() => void>>;
  } {
    const eventUnsubscribers = restricted ? [] : this.#eventUnsubscribers;
    this.#eventUnsubscribers = [];
    const containerEventUnsubscribers = restricted
      ? []
      : [...this.#containerEventUnsubscribers.values()];
    this.#containerEventUnsubscribers.clear();
    return { eventUnsubscribers, containerEventUnsubscribers };
  }
}
