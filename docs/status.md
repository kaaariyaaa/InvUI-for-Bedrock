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
- **Clicks:** `Window.handleClick(slot)` can run a button callback, but screen clicks are not automatically delivered to it.
- **Item movement:** Changes are detected after they occur. Restoring items can be incomplete.
- **Inventory links:** `InventoryLink.moveTo()` is unavailable. `PlayerInventory` cannot be modified through this library.
- **Lower inventory:** `setLowerGui()` retains a reference but does not draw lower slots.
- **Custom UI:** JSON UI and Resource Pack generation are not included.
- **Reloads:** Script-reload cleanup is not implemented.

Compatibility depends on the pinned preview version of `@minecraft/server`.

[API reference](api.md) · [Development](development.md)
