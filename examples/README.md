# Examples

> [!WARNING]
> **このディレクトリのコードはビルド・実行の対象外です。**
>
> - スケッチ内の API は現行コアに存在しますが、このディレクトリは `tsconfig.json` の `include`（`src/**/*.ts`）にもテストにも含まれていません。`npm run build` / `npm test` はここをコンパイル・実行しません。型検査の前には `npm run build` でパッケージ本体の `dist` を作ってください（`examples/` をビルドするわけではありません）。
> - コア（レイアウト計算・アイテム・状態管理・Window のライフサイクル）は実装済みで Node.js 上でテストされていますが、**実機では一切検証していません**。
> - **`Window.open()` は既定の実アダプタで実画面を開きます（実機未検証）。** `minecraftVirtualContainerAdapter` は `canOpenScreens = true` を返し、`open()` は `VirtualContainer` を作成して `VirtualContainer.open()` を呼び、`close()` は `VirtualContainer.close()` を呼びます。実際に画面が表示されるか、close がいつ完了するかは未確認です。`close()` は要求時点で返るため、閉鎖直後の再 `open()` は失敗し得ます。`open()` は `async` なので、呼び出し側で catch しないと未処理の Promise rejection になります。
> - **クリック通知を生成する UI も、アイテム保護もありません。** `Window` は最初の `open()` で `world.beforeEvents.chatSend` を購読し、`!invui:<session-id>:<slot>:<sequence>` 行を `handleClick()` へ流します（Node.js テスト済み・実機未検証）。session-id は open ごとに作り直される `Window._inputSessionId`（公開 getter）で、`Window.id` の `window-N` ではありません。ただし `resource_pack/` はこの行を生成せず、行はプレイヤーが手入力できるため偽装可能です。`Item` の `button` 分類はハンドラー実行ガードにすぎません。画面のアイテムはそのまま取り出せます。
> - **取り出し後の再描画で複製・消失が起こり得ます。** 表示アイテムは実際の `VirtualContainer` に `setItem()` で書き込まれます。プレイヤーが取り出した後に `refresh()`・状態更新・要素の更新通知で再描画が走ると、同じアイテムが書き戻されて複製され得ます。逆に、プレイヤーが入れたアイテムを再描画が上書きすると消失し得ます（実機未検証）。
> - **実機で試す場合は、使い捨てワールドだけで行ってください。** 本番ワールドや配布用ワールドでは実行しないでください。アイテムの複製・消失を防ぐ仕組みは現行コアにありません。
> - チャット通知を受けて `handleClick()` を呼ぶ経路だけは既定で接続されますが、通知を生成する UI 側は未実装で、実機未検証です。アイテム保護、`InventoryLink` のアイテム移動は実装していません。JSON UI は未検証の隔離テンプレート（`resource_pack/`）を同梱するだけで、チェスト画面へは接続していません。スケッチ内のクリック処理を動作する機能として前提にしないでください。
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

`buyButton` は `Gui.paged({ content })` と `GuiBuilder.setContent()` の両方に含めてあります。ボタンがコンテンツ領域のスロットに並ぶ前提の例ですが、クリック通知は UI 側が生成せず実機未検証のため、これは動作確認済みの例ではありません。

## 現行実装との差

スケッチの API 名は「予定」ではなく、現行の `dist/index.d.ts` に存在する名前です。ただし、次の点が実装とスケッチの前提からずれています。

| 項目 | 現行実装 | スケッチとの差 |
|---|---|---|
| `Gui` / `Structure` / `Markers` / `GuiLink` | 実装済み。Node.js のテストで確認済み | なし |
| `Item` / `ItemBuilder` / `Item.simple()` / `Item.builder()` / クリックハンドラー | 実装済み。ハンドラーは登録順に呼ばれる | 自動接続の chatSend 通知から `handleClick()` へ届くが、通知を生成する UI は未実装で、手入力偽装・実機未検証が残る。それ以外は `Window.handleClick(slot)` を直接呼ぶ |
| `ClickContext` | `player`、`slot`、`window: unknown` | `window` は `Window` 型ではない |
| `Window` の設定・状態・`close()` | 実装済み | 画面を開く経路が既定で有効（実機未検証） |
| `Window.open()` | `async`。既定の実アダプタで `VirtualContainer.open()` を呼ぶ（実機未検証） | スケッチは `await` して `try` / `catch` で受け、未処理 rejection を残さない。実機で表示されるかは未確認 |
| `WindowBuilder.setLowerGui()` | API 互換のため受け付けるが、下側領域へは描画しない | 下側 GUI を置き換えられる前提で読まない |
| `InventoryLink` の読み書き・購読 | 実装済み | なし |
| `InventoryLink.moveTo()` | 常に `InventoryLinkMoveRejectedError` | スケッチには移動処理を置いていない |
| JSON UI / Resource Pack | パッケージには未検証の隔離テンプレート（`resource_pack/`）を同梱するが、チェスト画面へは未接続。`!invui:` 通知を生成する部品もない | スケッチはこれらを前提にしない。入力抑制・画面識別は動かず、クリック通知も生成されない |

型レベルでは、このスケッチは現行の `dist` の公開型と矛盾しません。`examples/` は `tsconfig.json` の対象外なので、**先に `npm run build` を実行して `dist`（`dist/index.d.ts` を含む）を作成**し、そのうえでスケッチ専用の一時設定をリポジトリ直下に置いて型検査します。`npm run build` が作るのはパッケージ本体であり、`examples/` をコンパイルするものではありません。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "paths": { "invui-bedrock": ["./dist/index.d.ts"] },
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "files": ["examples/usage-sketch.ts"]
}
```

```bash
npx tsc -p tsconfig.examples-check.tmp.json
```

`src` を直接検査する場合は `paths` を `./src/index.ts` に変えます。型が合うことと実機で動くことは別です。

## `Window.open()` の現状

`openShop()` が呼ぶ `window.open()` は、既定の実アダプタで実画面を開こうとします。ただし実機未検証で、保護もありません。

- 実アダプタ `minecraftVirtualContainerAdapter` の `canOpenScreens` は `true` です。
- `Window.builder().build()` は `Window` オブジェクトを作成し、`status` は `"created"` になります。`open()` は状態を取得し、`VirtualContainer` を作成して全スロットを描画したうえで `VirtualContainer.open()` を呼びます。実機で画面が表示されるかは未確認です。
- `close()` は `VirtualContainer.close()` を呼びます。close は「要求した」時点で返り、実際の close イベントは別 tick になることがあるため、直後に同じプレイヤーへ `open()` し直すと失敗し得ます。
- `open()` は Container の作成・描画・open のどこで失敗しても reject し、エラーハンドラーにも報告します。スケッチの `openShop()` は `await window.open()` を `try` / `catch` で囲み、未処理 rejection にはなりません。
- 画面が開いた状態では、表示専用アイテムをプレイヤーが取り出せます（実機未検証）。取り出した後に `refresh()`（状態更新や購読による再描画）が走ると、同じアイテムが `setItem()` で再び書き込まれるため、複製が起こり得ます。逆にプレイヤーが入れたアイテムが上書きされて消失し得ます。
- 既定では `window.open()` した Window が `world.beforeEvents.chatSend` を購読し、`!invui:` 行を `handleClick()` へ流します（Node.js テスト済み・実機未検証）。ただし UI 側がその行を生成する実装はなく、行は手入力で偽装でき、入力抑制・アイテム保護もありません。ボタン押下が通知を生むかは未検証で、この経路を安全な機能として扱わないでください。
- 退出時は、最初の `open()` で購読した `world.afterEvents.playerLeave` が退出したプレイヤーの Window（`opening` / `open`）を `PlayerLeft` で close します（Node.js テスト済み・実機未検証）。自動再オープンはしません。
- 死亡時も、同じ `open()` で購読した `world.afterEvents.entityDie` が、死亡した entity の id が viewer id と一致する Window だけを `PlayerDied` で close します（Node.js テスト済み・実機未検証）。プレイヤー以外や他プレイヤーの死亡は無視し、アダプタには close を要求しません。自動再オープンはしません。shutdown・スクリプト再読み込み時の後始末は未実装です。

## 読み方

- スケッチは設計意図の確認用です。実装済み・動作確認済みという意味ではありません。
- クリックハンドラーや `InventoryLink` の利用例は、実機試験に合格するまで有効化しないでください。
- 画面を開く実験は、使い捨てワールドでのみ行ってください。貴重なアイテムを持ち込まないでください。表示アイテムの取り出しと再描画による複製・消失リスクがあります。
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
