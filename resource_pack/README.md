# InvUI Resource Pack テンプレート（既定で画面接続・実機未検証）

> [!WARNING]
> **これは実機で未検証の実験用パックです。現在は既定で画面接続が有効になっています。**
>
> - `ui/_ui_defs.json` は `ui/invui.json`、`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` の 3 つを登録済みです。後者 2 つが `data_driven_container` の `desktop_panel` / `pocket_panel` に `invui_probe` のラベルと実験的 `button.send` 部品を差し込みます。**登録済みのため、パックを置けば接続が働く想定**です。ただし**実機未検証であり、接続・表示・入力のどれも保証しません**。
> - 接続先は `data_driven_container` の 2 パネルです。**VirtualContainer を特定できないため、そのパネルを使うすべての画面（通常のコンテナや data-driven ブロックの画面を含み得る）に影響し得ます**。VirtualContainer だけに限定できません。`chest_screen` は編集しませんが、通常画面への影響を排除できません。
> - **アイテム保護・入力抑制・画面終了処理は未完成です。** 表示アイテムは取り出せる可能性があり、再描画との組み合わせで複製・消失が起き得ます（未検証）。`button.send` がチャットを送る保証もなく、スクリプト側の受信処理もありません。
> - `ui/invui_controls.json` は**作成中の追加プローブ**です。完成扱いせず、動作確認や受け入れ判断に使わないでください。どの画面にも接続されておらず、`ui/_ui_defs.json` へも登録していません。CLI の導入対象でもありません。
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
    ├── invui_connect.json # 警告ラベル + invui_probe_root のラッパー
    ├── invui_connect_data_driven.json
    │                      # data_driven_container の desktop/pocket への modifications
    └── invui_controls.json # 作成中の追加プローブ（未登録・接続なし・CLI 対象外）
```

## 既定で有効な画面接続

`ui/invui_connect_data_driven.json` は `data_driven_container.desktop_panel` と
`pocket_panel` の `controls` 先頭へ、次の 2 つを `insert_front` で差し込みます。

- `ui/invui_connect.json` の警告ラベル（「このパネルを使う全画面に適用され得る」ことを画面内に表示）
- `ui/invui.json` の `invui_probe_root`（ラベルと実験的 `button.send` 部品）

`chest_screen` は編集しません。ただし **VirtualContainer だけを識別する仕組みはなく**、
同じパネルを使う通常画面にも表示され得ます。`_ui_defs.json` への登録は接続を有効にするための
ものであり、表示・入力・アイテム保護が動くことを意味しません。

## `ui/invui_controls.json`（作成中・未検証）

入力部品（`edit_box` とボタン）の記法を確かめるための追加プローブです。現時点では**作成中**であり、次のいずれも行っていません。

- `ui/_ui_defs.json` への登録
- どの画面からの参照・表示
- スクリプト側の入力受信
- 実機での確認

CLI はこのファイルを導入しません。完成するまで、導入手順・部品名・挙動を確定したものとして扱わず、`invui.json` の確認や CHECKLIST の合否に含めないでください。

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
使い捨てワールド専用・アイテム保護なしという制約は変わりません。

## 新規パックの生成（接続込み）

```bash
node bin/cli.js generate-resource-pack --output ./invui-probe-pack
```

出力先は未作成である必要があります。生成される manifest の UUID は毎回新しくなります。
CLI は同梱テンプレートから `manifest.json`、`ui/_ui_defs.json`、`ui/invui.json`、
`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` を生成し、生成物の
`_ui_defs.json` は接続 2 ファイルを登録済みです。つまり生成物は**接続が既定で有効**ですが、
実機未検証であり、`data_driven_container` のパネルを使う全画面に影響し得ます。使い捨てワールド専用です。

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

`manifest.json` と `ui/chest_screen.json` も作成も変更もしません。`ui/invui_controls.json` は
導入対象ではないため、有無や内容は判定に影響しません。

`--behavior-pack` も同時に検査できます（導入だけなら省略可）。

### 安全側の動作

- **既存ファイルは上書きしません。** 追加するのは `ui/invui.json`、`ui/invui_connect.json`、
  `ui/invui_connect_data_driven.json` の 3 ファイルだけです。
- 導入先に同じ 3 ファイルのいずれかが既に存在する場合:
  - 内容が同梱テンプレートと同一なら、何も書き換えず「導入済み」と報告します。
  - 内容が異なる場合は**競合として中断**し、テンプレートと既存内容の差分を表示します。終了コードは `1` です。
- `ui/` がファイルとして存在する、親ディレクトリを辿れない、導入先の検査にエラーがある（`manifest.json` がない、JSON として壊れている等）、などの場合は書き込み前に中断します。
- 書き込みはファイルごとに一時ファイルへ行い、完成後にだけ排他的に配置します。失敗した場合は追加済みファイル・一時ファイル・この CLI が作成した空ディレクトリを削除する**ロールバックを試みます**が、**ロールバック自体が失敗しうる**ため部分適用が残る可能性があります。`npm test` はシミュレートした失敗経路でロールバックを確認するだけで、すべてのファイルシステム障害を再現しません。
- 既存ファイルを変更しないため、既存内容のバックアップは不要です。ただし実験前に対象 Resource Pack 全体のバックアップを取ってください。導入後に元へ戻す場合は、追加された 3 ファイルを削除してください（`ui/` をこの CLI が作成した場合は、空なら削除できます）。
- `ui/_ui_defs.json` と `ui/chest_screen.json` は変更しません（接続の登録は上記のとおり手動）。

### JSON 出力

`--json` を併用すると、`resourcePackInstall` に導入結果（`installed` / `already-installed` / `conflict` / `blocked` / `failed` / `not-requested`）、追加したファイル、競合時の差分が入ります。標準出力は単体でパースできる JSON のままです。

## 導入後に手動で検討すること（すべて未検証）

1. 既存の Resource Pack へ導入した場合は、その `ui/_ui_defs.json` の `ui_defs` へ `ui/invui.json`、`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` を追加する（既存ファイルのバックアップと差分確認は利用者が行う。CLI は 3 ファイルを配置するが登録はしない）。
2. 対象画面でラベル・ボタン・警告ラベルが表示されるか確認する。**`data_driven_container` のパネルを使う全画面に影響し得る**ため、VirtualContainer 以外（通常チェスト等）での表示も記録する。
3. クリック通知・アイテム保護・画面の終了処理を、実機イベントとあわせて検証する。保護・入力抑制・終了処理は未実装であり、`button.send` 部品からチャット送信が成立するかも未確認です。
4. `ui/invui_controls.json` は作成中のため、完成後に別途検証する。現時点の手順・部品名・挙動を確定したものとして扱わない。

画面の接続先として `data_driven_container` 名前空間や `data_driven_container_screen.json` を変更する方法は、**Mojang は変更しないことを期待し、後方互換性を保証していません**（Minecraft Preview 26.70.23 告知）。このテンプレートは同名前空間の 2 パネルへ接続するため、検証専用の実験にとどめ、正式機能や配布物の前提にしないでください。詳細は [data-driven 判定プローブ](../tests/manual-bedrock/data-driven-resource-pack/README.md) を参照してください。

これらは `tests/manual-bedrock/` の手順と CHECKLIST で記録してください。合格するまで「チェスト画面で動く」「安全」と表現しないでください。

## 既知の制約

- 対象ゲーム版、`@minecraft/server` の版、Experimental API の有効状態をこのテンプレートだけでは保証できません。
- 接続は既定で有効ですが、**実機未検証**です。`data_driven_container` の 2 パネルを使う**全画面に影響し得て**、VirtualContainer だけに限定できません。通常画面への影響も排除できません。
- **アイテム保護・入力抑制・画面終了処理は未完成**です。表示アイテムの取り出し、再描画による複製・消失、チャット送信の成否は未検証です。
- CLI が導入するのは接続込みの 3 ファイルです。既存 Resource Pack の `_ui_defs.json` への登録は手動です。
- `generate-resource-pack` は接続込みの 5 ファイルを生成し、`_ui_defs.json` も登録済みですが、実機未検証です。
- `ui/invui_controls.json` は作成中であり、未完成・未登録・未接続です。完成まで利用者向け機能として扱えません。
- 既存 Resource Pack との競合をゼロにはできません。追加するファイルは最小限ですが、無影響を保証するものではありません。
- `manifest.json` の UUID は固定のプレースホルダです。同じ内容のパックを複数入れると UUID が衝突し得ます。
- このテンプレートは実験用であり、初期リリースの正式機能ではありません。
