# Development

## Requirements

- Node.js 24 and npm
- `@minecraft/server@2.13.0-beta.1.26.70-preview.24`

The Minecraft package supplies API declarations; running the library in Node.js requires mocks.

## Build and package

~~~bash
npm ci
npm run build
npm pack --dry-run
~~~

`npm run build` compiles ESM JavaScript and type declarations into `dist/`. The package is private and unpublished.

When bundling the library into a Behavior Pack, leave `@minecraft/server` external to the bundle. For example, in an add-on project with `src/main.ts`:

~~~bash
npx esbuild src/main.ts --bundle --format=esm --platform=neutral \
  --external:@minecraft/server --outfile=behavior_pack/scripts/main.js
~~~

## Behavior Pack inspector

~~~bash
node bin/cli.js init --behavior-pack ./behavior_pack
node bin/cli.js init --behavior-pack ./behavior_pack --json
~~~

The CLI reads `manifest.json`, checks the script entry and Script API dependency, and does not modify files. Use `--help` to view its options.

## Source layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Public exports |
| `src/item.ts` | Items and button callbacks |
| `src/gui/` | GUI definitions and layout resolution |
| `src/window/` | Windows, rendering, events, and item protection |
| `src/state/` | State, persistence, and JSON helpers |
| `src/inventory/` | Virtual and player inventory APIs |
| `src/render/` | Rendering cache and scheduling |
| `bin/` | Behavior Pack CLI |

Optional development environments: `nix develop` or `direnv allow .`.

[API reference](api.md) · [Minecraft Script API](https://learn.microsoft.com/minecraft/creator/scriptapi/)
