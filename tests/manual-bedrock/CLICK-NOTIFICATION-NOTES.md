# 設計10 入力通知の実現可能性ノート（公式 samples / script beta 精査）

> [!WARNING]
> この文書は**調査記録**です。ここに書いた自動通知経路は実装済みではありません。実機未検証のものを「動作する機能」として案内しないでください。実機で試す場合も**使い捨てワールドだけ**で行い、表示アイテムの保護・設計 10.8 の合格根拠にしないでください。

## 1. 結論

対象版（下記）の公式 Resource Pack 構造と `@minecraft/server` beta の範囲では、**「表示アイテムを変えず・消費せず・標準のチェスト表示を保ち・PC / タッチ / コントローラーで・after イベントの復元なしに・自動でスロットクリックを Script API へ届ける」方法は確認できていません。** この結論は対象版の公式 samples と beta typings の範囲での調査結果であり、未文書の binding や将来版の API の不存在を断定するものではありません。

- `button.send` → チャット通知は**受信側**だけ実装済みです。UI 側から slot / session / sequence を**自動生成**する書式は公式構造で確認できていません。手入力の静的ペイロードだけが根拠ある形です。
- `button.drop_one` → `VirtualContainerItemChangeAfterEvent` は自動・タッチ可能ですが、**スロットのアイテムを動かす**ため非破壊ではありません。after イベントで元に戻すのは複製・消失の危険があり、採用しません。
- `PlayerCursorInventoryComponent` / `playerCursorItemGrab` を使う経路は、**タッチでカーソルが使われず**、slot / container も通知されないため、全入力方式を満たしません。カーソル復元は採用しません（[CURSOR-INPUT-NOTES.md](CURSOR-INPUT-NOTES.md)）。
- **マーカーアイテム方式**（button slot に使い捨てアイテムを置き、通常クリックで動いたことを itemChange で受ける）は、自動・タッチ可能な候補ですが、**button slot の見た目がマーカーになり、プレイヤーが持ち出せ、入力抑制なしでは他人のアイテムを置かれる**ため、設計 10.1 / 10.8 の「標準表示・取り出し不可・非破壊」を満たしません。実装していません（第 5 節 V-4）。

現時点で「実装済み」なのは、`World.beforeEvents.chatSend` を受けて `!invui:<session-id>:<slot>:<sequence>` を `Window.handleClick()` へ流す**受信経路のみ**です（Node.js テスト済み、実機未検証）。これはクリックの証明でも認証でもありません。

## 2. 対象版

| 項目 | 値 |
|---|---|
| 公式 samples | タグ `v1.26.70.23-preview`、commit `430142679bb7daf3160671f06ab32ea433be1e1d`（<https://github.com/Mojang/bedrock-samples/tree/v1.26.70.23-preview>） |
| Script API | `@minecraft/server` `2.13.0-beta.1.26.70-preview.24`（`package.json` に固定。2026-11-15 時点の npm `beta` 最新） |
| 調査日 | 2026-11-15 |

samples の版は **UI 構造の参照元**であり、実行に必要なゲーム版ではありません。`VirtualContainer` の実行には beta API に対応する Preview/Beta が必要です。

## 3. 公式 samples で確認したこと

| 確認したこと | 根拠（`resource_pack/ui/`） | 実装への影響 |
|---|---|---|
| `button.send` は chat と dev console にだけ現れる | `chat_screen.json:186,255,497,504`、`dev_console_screen.json:41`。`grep '"button.send"' ui` で他に一致なし | チェスト系画面での成立は未確認。成立しても、送る本文は text box の内容に依存する |
| Bedrock Wiki も `button.send` を **Chat 画面固有**の hardcoded button ID として列挙する | <https://wiki.bedrock.dev/json-ui/json-ui-documentation#hardcoded-button-ids> | チェスト画面での成立を前提にしない |
| `button_mappings` は `from_button_id` / `to_button_id` / `mapping_type` などの対応だけで、**引数や文字列を渡す書式がない** | `ui_common.json:44-101`（`common.button`）。samples 全体の `button_mappings` に payload 用のキーなし | 押下 slot をボタン ID に埋めたり、session / sequence を mapping で渡したりできない |
| chat の text box は `#message_text_box` と `#message_text_box_content` に依存する | `chat_screen.json:378-390`、`ui_common.json:1371-1428`（`text_edit_box_label` の content binding） | 後者は Wiki で **Chat 画面固有の hardcoded binding**。他画面で同じ内容が供給される保証はない |
| `edit_box` に固定文字の初期値プロパティはない。samples の `edit_box` は `ui_common.json:1519` の 1 種類だけで、`"text"` を持たない | `ui_common.json:1519-1780` | JSON UI だけで本文を事前入力する書式は確認できない。`text` を足すのは発明 binding |
| 通常クリックは `button.container_take_all_place_all`、ドロップキーは `button.drop_one` に対応する | `ui_common.json:4817-4955`（`container_slot_button_prototype`）。`button.menu_inventory_drop` → `button.drop_one` は 4925-4926 | アイテム変化を起こす経路は実在する。ただし表示アイテムを動かす |
| `container_items` はグリッドの collection 名で、`#collection_index` のような実行時 binding を本文へ変換する仕組みは確認できない | `chest_screen.json:24-45`、`data_driven_container_screen.json:15-42` | slot 番号を自動で本文へ入れる経路は確認できない |
| `data_driven_container_screen.json` は data-driven **ブロック**用で、chest 画面を継承しないと明記されている | 同ファイル冒頭コメント | `VirtualContainer` がこの画面を使うかは未確定。既定接続はこのパネルを対象にしているだけ |

## 4. script beta で確認したこと

| API | 確認したこと | 実装への影響 |
|---|---|---|
| `VirtualContainer` | `open` / `close` / `getViewers` / `title` のみ。**クリック・入力・JSON UI イベントを公開しない** | UI → script の汎用クリック通知 API はない |
| `VirtualContainerItemChangeAfterEvent` | `player` / `container` / `slot` / `beforeItemStack?` / `itemStack?`。**スクリプトからの変更では発生しない**。after イベント | slot は分かる。ただし変更後の通知で、変更を取り消せない |
| `WorldBeforeEvents` | プレイヤー入力の before イベントは `chatSend` のみ。UI クリック・コンテナ操作の before イベントはない | 変更前にクリックを止める／横取りする経路がない |
| `PlayerButtonInputAfterEvent` | `button` は `InputButton` の `Jump` / `Sneak` だけ。slot 情報なし | GUI のスロットクリックを識別できない |
| `PlayerCursorInventoryComponent` | 「Used when moving items between containers in the inventory UI. **Not used with touch controls.**」 | タッチではカーソル経路が成立しない |
| `PlayerCursorItemGrabAfterEvent` / `PlayerCursorItemReleaseAfterEvent` | @rc。`item` と `player` だけで **slot / container を持たない**。after イベント | itemChange と組み合わせても、クリックの証明・安全な復元にはならない |
| `scriptEventReceive` | コマンド起点の after イベント。JSON UI からコマンドを実行する書式は確認できない | UI から直接 script event を送る方法は確認できない |

型定義の根拠は `node_modules/@minecraft/server/index.d.ts`（`VirtualContainer` 25297 行付近、`VirtualContainerItemChangeAfterEvent` 25453 行付近、`InputButton` 2135 行付近、`PlayerCursorInventoryComponent` 20219 行付近、cursor イベント 20245 / 20300 行付近）。公式ドキュメント:

- <https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainer.md>
- <https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerItemChangeAfterEvent.md>
- <https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/PlayerCursorInventoryComponent.md>
- <https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/PlayerButtonInputAfterEvent.md>

## 5. 候補経路の評価

| ID | 経路 | 自動 | タッチ | 非破壊 | 標準表示 | 判定 |
|---|---|---|---|---|---|---|
| V-1 | `button.send` → chatSend | **未確認**（公式 samples に本文を自動生成する書式がない） | 可（手入力なら） | 可 | 可 | 受信側のみ実装。UI 自動生成は不採用 |
| V-2 | `button.drop_one` → itemChange | 可 | 可（タップで drop 相当） | **不可**（アイテムが動く） | 可 | 不採用。after 復元は危険 |
| V-3 | カーソル取得 + itemChange | 可（PC） | **不可**（カーソルなし） | 条件付き | 可 | 不採用（[CURSOR-INPUT-NOTES.md](CURSOR-INPUT-NOTES.md)） |
| V-4 | マーカーアイテム + itemChange | 可 | 可（通常タップが slot を変える想定） | プレイヤーの貴重品は守れるが**マーカーは持ち出せる** | **不可**（マーカー表示になる） | **実装しない**。条件付き候補として記録 |
| V-5 | `PlayerButtonInputAfterEvent` | 不可 | 不可 | — | — | 不採用（slot なし） |
| V-6 | `playerCursorItemGrab` + itemChange | 可（PC） | **不可** | 条件付き | 可 | 不採用（slot なし・after） |

### V-4 を実装しない理由

V-4 は「button slot に使い捨てマーカーを置けば、通常クリックで必ず slot が変わる」ため、`VirtualContainerItemChangeAfterEvent` だけで自動通知できる点が魅力です。チャット・session・sequence・JSON UI binding・カーソル・after 復元を使いません。しかし、次の理由で設計 10.1 / 10.8 を満たしません。

1. **標準表示を維持できない。** slot の中身がマーカーになるため、表示アイテムの見た目をそのまま出せない。表示アイテムをマーカーにすると、プレイヤーが持ち出した時点で価値のあるアイテムの複製になる。
2. **取り出しを防げない。** マーカーは通常クリックで持ち出せる。価値のないマーカーなら実害は小さいが、「表示・ボタン用アイテムを取り出せない」という要件は満たさない。
3. **入力抑制なしでは安全でない。** プレイヤーが自分のアイテムを button slot に置く／swap する／shift-click すると、itemChange の前後状態が変わる。サーバーがそれを上書きすると**プレイヤーのアイテム消失**、close すると**持ち出せず消失**になり得る。入力抑制（透明ブロッカー）自体が実機未検証で、全入力方式を止める保証もない。
4. **クリックと他の操作を区別できない。** itemChange は通常クリック・shift-click・ドロップ・配置のどれでも発生する。`beforeItemStack` / `itemStack` だけでは「通常クリック」を一意に決められない。
5. **after イベントである。** 変更後の通知なので、プレイヤーの操作を止められない。マーカーの再描画は「復元」ではなく新規作成だが、プレイヤーが持ち出したマーカーは複製される。価値のないマーカーに限定する運用が必須で、ライブラリの既定機能にはできない。

したがって V-4 は「要件を緩めた別製品」の候補であり、設計 10 の主機能としては実装しません。実装するなら、入力抑制・マーカー所有権・異常時の close 方針を先に実機で確定させる必要があります。

## 6. 実装済みの範囲（受信側）

- `src/input.ts`: `!invui:<session-id>:<slot>:<sequence>` の解析、Window snapshot との照合、rate limit、直列 queue。公開エントリからは export しない。
- `src/chat-input-bridge.ts`: `world.beforeEvents.chatSend` の購読、`system.run()` 経由の `Window.handleClick()` 呼び出し。session は open ごとの `Window._inputSessionId`。
- `src/window.ts`: 最初の `open()` で chatSend を 1 本購読し、close とページ/行/タブ変更で待機中の通知を捨てる。
- `resource_pack/ui/invui_controls.json`: **手入力**の静的ペイロードプローブ（オプトイン・既定未登録）。自動生成はしない。
- `tests/manual-bedrock/edit-box-resource-pack/`: chest / pocket 画面で edit_box + `button.send` の送信経路だけを観察する単体プローブ。
- `tests/manual-bedrock/button-send-resource-pack/`: `button.send` 単独の観察プローブ。

**UI 側が通知を自動生成する実装はありません。** `src/` に `button.send` や `#message_text_box` を生成するコードはありません。

## 7. 実機で確認が必要な項目

以下は**未実施**です。結果が出るまで、クリック通知を有効な機能として扱わないでください。記録は [README.md](README.md) の「3. 実施環境の記録」に合わせます。

| ID | 操作 | 確認すること | 使用するプローブ |
|---|---|---|---|
| CLICK-JSON-01 | `VirtualContainer` 画面で `button.send` ボタンを押す | チャット送信イベントが 1 回発生するか。発生しない場合、`button.send` 自体がこの画面で無効か | `button-send-resource-pack/` |
| CLICK-JSON-02 | 同じ画面で edit_box に手入力し、`button.send` を押す | 入力内容がチャットとして送信されるか。`#message_text_box` が機能するか | `edit-box-resource-pack/` |
| CLICK-JSON-03 | `data_driven_container` パネルを使う画面で同じ操作 | `VirtualContainer` が data_driven 画面を使う場合に送信経路が成立するか | `resource_pack/ui/invui_controls*.json` |
| CLICK-JSON-04 | chest 画面と data_driven 画面にマーカーを出す | `VirtualContainer` がどちらのパネルを使うか | `chest-resource-pack/`、`data-driven-resource-pack/` |
| CLICK-JSON-05 | 既定接続を有効にして `VirtualContainer` を開く | `$container_title` ゲートが `InvUI` / 空タイトルで一致するか | `resource_pack/` |
| CLICK-JSON-06 | PC / タッチ / コントローラーでマーカー入り slot を通常クリック | itemChange が 1 回か。`beforeItemStack` / `itemStack` / cursor / inventory の変化。タッチでも slot が変わるか | マーカー版プローブ（未作成。V-4 を試す場合だけ） |
| CLICK-JSON-07 | マーカー入り slot に自分のアイテムを置く / swap / shift-click / drop | 前後状態と、プレイヤーのアイテムがどこへ行くか。上書き・close で消失しないか | 同上 |
| CLICK-JSON-08 | `ItemLockMode.slot` のアイテムを通常クリック | itemChange が発生するか（発生しないならロックは通知に使えない） | 同上 |
| CLICK-JSON-09 | タッチで slot をタップ | `cursor_inventory` が更新されないこと。`playerCursorItemGrab` が来ないこと | カーソル経路の再確認 |
| CLICK-JSON-10 | 手入力ペイロードを `Window.handleClick()` へ流す | 1 回だけハンドラーが走るか。close / ページ変更後の古い通知が捨てられるか | ライブラリのテストビルド（未作成） |

## 8. 参照

- [設計書 10章](../../InvUI_for_Bedrock_Design.md#10-inputbridgeとクリック検知)
- [resource_pack/README.md](../../resource_pack/README.md)（手入力プローブ、`button.send` の根拠、`button.drop_one` プローブ）
- [CURSOR-INPUT-NOTES.md](CURSOR-INPUT-NOTES.md)（カーソル経路の不採用理由）
- [API-NOTES.md](API-NOTES.md)（VirtualContainer の型・ライフサイクル）
- [button-send-resource-pack/](button-send-resource-pack/README.md)
- [edit-box-resource-pack/](edit-box-resource-pack/README.md)
- [chest-resource-pack/](chest-resource-pack/README.md)
- [data-driven-resource-pack/](data-driven-resource-pack/README.md)
