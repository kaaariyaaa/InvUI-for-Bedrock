# Development

## Requirements

- Node.js 24 and npm
- `@minecraft/server@2.13.0-beta.1.26.70-preview.24` (pinned dependency)
- Minecraft Bedrock Preview/Beta for experiments with the experimental API

The `@minecraft/server` npm package provides declarations only. Node.js execution requires mocks.

## Build

```bash
npm ci
npm run build
npm pack --dry-run
```

`dist/` contains the generated ESM and declarations. The package is private and unpublished; `npm pack` creates a local archive.

Externalize `@minecraft/server` when bundling an add-on:

```bash
npx esbuild src/main.ts --bundle --format=esm --platform=neutral \
  --external:@minecraft/server --outfile=behavior_pack/scripts/main.js
```

This command runs in an add-on project with `src/main.ts`.

## Optional Nix environment

Use `direnv allow .` with `.envrc`, or `nix develop`. Node.js 24 also works without Nix.

## Behavior Pack CLI

```bash
node bin/cli.js init --behavior-pack ./behavior_pack
node bin/cli.js init --behavior-pack ./behavior_pack --json
```

The CLI checks `manifest.json`, the script entry, and the Script API dependency without writing files. `--help` and `--version` are available. Exit code `0` means inspection completed; `1` indicates an error.

## Repository

- `src/`: library
- `bin/`: CLI
- `docs/`: API, status, and development documentation
- `.github/workflows/`: build and package checks

[API reference](api.md) · [Minecraft Creator Script API](https://learn.microsoft.com/minecraft/creator/scriptapi/)
