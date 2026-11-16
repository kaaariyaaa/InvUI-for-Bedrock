# API reference

Public exports: [`src/index.ts`](../src/index.ts). Package version: `0.1.0-beta.1`.

## GUI

[`src/gui.ts`](../src/gui/gui.ts)

| API | Description |
| --- | --- |
| `new Structure(...rows)` | Character-based layout, up to 9 columns and 6 rows |
| `Structure.addIngredient(key, value)` | Map a character to an item, link, or marker |
| `Structure.getIngredient(key)`, `clone()` | Read an ingredient or copy the layout |
| `Gui.normal(options)` | Normal GUI |
| `Gui.paged(options)` | Paged GUI |
| `Gui.scroll(options)` | Scrolling GUI |
| `Gui.tab({ tabs })` | Tabbed GUI |
| `Gui.resolve(viewer?, state?)` | Resolve slots and page/scroll/tab state |
| `Gui.setContent(items)` | Replace content |
| `Gui.setIngredient(key, value)`, `removeIngredient(key)` | Change ingredients |
| `Gui.subscribe(listener)` | Subscribe to layout updates |

`GuiOptions` accepts `structure` (required), `ingredients?`, and `content?`. Scrolling adds `direction?`, `contentWidth?`, and `contentHeight?`.

```ts
import { Gui, Item, ItemBuilder, Markers } from "invui-bedrock";

const gui = Gui.paged({
  structure: ["xxxxxxxxx"],
  ingredients: { x: Markers.CONTENT_LIST_SLOT_HORIZONTAL },
  content: [Item.simple(new ItemBuilder("minecraft:stone"))],
});
```

Builders: `Gui.builder()`, `Gui.normal()`, `Gui.paged()`, `Gui.scroll()`, `Gui.tab()`, and `PagedGui.itemsBuilder()`. Use `setStructure()`, `addIngredient()`, `setContent()`, and `build()`. Scroll builders add `setDirection()`, `setContentWidth()`, and `setContentHeight()`; tab builders use `setTabs()` or `addTab()`.

`GuiLink(child, { key?, state?, mapping? })` embeds a child GUI. `Markers.CONTENT_LIST_SLOT_HORIZONTAL` and `Markers.CONTENT_LIST_SLOT_VERTICAL` identify content slots.

## Items

[`src/item.ts`](../src/item.ts)

| API | Description |
| --- | --- |
| `new ItemBuilder(typeId, amount?)` | Create an item stack provider |
| `setAmount()`, `setName()`, `addLoreLines()`, `setLoreLines()` | Configure a stack |
| `ItemBuilder.build()` | Create an `ItemStack` |
| `Item.simple(source)`, `new Item(source)` | Create an item definition |
| `Item.builder()` | Create an `ItemDefinitionBuilder` |
| `setItemProvider()`, `setPlaceholder()` | Configure item providers |
| `addClickHandler(handler)` | Register a click handler |
| `setMode(mode)`, `getMode()` | Display or button mode |
| `updateOnClick()`, `updatePeriodically(ticks)` | Configure updates |
| `resolve(viewer)`, `resolveForDisplay(viewer)` | Resolve a provider |
| `subscribe(listener)`, `notifyWindows()` | Notify open windows |

```ts
const item = Item.builder()
  .setItemProvider(new ItemBuilder("minecraft:emerald"))
  .addClickHandler(({ player, slot, window }) => {
    // Handle the click.
  })
  .build();
```

`ClickContext` contains `player`, `slot`, and `window`. Sources may be `ItemStack`, a provider function (including async), or an `ItemProvider`. `Item.EMPTY` represents an empty element.

## Windows

[`src/window.ts`](../src/window/window.ts)

### `WindowBuilder`

```ts
import { Window, type Gui } from "invui-bedrock";
import type { Player } from "@minecraft/server";

async function openGui(player: Player, gui: Gui) {
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Example")
    .setUpperGui(gui)
    .build();

  await window.open();
}
```

| Method | Description |
| --- | --- |
| `setViewer(player)` | Set the player (required) |
| `setUpperGui(gui)` | Set the GUI (required) |
| `setTitle(title)` | Window title |
| `setLowerGui(gui)` | Store a lower GUI reference; does not render lower slots |
| `setStateScope(scope)` | `player` or `shared` |
| `setStateKey(key)` | State identity |
| `setStateLifetime(lifetime)` | `window`, `session`, or `persistent` |
| `setStateManager(manager)` | State manager |
| `setContainerAdapter(adapter)` | Container adapter |
| `addOpenHandler(fn)`, `addCloseHandler(fn)` | Lifecycle callbacks |
| `setErrorHandler(fn)` | Error callback |
| `build()` | Create the window |

`Window.mergedBuilder()` supports `setGui(gui)` before `build()`.

### `Window`

| Member | Description |
| --- | --- |
| `open()`, `close(reason?)` | Open or close |
| `refresh()`, `setTitle(title)` | Refresh or update title |
| `setUpperGui(gui)`, `setLowerGui(gui)` | Replace GUI references |
| `setState(patch)`, `getState()` | Write/read state |
| `handleClick(slot)` | Dispatch an eligible item handler |
| `setErrorHandler(fn)` | Replace error callback |
| `status`, `isOpen`, `container` | Read lifecycle state |
| `viewer`, `title`, `upperGui`, `lowerGui`, `id` | Window properties |

The default adapter is `minecraftVirtualContainerAdapter`. Custom adapters implement `WindowContainerAdapter`. `handleClick(slot)` is invoked explicitly; no automatic UI click transport is included.

`WindowCloseReason` includes `PlayerClosed`, `PlayerDied`, `PlayerLeft`, `PlayerSpectating`, `ServerClosed`, and `UserBusy`.

## Inventories

[`src/inventory.ts`](../src/inventory/inventory.ts) · [`src/player-inventory.ts`](../src/inventory/player-inventory.ts)

| API | Description |
| --- | --- |
| `new VirtualInventory(size)` | In-memory inventory |
| `getItem(slot)`, `setItem(slot, item)`, `clear()` | Inventory operations |
| `getContents()`, `subscribe(listener)` | Read contents or changes |
| `serialize(codec)`, `VirtualInventory.deserialize(snapshot, codec)` | Save/restore snapshots |
| `serializeInventory(inventory, codec)` | Serialize any `Inventory` |
| `new InventoryLink(inventory, slot)` | Link to an inventory slot |
| `new PlayerInventory(player, options?)` | Read-only player inventory |
| `createPlayerInventoryChangeSource(signal, mapSlot)` | Optional event adapter |

`InventoryItemCodec` supplies `encode()` and `decode()`. There is no built-in codec. `InventoryLink.moveTo()` always throws; `PlayerInventory.setItem()` and `clear()` also throw.

## State

[`src/state.ts`](../src/state/state.ts) · [`src/bedrock-store.ts`](../src/state/bedrock-store.ts)

```ts
import { StateManager } from "invui-bedrock";

const manager = new StateManager();
const state = manager.acquire({ ownerId: "player-id", initial: { page: 0 } });
state.set({ page: 1 });
state.release();
```

| API | Description |
| --- | --- |
| `new StateManager(store?, options?)` | Manage state; persistence requires a `StateStore` |
| `acquire(options)`, `release(handle)` | Open/release a state handle |
| `migrate(options, fn)`, `remove(options)` | Migrate or remove stored state |
| `StateHandle.get()`, `set(patch)`, `subscribe(fn)` | Read/update/listen |
| `StateHandle.enqueue(task)`, `update(fn)` | Queue updates |
| `new BedrockWorldStateStore(world, options?)` | Persist state in world dynamic properties |

`StateAcquireOptions`: `scope?`, `key?`, `ownerId?`, `lifetime?`, `schema?`, `initial?`. Scopes: `player` / `shared`. Lifetimes: `window` / `session` / `persistent`.

`GuiState` fields: `page`, `line`, `tab`, `selection`, `data`, `tabs`, `children`. Optional manager settings include `onError`, `quarantineCorrupt`, and `migrations`.

For additional types and errors, see the generated `dist/index.d.ts` or the linked source files.

## Limitations

`VirtualContainer` is experimental. Item changes are handled after they occur and can lead to duplication or loss. `InventoryLink.moveTo()` is disabled; custom JSON UI and automatic click notifications are not included. See [Status and limitations](status.md).
