# InvUI Resource Pack テンプレート（既定で画面接続・実機未検証）

> [!WARNING]
> **これは実機で未検証の実験用パックです。現在は既定で画面接続が有効になっています。**
>
> - `ui/_ui_defs.json` は `ui/invui.json`、`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` の 3 つを登録済みです。後者 2 つが `data_driven_container` の `desktop_panel` / `pocket_panel` に警告ラベル、`invui_probe` のラベルと実験的 `button.send` 部品を差し込み、**透明ブロッカー**はデスクトップでは `panel_top_half`、pocket では `pocket_panel` に差し込みます。**登録済みのため、パックを置けば接続が働く想定**です。ただし**実機未検証であり、接続・表示・入力のどれも保証しません**。
> - 接続先は `data_driven_container` の 2 パネルです。**VirtualContainer を特定できないため、そのパネルを使うすべての画面（通常のコンテナや data-driven ブロックの画面を含み得る）に影響し得ます**。VirtualContainer だけに限定できません。VirtualContainer 画面がこのパネルを使っているかも未確定です。`chest_screen` は編集しませんが、通常画面への影響を排除できません。
> - **透明ブロッカーは保護ではありません。** ブロッカーはコンテナ側グリッド付近を覆う透明な `button` で、スロット系の入力を `button.invui_connect_blocked` へ付け替えるだけです。この ID を処理するスクリプトはありません。覆った範囲では**ボタンや inventory slot も抑制し得る**一方、**プレイヤー側のインベントリやホットバーは覆わず、controller・タッチ入力の遮断を保証しません**。フォーカスが下のスロットへ移る、JSON UI を経由しない操作、タッチの長押し・ドラッグなどは止まらない可能性があります。**アイテム保護・入力抑制・画面終了処理は未完成**で、ブロッカーによる遮断を保証しません。表示アイテムは取り出せる可能性があり、再描画との組み合わせで複製・消失が起き得ます（未検証）。`button.send` がチャットを送る保証もなく、このパックに受信スクリプトは同梱していません（ライブラリ側の `Window` は `!invui:<session-id>:<layout-generation>:<slot>:<sequence>` を購読しますが、この接続からその形式が送られる保証はなく、実機未検証です）。
> - `ui/invui_controls.json` は**手入力の静的ペイロード送信プローブ**です。JSON UI から slot / session / layout-generation / sequence を自動生成して送る方式は根拠が確認できていません。このファイルは、chat と同じ text box 名と `button.send` を使い、`!invui:<session-id>:<layout-generation>:<slot>:<sequence>`（session-id は開いた `Window` の公開 getter `_inputSessionId`、layout-generation は `_inputLayoutGeneration` から取得）を手入力して送信経路だけを観察するための**オプトイン**部品です。既定の `ui/_ui_defs.json` へは登録しておらず、キーボード入力を奪い得るため既定接続には含めません。CLI の導入対象でもありません。
> - `ui/invui_grid_input.json` は**自動コンテナ変更プローブ**です（設計 10.3 の代替候補 `button.drop_one` → コンテナ変化）。デスクトップのスロットグリッド上に透明ボタンを重ね、通常クリックを `button.drop_one` へ付け替えます。クリックでスロットが変われば `VirtualContainerItemChangeAfterEvent` が `player` / `container` / `slot` を伴って自動で届くため、チャット文字列の手入力は不要です。ただし**1 クリックごとにアイテムが 1 個ドロップされ得る破壊的プローブ**で、**サーバー側のクリック処理は未実装**です。現在のコアは itemChange を危険として close するため、そのままではクリックとして実行されません。既定未登録・CLI 対象外・pocket 非対応で、`data_driven_container.desktop_panel` を使う全画面に影響し得ます。詳細と制約は下記の専用節を参照してください。
> - `manifest.json` の UUID・version・`min_engine_version` はプレースホルダです。対応ゲーム版・パックの適用方法・読み込み順は確定していません。
> - 他の Resource Pack との競合を検出・解消する機能はありません。他パックが同じ `invui_probe` / `invui_connect_probe` / `data_driven_container` 名前空間や同じ UUID を使っている場合も衝突し得ます。
> - **使い捨てワールド専用。** バックアップを取り、試験後はワールドごと破棄するか、変更したファイルを元に戻してください。通常のワールドや配布物へ入れないでください。

## 同梱物

このディレクトリは、使い捨てワールドへそのまま追加できる**単体の（未完成な）Resource Pack** です。

```text
resource_pack/
├── README.md              # この説明（パックの中身としては使われません）
├── manifest.json          # resources モジュール 1 つ。UUID と版はプレースホルダ
├── experimental/
│   └── connect-data-driven/  # 同じ接続の隔離コピー（独立した実験用の参照。単体パックではない）
└── ui/
    ├── _ui_defs.json      # ui/invui.json と接続 2 ファイルを登録済み
    ├── invui.json         # invui_probe 名前空間（可視ラベルと実験的 button.send 部品）
    ├── invui_connect.json # 警告ラベル + 透明ブロッカー + invui_probe_root のラッパー
    ├── invui_connect_data_driven.json
    │                      # data_driven_container の desktop/pocket への modifications
    ├── invui_controls.json # 手動・静的ペイロード送信プローブ（オプトイン・未登録）
    ├── invui_controls_data_driven.json
    │                      # そのプローブを desktop/pocket へ差し込む opt-in modifications
    ├── invui_grid_input.json # 自動コンテナ変更プローブ（オプトイン・未登録）
    └── invui_grid_input_data_driven.json
                           # それを desktop のスロットグリッドへ差し込む opt-in modifications
```

## 既定で有効な画面接続

`ui/invui_connect_data_driven.json` は `data_driven_container.desktop_panel` と
`pocket_panel` の `controls` 先頭へ警告ラベルと `invui_probe_root` を `insert_front` で
差し込みます。透明ブロッカーは、デスクトップではスロット領域の `panel_top_half`
（`item_grid` と同じ基準）の `controls` 末尾へ、pocket では `pocket_panel` の `controls`
末尾へ `insert_back` で差し込みます。

- `ui/invui_connect.json` の警告ラベル（「このパネルを使う全画面に適用され得る」ことと、ブロッカーの限界を画面内に表示）
- `ui/invui.json` の `invui_probe_root`（ラベルと実験的 `button.send` 部品）
- `invui_connect_probe.grid_blocker`（透明な `button`。ホバー・押下時だけ赤く色づく）

ブロッカーはデスクトップでは `panel_top_half` 上で `offset [7, 10]` / `size [162, "100%-24px"]`
（公式 sample の `item_grid` の `offset [7, 10]` と 18px 行に一致）、
`pocket_panel` では `anchor_from: top_middle` / `anchor_to: top_left` / `offset [0, 27]` /
`size ["50%", "100%-27px"]` でコンテナ側グリッド付近を覆います。`button.menu_select`、
`button.menu_ok`、`button.menu_secondary_select`、`button.controller_select`、
`button.menu_auto_place`、`button.controller_secondary_select`、`button.menu_inventory_drop`、
`button.menu_inventory_drop_all` を `$pressed_button_name`（`button.invui_connect_blocked`）へ
付け替えます。この ID を購読・処理するスクリプトは同梱していません。

`chest_screen` は編集しません。ただし **VirtualContainer だけを識別する仕組みはなく**、
同じパネルを使う通常画面にも表示され得ます。`_ui_defs.json` への登録は接続を有効にするための
ものであり、表示・入力・アイテム保護が動くことを意味しません。

**ブロッカーの適用範囲は限定できません。** 覆った範囲では表示専用スロットだけでなく
**ボタンや inventory slot も押せなくなる可能性**があります。逆に、プレイヤー側の
インベントリ・ホットバーはブロッカーの範囲外で、controller のフォーカス移動、タッチの
長押し・ドラッグ、JSON UI を経由しないゲーム側処理は止まらない可能性があります。
**完全な保護ではなく、遮断を保証しません。** アイテム保護は依然として未実装です。

## `ui/invui_controls.json`（手動・静的ペイロード送信プローブ／オプトイン）

**JSON UI から `slot` / `session` / `sequence` を自動生成してチャット通知を送る方式は、公式構造だけでは実装方法を確認できていません。** このプローブは、その制約を前提にした**手入力の静的ペイロード実験**です。`common.text_edit_box` を chat 画面と同一の text box 名・content binding で置き、`button.send` を押して、入力した固定文字列が送信されるかだけを観察します。**自動 payload 生成、slot の自動挿入、session / sequence の自動採番は行いません。**

### 自動生成できない根拠（2026-11-15 時点）

公式 `bedrock-samples` のタグ **`v1.26.70.23-preview`**（commit `430142679bb7daf3160671f06ab32ea433be1e1d`）と Bedrock Wiki を確認しました。

| 確認したこと | 実装への影響 |
|---|---|
| `button.send` は [`ui/chat_screen.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chat_screen.json) と `ui/dev_console_screen.json` にだけ現れる。Wiki の [Hardcoded Button IDs](https://wiki.bedrock.dev/json-ui/json-ui-documentation) も **Chat 画面固有**と明記している | チェスト系画面での成立は未確認。成立しても、送る本文は text box の内容に依存する |
| [`ui/ui_common.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json) の `common.button` は `from_button_id` → `$pressed_button_name` の対応だけを持ち、引数や文字列を渡す書式がない | 押下 slot をボタン ID に埋め込んだり、session / sequence を `button_mappings` で渡したりできない |
| chat の [`text_edit_box@common.text_edit_box`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chat_screen.json) は `$text_box_name: "#message_text_box"` と `$text_edit_box_content_binding_name: "#message_text_box_content"` を使う | 本文の表示はこの 2 つに依存する。後者は Wiki で **Chat 画面固有の hardcoded binding** とされている |
| `edit_box` に `text` 初期値プロパティはなく、samples にも固定文字を初期表示する例がない。content binding はコード側が供給する | JSON UI だけで本文を書き込む／事前入力する書式は確認できない |
| `collection_index` は grid item の静的 index であり、`#collection_index` のような実行時 binding をボタン ID やチャット本文へ変換する仕組みは確認できない | slot を自動で本文へ入れる経路は確認できない |
| `VirtualContainer` の API は open / close / itemChange のみで、JSON UI からの汎用クリックイベントや script binding を公開しない | UI → script へ session / slot / sequence を渡す汎用の経路は確認できない |

したがって、**「押した slot・session・sequence を JSON UI が自動で送る」実装は、根拠のない binding を発明しない限り作る方法を確認できていません。** このプローブは、その未確認の部分を実装したふりをせず、**手入力の固定ペイロードで送信経路だけを切り分ける**ためのものです。

`button.drop_one` → コンテナ変化、カーソル、マーカーアイテムを含む候補の比較と、実機で必要な観測項目は、手元のメモにまとめておく必要があります。自動通知は実装済みではありません。

### 何をするか

`ui/invui_controls_data_driven.json` を有効にすると、`data_driven_container.desktop_panel` / `pocket_panel` の `controls` 先頭へ `invui_controls_probe_root` を `insert_front` します。表示されるのは警告文、固定例、chat と同じ text box 名を持つ入力欄、`button.send` を発火するボタンです。

送る形は **`!invui:<session-id>:<layout-generation>:<slot>:<sequence>`** です。`Window.id`（`window-N`）は使いません。

- **session-id**: `Window` が `open()` の成功ごとに作り直す `_inputSessionId` を 1 フィールド目に入れます。
- **layout-generation**: 通知を生成した時点のクリック可能レイアウトの世代 `_inputLayoutGeneration` を 2 フィールド目に入れます。open ごとに `0` から始まり、ページ・行・タブ・スロット要素の変更で進みます。**ページ変更前に控えた値のまま送ると、変更後に届いた通知は `stale-layout-generation` として拒否されます。** さらに、世代が一致していても、その世代のレイアウトが描画完了して画面に書かれるまでは入力ゲートが closed で、通知は button が無いものとして拒否されハンドラーは実行されません。`placeholder` を指定しない非同期 provider が未解決の間、Container 再生成中（`setTitle()` / サイズ変更 / `setUpperGui()`）、provider または `setItem()` が失敗したスロットも同じゲートで閉じます（失敗スロットは後で書き込みが成功するまで button にならない）。close・再オープンでゲートはリセットされます。Node.js 上での確認のみで実機未検証です。
- **slot**: 現在のレイアウトで button mode の論理スロット（0〜53）へ合わせます。
- **sequence**: 同じ session 内で厳密に増やします（最初の受理は `1`）。

入力欄には初期文字を入れていないため、**毎回手入力**が必要です。旧3フィールド形式 `!invui:<session>:<slot>:<sequence>` は世代を持たないため受理されません（malformed として実行されず、通常チャットからもキャンセルされません）。

### session-id と layout-generation の取得手順（開発者が手で行う）

`_inputSessionId` / `_inputLayoutGeneration` は公開クラス `Window` の公開 getter です（`dist/window.d.ts` に `get _inputSessionId(): string | undefined` と `get _inputLayoutGeneration(): number | undefined` として現れます）。JSON UI からは取得できないため、Window を開いている Behavior Pack スクリプトから値を出して読み取ります。

1. Window を開く側のスクリプトで、`await window.open()` の**後**に 2 つの値を表示します（開発時だけ。Resource Pack やゲーム内コマンドだけでは取得できません）。

   ```ts
   await window.open();
   player.sendMessage(
     `InvUI session: ${window._inputSessionId} generation: ${window._inputLayoutGeneration}`,
   );
   // ログで読む場合: console.warn("InvUI session:", window._inputSessionId, window._inputLayoutGeneration);
   ```

2. 表示された session-id（形は `session-<36進の時刻>-<36進の連番>-<36進6文字>`。毎回変わります）と layout-generation（open 直後は `0`）を控えます。
3. プローブへ `!invui:<session-id>:<layout-generation>:<slot>:<sequence>` を手入力して送信します（`!invui:session-ab12cd-1-f3k9xz:0:0:1` のような形。この例の値自体は無効です）。**対象レイアウトのアイテムが画面に表示されてから送ってください。** ページ変更直後・`placeholder` を指定しない非同期 provider の未解決中・Container 再生成中は入力ゲートが closed で、送信してもハンドラーは実行されません。
4. **`open()` のたびに session-id は変わり、layout-generation は `0` に戻ります。** 開き直したら両方読み直してください。**ページ・行・タブ、または同じページのスロット要素が変わったら layout-generation も変わる**ため、送信前に読み直してください。古い値は `stale-layout-generation`、前の open の session は `session-mismatch`、画面を閉じたままなら `window-closed` として拒否されます。最初の `open()` 成功前の値は `undefined` です。入力ゲートが closed の間に送った通知はハンドラーを実行しておらず sequence を消費しないため、アイテムが表示された後に同じ sequence で送り直せます（直前の受理から 100 ms の間隔は別途適用されます）。
5. 通知は直前の受理から既定 100 ms 間隔（10 回/秒）に制限されます。100 ms 以内の連投は `rate-limited` として拒否され、クリックは実行されません（`open()` をまたいでも直前の受理時刻を引き継ぎます）。この間隔を変える公開 API はありません（`Window` の自動接続が内部既定値 `minIntervalMs: 100` を使うため、変えるには `src/window.ts` の配線を変更する必要があります）。

両 getter はアンダースコア付きの内部扱い・互換保証なしです。取得手段はこの公開 getter だけで、**UI（JSON UI）から session-id / layout-generation を読む方法はありません**。値を取得できない場合はプローブでの送信は成立しないため、その時点で中止してください（取得できるふりの手順は記載しません）。自動送信も自動採番も実装していません。

### オプトイン手順（既定では無効）

`ui/_ui_defs.json` へは**登録していません**。キーボード入力を奪い得るため、既定の接続には含めません。使う場合だけ、`ui/invui_controls.json` と `ui/invui_controls_data_driven.json` をパックへコピーし、次の 2 ファイルを `ui_defs` に追加して有効化します（CLI の `--install-resource-pack` はこの 2 ファイルをコピーしません）。

```json
{
  "ui_defs": [
    "ui/invui_controls.json",
    "ui/invui_controls_data_driven.json"
  ]
}
```

- **使い捨てワールド専用。** バックアップを取り、終了後はワールドごと破棄してください。
- **`data_driven_container` のパネルを使う全画面に影響し得ます。** VirtualContainer だけに限定できません。
- **キーボード入力を奪い得ます。** chat と同じ `#message_text_box` と `always_listening` を使うため、画面を開いている間、チャットやキー操作を壊す可能性があります。入力途中のチャットを残さないでください。
- **自動送信ではありません。** 固定文字の初期表示、`bindings`、collection、slot / session / layout-generation / sequence の自動生成はありません。
- **偽装可能です。** 通知はプレイヤーが手入力でき、`sender` 以外は信用できません。bridge の session / layout-generation / sequence 検査も認証ではありません。
- **通常チェストの移動が壊れたら即時中止。** 他の手動プローブと同時に有効化しないでください。既定の接続（警告ラベルと `invui_probe`）と同じパネルへ差し込むため、ラベルやボタンが重なり得ます。単独試験を推奨します。


## `ui/invui_grid_input.json`（自動コンテナ変更プローブ／オプトイン・未登録）

これは設計 10.3 の**代替候補**「`button.drop_one` → コンテナ変化」を、チャット通知とは別の経路として切り分けるプローブです。`ui/invui_controls.json`（手入力の chat ペイロード）の複製ではありません。文字入力も `button.send` も使わず、**クリック自体をコンテナのアイテム変化に変換**して、公式イベント [`VirtualContainerItemChangeAfterEvent`](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerItemChangeAfterEvent.md) に `player` / `container` / `slot` / 変更前後のアイテムを出させることを狙います。

### 根拠（実機未検証）

| 確認したこと | 実装への影響 |
|---|---|
| [`ui/ui_common.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json) の `common.container_slot_button` は `button.menu_inventory_drop` → `button.drop_one` を `pressed` で結び、`button.container_slot_hovered` も同じ `button_mappings` に置いている | `button.drop_one` と `button.container_slot_hovered` はバニラのチェスト系 UI で使われる実在の hardcoded button ID。発明した binding ではない |
| `data_driven_container.container_grid_item` は `common.container_item` を継承し、`collection_name: "container_items"` を使う | グリッドのコレクション名はこの名前を使う。スロットは `common.container_slot_button_prototype` を継承して `collection_details` とフォーカスの binding を再利用し、`#collection_index` のような実行時 index binding は使わない |
| `VirtualContainerItemChangeAfterEvent` は `player` / `container` / `slot` / `beforeItemStack` / `itemStack` を持つ（`@minecraft/server` 2.13.0-beta.1.26.70-preview.24 の型定義と公式ドキュメント） | 通知に session-id や sequence を埋め込まなくても、どのプレイヤーのどの slot かはイベント側で分かる、という設計判断の根拠 |

一方で、**バニラは `button.drop_one` を「ドロップキー」から発火**しており、このプローブは**通常クリック（`button.menu_select` など）から同じ action を発火**します。action が入力元に依存しないか、オーバーレイしたボタンが下のコンテナ slot を正しく「hovered」として扱うかは**未検証**です。陰性なら「この画面・この版ではこの経路が成立しなかった」ことしか分かりません。

### 何をするか

`ui/invui_grid_input_data_driven.json` を有効にすると、`data_driven_container.desktop_panel` へ警告ラベルを `insert_front` し、`panel_top_half` の `item_grid`（`offset [7, 10]` / `size [162, "default"]`）に重なる**透明なグリッド**を `insert_back` します。

- グリッドは `collection_name: "container_items"`、`maximum_grid_items: "$container_size"`、`grid_item_template: invui_grid_input_probe.invui_grid_input_slot` を使い、スロットごとに 18×18 のボタンを生成します。
- 各ボタンは `common.container_slot_button_prototype` を継承してバニラのコレクション・フォーカス binding を再利用し、`button_mappings` だけを差し替えます。`button.menu_select` / `button.menu_ok` / `button.menu_secondary_select` / `button.controller_select` / `button.controller_secondary_select` を **`button.drop_one`** へ、加えてバニラと同じ **`button.container_slot_hovered`** へ `pressed` で結びます。
- ホバー時だけ赤く色づきます。**赤い色づきは、下のスロットを正しく対象にできた証明ではありません。**
- **通常クリックが 1 回通るたびに、そのスロットのアイテムが 1 個ドロップされ得ます。** 表示アイテムの保護ではありません。ドロップされたアイテムが戻らない・消える可能性があります。**必ず使い捨てのマーカーアイテムだけで試してください。**

### サーバー側の制約（この変更には含まれない）

このプローブが実現するのは**自動の入力「源」**です。`VirtualContainerItemChangeAfterEvent` をクリックとして `Window.handleClick()` に振り分ける処理は**実装していません**。現行コアの `minecraftVirtualContainerAdapter` はこのイベントを `WindowItemChangeDangerError` として扱い、再描画停止と `close()` 要求を行うため、**このプローブを有効にするとクリックがハンドラー実行ではなく画面 close につながり得ます**。また itemChange は、プレイヤーが普通にアイテムを動かした場合とも区別できません。クリックの証明・認証・保護にはなりません。

この節の実装は、**「チャット文字列を自動生成できない」制約を迂回する別候補の UI 側を用意し、サーバー側をどう変えるべきかを実機で切り分ける**ためのものです。自動入力経路の完成ではありません。

### 適用範囲と既存画面への影響

- 対象は `data_driven_container.desktop_panel` / `panel_top_half` です。**VirtualContainer を識別できないため、このパネルを使う全画面（通常の data-driven コンテナを含み得る）に影響し得ます。** 画面タイトル等による限定はしていません。
- **pocket 画面は対象外**です。`pocket_panel` のコンテナ側グリッドとプレイヤー側グリッドは同じ `pocket_half_screen` を共有しており、片方だけを根拠ある形で覆えなかったため、実装していません。
- 既定の接続（透明ブロッカーと警告ラベル）と同じ `panel_top_half` / `desktop_panel` に差し込むため、**同時に有効化しないでください**。重なり・入力の奪い合い・ラベルの衝突が起き得ます。単独のパックで試してください。
- 通常チェストのアイテム移動が壊れた、表示アイテムが消えた・増えた、画面が閉じた、などの異常が出たら**即時中止**してください。

### オプトイン手順（既定では無効）

`ui/_ui_defs.json` へは**登録していません**。CLI の導入対象でもありません。使う場合だけ、次の 2 ファイルをパックへコピーし、既定の接続 2 ファイルを `ui_defs` から外したうえで追加します。

```json
{
  "ui_defs": [
    "ui/invui_grid_input.json",
    "ui/invui_grid_input_data_driven.json"
  ]
}
```


## `experimental/connect-data-driven/`（隔離コピー・独立した実験用）

以前は明示 opt-in だった接続を、現在は main の `ui/` へ組み込んで既定で有効にしています。
このディレクトリは**独立した実験用の参照コピーとして残しています**が、単体の Resource Pack
ではありません（`manifest.json` を持ちません）。主パックの接続と同一内容であり、
`check.mjs` は既定の登録状態と JSON 構造を検査します。

```bash
node resource_pack/experimental/connect-data-driven/check.mjs
```

別の Resource Pack へ持ち出す場合の手順・警告・観察の解釈は
[`experimental/connect-data-driven/README.md`](experimental/connect-data-driven/README.md)
を参照してください。適用範囲は `data_driven_container` の 2 パネルを使う**全画面**であり、
透明ブロッカーも同じ範囲へ挿入されます。使い捨てワールド専用・アイテム保護なしという制約は
変わりません。ブロッカーはボタンや inventory slot も抑制し得ますが、プレイヤー側や
controller・タッチ入力を含む完全な保護ではなく、遮断を保証しません。

## 新規パックの生成（接続込み）

```bash
node bin/cli.js generate-resource-pack --output ./invui-probe-pack
```

出力先は未作成である必要があります。生成される manifest の UUID は毎回新しくなります。
CLI は同梱テンプレートから `manifest.json`、`ui/_ui_defs.json`、`ui/invui.json`、
`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` を生成し、生成物の
`_ui_defs.json` は接続 2 ファイルを登録済みです。つまり生成物は**接続が既定で有効**で、
透明ブロッカーも含まれますが、実機未検証であり、`data_driven_container` のパネルを使う
全画面に影響し得ます。ブロッカーは保護ではなく、遮断を保証しません。使い捨てワールド専用です。

## CLI での導入

```bash
node bin/cli.js init \
  --resource-pack <Resource Pack のルート> \
  --install-resource-pack
```

`--install-resource-pack` を**明示した場合だけ**、`<Resource Pack のルート>/ui/` へ
`invui.json`、`invui_connect.json`、`invui_connect_data_driven.json` の 3 ファイルを追加します。
指定しなければ従来どおり読み取り専用の検査だけを行います。

CLI は既存 Resource Pack の **`ui/_ui_defs.json` を変更しません**。そのため、既存パックへ
導入した場合は**接続は有効になりません**。必要なら手動で `ui/_ui_defs.json` の `ui_defs` へ
3 ファイルを登録してください（CLI は登録状況を検査して不足を報告します）。単体パックとして
このディレクトリを使う場合は登録済みです。

`manifest.json` と `ui/chest_screen.json` も作成も変更もしません。`ui/invui_controls.json` と
`ui/invui_controls_data_driven.json` は導入対象ではないため、有無や内容は判定に影響しません。
手動プローブを試す場合は、上記「オプトイン手順」に従って自分で `_ui_defs.json` へ登録してください。

`--behavior-pack` も同時に検査できます（導入だけなら省略可）。

### 安全側の動作

- **既存ファイルは上書きしません。** 追加するのは `ui/invui.json`、`ui/invui_connect.json`、
  `ui/invui_connect_data_driven.json` の 3 ファイルだけです。
- 導入先に同じ 3 ファイルのいずれかが既に存在する場合:
  - 内容が同梱テンプレートと同一なら、何も書き換えず「導入済み」と報告します。
  - 内容が異なる場合は**競合として中断**し、テンプレートと既存内容の差分を表示します。終了コードは `1` です。
- `ui/` がファイルとして存在する、親ディレクトリを辿れない、導入先の検査にエラーがある（`manifest.json` がない、JSON として壊れている等）、などの場合は書き込み前に中断します。
- 書き込みはファイルごとに一時ファイルへ行い、完成後にだけ排他的に配置します。失敗した場合は追加済みファイル・一時ファイル・この CLI が作成した空ディレクトリを削除する**ロールバックを試みます**が、**ロールバック自体が失敗しうる**ため部分適用が残る可能性があります。
- 既存ファイルを変更しないため、既存内容のバックアップは不要です。ただし実験前に対象 Resource Pack 全体のバックアップを取ってください。導入後に元へ戻す場合は、追加された 3 ファイルを削除してください（`ui/` をこの CLI が作成した場合は、空なら削除できます）。
- `ui/_ui_defs.json` と `ui/chest_screen.json` は変更しません（接続の登録は上記のとおり手動）。

### JSON 出力

`--json` を併用すると、`resourcePackInstall` に導入結果（`installed` / `already-installed` / `conflict` / `blocked` / `failed` / `not-requested`）、追加したファイル、競合時の差分が入ります。標準出力は単体でパースできる JSON のままです。

## 導入後に手動で検討すること（すべて未検証）

1. 既存の Resource Pack へ導入した場合は、その `ui/_ui_defs.json` の `ui_defs` へ `ui/invui.json`、`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` を追加する（既存ファイルのバックアップと差分確認は利用者が行う。CLI は 3 ファイルを配置するが登録はしない）。
2. 対象画面でラベル・ボタン・警告ラベルが表示されるか確認する。**`data_driven_container` のパネルを使う全画面に影響し得る**ため、VirtualContainer 以外（通常チェスト等）での表示も記録する。**VirtualContainer 画面がこのパネルを使っているかは未確定**であり、表示の有無だけで適用先を断定しない。
3. 透明ブロッカーの範囲（desktop: `offset [7, 10]` / `size [162, "100%-24px"]`、pocket: 右半分）で、ホバー・押下時に赤く色づくか、**通常クリックが止まるか**、**ボタンや inventory slot まで押せなくなっていないか**を入力方式ごとに記録する。プレイヤー側・ホットバーはブロッカーの範囲外であり、controller・タッチ入力は未検証である。赤く色づいてもアイテムが動く場合は、上重ねでは遮断できないという結果として扱う。
4. クリック通知・アイテム保護・画面の終了処理を、実機イベントとあわせて検証する。アイテム保護・画面終了処理・スクリプト側の入力処理は未実装であり、ブロッカーは押下を `button.invui_connect_blocked` へ流すだけで、`button.send` 部品からチャット送信が成立するかも未確認です。**ブロッカーがあることを保護の合格根拠にしないでください。**
5. `ui/invui_controls.json` を使う場合は、上記「オプトイン手順」で 2 ファイルを登録し、**手入力**で `!invui:<session-id>:<layout-generation>:<slot>:<sequence>` を送って観察する。session-id は開いた `Window._inputSessionId`、layout-generation は `Window._inputLayoutGeneration` をスクリプトから表示して取得し、open のたび・ページ変更のたびに読み直す（「session-id と layout-generation の取得手順」）。slot / session / layout-generation / sequence の自動生成はできない。既定 100 ms 間隔（10 回/秒）を超える連投は `rate-limited` で拒否される。キーボード入力の横取りと通常チェストへの影響を確認し、少しでも異常があれば即時中止する。
6. `ui/invui_grid_input.json` を使う場合は、既定の接続 2 ファイルを外した単独パックで、**使い捨てのマーカーアイテムだけ**をグリッドに置き、クリックごとにドロップ・スロット変化・`VirtualContainerItemChangeAfterEvent`・画面 close のどれが起きるかを記録する。`data_driven_container.desktop_panel` を使う全画面に影響し得る。pocket は対象外。通常画面への影響とアイテム消失が出た時点で中止する。**現行コアは itemChange をクリックとして扱わない**ため、このプローブ単体で `handleClick()` が走ることはない。

画面の接続先として `data_driven_container` 名前空間や `data_driven_container_screen.json` を変更する方法は、**Mojang は変更しないことを期待し、後方互換性を保証していません**（Minecraft Preview 26.70.23 告知）。このテンプレートは同名前空間の 2 パネルへ接続するため、検証専用の実験にとどめ、正式機能や配布物の前提にしないでください。

これらは手元の手順とチェックリストで記録してください。合格するまで「チェスト画面で動く」「安全」と表現しないでください。

## 既知の制約

- 対象ゲーム版、`@minecraft/server` の版、Experimental API の有効状態をこのテンプレートだけでは保証できません。
- 接続は既定で有効ですが、**実機未検証**です。`data_driven_container` の 2 パネルを使う**全画面に影響し得て**、VirtualContainer だけに限定できません。VirtualContainer 画面が同パネルを使っているかは未確定で、通常画面への影響も排除できません。
- **透明ブロッカーは保護ではなく、遮断を保証しません。** 覆った範囲ではボタンや inventory slot も抑制し得ますが、プレイヤー側のインベントリ・ホットバーは範囲外で、controller のフォーカス移動、タッチの長押し・ドラッグ、JSON UI を経由しない操作は止まらない可能性があります。押下先の `button.invui_connect_blocked` を処理するスクリプトもありません。
- **アイテム保護・入力抑制・画面終了処理は未完成**です。表示アイテムの取り出し、再描画による複製・消失、チャット送信の成否は未検証です。
- CLI が導入するのは接続込みの 3 ファイルです。既存 Resource Pack の `_ui_defs.json` への登録は手動です。
- `generate-resource-pack` は接続込みの 5 ファイルを生成し、`_ui_defs.json` も登録済みですが、実機未検証です。
- `ui/invui_controls.json` は**手入力の静的ペイロード送信プローブ**で、既定では未登録・未接続・CLI 対象外です。JSON UI から slot / session / layout-generation / sequence を自動生成して送る方式は根拠がなく、このプローブでも行いません。現在の session-id / layout-generation は開発者スクリプトが `Window._inputSessionId` / `Window._inputLayoutGeneration` を表示して取得します（JSON UI からは取得できません）。**入力ゲート**: 世代が一致していても、描画完了前・`placeholder` を指定しない未解決 provider・Container 再生成中・失敗スロットは button として扱われず、通知は拒否されます（Node.js 上での確認のみ、実機未検証）。有効化するとキーボード入力を奪い得るため、使い捨てワールドでのオプトイン検証にだけ使ってください。
- `ui/invui_grid_input.json` は**自動コンテナ変更プローブ**で、既定では未登録・未接続・CLI 対象外です。通常クリックを `button.drop_one` へ付け替えるため、**1 クリックごとにアイテムが 1 個ドロップされ得ます**（保護ではありません）。`button.drop_one` を通常クリックから発火させる書式と、オーバーレイが下の slot を対象にできるかは未検証です。サーバー側で itemChange をクリックとして処理する実装はなく、現行コアは itemChange を危険として close します。対象は `data_driven_container.desktop_panel` のみで、**同パネルを使う全画面に影響し得ます**。pocket は対象外です。既定の接続とは併用しないでください。
- 既存 Resource Pack との競合をゼロにはできません。追加するファイルは最小限ですが、無影響を保証するものではありません。
- `manifest.json` の UUID は固定のプレースホルダです。同じ内容のパックを複数入れると UUID が衝突し得ます。
- このテンプレートは実験用であり、初期リリースの正式機能ではありません。
