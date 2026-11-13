# data_driven_container 画面プローブ（単体実験用 RP）

`VirtualContainer` を開いたとき、ゲームが Mojang の `data_driven_container` 画面を使う**可能性があるか**を、画面に出る可視ラベルだけを手がかりに**推定する**使い捨て Resource Pack です。操作・アイテム・クリックには一切触れません。推定であって判定ではないため、結果は「そうかもしれない」以上の意味を持ちません。

> [!WARNING]
> - **Mojang 公式はこの画面の変更を非推奨とし、互換性を保証していません。** Minecraft Preview 26.70.23 の告知が `data_driven_container_screen.json` と `data_driven_container` 名前空間への変更を **非推奨（deprecated）** と明記し、**互換性を保証しない**としています（[告知](https://minecraft.net/en-us/article/minecraft-preview-26-70-23)、詳細は [API-NOTES.md](../API-NOTES.md)）。このパックが動く保証はなく、この実験の結果を将来のバージョンへの恒久的な前提にしないでください。
> - **実機未検証。** このパック自体、ラベルの表示、`modifications` の適用可否は検証していません。
> - **使い捨てワールド専用。** 本番・配布・共有サーバーでは使わないでください。通常プレイ中の画面にも作用するため、有効化したまま遊ぶと普段のコンテナ画面にマーカーが出ます。
> - **どの画面を `VirtualContainer` が使うかは未確認**です。この実験で確認する対象そのものです。
> - **読み込み失敗と画面違いは区別できません。** ラベルが出ない場合、原因は「パックが読み込まれていない」「`modifications` が適用されていない」「ラベルがレイアウトに隠れた」「`VirtualContainer` が別の画面を使っている」のいずれかで、この実験だけでは切り分けられません（[下記](#読み込み失敗と画面違いは区別できない)）。
> - **通常画面にもマーカーが出る可能性があります。** `data_driven_container` 画面が通常のコンテナと共有されている場合、チェスト等の通常画面でも同じラベルが出るかもしれません。その場合、ラベルの有無は `VirtualContainer` 固有の識別には使えません。このパックの `modifications` はバニラ名前空間 `data_driven_container` を直接対象にしているため、**通常画面にも作用し得る前提**で扱ってください。
> - **操作制御はありません。** 入力抑制・透明ボタン・アイテム保護・クリック通知は含みません。表示アイテムは**従来どおり取り出せてしまう可能性があります**（実際に取り出せるかは未検証です。検証するなら貴重品を使わないでください）。
> - **`chest_screen` は編集しません。** このパックは `chest_screen` を登録も上書きもしません。

## 何をするか

`bedrock-samples` preview 1.26.70.23 の `resource_pack/ui/data_driven_container_screen.json`（`data_driven_container` 名前空間）を土台に、次の 2 点だけを追加します。

- 独自名前空間 `invui_probe` に黄色いラベルを 2 つ定義（`desktop_marker` / `pocket_marker`）。
- `data_driven_container.desktop_panel` と `pocket_panel` の `controls` 先頭に、そのラベルを `insert_front` で差し込む。

```
ui/invui_probe.json              invui_probe 名前空間のラベル定義
ui/invui_probe_data_driven.json  data_driven_container への modifications
ui/_ui_defs.json                 上記 2 ファイルの登録（バニラの一覧に追記される想定。置き換えてしまう可能性は未検証）
manifest.json                    resources モジュール
check.mjs                        JSON 構造チェック（実機の代替ではない）
```

## 手順

1. 使い捨てワールドを複製し、バックアップを取る。
2. このディレクトリを `development_resource_packs/` に置き、ワールドで有効化する（preview 1.26.70.23 系で Experimental を有効化）。
3. **先に通常のチェストを開く。** ラベルの有無を記録する。
4. `VirtualContainer` の画面は、**同梱の raw probe**（[`tests/manual-bedrock/probe`](../probe/README.md)）の `!invui open 27` で開く。危険な custom Window adapter や `Window.open()` を直接叩くテスト用コードは書かない（現行コアは `Window.open()` を既定で拒否する。probe は使い捨てワールド前提で、stick/paper だけを扱う最小経路）。
5. 表示されたラベルの有無と、末尾が `.desktop` か `.pocket` かを記録する。

## 観察の解釈（いずれも推定）

| 観察 | 推定される解釈 |
|---|---|
| `VirtualContainer` の画面にラベルが出た | その画面が `data_driven_container` 系列を使っている**可能性がある**（desktop / pocket も判別できるかもしれない）。ただし通常画面でも出得るため、ラベルだけで VirtualContainer 専用とは言えない |
| ラベルが出ない | `data_driven_container` を使っていない**かもしれない**。**または** パック未適用・`modifications` 非対応・ラベルがレイアウトに隠れた。**1 回の陰性では何も断定できない** |
| 通常チェストでもラベルが出た | `data_driven_container` が通常コンテナと共有されている**可能性がある**。VirtualContainer だけの識別には使えない |

### 読み込み失敗と画面違いは区別できない

このパックは「正常に動けばラベルが出る」という前提の実験ですが、その前提自体が未検証です。さらに、**ラベルが出ないという 1 つの観察結果**からは次を区別できません。

1. パックが読み込まれていない（マニフェスト不正、バージョン不一致、実験設定オフ、キャッシュ）。
2. パックは読み込まれたが `modifications` が適用されていない（非対応・書式変更）。
3. `modifications` は適用されたが、ラベルがレイアウトに隠れた（UI スケール、画面サイズ、`insert_front` 先の描画順）。
4. パックも適用も正常で、`VirtualContainer` が `data_driven_container` 以外の画面を使っている（この実験の本来の対象）。

したがって陰性の結果は「`VirtualContainer` はこの画面を使っていない」の証拠になりません。切り分けるには、**同じパックを有効にしたまま通常チェストを開いてラベルが出ることを先に確認**し、そのうえで UI スケール・画面サイズ・言語・パックの有効化状態を記録してください。手順 3 がそのための確認です。

ラベルはパネル左上に固定オフセットで置くため、UI スケールやレイアウト次第で見切れる可能性があります。

## 検査

```bash
node tests/manual-bedrock/data-driven-resource-pack/check.mjs
```

確認できるのは JSON の妥当性（パース、`_ui_defs` の参照先、`invui_probe` のラベル、`desktop_panel` / `pocket_panel` への `insert_front`、`chest_screen` を触っていないこと）だけです。パックが読み込まれるか、ラベルが表示されるかは確認できません。

## 片付け

試験後はワールドごと破棄するか、このパックを無効化・削除してください。
