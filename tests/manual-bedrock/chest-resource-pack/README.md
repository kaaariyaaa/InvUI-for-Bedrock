# chest 画面マーカープローブ（単体実験用 RP）

`VirtualContainer` を開いたとき、ゲームが Mojang の **chest 画面**（`chest_screen.json` / `pocket_containers.json` のレイアウト）を使うかを、画面に出る黄色いラベルだけで観察する使い捨て Resource Pack です。ラベルを足すだけで、操作・入力・アイテムには一切触れません。

> [!WARNING]
> - **参照している samples の版と実行に必要なゲーム版は別です。** このパックが参照する `v1.26.70.23-preview` は UI 構造の参照元にすぎません。`VirtualContainer` を開くには npm beta `2.13.0-beta.1.26.70-preview.24` に対応する Preview ビルドが必要です（[API-NOTES.md](../API-NOTES.md) 第 1 節）。
> - **実機未検証。** このパック自体、ラベルの表示、`modifications` の適用可否、`VirtualContainer` がどの画面を使うかは検証していません。この実験で確認する対象そのものです。
> - **使い捨てワールド専用。** 本番ワールド・配布用ワールド・共有サーバーでは使わないでください。試験後はワールドごと破棄してよい状態にしてください。
> - **通常のチェストにも影響し得ます。** ラベルはバニラの chest パネル定義へ差し込むため、通常のチェスト・エンダーチェスト・シュルカーボックス・樽にも同じラベルが出ます。これは異常ではなく、このプローブの前提です。通常チェストの移動が壊れた場合は即時中止してください。
> - **保護・入力機能はありません。** ボタン、入力抑制、透明ボタン、クリック通知、アイテム保護は含みません。表示アイテムは従来どおり取り出せます。表示専用アイテムは使わないでください。
> - **`chest_screen.json` を上書きしません。** バニラのファイルを同梱・登録せず、別ファイルから `modifications` でラベルを差し込むだけです。
> - **陰性 1 回では断定できません。** ラベルが出ない場合でも「chest 画面を使っていない」とは限りません。パック未適用、`modifications` 非対応、継承元パネルへの差し込み失敗、ラベルの見切れの可能性があります。
> - **動作を断定しません。** この README は結果の解釈例を示すだけで、`VirtualContainer` が chest 画面を使う／使わないを保証しません。

## 何をするか

公式 `bedrock-samples` のタグ **`v1.26.70.23-preview`**（commit `430142679bb7daf3160671f06ab32ea433be1e1d`。UI 構造の参照元であり、実行に必要なゲーム版ではない）の UI 構造を参照し、次のパネルの `controls` 先頭にラベルを `insert_front` します。各パネルには黄色い静的なマーカーと、水色の `title_marker`（`text` は既存の画面変数 `$container_title` のみ）の 2 つが入ります。

| ファイル | 名前空間 | 差し込み先 | ラベル |
|---|---|---|---|
| `ui/invui_probe_chest.json` | `chest` | `small_chest_panel`, `large_chest_panel` | `InvUI probe: chest UI (desktop)` + `$container_title` |
| `ui/invui_probe_pocket.json` | `pocket_containers` | `small_chest_panel`, `large_chest_panel` | `InvUI probe: chest UI (pocket)` + `$container_title` |
| `ui/invui_probe.json` | `invui_probe` | ラベル定義のみ | — |

`$container_title` は、固定 samples（`v1.26.70.23-preview`）の全 UI ファイルと `_global_variables.json` のどこにも**定義がなく**、chest 画面の `chest_label`（`text: "$container_title"`）と `pocket_containers` の `container_header`（`$header_label` 経由）が**使っている**画面変数です。値はゲーム側が画面スコープへ供給し、既存ラベルはそれを継承して表示しています。差し込み先の `small_chest_panel` / `large_chest_panel` はどちらのラベルよりも**祖先**なので、サンプル上は同じ変数が見えます。ただし実機で挿入した control がこの変数を受け取ることは未検証で、これは固定 samples からの**仮説**です。`VirtualContainer` のタイトルがこの変数へ入るかも実機未検証です（下記）。

`title_marker` は素の `text` 参照だけで、binding・式・`ignored` ゲートを追加していません。`$container_title` を式や文字列比較に使うと 1.20.30 以降解決されない既知の制約がありますが（[MCPE-175115](https://bugs.mojang.com/browse/MCPE/issues/MCPE-175115)、素の表示は対象外）、このマーカーはその制約を踏みません。生の値を表示し `localize` は付けていないため、通常チェストでは翻訳キー（例: `container.chest`）が出る可能性があります。`ignored` ゲートを掛けないのは、タイトルが解決されない場合にラベルごと消えてパック読み込みの確認もできなくなるためです。

`chest_screen.json` ではデスクトップ用の `small_chest_panel` / `large_chest_panel` が `chest.small_chest_screen` / `chest.large_chest_screen` の `$screen_content` に指定され、ポケット用には `pocket_containers.small_chest_panel` / `large_chest_panel` が指定されています。この 2 系統を別ラベルで観察します。

```
manifest.json                     resources モジュール
ui/_ui_defs.json                  上記 3 ファイルの登録（バニラの一覧に追加されるだけ）
ui/invui_probe.json               ラベル定義（desktop / pocket / $container_title）
ui/invui_probe_chest.json         chest 名前空間への modifications
ui/invui_probe_pocket.json        pocket_containers 名前空間への modifications
check.mjs                         JSON 構造チェック（実機の代替ではない）
```

出典:

- [Mojang/bedrock-samples — `resource_pack/ui/chest_screen.json`（v1.26.70.23-preview）](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chest_screen.json)
- [Mojang/bedrock-samples — `resource_pack/ui/pocket_containers.json`（v1.26.70.23-preview）](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/pocket_containers.json)
- [Mojang/bedrock-samples — `resource_pack/ui/data_driven_container_screen.json`（v1.26.70.23-preview）](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/data_driven_container_screen.json)（比較用。この画面は chest 画面を土台にしないと明記されている）

`manifest.json` の `min_engine_version` は `[1, 26, 70]` の仮置きです。実際のゲーム版に合わせて変更してください。

## 手順

1. 使い捨てワールドを複製し、バックアップを取る。
2. このディレクトリを `development_resource_packs/` に置き、ワールドで有効化する。`VirtualContainer` を開くには npm beta `2.13.0-beta.1.26.70-preview.24` に対応する Preview ビルドが必要（ゲーム側の版表記は [API-NOTES.md](../API-NOTES.md) 第 8 節で確認）。samples の `v1.26.70.23-preview` は UI 構造の参照元にすぎない。Experimental を有効化する。
3. **先に通常のチェストを開く。** 黄色いラベルの有無と、末尾が `desktop` か `pocket` か、`title_marker` に通常チェストのタイトルが出るかを記録する。ここでラベルが出なければ、パックが読み込まれていない可能性があるため、以降の結果は使わない。
4. `VirtualContainer` の画面は、**同梱の raw probe**（[`tests/manual-bedrock/probe`](../probe/README.md)）の `!invui open 27` で開く。`Window.open()` 用の custom adapter やテスト用コードは使わない（現行コアの実アダプタは `Window.open()` から `VirtualContainer.open()` を既定で呼ぶが、実機未検証でアイテム保護もない。probe は使い捨てワールド前提で、stick/paper だけを扱う最小経路）。この手順の raw probe はタイトルを `InvUI probe 27` に固定する。
5. `VirtualContainer` 側の画面でラベルの有無と種類、`title_marker` の文字列を記録する。あわせて画面サイズ・UI スケール・言語・入力方式を記録する。
6. 終了後、通常のチェストでアイテム移動が従来どおり動くことを再確認する。

## 判定

| 観察 | 解釈の例（断定ではない） |
|---|---|
| `VirtualContainer` の画面にラベルが出た | その画面は chest 系パネルを参照している可能性が高い。`desktop` / `pocket` で系統を分けられる |
| `title_marker` に `InvUI probe 27`（手順 4 のタイトル）が出た | その chest 系パネルが、開いた `VirtualContainer` のタイトルを画面変数として受け取っている可能性が高い。ラベルだけより強い手がかりだが、タイトル binding は実機未検証で断定ではない |
| `title_marker` が空、`InvUI probe 27` 以外、または `$container_title` という文字列をそのまま表示した | その画面は別のコンテナのタイトルを受けている**かもしれない**。あるいは `$container_title` がこの位置へ伝播していない（変数名がそのまま出た場合は未解決）。タイトルだけでは陰性を断定できない |
| ラベルが出ない | chest 系パネルを使っていない、**または** パック未適用・`modifications` 非対応・継承元への差し込み失敗・ラベルの見切れ。**1 回の陰性では断定できない** |
| 通常のチェストで `desktop` ラベルが出た | プローブは期待どおり読み込まれている（基準確認） |
| 通常のチェストでラベルが出ない | プローブが効いていない。`VirtualContainer` 側の陰性も判定に使えない |
| pocket 側だけラベルが出ない | `small_chest_panel` は `panel` から `controls` を継承しているため、継承元配列への `modifications` が効いていない可能性がある |

ラベルはパネルの左上（画面コンテンツの左上）に固定オフセットで置きます。静的マーカーは `[4, 4]`、`title_marker` は `[4, 18]`、`layer` は 100 で、パネルに clip はありません。デスクトップのタイトルは中央の `root_panel` 内なので重なりません。pocket では上 27px のヘッダー帯に重なり、狭い画面や大きい UI スケールでは静的マーカーが左ヘッダーの `Player` と重なり得ます（静的マーカー側の見え方で、`title_marker` の追加によるものではありません）。見切れ・重なりを判断できるよう、画面サイズ・UI スケール・言語を記録してください。

静的マーカーと `title_marker` は同じ `insert_front` の `value` で入るため、静的マーカーが見えていれば `title_marker` も挿入されています。水色の文字が見えない場合は「挿入失敗」ではなく「`$container_title` が空/未解決」と読み、空・未解決・`$container_title` の literal 表示のどれだったかを実機で記録してください（サンプルからは決められません）。

## データ駆動画面プローブは別試験

`data_driven_container` 画面を使うかを調べるプローブは [../data-driven-resource-pack/](../data-driven-resource-pack/) にあり、**このパックとは別試験**です。両方を同時に有効化すると、どちらのラベルがどの画面由来か切り分けられなくなります。1 回の試験で有効化するのは一方だけにしてください。

このパックは chest 画面側のラベルだけを見ます。`data_driven_container` 側の判定や、両者の比較は行いません。

## 検査

```bash
node tests/manual-bedrock/chest-resource-pack/check.mjs
```

確認できるのは JSON の妥当性だけです。manifest の必須項目、`_ui_defs` の参照先、ラベルが `label` であること、`chest` / `pocket_containers` の対象パネルへの `insert_front`、`chest_screen.json` を同梱・登録していないこと、README に安全警告と出典が残っていることを `node:assert` で検証します。

確認できないこと:

- パックが読み込まれるか、ラベルが表示されるか。
- `VirtualContainer` が chest 画面を使うか。
- 通常チェストへの影響の有無、アイテムの複製・消失、入力方式ごとの挙動。

## 片付け

試験後はワールドごと破棄するか、このパックを無効化・削除してください。通常のチェストで移動が従来どおり動くことを再確認し、結果を記録します。
