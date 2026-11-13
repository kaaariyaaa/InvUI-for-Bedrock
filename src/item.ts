import { ItemStack } from "@minecraft/server";
import type { Player } from "@minecraft/server";

/**
 * Context handed to an Item click handler. The Window/EventRouter owns
 * generation checks; Item only invokes handlers in registration order.
 */
export interface ClickContext {
  readonly player: Player;
  readonly slot: number;
  readonly window: unknown;
}

export type ClickHandler = (context: ClickContext) => void | Promise<void>;

export type MaybeItemStack = ItemStack | undefined | Promise<ItemStack | undefined>;

/** Player-dependent display source (Java InvUI's ItemProvider). */
export interface ItemProvider {
  provide(viewer: Player): MaybeItemStack;
}

export type ItemProviderFunction = (viewer: Player) => MaybeItemStack;

/** Accepted anywhere a display source is expected. */
export type ItemProviderSource = ItemProvider | ItemProviderFunction | ItemStack;

export type ItemUpdateListener = () => void;

let nextItemId = 1;

function cloneItem(stack: ItemStack): ItemStack {
  return stack.clone();
}

function isItemStack(source: ItemProviderSource): source is ItemStack {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as ItemStack).typeId === "string" &&
    typeof (source as ItemStack).clone === "function"
  );
}

function normalizeProvider(source: ItemProviderSource): ItemProviderFunction {
  if (typeof source === "function") {
    return source;
  }
  if (isItemStack(source)) {
    return () => cloneItem(source);
  }
  if (source && typeof (source as ItemProvider).provide === "function") {
    const provider = source as ItemProvider;
    return (viewer) => provider.provide(viewer);
  }
  throw new TypeError("InvUI: Item provider must be an ItemStack, function, or { provide() }.");
}

function assertTicks(ticks: number): void {
  if (!Number.isInteger(ticks) || ticks <= 0) {
    throw new RangeError(`InvUI: updatePeriodically ticks must be a positive integer (got ${ticks}).`);
  }
}

/**
 * Builds the ItemStack used for display. Each build returns a fresh stack so
 * callers can mutate it without sharing state.
 */
export class ItemBuilder implements ItemProvider {
  private readonly typeId: string;
  private itemAmount: number;
  private name: string | undefined;
  private lore: string[] = [];

  constructor(typeId: string, amount = 1) {
    if (typeof typeId !== "string" || typeId.length === 0) {
      throw new TypeError("InvUI: ItemBuilder requires a non-empty item type id.");
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new RangeError(`InvUI: ItemBuilder amount must be a positive integer (got ${amount}).`);
    }
    this.typeId = typeId;
    this.itemAmount = amount;
  }

  setAmount(amount: number): this {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new RangeError(`InvUI: ItemBuilder amount must be a positive integer (got ${amount}).`);
    }
    this.itemAmount = amount;
    return this;
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  addLoreLines(...lines: string[]): this {
    this.lore.push(...lines);
    return this;
  }

  setLoreLines(...lines: string[]): this {
    this.lore = [...lines];
    return this;
  }

  provide(_viewer: Player): ItemStack {
    return this.createStack();
  }

  build(): ItemStack {
    return this.createStack();
  }

  private createStack(): ItemStack {
    const stack = new ItemStack(this.typeId, this.itemAmount);
    if (this.name !== undefined) {
      stack.nameTag = this.name;
    }
    if (this.lore.length > 0) {
      stack.setLore([...this.lore]);
    }
    return stack;
  }
}

/** Stage-builder returned by Item.builder(). */
export class ItemDefinitionBuilder {
  private provider: ItemProviderSource = () => undefined;
  private clickHandlers: ClickHandler[] = [];
  private updateAfterClick = false;
  private periodTicks: number | undefined;

  setItemProvider(source: ItemProviderSource): this {
    this.provider = source;
    return this;
  }

  addClickHandler(handler: ClickHandler): this {
    if (typeof handler !== "function") {
      throw new TypeError("InvUI: click handler must be a function.");
    }
    this.clickHandlers.push(handler);
    return this;
  }

  updateOnClick(): this {
    this.updateAfterClick = true;
    return this;
  }

  updatePeriodically(ticks: number): this {
    assertTicks(ticks);
    this.periodTicks = ticks;
    return this;
  }

  build(): Item {
    const item = new Item(this.provider);
    for (const handler of this.clickHandlers) {
      item.addClickHandler(handler);
    }
    if (this.updateAfterClick) {
      item.updateOnClick();
    }
    if (this.periodTicks !== undefined) {
      item.updatePeriodically(this.periodTicks);
    }
    return item;
  }
}

/**
 * A display element. It holds no Window reference: update consumers subscribe
 * via subscribe() and Item.notifyWindows() fans out to all of them.
 */
export class Item {
  static readonly EMPTY: Item = new Item(() => undefined);

  readonly id: string;

  private provider: ItemProviderFunction;
  private clickHandlers: ClickHandler[] = [];
  private updateListeners = new Set<ItemUpdateListener>();
  private updateAfterClick = false;
  private periodTicks: number | undefined;

  constructor(provider: ItemProviderSource = () => undefined) {
    this.id = `item-${nextItemId++}`;
    this.provider = normalizeProvider(provider);
  }

  static simple(source: ItemProviderSource): Item {
    return new Item(source);
  }

  static builder(): ItemDefinitionBuilder {
    return new ItemDefinitionBuilder();
  }

  /** Resolve the display stack for a viewer; providers may be asynchronous. */
  resolve(viewer: Player): Promise<ItemStack | undefined> {
    return Promise.resolve(this.provider(viewer));
  }

  setItemProvider(source: ItemProviderSource): this {
    this.provider = normalizeProvider(source);
    this.notifyWindows();
    return this;
  }

  addClickHandler(handler: ClickHandler): this {
    if (typeof handler !== "function") {
      throw new TypeError("InvUI: click handler must be a function.");
    }
    this.clickHandlers.push(handler);
    return this;
  }

  /** Handlers run sequentially; handler errors propagate to the Window. */
  async handleClick(context: ClickContext): Promise<void> {
    for (const handler of [...this.clickHandlers]) {
      await handler(context);
    }
    if (this.updateAfterClick) {
      this.notifyWindows();
    }
  }

  updateOnClick(): this {
    this.updateAfterClick = true;
    return this;
  }

  getUpdateOnClick(): boolean {
    return this.updateAfterClick;
  }

  /** Requested re-evaluation period in ticks, or undefined when not periodic. */
  updatePeriodically(ticks: number): this {
    assertTicks(ticks);
    this.periodTicks = ticks;
    this.notifyWindows();
    return this;
  }

  getUpdatePeriod(): number | undefined {
    return this.periodTicks;
  }

  /** Window/UpdateScheduler registration point. */
  subscribe(listener: ItemUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  notifyWindows(): void {
    for (const listener of [...this.updateListeners]) {
      try {
        listener();
      } catch (error) {
        console.error("InvUI: item update listener failed.", error);
      }
    }
  }
}
