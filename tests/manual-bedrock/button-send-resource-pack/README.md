# button.send 通知プローブ（単体実験用 RP）

`VirtualContainer` を含むチェスト画面に、**陽性対照ラベル**と**実験用ボタン**を 1 つずつ差し込み、ボタン押下が `button.send` を発火させた結果、ペアの Behavior Pack（[`../probe/`](../probe/README.md)）が `!invui:` のチャット通知を受信するかを**目視で観察する**ための使い捨て Resource Pack です。ボタンとラベル以外は追加せず、操作の抑制・入力の横取り・アイテムの移動は行いません。

> [!WARNING]
> - **実機未検証。** このパック自体、ボタンとラベルの表示、`modifications` の適用可否、ボタン押下が `button.send` を発火すること、`!invui:` 通知が届くことは、いずれも検証していません。この実験で確認する対象そのものです。
> - **使い捨てワールド専用。** 本番ワールド・配布用ワールド・共有サーバーでは使わないでください。試験後はワールドごと破棄してよい状態にしてください。
> - **通常のチェストにも影響し得ます。** ラベルとボタンはバニラの chest パネル定義へ差し込むため、通常のチェスト・エンダーチェスト・シュルカーボックス・樽にも同じラベルとボタンが出ます。これは異常ではなく、このプローブの前提です。通常チェストの移動が壊れた場合は即時中止してください。
> - **通知は保証されません。** そもそも `button.send` は公式 samples では**チャット画面（と開発コンソール）の hardcoded button ID** です（下記「根拠と限界」）。チェスト画面にはチャット用のテキスト入力欄がなく、このパックはチャット文もテキスト入力欄も生成しません。したがって**ボタン押下だけで `!invui:` が送られるとは考えにくく、陰性が予想されます**。陰性は「`button.send` がどの画面でも使えない」ことの証明にはなりません。
> - **通知は偽装可能です。** `!invui:` で始まるチャットはプレイヤーが手入力できます。`NOTIFY_OBSERVED` のログは、それだけで本物のクリック経路の証明になりません。
> - **操作抑制・アイテム保護は提供しません。** 入力の抑制、スロット操作の禁止、アイテムの保護・移動の制限はありません。表示アイテムは従来どおり取り出せます。表示専用アイテム（`setItem()` で置いたもの）は使わないでください。
> - **ボタンは操作可能な UI 部品です。** スロットに重ならない位置（画面左上）に置きますが、画面サイズ・UI スケール・言語次第でチェストの表示やスロットに重なる可能性があります。重なりや操作不能を確認したら中止してください。
> - **`chest_screen.json` を上書きしません。** バニラのファイルを同梱・登録せず、別ファイルから `modifications` で差し込むだけです。
> - **パックは何も記録しません。** 通知の受信観測は Behavior Pack 側（`../probe/`）の機能です。この Resource Pack 単体ではログも判定も出ません。
> - **陰性 1 回では断定できません。** ラベルが出ない場合も、ボタンの押下が視覚的に変化しない場合も、原因を切り分けられません。下記「判定」の条件を 1 つずつ確認してください。

## 根拠と限界

### 参照した公式 UI 構造

公式 `bedrock-samples` のタグ **`v1.26.70.23-preview`**（commit `430142679bb7daf3160671f06ab32ea433be1e1d`。UI 構造の参照元であり、実行に必要なゲーム版ではない）を読み、次の構造に合わせています。

| 参照元 | 確認した内容 | このパックでの使い方 |
|---|---|---|
| [`ui/chest_screen.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chest_screen.json) | `small_chest_panel` / `large_chest_panel` が `controls` を持ち、`small_chest_screen` / `large_chest_screen` の `$screen_content` に指定される | この 2 パネルの `controls` 先頭にラベルとボタンを `insert_front` |
| [`ui/ui_common.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json) | `common.button` の `button_mappings` が `button.menu_select` / `button.menu_ok` を `$pressed_button_name` に割り当てる。押下で「その control の `$pressed_button_name`」が発火する | ボタンの書式の根拠。同じ 2 マッピングを明示的に持たせた |
| [`ui/chat_screen.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chat_screen.json) | `send_button@common_buttons.light_text_form_fitting_button` と `small_button@common_buttons.light_content_button` が `$pressed_button_name: "button.send"` を持つ | 「押下で `button.send` を発火させる」書式の根拠 |
| [`ui/dev_console_screen.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/dev_console_screen.json) | `send_button@common_buttons.light_content_button` も `$pressed_button_name: "button.send"` を持つ | 2 例目の根拠 |
| [Bedrock Wiki — Hardcoded Button IDs](https://wiki.bedrock.dev/json-ui/json-ui-documentation) | `button.send` は **Chat（`ui/chat_screen.json`）固有の hardcoded button ID** として列挙されている | チェスト画面での成立が期待できない根拠。**この試験の中心的な不確実性** |

`button` を `type: "button"` として自前定義し、`$pressed_button_name: "button.send"`、`button_mappings` 2 件、`default` / `hover` / `pressed` の画像とラベルだけを持たせています。`bindings`、`collection_name`、`edit_box`、`toggle`、`grid` などは含みません。

### 根拠が組めなかった部分（正直な限界）

**「押下したら固定文字列 `!invui:<...>` がチャットとして送られる」という書式は、公式 UI 構造から根拠を組めませんでした。** そのため、この RP はそこを実装せず、**「`button.send` を発火させるボタンがチェスト画面で通知を生むか」だけ**を観察します。

- バニラのチャット送信は、チャット画面のテキスト入力欄（`#message_text_box`）の中身を送る構造です。チェスト画面にはその入力欄がありません。
- JSON UI の `edit_box` は表示文字列をリテラルで持てず、`bindings` 経由でしか内容を与えられません。固定文字列を最初から入れておく書式を、公式 samples からは確認できませんでした。
- 入力欄を足せば「文字入りで送れるか」を試せますが、(1) チェスト画面の入力・キーバインドを奪い得る、(2) 固定文字列を初期表示する書式が未確認、(3) 今回の指示は「ボタン＋陽性対照ラベル」である、という理由で**追加していません**。必要なら別試験として切り分けてください。
- したがって**予想される結果は陰性**です。陰性は「この画面では `button.send` から `!invui:` が出なかった」ことしか示さず、`button.send` 自体の可否（チャット画面では使われている）や、将来テキスト入力欄を足した場合の成否は判定できません。

## 何をするか

次の 2 パネル系統の `controls` 先頭に、ラベルとボタンを 1 つずつ `insert_front` します。

| ファイル | 名前空間 | 差し込み先 | 挿入するもの |
|---|---|---|---|
| `ui/invui_button_send_chest.json` | `chest` | `small_chest_panel`, `large_chest_panel` | desktop 用陽性対照ラベル＋ボタン |
| `ui/invui_button_send_pocket.json` | `pocket_containers` | `small_chest_panel`, `large_chest_panel` | pocket 用陽性対照ラベル＋ボタン |
| `ui/invui_button_send.json` | `invui_button_send` | 定義のみ | ラベル 2 種とボタン 1 種 |

ラベルは画面左上 `[4, 4]` に緑色で出ます。ボタンはその下 `[4, 22]`、サイズ `[200, 20]`、`layer` 101 です。ラベルは「パックがこの画面に適用された」ことの**陽性対照**であり、通知経路の陽性対照ではありません。

```
manifest.json                          resources モジュール
ui/_ui_defs.json                       上記 3 ファイルの登録（バニラの一覧に追加されるだけ）
ui/invui_button_send.json              ラベル 2 種と send_button の定義
ui/invui_button_send_chest.json        chest 名前空間への modifications
ui/invui_button_send_pocket.json       pocket_containers 名前空間への modifications
check.mjs                              JSON 構造チェック（実機の代替ではない）
```

`manifest.json` の `min_engine_version` は `[1, 26, 70]` の仮置きです。実際のゲーム版に合わせて変更してください。名前空間 `invui_button_send` は、`resource_pack/ui/invui.json` の `invui_probe` や他ディレクトリのパックと衝突しません。

## 手順

1. 使い捨てワールドを複製し、ワールドとパックのバックアップを取る。
2. このディレクトリを `development_resource_packs/` に置き、ワールドで有効化する。合わせて [`../probe/`](../probe/README.md) の Behavior Pack を導入し、Beta APIs / Experimental を有効化する。`VirtualContainer` を開くには npm beta `2.13.0-beta.1.26.70-preview.24` に対応する Preview ビルドが必要（ゲーム側の版表記は [API-NOTES.md](../API-NOTES.md) 第 8 節で確認）。samples の `v1.26.70.23-preview` は UI 構造の参照元にすぎない。
3. **通知経路の陽性対照（先に必須）。** 通常のチャットで `!invui:manual:0:0` と手入力して送信する。probe が `NOTIFY_OBSERVED ... message="!invui:manual:0:0" action=NONE` をコンソールに出し、そのメッセージが通常チャットに表示されないことを確認する。ここでログが出ない場合、probe が動いていないため、以降のボタン試験は判定に使えない。
4. **通常のチェストを開く。** 緑色の陽性対照ラベルと「Press: button.send (unverified)」ボタンが出るか、末尾が `desktop` か `pocket` かを記録する。ラベルが出なければ、パック未適用・`modifications` 非対応・継承元への差し込み失敗・見切れの可能性があるため、以降の結果は使わない。
5. ボタンにカーソルを合わせ、**押下時の見た目（hover / pressed の変化）とクリック音**を確認しながら押す。あわせて probe のコンソールに `NOTIFY_OBSERVED` が出ないことを確認する（出た場合は内容と時刻を記録）。
6. `VirtualContainer` の画面は、同梱の raw probe の `!invui open 27` で開き、4〜5 を繰り返す。`Window.open()` 用の custom adapter やテスト用コードは使わない（現行コアの実アダプタは `Window.open()` から `VirtualContainer.open()` を既定で呼ぶが、実機未検証でアイテム保護もない。probe の raw 経路を使う）。
7. 画面サイズ・UI スケール・言語・入力方式（PC / タッチ / コントローラー）を記録する。
8. 終了後、**通常のチェストでアイテム移動が従来どおり動くこと**を再確認する。

## 判定

| 観察 | 解釈の例（断定ではない） |
|---|---|
| 通常のチェストで緑ラベルが出ない | パックが効いていない。`VirtualContainer` 側の陰性も判定に使えない |
| 通常のチェストで緑ラベルが出た | 陽性対照は成立。少なくとも desktop / pocket のどちらの系統かは切り分けられる |
| ラベルは出るが、ボタンの hover / pressed が変化せずクリック音もしない | クリックがボタンに届いていない（他の control が上にある、画面外、UI スケール、フォーカス）。**判定不能** |
| 押下の視覚変化はあるが `NOTIFY_OBSERVED` が出ない | この画面では `button.send` から `!invui:` 通知は出なかった（予想どおり）。ただし送るチャット文が存在しないため、`button.send` 自体の可否は断定できない |
| `NOTIFY_OBSERVED` が出た | 通知は届いた。ただし手入力でも同じログが出るため、偽装・取り違えを排除できない。内容・時刻・自分が入力していないことを記録する |
| 通常のチェストでアイテム移動が壊れた | **即時中止。** パックと probe を無効化する |
| 表示アイテムの増減・複製、クライアントのクラッシュ | **即時中止。** |

ラベルとボタンは画面左上に固定オフセットで置くため、UI スケールやレイアウト次第で見切れたり、タイトル・閉じるボタン・スロットと重なったりする可能性があります。陰性の場合は、画面サイズ・UI スケール・言語も記録してください。

## このパックが提供しないもの

- **操作抑制**: 通常クリック・スロット操作・ホットバー操作を止める仕組みはありません。逆に、ボタンが UI 上で操作可能なぶん、レイアウト次第ではクリックを奪い得ます。
- **アイテム保護**: 表示アイテムの保護、移動制限、複製・消失の防止はありません。
- **通知の保証**: `!invui:` が送られることも、probe が受信することも保証しません。
- **偽装耐性**: 通知は手入力でき、この RP も probe も送信元を認証しません。
- **入力ブリッジ / クリック処理**: 押下をスロット操作へつなぐ仕組みはありません。`bindings` も `collection` も使いません。
- **画面識別**: このラベルとボタンは InvUI 専用画面の判定に使えません。通常のチェストにも同じものが出ます。

## 別試験

[`../chest-resource-pack/`](../chest-resource-pack/)（chest 画面マーカー）や [`../data-driven-resource-pack/`](../data-driven-resource-pack/)（データ駆動画面マーカー）と**同時に有効化しないでください**。ラベルが同じ位置に重なり、どちらのパック由来か切り分けられなくなります。1 回の試験で有効化するのは 1 つだけにしてください。

## 検査

```bash
node tests/manual-bedrock/button-send-resource-pack/check.mjs
```

確認できるのは JSON の妥当性だけです。manifest の必須項目と警告文、`_ui_defs` の参照先、ラベルが `label` であること、ボタンが `button.send` だけを発火すること、禁止した入力系 control（`edit_box` / `toggle` / `grid` など）や `bindings` / `collection_name` が混入していないこと、`chest` / `pocket_containers` の対象パネルへの `insert_front`、`chest_screen.json` を同梱・登録していないこと、probe が `!invui:` を監視していること、README に安全警告と出典が残っていることを `node:assert` で検証します。

確認できないこと:

- パックが読み込まれるか、ラベルとボタンが表示されるか。
- ボタン押下が `button.send` を発火するか、通知が送られるか、probe が受信するか。
- 通常チェストへの影響の有無、アイテムの複製・消失、入力方式ごとの挙動。

## 片付け

試験後はワールドごと破棄するか、このパックを無効化・削除してください。通常のチェストで移動が従来どおり動くことを再確認し、結果を記録します。
