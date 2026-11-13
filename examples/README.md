# Examples

> [!WARNING]
> **このディレクトリのコードはビルド・実行の対象外です。**
>
> - スケッチ内の API は現行コアに存在しますが、このディレクトリは `tsconfig.json` の `include`（`src/**/*.ts`）にもテストにも含まれていません。`npm run build` / `npm test` はここをコンパイル・実行しません。
> - コア（レイアウト計算・アイテム・状態管理・Window のライフサイクル）は実装済みで Node.js 上でテストされていますが、**実機では一切検証していません**。
> - **`Window.open()` は既定の実アダプタでは常に拒否されます。** `minecraftVirtualContainerAdapter` は `canOpenScreens = false` を返すため、`open()` は Container の作成・表示より前に `WindowOpenRejectedError` で reject します。`open()` は `async` なので、呼び出し側で catch しないと未処理の Promise rejection になります。Resource Pack を置いても画面は開きません。
> - **ただし、この既定拒否は安全境界ではありません。** `WindowBuilder.setContainerAdapter()` は公開 API で、`canOpenScreens = true` を返し `openContainer()` を実装したアダプタを実機でも注入すれば画面は開きます。テスト用アダプタはテスト環境専用の保護ではなく、実機でもそのまま機能します。
> - **表示専用アイテムの保護はありません。** 画面を開くと、表示アイテムは実際の `VirtualContainer` に `setItem()` で書き込まれます。入力抑制も JSON UI もないためプレイヤーは表示アイテムを取り出せ、`refresh()` や状態更新の再描画で同じアイテムが再設定されるため、取り出しと再描画の組み合わせでアイテムが複製され得ます。
> - **実機で試す場合は、使い捨てワールドだけで行ってください。** 本番ワールドや配布用ワールドでは実行しないでください。アイテムの複製・消失を防ぐ仕組みは現行コアにありません。
> - クリック入力のブリッジ、アイテム保護、JSON UI テンプレート、`InventoryLink` のアイテム移動は実装していません。スケッチ内のクリック処理を動作する機能として前提にしないでください。
> - `VirtualContainer` は Bedrock Preview/Beta の Experimental API を前提とした設計です。

## 含まれるもの

| ファイル | 内容 |
|---|---|
| [usage-sketch.ts](usage-sketch.ts) | 宣言型（Options）と Builder の利用イメージ、Window の設定例 |

スケッチは次の設計書の節に対応します。

- 宣言型 / Builder: 設計書 5.1、5.2
- アイテムとクリック: 設計書 6.2
- Window と状態: 設計書 8.2、8.3、9.1〜9.3
- 未検証機能の扱い: 設計書 10.8、16.5、18.3

## 現行実装との差

スケッチの API 名は「予定」ではなく、現行の `dist/index.d.ts` に存在する名前です。ただし、次の点が実装とスケッチの前提からずれています。

| 項目 | 現行実装 | スケッチとの差 |
|---|---|---|
| `Gui` / `Structure` / `Markers` / `GuiLink` | 実装済み。Node.js のテストで確認済み | なし |
| `Item` / `ItemBuilder` / `Item.simple()` / `Item.builder()` / クリックハンドラー | 実装済み。ハンドラーは登録順に呼ばれる | 実機のクリックをハンドラーへ届ける仕組みはない。`Window.handleClick(slot)` を直接呼ぶ必要がある |
| `ClickContext` | `player`、`slot`、`window: unknown` | `window` は `Window` 型ではない |
| `Window` の設定・状態・`close()` | 実装済み | 画面を開く経路だけが既定拒否 |
| `Window.open()` | `async`。実アダプタでは常に `WindowOpenRejectedError` | スケッチは `await` / `catch` をしておらず、実行すると未処理 rejection になる |
| `WindowBuilder.setLowerGui()` | API 互換のため受け付けるが、下側領域へは描画しない | 下側 GUI を置き換えられる前提で読まない |
| `InventoryLink` の読み書き・購読 | 実装済み | なし |
| `InventoryLink.moveTo()` | 常に `InventoryLinkMoveRejectedError` | スケッチには移動処理を置いていない |
| JSON UI / Resource Pack | 未提供（未検証のため意図的に同梱しない） | 入力抑制・画面識別は動かない |

型レベルでは、このスケッチは現行の `dist` の公開型と大きく矛盾しません（手元の型検査では、`console` の型解決を除いて型エラーは出ませんでした）。ただし型が合うことと実機で動くことは別です。

## `Window.open()` の現状

`openShop()` が呼ぶ `window.open()` は、既定の実アダプタでは画面を開きません。

- 実アダプタ `minecraftVirtualContainerAdapter` の `canOpenScreens` は `false` 固定です。
- `open()` は Container を作る前に `WindowOpenRejectedError` で reject します。
- ただし `setContainerAdapter()` は公開 API です。`canOpenScreens = true` を返し `openContainer()` を実装したアダプタを渡せば、テストでも実機でも画面は開きます。既定拒否は「うっかり開かない」ための既定値であり、安全境界ではありません。
- 画面が開いた状態では、表示専用アイテムを取り出せます。取り出した後に `refresh()`（状態更新や購読による再描画）が走ると、同じアイテムが `setItem()` で再び書き込まれるため、複製が起こり得ます。
- 保護とクリック処理が実機未検証のため既定は変えませんが、既定を変えないこと自体は安全性の保証ではありません。

## 読み方

- スケッチは設計意図の確認用です。実装済み・動作確認済みという意味ではありません。
- クリックハンドラーや `InventoryLink` の利用例は、実機試験に合格するまで有効化しないでください。
- `setContainerAdapter()` で画面を開く実験は、使い捨てワールドでのみ行ってください。貴重なアイテムを持ち込まないでください。
- 実際に動かせる例は、実機検証済みのテストビルドが用意された後に別途追加します。その際も、未検証機能を「動作例」として提示しないようにしてください。

## 将来の実行可能な例に必要なもの

1. ビルド済みの `invui-bedrock`（ES Module と `.d.ts`）。
2. `@minecraft/server` を外部化したバンドル設定。
3. 対象ゲーム版に合う `manifest.json` と Resource Pack の扱い。
4. 実機テストで合格した範囲だけを使うサンプル。

現時点でこのディレクトリのスケッチは実行できません。実行可能な自動テストは `tests/` 配下にあります（CLI テストは次のコマンドで実行できます）。

```bash
node tests/manual-bedrock/cli.test.mjs
```
