# Status and limitations

Version `0.1.0-beta.1` (unpublished beta).

> [!CAUTION]
> `VirtualContainer` item changes are restored after the event, not prevented. Duplication or loss is possible. Use disposable worlds.

## Implemented

- Normal, paged, scrolling, and tabbed `Gui` layouts; `Structure` and `GuiLink`
- Item providers, click handlers, placeholders, and update notifications
- `Window` lifecycle, rendering, and GUI replacement
- Player/shared state, persistence, migrations, and schema validation
- `VirtualInventory`, read-only `PlayerInventory`, and inventory snapshots
- Read-only Behavior Pack inspection CLI

## Limitations

| Feature | Status |
| --- | --- |
| Screen UI | Uses experimental `VirtualContainer` |
| Click handlers | `Window.handleClick(slot)` dispatches an eligible button callback when called explicitly |
| Item protection | Post-event restoration and reconciliation, not preventative locking |
| Inventory movement | `InventoryLink.moveTo()` disabled; `PlayerInventory` read-only |
| Lower inventory | `setLowerGui()` stores a reference but does not render it |
| JSON UI / Resource Pack | Not included |
| Script reload cleanup | Not implemented |
| Runtime compatibility | Depends on the pinned experimental Script API |

Real item changes may not be fully reversible.

See the [API reference](api.md) and [development guide](development.md).
