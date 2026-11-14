/**
 * Per-slot write filter for one VirtualContainer (design 11.2).
 *
 * Bedrock has no total equality relation for `ItemStack`: components, dynamic
 * properties, lore, and future fields are not enumerable as one comparable
 * value. "The screen still looks the same" therefore cannot be proven from two
 * stacks, and a diff that skips on a guess can leave stale display data. The
 * one provable skip goes the other way: a slot this cache last wrote empty is
 * written empty again.
 *
 * That skip is safe by construction:
 * - it only avoids clearing an already empty slot, so it cannot delete data;
 * - it never skips a stack, so display content is never withheld.
 *
 * Contract: call `shouldWrite()` before `container.setItem()`, and
 * `markWritten()` only after that call returned without throwing. A throwing
 * `setItem()` is recorded with `markFailed()` so a diff that skips unchanged
 * slots still retries that slot on the next pass instead of leaving the failed
 * write's stale display in place.
 *
 * The cache describes physical container slots. The logical-to-physical
 * mapping is fixed for one container because the only in-place GUI swap
 * (`setUpperGui`) accepts the same state schema, which contains the Structure
 * rows (hence the width and height). A tab switch can change the width; that
 * path re-renders every slot and clears the columns the previous layout used.
 * Start from a fresh cache when the container is created or replaced (open, or
 * a size change), and `invalidate(slot)` a slot whose content something else
 * may have changed (itemChange through the screen).
 */
import type { ItemStack } from "@minecraft/server";

/**
 * ponytail: the only skipped write is empty-over-empty, so a refresh costs one
 * `setItem()` per occupied slot and zero per empty one. Skip more only with an
 * equality the caller itself guarantees (a declared render key on Item); never
 * from a guessed ItemStack comparison.
 */
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
