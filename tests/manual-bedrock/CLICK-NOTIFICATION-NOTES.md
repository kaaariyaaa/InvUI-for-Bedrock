# 設計10 入力通知の実現可能性ノート（公式 samples / script beta 精査）

> [!WARNING]
> この文書は**調査記録**です。ここに書いた自動通知経路は実装済みではありません。実機未検証のものを「動作する機能」として案内しないでください。実機で試す場合も**使い捨てワールドだけ**で行い、表示アイテムの保護・設計 10.8 の合格根拠にしないでください。

## 1. 結論

対象版（下記）の公式 Resource Pack 構造と `@minecraft/server` beta の範囲では、**「表示アイテムを変えず・消費せず・標準のチェスト表示を保ち・PC / タッチ / コントローラーで・after イベントの復元なしに・自動でスロットクリックを Script API へ届ける」方法は確認できていません。** この結論は対象版の公式 samples と beta typings の範囲での調査結果であり、未文書の binding や将来版の API の不存在を断定するものではありません。

- `button.send` → チャット通知は**受信側**だけ実装済みです。UI 側から slot / session / sequence を**自動生成**する書式は公式構造で確認できていません。手入力の静的ペイロードだけが根拠ある形です。
- `button.drop_one` → `VirtualContainerItemChangeAfterEvent` は自動・タッチ可能ですが、**スロットのアイテムを動かす**ため非破壊ではありません。after イベントで元に戻すのは複製・消失の危険があり、採用しません。
- `PlayerCursorInventoryComponent` / `playerCursorItemGrab` を使う経路は、**タッチでカーソルが使われず**、slot / container も通知されないため、全入力方式を満たしません。カーソル復元は採用しません（[CURSOR-INPUT-NOTES.md](CURSOR-INPUT-NOTES.md)）。
- **マーカーアイテム方式**（button slot に使い捨てアイテムを置き、通常クリックで動いたことを itemChange で受ける）は、自動・タッチ可能な候補ですが、**button slot の見た目がマーカーになり、プレイヤーが持ち出せ、入力抑制なしでは他人のアイテムを置かれる**ため、設計 10.1 / 10.8 の「標準表示・取り出し不可・非破壊」を満たしません。実装していません（第 5 節 V-4）。

§12 で、残っていた抜け道（コンテナ規則・入力権限・DDUI のアイテム描画・ホットバー選択）について、公式型で否定できるものと、記述がなくて可否不明のものを整理しています。

現時点で「実装済み」なのは、`World.beforeEvents.chatSend` を受けて `!invui:<session-id>:<layout-generation>:<slot>:<sequence>` を `Window.handleClick()` へ流す**受信経路のみ**です（Node.js テスト済み、実機未検証）。`layout-generation` は `Window._inputLayoutGeneration` と照合され、ページ・行・タブ・スロット要素の変更前に生成された通知は、変更後に届いても `stale-layout-generation` として拒否されます。世代を持たない旧3フィールド形式は受理しません。これはクリックの証明でも認証でもなく、値を自動生成する UI もありません。

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
| samples の範囲では、`edit_box` に固定文字の初期値プロパティは見つからない。`edit_box` は `ui_common.json:1519` の 1 種類だけで、`"text"` を持たない | `ui_common.json:1519-1780` | JSON UI だけで本文を事前入力する書式は確認できない。`text` を足すのは発明 binding |
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

- `src/input.ts`: `!invui:<session-id>:<layout-generation>:<slot>:<sequence>` の解析、Window snapshot（session / layout-generation / slot mode / sequence）との照合、rate limit、直列 queue。公開エントリからは export しない。
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
| CLICK-JSON-04 | chest 画面と data_driven 画面にマーカーを出し、`title_marker` の `$container_title` を読む | `VirtualContainer` がどちらのパネルを使うか。マーカーのパネルが開いたコンテナのタイトルを受けているか（`$container_title` の伝播は実機未検証） | `chest-resource-pack/`、`data-driven-resource-pack/` |
| CLICK-JSON-05 | 既定接続を有効にして `VirtualContainer` を開き、続けて通常チェストも開く | **`$container_title` ゲートは実装していません**（タイトル gate は不採用）。既定接続は `data_driven_container` のパネルを使う全画面に適用される想定なので、警告ラベル・ブロッカーの有無を VirtualContainer と通常チェストで比べ、実際の適用範囲を記録する | `resource_pack/` |
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

## 9. 2026-11-15 再調査: 1.26.70 beta の全イベントと JSON UI の再確認

設計10の実装経路を探すため、`@minecraft/server` `2.13.0-beta.1.26.70-preview.24` の `index.d.ts` と `bedrock-samples` のタグ `v1.26.70.23-preview` を**全イベント・全 hardcoded button ID・binding 名**まで再確認しました。前回の結論（標準チェスト表示を保ったまま、非破壊・自動・slot 区別・全入力対応の経路は確認できない）は変わりません。追加で確認した API と、新しい候補を以下に記録します。

### 9.1 新規・変更された Script API イベントの評価

| API | 内容 | クリック源に使えるか |
|---|---|---|
| `VirtualContainerCloseAfterEvent.items` | 画面が閉じた時点の全スロット内容。`player` / `reason` はあるが slot はない | **不可**。閉じたことしか分からず、どの slot を押したかを示さない |
| `BlockContainerOpenedAfterEvent` / `EntityContainerOpenedAfterEvent` | コンテナが開かれた after イベント。`openSource` はあるが、**開いたプレイヤーを持たない**（block / entity 側のイベント） | **不可**。クリックでもなく、プレイヤーも slot も特定できない |
| `PlayerInventoryItemChangeAfterEvent` | `player` / `inventoryType`（Hotbar / Inventory）/ `slot` / before / after。after | **不可**。VirtualContainer の slot ではなく、カーソルも含まない。クリックでアイテムを動かすと破壊的 |
| `PlayerHotbarSelectedSlotChangeAfterEvent` | `player` / `previousSlotSelected` / `newSlotSelected`（0〜8）/ `itemStack`。after | **条件付き候補**。JSON UI のボタンを `button.slot_N` へ mapping すればホットバー選択が変わる可能性がある。ただし **9 値しかなく、mapping がクリックで発火するかは未検証**。プレイヤーの通常の 1〜9 キー入力とも区別できない |
| `PlayerInputModeChangeAfterEvent` | 入力デバイスの種類の変更だけ | **不可**。slot もクリックもない |
| `PlayerInputPermissionCategoryChangeAfterEvent` | 入力権限カテゴリの変更 | **不可**。UI クリックではない |
| `PlayerCraftRecipeAfterEvent` / `PlayerUseNameTagAfterEvent` / `PortalActivateAfterEvent` / `PackSettingChangeAfterEvent` / `SoundCompletedAfterEvent` | それぞれの対象操作の after イベント | **不可**。チェスト画面の通常クリックでは発生しない |
| `MessageReceiveAfterEvent` | client → server のメッセージ。`player` / `id` / `message` | **不可**。型定義のコメントに「This event is an internal implementation detail, and is otherwise not currently functional」と明記されている。JSON UI からこの id/message を送る書式も確認できない |
| `Player.postClientMessage` / `World.broadcastClientMessage` | server → client のメッセージ送信 | **不可**。逆向きであり、クリックの受信には使えない |
| `ContainerRules` | `allowedItems` / `bannedItems` / `weightLimit` などでコンテナ操作を制限 | **不明**。作成時に規則を渡す口はないが、`containerRules` の各項目は readonly ではなく、型の上では取得後の変更が可能。実行時に反映されるか、拒否時にイベントが届くかは未検証（§12.1） |
| `ItemLockMode.slot` | アイテムをその slot から動かせない | **未検証の候補**。通常クリックで `VirtualContainerItemChangeAfterEvent` が同じ内容で届くなら、復元不要のクリック源になり得る。ただし設計7.2 により、ロックを表示スロットの読み取り専用化には使えない。陽性でもクリック源としてだけ検討する。専用プローブを追加した（10 節） |

### 9.2 JSON UI samples の再確認

- `button.send` は `chat_screen.json` と `dev_console_screen.json` にだけ現れる。**他の画面で動く保証はなく、slot / session / sequence を本文へ自動で入れる binding もない**（前回と同じ）。
- 新しい hardcoded button ID は増えていない。`button.slot0`〜`button.slot9` はホットバー選択、`button.drop_one` / `button.drop_all` はアイテム移動、`button.container_*` はスロット操作で、**汎用の「script へ値を送る」ボタンはない**。
- `text_edit_box` に初期文字を入れる `text` プロパティは samples に存在せず、`common.text_edit_box` も `text_box_name` と content binding だけを使う。**根拠のない binding を追加しない**方針を維持する。
- `button_mappings` は `from_button_id` / `to_button_id` / `mapping_type` / `scope` だけで、引数や動的な文字列を渡せない。
- `data_driven_container_screen.json` の `item_grid` は `container_items` を使うが、collection index を chat 本文や button ID へ変換する書式は samples の範囲では見つからない。
- 公式 samples の範囲で、**UI → Script API の汎用クリック通知は依然として存在しない**。

### 9.3 唯一の直接クリック API: `@minecraft/server-ui` の `CustomForm`（設計10の対象外）

`@minecraft/server-ui` `2.5.0-beta.1.26.70-preview.24` には DDUI の `CustomForm` があり、`button(label, onClick)`、`image(src, pack, { onClick })`、`multiButtonRow`（最大 3 個）を提供します。**クリックはコールバックで直接 Script API に届き、slot を呼び出し側が持つため、非破壊・自動・slot 区別・全入力対応という点だけを見れば設計10の要件を満たします。**

ただし、これは `VirtualContainer` のチェスト画面ではありません。

- 標準チェストのアイテム表示（9×6 グリッド、アイテムアイコン、個数、ツールチップ）を維持できない。
- `VirtualContainer` の `Container` / itemChange / close イベントと接続されない。
- 設計 0.1 の「GUI 基盤は `VirtualContainer`」、10.1 の「視覚上は標準のチェストアイテム表示を維持する」に反する。

したがって **設計10の代替にはならない**。標準チェスト表示を諦めてよい別プロダクト判断がある場合だけ、`CustomForm` をクリック源にする選択肢があります。その場合も 54 ボタンの一覧は実用的なチェスト UI ではないため、9 / 27 スロット程度のメニュー用途に限定されます。

## 10. 追加した実機プローブ（ロック済みアイテム）

[`locked-click-probe/`](locked-click-probe/README.md) を追加しました。`ItemLockMode.slot` のアイテムを VirtualContainer に置き、**通常クリックで `VirtualContainerItemChangeAfterEvent` が同じ内容で届くか**だけを観測します。

- 復元・`setItem`・カーソル操作・クリック実行は**一切しません**。
- JSON UI / Resource Pack / `button.send` を含みません。
- アイテムは `minecraft:stick` / `minecraft:paper` だけです。
- 陽性なら、復元不要で slot 付きのクリック源になる可能性があります。陰性なら、ロックはクリック源に使えないと確定できます。
- **陽性でも設計7.2 は変わりません。** `ItemLockMode.slot` を VirtualContainer の読み取り専用化に使わず、表示スロットの操作抑制は JSON UI 側か `inventory` 分離で行います。このプローブはロックを安全機構として検証していません。

## 11. 実機テストの次の順序

1. **CLICK-LOCK-01**: [`locked-click-probe/`](locked-click-probe/README.md) を単独の使い捨てワールドで実行する。`slot` / `inventory` / `plain`、9 / 27 / 54、PC / タッチ / コントローラーで、通常クリック 1 回あたりの `ITEM_CHANGE` と `kind` を記録する。**最初に試すべき候補**（標準チェスト表示を維持でき、復元もチャットも不要）。陽性でも設計7.2 により、ロックを表示スロットの読み取り専用化には使わない。
2. **CLICK-HOTBAR-01**: 9 スロットの透明ボタン overlay で、各ボタンの `button.menu_select` を `button.slot_N`（N=0〜8）へ mapping し、`PlayerHotbarSelectedSlotChangeAfterEvent` がクリックで発火するかを見る。発火しても 9 値だけであり、通常の 1〜9 キー入力との区別が必要。実装候補にする前に、入力抑制と誤発火を確認する。
3. **CLICK-SEND-01/02**: 既存の `button-send-resource-pack/` / `edit-box-resource-pack/` で、VirtualContainer 画面の `button.send` と `edit_box` の成立を確認する。成立しても、slot / session / sequence の自動生成経路はないため、手入力プローブ以上にはならない。
4. **CLICK-CURSOR-01**: `CURSOR-INPUT-NOTES.md` のカーソル経路を再確認する。タッチ非対応と after 復元の危険が残るため、採用しない場合の比較用。
5. **CLICK-DDUI-01**（設計変更を許す場合だけ）: `CustomForm` で 9 / 27 ボタンのメニューを表示し、PC / タッチ / コントローラーでコールバックとレイアウトを確認する。標準チェスト表示の代替にはならないことを記録する。

**1 が陽性になるまで、コアにクリック経路を実装しないでください。** 1 が陰性なら、2 の 9 値制限と入力抑制を実機で確認し、それも陰性なら設計10は「標準チェスト表示を保った自動クリックは実現できない」として、`Window.handleClick(slot)` の明示 API と手入力プローブだけを残します。

## 12. 2026-11-15 追加調査: 残っていた抜け道の確認（実装なし）

§1 / §9 の結論を覆す経路が残っていないか、固定版の型（`node_modules/@minecraft/server/index.d.ts`、`@minecraft/server-ui` `2.5.0-beta.1.26.70-preview.24` の npm tarball）と samples `v1.26.70.23-preview` を追加で確認しました。**この範囲では、新しく実装できる安全な経路は見つかりませんでした。** ただし「型・samples に記述がない」ことは不可能の証明ではないため、以下では**型の列挙で否定できるもの**と、**記述がないだけで可否が不明なもの**を分けます。**この節によるコード変更はありません。**

### 12.1 候補ごとの確認結果

| 候補 | 確認した内容 | 根拠 |
|---|---|---|
| コンテナ規則で移動を拒否し、その拒否イベントをクリック源にする | `VirtualContainerOptions` は `size` と `title` だけで、`VirtualContainerManager.create()` に規則を渡す口はない。`Container.containerRules` も `readonly` なので再代入できない。**ただし `readonly` が禁じるのはプロパティの再代入だけで、`ContainerRules` の各項目（`allowedItems` / `bannedItems` / `allowNestedStorageItems` / `weightLimit`）は readonly ではなく、取得したオブジェクトの配列操作や真偽値の書き換えは型検査を通る。** VirtualContainer の `containerRules` が実行時に存在するか、その変更が反映されるか、拒否時にイベントが届くかは公式型に記述がない。したがって「型の上で成立しない」とは言えず、**可否は不明（未検証）** | d.ts 31086-31102（options）、8119（`readonly containerRules?`）、28403-28432（`ContainerRules` interface）、25535-25553（manager） |
| 入力権限でチェスト画面のアイテム操作を止める | `InputPermissionCategory` の列挙は Camera / Movement / LateralMovement / Sneak / Jump / Mount / Dismount / MoveForward / MoveBackward / MoveLeft / MoveRight の 11 種類で閉じている。**inventory / GUI 操作に対応するカテゴリは型にない** | d.ts 2200-2276 |
| DDUI で標準チェストのスロット表示を再現する | `@minecraft/server-ui` `2.5.0-beta.1.26.70-preview.24` の `index.d.ts` に **`ItemStack` を受け取る要素・オプションはない**。`CustomForm` の要素は button / label / header / divider / dropdown / toggle / slider / textField / image / multiButtonRow / spacer だけで、個数・ツールチップ付きのアイテムスタックを表示する要素はない。**ただし `image(src, pack)` はパック内の画像を表示できるため、アイコン画像としてなら描ける可能性があり、「ItemStack の記述がない」ことは描画不能の証明ではない。** 標準チェスト表示を型の範囲で再現する手段は見つからないが、可否は不明 | server-ui 365-698、1634-1836 |
| ホットバー選択変更を全スロットのクリック通知にする | `PlayerHotbarSelectedSlotChangeAfterEvent` の購読オプション `HotbarEventOptions` は `allowedSlots`（0〜8）だけで、**入力源（実キー / GUI ボタン）を区別する項目がない**。`Player.selectedSlotIndex` は書き込み可能（restricted-execution では読み取り専用）なので「クリック後に選択を戻して連打を検出する」案は型の上では書けるが、held item が実際に切り替わること、script からの書き込みが同じイベントを再発火するかは未確認。**実機根拠なしに実装しない** | d.ts 20587-20648、29575-29584、19304 |
| チェスト画面で `button.slot_N` を受ける | `button.slot_0`〜`button.slot_9` への number key 対応は `inventory_screen_common`（`ui_common.json` 6838 以降）と loom / trade_2 / stonecutter / furnace / inventory_screen(_pocket) / hud にあり、**`chest_screen.json` には見つからない**。これは samples に記述がないという記録であり、未文書の binding や overlay 側の受け口の不存在を断定しない。チェスト画面側に受け口がある保証もない | `ui_common.json` 6838-6990、`chest_screen.json` 全体 |

### 12.2 変更がないことも再確認（samples / 型に見つからない記録）

以下は「公式 samples / 固定版の型の範囲で確認できた」という記録で、記述がないことは不可能の証明ではありません。

- `MessageReceiveAfterEvent` は「A specific currently-internal event used for passing messages from client to server」、購読側の `ServerMessageAfterEventSignal` は「not currently fully implemented, and should not be used」。§9.1 の評価は変わらない（d.ts 18820、23532 付近）。
- `button.send` は samples の範囲では `chat_screen.json`（4 箇所）と `dev_console_screen.json`（1 箇所）だけ。
- `edit_box` は samples の範囲では `ui_common.json` の `common.text_edit_box`（1519）と `common.transparent_text_edit_box`（1947）の 2 種類だけで、どちらも初期文字列プロパティを持たない。`text_control` は文字表示用の control 参照で、内容の初期化ではない。
- samples の UI JSON には command / scriptevent を実行する書式が見つからない（`"command"` は command_block のコメントのみ）。
- `Store` 系・`button.copy_*` 系の hardcoded ID はクリップボードかストアで、サーバーへ値を送る経路ではない。

### 12.3 結論

公式型・samples で確認した範囲では、追加で実装できる安全な経路は見つかっていません。ただし、**型が禁止していないが実行時挙動が未確認の候補は残っています**：`containerRules` の項目変更が実行時に効くか（拒否イベントが届くか）と、`Player.selectedSlotIndex` の script 書き込みがホットバーイベントを再発火するかです。これらは「不可能」ではなく「不明」です。型・samples では決着しないため、使い捨てワールドでの実機観測が必要です。

残っている lead のうち、§11 の **CLICK-LOCK-01**（`ItemLockMode.slot` のアイテムを通常クリックしたときに `VirtualContainerItemChangeAfterEvent` が同じ内容で届くか）が最初に試すべきものです。**これらの結果が出るまで、コアにクリック経路を実装しないでください。**
