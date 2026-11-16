# API reference

All public exports come from [`src/index.ts`](../src/index.ts). For a complete screen example, start with the [README](../README.md).

## GUIs

A `Structure` uses one character per slot (up to 9 columns and 6 rows). Map characters to items, links, or content markers.

~~~ts
import { Gui, Item, ItemBuilder, Markers } from "invui-bedrock";

const gui = Gui.paged({
  structure: ["xxxxxxxxx"],
  ingredients: { x: Markers.CONTENT_LIST_SLOT_HORIZONTAL },
  content: [Item.simple(new ItemBuilder("minecraft:diamond"))],
});
~~~

| API | What it does |
| --- | --- |
| `new Structure(...rows)`, `addIngredient(key, value)` | Define a layout |
| `Gui.normal(options)`, `Gui.paged(options)` | Fixed or paged GUI |
| `Gui.scroll(options)`, `Gui.tab({ tabs })` | Scrolling or tabbed GUI |
| `gui.resolve(viewer?, state?)` | Calculate visible slots |
| `gui.setContent(items)` | Replace the content |
| `gui.setIngredient(key, value)`, `removeIngredient(key)` | Edit the layout |
| `gui.subscribe(fn)` | Listen for changes |

GUI options: `structure`, `ingredients?`, `content?`. Scrolling also supports `direction?`, `contentWidth?`, and `contentHeight?`. `GuiLink` embeds a child GUI with optional `key`, `state`, or `mapping`.

For a builder instead of options, call `Gui.builder()` or a no-argument `Gui.normal()`, `Gui.paged()`, `Gui.scroll()`, or `Gui.tab()`.

[Source](../src/gui/gui.ts)

## Items

`ItemBuilder` creates a Minecraft `ItemStack`. `Item` determines what a GUI slot displays.

~~~ts
import { Item, ItemBuilder } from "invui-bedrock";

const button = Item.builder()
  .setItemProvider(new ItemBuilder("minecraft:emerald"))
  .addClickHandler(({ player }) => player.sendMessage("Selected"))
  .build();
~~~

| API | What it does |
| --- | --- |
| `new ItemBuilder(typeId, amount?)` | Create a stack; configure with `setAmount()`, `setName()`, or lore methods |
| `Item.simple(source)`, `new Item(source)` | Create an item |
| `Item.builder()` | Configure an item using a builder |
| `setItemProvider(source)`, `setPlaceholder(stack)` | Set the item or async placeholder |
| `addClickHandler(fn)`, `setMode(mode)` | Configure button behavior |
| `updateOnClick()`, `updatePeriodically(ticks)`, `notifyWindows()` | Request updates |

Sources can be `ItemStack` values, providers, or functions (including async functions). Items with handlers default to `button` mode; `display` items do not execute handlers. `Item.EMPTY` creates an empty slot.

**Minecraft screen clicks are detected heuristically.** A take from a `button`-mode slot is restored from `beforeItemStack` and then routed through `handleClick()`. This comes from the `virtualContainerItemChange` after-event, so a shift-click or drag is indistinguishable from a click, and a click that moves no item is not seen. Call `window.handleClick(slot)` to invoke a handler explicitly.

[Source](../src/item.ts)

## Windows

`Window.builder()` creates a screen for a player. Open it with `await window.open()`, as shown in the [README](../README.md#quick-start).

| Builder method | What it does |
| --- | --- |
| `setViewer(player)`, `setUpperGui(gui)` | Required player and GUI |
| `setTitle(title)` | Set the title |
| `setStateScope(scope)`, `setStateKey(key)` | Choose `player` or `shared` state; shared state needs a key |
| `setStateLifetime(lifetime)` | `window`, `session`, or `persistent` |
| `setStateManager(manager)` | Supply a state manager |
| `setContainerAdapter(adapter)` | Use a custom screen adapter |
| `addOpenHandler(fn)`, `addCloseHandler(fn)`, `setErrorHandler(fn)` | Register callbacks |
| `setLowerGui(gui)` | Store a reference; lower slots are not drawn |
| `build()` | Create the window |

`Window.mergedBuilder().setGui(gui)` is another way to set the upper GUI.

| Window member | What it does |
| --- | --- |
| `open()`, `close(reason?)`, `refresh()` | Control the screen |
| `setTitle(title)`, `setUpperGui(gui)` | Change displayed content |
| `setLowerGui(gui)` | Replace the lower GUI reference |
| `getState()`, `setState(patch)` | Read or update state |
| `handleClick(slot)` | Call a displayed button's handler explicitly |
| `status`, `isOpen`, `container` | Inspect the window |
| `viewer`, `title`, `upperGui`, `lowerGui`, `id` | Window properties |

The default adapter is `minecraftVirtualContainerAdapter`. Custom adapters implement `WindowContainerAdapter`.

[Source](../src/window/window.ts)

## Inventories

| API | What it does |
| --- | --- |
| `new VirtualInventory(size)` | Store items in memory |
| `getItem(slot)`, `setItem(slot, item)`, `clear()` | Work with slots |
| `getContents()`, `subscribe(fn)` | Read or watch changes |
| `serialize(codec)`, `VirtualInventory.deserialize(snapshot, codec)` | Save or load a snapshot |
| `new InventoryLink(inventory, slot)` | Refer to a slot |
| `new PlayerInventory(player, options?)` | Read the player's inventory |
| `createPlayerInventoryChangeSource(signal, mapSlot)` | Adapt change events |

Serialization needs an `InventoryItemCodec` with `encode()` and `decode()`. There is no built-in codec. `PlayerInventory` is read-only; `InventoryLink.moveTo()` is unavailable.

[Source](../src/inventory/inventory.ts) · [Player inventory](../src/inventory/player-inventory.ts)

## State

`StateManager` manages GUI state. A store is required for persistent state.

~~~ts
import { StateManager } from "invui-bedrock";

const state = new StateManager().acquire({
  ownerId: "player-id",
  initial: { page: 0 },
});
state.set({ page: 1 });
state.release();
~~~

| API | What it does |
| --- | --- |
| `new StateManager(store?, options?)` | Manage state and optional persistence |
| `acquire(options)`, `release(handle)` | Acquire or release a state handle |
| `get()`, `set(patch)`, `subscribe(fn)` | Read, update, or observe state |
| `enqueue(task)`, `update(fn)` | Run ordered state updates |
| `migrate(options, fn)`, `remove(options)` | Manage persisted records |
| `new BedrockWorldStateStore(world, options?)` | Store state in world dynamic properties |

Options include `scope` (`player` or `shared`), `lifetime` (`window`, `session`, or `persistent`), `key`, `ownerId`, `schema`, and `initial`. State fields include `page`, `line`, `tab`, `selection`, `data`, `tabs`, and `children`.

[Source](../src/state/state.ts) · [Bedrock store](../src/state/bedrock-store.ts)

See [Feature status](status.md) for limitations. The generated `dist/index.d.ts` contains full signatures and types.
