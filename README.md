# InvUI for Bedrock

A TypeScript GUI library for Minecraft Bedrock Edition Script API, based on [InvUI for Java Edition](https://github.com/NichtStudioCode/InvUI).

> [!CAUTION]
> The experimental `VirtualContainer` API restores item changes after they occur. Item duplication or loss is possible. Use disposable worlds for testing.

## Features

- Normal, paged, scrolling, and tabbed GUIs
- Item providers, buttons, and update handlers
- Windows, state management, and optional persistence
- Virtual inventories and read-only player inventories

`InventoryLink.moveTo()` is not implemented.

## Build

Requires Node.js 24 and `@minecraft/server@2.13.0-beta.1.26.70-preview.24`.

```bash
git clone https://github.com/kaaariyaaa/InvUI-for-Bedrock.git
cd InvUI-for-Bedrock
npm ci
npm run build
```

The package is currently private and unpublished. `npm pack` creates a local archive. Keep `@minecraft/server` external when bundling an add-on.

## Example

```ts
import { Gui, Item, ItemBuilder } from "invui-bedrock";

const gui = Gui.normal({
  structure: ["#########"],
  ingredients: {
    "#": Item.simple(new ItemBuilder("minecraft:stone")),
  },
});
```

## CLI

Read-only Behavior Pack inspection:

```bash
node bin/cli.js init --behavior-pack ./behavior_pack
```

Options: `--json`, `--help`, `--version`.

## Documentation

- [API reference](docs/api.md)
- [Status and limitations](docs/status.md)
- [Development](docs/development.md)

## License

[MIT](LICENSE).
