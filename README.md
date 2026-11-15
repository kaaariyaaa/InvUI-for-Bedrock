# InvUI for Bedrock

A TypeScript GUI library for Minecraft Bedrock Edition Script API, based on the design and public API of [InvUI for Java Edition](https://github.com/NichtStudioCode/InvUI).

> [!WARNING]
> **Beta — not tested in Minecraft.**
>
> Version `0.1.0-beta.1` is not published to npm. This library uses the experimental `VirtualContainer` API in Minecraft Bedrock Preview/Beta. `Window.open()` attempts to open a real screen, but the game-side behavior has not been verified.
>
> No bundled UI generates click notifications, and JSON UI integration is not provided. Item changes are restored only *after* they occur, which can cause item duplication or loss. **Only use disposable test worlds. Do not use this library in production worlds.**

## Features

- Normal, paged, scrolling, and tabbed layouts with `Structure` and `Gui`
- Item providers, display metadata, and click handlers with `Item` and `ItemBuilder`
- Window lifecycle, state-aware rendering, and GUI replacement
- Player-specific or shared state, with optional persistence and migrations
- In-memory inventories and read-only player inventory access

The layout and state-management core has been checked using Node.js mocks, **not on a Minecraft client**. `InventoryLink.moveTo()` is not implemented.

## Build

Requires **Node.js 24** and the pinned `@minecraft/server@2.13.0-beta.1.26.70-preview.24` development/peer dependency.

```bash
git clone https://github.com/kaaariyaaa/InvUI-for-Bedrock.git
cd InvUI-for-Bedrock
npm ci
npm run build
```

The build generates ESM JavaScript and TypeScript declarations in `dist/`. The package is currently private and unpublished. You can use `npm pack` to create a local archive for an add-on project. Keep `@minecraft/server` external when bundling.

## Basic API

This example constructs a layout; it does not demonstrate a tested in-game screen.

```ts
import { Gui, Item, ItemBuilder } from "invui-bedrock";

const gui = Gui.normal({
  structure: ["#########"],
  ingredients: {
    "#": Item.simple(new ItemBuilder("minecraft:stone")),
  },
});
```

See the [API reference](docs/api.md) for the public classes, types, builders, and method signatures.

## Behavior Pack inspection

The bundled CLI inspects an existing Behavior Pack **without modifying files**:

```bash
node bin/cli.js init --behavior-pack ./behavior_pack
```

It also accepts `--json`, `--help`, and `--version`.

## Documentation

- [API reference](docs/api.md) — public API and usage
- [Status and limitations](docs/status.md) — implemented functionality, missing pieces, and risks
- [Development](docs/development.md) — local setup, packaging, and CLI

## License

[MIT](LICENSE).
