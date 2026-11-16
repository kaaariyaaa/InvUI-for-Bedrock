/**
 * Skip empty-to-empty writes for the current container only.
 * General ItemStack equality is not reliable across all item properties.
 * Invalidate any slot changed outside rendering.
 */
import type { ItemStack } from "@minecraft/server";

/** Skipping nonempty writes requires a caller-provided equality guarantee. */
export class SlotWriteCache {
  /** Physical container slots whose last successful write was empty. */
  readonly #empty = new Set<number>();

  /** Physical slots whose last `setItem()` threw and were not written since. */
  readonly #failed = new Set<number>();

  /** False only when the slot is known empty and the next value is empty too. */
  shouldWrite(physicalSlot: number, stack: ItemStack | undefined): boolean {
    return stack !== undefined || !this.#empty.has(physicalSlot);
  }

  /** True when the last write attempt for this slot threw. */
  needsRetry(physicalSlot: number): boolean {
    return this.#failed.has(physicalSlot);
  }

  /** Record a successful write; never call this for a throwing `setItem()`. */
  markWritten(physicalSlot: number, stack: ItemStack | undefined): void {
    this.#failed.delete(physicalSlot);
    if (stack === undefined) {
      this.#empty.add(physicalSlot);
      return;
    }
    this.#empty.delete(physicalSlot);
  }

  /** Record a throwing `setItem()` so a slot-skipping diff still retries it. */
  markFailed(physicalSlot: number): void {
    this.#failed.add(physicalSlot);
    // The failed write may have been a clear: do not trust the empty record.
    this.#empty.delete(physicalSlot);
  }

  /** Forget one slot, or every slot when called without an argument. */
  invalidate(physicalSlot?: number): void {
    if (physicalSlot === undefined) {
      this.#empty.clear();
      this.#failed.clear();
      return;
    }
    this.#empty.delete(physicalSlot);
    this.#failed.delete(physicalSlot);
  }
}
