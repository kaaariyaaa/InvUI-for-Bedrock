# data_driven_container 画面プローブ（単体実験用 RP）

`VirtualContainer` を開いたとき、ゲームが Mojang の `data_driven_container` 画面を使う**可能性があるか**を、画面に出る可視ラベルだけを手がかりに**推定する**使い捨て Resource Pack です。操作・アイテム・クリックには一切触れません。推定であって判定ではないため、結果は「そうかもしれない」以上の意味を持ちません。

> [!WARNING]
> - **Mojang 公式はこの画面の変更を控えるよう求め、互換性を保証していません。** Minecraft Preview 26.70.23 の告知は、`data_driven_container_screen.json` と `data_driven_container` 名前空間について、**クリエイターがこの UI を変更しないことを期待しており**、**将来の破壊的変更があり得て後方互換性を保証しない**としています（[告知](https://minecraft.net/en-us/article/minecraft-preview-26-70-23)、詳細は [API-NOTES.md](../API-NOTES.md)）。告知は「非推奨（deprecated）」とは述べていません。このパックが動く保証はなく、この実験の結果を将来のバージョンへの恒久的な前提にしないでください。
> - **参照する samples の版と実行に必要なゲーム版は別です。** ここで使う `bedrock-samples` の 26.70.23 はパネル名を参照するための版にすぎません。`VirtualContainer` を開くには npm beta `2.13.0-beta.1.26.70-preview.24` に対応する Preview ビルドが必要です（[API-NOTES.md](../API-NOTES.md) 第 1 節）。
> - **実機未検証。** このパック自体、ラベルの表示、`modifications` の適用可否は検証していません。
> - **使い捨てワールド専用。** 本番・配布・共有サーバーでは使わないでください。`modifications` はバニラの `data_driven_container` 名前空間を直接対象にしているため、通常プレイ中の画面にも作用する**可能性があります**（有効化したまま遊ぶと普段のコンテナ画面にマーカーが出るかもしれません。実機未検証です）。
> - **どの画面を `VirtualContainer` が使うかは未確認**です。この実験で確認する対象そのものです。
> - **読み込み失敗と画面違いは区別できません。** ラベルが出ない場合、原因は「パックが読み込まれていない」「`modifications` が適用されていない」「ラベルがレイアウトに隠れた」「`VirtualContainer` が別の画面を使っている」のいずれかで、この実験だけでは切り分けられません（[下記](#読み込み失敗と画面違いは区別できない)）。
> - **通常画面にもマーカーが出る可能性があります。** `data_driven_container` 画面が通常のコンテナと共有されている場合、チェスト等の通常画面でも同じラベルが出るかもしれません。その場合、ラベルの有無は `VirtualContainer` 固有の識別には使えません。このパックの `modifications` はバニラ名前空間 `data_driven_container` を直接対象にしているため、**通常画面にも作用し得る前提**で扱ってください。
> - **操作制御はありません。** 入力抑制・透明ボタン・アイテム保護・クリック通知は含みません。表示アイテムは**従来どおり取り出せてしまう可能性があります**（実際に取り出せるかは未検証です。検証するなら貴重品を使わないでください）。
> - **`chest_screen` は編集しません。** このパックは `chest_screen` を登録も上書きもしません。

## 何をするか

`bedrock-samples` preview 1.26.70.23（UI 構造の参照元。実行に必要なゲーム版ではない）の `resource_pack/ui/data_driven_container_screen.json`（`data_driven_container` 名前空間）の既存パネル名を借りて、**バニラ JSON を複製せず**、`modifications` で次の 3 点だけを追加します。

- 独自名前空間 `invui_probe` に黄色いラベルを 2 つ定義（`desktop_marker` / `pocket_marker`）。
- 同じ名前空間に水色の `title_marker` を 1 つ定義。`text` は `$container_title` だけを使う。
- `data_driven_container.desktop_panel` と `pocket_panel` の `controls` 先頭に、そのパネル用のラベルと `title_marker` を `insert_front` で差し込む。

`$container_title` は、この画面の `container_label`（pocket は `container_header` の `$header_label` → `$container_title`）が既に使っている**画面変数**です。`title_marker` はその値をそのまま表示するだけで、新しい binding 名や架空の変数を追加していません。`VirtualContainer` のタイトルがこの変数へ入るかは実機未検証です（下記）。`title_marker` は生の値を表示し、`localize` は付けていません。通常チェストでは翻訳キー（例: `container.chest`）が出る可能性があり、翻訳表示は検証していません。 タイトルで `ignored` ゲートはかけていません。タイトルが解決されない場合にラベルごと消えて、パック読み込みの確認もできなくなるためです。

```
ui/invui_probe.json              invui_probe 名前空間のラベル定義（静的マーカー + $container_title）
ui/invui_probe_data_driven.json  data_driven_container への modifications
ui/_ui_defs.json                 上記 2 ファイルの登録（バニラの一覧に追記される想定。置き換えてしまう可能性は未検証）
manifest.json                    resources モジュール
check.mjs                        JSON 構造チェック（実機の代替ではない）
```

## 手順

1. 使い捨てワールドを複製し、バックアップを取る。
2. このディレクトリを `development_resource_packs/` に置き、ワールドで有効化する。`VirtualContainer` を開くには npm beta `2.13.0-beta.1.26.70-preview.24` に対応する Preview ビルドが必要（ゲーム側の版表記は [API-NOTES.md](../API-NOTES.md) 第 8 節で確認）。samples の 1.26.70.23 は UI 構造の参照元にすぎない。Experimental を有効化する。
3. 通常チェストでもラベルの有無を参考として記録する。ただし通常チェストは陽性対照ではない。
4. `VirtualContainer` の画面は、**同梱の raw probe**（[`tests/manual-bedrock/probe`](../probe/README.md)）の `!invui open 27` で開く。custom Window adapter や `Window.open()` を直接叩くテスト用コードは書かない（現行コアの実アダプタは `Window.open()` から `VirtualContainer.open()` を既定で呼ぶが、実機未検証で保護もない。probe は使い捨てワールド前提で、stick/paper だけを扱う最小経路）。この手順の raw probe はタイトルを `InvUI probe 27` に固定する。
5. 表示されたラベルの有無、末尾が `.desktop` か `.pocket` か、`title_marker` に表示された文字列を記録する。

## 観察の解釈（いずれも推定）

| 観察 | 推定される解釈 |
|---|---|
| `VirtualContainer` の画面にラベルが出た | その画面が `data_driven_container` 系列を使っている**可能性がある**（desktop / pocket も判別できるかもしれない）。ただし data-driven ブロックなど他の利用箇所でも出得るため、ラベルだけで VirtualContainer 専用とは言えない |
| `title_marker` に `InvUI probe 27`（手順 4 のタイトル）が出た | そのパネルが、開いた `VirtualContainer` のタイトルを画面変数として受け取っている**可能性がある**。ラベルの有無だけより強い手がかりになるが、タイトル binding と `modifications` の適用は実機未検証で、断定ではない |
| `title_marker` が空、`InvUI probe 27` 以外、または `$container_title` という文字列をそのまま表示した | その画面は別のコンテナのタイトルを受けている**かもしれない**。あるいは `$container_title` がこの位置へ伝播していない（変数名がそのまま出た場合は未解決）。タイトルだけでは陰性を断定できない |
| ラベルが出ない | `data_driven_container` を使っていない**かもしれない**。**または** パック未適用・`modifications` 非対応・ラベルがレイアウトに隠れた。**1 回の陰性では何も断定できない** |
| 通常チェストでもラベルが出た | `data_driven_container` が通常コンテナと共有されている**可能性がある**。VirtualContainer だけの識別には使えない |

### 読み込み失敗と画面違いは区別できない

このパックは「正常に動けばラベルが出る」という前提の実験ですが、その前提自体が未検証です。さらに、**ラベルが出ないという 1 つの観察結果**からは次を区別できません。

1. パックが読み込まれていない（マニフェスト不正、バージョン不一致、実験設定オフ、キャッシュ）。
2. パックは読み込まれたが `modifications` が適用されていない（非対応・書式変更）。
3. `modifications` は適用されたが、ラベルがレイアウトに隠れた（UI スケール、画面サイズ、`insert_front` 先の描画順）。
4. パックも適用も正常で、`VirtualContainer` が `data_driven_container` 以外の画面を使っている（この実験の本来の対象）。

したがって陰性の結果は「`VirtualContainer` はこの画面を使っていない」の証拠になりません。通常チェストは samples 上で別の画面を使うため、ラベルが出なくてもこのパックの読み込み失敗を意味せず、陽性対照にはなりません。このパックに独立した陽性対照はありません。UI スケール・画面サイズ・言語・パックの有効化状態を記録してください。

ラベルはパネル左上に固定オフセットで置くため、UI スケールやレイアウト次第で見切れる可能性があります。

## 検査

```bash
node tests/manual-bedrock/data-driven-resource-pack/check.mjs
```

確認できるのは JSON の妥当性（パース、`_ui_defs` の参照先、`invui_probe` のラベル、`desktop_panel` / `pocket_panel` への `insert_front`、`chest_screen` を触っていないこと）だけです。パックが読み込まれるか、ラベルが表示されるかは確認できません。

## 片付け

試験後はワールドごと破棄するか、このパックを無効化・削除してください。
