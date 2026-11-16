# Feature status

Version `0.1.0-beta.1`. The package is private and unpublished.

## Available

- Normal, paged, scrolling, and tabbed GUIs, with nested `GuiLink` layouts
- Item providers, placeholders, button callbacks, and update notifications
- Window lifecycle, screen rendering, and GUI replacement
- Player or shared state, optional persistence, and migrations
- Virtual inventories, inventory snapshots, and read-only player inventories
- Read-only Behavior Pack inspection CLI

## Current limitations

- **Screens:** Uses the experimental Minecraft `VirtualContainer` API.
- **Clicks:** A take from a `button`-mode slot is restored and then routed to `handleClick()`. Detection happens after the item change, so shift-click and drag are indistinguishable from a click, and a click that moves no item is not seen. `Window.handleClick(slot)` also runs a callback explicitly.
- **Item movement:** Changes are detected after they occur. Restoring items can be incomplete.
- **Inventory links:** `InventoryLink.moveTo()` is unavailable. `PlayerInventory` cannot be modified through this library.
- **Lower inventory:** `setLowerGui()` retains a reference but does not draw lower slots.
- **Custom UI:** JSON UI and Resource Pack generation are not included.
- **Reloads:** Script-reload cleanup is not implemented.

Compatibility depends on the pinned preview version of `@minecraft/server`.

[API reference](api.md) · [Development](development.md)
