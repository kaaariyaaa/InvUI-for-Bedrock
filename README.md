# InvUI for Bedrock

Java版 [InvUI](https://github.com/NichtStudioCode/InvUI) の設計と公開 API を参考にした、Minecraft Bedrock Edition Script API 向けの TypeScript GUI ライブラリです。

> [!WARNING]
> **ベータ版・実機未検証**
>
> バージョンは `0.1.0-beta.1` で、npm には未公開です。画面表示には Bedrock Preview/Beta の Experimental API `VirtualContainer` を使用します。
>
> `Window.open()` は既定で実画面を開こうとしますが、Minecraft 実機では未検証です。クリック通知を自動生成する UI や JSON UI 連携はありません。アイテムの取り出しは事後復元のみのため、**複製・消失の危険があります**。実機で試す場合は使い捨てワールドだけを使用してください。

## 機能

- `Structure`、`Gui` による通常・ページ・スクロール・タブ形式のレイアウト
- `Item` / `ItemBuilder` による表示要素とクリックハンドラーの定義
- `Window` の画面管理、GUI の差し替え、状態に応じた表示更新
- `StateManager` によるプレイヤー別・共有状態と任意の永続化
- `VirtualInventory` と読み取り専用の `PlayerInventory`

コアの計算・状態管理は Node.js 上のモック環境で確認しています。ゲーム内での動作は別途検証が必要です。`InventoryLink.moveTo()` は未実装で、アイテム移動はできません。詳しくは [実装状況と制約](docs/status.md) を参照してください。

## 導入とビルド

必要環境は **Node.js 24** と `@minecraft/server@2.13.0-beta.1.26.70-preview.24`（開発・peer 依存の固定バージョン）です。Minecraft 本体の対応バージョンは実機未確認です。

npm に未公開のため、現在はソースを取得してビルドします。

```bash
git clone https://github.com/kaaariyaaa/InvUI-for-Bedrock.git
cd InvUI-for-Bedrock
npm ci
npm run build
```

`dist/` に ESM と TypeScript の型定義を生成します。ローカルパッケージとして使う場合は `npm pack` で tarball を作成し、アドオン側で導入してください。`@minecraft/server` はアドオンのバンドルから外部化する必要があります。

## API の例

次は GUI のレイアウトを作る例です。ゲーム内での画面表示やクリック動作を保証する例ではありません。

```ts
import { Gui, Item, ItemBuilder } from "invui-bedrock";

const gui = Gui.normal({
  structure: ["#########"],
  ingredients: {
    "#": Item.simple(new ItemBuilder("minecraft:stone")),
  },
});
```

`Window` を使う例は [examples/usage-sketch.ts](examples/usage-sketch.ts) にあります。スケッチはビルド・実機テストの対象外です。

## CLI

`bin/cli.js` の `init` は Behavior Pack の設定を**読み取り専用で検査**します。ファイルを生成・修正しません。

```bash
node bin/cli.js init --behavior-pack ./behavior_pack
```

`--json`、`--help`、`--version` にも対応しています。

## ドキュメント

- [実装状況と制約](docs/status.md) — 実装済みの機能、未完成点、実機検証
- [実装の詳細](docs/implementation.md) — 差分描画、状態管理、インベントリ
- [開発・ビルド](docs/development.md) — 開発環境、パッケージ化、CLI
- [全体設計書](docs/design.md) — 設計方針と今後の検証対象
- [利用スケッチ](examples/README.md) — 公開 API を使った例と注意点

## ライセンス

MIT。詳細は [LICENSE](LICENSE) を参照してください。
