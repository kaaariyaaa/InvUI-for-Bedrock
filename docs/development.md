# 開発・ビルド

開発環境、ビルド、ローカルパッケージ化、CLI の説明です。実機での利用に関する制約は [実装状況と制約](status.md) を参照してください。

## 必要環境

- **Node.js 24.22.1**（`flake.nix` が提供する `nodejs_24`）
  - `.envrc` の `use flake` により、このリポジトリの direnv 環境は `flake.nix` の `nodejs_24` を提供します。その Node 24.22.1 で `npm run build` が成功することを確認済みです。
  - 初回、または `.envrc` を変更した後は、リポジトリのルートで `.envrc` を信頼してから作業します。

    ```bash
    direnv allow .
    node --version   # v24.22.1
    npm install
    ```

    `direnv allow .` を実行しないと `use flake` は評価されず、Node 24.22.1 は PATH に入りません。direnv を使わない場合は `nix develop` で同じシェルに入るか、Node.js 24.22.1 を直接用意してください。
- **Minecraft Bedrock Edition** の Preview/Beta と `@minecraft/server` Experimental（実機は未検証）
- **`@minecraft/server` の型は `2.13.0-beta.1.26.70-preview.24` に完全固定**（`devDependencies` / `peerDependencies` とも exact 指定）。`peerDependencies` は範囲ではなく exact です。
- **npm の `@minecraft/server` は型定義（`index.d.ts`）だけで、実行時 JS を含みません。** Node.js から直接 `import "@minecraft/server"` すると `ERR_MODULE_NOT_FOUND` になります。したがって Node.js 上でコアを直接読み込むには、`ItemStack` と `world.virtualContainerManager` などの最小モック（または同等のスタブ）が必須です。実機ではゲーム本体がこのモジュールを提供します。
- Minecraft 本体の対応バージョンは**未確定**です。`@minecraft/server` の型バージョンと、実際に動くゲーム版は別物なので、実機で確認した組み合わせだけを記録してください。

## 導入・ビルド

npm 未公開のため、現時点ではリポジトリを取得してビルドします。

```bash
npm install
npm run build   # tsc -p tsconfig.json -> dist/（ESM + .d.ts）
```

- ビルド成果物は `dist/index.js` と `dist/index.d.ts` です。`dist/` は git 管理外です。
- パッケージとして試す場合は `npm pack` で tarball を作り、アドオンのプロジェクトへローカル導入してください（`prepack` でビルドされます）。
- アドオンへ組み込むときは、`@minecraft/server` をバンドルに含めず外部化してください（`peerDependencies` として扱います）。例:

```bash
npx esbuild src/main.ts \
  --bundle \
  --format=esm \
  --platform=neutral \
  --external:@minecraft/server \
  --outfile=behavior_pack/scripts/main.js
```

- `manifest.json` の依存バージョンは、実際に確認したゲーム版・`@minecraft/server` 版に合わせてください。
- Node.js 上でコアを直接読み込むには、`@minecraft/server` のモック（`ItemStack`、`world.virtualContainerManager.create` など）が必要です。モックは実機の挙動を再現しないため、実機の画面表示・入力・アイテム保護の検証にはなりません。

## CLI（Behavior Pack の静的検査）

`init` は既存の Behavior Pack を静的に検査し、手動で必要な確認を表示する読み取り専用のコマンドです。パック内のファイルは変更しません。`package.json` の `bin` には登録されていますが、npm 未公開のため現時点ではリポジトリ内で直接実行します。

```bash
node bin/cli.js init --behavior-pack ./behavior_pack
```

| 指定 | 内容 |
|---|---|
| `init` | Behavior Pack を静的に検査し、手動で必要な作業を表示する。書き込まない |
| `--behavior-pack <dir>` | `init` 用。Behavior Pack のルート。必須 |
| `--json` | 検査結果を JSON として標準出力へ出す |
| `-h`, `--help` | 使い方を表示する |
| `-v`, `--version` | バージョンを表示する |

### CLI が行うこと

- `manifest.json` の存在と JSON としての読み込みを検査する。JSON として読めてもルートがオブジェクトでない（`null` や配列など）場合は検査エラーにする。
- script モジュール、`entry` の有無、`@minecraft/server` への dependency を確認する。
- 未検証機能と、手動で確認すべき手順を表示する。
- `--json` 指定時は、検査結果を JSON として標準出力へ出す。

### 終了コード

| コード | 意味 |
|---|---|
| `0` | 検査完了（警告のみを含む） |
| `1` | 引数エラー、検査エラー |

## リポジトリ構成

```text
InvUI-for-Bedrock/
├── src/               # TypeScript ソース
├── bin/               # Behavior Pack の静的検査 CLI
├── examples/          # 利用スケッチ（実機未検証）
├── docs/              # 実装・開発・設計ドキュメント
├── .github/workflows/ # CI
├── package.json       # npm 設定
├── tsconfig.json      # TypeScript 設定
├── flake.nix           # Nix 開発環境（任意）
└── README.md          # 概要
```

`dist/` は Git 管理外のビルド生成物です。Nix / direnv を使う場合は `flake.lock` と `.envrc` を利用できます。スケッチは [examples/README.md](../examples/README.md) を参照してください。

## 対応バージョン

| 対象 | バージョン | 状態 |
|---|---|---|
| ライブラリ | `0.1.0-beta.1` | npm 未公開 |
| `@minecraft/server`（型・開発時） | `2.13.0-beta.1.26.70-preview.24`（固定） | ビルドで使用 |
| `@minecraft/server`（peer） | `2.13.0-beta.1.26.70-preview.24`（exact） | 実機未検証 |
| Minecraft Bedrock Edition | 未確定 | 実機検証で確認した組み合わせのみ記録する |

CLI は manifest からゲーム版・Experimental の有効状態を確定できません。実機検証の記録欄に、実際に使用した版を残してください。

## ライセンス

MIT です。[LICENSE](../LICENSE) を参照してください。

## 参考

- [設計書](design.md)
- [Java版 InvUI](https://github.com/NichtStudioCode/InvUI)
- [Minecraft Creator ドキュメント（Script API）](https://learn.microsoft.com/minecraft/creator/scriptapi/)
