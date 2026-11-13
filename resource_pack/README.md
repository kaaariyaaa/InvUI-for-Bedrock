# InvUI Resource Pack テンプレート（実験用・未検証）

> [!WARNING]
> **これは実機で未検証の隔離プローブです。**
>
> - `manifest.json` と `ui/_ui_defs.json` は同梱済みで、`ui/invui.json` はパック内で登録されています。`invui_probe` 名前空間には**可視ラベルと実験的な `button.send` 部品**を定義していますが、**どの画面からも参照していない**ため、**画面表示は変わらない想定**です。ただし**実機未検証であり、表示が変わらないことも、部品が読み込まれることも保証しません**。これらは独自部品で、画面へ未接続・実機未検証です。チャット送信やアイテム保護が動く保証はありません。
> - `ui/invui_controls.json` は**作成中の追加プローブ**です。完成扱いせず、動作確認や受け入れ判断に使わないでください。どの画面にも接続されておらず、`ui/_ui_defs.json` へも登録していません。CLI の導入対象でもありません。名前・内容・構造は変更される可能性があります。
> - 既存の Resource Pack やチェスト画面を変更・上書きしません。導入直後に表示が変わらなくても、それは正常/異常の判定材料になりません（パックが読み込まれているか自体が未検証です）。
> - `manifest.json` の UUID・version・`min_engine_version` はプレースホルダです。対応ゲーム版は確定していません。
> - 他の Resource Pack との競合を検出・解消する機能はありません。パックの重ね順や対象ゲーム版によって挙動が変わる可能性があります。他パックが同じ `invui_probe` 名前空間や同じ UUID を使っている場合も衝突し得ます。
> - 検証は**使い捨てワールド**で、既存 Resource Pack のバックアップを取ってから行ってください。通常のワールドや配布物へ入れないでください。

## 同梱物

このディレクトリは、使い捨てワールドへそのまま追加できる**単体の（未完成な）Resource Pack** です。`manifest.json` と `ui/_ui_defs.json` を含みますが、`ui/chest_screen.json` は含みません。

```text
resource_pack/
├── README.md              # この説明（パックの中身としては使われません）
├── manifest.json          # resources モジュール 1 つ。UUID と版はプレースホルダ
└── ui/
    ├── _ui_defs.json      # ui/invui.json を登録済み（controls は未登録）
    ├── invui.json         # 隔離された JSON UI 定義（可視ラベルと実験的 button.send 部品。CLI が導入するのはこれだけ）
    └── invui_controls.json # 作成中の追加プローブ（未登録・接続なし・CLI 対象外）
```

`ui/invui.json` は `invui_probe` 名前空間だけを定義し、バニラや他の Resource Pack の名前空間を参照・上書きしません。定義には**可視ラベルと実験的な `button.send` 部品**が含まれますが、これらは独自部品であり、どの画面からも参照されていないため、**画面表示は変わらない想定**です（実機未検証のため断定はできません）。**`_ui_defs.json` への登録は、ファイルを読み込ませるだけで画面への接続ではありません。** 部品は未接続・実機未検証で、チャット送信が成立する保証も、アイテム保護を提供する保証もありません。

## `ui/invui_controls.json`（作成中・未検証）

入力部品（`edit_box` とボタン）の記法を確かめるための追加プローブです。現時点では**作成中**であり、次のいずれも行っていません。

- `ui/_ui_defs.json` への登録
- どの画面からの参照・表示
- スクリプト側の入力受信
- 実機での確認

CLI はこのファイルを導入しません。手動でコピーした場合だけ配置されます。完成するまで、導入手順・部品名・挙動を確定したものとして扱わず、`invui.json` の確認や CHECKLIST の合否に含めないでください。

## 新規パックの生成

```bash
node bin/cli.js generate-resource-pack --output ./invui-probe-pack
```

出力先は未作成である必要があります。生成される manifest の UUID は毎回新しくなりますが、UI 部品は画面未接続・実機未検証です。

## CLI での導入

```bash
node bin/cli.js init \
  --resource-pack <Resource Pack のルート> \
  --install-resource-pack
```

`--install-resource-pack` を**明示した場合だけ**、`<Resource Pack のルート>/ui/invui.json` を追加します。指定しなければ従来どおり読み取り専用の検査だけを行います。

CLI が導入するのは **`ui/invui.json` だけ**です。`manifest.json`、`ui/_ui_defs.json`、`ui/chest_screen.json` は作成も変更もしません。このため、既存の Resource Pack へ導入した場合は `_ui_defs.json` への登録が自動では行われず、必要なら手動で追加します（単体パックとして使う場合は登録済みです）。

このディレクトリ自身を対象に実行した場合、`ui/invui.json` は同梱テンプレートと同一なので「導入済み」と報告し、何も書き込みません。`ui/invui_controls.json` は導入対象ではないため、有無や内容は判定に影響しません。

`--behavior-pack` も同時に検査できます（導入だけなら省略可）。

```bash
node bin/cli.js init \
  --behavior-pack <Behavior Pack のルート> \
  --resource-pack <Resource Pack のルート> \
  --install-resource-pack
```

### 安全側の動作

- **既存ファイルは上書きしません。** 追加するのは `ui/invui.json` だけです。
- 導入先の `ui/invui.json` が既に存在する場合:
  - 内容が同梱テンプレートと同一なら、何も書き換えず「導入済み」と報告します。
  - 内容が異なる場合は**競合として中断**し、テンプレートと既存内容の差分を表示します。終了コードは `1` です。
- `ui/` がファイルとして存在する、親ディレクトリを辿れない、導入先の検査にエラーがある（`manifest.json` がない、JSON として壊れている等）、などの場合は書き込み前に中断します。
- 書き込みは一時ファイルへ行い、完成後にだけ排他的に `ui/invui.json` として配置します。失敗した場合は追加済みファイル・一時ファイル・この CLI が作成した空ディレクトリを削除する**ロールバックを試みます**が、**ロールバック自体が失敗しうる**ため部分適用が残る可能性があります。削除できなかった場合はエラーメッセージに理由が含まれるので、対象の `ui/invui.json` と作成されたディレクトリを手動で確認・削除してください。`npm test` はシミュレートした失敗経路でロールバックを確認するだけで、すべてのファイルシステム障害を再現しません。
- 既存ファイルを変更しないため、既存内容のバックアップは不要です。ただし実験前に対象 Resource Pack 全体のバックアップを取ってください。導入後に元へ戻す場合は、追加された `ui/invui.json` を削除してください（`ui/` をこの CLI が作成した場合は、空なら削除できます）。
- 他の Resource Pack のファイル、`manifest.json`、`ui/chest_screen.json`、`ui/_ui_defs.json` は変更しません。

### JSON 出力

`--json` を併用すると、`resourcePackInstall` に導入結果（`installed` / `already-installed` / `conflict` / `blocked` / `failed` / `not-requested`）、追加したファイル、競合時の差分が入ります。標準出力は単体でパースできる JSON のままです。

## 導入後に手動で検討すること（すべて未検証）

`invui.json` を実際の画面へつなぐには、対象ゲーム版の JSON UI 仕様を確認したうえで、利用者が手動で次を行う必要があります。この CLI は自動化しません。

1. 既存の Resource Pack へ `invui.json` だけを追加した場合は、その `ui/_ui_defs.json` へ `ui/invui.json` を追加する（既存ファイルのバックアップと差分確認は利用者が行う。単体パックでは登録済み）。
2. 対象画面から `invui_probe` 名前空間の要素（可視ラベル・実験的な `button.send` 部品）を参照する方法を、実機の JSON UI 仕様に沿って検証する。`_ui_defs.json` への登録だけでは画面は変わらない。
3. クリック通知・アイテム保護・画面の終了処理を、実機イベントとあわせて検証する。`button.send` 部品からチャット送信が成立するかは未確認であり、送信も保護も保証されない。
4. `ui/invui_controls.json` は作成中のため、完成後に別途検証する。現時点の手順・部品名・挙動を確定したものとして扱わない。

画面の接続先として `data_driven_container` 名前空間や `data_driven_container_screen.json` を変更する方法は、**Mojang は変更しないことを期待し、後方互換性を保証していません**（Minecraft Preview 26.70.23 告知）。このテンプレート自身は同名前空間を変更しませんが、接続先として選ぶ場合は検証専用の実験にとどめ、正式機能や配布物の前提にしないでください。詳細は [data-driven 判定プローブ](../tests/manual-bedrock/data-driven-resource-pack/README.md) を参照してください。

これらは `tests/manual-bedrock/` の手順と CHECKLIST で記録してください。合格するまで「チェスト画面で動く」「安全」と表現しないでください。

## 既知の制約

- 対象ゲーム版、`@minecraft/server` の版、Experimental API の有効状態をこのテンプレートだけでは保証できません。
- `ui/invui.json` は登録済みでも、どの画面からも参照されていないため、置いただけではチェストに適用されません。含まれる可視ラベルと実験的な `button.send` 部品は未接続・実機未検証で、送信経路・アイテム保護は保証されません。チェスト画面へのフック方法は確定していません。
- `ui/invui_controls.json` は作成中であり、未完成・未登録・未接続です。完成まで利用者向け機能として扱えません。
- 既存 Resource Pack との競合をゼロにはできません。追加するファイルは最小限ですが、無影響を保証するものではありません。
- `manifest.json` の UUID は固定のプレースホルダです。同じ内容のパックを複数入れると UUID が衝突し得ます。
- このテンプレートは実験用であり、初期リリースの正式機能ではありません。
