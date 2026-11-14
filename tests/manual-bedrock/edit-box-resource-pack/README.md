# edit_box + button.send 実送信プローブ（単体実験用 RP）

`VirtualContainer` を含むチェスト画面に、**陽性対照ラベル**、**手入力のテキスト欄**、**`button.send` を発火させるボタン**を 1 つずつ差し込み、手入力した文字が実際にチャットとして送信されるかを**目視で観察する**ための使い捨て Resource Pack です。固定文字の自動送信、入力内容の Script API への受け渡し、クリック処理は実装していません。

> [!WARNING]
> - **実機未検証。** このパック自体、入力欄とボタンの表示、`edit_box` が文字を受け付けること、`modifications` の適用可否、`button.send` が入力内容を送信すること、probe が `NOTIFY_OBSERVED` を出すことは、いずれも検証していません。この実験で確認する対象そのものです。
> - **使い捨てワールド専用。** 本番ワールド・配布用ワールド・共有サーバーでは使わないでください。試験後はワールドごと破棄してよい状態にしてください。
> - **通常のチェストにも影響し得ます。** 入力欄とボタンはバニラの chest パネル定義へ差し込むため、通常のチェスト・エンダーチェスト・シュルカーボックス・樽にも同じものが表示される可能性があります。通常チェストの移動が壊れた場合は即時中止してください。
> - **チャット操作に影響し得ます。** このパックは chat 画面と同じ text box 名 (`#message_text_box`) と `always_listening` を使うため、チェスト画面を開いている間、チャット入力やキー操作を奪う・壊す可能性があります。`always_listening` はバニラで chat 画面だけが使っている指定であり、他画面での安全は確認されていません。試験を始める前に、チャット欄に入力途中の文面を残さないでください。
> - **通常チェストのアイテムを失い得ます。** 入力欄がキー操作を奪うと、意図しないドロップ (Q など) や移動が起きる可能性があります。確認に使う通常チェストにも価値のあるアイテムを入れず、使い捨てのアイテムだけで行ってください。
> - **固定文字の自動送信は提供しません。** 文字は毎回手入力です。`bindings` や初期 `text` は使っていません。入力内容を自動で `!invui:` 形式にする仕組みもありません。
> - **Script 接続は保証しません。** この Resource Pack は何も記録しません。観測は Behavior Pack 側 ([`../probe/`](../probe/README.md)) の `!invui:` チャット受信ログだけです。押下をスロット操作・クリック処理へつなぐ仕組みはありません。
> - **通知は偽装可能です。** `!invui:` で始まるチャットはプレイヤーが手入力できます。`NOTIFY_OBSERVED` のログは、それだけで本物の送信経路の証明になりません。
> - **操作抑制・アイテム保護は提供しません。** 入力の抑制、スロット操作の禁止、アイテムの保護・移動の制限はありません。表示アイテムは従来どおり取り出せます。表示専用アイテム（`setItem()` で置いたもの）は使わないでください。
> - **ボタンと入力欄は操作可能な UI 部品です。** 画面左上に固定オフセットで置くため、画面サイズ・UI スケール・言語次第でチェストの表示やスロットに重なる可能性があります。重なりや操作不能を確認したら中止してください。
> - **`chest_screen.json` を上書きしません。** バニラのファイルを同梱・登録せず、別ファイルから `modifications` で差し込むだけです。
> - **陰性 1 回では断定できません。** 入力欄に文字が入らない場合も、ボタン押下で何も起きない場合も、原因を切り分けられません。下記「判定」の条件を 1 つずつ確認してください。

## 根拠と限界

### 参照した公式 UI 構造

公式 `bedrock-samples` のタグ **`v1.26.70.23-preview`**（commit `430142679bb7daf3160671f06ab32ea433be1e1d`。UI 構造の参照元であり、実行に必要なゲーム版ではない）を読み、次の構造に合わせています。

| 参照元 | 確認した内容 | このパックでの使い方 |
|---|---|---|
| [`ui/chat_screen.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chat_screen.json) | `text_edit_box@common.text_edit_box` が `$text_box_name: "#message_text_box"`、`$text_edit_box_content_binding_name: "#message_text_box_content"`、`always_listening: true` を持つ。`send_button@common_buttons.light_text_form_fitting_button` が `$pressed_button_name: "button.send"` を持つ | 「この 2 つを同じ画面に置く」書式の根拠。**入力欄と送信ボタンの組み合わせをそのまま最小化**した |
| [`ui/ui_common.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_common.json) | `common.text_edit_box` が `text_box_name` / bindings / 表示ラベル / プレースホルダ / 背景を持つ。`common.button` の `button_mappings` が `button.menu_select` / `button.menu_ok` を `$pressed_button_name` に割り当てる | 入力欄は `common.text_edit_box` を継承し、必要な変数だけ上書き。ボタンは同じ 2 マッピングを明示的に持たせた |
| [`ui/ui_template_buttons.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/ui_template_buttons.json) | `light_text_button` / `light_text_form_fitting_button` の定義（chat の `send_button` の継承元） | ボタンを継承せず自前定義する判断の根拠（chat の send_button は `$button_type_panel` に送信アイコンを要求し、テキストボタンの変数を追加で必要とするため） |
| [`ui/chest_screen.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/chest_screen.json) | `small_chest_panel` / `large_chest_panel` が自前の `controls` を持つ | この 2 パネルの `controls` 先頭に 3 部品を `insert_front` |
| [`ui/pocket_containers.json`](https://github.com/Mojang/bedrock-samples/blob/v1.26.70.23-preview/resource_pack/ui/pocket_containers.json) | `small_chest_panel@panel` / `large_chest_panel@panel` は自前の `controls` を持たず、`panel` の `controls` を継承している | pocket 側の差し込み先。**継承元配列への `modifications` が効かない可能性がある**（下記「根拠が組めなかった部分」） |
| [Bedrock Wiki — Hardcoded Button IDs](https://wiki.bedrock.dev/json-ui/json-ui-documentation) | `button.send` は **Chat（`ui/chat_screen.json`）固有の hardcoded button ID** として列挙されている（samples では `ui/dev_console_screen.json` も同じ ID を使うが、そのテキスト欄も `chat.text_edit_box` を再利用している） | チェスト画面での成立が期待できない根拠。**この試験の中心的な不確実性** |

### このパックが置いている仮説

入力欄は chat 画面とまったく同じ `$text_box_name: "#message_text_box"` と `always_listening: true` を持たせています。つまり「**`button.send` は `#message_text_box` という名前の text box の中身を送る**」という仮説を、chat 画面の書式からそのまま借りています。入力欄の継承元も、バニラで実際に使われている `common.text_edit_box` です（`book_screen.json` / `play_screen.json` などと同じ使い方）。

### 根拠が組めなかった部分（正直な限界）

**「`#message_text_box` を chat 以外の画面で定義すれば `button.send` がその中身を送る」という結線は、公式 UI 構造からは確認できていません。**

- `text_box_name` が画面ローカルなのか、`button.send` が chat 画面の text box を直接参照するのかは、JSON からは判別できません。chat 画面では両者が同じ画面にあるため、どちらの解釈でも成立します。
- 入力欄の表示・入力内容の受け渡しに使う `#message_text_box_content` は、[Bedrock Wiki — Hardcoded Binding Names](https://wiki.bedrock.dev/json-ui/json-ui-documentation#hardcoded-binding-names) で **Chat 画面固有（screen specific）の hardcoded binding 名**として列挙されています。chat 以外の画面で同じ名前の binding が供給される保証はなく、これは「結線が未確認」というより**陰性予想を強める材料**です。
- チェスト画面がキーボード入力を受け付けるか、`always_listening` が chat 以外で機能するかも未確認です。バニラで `always_listening` を使っているのは chat 画面だけでした。
- `VirtualContainer` の画面が `chest_screen.json` / `pocket_containers.json` のパネルを使うか自体が未確認です（[API-NOTES.md](../API-NOTES.md) 第 4 節。`data_driven_container_screen.json` の採否は同ノートの未検証点 13）。`data_driven_container_screen.json` を使う場合、この差し込みは表示に現れない可能性があります。
- `pocket_containers` の `small_chest_panel` / `large_chest_panel` は `panel` から `controls` を継承しているため、`modifications`（`insert_front`）が効かない可能性があります（[`../chest-resource-pack/README.md`](../chest-resource-pack/README.md) の判定表と同じ既知の不確実性）。pocket 側でラベルが出ない場合、この差し込み失敗とパック未適用を切り分けられません。
- したがって**予想される結果は陰性**です。陰性は「この画面・この版では送信されなかった」ことしか示さず、`button.send` 自体の可否や、他の画面・版での成否を判定できません。逆に陽性でも、手入力による偽装や別経路の混入を排除できません。

この不確実性は「書式が組めない」ことではなく「結線が未確認」であることなので、**書式を最小構成で作り、結線の有無を観察する**方針を採りました。実装を見送るほどの根拠不足（`edit_box` の書式や `button.send` の書式が不明）ではありません。

## 何をするか

desktop は `chest` パネル自身の `controls`、pocket は `pocket_containers.panel` から継承された `controls` の先頭に、ラベル・入力欄・ボタンを 1 つずつ `insert_front` します。

| ファイル | 名前空間 | 差し込み先 | 挿入するもの |
|---|---|---|---|
| `ui/invui_edit_box_chest.json` | `chest` | `small_chest_panel`, `large_chest_panel` | desktop 用ラベル＋入力欄＋ボタン |
| `ui/invui_edit_box_pocket.json` | `pocket_containers` | `small_chest_panel`, `large_chest_panel`（`panel` から継承） | pocket 用ラベル＋入力欄＋ボタン |
| `ui/invui_edit_box.json` | `invui_edit_box` | 定義のみ | ラベル 2 種、入力欄 1 種、ボタン 1 種 |

配置は画面左上の固定オフセットです。ラベル `[4, 4]`、入力欄 `[4, 22]` サイズ `[200, 20]`、ボタン `[4, 46]` サイズ `[200, 20]`。ラベルは「パックがこの画面に適用された」ことの**陽性対照**であり、送信経路の陽性対照ではありません。

```
manifest.json                          resources モジュール
ui/_ui_defs.json                       上記 3 ファイルの登録（バニラの一覧に追加されるだけ）
ui/invui_edit_box.json                 ラベル 2 種・入力欄・send_button の定義
ui/invui_edit_box_chest.json           chest 名前空間への modifications
ui/invui_edit_box_pocket.json          pocket_containers 名前空間への modifications
check.mjs                              JSON 構造チェック（実機の代替ではない）
```

`manifest.json` の `min_engine_version` は `[1, 26, 70]` の仮置きです。実際のゲーム版に合わせて変更してください。名前空間 `invui_edit_box` は、`resource_pack/ui/invui.json` の `invui_probe` や他ディレクトリのパックと衝突しません。

## 手順

1. 使い捨てワールドを複製し、ワールドとパックのバックアップを取る。
2. このディレクトリを `development_resource_packs/` に置き、ワールドで有効化する。合わせて [`../probe/`](../probe/README.md) の Behavior Pack を導入し、Beta APIs / Experimental を有効化する。`VirtualContainer` を開くには npm beta `2.13.0-beta.1.26.70-preview.24` に対応する Preview ビルドが必要（ゲーム側の版表記は [API-NOTES.md](../API-NOTES.md) 第 8 節で確認）。
3. **通知経路の陽性対照（先に必須）。** 通常のチャットで `!invui:manual:0:0:0` と手入力して送信する。probe が `NOTIFY_OBSERVED ... message="!invui:manual:0:0:0" action=NONE` をコンソールに出し、そのメッセージが通常チャットに表示されないことを確認する。**これは「通常チャットから送信した」基準記録なので、送信時刻と送信方法（通常チャット）を控える。** ここでログが出ない場合、probe が動いていないため、以降の結果は判定に使えない。
4. **通常のチェストを開く。** 緑色の陽性対照ラベル、薄い入力欄、「Send typed text (unverified)」ボタンが出るか、末尾が `desktop` か `pocket` かを記録する。ラベルが出なければ、パック未適用・`modifications` 非対応・継承元への差し込み失敗・見切れの可能性があるため、以降の結果は使わない。
5. **入力欄をクリック（タッチはタップ）する。** カーソルが入るか、枠や見た目が変わるかを確認する。
6. **`!invui:editbox:0:0:0` を手入力する。** 1 文字ずつ入るか、入力欄に表示されるかを確認する。**入力欄への手入力の完了時刻を記録する。** **このとき絶対に `!invui:` 以外の文字を送らない。** 送信経路が成立していれば、通常の文字はそのまま公開チャットとして全員に表示される（probe がキャンセルするのは `!invui:` で始まるメッセージだけ）。
7. **送信ボタンを押す。** 押下時の見た目（hover / pressed の変化）とクリック音を確認しながら押し、probe のコンソールに `NOTIFY_OBSERVED` が出るか記録する。**押下時刻を記録し、手順 6 の入力完了時刻との前後関係（入力 → 押下の順）を控える。**入力欄の文字が消える・チャット画面が開く・チェストが閉じるなどの副作用も記録する。
8. `VirtualContainer` の画面は、同梱の raw probe の `!invui open 27` で開き、4〜7 を繰り返す（手順 4 は「通常のチェストを開く」ではなく、開いた画面でラベル・入力欄・ボタンが出るかの確認に読み替える）。`Window.open()` 用の custom adapter やテスト用コードは使わない（現行コアの実アダプタは `Window.open()` から `VirtualContainer.open()` を既定で呼ぶが、実機未検証でアイテム保護もない。probe の raw 経路を使う）。**チャットは画面表示中に入力できないため、手順 3 の陽性対照と手順 7 の結果確認は画面を閉じてから行う。**
9. 画面サイズ・UI スケール・言語・入力方式（PC / タッチ / コントローラー）を記録する。
10. 終了後、**通常のチェストでアイテム移動が従来どおり動くこと**と、**通常のチャットが従来どおり動くこと**を再確認する。

## 判定

| 観察 | 解釈の例（断定ではない） |
|---|---|
| 通常のチェストで緑ラベルが出ない | パックが効いていない。以降の陰性も判定に使えない |
| pocket 側でだけラベル・入力欄・ボタンが出ない | `pocket_containers` のパネルが `panel` の `controls` を継承しており、継承元配列への `modifications` が効いていない可能性。この系統の結果は判定に使わない（desktop 側とは分けて記録する） |
| ラベルは出るが入力欄が見えない | 継承・レイアウトの問題。**判定不能** |
| 入力欄は見えるが、クリックしても文字が入らない | キーボード入力が届いていない（フォーカス、`always_listening` の非対応、画面の入力処理）。**判定不能**。入力欄自体が機能していない可能性を記録する |
| 文字は入るが、送信ボタンで `NOTIFY_OBSERVED` が出ない | この画面では入力内容が `button.send` で送られなかった（予想どおり）。ただし `button.send` 自体の可否や、チャット画面以外での一般的不可能性は断定できない |
| 送信ボタン押下で、入力欄の文字が通常チャットに表示された | 送信経路は成立した可能性がある。`!invui:` 以外を送っていた場合は特に、内容・押下時刻・手順 3 の通常チャット送信との違い（送信方法と時刻）を記録する |
| `NOTIFY_OBSERVED` が出た（`!invui:editbox:...`） | 送信経路が成立した可能性がある。ただし手入力でも同じログが出るため、偽装・取り違えを排除できない。入力を自分で行っている以上「自分が入力していないこと」は確認できないので、代わりに **内容、入力欄への手入力の完了時刻、ボタン押下時刻、その前後関係、手順 3 の通常チャット送信と区別できる根拠**（送信方法と時刻の対応）を記録する |
| 画面を開いたままチャットが開く／キー入力が chat に流れる／チャットが壊れる | 入力欄がチャット操作を奪っている。**即時中止。** |
| 通常のチェストでアイテム移動が壊れた | **即時中止。** パックと probe を無効化する |
| 表示アイテムの増減・複製、クライアントのクラッシュ | **即時中止。** |

入力欄とボタンは画面左上に固定オフセットで置くため、UI スケールやレイアウト次第で見切れたり、タイトル・閉じるボタン・スロットと重なったりする可能性があります。陰性の場合は、画面サイズ・UI スケール・言語も記録してください。

## このパックが提供しないもの

- **固定文字の自動送信**: 初期値・`bindings`・自動入力はありません。文字は毎回手入力です。
- **Script 接続**: 押下や入力内容を Script API へ渡す仕組みはありません。probe は `!invui:` チャットの受信ログを出すだけで、click 処理を一切行いません。
- **操作抑制**: 通常クリック・スロット操作・ホットバー操作を止める仕組みはありません。逆に、入力欄とボタンが UI 上で操作可能なぶん、レイアウト次第ではクリックやキー入力を奪い得ます。
- **アイテム保護**: 表示アイテムの保護、移動制限、複製・消失の防止はありません。
- **通知の保証**: 入力内容が送られることも、probe が受信することも保証しません。
- **偽装耐性**: 通知は手入力でき、この RP も probe も送信元を認証しません。
- **画面識別**: このラベル・入力欄・ボタンは InvUI 専用画面の判定に使えません。通常のチェストにも同じものが出ます。

## 別試験

[`../button-send-resource-pack/`](../button-send-resource-pack/README.md)（`button.send` 単独プローブ）や [`../chest-resource-pack/`](../chest-resource-pack/)、[`../data-driven-resource-pack/`](../data-driven-resource-pack/)、[`../protection-resource-pack/`](../protection-resource-pack/) と**同時に有効化しないでください。** ラベルやボタンが同じ位置に重なり、どちらのパック由来か切り分けられなくなります。1 回の試験で有効化するのは 1 つだけにしてください。

## 検査

```bash
node tests/manual-bedrock/edit-box-resource-pack/check.mjs
```

確認できるのは JSON の妥当性だけです。manifest の必須項目と警告文、`_ui_defs` の参照先、入力欄が `common.text_edit_box` を継承し `#message_text_box` を指定していること、固定文字や `bindings` を追加していないこと、ボタンが `button.send` だけを発火すること、`chest` / `pocket_containers` の対象パネルへの `insert_front`、`chest_screen.json` を同梱・登録していないこと、probe が `!invui:` を監視していること、README に安全警告と出典が残っていることを `node:assert` で検証します。

確認できないこと:

- パックが読み込まれるか、ラベル・入力欄・ボタンが表示されるか。
- 入力欄が文字を受け付けるか、ボタン押下が `button.send` を発火するか、入力内容が送信されるか、probe が受信するか。
- チャット・通常チェストへの影響の有無、アイテムの複製・消失、入力方式ごとの挙動。

## 片付け

試験後はワールドごと破棄するか、このパックを無効化・削除してください。通常のチェストで移動が従来どおり動くこと、通常のチャットが動くことを再確認し、結果を記録します。
