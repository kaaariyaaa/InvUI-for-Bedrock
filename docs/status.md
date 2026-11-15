# Status and limitations

InvUI for Bedrock `0.1.0-beta.1` is an **unpublished beta**. The library contains working TypeScript code paths, but **has not been tested inside Minecraft**.

> [!WARNING]
> The default `minecraftVirtualContainerAdapter` attempts to open real `VirtualContainer` screens. Changes to inventory slots can only be restored *after* they occur. Item extraction followed by redraws may cause duplication or loss. Only run experiments in disposable worlds.

## Implemented in source

| Component | Implemented behavior |
| --- | --- |
| GUI | `Structure`, normal/paged/scroll/tab `Gui`, `GuiLink`, layout resolution |
| Items | `Item`/`ItemBuilder`, providers, placeholders, click handlers, periodic updates |
| Windows | Configuration builders, state access, redraws, GUI replacement, open/close requests |
| State | Player/shared scopes, window/session/persistent lifetimes, schema checks, migrations, optional corrupt-record quarantine |
| Inventories | `VirtualInventory`, codec-based snapshots, read-only `PlayerInventory`, `InventoryLink` references |
| Bedrock adapter | Experimental `VirtualContainer` creation/open/close and after-event subscriptions |
| Input | Receiver for `!invui:<session-id>:<layout-generation>:<slot>:<sequence>` through `world.beforeEvents.chatSend` |
| Tooling | TypeScript build, local package preparation, read-only Behavior Pack inspection CLI, build CI |

Layout, item, state, and window logic has previously been checked in a Node.js environment with mocked Minecraft interfaces. Such checks do not establish Minecraft compatibility or item safety.

## Unsupported or unverified behavior

**Screen opening and closing.** `Window.open()` uses the experimental API by default. Its rendering, close timing, and lifecycle behavior have not been verified on a game client.

**Real UI clicks.** The library can parse and route specifically formatted chat notifications. It does not include a JSON UI or another component that sends them when a slot is pressed. Players can type the same notifications manually, so they are not authenticated clicks. Session and layout-generation checks only reject certain stale or mismatched messages.

**Item safety.** `virtualContainerItemChange` events occur after items have moved. The implementation attempts to restore container slots and reconcile matching player inventory, cursor, and dropped-item changes on a subsequent tick. This is not preventative protection and may fail in-game. A redraw may overwrite an item placed by a player or recreate one taken by a player.

**Inventory movement.** `InventoryLink.moveTo()` always throws `InventoryLinkMoveRejectedError`. `PlayerInventory` is read-only, and optional inventory-change event mapping requires on-device verification.

**Lower inventory GUI.** `Window.setLowerGui()` stores a GUI reference but does not render the player's lower inventory slots.

**JSON UI / Resource Packs.** Neither integration nor generated assets are included.

**Script reload.** The library has handlers for several lifecycle events, including departure, death, dimension changes, spectator mode, and world shutdown, but reload cleanup is not implemented. None of these paths has been verified on a Minecraft client.

**Compatibility.** `@minecraft/server` is pinned to `2.13.0-beta.1.26.70-preview.24`. A compatible Minecraft game build has not been established by device testing.

## Rendering and persistence limits

State-triggered rendering compares layouts and reevaluates modified slots and items that might depend on state. Explicit `refresh()` and content changes may reevaluate all slots. GUI size changes require container recreation; incompatible state schemas can reject updates. These optimizations do **not** make inventory operations safe.

For persistence, `StateManager` needs a `StateStore`; a Bedrock dynamic-property implementation is available. Migrations must be configured or invoked, and corruption quarantine is opt-in.

## Testing requirement

Before the library can be used for actual gameplay, opening and closing, click identification, ordinary-container isolation, cross-input behavior, and item duplication/loss must be tested in Minecraft. Until then, treat it as experimental code.

See the [API reference](api.md) and [development guide](development.md).
