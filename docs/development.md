# Development

Instructions for building the repository and running its read-only inspection tooling. Review [Status and limitations](status.md) before attempting in-game use.

## Requirements

- **Node.js 24**, npm, and the dependencies in [`package.json`](../package.json). A previous build was checked with Node.js 24.22.1.
- For game experiments, Minecraft Bedrock Preview/Beta and the experimental Script API; no compatible game version has been verified.
- The development and peer dependency `@minecraft/server` is pinned to `2.13.0-beta.1.26.70-preview.24`.

The `@minecraft/server` npm dependency provides type declarations, not a standalone Minecraft runtime. Importing the core directly in Node.js without mocks fails; use the Minecraft runtime or a suitable mock environment.

## Build

```bash
npm ci
npm run build
npm pack --dry-run
```

`npm run build` compiles TypeScript from `src/` to ESM and declarations in `dist/`. The package currently has `private: true` and is not published. `npm pack` creates a local tarball suitable for installing into an add-on project; `prepack` builds first.

Keep `@minecraft/server` external when bundling the add-on:

```bash
npx esbuild src/main.ts \
  --bundle \
  --format=esm \
  --platform=neutral \
  --external:@minecraft/server \
  --outfile=behavior_pack/scripts/main.js
```

This command applies to an add-on project containing `src/main.ts`, not a file in this repository. Align the add-on `manifest.json` dependencies with Minecraft versions verified during testing.

## Optional Nix / direnv

The repository contains `flake.nix`, `flake.lock`, and `.envrc` for an optional Node 24 development environment.

```bash
direnv allow .
node --version
npm ci
```

Alternatively use `nix develop`, or an existing Node 24 installation without Nix.

## Behavior Pack inspection CLI

```bash
node bin/cli.js init --behavior-pack ./behavior_pack
node bin/cli.js init --behavior-pack ./behavior_pack --json
node bin/cli.js --help
node bin/cli.js --version
```

The CLI is **read-only**. It checks a Behavior Pack's `manifest.json`, script module and entry, and `@minecraft/server` dependency, then prints findings and manual checks. It does not create, modify, or install pack assets.

| Exit code | Meaning |
| --- | --- |
| `0` | Inspection completed; warnings may remain |
| `1` | Invalid arguments or inspection error |

## Repository layout

```text
InvUI-for-Bedrock/
├── src/                 # Core library and internal implementation
├── bin/cli.js           # Behavior Pack inspection
├── docs/
│   ├── api.md           # Public API reference
│   ├── status.md        # Current support and limitations
│   └── development.md   # Build and local tooling
├── .github/workflows/   # Build and package CI
├── package.json
├── tsconfig.json
├── flake.nix             # Optional Nix development shell
└── README.md
```

GitHub Actions runs `npm ci`, `npm run build`, and `npm pack --dry-run`. A successful build does not mean the game-facing behavior is verified.

## References

- [Public API reference](api.md)
- [Minecraft Creator Script API](https://learn.microsoft.com/minecraft/creator/scriptapi/)
- [InvUI for Java Edition](https://github.com/NichtStudioCode/InvUI)
