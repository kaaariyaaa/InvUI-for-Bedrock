# InvUI for Bedrock

A TypeScript library for building inventory-style GUI screens in Minecraft Bedrock Edition, inspired by [InvUI for Java Edition](https://github.com/NichtStudioCode/InvUI).

Create normal, paged, scrolling, or tabbed GUIs. Display items, update them, and manage window state.

## Quick start

Create a GUI, then open it for a player:

~~~ts
import { Gui, Item, ItemBuilder, Window } from "invui-bedrock";
import type { Player } from "@minecraft/server";

async function showMenu(player: Player) {
  const gui = Gui.normal({
    structure: ["    X    "],
    ingredients: {
      X: Item.simple(new ItemBuilder("minecraft:emerald")),
    },
  });

  const window = Window.builder()
    .setViewer(player)
    .setTitle("My Menu")
    .setUpperGui(gui)
    .build();

  await window.open();
}
~~~

The screen uses Minecraft's experimental `VirtualContainer` API. Item click handlers can be called with `window.handleClick(slot)`; the library does not automatically detect button clicks in the screen.

## Build

Requires Node.js 24 and `@minecraft/server@2.13.0-beta.1.26.70-preview.24`.

~~~bash
git clone https://github.com/kaaariyaaa/InvUI-for-Bedrock.git
cd InvUI-for-Bedrock
npm ci
npm run build
~~~

The package is private and not published to npm. Keep `@minecraft/server` external when bundling your add-on.

## Behavior Pack check

Inspect a Behavior Pack without changing its files:

~~~bash
node bin/cli.js init --behavior-pack ./behavior_pack
~~~

Use `--json` for machine-readable output.

## Documentation

- [API reference](docs/api.md): GUIs, items, windows, inventory, and state.
- [Feature status](docs/status.md): supported features and limitations.
- [Development](docs/development.md): build, packaging, and repository layout.

## License

[MIT](LICENSE).
