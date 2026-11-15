# API reference

InvUI for Bedrock `0.1.0-beta.1`. This document describes the public entry point in [`src/index.ts`](../src/index.ts). The package is not published to npm; build or install it locally before importing from `invui-bedrock`.

> [!WARNING]
> The default `Window` adapter attempts to open a real `VirtualContainer` screen, but has **not been tested in Minecraft**. The package does not provide UI-generated click events or JSON UI integration. Slot changes are handled after the event and may result in item duplication or loss. Only test in disposable worlds.

## Layouts: `Structure` and `Gui`

Source: [`src/gui.ts`](../src/gui.ts).

### `Structure`

```ts
new Structure(...rows: Array<string | readonly string[]>)
```

A character-based slot layout, with one Unicode code point per slot. All rows must have the same width. A structure can contain at most **9 columns and 6 rows**.

| Member | Purpose |
| --- | --- |
| `addIngredient(key, ingredient)` | Assign an ingredient to a one-character key |
| `getIngredient(key)` | Read an ingredient |
| `clone()` | Copy the structure |
| `rows`, `width`, `height` | Read the rows and dimensions |

`Ingredient` is an `Item`, an `InventoryLink`, a `GuiLink`, or a content marker. A `SlotElement` is an `Item | InventoryLink`.

### `Gui` factories

| Call | Result |
| --- | --- |
| `Gui.normal(options)` | Normal `Gui` |
| `Gui.paged(options)` | `PagedGui` |
| `Gui.scroll(options)` | `ScrollGui` |
| `Gui.tab({ tabs })` | `TabGui` |
| `Gui.normal()`, `Gui.paged()`, `Gui.scroll()`, `Gui.tab()` | Corresponding builder |
| `Gui.builder()` | `GuiBuilder` |
| `PagedGui.itemsBuilder()` | `PagedGuiBuilder` |

`GuiOptions` and `PagedGuiOptions` use the following properties:

| Property | Type | Meaning |
| --- | --- | --- |
| `structure` | `Structure | readonly string[]` | Required layout |
| `ingredients?` | `Record<string, Ingredient>` | Optional character-to-ingredient mapping |
| `content?` | `readonly SlotElement[]` | Content items |

`ScrollGuiOptions` additionally supports `direction?: "vertical" | "horizontal"`, `contentWidth?: number`, and `contentHeight?: number`. `TabGuiOptions` requires `tabs: readonly Gui[]`.

```ts
import { Gui, Item, ItemBuilder, Markers } from "invui-bedrock";

const gui = Gui.paged({
  structure: ["xxxxxxxxx"],
  ingredients: {
    x: Markers.CONTENT_LIST_SLOT_HORIZONTAL,
  },
  content: [
    Item.simple(new ItemBuilder("minecraft:stone")),
    Item.simple(new ItemBuilder("minecraft:diamond")),
  ],
});
```

`Markers.CONTENT_LIST_SLOT_HORIZONTAL` and `Markers.CONTENT_LIST_SLOT_VERTICAL` designate content positions. `Gui.resolve(viewer?, state?)` returns a `ResolvedGuiLayout` describing the resolved slots, dimensions, pages, scroll position, and tab. It does not open a screen.

A `Gui` instance exposes `setContent(content)`, `setIngredient(key, ingredient)`, `removeIngredient(key)`, and `subscribe(listener)`. `TabGui` selects its active child using `state.tab`.

### Builders and linked GUIs

| Builder | Methods |
| --- | --- |
| `GuiBuilder` | `setStructure()`, `addIngredient()`, `setContent()`, `build()` |
| `PagedGuiBuilder` | Same configuration methods; `build()` creates a `PagedGui` |
| `ScrollGuiBuilder` | Base methods and `setDirection()`, `setContentWidth()`, `setContentHeight()`; `build()` creates a `ScrollGui` |
| `TabGuiBuilder` | `setTabs()`, `addTab()`, `build()` |

`GuiLink` projects a child GUI into another layout:

```ts
new GuiLink(childGui, { key?, state?, mapping? })
```

The optional `key` selects nested state in `state.children[key]`. An explicit `state` overrides it; `mapping` specifies child-slot to parent-slot indices.

## Items

Source: [`src/item.ts`](../src/item.ts).

### `ItemBuilder`

`new ItemBuilder(typeId, amount = 1)` creates an `@minecraft/server` `ItemStack` provider.

| Member | Purpose |
| --- | --- |
| `setAmount(amount)` | Set stack amount |
| `setName(name)` | Set display name |
| `addLoreLines(...lines)` | Append lore |
| `setLoreLines(...lines)` | Replace lore |
| `build()` | Build an `ItemStack` |
| `provide(viewer)` | Return an `ItemStack` |

### `Item` and `ItemDefinitionBuilder`

Use `Item.simple(source)`, `new Item(source)`, or `Item.builder()...build()`. Sources may be `ItemStack`, `ItemProvider` objects implementing `provide(viewer)`, or provider functions, including asynchronous ones.

```ts
import { Item, ItemBuilder } from "invui-bedrock";

const item = Item.builder()
  .setItemProvider(new ItemBuilder("minecraft:emerald").setName("Action"))
  .addClickHandler(({ player, slot, window }) => {
    // Registering a handler does not generate in-game click events.
  })
  .updateOnClick()
  .build();
```

| Member | Purpose |
| --- | --- |
| `setItemProvider(source)` | Change the provider |
| `setPlaceholder(stack)`, `getPlaceholder()` | Manage a placeholder for asynchronous resolution |
| `addClickHandler(handler)` | Register a `ClickContext` handler |
| `setMode(mode)`, `getMode()` | Set/read `"display" | "button"` |
| `updateOnClick()`, `getUpdateOnClick()` | Click-triggered update setting |
| `updatePeriodically(ticks)`, `getUpdatePeriod()` | Periodic update setting |
| `subscribe(listener)`, `notifyWindows()` | Subscribe to and emit item updates |
| `resolve(viewer)`, `resolveForDisplay(viewer)` | Resolve the item provider |
| `handleClick(context)` | Execute eligible click handlers |
| `Item.EMPTY` | Empty item definition |

`ItemDefinitionBuilder` supports `setItemProvider()`, `setPlaceholder()`, `addClickHandler()`, `updateOnClick()`, `updatePeriodically()`, and `build()`.

`ClickContext` contains `player`, `slot`, and `window`. `ItemMode` only controls metadata and callback execution: it **does not prevent** players from moving displayed items.

## Windows

Source: [`src/window.ts`](../src/window.ts).

### `WindowBuilder`

```ts
import { Window, type Gui } from "invui-bedrock";
import type { Player } from "@minecraft/server";

async function openScreen(player: Player, gui: Gui): Promise<void> {
  const window = Window.builder()
    .setViewer(player)
    .setTitle("Example")
    .setUpperGui(gui)
    .setStateScope("player")
    .setStateLifetime("window")
    .build();

  // Use a disposable world only. In-game behavior is unverified.
  await window.open();
}
```

| Method | Purpose |
| --- | --- |
| `setViewer(player)` | Required viewer |
| `setUpperGui(gui)` | Required upper GUI |
| `setTitle(title)` | Window title |
| `setLowerGui(gui)` | Retain a lower GUI reference; **does not render** the player inventory area |
| `setStateScope("player" | "shared")` | State scope |
| `setStateKey(key)` | State identity |
| `setStateLifetime("window" | "session" | "persistent")` | State lifetime |
| `setStateManager(manager)` | Supply a `StateManager` |
| `setContainerAdapter(adapter)` | Supply a screen adapter |
| `addOpenHandler(handler)`, `addCloseHandler(handler)` | Lifecycle callbacks |
| `setErrorHandler(handler)` | Error callback |
| `build()` | Build a `Window` |

`Window.mergedBuilder()` returns a `MergedWindowBuilder` with `setGui(gui)`.

### `Window` instance

| Member | Purpose |
| --- | --- |
| `open(): Promise<void>` | Attempt to open a screen |
| `close(reason?)` | Close, default reason `"ServerClosed"` |
| `refresh(): Promise<void>` | Refresh displayed content |
| `setTitle(title): Promise<void>` | Change title; may recreate the container |
| `setUpperGui(gui)` | Replace upper GUI; size changes may recreate the container |
| `setLowerGui(gui)` | Change stored lower GUI only |
| `setState(patch)`, `getState()` | Update/read GUI state |
| `handleClick(slot): Promise<boolean>` | Route a click to an eligible button, not proof of a real UI click |
| `setErrorHandler(handler)` | Change the error handler |
| `status`, `isOpen`, `container` | Lifecycle and container information |
| `viewer`, `title`, `upperGui`, `lowerGui`, `id` | Window configuration and identity |
| `_inputSessionId`, `_inputLayoutGeneration` | Input-message identifiers (not authentication) |

`WindowStatus` is `"created" | "opening" | "open" | "closing" | "closed"`. `WindowCloseReason` includes `"PlayerClosed"`, `"PlayerDied"`, `"PlayerLeft"`, `"PlayerSpectating"`, `"ServerClosed"`, and `"UserBusy"`.

The default adapter, `minecraftVirtualContainerAdapter`, is an instance of `MinecraftVirtualContainerAdapter`. `WindowContainerAdapter` is the public adapter interface for `createContainer()`, `openContainer()`, `closeContainer()`, and optional `subscribeClose()` and `subscribeItemChange()` hooks. Adapter events are reported after they occur.

The exports also include `WindowConfig`, window event/handler types, `MAX_OPEN_RENDER_PASSES`, `WindowOpenRejectedError`, `WindowItemChangeDangerError`, `WindowStateSchemaChangedError`, and `WindowOpenRenderLimitError`.

## Inventories

Sources: [`src/inventory.ts`](../src/inventory.ts) and [`src/player-inventory.ts`](../src/player-inventory.ts).

| API | Operations |
| --- | --- |
| `new VirtualInventory(size)` | `getItem()`, `setItem()`, `clear()`, `getContents()`, `subscribe()` |
| `VirtualInventory.serialize(codec)` | Encode an in-memory inventory |
| `VirtualInventory.deserialize(snapshot, codec)` | Restore an encoded inventory |
| `serializeInventory(inventory, codec)` | Encode any compatible `Inventory` |
| `cloneItem(item)` | Clone an `ItemStack` or preserve `undefined` |
| `new InventoryLink(inventory, slot)` | `getItem()`, `setItem()`, `subscribe()` |
| `new PlayerInventory(player, options?)` | Read-only `getItem()` and optional change subscription |

`Inventory` defines `size`, `getItem()`, `setItem()`, `clear()`, and `subscribe()`. An `InventoryItemCodec<T>` must provide `encode(item)` and `decode(value)`. No general-purpose codec is provided because an `ItemStack` cannot be completely serialized through the exposed API.

`InventoryLink.moveTo()` always throws `InventoryLinkMoveRejectedError`. `PlayerInventory.setItem()` and `clear()` throw `PlayerInventoryReadOnlyError`. `PlayerInventory` does not automatically subscribe to game inventory changes. To supply verified change events, use `createPlayerInventoryChangeSource(signal, mapSlot)` with a caller-provided slot mapper tested in the game.

Related exported declarations include `InventoryChange`, `InventoryListener`, `InventoryItemCodec`, `SerializedVirtualInventory`, `INVENTORY_SNAPSHOT_VERSION`, `PlayerInventoryOptions`, `PlayerInventoryChange`, `PlayerInventoryChangeSource`, `PlayerInventoryItemChangeEvent`, `PlayerInventoryItemChangeSignal`, and `PlayerInventorySlotMapper`.

## State management

Source: [`src/state.ts`](../src/state.ts).

### `StateManager`

```ts
const manager = new StateManager(store?, {
  onError?: (error: unknown) => void,
  quarantineCorrupt?: boolean,
  migrations?: readonly StateAutoMigration[],
});
```

A `StateStore` is a synchronous store with `getItem(key)`, `setItem(key, value)`, and `removeItem(key)`. `persistent` state requires a store; `quarantineCorrupt` is **off** by default.

| Method | Purpose |
| --- | --- |
| `acquire(options)` | Acquire a `StateHandle` |
| `migrate(options, migrate)` | Explicitly migrate a persistent record |
| `remove(options)` | Delete a stored record |
| `release(handle)` | Release an acquired handle |

`StateAcquireOptions` accepts `scope?`, `key?`, `ownerId?`, `lifetime?`, `schema?`, and `initial?`. Scope is `"player" | "shared"`; lifetime is `"window" | "session" | "persistent"`. A player scope requires `ownerId`; a shared scope requires `key` and rejects `ownerId`.

A `StateHandle` exposes `get()`, `set(patch)`, `subscribe(listener)`, `enqueue(task)`, `update(updater)`, and `release()`. The `update()` method serializes a read-modify-write operation for the same state identity. Do not await another operation queued for that identity from inside the queued task.

`GuiState` fields are `page`, `line`, `tab`, `selection`, `data`, `tabs` (per-tab state), and `children` (per-linked-GUI state). Related exported declarations include `GuiStatePatch`, `StateSnapshot`, `StateListener`, `StateScope`, `StateLifetime`, `StateAcquireOptions`, `StateManagerOptions`, `StateAutoMigration`, `StateMigration`, `StateMigrationOptions`, `StateRemoveOptions`, `StateHandle`, `StoredGuiState`, and `STATE_STORAGE_VERSION`.

### Bedrock persistence

Source: [`src/bedrock-store.ts`](../src/bedrock-store.ts).

`new BedrockWorldStateStore(world, options?)` stores state records in world dynamic properties and implements `StateStore`. It exposes `identifierFor(key)`, `getItem(key)`, `setItem(key, value)`, and `removeItem(key)`. Options allow overriding `maxIdentifierLength` and `maxValueLength`.

Exported types/constants include `DynamicPropertyHost`, `BedrockStateStoreOptions`, `BedrockStoreError`, `BedrockStoreErrorCode`, `BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH`, and `BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH`. State errors include `StateError`, `StateValidationError`, `StateConflictError`, `StateReleasedError`, `StateCorruptionError`, and `StateErrorCode`.

## Runtime boundaries

- The package is private and unpublished; building locally does not install a tested game add-on.
- The npm `@minecraft/server` package contains TypeScript declarations rather than a standalone Node.js runtime. Node.js execution of these modules requires appropriate mocks or the actual game engine.
- Input receives formatted chat messages; the repository does not include UI components that generate them. Manually typed messages can mimic notifications.
- Experimental screen behavior, item restoration, and lifecycle cleanup require verification in Minecraft.

See [Status and limitations](status.md) and [Development](development.md).
