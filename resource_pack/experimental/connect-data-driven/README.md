# VirtualContainer 候補画面への試験的接続（隔離コピー・使い捨てワールド専用・実機未検証）

> [!WARNING]
> **かつて明示 opt-in だった接続は、現在 main の `resource_pack/ui/` に組み込まれて既定で有効です。**
> このディレクトリは独立した実験用の**参照コピー**として残しており、単体の Resource Pack ではありません
> （`manifest.json` を持ちません）。ここにある JSON は main の `ui/` と同一内容です。
>
> - **実機で一切検証していません。** パックが読み込まれるか、ラベルや部品が表示されるか、
>   入力がどうなるかは未確認です。
> - **VirtualContainer を特定できないため、接続先を VirtualContainer に限定できません。**
>   接続は `data_driven_container` の `desktop_panel` / `pocket_panel` を編集するため、
>   **そのパネルを使うすべての画面（通常のコンテナや data-driven ブロックの画面を含み得る）**
>   に適用されます。画面識別をしていないので、**実質的に全画面に適用され得る**前提で扱ってください。
>   **VirtualContainer 画面がこのパネルを使っているかは未確定**です。
> - **透明ブロッカーは保護ではありません。** コンテナ側グリッド付近を覆う透明な `button` で、
>   スロット系の入力を `button.invui_connect_blocked` へ付け替えるだけです。この ID を処理する
>   スクリプトはありません。覆った範囲では**ボタンや inventory slot も抑制し得る**一方、
>   **プレイヤー側のインベントリ・ホットバーは覆わず、controller・タッチ入力の遮断を保証しません**。
>   フォーカスが下のスロットへ移る、JSON UI を経由しない操作、長押し・ドラッグなどは止まらない
>   可能性があります。**完全な保護ではなく、遮断を保証しません。**
> - **通常画面への影響を排除できません。** 有効化したまま通常プレイをしないでください。
> - **アイテム保護・入力抑制・画面終了処理は未完成です。** 表示アイテムは取り出せる可能性があり、
>   再描画との組み合わせで複製が起き得ます（未検証）。`button.send` がチャットを送る保証もありません。
> - **使い捨てワールド専用。** バックアップを取り、試験後はワールドごと破棄するか、
>   追加したファイルと `_ui_defs.json` の変更を元に戻してください。
> - 他の実験用 Resource Pack（`button-send-resource-pack` / `chest-resource-pack` /
>   `data-driven-resource-pack` / `edit-box-resource-pack` / `protection-resource-pack`）と
>   **同時に有効化しないでください。**

## 何をするか

`tests/manual-bedrock/data-driven-resource-pack/` の判定プローブと同じ候補パネルに、
既存の `invui_probe.invui_probe_root`（`ui/invui.json` のラベルと実験的 `button.send` 部品）を
`insert_front` で差し込みます。加えて、適用範囲が全画面に及び得ることとブロッカーの限界を
画面内に示す警告ラベルを重ねます。**透明ブロッカー**は、デスクトップではスロット領域の
`panel_top_half`（`item_grid` と同じ基準）の `controls` 末尾へ、pocket では `pocket_panel` の
`controls` 末尾へ `insert_back` で差し込みます。

ブロッカーは `invui_connect_probe.grid_blocker` という透明な `button` で、デスクトップでは
`panel_top_half` 上で `offset [7, 10]` / `size [162, "100%-24px"]`（公式 sample の `item_grid` の
`offset [7, 10]` と 18px 行に一致）、`pocket_panel` では `anchor_from: top_middle` /
`anchor_to: top_left` / `offset [0, 27]` / `size ["50%", "100%-27px"]` の範囲を覆います。
ホバー・押下時だけ赤く色づきます。`button.menu_select`、`button.menu_ok`、
`button.menu_secondary_select`、`button.controller_select`、`button.menu_auto_place`、
`button.controller_secondary_select`、`button.menu_inventory_drop`、`button.menu_inventory_drop_all`
を `button.invui_connect_blocked` へ付け替えますが、この ID を受け取るスクリプトはありません。

```text
resource_pack/experimental/connect-data-driven/
├── README.md                        # この説明（パックの動作には使われません）
├── check.mjs                        # 構造チェック（実機の代替ではありません）
├── _ui_defs.opt-in.json             # 登録内容の参照用コピー（main の既定 _ui_defs.json と同一）
└── ui/
    ├── invui_connect.json           # 警告ラベル + 透明ブロッカー + 既存 invui_probe_root のラッパー
    └── invui_connect_data_driven.json
                                       # data_driven_container の desktop/pocket への modifications
```

接続先は `data_driven_container.desktop_panel` と `pocket_panel` の 2 つだけです。
`chest_screen` は編集しません。**VirtualContainer がこの画面を使うかは未確認**であり、
別の画面を使う場合、この接続では何も表示されません。

## 既定の有効化状態

main の `resource_pack/ui/_ui_defs.json` は次の 3 つを登録済みで、接続は既定で有効です。

```json
{
  "ui_defs": [
    "ui/invui.json",
    "ui/invui_connect.json",
    "ui/invui_connect_data_driven.json"
  ]
}
```

構造チェックは main パックの登録状態と、このディレクトリの JSON が main と同一であることを検査します
（**実機の代替ではありません**）。

```bash
node resource_pack/experimental/connect-data-driven/check.mjs
```

## 別の Resource Pack へ持ち出す場合

1. 使い捨てワールドを複製し、バックアップを取る。
2. このディレクトリの `ui/invui_connect.json` と `ui/invui_connect_data_driven.json` を
   対象パックの `ui/` へコピーし、そのパックの `ui/invui.json` も用意する。
3. 対象パックの `ui/_ui_defs.json` へ `ui/invui.json`、`ui/invui_connect.json`、
   `ui/invui_connect_data_driven.json` の 3 行を追加する（既存の登録は残す）。
4. 対象パックを Development Resource Pack として使い捨てワールドで有効化し、
   Experimental / Beta APIs を有効にする。`VirtualContainer` を開くには
   npm beta `2.13.0-beta.1.26.70-preview.24` に対応する Preview ビルドが必要
   （[API-NOTES.md](../../../tests/manual-bedrock/API-NOTES.md) 第 1 節・第 8 節）。
5. `VirtualContainer` は同梱の raw probe（[`tests/manual-bedrock/probe/`](../../../tests/manual-bedrock/probe/README.md)）の
   `!invui open 27` で開く。`Window.open()` を許可する独自アダプタやテスト用コードは使わない。
6. 表示された警告ラベル・`InvUI probe (experimental, unverified)`・ボタンの有無、
   末尾が `.desktop` か `.pocket` か、通常チェストでの表示、画面サイズ・UI スケール・言語・
   入力方式を記録する。ボタン押下でチャットが送られるかも目視で確認する
   （チャットは画面を閉じてから確認する）。
7. コンテナ側グリッド上でポインタを動かし、**赤い色づき**が出るか確認する。出なければ、
   ブロッカーが未適用・スロットより下・画面外・クリップのいずれかであり、**この陰性は
   判定に使えない**。赤い色づきが出たら、通常クリック・シフト相当・ドラッグ・ドロップ・
   ダブルクリック相当・タッチ・コントローラーで、アイテムが動くかを入力方式ごとに記録する。
   あわせて、**ブロッカーが覆った範囲のボタンや inventory slot まで押せなくなっていないか**、
   **プレイヤー側のインベントリ・ホットバーは操作できるか**（ブロッカーの範囲外なので
   想定どおり）を記録する。controller はフォーカスが下のスロットへ移り得るため、PC の結果を
   流用しない。
8. 試験後は追加した 2 ファイルを削除し、`ui/_ui_defs.json` をバックアップから戻す。
   ワールドごと破棄するのが最も安全。

> **既存パックでは CLI が `_ui_defs.json` を変更しません。** `init --install-resource-pack` は
> `ui/invui.json` と接続 2 ファイルを配置しますが、登録は手動です。`generate-resource-pack` は
> 接続 2 ファイルを含む 5 ファイルを生成し、生成物の `_ui_defs.json` は登録済みです。
> いずれも実機未検証であり、この実験を配布物・正式機能の前提にしないでください。

## 観察の解釈（いずれも推定）

| 観察 | 推定される解釈 |
|---|---|
| `VirtualContainer` の画面に警告ラベルと InvUI probe が出た | その画面が `data_driven_container` の desktop/pocket パネルを使っている**可能性がある**。ただし同じパネルを使う他の画面でも出るため、VirtualContainer 専用の証拠にはならない |
| 通常チェストでも出た | `data_driven_container` が通常画面と共有されている**可能性がある**。画面識別には使えない |
| どこにも出ない | パック未適用 / `modifications` 非対応 / ラベルが隠れた / VirtualContainer が別の画面を使っている、のいずれか。**1 回の陰性では何も断定できない** |
| グリッド上で赤い色づきが出た | ブロッカーが描画され、入力を受けている**可能性がある**。アイテム操作を止めた証拠ではない |
| 赤い色づきが出るのにアイテムが動く | JSON UI の上重ねだけでは遮断できない**可能性がある**。保護方式として採用しない判断材料になる |
| 赤い色づきが出てアイテムが動かない | その入力方式・その範囲では抑制できた**可能性がある**。全スロット・全操作・全画面の証明ではなく、保護でもない |
| ボタンや inventory slot が押せない | ブロッカーがそれらも覆っている**可能性がある**。スロット単位の選択はできない |
| プレイヤー側のインベントリ・ホットバーは動く | 想定どおり（ブロッカーはプレイヤー側を覆わない）。保護の不合格ではないが、保護でもない |
| コントローラーでフォーカスが下のスロットへ移り操作できる | ブロッカーがフォーカス対象を除去できていない**可能性がある**。PC の結果を流用しない |
| ボタンでチャットが送られた | `button.send` がこの画面で成立する**可能性がある**。スクリプト側の受信・クリック処理は未実装で、動作を保証しない |

## 既知の制約

- 画面タイトル等による識別は実装していません。**VirtualContainer だけに適用する方法は未確立**です。
  VirtualContainer 画面がこのパネルを使っているかも未確定です。
- **透明ブロッカーは保護ではありません。** 覆った範囲ではボタンや inventory slot も抑制し得ますが、
  プレイヤー側のインベントリ・ホットバーは範囲外です。controller・タッチ入力、フォーカス移動、
  JSON UI を経由しない操作の遮断は保証しません。**完全な保護ではなく、遮断を保証しません。**
- `data_driven_container` 名前空間と `data_driven_container_screen.json` は、Mojang が変更を控えるよう
  求めており、後方互換性は保証されません（Minecraft Preview 26.70.23 告知）。この接続は
  検証専用であり、将来の版で動く保証はありません。
- 構造チェックが確認できるのは JSON の妥当性、参照先、既定の登録状態だけです。
  パックの読み込み・表示・入力・アイテム保護・ブロッカーの遮断は確認できません。
- アイテム保護・入力抑制・画面終了処理は未完成です。通常画面への影響も排除できません。
