# API reference

Import the public API from `invui-bedrock`. The complete list of exports is in [`src/index.ts`](../src/index.ts).

## GUIs

A GUI uses a `Structure` to place items in slots. Each character is one slot, with a maximum size of 9 columns by 6 rows.

~~~ts
import { Gui, Item, ItemBuilder, Markers } from "invui-bedrock";

const gui = Gui.paged({
  structure: ["xxxxxxxxx"],
  ingredients: { x: Markers.CONTENT_LIST_SLOT_HORIZONTAL },
  content: [
    Item.simple(new ItemBuilder("minecraft:stone")),
    Item.simple(new ItemBuilder("minecraft:diamond")),
  ],
});
~~~

| API | Purpose |
| --- | --- |
| `new Structure(...rows)` | Define a character-based layout |
| `Gui.normal(options)` | Fixed layout |
| `Gui.paged(options)` | Pages of content |
| `Gui.scroll(options)` | Scrolling content |
| `Gui.tab({ tabs })` | Switch between child GUIs |
| `Gui.resolve(viewer?, state?)` | Calculate the displayed slots |
| `gui.setContent(items)` | Replace the content |
| `gui.setIngredient(key, value)` | Change a character's item or marker |
| `gui.removeIngredient(key)` | Remove an ingredient |
| `gui.subscribe(listener)` | Listen for layout changes |

`GuiOptions` contains `structure`, optional `ingredients`, and optional `content`. Scrolling GUIs also accept `direction`, `contentWidth`, and `contentHeight`.

Use `GuiLink(child, options)` to embed a GUI. The `key`, `state`, and `mapping` options control its state and slot placement. The horizontal and vertical content markers are in `Markers`.

Builder-style construction is also available through `Gui.builder()` or the no-argument `Gui.normal()`, `Gui.paged()`, `Gui.scroll()`, and `Gui.tab()` methods.

[GUI source](../src/gui/gui.ts)

## Items and buttons

`Item` controls what appears in a slot. An `ItemBuilder` creates the underlying Minecraft `ItemStack`.

~~~ts
import { Item, ItemBuilder } from "invui-bedrock";

const button = Item.builder()
  .setItemProvider(new ItemBuilder("minecraft:emerald").setName("Select"))
  .addClickHandler(({ player }) => {
    player.sendMessage("Selected");
  })
  .build();
~~~

| API | Purpose |
| --- | --- |
| `new ItemBuilder(typeId, amount?)` | Create an item stack |
| `setAmount()`, `setName()`, `addLoreLines()` | Set item details |
| `Item.simple(source)`, `new Item(source)` | Create an item |
| `Item.builder()` | Configure an item with a builder |
| `setItemProvider(source)` | Change its item source |
| `setPlaceholder(stack)` | Display an item while an async source loads |
| `addClickHandler(handler)` | Register a button callback |
| `setMode(mode)` | Choose `button` or `display` |
| `updateOnClick()`, `updatePeriodically(ticks)` | Configure refreshes |
| `notifyWindows()` | Ask subscribed windows to refresh |

An item source can be an `ItemStack`, an `ItemProvider`, or a function returning an item (including asynchronously). Items with click handlers default to `button` mode; `display` items do not run those handlers. `Item.EMPTY` represents an empty slot.

**Click handlers are not connected to actual Minecraft screen clicks.** Call `Window.handleClick(slot)` explicitly to dispatch them.

[Item source](../src/item.ts)

## Windows

A `Window` displays a GUI to a player using `VirtualContainer`.

~~~ts
import { Window, type Gui } from "invui-bedrock";
import type { Player } from "@minecraft/server";

async function openMenu(player: Player, gui: Gui) {
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Menu")
    .setUpperGui(gui)
    .build();

  await window.open();
}
~~~

### Window builder

| Method | Purpose |
| --- | --- |
| `setViewer(player)` | Required player |
| `setUpperGui(gui)` | Required GUI |
| `setTitle(title)` | Set the title |
| `setLowerGui(gui)` | Store a lower GUI reference; it is not rendered |
| `setStateScope(scope)` | `player` or `shared` |
| `setStateKey(key)` | Identify the state; required for shared state |
| `setStateLifetime(lifetime)` | `window`, `session`, or `persistent` |
| `setStateManager(manager)` | Supply a state manager |
| `setContainerAdapter(adapter)` | Replace the default container adapter |
| `addOpenHandler(fn)`, `addCloseHandler(fn)` | Register lifecycle callbacks |
| `setErrorHandler(fn)` | Register error reporting |
| `build()` | Create the window |

`Window.mergedBuilder()` also provides `setGui(gui)` as an alias for `setUpperGui(gui)`.

### Window methods

| Member | Purpose |
| --- | --- |
| `open()`, `close(reason?)` | Open or close the screen |
| `refresh()` | Refresh the displayed content |
| `setTitle(title)` | Change the window title |
| `setUpperGui(gui)`, `setLowerGui(gui)` | Replace GUI references |
| `setState(patch)`, `getState()` | Update or read GUI state |
| `handleClick(slot)` | Call the rendered button's handler explicitly |
| `setErrorHandler(fn)` | Change error reporting |
| `status`, `isOpen`, `container` | Inspect the current window |
| `viewer`, `title`, `upperGui`, `lowerGui`, `id` | Window properties |

The default adapter is `minecraftVirtualContainerAdapter`. Custom adapters implement `WindowContainerAdapter`.

[Window source](../src/window/window.ts)

## Inventories

| API | Purpose |
| --- | --- |
| `new VirtualInventory(size)` | Inventory held in memory |
| `getItem(slot)`, `setItem(slot, item)`, `clear()` | Read or change items |
| `getContents()`, `subscribe(listener)` | Read contents or listen for changes |
| `serialize(codec)`, `VirtualInventory.deserialize(snapshot, codec)` | Save and load an inventory |
| `new InventoryLink(inventory, slot)` | Refer to an inventory slot |
| `new PlayerInventory(player, options?)` | Read the player's inventory |
| `createPlayerInventoryChangeSource(signal, mapSlot)` | Connect an inventory change event |

Inventory snapshots require an `InventoryItemCodec` with `encode` and `decode` methods. No default codec is provided. `PlayerInventory` is read-only, and `InventoryLink.moveTo()` is not implemented.

[Inventory source](../src/inventory/inventory.ts) · [Player inventory source](../src/inventory/player-inventory.ts)

## State

Use `StateManager` to hold GUI state and, optionally, save it across sessions.

~~~ts
import { StateManager } from "invui-bedrock";

const manager = new StateManager();
const state = manager.acquire({
  ownerId: "player-id",
  initial: { page: 0 },
});

state.set({ page: 1 });
state.release();
~~~

| API | Purpose |
| --- | --- |
| `new StateManager(store?, options?)` | Manage state |
| `manager.acquire(options)` | Obtain a state handle |
| `manager.migrate(options, fn)`, `manager.remove(options)` | Change or delete stored state |
| `state.get()`, `state.set(patch)` | Read and update state |
| `state.subscribe(fn)` | Listen for changes |
| `state.enqueue(task)`, `state.update(fn)` | Run ordered updates |
| `state.release()` | Release a handle |
| `new BedrockWorldStateStore(world, options?)` | Store data in world dynamic properties |

`StateAcquireOptions` accepts `scope`, `key`, `ownerId`, `lifetime`, `schema`, and `initial`. GUI state can contain `page`, `line`, `tab`, `selection`, `data`, `tabs`, and `children`.

State is scoped to a `player` or `shared`. Its lifetime is `window`, `session`, or `persistent`. Persistent state requires a store; the default Window manager uses world dynamic properties when available.

[State source](../src/state/state.ts) · [Storage source](../src/state/bedrock-store.ts)

For supported behavior and restrictions, see [Feature status](status.md). For complete signatures and error types, see the generated `dist/index.d.ts`.
