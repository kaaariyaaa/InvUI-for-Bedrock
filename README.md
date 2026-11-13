# InvUI for Bedrock

Java版 [InvUI](https://github.com/NichtStudioCode/InvUI) の設計と公開 API をできるだけ維持した、Minecraft Bedrock Edition 向け GUI ライブラリです。

> [!WARNING]
> **ベータ / 実機未検証**
>
> - バージョンは `0.1.0-beta.1`。**npm には未公開**です。`npm install invui-bedrock` はまだ使えません。
> - **実機では一切検証していません。** ライブラリ経由の実機画面表示は既定ではすべて拒否され、実機ライフサイクル（close・死亡・退出・shutdown）と入力ブリッジは未実装です。クリック通知、アイテム保護、JSON UI 連携、`InventoryLink` のアイテム移動も未実装または未検証です。`WindowContainerAdapter` には close / itemChange の任意購読フック（`subscribeClose` / `subscribeItemChange`）がありますが、これは Node.js のテスト用モック向けに追加されたもので、既定の `minecraftVirtualContainerAdapter` は購読を実装しておらず、実機イベントとは接続していません。
> - **`Window.open()` は既定で拒否されますが、これは強制された安全境界ではありません。** 画面のアイテム保護とクリック処理が実機未検証のため、実アダプタ（`minecraftVirtualContainerAdapter`）は `canOpenScreens = false` を返し、`open()` は `WindowOpenRejectedError` を投げます。Container の作成・表示より前に拒否されます。`openContainer()` / `closeContainer()` も同じ例外を投げます。ただし公開 API の `WindowBuilder.setContainerAdapter()` に `canOpenScreens = true` を返すアダプタを渡せば、この既定拒否は迂回できます。実画面を開くと、保護未検証の表示アイテムを取り出して再描画させることで消失・複製事故につながる恐れがあります。実験は「[実機画面を開く実験は使い捨てワールドで](#実機画面を開く実験は使い捨てワールドで)」の条件でのみ行ってください。
> - コア（レイアウト計算、アイテム表現、状態管理、Window の状態遷移）は実装・Node.js テスト済みです。**状態更新時の描画はスロット差分ではなく全スロット再評価、周期更新は Item を表示中の Window がある間のみ、永続ストアは手動 migration API までで自動移行・破損復旧は未実装**です。クリック入力を実機イベントへつなぐ仕組みと JSON UI の画面接続は未実装です。`resource_pack/` には未検証の隔離テンプレートだけを同梱し、チェスト画面には接続していません。
> - この README は、実装済みの範囲と未完成・未検証の機能を区別して記載します。未検証の機能を「完成・動作確認済み」として扱わないでください。

## 現在の状態

| 項目 | 状態 |
|---|---|
| コア（`src/`） | **実装済み（実機非依存の範囲）**。`Structure` / `Gui`（normal・paged・scroll・tab）/ `GuiLink` / `Item` / `VirtualInventory` / `StateManager` / `Window`。ただし「[コアの未完成点](#コアの未完成点実コードで確認)」に挙げた項目は未完成 |
| 公開エントリ（`src/index.ts`） | コアの公開型に加え、`BedrockWorldStateStore` / `BedrockStoreError` / `BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH` / `BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH` と migration 型を公開。`periodic.ts` のスケジューラは内部用で公開しない |
| ビルド（`npm run build`） | 成功する（Node.js 24.22.1 で確認）。TypeScript で `dist/` に ESM と `.d.ts` を出力 |
| 自動テスト（`npm test`） | 成功する（Node.js 24.22.1 で確認）。Node.js のユニットテスト、周期更新、Bedrock ストア、CLI の安全側テスト、phase0 プローブの静的検査、パッケージ境界の検査。件数はテスト追加で変わるため固定値としては記載しない |
| CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)） | GitHub Actions で `npm ci` / `npm run build` / `npm test` / `npm pack --dry-run` を実行 |
| 実機テスト | **未実施** |
| 実機画面の表示 | **既定では全拒否**。実アダプタは `canOpenScreens = false` で、`Window.open()` は Container 作成前に `WindowOpenRejectedError`。ただし `setContainerAdapter()` による迂回が可能（強制境界ではない） |
| 実機ライフサイクル（close・死亡・退出・shutdown・再読み込み） | **未実装（既定アダプタ）**。`Window` はアダプタの任意フック `subscribeClose` / `subscribeItemChange` に接続するが、これは Node.js テスト用モック向けで、既定の `minecraftVirtualContainerAdapter` は購読を実装していない。`world.afterEvents.virtualContainerClose` 等の実機イベントは購読していない |
| 入力ブリッジ | **未実装**。JSON UI の画面接続もない |
| クリック通知・アイテム保護・JSON UI 連携 | **未実装**。itemChange 検出時の危険通知・再描画停止・close 要求は `Window` にあるが、保護でもクリック処理でもない |
| 差分描画 | **スロット単位の差分なし**。状態更新と明示 `refresh()` は全スロットを再評価・再描画する。要素の更新通知だけが該当スロットを再描画する。理由と限界は「[差分描画の限界](#差分描画の限界状態更新)」を参照 |
| 周期更新（`updatePeriodically()`） | **実装済み（Node.js テスト済み、実機未検証）**。Item を表示している開いた Window がある間だけ `system.runInterval()` で実行し、最後の購読解除または `close()` で停止する |
| 永続ストアの schema migration | **手動 API のみ**。`StateManager.migrate()` で、宣言した旧 version/schema に一致するレコードだけを明示的に書き換える。`acquire()` は不一致を自動移行せず拒否する。migration のコールバックと書き込みの実行中は、同一 identity の `acquire()` / `migrate()` を `LIVE_STATE` で拒否する |
| 永続ストアの破損復旧 | **未実装**。壊れた JSON や不正な `guiState` は `StateCorruptionError` で失敗し、レコードを退避・削除・復旧しない |
| Bedrock 用 `StateStore` | **実装済み（Node.js テスト済み、実機未検証）**。`BedrockWorldStateStore` がワールドの動的プロパティに保存する。非文字列、識別子の長さ超過、UTF-8 換算の値サイズ超過を保存前に拒否する |
| `InventoryLink` のアイテム移動 | **無効固定**。`moveTo()` は常に `InventoryLinkMoveRejectedError` を投げる |
| `Window.open()` | **既定拒否**。`WindowOpenRejectedError` を投げる |
| 配布補助 CLI（[bin/cli.js](bin/cli.js)） | 実装済み。既定は読み取り専用の静的検査。`--install-resource-pack` を明示した場合だけ `ui/invui.json` を追加する |
| CLI の自動テスト（[cli.test.mjs](tests/manual-bedrock/cli.test.mjs)） | 実行可能（`npm test` に含まれる） |
| 実機テスト手順（[tests/manual-bedrock/README.md](tests/manual-bedrock/README.md)） | あり |
| 合否チェックリスト（[CHECKLIST.md](tests/manual-bedrock/CHECKLIST.md)） | あり |
| 利用イメージ（[examples/README.md](examples/README.md)） | 設計スケッチのみ。型検査は可能、実行は対象外 |
| 全体設計（[設計書](InvUI_for_Bedrock_Design.md)） | あり（バージョン 1.2） |
| JSON UI テンプレート（`resource_pack/`） | **未検証の隔離プローブのみ**。単体 Resource Pack として `manifest.json` と `ui/_ui_defs.json`（`ui/invui.json` 登録済み）を同梱する。`invui_probe` 名前空間に可視ラベルと実験的な `button.send` 部品を定義するが、どの画面からも参照せず、チェスト画面へ接続していない。CLI の導入対象は `ui/invui.json` だけ |
| npm 公開 | 未実施 |
| ライセンス | 未設定 |

## コアの実装範囲（実機非依存）

実機に依存しない範囲は実装され、Node.js 上で `@minecraft/server` をモックしてテストされています。Bedrock 実機での動作を保証するものではありません。

- **レイアウト**: `Structure`（最大 9×6、Unicode 1 コードポイント = 1 スロット）、`Gui.normal()` / `Gui.paged()` / `Gui.scroll()` / `Gui.tab()`、`PagedGui.itemsBuilder()`（Java版互換の別名）、`Markers.CONTENT_LIST_SLOT_HORIZONTAL` / `VERTICAL`、`GuiLink` による子 GUI の投影。ページ・行・タブは `GuiState` として外から渡し、GUI インスタンス自身は状態を持ちません。
- **アイテム**: `Item`、`ItemBuilder`、`Item.simple()`、`Item.builder()`、クリックハンドラーの登録と呼び出し順序。`updatePeriodically(ticks)` は、その Item を表示している開いた Window が 1 つ以上ある間だけ `system.runInterval()` に登録し、最後の Window が閉じるか購読を解除すると `clearRun()` で停止します。1 Item につき 1 インターバルで、再購読すると周期の位相はリセットされます。スケジューラの登録失敗は `console.error` に記録され、Item は明示更新では引き続き描画されます。クリックを実機イベントから届ける仕組み（InputBridge / JSON UI）は未実装です。
- **インベントリ**: メモリ上の `VirtualInventory`（`Inventory` インターフェース実装）。`InventoryLink` はリンク先スロットの読み書きと購読のみ提供し、**別インベントリへの移動は実装していません**。
- **状態**: `StateManager`。`player` / `shared` のスコープ、`window` / `session` / `persistent` の保存期間、スキーマ不一致の拒否。永続化には注入した `StateStore` が必要です。**`StateManager.migrate()` による明示的な移行は実装済み**ですが、`acquire()` が旧 version/schema を自動変換することはありません。破損レコードの退避・復旧と `StateManager` からの削除は未実装で、破損時は `StateCorruptionError` を投げてレコードを残します。Bedrock 用には `BedrockWorldStateStore`（ワールドの動的プロパティを使用）を公開しています。
- **Window**: `Window.builder()` の設定、状態の取得・更新、`close()`、クリックのルーティング（`Window.handleClick()`）まで。状態更新・GUI 変更・明示 `refresh()` は全スロットを再評価して描画し、要素の更新通知だけが該当スロットを再描画します。**画面を開く経路は未検証のため既定で拒否されます。** アダプタが任意フック `subscribeClose` / `subscribeItemChange` を実装していれば、`Window` は open 前に購読し、close イベントを close ハンドラーへ、itemChange を `WindowItemChangeDangerError` の通知・再描画停止・`close()` 要求として扱います。ただしこれは Node.js モック向けの接続で、既定の `minecraftVirtualContainerAdapter` は購読を実装しておらず、`close(reason)` の `reason` は呼び出し側が渡す値です。itemChange はクリックではなく、変更されたアイテムを復元する保護でもありません。死亡・退出・shutdown・スクリプト再読み込み時の後始末や再オープンは実装していません。GUI の構造変更（種別・Structure 行・スクロール設定・タブ・`GuiLink` の子 GUI）で state schema が合わなくなった場合、`Window` はエラーハンドラーへ `WindowStateSchemaChangedError`（`INVUI_STATE_SCHEMA_CHANGED`）を報告し、再描画を停止して close します。同じ通知中に走った `setState()` は同じエラーで拒否され、以後の `setState()` は開いていない Window として失敗します。内容変更（`setContent`）は schema を変えないため、通常どおり描画だけ更新します。close が実機で成功するかは未検証です。

## コアの未完成点（実コードで確認）

「コア実装済み」は実機非依存の計算・状態遷移までを指します。次の項目は未完成、または実装済みでも制約・実機未検証が残ります。

- **実機画面**: 実アダプタは `canOpenScreens = false` を返すため、`Window.open()` は状態取得・Container 作成より前に `WindowOpenRejectedError` で失敗します。`openContainer()` / `closeContainer()` も例外を投げます。既定の経路で実機画面は表示されませんが、`setContainerAdapter()` に任意のアダプタを渡せるため、これは強制された安全境界ではありません。
- **実機ライフサイクル**: `world.afterEvents.virtualContainerClose` / `virtualContainerItemChange` / `system.beforeEvents.shutdown` などを購読していません。`WindowContainerAdapter` の任意フック `subscribeClose` / `subscribeItemChange` には `Window` が接続しますが、これは Node.js テスト用モックで経路を確認するためのもので、既定の `minecraftVirtualContainerAdapter` はフックを実装していません。`Window` の `status` 遷移、状態ハンドルの解放、`close()` の明示呼び出しはありますが、ゲーム側の close・死亡・退出・shutdown・再読み込みに接続していません。
- **入力**: `Window.handleClick(slot)` は呼び出し側が論理スロットを直接渡す API です。Bedrock のイベントからスロットを特定して呼ぶ経路（InputBridge / JSON UI / `button.send`）はなく、左右・Shift・ダブルクリックの区別もありません。
- **差分描画**: 状態更新と明示 `refresh()` は、要素参照が変わっていなくても全スロットの provider を再評価して `setItem()` します。Item の provider が状態に依存して同じ Item でも別の表示を返す場合があること、Bedrock の `ItemStack` を全 component まで比較して同値判定することを避けたためです。要素の更新通知だけが該当スロットを再描画します。詳細と限界は「[差分描画の限界](#差分描画の限界状態更新)」を参照してください。レイアウトサイズが変わった場合、表示中の Window は再オープンが必要で、`refresh()` はエラーを報告するだけです。
- **周期更新**: `Item.updatePeriodically()` は実装済みですが、実機未検証です。Bedrock の `system.runInterval()` に接続するのは、その Item を表示している開いた Window がある間だけで、Window を開く前や最後の Window を閉じた後は実行されません。1 Item につき 1 インターバルで、購読の張り替えで周期の位相がリセットされます。スケジューラの登録に失敗した場合は `console.error` に記録され、自動の再試行はありません。
- **永続ストア**: `StateManager` は注入された同期 `StateStore` に JSON を読み書きします。`STATE_STORAGE_VERSION` と schema の不一致は `StateConflictError`、壊れた JSON や不正な `guiState` は `StateCorruptionError` で失敗し、レコードは変更しません。**`StateManager.migrate()` による明示的な移行は実装済み**ですが、`acquire()` が旧 version/schema を自動変換することはありません。破損レコードを退避して復旧する処理、`StateManager` からレコードを削除する処理は実装していません。外部 `StateStore` の `setItem()` が途中で失敗して部分的な書き込みが残っても、`StateManager` はそれを検出・修復しません（ストア実装の原子性に依存します）。Window の schema は GUI 種別・Structure 行・スクロール設定・タブと `GuiLink` の子 GUI を再帰的に含む識別子で、循環参照は拒否されます。

## 差分描画の限界（状態更新）

状態更新時に「変わったスロットだけ」を描く最適化はしていません。`setState()`、GUI の内容変更、明示 `refresh()` は、要素の参照が同じでも全スロットの provider を再評価して描画します。

- **理由**: Item の provider は `GuiState` を読んで表示を変えられます。スロットの要素インスタンスが同じでも、状態が変われば provider の戻り値も変わります。また Bedrock の `ItemStack` は component や lore を含み、全項目の同値比較を安全に行えません。要素参照や ItemStack の値で差分を取ると、古い表示を残す可能性があります。
- **コスト**: 状態を 1 回変えるたびに、表示スロット数ぶんの provider 呼び出しと `container.setItem()` が走ります。provider は全スロット分を同期的に開始して並列に解決するため、1 つの遅い provider が他の開始をブロックすることはありませんが、そのバッチ全体の完了は待ちます。高頻度の状態更新は負荷になります。
- **古い非同期結果**: 状態変更・GUI 変更・新しい描画バッチのたびに render epoch を進め、スロットごとの token と generation も検査します。変更前に開始した provider の結果は、後から解決しても書き込まれません。
- **要素の更新通知**: `Item.notifyWindows()` や `InventoryLink` の変更通知は、購読しているスロットだけを再描画します。レイアウト変更時は新しいレイアウトに購読を張り替えてから描画するため、移動先のスロットへ通知が届きます。
- **レイアウトサイズの変更**: 表示中の Window では `refresh()` がエラーを報告するだけで、サイズは変わりません。再オープンが必要です。`open()` の解決中にサイズが変わった場合は、画面を表示する前に Container を作り直します。

## 永続状態の移行と Bedrock ストア（任意）

永続状態を使う場合、`StateManager` に同期の `StateStore` を注入します。Bedrock 用の `BedrockWorldStateStore` は、ワールドの動的プロパティを 1 レコード 1 プロパティとして使います。どちらも `src/index.ts` から公開されています。

```ts
import { world } from "@minecraft/server";
import { BedrockWorldStateStore, StateManager } from "invui-bedrock";

const states = new StateManager(new BedrockWorldStateStore(world));

states.migrate(
  {
    ownerId: player.id,
    key: "shop",
    // 対象レコードの保存値に合わせる。旧形式の schema なしレコードは null。
    fromVersion: 0,
    fromSchema: null,
    schema: "shop-v2",
  },
  (legacy) => {
    const old = legacy as { guiState?: { pageNo?: number } };
    return { page: old.guiState?.pageNo ?? 0 };
  },
);
```

`StateManager.migrate(options, migrate)` の前提と制約:

- 注入した `StateStore` が必要です。対象は永続化済みレコードだけで、存在しなければ `MISSING_STATE` で失敗します。
- `fromVersion` / `fromSchema` / `schema` は必須です。`fromVersion` と `fromSchema` は保存済みレコードの version/schema と完全一致しなければ `VERSION_MISMATCH` / `SCHEMA_MISMATCH` で拒否され、`schema` は移行後のレコードに記録されます。すでに現在の version/schema と同じ組み合わせは「移行不要」として拒否されます。`fromSchema: null` は schema を持たない古い形式を表します。
- `acquire()` の前、または同じ identity のハンドルをすべて `release()` した後に呼びます。表示中の状態や、`persistent` 以外で登録中の identity は `LIVE_STATE` で拒否されます。
- **migration 実行中の同一 identity は再入できません。** コールバックとストア書き込みの間、その identity の `acquire()` と `migrate()` は `LIVE_STATE` の `StateConflictError` で失敗します。他の identity は影響を受けません。コールバックが例外を投げてもロックは解放されます。
- コールバックにはデコード済みの旧レコードがそのまま渡されます。戻り値は現在の `GuiState` として検証・複製され、`STATE_STORAGE_VERSION` と指定した schema で上書き保存されます。
- コールバックまたは検証が失敗した場合、`StateManager` はストアに書き込みません。ストア書き込みの失敗時はロールバックされず、結果はストアの実装に依存します（次項参照）。失敗前に解放済みのメモリ上の entry は破棄されるため、次回の `acquire()` はストアから読み直します。壊れた JSON はコールバックに渡さず `StateCorruptionError` で失敗します。
- **注入した外部 `StateStore` の失敗時の状態は、その実装の原子性に依存します。** `StateManager` は 1 レコードにつき `setItem()` を 1 回だけ呼び、失敗したときに再試行・ロールバック・部分書き込みの検出を行いません。したがって、`setItem()` が途中で失敗して値を部分的に残すストア実装では、**部分的な書き込みが残る可能性があります**。`BedrockWorldStateStore` は 1 つの動的プロパティへの単一 `setDynamicProperty()` 呼び出しですが、エンジン側で失敗したときに書き込みが残らないかは実機未検証です。
- 自動移行は行いません。`acquire()` は version/schema 不一致を `StateConflictError` で拒否します。レコードの退避・復旧・削除を行う API はありません（`StateStore.removeItem()` はありますが、`StateManager` は呼びません）。
- Window の state schema は GUI 種別・Structure 行・スクロール設定・タブ・`GuiLink` の子 GUI を再帰的に含む JSON 文字列から作る識別子です。Window を開いた後にこの構造が変わると、その Window は `WindowStateSchemaChangedError` を報告して close し、古い schema で新しい状態を保存しません。古い schema token のレコードは自動変換されず、移行する場合は `fromSchema` にその文字列を指定します。
- `BedrockWorldStateStore` は、キーを `%:` の世代 prefix に続けて固定幅の `%XXXX` 形式でエンコードした動的プロパティ識別子を使います（安全な ASCII はそのまま、それ以外は 1 UTF-16 コード単位 = `%` + 16 進4桁）。`%:` は旧エンコーダが生成しないため、新旧の識別子空間は分離されます。識別子は 1024 文字、値は UTF-8 換算で 32,767 バイトを既定の上限として、書き込み前に拒否します（`maxIdentifierLength` / `maxValueLength` で変更可）。32,767 はコミュニティ情報に基づくローカルガードで、エンジンの実上限は未検証です。文字列以外の保存値も拒否します。
- **以前の可変幅パーセントエンコード（例 `%E9`）で保存した動的プロパティは、このエンコーダでは読みません。** 現在の識別子が存在せず、旧エンコードの識別子に値がある場合、`LEGACY_IDENTIFIER_CONFLICT` で失敗し、旧エンコード側の値は返さず、どちらのプロパティも変更しません。旧エンコードは単射ではなく別キーの値と衝突し得るため、値をこのキーに帰属できません。手動で調査・移行してください。

## 必要環境

- **Node.js 24.22.1**（`flake.nix` が提供する `nodejs_24`）
  - `.envrc` の `use flake` により、このリポジトリの direnv 環境は `flake.nix` の `nodejs_24` を提供します。その Node 24.22.1 で `npm test` と `npm run build` が成功することを確認済みです。
  - 初回、または `.envrc` を変更した後は、リポジトリのルートで `.envrc` を信頼してから作業します。

    ```bash
    direnv allow .
    node --version   # v24.22.1
    npm install
    ```

    `direnv allow .` を実行しないと `use flake` は評価されず、Node 24.22.1 は PATH に入りません。direnv を使わない場合は `nix develop` で同じシェルに入るか、Node.js 24.22.1 を直接用意してください。
  - テストは TypeScript の `.ts` を直接読み込みます。型ストリッピングが既定で有効な Node.js 23.6 以降が必要です（22.6〜23.5 では `--experimental-strip-types` が必要）。
- **Minecraft Bedrock Edition** の Preview/Beta と `@minecraft/server` Experimental（実機は未検証）
- **`@minecraft/server` の型は `2.13.0-beta.1.26.70-preview.24` に完全固定**（`devDependencies` / `peerDependencies` とも exact 指定）。`peerDependencies` は範囲ではなく exact です。
- **npm の `@minecraft/server` は型定義（`index.d.ts`）だけで、実行時 JS を含みません。** Node.js から直接 `import "@minecraft/server"` すると `ERR_MODULE_NOT_FOUND` になります。自動テストは `node:module` の `registerHooks` で `ItemStack` と `world.virtualContainerManager` の最小モックに差し替えています。したがって Node.js 上でコアを直接読み込むには、テストと同様のモック（または同等のスタブ）が必須です。実機ではゲーム本体がこのモジュールを提供します。
- Minecraft 本体の対応バージョンは**未確定**です。`@minecraft/server` の型バージョンと、実際に動くゲーム版は別物なので、実機で確認した組み合わせだけを記録してください。

## 導入・ビルド・テスト

npm 未公開のため、現時点ではリポジトリを取得してビルドします。

```bash
npm install
npm run build   # tsc -p tsconfig.json -> dist/（ESM + .d.ts）
npm test        # node --test（ユニットテスト・CLI・phase0 プローブの静的検査・パッケージ境界）
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
- `npm test` は `@minecraft/server` をテスト内の最小モック（`ItemStack`、`world.virtualContainerManager.create` など）に差し替えます。モックは実機の挙動を再現しないため、テストが通っても実機の画面表示・入力・アイテム保護の検証にはなりません。close / itemChange の購読も同じモック上での確認に限られます。
- `npm test` に実機テストは含まれません。クリック・アイテム保護・JSON UI の検証は [tests/manual-bedrock/](tests/manual-bedrock/README.md) の手順で行います。
- phase0 の `VirtualContainer` プローブは静的検査だけが `npm test` に含まれます。実機での表示・close reason・itemChange の確認手順は [tests/manual-bedrock/probe/README.md](tests/manual-bedrock/probe/README.md) を参照してください。

## CLI（配布補助・静的検査＋任意のプローブ導入）

`init` は**既存パックを対象にした検査コマンド**で、既定では Behavior Pack / Resource Pack を変更しません。`--install-resource-pack` を明示した場合だけ、未検証の隔離プローブ `ui/invui.json` を既存 Resource Pack に追加します。`generate-resource-pack` は既存パックを対象にせず、`--output` で指定した**まだ存在しないディレクトリ**へ、同梱テンプレートから独立した実験用 Resource Pack を新規生成します（`init` とは別コマンドで、`init` 用オプションは受け付けません）。いずれもチェスト画面への接続は行いません。`package.json` の `bin` には登録されていますが、npm 未公開のため現時点ではリポジトリ内で直接実行します。

```bash
# 既定: 読み取り専用の静的検査
node bin/cli.js init \
  --behavior-pack ./behavior_pack \
  --resource-pack ./resource_pack

# 明示した場合だけ ui/invui.json を追加（既存ファイルは上書きしない）
node bin/cli.js init \
  --resource-pack ./resource_pack \
  --install-resource-pack

# 存在しない出力先に実験用 Resource Pack を新規生成
node bin/cli.js generate-resource-pack --output ./invui-probe-pack
```

### コマンドとオプション

| 指定 | 内容 |
|---|---|
| `init` | 既存の Behavior Pack / Resource Pack を静的に検査し、手動で必要な作業を表示する。既定では書き込まない |
| `generate-resource-pack --output <dir>` | 既存パックを変更せず、新しい出力先へ `manifest.json`・`ui/_ui_defs.json`・`ui/invui.json` の3ファイルを生成する。UUID（`header` と各 module）は生成のたびに作り直す |
| `--behavior-pack <dir>` | `init` 用。Behavior Pack のルート。`--install-resource-pack` 指定時は省略可 |
| `--resource-pack <dir>` | `init` 用。Resource Pack のルート。必須 |
| `--install-resource-pack` | `init` 用。未検証プローブ `ui/invui.json` を追加する（明示時のみ）。既存ファイルは上書きせず、内容が異なる場合は競合として中断する |
| `--output <dir>` | `generate-resource-pack` 専用・必須。既存パス、既存パス上のファイル、シンボリックリンク、ファイルシステムのルートは拒否し、上書きしない。`init` に指定すると引数エラー |
| `--json` | 検査結果と導入結果を JSON として標準出力へ出す |
| `-h`, `--help` | 使い方を表示する |
| `-v`, `--version` | バージョンを表示する |

`generate-resource-pack` は `--behavior-pack` / `--resource-pack` / `--install-resource-pack` を受け付けません（指定すると引数エラー）。`--output` 先が既に存在する場合も、既存のファイルとディレクトリは一切変更せず、生成しません。生成中に失敗した場合は、この CLI がその実行で作成したファイルとディレクトリだけを削除し、他プロセスが置いたファイルは消しません。

`check` は設計書にある将来案であり、まだ仕様確定していません。CLI が受け付けるコマンドは `init` と `generate-resource-pack` です。`--install-resource-pack` を指定しない `init` は静的検査だけを行います。

### CLI が行うこと

- `manifest.json` の存在と JSON としての読み込みを検査する。
- Behavior Pack の script モジュール、`entry` の有無、`@minecraft/server` への dependency を確認する。
- Resource Pack の `ui/` ディレクトリと、既存の `chest_screen.json` / `invui.json` / `_ui_defs.json` の有無を報告する。
- 未検証機能と、手動で確認すべき手順を表示する。
- `--json` 指定時は、検査結果と導入結果を JSON として標準出力へ出す。
- `--install-resource-pack` 指定時だけ、`ui/invui.json` を次の安全側の手順で追加する。
  - 既存ファイルの内容が同梱テンプレートと同一なら「導入済み」と報告し、書き換えない。
  - 内容が異なる場合は競合として中断し、差分を表示して終了コード `1` を返す。
  - 一時ファイルへ書いてから排他的に配置し、失敗時は追加済みファイル・一時ファイル・この CLI が作成した空ディレクトリを削除する**ロールバックを試みる**。
  - ただしロールバックは失敗しうる。削除権限がない、他プロセスがファイルを置き換えた、などの場合は削除できず、**部分適用が残る可能性がある**。その場合はエラーメッセージに削除できなかった理由が含まれるので、対象の `ui/invui.json` と作成されたディレクトリを手動で確認・削除する。
  - `npm test` はシミュレートした失敗経路でロールバックを確認するが、すべてのファイルシステム障害を再現するものではない。
  - `ui/` にシンボリックリンクがあるなど、パック外へ書き込むおそれがある経路は拒否する。

### CLI が行わないこと

- **既存画面へ JSON UI をマージ・接続しない。** `generate-resource-pack` は未接続のテンプレートから独立したパックを作り、`--install-resource-pack` で追加するのは隔離プローブ 1 ファイルだけです。
- **`generate-resource-pack` は既存のパックやパスを変更しない。** 出力先が存在する場合は生成自体を行わず、既存のファイル・ディレクトリ・シンボリックリンクに触れません。生成するのは `manifest.json` / `ui/_ui_defs.json` / `ui/invui.json` の3ファイルだけです。
- **既存の `chest_screen.json` を上書きしない。** 競合を検出した場合は報告だけ行います。
- **既存の `_ui_defs.json` を変更しない。** 導入時の参照追加は手動マージの対象です（`generate-resource-pack` は新しいパック内に自身の `_ui_defs.json` を作ります）。
- **既存の `manifest.json` を変更せず、Behavior Pack へも書き込まない。**
- **バックアップや復元を自動化しない。** UI を手動マージする場合は、利用者がバックアップを取ってください。

### 終了コード

| コード | 意味 |
|---|---|
| `0` | 検査完了（警告のみを含む）。導入指定時は「導入済み」または新規追加 |
| `1` | 引数エラー、検査エラー、導入の競合・失敗 |

## 実機テスト

未検証機能を「提供済み」にしないため、実機テストの手順と合否基準を用意しています。

- 手順と安全上の注意: [tests/manual-bedrock/README.md](tests/manual-bedrock/README.md)
- 合否チェックリスト: [tests/manual-bedrock/CHECKLIST.md](tests/manual-bedrock/CHECKLIST.md)
- phase0 の最小プローブ（`VirtualContainer` の表示・close reason・itemChange）: [tests/manual-bedrock/probe/README.md](tests/manual-bedrock/probe/README.md)
- `VirtualContainer` が chest 画面を使うかのマーカープローブ（単体 RP・ラベルのみ）: [tests/manual-bedrock/chest-resource-pack/README.md](tests/manual-bedrock/chest-resource-pack/README.md)
- `data_driven_container` 画面の判定プローブ: [tests/manual-bedrock/data-driven-resource-pack/README.md](tests/manual-bedrock/data-driven-resource-pack/README.md)

CLI の安全側の動作は、次のコマンドで自動確認できます（`npm test` にも含まれます）。

```bash
node --test tests/manual-bedrock/cli.test.mjs
```

このテストは、既定ではパックを変更しないこと、`--install-resource-pack` 指定時も `ui/invui.json` 以外を書き換えず既存ファイルを上書きしないこと、壊れた manifest で失敗することなどを確認します。実機の入力・表示・アイテム安全試験の代わりにはなりません。

### 実機検証が終わるまで利用できない機能

| 機能 | 現状 | 扱い |
|---|---|---|
| `Window.open()` による画面表示 | 実装は既定拒否・実機未検証 | 既定の実アダプタでは常に `WindowOpenRejectedError`。ただし `setContainerAdapter()` で迂回でき、強制境界ではない |
| close / itemChange のアダプタ購読 | `Window` 側の接続は Node.js モックでテスト済み。既定アダプタは未実装・実機未検証 | 実機ライフサイクル・入力・アイテム保護として扱わない |
| クリック通知（`button.send` → チャット候補を含む） | ライブラリ実装なし。RP には未接続の試験部品のみ・実機未検証 | 安全に利用不可。有効な機能として案内しない |
| 表示専用・ボタン用スロットのアイテム保護 | 実装なし・実機未検証 | 安全に利用不可。アイテム移動を許可しない |
| JSON UI による入力抑制・画面識別 | 未検証の隔離プローブのみ・実機未検証 | チェスト画面へ未接続。通常チェストへの影響も未確認 |
| `InventoryLink` のアイテム移動 | 実装なし。`moveTo()` は常に例外 | 複製・消失の可能性を排除できないため無効 |
| 左・右・Shift・ダブルクリックの区別 | 初期リリース非目標 | 通常クリックのみを設計対象とする |

設計書の合格条件（InvUI 画面だけに適用される、通常チェストが壊れない、表示アイテムを持ち出せない、通知が 1 回だけ届く、通知からプレイヤーとスロットを特定できる、アイテムが消失・複製しない、PC・タッチ・コントローラーで成立する、終了後の遅延入力が処理されない）を満たすまで、クリック機能を正式機能として公開しません。

### 実機画面を開く実験は使い捨てワールドで

- **既定拒否は強制された安全境界ではありません。** 実アダプタの `canOpenScreens = false` と `WindowOpenRejectedError` は、呼び出し側を拘束するサンドボックスではありません。公開 API の `WindowBuilder.setContainerAdapter()` は任意の `WindowContainerAdapter` を受け付けます。`canOpenScreens = true` を返し、`world.virtualContainerManager.create()` と実画面の open を包んだアダプタを渡せば、`Window.open()` は実画面を表示します。
- **消失・複製事故の恐れがあります。** 実画面では表示専用・ボタン用スロットのアイテム保護が未実装・未検証です。プレイヤーが保護未検証の表示アイテムを取り出したあと、`refresh()`・状態更新・要素の更新通知による再描画が走ると、`container.setItem()` が同じアイテムを書き戻し、アイテムが複製される可能性があります。逆に、プレイヤーが入れたアイテムを再描画が上書きすると消失します。クリック通知も未検証のため、入力の取りこぼし・遅延入力・意図しないスロットへの適用も保証できません。
- **itemChange を検出しても保護はされません。** アダプタが `subscribeItemChange` を実装してイベントを渡した場合、`Window` は `WindowItemChangeDangerError` をエラーハンドラーへ通知し、再描画を停止して `close()` を要求します。これはクリック通知ではなく、変更されたスロットを元のアイテムへ戻す保護でもありません。close 要求が実機で成功するか、画面が実際に閉じるかは未検証です。既定の `minecraftVirtualContainerAdapter` はこのフックを実装しておらず、`open()` も拒否したままなので、既定のままではこの経路自体が動きません。
- **実験は使い捨てのテスト用ワールドだけで行ってください。** 進行データのあるワールド、失いたくないアイテムを持つ環境、他のプレイヤーが参加するワールドでは実行しないでください。どうしても試す場合は、事前にワールド全体をバックアップし、終了後にインベントリとチェストのアイテム増減を確認してください。

## Resource Pack テンプレート（実験用・未検証）

`resource_pack/` には、単体の Resource Pack として構成した未検証のテンプレートを同梱しています。`manifest.json` と `ui/_ui_defs.json`、`invui_probe` 名前空間（可視ラベルと実験的な `button.send` 部品）を定義する `ui/invui.json` を含みますが、**どの画面からも参照されていません**。そのため画面表示は変わらない想定ですが、**実機未検証であり、表示が変わらないことも、部品が読み込まれることも保証しません**。`button.send` を購読するスクリプトは同梱しておらず、チャット送信やアイテム保護を提供するものでもありません。他 Resource Pack との名前空間・UUID の衝突や、ゲーム側の JSON UI の解釈次第で挙動が変わる可能性があります。チェスト画面への接続は含みません。

- `ui/invui.json` は CLI の `--install-resource-pack` が追加する唯一のファイルです。既存の Resource Pack へ追加した場合、`ui/_ui_defs.json` への登録は自動では行われず、必要なら手動でマージします。
- `ui/invui_controls.json` は作成中の追加プローブで、未登録・未接続・CLI 導入対象外です。完成扱いしないでください。
- `manifest.json` の UUID・version・`min_engine_version` はプレースホルダです。対象ゲーム版は未確定です。
- このテンプレートは `data_driven_container` 名前空間を変更しません。同名前空間を変更する判定プローブは別ディレクトリにあり、Mojang が変更しないよう求める箇所を検証専用に変更するものです（[data-driven 判定プローブ](tests/manual-bedrock/data-driven-resource-pack/README.md)）。
- 既存 Resource Pack との競合を検出・解消する機能はありません。**使い捨てワールドで、バックアップを取ってから**検証してください。詳細は [resource_pack/README.md](resource_pack/README.md) を参照してください。

Resource Pack を使わなくても、コアの型・レイアウト計算・状態管理は利用できます（Node.js 上で `@minecraft/server` をモックしたテストで確認済み）。ただしクリック入力を必要とする Window は動作しません。既定の実アダプタでは `Window.open()` が拒否されるため、Resource Pack の有無にかかわらず画面は開きません（`setContainerAdapter()` で実画面を開くアダプタを渡した場合は除く）。

## 設計上の前提（実機未検証）

以下は設計書の方針です。実機で確認されるまで動作保証として読み替えないでください。

- `VirtualContainer` は Bedrock Preview/Beta の Experimental API で、メモリ上のコンテナであり、ワールドに保存されない。
- `size` と `title` は生成後に変更できないため、変更時は画面を開き直す。
- スクリプト再読み込み時に画面は閉じ、通常の終了イベントに依存した永続化はできない。
- 状態の共有範囲は `player` / `shared`、保存期間は `window` / `session` / `persistent`。
- 設計原則は影響を受けたスロットの差分反映だが、**現在の状態更新・明示 `refresh()` は全スロットを再評価する**（要素の更新通知のみ該当スロット）。理由と限界は「[差分描画の限界](#差分描画の限界状態更新)」を参照。
- JSON UI の変更は必要最低限とし、通常チェストへの影響を避ける。
- **Mojang は `data_driven_container_screen.json` と `data_driven_container` 名前空間を変更しないことを期待し、後方互換性を保証していません**（Minecraft Preview 26.70.23 告知）。このため、この JSON / 名前空間の変更や、それに依存する入力・画面接続を前提にしません。[data-driven 判定プローブ](tests/manual-bedrock/data-driven-resource-pack/README.md)は、この変更を「どの画面が使われるか」の観察だけのために意図的に行う検証専用プローブであり、配布物や正式機能の土台にはしないでください。`VirtualContainer` がこの画面を使うか自体も未確認です。
- `@bedrock-core/ui` には依存しない。

## ディレクトリ構成（現時点）

```text
InvUI-for-Bedrock/
├── package.json                  # 0.1.0-beta.1 / ESM / build・test・pack scripts
├── tsconfig.json
├── bin/
│   └── cli.js                    # 配布補助 CLI（静的検査・任意でプローブ導入）
├── resource_pack/                # 未検証の隔離テンプレート（チェスト画面へ未接続）
│   ├── README.md
│   ├── manifest.json
│   └── ui/
│       ├── _ui_defs.json
│       ├── invui.json            # CLI が導入する唯一のファイル
│       └── invui_controls.json   # 作成中・未登録・CLI 対象外
├── .github/
│   └── workflows/ci.yml          # GitHub Actions（build / test / pack）
├── src/
│   ├── index.ts                  # 公開エントリ（bedrock-store も公開）
│   ├── gui.ts                    # Structure / Gui / GuiLink / レイアウト計算
│   ├── item.ts                   # Item / ItemBuilder / クリックハンドラー / 周期更新
│   ├── periodic.ts               # system.runInterval を使う周期スケジューラ（内部）
│   ├── inventory.ts              # VirtualInventory / InventoryLink（移動は拒否）
│   ├── state.ts                  # StateManager（scope / lifetime / 永続化 / migrate）
│   ├── bedrock-store.ts          # 動的プロパティを使う StateStore
│   └── window.ts                 # Window（open は既定拒否）
├── dist/                         # ビルド成果物（ESM + .d.ts、git 管理外）
├── tests/
│   ├── gui.test.mjs
│   ├── item-inventory.test.mjs
│   ├── periodic.test.mjs         # 周期更新の開始・停止
│   ├── bedrock-store.test.mjs    # 動的プロパティ・StateManager 連携
│   ├── state.test.mjs            # 状態管理・migration・破損時の挙動
│   ├── window.test.mjs           # Window と実アダプタの拒否経路・state schema
│   ├── window-diff.test.mjs      # 状態変更時の全スロット再評価
│   ├── package.test.mjs          # パッケージ境界の検査
│   └── manual-bedrock/
│       ├── README.md             # 実機テスト手順
│       ├── CHECKLIST.md          # 合否チェックリスト
│       ├── API-NOTES.md          # VirtualContainer の型・ドキュメント調査
│       ├── cli.test.mjs          # CLI の自動テスト
│       ├── probe/                # phase0 の最小プローブ
│       │   ├── README.md
│       │   ├── probe.test.mjs
│       │   └── behavior_pack/
│       ├── chest-resource-pack/  # VirtualContainer が chest 画面を使うかのマーカープローブ
│       └── data-driven-resource-pack/  # data_driven_container 判定用の隔離 RP
├── examples/
│   ├── README.md
│   └── usage-sketch.ts           # 設計上の利用イメージ（型検査のみ）
└── InvUI_for_Bedrock_Design.md   # 全体設計書
```

`LICENSE` はまだありません。`resource_pack/` は未検証の隔離テンプレートで、チェスト画面には接続していません。`examples/usage-sketch.ts` は現行コアの公開型に一致するスケッチですが、実行の対象外で、実アダプタでは `Window.open()` が拒否されます。型検査の手順は [examples/README.md](examples/README.md) を参照してください。

## 対応バージョン

| 対象 | バージョン | 状態 |
|---|---|---|
| ライブラリ | `0.1.0-beta.1` | npm 未公開 |
| `@minecraft/server`（型・開発時） | `2.13.0-beta.1.26.70-preview.24`（固定） | ビルド・テストで使用 |
| `@minecraft/server`（peer） | `2.13.0-beta.1.26.70-preview.24`（exact） | 実機未検証 |
| Minecraft Bedrock Edition | 未確定 | 実機テストで確認した組み合わせのみ記録する |

CLI は manifest からゲーム版・Experimental の有効状態を確定できません。実機テストの記録欄に、実際に使用した版を残してください。

## ライセンス

未設定です。配布前に決定する必要があります。

## 参考

- [設計書](InvUI_for_Bedrock_Design.md)
- [Java版 InvUI](https://github.com/NichtStudioCode/InvUI)
- [Minecraft Creator ドキュメント（Script API）](https://learn.microsoft.com/minecraft/creator/scriptapi/)
