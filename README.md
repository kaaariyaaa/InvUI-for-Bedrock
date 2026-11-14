# InvUI for Bedrock

Java版 [InvUI](https://github.com/NichtStudioCode/InvUI) の設計と公開 API をできるだけ維持した、Minecraft Bedrock Edition 向け GUI ライブラリです。

> [!WARNING]
> **ベータ / 実機未検証**
>
> - バージョンは `0.1.0-beta.1`。**npm には未公開**です。`npm install invui-bedrock` はまだ使えません。
> - **実機では一切検証していません。** ライブラリ経由の実機画面表示は**既定で有効**です。`minecraftVirtualContainerAdapter` は `canOpenScreens = true` を返し、`Window.open()` から `VirtualContainer` の作成・`VirtualContainer.open()`、`Window.close()` から `VirtualContainer.close()` を呼びます（すべて実機未検証）。実機ライフサイクルの後始末は、退出（`world.afterEvents.playerLeave`）と死亡（`world.afterEvents.entityDie`）が実装済みです（Node.js テスト済み、実機未検証。退出したプレイヤーの `opening` / `open` の Window を `PlayerLeft`、死亡したプレイヤーの Window も `PlayerDied` で close し、どちらも自動再オープンはしません。死亡は死亡した entity の id だけを照合するため、プレイヤー以外や他プレイヤーの死亡では close しません）。次元変更（`world.afterEvents.playerDimensionChange`）は `ServerClosed`、スペクテイターへの変更（`world.afterEvents.playerGameModeChange` の `toGameMode` が `Spectator`）は `PlayerSpectating` で close し、どちらもプレイヤーがまだ有効なのでアダプタにも close を要求します（Node.js テスト済み、実機未検証。他プレイヤーと Spectator 以外のゲームモード変更は無視）。shutdown は `system.beforeEvents.shutdown` で `opening` / `open` の全 Window を `ServerClosed` で close します（Node.js テスト済み、実機未検証）。このコールバックは restricted execution で走るため、`VirtualContainer.close()` とアダプタのイベント購読解除は呼ばず、画面とアダプタ購読の破棄はエンジンに任せ、チャット登録・state ハンドル・GUI/要素の購読などのローカル資源だけを解放します。close ハンドラー（およびそこで例外が起きた場合のエラーハンドラー）も同じ restricted なコールバック内で実行され、close ハンドラーは 1 回だけ呼ばれます。そこから `open()` しても画面は開かず `closed` のままです。shutdown 後の `open()` はモジュールの生存期間中ずっと抑止され、2 回目の shutdown は何もしません。スクリプト再読み込み時の後始末は未対応です。クリック入力はチャット通知の受信経路だけが既定で接続され、UI 側が通知を**自動生成**する処理はなく、通知は手入力で偽装でき、実機未検証です。JSON UI から押下 slot / session / sequence を自動生成して送る方式は、公式 `bedrock-samples` と Bedrock Wiki の範囲では根拠がなく実装していません（詳細は [resource_pack/README.md](resource_pack/README.md)）。`resource_pack/` には手入力の**静的ペイロード送信プローブ**（`!invui:<session-id>:<slot>:<sequence>` を手で入力するオプトイン部品、既定未登録。session-id は開いた `Window` の公開 getter `_inputSessionId` から取得する）だけを置いています。アイテム保護、`InventoryLink` のアイテム移動は未実装です。JSON UI 連携は `resource_pack/` が既定で `data_driven_container` のパネルへ差し込む未検証のものだけで、VirtualContainer の識別はありません。既定の接続はグリッドへ透明ブロッカーも差し込みますが、実機未検証であり、ボタンや inventory slot への影響、プレイヤー側や controller 入力の遮断を保証しません（アイテム保護ではありません）。`Item` の `display` / `button` 分類はメタデータとハンドラー実行のガードに留まり、実機のアイテム保護ではありません。`Window` は最初の `open()` で `world.beforeEvents.chatSend` を 1 本購読し、`!invui:<session-id>:<slot>:<sequence>` を解釈して `handleClick()` へ流しますが、これは Node.js テストで確認しただけで実機未検証です。`src/input.ts` と `src/chat-input-bridge.ts` は公開エントリから export していません。`WindowContainerAdapter` の任意購読フック（`subscribeClose` / `subscribeItemChange`）は既定の `minecraftVirtualContainerAdapter` も実装し、`world.afterEvents.virtualContainerClose` / `virtualContainerItemChange` を購読しますが、Node.js テストで経路を確認しただけで実機未検証です。どちらも `after` イベントなので、購読しても close・アイテム変更はすでに起きており、防ぐことも変更前のアイテムへ戻すこともできません。既定の `open()` 経路でも購読は張られますが、保護にはなりません。
> - **既定で実画面を開くため、アイテムの複製・消失リスクが既定で有効です。** 画面にはクリック通知を生成する UI もアイテム保護もなく、実機未検証です。表示アイテムは実際の `VirtualContainer` に `setItem()` で書き込まれ、プレイヤーが取り出せます。取り出した後に `refresh()`・状態更新・要素の更新通知で再描画が走ると、同じアイテムが書き戻されて複製され得ます。逆に、プレイヤーが入れたアイテムを再描画が上書きすると消失し得ます。試す場合は「[実機画面は既定で開く（使い捨てワールドで）](#実機画面は既定で開く使い捨てワールドで)」の条件だけに従ってください。
> - コア（レイアウト計算、アイテム表現、状態管理、Window の状態遷移）は実装・Node.js テスト済みです。**状態更新時の描画はスロット差分ではなく全スロット再評価、周期更新は Item を表示中の Window がある間のみ、永続ストアは手動の migration / レコード削除 API に加え、オプトインの `quarantineCorrupt` による破損レコードの自動退避・初期状態からの再開まで実装済みで、`migrations` に宣言した自動移行も `acquire()` が適用できます（未宣言の不一致は引き続き fail closed）**。クリック入力は、`window.ts` が最初の `open()` で `world.beforeEvents.chatSend` を購読し、`!invui:` 形式のチャット行を `system.run()` 経由で `handleClick()` に渡す経路だけが自動で接続されます（Node.js テストのみ、実機未検証）。ただし UI 側がその通知を自動生成する実装はなく、同じ行はプレイヤーが手入力できるため、クリックの証明にはなりません。JSON UI から slot / session / sequence を自動生成する書式は公式構造から確認できていないため、`resource_pack/` には手入力の静的ペイロードプローブ（`!invui:<session-id>:<slot>:<sequence>`、オプトイン・既定未登録。session-id は開いた `Window._inputSessionId`）だけを置いています。`resource_pack/` は既定で `data_driven_container` の `desktop_panel` / `pocket_panel` へ接続する未検証テンプレートで、`chest_screen` は編集していません。既定の接続はグリッドへ透明ブロッカーも挿入しますが、遮断の成否は実機未検証で、VirtualContainer 画面を使っているかは未確定です。VirtualContainer を識別する仕組みがなく、同パネルを使う他の画面にも影響し得ます。
> - この README は、実装済みの範囲と未完成・未検証の機能を区別して記載します。未検証の機能を「完成・動作確認済み」として扱わないでください。

## 現在の状態

| 項目 | 状態 |
|---|---|
| コア（`src/`） | **実装済み（実機非依存の範囲）**。`Structure` / `Gui`（normal・paged・scroll・tab）/ `GuiLink` / `Item` / `VirtualInventory` / `PlayerInventory` / `StateManager` / `Window`。ただし「[コアの未完成点](#コアの未完成点実コードで確認)」に挙げた項目は未完成 |
| 公開エントリ（`src/index.ts`） | コアの公開型に加え、`BedrockWorldStateStore` / `BedrockStoreError` / `BEDROCK_MAX_DYNAMIC_PROPERTY_IDENTIFIER_LENGTH` / `BEDROCK_MAX_DYNAMIC_PROPERTY_LENGTH` と migration / remove / 自動移行宣言（`StateAutoMigration`）の型を公開。`periodic.ts` のスケジューラは内部用で公開しない |
| ビルド（`npm run build`） | 成功する（Node.js 24.22.1 で確認）。TypeScript で `dist/` に ESM と `.d.ts` を出力 |
| 自動テスト（`npm test`） | 成功する（Node.js 24.22.1 で確認）。Node.js のユニットテスト、周期更新、Bedrock ストア、CLI の安全側テスト、phase0 プローブの静的検査、パッケージ境界の検査。件数はテスト追加で変わるため固定値としては記載しない |
| CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)） | GitHub Actions で `npm ci` / `npm run build` / `npm test` / `npm pack --dry-run` を実行 |
| 実機テスト | **未実施** |
| 実機画面の表示 | **既定で有効（実機未検証）**。実アダプタは `canOpenScreens = true` を返し、`Window.open()` が `VirtualContainer` を作成して `VirtualContainer.open()` を呼び、`Window.close()` が `VirtualContainer.close()` を呼ぶ。画面の表示可否・close 完了は実機未確認 |
| 実機ライフサイクル（close・死亡・退出・次元変更・スペクテイター・shutdown・再読み込み） | **イベント購読と退出・死亡・次元変更・スペクテイター・shutdown時の自動 close（Node.js テスト済み、実機未検証）**。既定の `minecraftVirtualContainerAdapter` が `world.afterEvents.virtualContainerClose` / `virtualContainerItemChange` を購読し、`Window` が open 前に接続して close ハンドラーと itemChange の危険通知に流す（`after` イベントなので close・アイテム変更を防ぐ保護ではない）。`Window` は最初の `open()` で `world.afterEvents.playerLeave` を 1 本購読し、退出したプレイヤーの Window（`opening` / `open`）を `PlayerLeft` で close する。同じく最初の `open()` で `world.afterEvents.entityDie` を 1 本購読し、死亡した entity の id が Window の viewer id と一致する場合だけ `PlayerDied` で close する（プレイヤー以外・他プレイヤーの死亡は無視）。どちらも自動再オープンはしない。同じ `open()` で `world.afterEvents.playerDimensionChange` と `world.afterEvents.playerGameModeChange` も 1 本ずつ購読し、次元変更は `ServerClosed`、`toGameMode` が `Spectator` のときだけ `PlayerSpectating` で close する（プレイヤーが有効なのでアダプタにも close を要求する。他プレイヤーと Spectator 以外のモード変更は無視、自動再オープンはしない）。同じ `open()` で `system.beforeEvents.shutdown` も 1 本購読し、shutdown 時は `opening` / `open` の全 Window を `ServerClosed` で close する。shutdown のコールバックは restricted execution なので `VirtualContainer.close()` とアダプタのイベント購読解除は呼ばず、画面・アダプタ購読の破棄はエンジンに任せてローカル資源だけを解放する。close ハンドラーは同じコールバック内で 1 回走り、再 `open()` は抑止される（`closed` のまま）。2 回目の shutdown は何もしない。スクリプト再読み込み時の後始末は未実装 |
| 入力ブリッジ | **受信経路のみ自動接続（Node.js テスト済み、実機未検証）**。最初の `open()` で `world.beforeEvents.chatSend` を 1 本購読し、`!invui:<session-id>:<slot>:<sequence>` を解析して `system.run()` から `handleClick()` に流す。session-id は open ごとに作り直す `Window._inputSessionId`（`Window.id` の `window-N` ではない）。UI 側の payload の自動生成は未実装（JSON UI から slot/session/sequence を渡す書式は根拠なし）。手入力の静的ペイロードプローブは `resource_pack/ui/invui_controls.json` にオプトインで同梱（既定未登録）。通知は手入力で偽装可能、実機の `button.send` 挙動は未検証。rate limit は既定 100 ms（`minIntervalMs: 100`、10 回/秒）で、直前の受理から 100 ms 以内の連投は `rate-limited` として拒否する（`open()` をまたいでも直前の受理時刻を引き継ぐ）。パック側から変更する API はない。`src/input.ts` / `src/chat-input-bridge.ts` は公開エントリから export しない |
| クリック通知・アイテム保護・JSON UI 連携 | **ライブラリ側の受け口のみ**。自動接続のチャット通知は `handleClick()` まで届くが、通知を送る UI 側は未実装で、手入力偽装と実機未検証が残る。itemChange 検出時の危険通知・再描画停止・close 要求は `Window` にあるが、保護でもクリック処理でもない。`Window.handleClick()` は button mode の Item のみを実行する |
| アイテムの用途分類（`Item.getMode()` / `setMode()`） | **実装済み（Node.js テスト済み）**。`display` / `button` を分類し、未指定はハンドラーの有無から推測する。分類とハンドラー実行ガードのみで、実機のアイテム保護ではない |
| 差分描画 | **状態更新は provider の評価も全スロット、`setItem()` は「空→空」だけ省略。同じサイズの `setUpperGui()` だけは要素が変わった（または書き込みに失敗した）スロットだけを再評価**。状態更新と明示 `refresh()` は全スロットの provider を再評価するが、Container がすでに空のスロットを空で上書きする書き込みだけをスキップする（Window・Container ごとの `SlotWriteCache`）。要素の更新通知だけが該当スロットを再描画する。状態更新・GUI 変更・要素の更新通知は 1 つの microtask（`Promise.then`）にまとめて 1 回だけ描画する。前提と限界は「[差分描画の限界](#差分描画の限界状態更新)」を参照 |
| 開いている Window の GUI 差し替え（`Window.setUpperGui()`） | **実装済み（Node.js テスト済み、実機未検証）**。Container サイズと state schema が同じ GUI だけを、Container・画面を維持したまま差し替え、要素が変わったスロット（と直前の書き込みに失敗したスロット）だけを再描画する。サイズ違いはエラーハンドラーへ報告して現在の GUI を維持し、schema 違いは `WindowStateSchemaChangedError` を報告して close する（fail closed）。詳細は「[開いている Window の GUI 差し替えと非同期プレースホルダー](#開いている-window-の-gui-差し替えと非同期プレースホルダー)」を参照 |
| 表示中のタイトル変更（`Window.setTitle()`） | **実装済み（Node.js テスト済み、実機未検証）**。`VirtualContainer.title` は生成後に変更できないため、同じサイズの新しい Container を作って全スロットを描画してから旧画面を閉じ、新しい画面を開く。state・GUI・要素の購読は維持し、open/close ハンドラーは内部再生成では再実行しない。生成・close・open の失敗は ErrorHandler（`operation: "titleChange"`）へ報告する。旧画面を閉じた後の失敗は、未知の画面を残さないよう Window を close する（fail closed）。`open()` 実行中の変更は拒否する |
| 表示中のレイアウトサイズ変更（タブ切替など） | **実装済み（Node.js テスト済み、実機未検証）**。開いている Window の再評価で Container サイズが変わった場合（別サイズのタブへ `state.tab` で切り替えるなど）、同じタイトルの新しい Container を作って全スロットを描画してから旧画面を閉じて開き直す。state・GUI・要素の購読と open/close ハンドラーは維持し、生成に失敗した場合は ErrorHandler（`operation: "resize"`）へ報告して現在の Container・画面を維持する。幅だけが変わり Container サイズが同じ場合は Container を作り直さず、はみ出した旧列を消して再描画する |
| 非同期アイテムのプレースホルダー（`Item.setPlaceholder()` / `Item.builder().setPlaceholder()`） | **実装済み（Node.js テスト済み、実機未検証）**。placeholder を指定すると、非同期 provider の解決を待たずに placeholder を表示し、完了後に同じスロットを結果で更新する。未指定なら従来どおり解決まで待つ。表示の差し替えだけで、実機のアイテム保護ではない |
| 周期更新（`updatePeriodically()`） | **実装済み（Node.js テスト済み、実機未検証）**。Item を表示している開いた Window がある間だけ `system.runInterval()` で実行し、最後の購読解除または `close()` で停止する |
| 永続ストアの schema migration | **手動 API と宣言型の自動移行**。`StateManager.migrate()` で旧 version/schema に一致するレコードを明示的に書き換えるほか、`migrations` に宣言した移行を `acquire()` が自動適用する。宣言のない不一致は拒否する（fail closed）。migration のコールバックと書き込みの実行中は、同一 identity の `acquire()` / `migrate()` を `LIVE_STATE` で拒否する |
| 永続ストアの破損復旧 | **オプトインで実装済み（Node.js テスト済み）**。既定は fail closed で、壊れた JSON や不正な `guiState` は `StateCorruptionError` で失敗し、レコードを変更しない。`new StateManager(store, { quarantineCorrupt: true })` を指定すると、`acquire()` は壊れた生値を対象キーの `...:quarantine`（2 件目以降は `...:quarantine:2`）へ退避して元キーを削除し、`onError` へ通知したうえで `initial` から再開する。`migrate()` は対象外で fail closed のまま。退避の書き込みに失敗した場合は元レコードを残す |
| Bedrock 用 `StateStore` | **実装済み（Node.js テスト済み、実機未検証）**。`BedrockWorldStateStore` がワールドの動的プロパティに保存する。非文字列、識別子の長さ超過、UTF-8 換算の値サイズ超過を保存前に拒否する |
| `InventoryLink` のアイテム移動 | **無効固定**。`moveTo()` は常に `InventoryLinkMoveRejectedError` を投げる |
| `PlayerInventory`（プレイヤーインベントリの読み取り専用ビュー） | **実装済み（Node.js テスト済み、実機未検証）**。プレイヤーの実コンテナを `Inventory` として読み取り専用で公開する。`getItem()` は clone を返し、範囲外 slot は `RangeError`。`setItem()` / `clear()` は常に `PlayerInventoryReadOnlyError` を投げ、Container へは書き込まない（`PlayerInventory.writable` は `false`）。変更通知は `changes` に明示注入した `PlayerInventoryChangeSource` からのみ流す。`world.afterEvents.playerInventoryItemChange` から接続する任意の `createPlayerInventoryChangeSource(signal, mapSlot)` も用意したが、`inventoryType`/`slot` から絶対スロットへの対応は呼び出し側が実機で確認した mapper を渡す必要があり、既定 mapper はない。ブリッジは通知の転送だけでコンテナへの読み書きはしない。注入しない場合 `subscribe()` は購読解除関数を返すだけで発火しない（GUI は `refresh()` で再描画される） |
| `Window.mergedBuilder()` | **実装済み（Node.js テスト済み、実機未検証）**。Java 版と同名の merged ビルダー。Bedrock ではプレイヤーインベントリが描き換え可能な `VirtualContainer` ではないため、`setGui(gui)` は単一 GUI を Container に表示する（`setUpperGui()` の別名）だけで、下側領域は標準 UI のまま。merged 固有の描画は行わない |
| `Window.open()` | **既定で実画面を開く（実機未検証）**。Container を作成し `VirtualContainer.open()` を呼ぶ。失敗は例外・エラーハンドラーで報告するが、実機での表示は未確認 |
| 配布補助 CLI（[bin/cli.js](bin/cli.js)） | 実装済み。既定は読み取り専用の静的検査。`--install-resource-pack` を明示した場合だけ `ui/invui.json` と接続用 `ui/invui_connect.json` / `ui/invui_connect_data_driven.json` の3ファイルを追加する。既存の `ui/_ui_defs.json` は既定で変更しない。`--install-resource-pack` と併用して `--register-ui-defs` を明示した場合だけ、事前検査を通ったときに既存 `_ui_defs.json` へ不足エントリをバックアップ付きで追記する（JSON は再整形されるため、元の書式へ戻すならバックアップから復元する） |
| CLI の自動テスト（[cli.test.mjs](tests/manual-bedrock/cli.test.mjs)） | 実行可能（`npm test` に含まれる） |
| 実機テスト手順（[tests/manual-bedrock/README.md](tests/manual-bedrock/README.md)） | あり |
| 合否チェックリスト（[CHECKLIST.md](tests/manual-bedrock/CHECKLIST.md)） | あり |
| 利用イメージ（[examples/README.md](examples/README.md)） | 設計スケッチのみ。型検査は可能、実行は対象外 |
| 全体設計（[設計書](InvUI_for_Bedrock_Design.md)） | あり（バージョン 1.2） |
| JSON UI テンプレート（`resource_pack/`） | **既定で data_driven 接続・実機未検証**。単体 Resource Pack として `manifest.json` と `ui/_ui_defs.json`（`ui/invui.json`・`ui/invui_connect.json`・`ui/invui_connect_data_driven.json` の3ファイル登録済み）を同梱する。`ui/invui_connect_data_driven.json` が `data_driven_container` の `desktop_panel` / `pocket_panel` の `controls` 先頭へ警告ラベルと `invui_probe_root` を `insert_front` で差し込み、末尾へ透明ブロッカー（`invui_connect_probe.grid_blocker`）を `insert_back` で差し込む。**VirtualContainer を識別する仕組みがないため、同パネルを使う全画面に影響し得る**。ブロッカーは実機未検証で、ボタンや inventory slot も制限し得る一方、プレイヤー側や controller 入力の遮断を保証しません。`chest_screen` は編集していない。CLI の導入対象は上記3ファイル、`generate-resource-pack` の生成物は5ファイル |
| npm 公開 | 未実施 |
| ライセンス | 未設定 |

## コアの実装範囲（実機非依存）

実機に依存しない範囲は実装され、Node.js 上で `@minecraft/server` をモックしてテストされています。Bedrock 実機での動作を保証するものではありません。

- **レイアウト**: `Structure`（最大 9×6、Unicode 1 コードポイント = 1 スロット）、`Gui.normal()` / `Gui.paged()` / `Gui.scroll()` / `Gui.tab()`、`PagedGui.itemsBuilder()`（Java版互換の別名）、`Markers.CONTENT_LIST_SLOT_HORIZONTAL` / `VERTICAL`、`GuiLink` による子 GUI の投影。ページ・行・タブは `GuiState` として外から渡し、GUI インスタンス自身は状態を持ちません。
- **アイテム**: `Item`、`ItemBuilder`、`Item.simple()`、`Item.builder()`、クリックハンドラーの登録と呼び出し順序、`Item.getMode()` / `setMode()` による `display` / `button` 分類（未指定はハンドラーの有無から推測、`setMode` はハンドラーを追加・削除しない）まで。`display` の Item はハンドラーを保持していても実行しません。ただし分類はメタデータと `Item` レベルのガードに留まり、JSON UI 側のアイテム保護（設計 7.2 / 10.1）ではありません。`updatePeriodically(ticks)` は、その Item を表示している開いた Window が 1 つ以上ある間だけ `system.runInterval()` に登録し、最後の Window が閉じるか購読を解除すると `clearRun()` で停止します。1 Item につき 1 インターバルで、再購読すると周期の位相はリセットされます。スケジューラの登録失敗は `console.error` に記録され、Item は明示更新では引き続き描画されます。クリックを実機イベントから届ける仕組みは、`world.beforeEvents.chatSend` を受ける自動接続だけが入っています（UI 側の通知生成は未実装・実機未検証。詳細は「コアの未完成点」の「入力」）。`Item.setPlaceholder(stack)` / `Item.builder().setPlaceholder(stack)` は非同期 provider の実行中に表示する `ItemStack` を設定します（clone して保持し、`undefined` で解除）。placeholder 未指定の非同期 provider は従来どおり解決まで待ち、指定時は途中で placeholder を表示して完了後に同じスロットを更新します。placeholder は表示だけの差し替えで、実機のアイテム保護ではありません。
- **インベントリ**: メモリ上の `VirtualInventory`（`Inventory` インターフェース実装）。`serialize()` / `VirtualInventory.deserialize()` は、呼び出し側が渡す明示的な `InventoryItemCodec` を介して JSON 可能なスナップショットへ変換・復元します（`ItemStack` の全状態は列挙できないため既定 codec は提供しません）。codec の `encode()` の戻り値とスナップショットは strict な JSON 検証と deep clone を通り、`serialize()` は最初の `encode()` より前に全占有 slot を clone して固定します。`deserialize()` は `item` が欠落した slot エントリを空 slot として扱わず拒否します。`InventoryLink` はリンク先スロットの読み書きと購読のみ提供し、**別インベントリへの移動は実装していません**。`PlayerInventory` はプレイヤーの実コンテナを同じ `Inventory` として読み取り専用で公開し、変更通知は呼び出し側が明示注入した `PlayerInventoryChangeSource` からのみ流れます（既定の自動接続はしない。`world.afterEvents.playerInventoryItemChange` を使う任意の `createPlayerInventoryChangeSource(signal, mapSlot)` もあるが、絶対スロットへの mapper は呼び出し側が実機で確認して渡す。詳細は「[プレイヤーインベントリ](#プレイヤーインベントリ読み取り専用実機未検証)」）。
- **状態**: `StateManager`。`player` / `shared` のスコープ、`window` / `session` / `persistent` の保存期間、スキーマ不一致の拒否。永続化には注入した `StateStore` が必要です。**`StateManager.migrate()` による明示的な移行と、`migrations` に宣言した自動移行が実装済み**です。宣言のない旧 version/schema は自動変換せず拒否します。破損レコードは既定では自動退避・復旧せず、破損時は `StateCorruptionError` を投げてレコードを残します。`StateManager` の `quarantineCorrupt: true` を指定した場合だけ、`acquire()` が壊れた生値を退避して `initial` から再開します。削除は `StateManager.remove()` で明示的に行います。Bedrock 用には `BedrockWorldStateStore`（ワールドの動的プロパティを使用）を公開しています。
- **Window**: `Window.builder()` の設定、状態の取得・更新、`close()`、クリックのルーティング（`Window.handleClick()`）まで。開いた Window は自動でチャット通知の入力対象に登録され、close とページ/行/タブ変更で無効化されます（詳細は「[入力](#コアの未完成点実コードで確認)」）。`handleClick(slot)` は button mode の Item だけを実行し、キュー投入時と実行時の両方で slot・layout/generation・mode を再検証するため、close・再オープン・ページ/タブ変更をまたいだクリックは破棄されます。状態更新・GUI の内容変更・明示 `refresh()` は全スロットを再評価して描画し、要素の更新通知だけが該当スロットを再描画します。同じサイズの `setUpperGui()` は要素が変わったスロットだけを描画します。状態更新と GUI 変更は 1 つの microtask（`Promise.then`。Bedrock の実行環境に `queueMicrotask` があるとは限らないため）にまとめ、同じタイミングで届いた要素の更新通知もスロット単位でその flush に合流させて 1 回だけ描画します。予約した時点でそのスロットの描画 token を進めるため、flush 前に解決した古い非同期結果は書き込まれません。**画面を開く経路は既定で有効（実機未検証）。** アダプタが任意フック `subscribeClose` / `subscribeItemChange` を実装していれば、`Window` は open 前に購読し、close イベントを close ハンドラーへ、itemChange を `WindowItemChangeDangerError` の通知・再描画停止・`close()` 要求として扱います。close ハンドラーの実行中に再 open すると新しい generation が始まり、それ以降の旧 generation の close ハンドラーは通知されず、再 open 後にそのハンドラーが投げた例外も新 generation には配送されません。既定の `minecraftVirtualContainerAdapter` も `world.afterEvents.virtualContainerClose` / `virtualContainerItemChange` を購読してこのフックへ流しますが、Node.js テストで確認しただけで実機未検証です。close 理由は `VirtualContainerCloseReason` から `WindowCloseReason` へ明示的に変換し、未知の理由は `ServerClosed` として通知します。`Window.close(reason)` の `reason` は呼び出し側が渡す値のままです。どちらのイベントも `after` なので、購読した時点で close・アイテム変更はすでに起きており、防ぐことも元のアイテムへ戻すこともできません。itemChange はクリック通知でも保護でもありません。退出時の後始末（最初の `open()` で購読した `world.afterEvents.playerLeave` から、退出したプレイヤーの Window を `PlayerLeft` で close し、chat 登録・state ハンドル・GUI/要素の購読を解放する。自動再オープンはしない）と、死亡時の後始末（同じ `open()` で購読した `world.afterEvents.entityDie` から、死亡した entity の id が viewer id と一致する Window だけを `PlayerDied` で close し、同じ経路で購読と state ハンドルを解放する。プレイヤー以外や他プレイヤーの死亡は無視し、アダプタには close を要求しない）は実装済みですが、Node.js テストのみで実機未検証です。次元変更時は同じ `open()` で購読した `world.afterEvents.playerDimensionChange` から `ServerClosed` で、スペクテイターへの変更時は `world.afterEvents.playerGameModeChange` の `toGameMode` が `Spectator` のときだけ `PlayerSpectating` で、viewer id が一致する Window を同じ close 経路で後始末します（プレイヤーがまだ有効なのでアダプタにも close を要求し、自動再オープンはしない。他プレイヤーと Spectator 以外のモード変更は無視。Node.js テストのみで実機未検証）。shutdown は同じ最初の `open()` で購読する `system.beforeEvents.shutdown` で `opening` / `open` の全 Window を `ServerClosed` で close します（実機未検証）。このコールバックは restricted execution で走るため、`VirtualContainer.close()` とアダプタ/イベントの `unsubscribe()` は呼ばず、画面と購読の破棄はエンジンに任せ、chat 登録・state ハンドル・GUI/要素の購読・container 参照などのローカル資源だけを解放します。ユーザーの close ハンドラー（およびそこで例外が起きた場合のエラーハンドラー）も同じ restricted なコールバック内で実行され、close ハンドラーは 1 回だけ呼ばれるため、close ハンドラーから `VirtualContainer.close()` やイベント `unsubscribe()` を呼ぶと失敗し得ます。close ハンドラーから `open()` しても画面は開かず `closed` のままで、shutdown 後の `open()` はモジュールの生存期間中ずっと抑止されます。shutdown 経路では close イベントは発生せず、2 回目の shutdown は何もしません。shutdown API がない環境では購読を諦めて Window は通常どおり動きます。スクリプト再読み込み時の後始末は未対応です。GUI の構造変更（種別・Structure 行・スクロール設定・タブ・`GuiLink` の子 GUI）で state schema が合わなくなった場合、`Window` はエラーハンドラーへ `WindowStateSchemaChangedError`（`INVUI_STATE_SCHEMA_CHANGED`）を報告し、再描画を停止して close します。同じ通知中に走った `setState()` は同じエラーで拒否され、以後の `setState()` は開いていない Window として失敗します。内容変更（`setContent`）は schema を変えないため、通常どおり描画だけ更新します。ページ・行・タブが新しいコンテンツ範囲外になった場合は、描画に使ったクランプ値を状態へ書き戻し（コンテンツ更新時と `setUpperGui()` 後、非表示だったタブを選択したとき）、コンテンツが再び増えても古い範囲外の値が復活しないようにします。`open()` は状態を書き戻さずクランプして描画するだけなので、小さいコンテンツ範囲を持つ Window を開いても、同じ共有状態を使う別 viewer のページ・行を巻き戻しません。`setUpperGui(gui)` は開いている Window の upper GUI を、Container と画面を維持したまま同じサイズ・同じ state schema に限って差し替え、再描画します。サイズが違う場合はエラーハンドラーへ `guiChange` として報告して現在の GUI を維持し（state・GUI 変更の再評価でサイズが変わった場合は新しい Container を生成して旧画面を閉じた後に開き直す）、schema が違う場合は `WindowStateSchemaChangedError` を報告して close します（fail closed）。`setTitle(title)` は開いている Window のタイトルを、同じサイズの Container を新しく作って描画してから旧画面を閉じて開き直すことで変更します。state と購読は維持し、open/close ハンドラーは再実行しません。`open()` 実行中の変更は拒否し、旧画面を閉じた後に失敗した場合は Window を close します。close が実機で成功するかは未検証です。**画面を開く経路は既定で有効になりましたが、実機での表示・入力・アイテム保護は未検証です。**

## コアの未完成点（実コードで確認）

「コア実装済み」は実機非依存の計算・状態遷移までを指します。次の項目は未完成、または実装済みでも制約・実機未検証が残ります。

- **実機画面**: 実アダプタは `canOpenScreens = true` を返し、`Window.open()` は Container を作成して `VirtualContainer.open()` を呼びます。`close()` は `VirtualContainer.close()` を呼びます。ただし**実機で画面が表示されるか、close がいつ完了するかは未検証**です。`close()` は閉鎖を要求した時点で返り、実際の close イベントは別 tick になることがあるため、直後の再 `open()` は前画面の閉鎖待ちで失敗し得ます。表示されたアイテムの取り出しを防ぐ仕組みはありません。
- **実機ライフサイクル**: 既定の `minecraftVirtualContainerAdapter` は `world.afterEvents.virtualContainerClose` / `virtualContainerItemChange` を購読し、`Window`（open 前に購読し、close または失敗した open で解除）が close ハンドラーと itemChange の危険通知に流します。ただし Node.js テストで確認しただけで実機未検証であり、どちらも `after` イベントなので close・アイテム変更を防ぐ保護ではありません。`world.afterEvents.playerLeave` は最初の `open()` で 1 本購読し、退出したプレイヤーの Window を `PlayerLeft` で close して後始末します。同じ `open()` で `world.afterEvents.entityDie` も 1 本購読し、死亡した entity の id が viewer id と一致する Window（`opening` / `open`）だけを `PlayerDied` で close して同じ経路で後始末します（プレイヤー以外・他プレイヤーの死亡、id を読めない entity は無視。アダプタには close を要求しません）。どちらも Node.js テストで確認しただけで実機未検証です。`entityDie` の検出は `playerLeave` とは別に行い、片方が無い環境でも他方は動きます。`world.afterEvents.playerDimensionChange` と `world.afterEvents.playerGameModeChange` も同じ `open()` で 1 本ずつ購読し（feature detection も別々）、次元変更は `ServerClosed`、`toGameMode` が `Spectator` のときだけ `PlayerSpectating` で close します。こちらはプレイヤーがまだ有効なのでアダプタにも close を要求します（Node.js テスト済み、実機未検証。他プレイヤーと Spectator 以外のゲームモード変更は無視。自動再オープンはしない）。`system.beforeEvents.shutdown` も同じ最初の `open()` で 1 本購読し、shutdown 時は `opening` / `open` の全 Window を `ServerClosed` で close します（Node.js テスト済み、実機未検証）。ただし shutdown のコールバックは restricted execution で走るため、`VirtualContainer.close()` とアダプタ/イベントの `unsubscribe()` は呼びません。画面と購読の破棄はエンジンに任せ、chat 登録・state ハンドル・GUI/要素の購読・container 参照などのローカル資源だけを解放します。close ハンドラーも同じ restricted なコールバック内で 1 回だけ実行され、そこで `open()` しても画面は開かず `closed` のままです。shutdown 後の `open()` はモジュールの生存期間中ずっと抑止され、2 回目の shutdown は何もしません。shutdown API がない環境では購読を諦め、Window は通常どおり動きます。スクリプト再読み込み時の後始末は実装していません。`Window` の `status` 遷移、状態ハンドルの解放、`close()` の明示呼び出しはありますが、これらは実機の画面終了を保証しません。
- **入力**: `Window.handleClick(slot)` は呼び出し側が論理スロットを直接渡す API です。button mode の Item だけを実行し、キュー投入時と実行時の両方で slot・layout/generation・mode を再検証するため、待機中に close・再オープン・ページ変更があったクリックや、display に変わったスロットのクリックはハンドラーを呼ばずに破棄されます。左右・Shift・ダブルクリックの区別はありません。
  既定では、`Window` が最初の `open()` で `world.beforeEvents.chatSend` を 1 本購読し、`!invui:<session-id>:<slot-index>:<sequence>` 形式の行を `system.run()` 経由で `handleClick()` へ流します（[src/chat-input-bridge.ts](src/chat-input-bridge.ts)、Node.js テスト済み）。session-id は open ごとに作り直される `Window._inputSessionId`（`Window.id` の `window-N` ではありません。`window-N` は再読み込みで再利用されるため、遅延した通知が新しい画面に一致し得ます）で、送信者 id と一致する開いている Window だけが対象です。`_inputSessionId` は公開クラス `Window` の公開 getter（`dist/window.d.ts`）で、値は `session-<36進の時刻>-<36進の連番>-<36進6文字>` 形式の不透明なトークンです。アンダースコア付きで内部扱い・互換保証なしですが、開発者が現在値を読むことはできます（[resource_pack/README.md](resource_pack/README.md) の「session-id の取得手順」）。解析・重複排除・直列 queue は [src/input.ts](src/input.ts) の `createInputAcceptor()` が担い、close とページ/行/タブ変更で generation を進めて待機中の通知を捨てます。スロットは現在のレイアウトの mode で再評価され、button 以外（display・inventory）は拒否されます。解析に成功した行は `cancel` で通常チャットから隠します（偽装行も隠れます）。
  ただし、**この経路はクリックの証明でも認証でもありません。** 行はプレイヤーが手入力でき、sender id 以外の全フィールドが攻撃者制御です。rate limit は既定で 100 ms（`minIntervalMs: 100`、10 回/秒）有効で、直前の受理から 100 ms 以内に送った通知は `rate-limited` として拒否します（`open()` をまたいでも直前の受理時刻を引き継ぎます）。時刻ベースの有効期限は別途ありません。この間隔は `Window` の自動接続では内部既定値で、パック側から変更する API はありません。UI 側が通知を生成する実装（`button.send` ペイロード）はリポジトリにありません。実機での `button.send` と表示アイテムの扱いは未検証で、アイテム保護・入力抑制はこの経路に含まれません。`src/input.ts` と `src/chat-input-bridge.ts` は `src/index.ts` から export していません。`world.beforeEvents.chatSend` か `system.run` がない環境では接続せず、chat 入力は fail closed になります。チャット送信からの入力経路は、実機で `button.send` の挙動を確認するまで正式機能にしません。
- **差分描画**: 状態更新と明示 `refresh()` は、要素参照が変わっていなくても全スロットの provider を再評価します。Item の provider が状態に依存して同じ Item でも別の表示を返す場合があること、Bedrock の `ItemStack` を全 component まで比較して同値判定することを避けたためです。同じサイズ・同じ state schema の `setUpperGui()` だけは、要素が変わったスロットと直前の書き込みに失敗したスロットだけを再評価して描画します（この経路では Window の状態が変わらず、クランプが必要なら全スロット描画に回ります。詳細は「[差分描画の限界](#差分描画の限界状態更新)」）。全スロット描画で **`setItem()` を省略するのは、その Container に対して直前に自分で空を書いたスロットを空で上書きする場合だけ**です（空→空のみ、表示アイテムの書き込みはスキップしません）。要素の更新通知だけが該当スロットを再描画しますが、状態更新・GUI 変更・同じタイミングの複数の要素の更新通知は 1 つの microtask に合流して 1 回だけ描画します。詳細と限界は「[差分描画の限界](#差分描画の限界状態更新)」を参照してください。レイアウトサイズが変わった場合、表示中の Window は再オープンが必要で、`refresh()` はエラーを報告するだけです。
- **周期更新**: `Item.updatePeriodically()` は実装済みですが、実機未検証です。Bedrock の `system.runInterval()` に接続するのは、その Item を表示している開いた Window がある間だけで、Window を開く前や最後の Window を閉じた後は実行されません。1 Item につき 1 インターバルで、購読の張り替えで周期の位相がリセットされます。スケジューラの登録に失敗した場合は `console.error` に記録され、自動の再試行はありません。
- **永続ストア**: `StateManager` は注入された同期 `StateStore` に JSON を読み書きします。`STATE_STORAGE_VERSION` と schema の不一致は `StateConflictError`、壊れた JSON や不正な `guiState` は `StateCorruptionError` で失敗し、レコードは変更しません。**`StateManager.migrate()` による明示的な移行と、`migrations` に宣言した自動移行が実装済み**です。宣言のない旧 version/schema は自動変換せず拒否します。破損レコードの自動退避・復旧は既定では行いません。`StateManager` の `quarantineCorrupt: true` を指定したときだけ、`acquire()` が壊れた生値を `...:quarantine` キーへ退避して元キーを削除し、`onError` で通知して `initial` から再開します（`migrate()` は対象外）。明示的な削除は `StateManager.remove()` です。永続状態の `set()` が `setItem()` を実行している間はその identity をロックし、ストア実装から同じ identity の `acquire()` / `set()` / `migrate()` / `remove()` を再入すると `LIVE_STATE` の `StateConflictError` で拒否します（再入した書き込みが後から黙って上書きされるのを防ぐため。他の identity は影響を受けません）。外部 `StateStore` の `setItem()` が途中で失敗して部分的な書き込みが残っても、`StateManager` はそれを検出・修復しません（ストア実装の原子性に依存します）。Window の schema は GUI 種別・Structure 行・スクロール設定・タブと `GuiLink` の子 GUI を再帰的に含む識別子で、循環参照は拒否されます。

## 差分描画の限界（状態更新）

状態更新時に「変わったスロットだけ」を描く最適化はしていません。`setState()`、GUI の内容変更、明示 `refresh()` は、要素の参照が同じでも全スロットの provider を再評価します。書き込みだけは、その Container がすでに空のスロットを空で上書きする場合に限って省略します。

- **理由**: Item の provider は `GuiState` を読んで表示を変えられます。スロットの要素インスタンスが同じでも、状態が変われば provider の戻り値も変わります。また Bedrock の `ItemStack` は component や lore を含み、全項目の同値比較を安全に行えません。要素参照や ItemStack の値で差分を取ると、古い表示を残す可能性があります。
- **同じサイズの `setUpperGui()` だけの例外**: Container サイズと state schema が同じ GUI 差し替えでは、要素が変わったスロットと直前の `setItem()` に失敗したスロットだけを再評価します（設計 8.4 の差分更新）。この経路は Window の状態を変えず（クランプが必要な場合は全スロット描画に回します）、同じスロットの同じ Item・同じ viewer・同じ状態なので provider の入力は同じ、という前提です。**provider が viewer と Window の state 以外（`window.upperGui` や外部の可変データなど）を読む場合は、その値が変わった後に `notifyWindows()` を呼んでください。** 状態更新・GUI の内容変更・明示 `refresh()` は従来どおり全スロットを再評価します。
- **コスト**: 状態を 1 回変えるたびに、全スロットの provider 呼び出しと、空でないスロット（および空と未記録のスロット）への `container.setItem()` が走ります。provider は全スロット分を同期的に開始して並列に解決するため、1 つの遅い provider が他の開始をブロックすることはありませんが、そのバッチ全体の完了は待ちます。高頻度の状態更新は負荷になります。
- **古い非同期結果**: 状態変更・GUI の内容変更・新しい描画バッチのたびに render epoch を進め、スロットごとの token と generation も検査します。変更前に開始した provider の結果は、後から解決しても書き込まれません。同じサイズの `setUpperGui()` の差分描画は、変わっていないスロットの実行中 provider 結果をそのスロットのものとして有効に残すため epoch を進めません（変更したスロットは token で無効化します）。
- **要素の更新通知**: `Item.notifyWindows()` や `InventoryLink` の変更通知は、購読しているスロットだけを再描画します。レイアウト変更時は新しいレイアウトに購読を張り替えてから描画するため、移動先のスロットへ通知が届きます。
- **通知のバッチ**: 状態更新・GUI 変更は 1 つの microtask にまとめ、要素の更新通知はスロット単位で同じ flush に合流させます（設計 11.2 step 3 / 11.5）。同じタイミングの複数通知は 1 回の描画になり、full refresh が予約されていれば予約済みのスロット通知はそれに吸収されます。スロット通知は予約時点で描画 token を進めるため、flush 前に解決した古い provider 結果は書き込まれません。close・再オープン・明示 `refresh()` は予約を破棄します。microtask には `queueMicrotask` ではなく `Promise.then` を使います（Bedrock のスクリプト環境で `queueMicrotask` が常にあるとは限らないため）。
- **レイアウトサイズの変更**: 表示中の Window では `refresh()` がエラーを報告するだけで、サイズは変わりません。再オープンが必要です。`open()` の解決中にサイズが変わった場合は、画面を表示する前に Container を作り直します。
- **空→空の書き込み省略**: 直前に自分で空を書いた物理スロットを、次の描画でも空にする場合だけ `setItem()` をスキップします（`SlotWriteCache`）。記録は `setItem()` が例外を投げずに返った後だけ行い、失敗した書き込みは失敗として記録して次の描画（同じサイズの `setUpperGui()` の差分描画を含む）で再試行します。キャッシュは Container の作成（`open()` 中のサイズ変更を含む）で新しくなり、close の後始末と Container の差し替えで破棄されます。古い描画結果・古い generation・レイアウト変更後の結果は書き込み自体が破棄されるため、キャッシュにも記録されません。全スロット描画では空でない値の書き込みを決してスキップしないので、表示アイテムが出ない・消えることはありません。`setUpperGui()` の後も物理スロットの実際の内容についての記録として有効です。
- **書き込みキャッシュの前提と限界**: キャッシュは「その Container に書くのはこの Window だけ」という前提で、空→空の書き込みだけを省きます。そのため、itemChange を転送しないアダプタ（`subscribeItemChange` 未実装）や `window.container` を直接書き換える外部コードがあると、本来空にするスロットに外部のアイテムが残る可能性があります（表示のずれであり、この省略によるアイテムの消失・複製はありません）。自分の player の itemChange は再描画停止と close でキャッシュを破棄し、別 player の itemChange（この Window は無視して描画を続ける）ではキャッシュ全体を破棄します。実機未検証です。

## 開いている Window の GUI 差し替えと非同期プレースホルダー

`Window.setUpperGui(gui)` は、開いている Window の upper GUI を、既存の Container と画面を維持したまま差し替えます。差し替え後はレイアウトを再評価し、要素が変わったスロット（と直前の書き込みに失敗したスロット）だけを描画して、旧 GUI と旧要素の購読を新 GUI に張り替えます。Container は作り直しません。閉じている・まだ開いていない Window では、次回の `open()` に使う GUI を置き換えるだけです。

- **同じ Container サイズ・同じ state schema**: その場で差し替えます。要素が変わったスロットと、直前の `setItem()` に失敗したスロットだけを Provider から再評価して描画し、変わっていないスロットの表示と購読は維持します（設計 8.4 の差分更新）。同じスロットの同じ Item は viewer と Window の状態が同じなら同じ結果になる、という前提です（provider がそれ以外を読む場合は `notifyWindows()` を呼んでください）。schema の同一性は、GUI 種別・Structure 行・スクロール設定・タブ・`GuiLink` の子 GUI を再帰的に含む識別子で判定します。Structure 行が同じなら幅・高さも同じなので、論理スロットの物理位置は変わりません。
- **サイズが違う**: Container の `size` は生成後に変更できないため適用しません。エラーハンドラーへ `guiChange` として報告し、**現在の GUI・Container・購読をそのまま維持**します。新しいサイズを適用するには Window を開き直してください。この制限は `setUpperGui()` の経路のもので、state や GUI の変更による再評価でサイズが変わった場合は下記の再生成を使います。
- **state schema が違う**: 取得済みの state が新しい GUI の形を説明しなくなるため、`WindowStateSchemaChangedError`（`INVUI_STATE_SCHEMA_CHANGED`）を報告して再描画を停止し、close します（fail closed）。GUI の構造変更と同じ経路です。
- **レイアウトの Container サイズが変わる（別サイズのタブへの切替など）**: `refresh()`・状態変更・GUI 変更の再評価で Container の `size` が変わった場合、`setTitle()` と同じ経路で新しい Container を生成して全スロットを描画してから旧画面を閉じ、新しい画面を開きます。state・購読と open/close ハンドラーは維持し、生成に失敗した場合は `operation: "resize"` として報告して現在の Container・画面を維持します。幅だけが変わって Container サイズが同じ場合は Container を維持したまま再描画し、旧レイアウトが使っていた 9 列のうち新しい幅の外側の列を空にします。

```ts
window.setUpperGui(nextGui); // 同じサイズ・同じ schema のときだけ反映される
```

`Item.setPlaceholder(stack)` と builder の `.setPlaceholder(stack)` は、非同期 provider が解決するまでの間に表示する `ItemStack` を設定します。設定値は clone して保持し、`undefined` で解除します。`getPlaceholder()` はコピーを返します。

- provider が同期のときは使われません。
- **placeholder 未指定**: 従来どおり、`open()`・`refresh()`・再描画は provider の promise 解決まで待ちます。
- **placeholder 指定あり**: promise を待たずに placeholder を表示し、解決後に同じスロットを最終結果で更新します。`open()` は待たされません。解決が遅れて close・再描画・レイアウト変更・同じスロットの新しい解決が起きた場合、古い結果は書き込まずに破棄します。解決に失敗した場合は placeholder を含む直前の表示を残し、エラーハンドラーへ `itemProvider` として報告します。
- builder では `Item.builder().setItemProvider(...).setPlaceholder(stack).build()` のように指定できます。

```ts
const loading = new ItemBuilder("minecraft:clock").setName("読み込み中").build();

const item = Item.builder()
  .setItemProvider(async (viewer) => await fetchIcon(viewer))
  .setPlaceholder(loading)
  .build();

item.setPlaceholder(undefined); // 解除
```

`setUpperGui()` の差し替えと placeholder はどちらも Node.js テスト済みですが実機未検証です。**実機のアイテム保護・操作制限ではありません。** placeholder は非同期解決中の見た目を変えるだけで、プレイヤーの取り出しや変更を防ぎません。

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
- `fromVersion` / `fromSchema` / `schema` は必須です。`fromVersion` と `fromSchema` は保存済みレコードの version/schema と完全一致しなければ `VERSION_MISMATCH` / `SCHEMA_MISMATCH` で拒否され、`schema` は移行後のレコードに記録されます。すでに現在の version/schema と同じ組み合わせは「移行不要」として拒否されます。`fromSchema: null` は schema を持たない古い形式を表します。設計 9.6 形式（`lifetime` / `schema` を持たない）レコードは、`migrate()` と `acquire()` の両方で「保存期間 `persistent`・schema なし」として読むため、`acquire()` に既定の schema（`"default"`）を渡すと（version が現行なら）`SCHEMA_MISMATCH` になり、`fromSchema: null` の自動移行（`schema` は取得時の値）を宣言した場合だけ救済されます。`fromVersion` は保存値と一致させてください。明示的に `lifetime` / `schema` を持つレコードは従来どおり完全一致が必要です。
- `acquire()` の前、または同じ identity のハンドルをすべて `release()` した後に呼びます。表示中の状態や、`persistent` 以外で登録中の identity は `LIVE_STATE` で拒否されます。
- **migration 実行中の同一 identity は再入できません。** コールバックとストア書き込みの間、その identity の `acquire()` と `migrate()` は `LIVE_STATE` の `StateConflictError` で失敗します。他の identity は影響を受けません。コールバックが例外を投げてもロックは解放されます。
- コールバックにはデコード済みの旧レコードがそのまま渡されます。戻り値は現在の `GuiState` として検証・複製され、`STATE_STORAGE_VERSION` と指定した schema で上書き保存されます。
- コールバックまたは検証が失敗した場合、`StateManager` はストアに書き込みません。ストア書き込みの失敗時はロールバックされず、結果はストアの実装に依存します（次項参照）。失敗前に解放済みのメモリ上の entry は破棄されるため、次回の `acquire()` はストアから読み直します。壊れた JSON はコールバックに渡さず `StateCorruptionError` で失敗します。
- **注入した外部 `StateStore` の失敗時の状態は、その実装の原子性に依存します。** `StateManager` は 1 レコードにつき `setItem()` を 1 回だけ呼び、失敗したときに再試行・ロールバック・部分書き込みの検出を行いません。したがって、`setItem()` が途中で失敗して値を部分的に残すストア実装では、**部分的な書き込みが残る可能性があります**。`BedrockWorldStateStore` は 1 つの動的プロパティへの単一 `setDynamicProperty()` 呼び出しですが、エンジン側で失敗したときに書き込みが残らないかは実機未検証です。
- 自動移行は、`StateManager` の `migrations` に宣言したものだけを `acquire()` が適用します。宣言は identity・`fromVersion`・`fromSchema`・移行後 `schema` の完全一致が必要で、対象は `persistent` レコードだけです。宣言のない version/schema 不一致は従来どおり `StateConflictError` で拒否します。設計 9.6 形式（`lifetime` / `schema` なし）のレコードは `persistent`・schema なしとして読むため、`fromSchema: null` の宣言が一致します。破損レコード（デコード不能な JSON、不正な `guiState`）の自動退避・復旧は `StateManager` の `quarantineCorrupt: true` を指定した場合だけ `acquire()` が行い、version/schema 不一致は対象外です。

```ts
const states = new StateManager(store, {
  migrations: [
    {
      ownerId: player.id,
      key: "shop",
      fromVersion: 0,
      fromSchema: null, // schema なしの旧形式
      schema: "shop-v2",
      migrate: (legacy) => ({ page: (legacy as any).guiState?.pageNo ?? 0 }),
    },
  ],
});

// acquire() が一致する旧レコードを検証後に 1 回だけ書き換え、その状態で再開する。
const state = states.acquire({
  ownerId: player.id,
  key: "shop",
  lifetime: "persistent",
  schema: "shop-v2",
});
```

自動移行の制約:

- 一致する宣言が複数ある組み合わせは、`StateManager` の生成時に `StateValidationError` で拒否されます。
- コールバックの例外・戻り値の検証失敗ではレコードを変更しません。コールバックは `StateManager.migrate()` と同じ identity ロックの下で実行され、再入 `acquire()` / `migrate()` / `remove()` は `LIVE_STATE` で失敗します。
- ストア書き込みの失敗はロールバックされません（次項参照）。

```ts
const states = new StateManager(store, {
  quarantineCorrupt: true, // 壊れた生値を ...:quarantine に退避して initial から再開
  onError: (error) => console.warn("InvUI state recovery", error),
});
```

退避は元キーの `...:quarantine`、使用済みなら `...:quarantine:2`、`...:quarantine:3` と空きキーへ行い、元キーを削除してから `initial` を保存します。退避の書き込みに失敗した場合は元レコードを残したままストアのエラーを投げ、復旧は行いません。
- `StateManager.remove({ scope?, key?, ownerId? })` で、その identity の永続レコードを削除できます。壊れた JSON や schema 不一致で `acquire()` が拒否するレコードを、初期状態からやり直すための明示操作です。格納値はデコード・検証せずに削除し、レコードが存在しなくてもエラーになりません。注入した `StateStore` が必要です。ハンドルが残っている状態、`persistent` 以外で登録中の identity、migration 実行中の identity は `LIVE_STATE` で拒否されます。ゼロハンドルの `persistent` entry は削除前に破棄されるため、`removeItem()` が失敗しても次回の `acquire()` はストアから読み直します。
- Window の state schema は GUI 種別・Structure 行・スクロール設定・タブ・`GuiLink` の子 GUI を再帰的に含む JSON 文字列から作る識別子です。Window を開いた後にこの構造が変わると、その Window は `WindowStateSchemaChangedError` を報告して close し、古い schema で新しい状態を保存しません。古い schema token のレコードは、一致する自動移行を宣言していない限り自動変換されず、移行する場合は `migrations` か `fromSchema` にその文字列を指定します。
- `BedrockWorldStateStore` は、キーを `%:` の世代 prefix に続けて固定幅の `%XXXX` 形式でエンコードした動的プロパティ識別子を使います（安全な ASCII はそのまま、それ以外は 1 UTF-16 コード単位 = `%` + 16 進4桁）。`%:` は旧エンコーダが生成しないため、新旧の識別子空間は分離されます。識別子は 1024 文字、値は UTF-8 換算で 32,767 バイトを既定の上限として、書き込み前に拒否します（`maxIdentifierLength` / `maxValueLength` で変更可）。32,767 はコミュニティ情報に基づくローカルガードで、エンジンの実上限は未検証です。文字列以外の保存値も拒否します。
- **以前の可変幅パーセントエンコード（例 `%E9`）で保存した動的プロパティは、このエンコーダでは読みません。** 現在の識別子が存在せず、旧エンコードの識別子に値がある場合、`LEGACY_IDENTIFIER_CONFLICT` で失敗し、旧エンコード側の値は返さず、どちらのプロパティも変更しません。旧エンコードは単射ではなく別キーの値と衝突し得るため、値をこのキーに帰属できません。手動で調査・移行してください。

## インベントリのシリアライズ（任意・実機非依存）

`VirtualInventory` は、永続化のために明示的な `InventoryItemCodec` で JSON 可能なスナップショットへ変換できます（設計 4.3 / 9.6）。Bedrock の `ItemStack` は component・dynamic property・タグなどを一つの値として全列挙できないため、既定の codec はありません。保持する情報は呼び出し側が codec で決めます。

```ts
import { ItemBuilder, VirtualInventory, type InventoryItemCodec } from "invui-bedrock";

interface PlainItem {
  typeId: string;
  amount: number;
}

const codec: InventoryItemCodec<PlainItem> = {
  encode: (item) => ({ typeId: item.typeId, amount: item.amount }),
  decode: (value) => new ItemBuilder(value.typeId, value.amount).build(),
};

const snapshot = inventory.serialize(codec); // 空スロットは含まない
const restored = VirtualInventory.deserialize(snapshot, codec);
```

**codec は情報を落とし得ます。** `ItemStack` の全状態は列挙できないため、codec が保存対象にしない component・dynamic property・タグ・名前・lore などは失われます。復元されるのは codec が encode で書き出し、decode で戻せる情報だけであり、元の `ItemStack` と同一にはなりません。上の例は typeId と個数だけを保存するので、名前・lore・component などは失われます。何を保持するかは呼び出し側の明示的な選択です（既定 codec は提供しません）。必要な情報を codec に追加してください。

`serialize()` は最初の `encode()` 呼び出しより前に全占有 slot の `ItemStack` を clone して固定するため、encode 中に codec がインベントリを変更しても、2 つの時点が混ざったスナップショットにはなりません。各 `encode()` の戻り値は strict な JSON 検証と deep clone を通します。`JSON.stringify` が黙って書き換える値（入れ子の `undefined`、`NaN` / `Infinity`、疎配列、配列の非インデックスキー、オブジェクトのシンボルキー・非列挙プロパティ・getter、`toJSON`、循環参照）は拒否します。

`deserialize()` は、decode や書き込みを始める前にスナップショット全体を strict な JSON として検証・deep clone します。そのため decode が呼び出し側のスナップショットを変更できず、不正なスナップショットから部分的に復元されたインベントリを返すこともありません。検証は snapshot の version・size・slot 範囲・重複 slot に加え、各 slot エントリが `slot` と `item` の両方を持つことを含みます。`item` を欠いたエントリは空 slot と解釈せず拒否します。decode の戻り値は `clone()` を持つ `ItemStack` として検証し、不正なら拒否します。実機に依存しないロジックですが、実機での永続化は未検証です。

## プレイヤーインベントリ（読み取り専用・実機未検証）

`PlayerInventory` は、プレイヤーの実インベントリ（`player.getComponent("inventory").container`）を `Inventory` として読むアダプタです（設計 3.6 / 7.4）。`InventoryLink` と組み合わせて、プレイヤー自身のスロットを upper GUI に表示できます。`src/index.ts` から公開しています。

```ts
import { InventoryLink, PlayerInventory } from "invui-bedrock";

const inventory = new PlayerInventory(player); // 読み取り専用。変更通知は接続しない
const link = new InventoryLink(inventory, 0);  // スロット 0 を GUI 要素として表示
```

- **読み取り専用です。** `getItem(slot)` は clone を返し、`slot` が非整数・負数・`size` 以上なら `RangeError` を投げます。`setItem()` と `clear()` は常に `PlayerInventoryReadOnlyError`（`INVUI_PLAYER_INVENTORY_READ_ONLY`）を投げ、実コンテナへは書き込みません。`PlayerInventory.writable` は `false` 固定です。
- **生成時の検証**: `new PlayerInventory(player, options)` は、`player.id` を空でない文字列として読めない場合に `TypeError`、`getComponent("inventory")` かその `container` を読めない場合に `Error` を投げます。`options` がオブジェクトでない場合、`changes` が `subscribe()` を持たない場合も `TypeError` です。`size` はそのコンテナの実際のサイズです。
- **移動はできません。** `PlayerInventory` を `InventoryLink` に渡すと、`link.setItem()` は `PlayerInventoryReadOnlyError` で失敗し、`link.moveTo()` は移動自体が無効なため `InventoryLinkMoveRejectedError` を投げます。`PlayerInventory` は `Inventory` の書き込みメソッドを実装していますが、それは `InventoryLink` の読み取り経路を通すためだけで、成功する書き込み経路ではありません。
- **変更通知は明示注入だけです。** Bedrock には、このアダプタが使う絶対スロット番号と一致することを保証する文書化された変更イベントがありません（`PlayerInventoryType` は hotbar と main inventory を分け、インデックス空間は未規定）。そのため自動接続はせず、`new PlayerInventory(player, { changes: source })` のように、イベントから絶対スロットへの変換を確認済みの `PlayerInventoryChangeSource` を呼び出し側が渡します。
- **任意のイベントブリッジ（`createPlayerInventoryChangeSource`）も用意しています。** `world.afterEvents.playerInventoryItemChange` を購読し、呼び出し側が渡した `mapSlot(inventoryType, slot)` の結果を絶対スロットとして転送します。対応表は Bedrock のドキュメントにないため、**実機で確認した mapper を明示的に渡す必要があり、既定の mapper はありません**（未検証の例をそのまま使わないでください）。このブリッジは通知の転送だけで、コンテナへの読み書き・アイテム移動は一切しません（`PlayerInventory` は読み取り専用のまま）。player id を読めないイベント、mapper の例外・非整数・負数の結果、`undefined` を返したイベントは破棄します。`createPlayerInventoryChangeSource` も `src/index.ts` から公開しています。**実機未検証です。**

```ts
const inventory = new PlayerInventory(player, { changes: verifiedSource });
```

イベントから接続する場合（`mapSlot` は実機で確認した対応だけを書く）:

```ts
import { createPlayerInventoryChangeSource, PlayerInventory } from "invui-bedrock";
import { world } from "@minecraft/server";

const changes = createPlayerInventoryChangeSource(
  world.afterEvents.playerInventoryItemChange,
  (inventoryType, slot) => (inventoryType === "Hotbar" ? slot : slot + 9), // 例。実機未検証
);
const inventory = new PlayerInventory(player, { changes });
```

- **イベント解除は `subscribe()` の戻り値ではなく `signal.unsubscribe(callback)` で行います。** beta の `PlayerInventoryItemChangeAfterEventSignal.subscribe()` は解除関数ではなく**渡したコールバック自身**を返します（型も `(arg0: PlayerInventoryItemChangeAfterEvent) => void`）。戻り値を解除関数として呼ぶと、リスナーが解除されないまま偽イベントとして再実行されるため、ブリッジは戻り値を無視して `unsubscribe(callback)` を呼びます。ブリッジが返す購読解除関数は冪等で、二重解除でも `unsubscribe` は一度しか呼びません。`subscribe()` / `unsubscribe()` を持たない signal、関数でない `mapSlot`、関数でない listener を渡した場合も購読前に `TypeError` を投げ、`PlayerInventory` 側は `console.error` に記録して表示を継続します。
- `PlayerInventoryChangeSource.subscribe(listener)` は購読解除関数を返す必要があります。`changes` を省略した場合、`subscribe()` は購読解除関数を返しますが**一度も発火しません**（表示は `refresh()`・状態更新・GUI 変更時の再描画で更新されます）。
- 注入した source が投げた例外、購読解除関数を返さない場合、購読解除時の例外は `console.error` に記録し、表示は継続します。最後の購読者が解除されると source の購読も解除します。
- source から届いた変更のうち、`playerId` がこのインスタンスの `playerId` と一致し、`slot` が整数で `0 <= slot < size` のものだけを転送します。`previous` / `current` は clone して渡し、リスナーの例外は `console.error` に記録して他のリスナーへの配送を続けます。
- **実機未検証です。** 実装とテストは Node.js 上のモックに対するもので、実機で `getComponent("inventory").container` から同じスロット番号で読めるか、注入した source のマッピングが正しいかは確認していません。`size` はコンテナの実際のサイズで、固定の 36 ではありません。実機のアイテム保護・移動の安全性を提供するものではありません。

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

`init` は**既存パックを対象にした検査コマンド**で、既定では Behavior Pack / Resource Pack を変更しません。`--install-resource-pack` を明示した場合だけ、未検証のプローブ `ui/invui.json` と接続用 `ui/invui_connect.json` / `ui/invui_connect_data_driven.json` の3ファイルを既存 Resource Pack に追加します。既存の `ui/_ui_defs.json` は既定で変更しないため、登録するまで接続は有効になりません。`--install-resource-pack` と `--register-ui-defs` を**両方**明示した場合だけ、事前検査を通ったときに `_ui_defs.json` へ不足エントリを追記します（詳細は「[`--register-ui-defs` による追記](#--register-ui-defs-による-_ui_defsjson-追記オプトイン)」）。`generate-resource-pack` は既存パックを対象にせず、`--output` で指定した**まだ存在しないディレクトリ**へ、同梱テンプレートから独立した実験用 Resource Pack を新規生成します（`init` とは別コマンドで、`init` 用オプションは受け付けません）。生成物の `ui/_ui_defs.json` は3ファイル登録済みで、接続が既定で有効です。いずれも `chest_screen` は編集しませんが、生成物・登録後のパックは `data_driven_container` のパネルを使う全画面に影響し得ます。`package.json` の `bin` には登録されていますが、npm 未公開のため現時点ではリポジトリ内で直接実行します。

```bash
# 既定: 読み取り専用の静的検査
node bin/cli.js init \
  --behavior-pack ./behavior_pack \
  --resource-pack ./resource_pack

# 明示した場合だけ ui/invui.json を追加（既存ファイルは上書きしない）
node bin/cli.js init \
  --resource-pack ./resource_pack \
  --install-resource-pack

# さらに明示した場合だけ _ui_defs.json へ不足分を追記（バックアップ付き）
node bin/cli.js init \
  --resource-pack ./resource_pack \
  --install-resource-pack \
  --register-ui-defs

# 存在しない出力先に実験用 Resource Pack を新規生成
node bin/cli.js generate-resource-pack --output ./invui-probe-pack
```

### コマンドとオプション

| 指定 | 内容 |
|---|---|
| `init` | 既存の Behavior Pack / Resource Pack を静的に検査し、手動で必要な作業を表示する。既定では書き込まない |
| `generate-resource-pack --output <dir>` | 既存パックを変更せず、新しい出力先へ `manifest.json`・`ui/_ui_defs.json`・`ui/invui.json`・`ui/invui_connect.json`・`ui/invui_connect_data_driven.json` の5ファイルを生成する。生成物の `_ui_defs.json` は3ファイル登録済みで接続が既定で有効。UUID（`header` と各 module）は生成のたびに作り直す |
| `--behavior-pack <dir>` | `init` 用。Behavior Pack のルート。`--install-resource-pack` 指定時は省略可 |
| `--resource-pack <dir>` | `init` 用。Resource Pack のルート。必須 |
| `--install-resource-pack` | `init` 用。プローブ `ui/invui.json` と接続用 2 ファイルの計3ファイルを追加する（明示時のみ）。既存ファイルは上書きせず、内容が異なる場合は競合として中断する。既存の `ui/_ui_defs.json` は変更せず、登録するまで接続は有効にならない |
| `--register-ui-defs` | `init` 用。`--install-resource-pack` との併用が必須（単独指定は引数エラー）。既存 `ui/_ui_defs.json` の `ui_defs` 配列へ、未登録の3エントリだけを追記する。追記前に同一ディレクトリへバックアップを作り、JSON として読めない・`ui_defs` が配列でない・競合時は書き込まず中断する。既に全部登録済みなら何も書かない。追記する場合は `JSON.stringify` で再整形される |
| `--output <dir>` | `generate-resource-pack` 専用・必須。既存パス、既存パス上のファイル、シンボリックリンク、ファイルシステムのルートは拒否し、上書きしない。`init` に指定すると引数エラー |
| `--json` | 検査結果と導入結果を JSON として標準出力へ出す |
| `-h`, `--help` | 使い方を表示する |
| `-v`, `--version` | バージョンを表示する |

`generate-resource-pack` は `--behavior-pack` / `--resource-pack` / `--install-resource-pack` / `--register-ui-defs` を受け付けません（指定すると引数エラー）。`--output` 先が既に存在する場合も、既存のファイルとディレクトリは一切変更せず、生成しません。生成中に失敗した場合は、この CLI がその実行で作成したファイルとディレクトリだけを削除し、他プロセスが置いたファイルは消しません。

`check` は設計書にある将来案であり、まだ仕様確定していません。CLI が受け付けるコマンドは `init` と `generate-resource-pack` です。`--install-resource-pack` を指定しない `init` は静的検査だけを行います。`--register-ui-defs` はそれに加えて `--install-resource-pack` の明示が必要で、どちらかを欠くと書き込みません。

### CLI が行うこと

- `manifest.json` の存在と JSON としての読み込みを検査する。
- Behavior Pack の script モジュール、`entry` の有無、`@minecraft/server` への dependency を確認する。
- Resource Pack の `ui/` ディレクトリと、既存の `chest_screen.json` / `invui.json` / `invui_connect*.json` / `_ui_defs.json` の有無を報告する。
- 未検証機能と、手動で確認すべき手順を表示する。
- `--json` 指定時は、検査結果と導入結果を JSON として標準出力へ出す。
- `--install-resource-pack` 指定時だけ、`ui/invui.json`・`ui/invui_connect.json`・`ui/invui_connect_data_driven.json` の3ファイルを次の安全側の手順で追加する。既存の `ui/_ui_defs.json` は変更せず、登録状況（登録済み／不足）を報告するだけで、登録するまで接続は有効にならない。
  - 既存ファイルの内容が同梱テンプレートと同一なら「導入済み」と報告し、書き換えない。
  - 内容が異なる場合は競合として中断し、差分を表示して終了コード `1` を返す。
  - 一時ファイルへ書いてから排他的に配置し、失敗時は追加済みファイル・一時ファイル・この CLI が作成した空ディレクトリを削除する**ロールバックを試みる**。
  - ただしロールバックは失敗しうる。削除権限がない、他プロセスがファイルを置き換えた、などの場合は削除できず、**部分適用が残る可能性がある**。その場合はエラーメッセージに削除できなかった理由が含まれるので、対象の `ui/invui.json` と作成されたディレクトリを手動で確認・削除する。
  - `npm test` はシミュレートした失敗経路でロールバックを確認するが、すべてのファイルシステム障害を再現するものではない。
  - `ui/` にシンボリックリンクがあるなど、パック外へ書き込むおそれがある経路は拒否する。

### `--register-ui-defs` による `_ui_defs.json` 追記（オプトイン）

`--register-ui-defs` は**既定では何も変えない**オプトインの追記機能です。`init` に指定しなければ `ui/_ui_defs.json` は読み取りだけで、登録状況（登録済み／不足）を報告します。追記が起きるのは `init --install-resource-pack --register-ui-defs` を両方明示した実行だけです。`--register-ui-defs` 単独は引数エラー、`generate-resource-pack` はこのフラグ自体を受け付けません（生成物の `_ui_defs.json` は元から3ファイル登録済み）。

**追記する内容**

- 対象は同梱の3エントリ `ui/invui.json`・`ui/invui_connect.json`・`ui/invui_connect_data_driven.json` で、`ui_defs` 配列に**未登録のものだけ**を既存要素の末尾へ追加します。既存エントリは削除・並べ替えしません。
- 3つとも登録済みなら「登録済み」と報告し、ファイルもバックアップも作りません。
- 追記はテンプレート3ファイルの配置が終わった後に行い、追記に失敗した場合は追加済みファイル・一時ファイル・作成した空ディレクトリもロールバックします。

**既存 def の安全検査（書き込み前）**

追記の可否は、テンプレートを1ファイルも追加する前に検査します。次のいずれかに当たると「競合」として中断し、終了コード `1` を返して `_ui_defs.json` もテンプレートも変更しません。

- `ui/_ui_defs.json` が存在しない（この機能は既存ファイルへの追記専用。新規作成には `generate-resource-pack` を使う）。
- 導入先の経路にシンボリックリンクがある、または `_ui_defs.json` が通常ファイルでない（パック外へ書き込まないため）。
- JSON として読めない、ルートがオブジェクトでない、`ui_defs` が配列でない、`ui_defs` に文字列以外の要素がある。

**バックアップと復元**

- 追記の直前に、`_ui_defs.json` と同じディレクトリへ `<ファイル名>.invui-backup.<pid>.<乱数>.bak` を排他的に作成します。内容は追記前のバイト列そのものです。
- 一時ファイルへ書いてから rename で置き換えます。バックアップ作成後と rename 直前の2回、別プロセスが `_ui_defs.json` を変更していないかを内容比較で確認し、変わっていれば書き込まずに中断します。
- 追記に失敗した場合、一時ファイルを削除し、`_ui_defs.json` が元のままならバックアップも削除します。元と異なる場合はバックアップを残し、そのパスをエラーに含めます。
- 成功時は人間向け出力と `--json` の `resourcePackInstall.restore` に `cp "<バックアップ>" "<_ui_defs.json>"` 形式の復元コマンドを出します。復元すると追記分は消え、**追記後に手で加えた変更も失われます**。
- `--json` では `resourcePackInstall.status`（`installed` / `already-installed`）、`uiDefs.action`（`registered` / `already-registered` など）、`added`、`missing`、`backup`、`restore` を返します。

**JSON の再整形**

追記時は `JSON.parse` した内容を `JSON.stringify` で作り直します。既存のキー順と `ui_defs` の並びを保ち、インデント・改行コード（LF / CRLF）・末尾改行の有無は可能な範囲で合わせますが、空白やエスケープなどの元の書式は完全には保持されません。正確に戻したい場合はバックアップから復元してください。

`npm test` は、追記とバックアップ、再実行で何も書かないこと、壊れた JSON でテンプレートごと中断すること、追記失敗時のロールバックを確認します。

### CLI が行わないこと

- **既存 Resource Pack の `ui/_ui_defs.json` を既定では変更せず、接続を自動で有効化しない。** `--install-resource-pack` が追加するのは `ui/invui.json` と接続用 2 ファイルの計3ファイルで、`ui_defs` への登録は既定で手動です（CLI は登録状況を検査して不足を報告します）。`--register-ui-defs` を併用して明示した場合だけ、事前検査を通ったときに不足分をバックアップ付きで追記します。`generate-resource-pack` は同梱の `_ui_defs.json`（3ファイル登録済み）を使って接続済みの独立パックを作りますが、`chest_screen` は編集せず、`data_driven_container` のパネルを使う全画面へ影響し得る未検証の接続です。
- **`generate-resource-pack` は既存のパックやパスを変更しない。** 出力先が存在する場合は生成自体を行わず、既存のファイル・ディレクトリ・シンボリックリンクに触れません。生成するのは `manifest.json` / `ui/_ui_defs.json` / `ui/invui.json` / `ui/invui_connect.json` / `ui/invui_connect_data_driven.json` の5ファイルだけです。
- **既存の `chest_screen.json` を上書きしない。** 競合を検出した場合は報告だけ行います。
- **`_ui_defs.json` を自動で書き換えるのは `--register-ui-defs` の明示時だけ。** その場合も追記のみで、既存エントリの削除・並べ替えは行いません（ファイル全体は JSON として再整形されます）。未指定時の参照追加は手動マージの対象です（`generate-resource-pack` は新しいパック内に自身の `_ui_defs.json` を作ります）。
- **アイテム保護・入力抑制・画面終了処理を提供しない。** 追加するのは JSON UI の部品だけで、表示アイテムの取り出し、`button.send` の受信、VirtualContainer の識別は実装していません。導入しても安全にはなりません。
- **既存の `manifest.json` を変更せず、Behavior Pack へも書き込まない。**
- **`--register-ui-defs` の追記以外でバックアップや復元を自動化しない。** 手動で UI をマージする場合は、利用者がバックアップを取ってください。

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
- チェスト画面のボタン押下が `!invui:` チャット通知を生むかの未検証観察プローブ（単体 RP・自動 payload なし・通常チェストにも影響し得る・使い捨てワールド専用・他の RP と同時併用しない）: [tests/manual-bedrock/button-send-resource-pack/README.md](tests/manual-bedrock/button-send-resource-pack/README.md)

CLI の安全側の動作は、次のコマンドで自動確認できます（`npm test` にも含まれます）。

```bash
node --test tests/manual-bedrock/cli.test.mjs
```

このテストは、既定ではパックを変更しないこと、`--install-resource-pack` 指定時も `ui/invui.json`・`ui/invui_connect.json`・`ui/invui_connect_data_driven.json` の3ファイル以外を書き換えず既存ファイルを上書きしないこと、`--register-ui-defs` が単独では拒否され、併用時だけ不足分をバックアップ付きで追記して再実行では何も書かないこと、壊れた `_ui_defs.json` ではテンプレートごと中断すること、追記失敗時はロールバックすること、`generate-resource-pack` が5ファイルを生成して `_ui_defs.json` に3ファイルを登録すること、壊れた manifest で失敗することなどを確認します。実機の入力・表示・アイテム安全試験の代わりにはなりません。

### 実機検証が終わるまで正式機能として扱わないもの

| 機能 | 現状 | 扱い |
|---|---|---|
| `Window.open()` による画面表示 | コード上は既定で有効・実機未検証 | 実アダプタは `canOpenScreens = true` で `VirtualContainer.open()` を呼ぶ。実機での表示・入力・アイテム保護は未確認のため、実在ワールドでの利用は推奨しない |
| close / itemChange のアダプタ購読 | 既定アダプタが `afterEvents.virtualContainerClose` / `virtualContainerItemChange` を購読。Node.js テストで経路を確認済み・実機未検証 | 実機ライフサイクル・入力・アイテム保護として扱わない。`after` なので close・変更を防げない |
| 退出・死亡・次元変更・スペクテイター・shutdown時の自動 close（`world.afterEvents.playerLeave` / `world.afterEvents.entityDie` / `world.afterEvents.playerDimensionChange` / `world.afterEvents.playerGameModeChange` / `system.beforeEvents.shutdown`） | `Window` が最初の `open()` でそれぞれ 1 本購読し、退出したプレイヤーの Window（`opening` / `open`）を `PlayerLeft` で、死亡した entity の id が viewer id と一致する Window だけを `PlayerDied` で close する。次元変更は `ServerClosed`、`toGameMode` が `Spectator` のときだけ `PlayerSpectating` で close する（どちらもプレイヤーが有効なのでアダプタにも close を要求する）。shutdown では `opening` / `open` の全 Window を `ServerClosed` で close する。Node.js テスト済み・実機未検証。自動再オープンはしない | 実機でイベントが届くか、close が成功するかは未確認。プレイヤー以外や他プレイヤーの死亡、他プレイヤーの次元変更、Spectator 以外のゲームモード変更は対象外。shutdown のコールバックは restricted execution のため、`VirtualContainer.close()` とアダプタのイベント購読解除は呼ばず、画面・アダプタ購読の破棄はエンジン任せになる。close ハンドラーも同じ制約下で実行される。スクリプト再読み込みの後始末の代替にはしない |
| クリック通知（`button.send` → チャット候補を含む） | `Window` が最初の `open()` で `world.beforeEvents.chatSend` を購読し、`!invui:` 行を `handleClick()` へ流す経路のみ自動接続（Node.js テスト済み・実機未検証）。UI 側の payload の自動生成は未実装（JSON UI から slot/session/sequence を渡す書式は公式構造から確認できない）。手入力の静的ペイロードプローブはオプトインで同梱（既定未登録）、行は手入力で偽装可能、rate limit は既定 100 ms（`minIntervalMs: 100`）、時刻ベースの期限なし | クリックの証明・認証としては使えない。安全に利用不可。有効な機能として案内しない |
| 表示専用・ボタン用スロットのアイテム保護 | 実装なし・実機未検証。`Item.getMode()` / `setMode()` は分類とハンドラー実行ガードのみ | 安全に利用不可。アイテム移動を許可しない |
| JSON UI による入力抑制・画面識別 | `resource_pack/` は既定で `data_driven_container` の desktop/pocket パネルへ接続し、透明ブロッカーを重ねるが実機未検証。VirtualContainer を識別する仕組みはなく、遮断が成立する保証もない | 同パネルを使う他の画面にも表示・入力が干渉し得る。ボタンや inventory slot も制限し得るが、プレイヤー側や controller 入力の遮断は保証されない。安全に利用不可 |
| `InventoryLink` のアイテム移動 | 実装なし。`moveTo()` は常に例外 | 複製・消失の可能性を排除できないため無効 |
| 左・右・Shift・ダブルクリックの区別 | 初期リリース非目標 | 通常クリックのみを設計対象とする |

設計書の合格条件（InvUI 画面だけに適用される、通常チェストが壊れない、表示アイテムを持ち出せない、通知が 1 回だけ届く、通知からプレイヤーとスロットを特定できる、アイテムが消失・複製しない、PC・タッチ・コントローラーで成立する、終了後の遅延入力が処理されない）を満たすまで、クリック機能を正式機能として公開しません。

### 実機画面は既定で開く（使い捨てワールドで）

- **既定の実アダプタが実画面を開きます。** `minecraftVirtualContainerAdapter` は `canOpenScreens = true` を返し、`Window.open()` は `world.virtualContainerManager.create()` で `VirtualContainer` を作成して `VirtualContainer.open()` を呼び、`Window.close()` は `VirtualContainer.close()` を呼びます。**実機で表示・close が成立するかは未検証**です。`close()` は要求時点で返り、実際の close イベントは別 tick になることがあるため、閉鎖直後の再 `open()` は失敗し得ます。
- **クリック通知は UI 側が生成しません。** `Window` は `world.beforeEvents.chatSend` を購読し、`!invui:` 行を `handleClick()` へ流す受け口だけを持ちます（Node.js テスト済み・実機未検証）。`resource_pack/` の `button.send` は通知を生成せず、購読スクリプトもありません。通知はプレイヤーが手入力でき、送信者 id 以外は偽装可能です。`Item` の `button` 分類はハンドラー実行ガードにすぎません。クリックの取りこぼし・遅延入力・意図しないスロットへの適用を保証できません。
- **透明ブロッカーは保護の保証ではありません。** 既定の接続はグリッド上へ透明なボタン（`invui_connect_probe.grid_blocker`）を重ね、スロット系入力を `button.invui_connect_blocked` へ付け替えますが、受け側のスクリプトはありません。実機未検証であり、**ボタンや inventory slot も制限し得る**一方で、**プレイヤー側や controller 入力の遮断は保証しません**。アイテム保護でもありません。
- **アイテム保護はありません。消失・複製事故の恐れがあります。** 表示専用・ボタン用スロットのアイテムは保護されておらず、プレイヤーが保護未検証の表示アイテムを取り出せます。取り出したあと、`refresh()`・状態更新・要素の更新通知による再描画が走ると、`container.setItem()` が同じアイテムを書き戻し、アイテムが複製される可能性があります。逆に、プレイヤーが入れたアイテムを再描画が上書きすると消失します。既定接続の透明ブロッカーは実機未検証の試みで、プレイヤー側や controller 入力の遮断を保証しません。ボタンや inventory slot も制限し得る一方、アイテム保護ではありません。このリスクは既定で有効です。
- **itemChange を検出しても保護はされません。** 既定の `minecraftVirtualContainerAdapter` は `subscribeItemChange` を実装して `world.afterEvents.virtualContainerItemChange` を購読しますが、これは Node.js テストで経路を確認しただけで実機未検証です。`after` イベントなので変更後の通知にすぎず、変更を取り消したり変更前のアイテムへ戻したりはできません。アダプタがイベントを渡した場合、`Window` は `WindowItemChangeDangerError` をエラーハンドラーへ通知し、再描画を停止して `close()` を要求します。ただし close 要求が実機で成功するか、画面が実際に閉じるかは未検証です。
- **実験は使い捨てのテスト用ワールドだけで行ってください。** `resource_pack/` を入れると、`data_driven_container` のパネルを使う全画面に警告ラベル・ボタン・透明ブロッカーが重なり得ます（VirtualContainer 限定ではない）。ブロッカーは実機未検証で、ボタンや inventory slot も制限し得ます。進行データのあるワールド、失いたくないアイテムを持つ環境、他のプレイヤーが参加するワールドでは実行しないでください。どうしても試す場合は、事前にワールド全体をバックアップし、終了後にインベントリとチェストのアイテム増減を確認してください。

## Resource Pack テンプレート（実験用・未検証）

`resource_pack/` には、単体の Resource Pack として構成した未検証のテンプレートを同梱しています。`ui/_ui_defs.json` は `ui/invui.json`・`ui/invui_connect.json`・`ui/invui_connect_data_driven.json` の3ファイルを登録済みで、**既定で接続が有効**です。`ui/invui_connect_data_driven.json` は `data_driven_container` の `desktop_panel` / `pocket_panel` の `controls` 先頭へ、警告ラベルと `invui_probe_root`（`invui_probe` 名前空間の可視ラベルと実験的な `button.send` 部品）を `insert_front` で差し込み、さらに末尾へ透明ブロッカー（`invui_connect_probe.grid_blocker`）を `insert_back` で差し込みます。`chest_screen` は編集していません。`button.send` を購読するスクリプトは同梱しておらず、チャット送信やアイテム保護を提供するものでもありません。

ただし **`VirtualContainer` を識別する仕組みはなく**、接続先のパネルを使う全画面（通常のコンテナや data-driven ブロックの画面を含み得る）に表示され得ます。そのため、他の画面での入力干渉・表示の重なり・アイテム保護の欠如というリスクが残ります。透明ブロッカーは実機未検証で、ボタンや inventory slot も制限し得る一方、プレイヤー側や controller 入力の遮断を保証しません。VirtualContainer 画面を使っているかは未確定です。**実機未検証であり、接続・表示・入力の遮断・アイテム保護のいずれも保証しません。** 他 Resource Pack との名前空間・UUID の衝突や、ゲーム側の JSON UI の解釈次第で挙動が変わる可能性があります。

- CLI の `--install-resource-pack` が追加するのは `ui/invui.json`・`ui/invui_connect.json`・`ui/invui_connect_data_driven.json` の3ファイルです。既存の Resource Pack へ追加した場合、`ui/_ui_defs.json` への登録は既定では行われず、手動でマージするまで接続は有効になりません（CLI は登録状況を検査して不足を報告します）。`--install-resource-pack` と併用して `--register-ui-defs` を明示した場合だけ、事前検査を通ったときに不足分をバックアップ付きで追記します。`generate-resource-pack` の生成物は `_ui_defs.json` 込みの5ファイルで、接続が既定で有効です。
- `ui/invui_controls.json` は**手入力の静的ペイロード送信プローブ**です。chat と同じ `#message_text_box` / `#message_text_box_content` と `button.send` を使い、`!invui:<session-id>:<slot>:<sequence>` の各値を手で入力して送信経路だけを観察します。session-id は開いた `Window._inputSessionId` を開発者側で取得し（[resource_pack/README.md](resource_pack/README.md) の「session-id の取得手順」）、open のたびに変わるため送信前に読み直します。slot / session / sequence の自動生成は行いません。既定の `_ui_defs.json` へは未登録で、キーボード入力を奪い得るため既定接続には含めません。CLI 導入対象外です。有効化手順・根拠・制約は [resource_pack/README.md](resource_pack/README.md) の「手動・静的ペイロード送信プローブ」を参照してください。
- `manifest.json` の UUID・version・`min_engine_version` はプレースホルダです。対象ゲーム版は未確定です。
- このテンプレートは `data_driven_container` 名前空間の `desktop_panel` / `pocket_panel` を変更します（`data_driven_container_screen.json` 自体は編集しません）。Mojang は同名前空間を変更しないことを期待し、後方互換性を保証していません。検証専用の実験にとどめ、正式機能や配布物の前提にしないでください（[data-driven 判定プローブ](tests/manual-bedrock/data-driven-resource-pack/README.md)）。
- 既存 Resource Pack との競合を検出・解消する機能はありません。**使い捨てワールドで、バックアップを取ってから**検証してください。詳細は [resource_pack/README.md](resource_pack/README.md) を参照してください。

Resource Pack を使わなくても、コアの型・レイアウト計算・状態管理は利用できます（Node.js 上で `@minecraft/server` をモックしたテストで確認済み）。既定の実アダプタは `Window.open()` で実画面を開こうとしますが、実機未検証であり、クリック入力・アイテム保護は動きません（既定接続の透明ブロッカーも遮断を保証しません）。

## 設計上の前提（実機未検証）

以下は設計書の方針です。実機で確認されるまで動作保証として読み替えないでください。

- `VirtualContainer` は Bedrock Preview/Beta の Experimental API で、メモリ上のコンテナであり、ワールドに保存されない。
- `size` と `title` は生成後に変更できないため、変更時は画面を開き直す。
- ワールド終了時は `system.beforeEvents.shutdown` で `opening` / `open` の Window を `ServerClosed` で close する（restricted execution のため `VirtualContainer.close()` とアダプタのイベント購読解除は呼ばず、画面・アダプタ購読の破棄はエンジン任せ）。スクリプト再読み込みは未対応で、この後始末は走らず、close ハンドラー・状態解放・永続化は保証されない。通常の終了イベントに依存した永続化はできない。
- プレイヤーの次元変更は `ServerClosed`、スペクテイターへの変更は `PlayerSpectating` で Window を close する（設計 13.1）。どちらも viewer id が一致する Window だけが対象で、自動再オープンはしない。
- 状態の共有範囲は `player` / `shared`、保存期間は `window` / `session` / `persistent`。
- 設計原則は影響を受けたスロットの差分反映だが、**現在の状態更新・明示 `refresh()` は全スロットを再評価する**（要素の更新通知のみ該当スロット）。状態更新・GUI 変更は 1 つの microtask にまとめて 1 回だけ描画し、同じタイミングの要素の更新通知はスロット単位でその flush に合流させる。理由と限界は「[差分描画の限界](#差分描画の限界状態更新)」を参照。
- JSON UI の変更は必要最低限とし、通常チェストへの影響を避ける（`resource_pack/` の既定接続はこの原則の例外で、`data_driven_container` のパネルを使う他の画面へ影響し得る。透明ブロッカーも同じ範囲に挿入され、検証専用）。
- **Mojang は `data_driven_container_screen.json` と `data_driven_container` 名前空間を変更しないことを期待し、後方互換性を保証していません**（Minecraft Preview 26.70.23 告知）。このため、この JSON / 名前空間の変更や、それに依存する入力・画面接続を前提にしません。`resource_pack/` の既定接続は同名前空間の 2 パネルへ差し込む検証専用の例外であり、正式機能の土台にはしません。[data-driven 判定プローブ](tests/manual-bedrock/data-driven-resource-pack/README.md)も、この変更を「どの画面が使われるか」の観察だけのために意図的に行う検証専用プローブです。`VirtualContainer` がこの画面を使うか自体も未確認です。
- `@bedrock-core/ui` には依存しない。

## ディレクトリ構成（現時点）

```text
InvUI-for-Bedrock/
├── package.json                  # 0.1.0-beta.1 / ESM / build・test・pack scripts
├── tsconfig.json
├── bin/
│   └── cli.js                    # 配布補助 CLI（静的検査・任意でプローブ導入）
├── resource_pack/                # 既定で data_driven 接続する未検証テンプレート（chest_screen は未編集）
│   ├── README.md
│   ├── manifest.json
│   ├── experimental/
│   │   └── connect-data-driven/  # 同じ接続の隔離コピー（単体パックではない）
│   └── ui/
│       ├── _ui_defs.json         # ui/invui.json と接続 2 ファイルを登録済み
│       ├── invui.json            # invui_probe 名前空間（ラベル・実験的 button.send 部品）
│       ├── invui_connect.json    # 警告ラベル + invui_probe_root のラッパー
│       ├── invui_connect_data_driven.json  # data_driven_container の desktop/pocket への modifications
│       ├── invui_controls.json   # 手動・静的ペイロード送信プローブ（オプトイン・未登録）
│       └── invui_controls_data_driven.json  # そのプローブの opt-in modifications
├── .github/
│   └── workflows/ci.yml          # GitHub Actions（build / test / pack）
├── src/
│   ├── index.ts                  # 公開エントリ（bedrock-store も公開）
│   ├── gui.ts                    # Structure / Gui / GuiLink / レイアウト計算
│   ├── item.ts                   # Item / ItemBuilder / クリックハンドラー / 周期更新
│   ├── periodic.ts               # system.runInterval を使う周期スケジューラ（内部）
│   ├── render-cache.ts           # 空→空の setItem を省略する書き込みキャッシュ（Window 内部）
│   ├── inventory.ts              # VirtualInventory / InventoryLink（移動は拒否）
│   ├── player-inventory.ts       # プレイヤーインベントリの読み取り専用 Inventory（変更通知は明示注入）
│   ├── json.ts                   # JSON 検証・複製（内部）
│   ├── input.ts                  # 設計 10.4 の通知パーサと入力受け入れ（非公開）
│   ├── chat-input-bridge.ts      # chatSend 購読 → handleClick（非公開）
│   ├── state.ts                  # StateManager（scope / lifetime / 永続化 / migrate）
│   ├── bedrock-store.ts          # 動的プロパティを使う StateStore
│   └── window.ts                 # Window（open は既定で実画面、chatSend 入力も自動接続）
├── dist/                         # ビルド成果物（ESM + .d.ts、git 管理外）
├── tests/
│   ├── gui.test.mjs
│   ├── item-inventory.test.mjs
│   ├── player-inventory.test.mjs # PlayerInventory の読み取り専用・slot 検証・変更転送
│   ├── input.test.mjs            # 入力通知パーサと snapshot 検証
│   ├── input-bridge.test.mjs     # 入力受け入れ（直列化・generation・rate limit）
│   ├── chat-input-bridge.test.mjs # chatSend 購読 → handleClick の橋渡し
│   ├── periodic.test.mjs         # 周期更新の開始・停止
│   ├── bedrock-store.test.mjs    # 動的プロパティ・StateManager 連携
│   ├── state.test.mjs            # 状態管理・migration・破損時の挙動
│   ├── window.test.mjs           # Window と実アダプタの open/close 経路・イベント購読・ライフサイクル close・state schema・書き込み省略
│   ├── window-diff.test.mjs      # 状態変更時の全スロット再評価・通知のバッチ
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

`LICENSE` はまだありません。`resource_pack/` は既定で `data_driven_container` のパネルへ接続する未検証テンプレートで、`chest_screen` は編集していません。`examples/usage-sketch.ts` は現行コアの公開型に一致するスケッチですが、実行の対象外で、実アダプタの `Window.open()` は実機未検証の実画面 open 経路に入ります。型検査の手順は [examples/README.md](examples/README.md) を参照してください。

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
