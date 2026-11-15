# Bedrock 実機テスト手順（フェーズ0）

> [!WARNING]
> **すべて実機未検証。使い捨てワールド専用。** 本番・配布用ワールドや共有サーバーでは実施しない。表示専用アイテムは保護されておらず、取り出し＋再描画で複製、再描画で消失し得る。価値のあるアイテムは使わない。

## 手順（この順で）

前の段階が不合格なら次へ進まない。

### 1. 準備

- テスト用ワールドを複製し、バックアップを取る。Preview/Beta で Experimental API を有効化する。
- ゲーム版・`@minecraft/server` 版・プラットフォーム・入力方式・パックの版/ハッシュを記録する。
- 静的検査だけなら CLI（既定で書き込みなし）:

  ```bash
  node bin/cli.js init --behavior-pack <BP> --resource-pack <RP> --json
  ```

  既存 RP へ `ui/invui.json` と試験的接続 2 ファイルを追加する場合のみ `--install-resource-pack` を付ける。`ui/_ui_defs.json` への登録は手動で行い、差分を確認する。
- 試験マトリクス（9 / 27 / 54 スロット × PC / タッチ / コントローラー）を用意する。

### 2. 通常チェストの基準確認（`BASE-01`〜`03`）

接続ファイルを `_ui_defs.json` へ登録する**前と後**で、通常チェストのアイテム移動・ボタン操作が従来どおりできることを確認する。接続は `data_driven_container` のパネルを使う全画面に及び得るため、必ず最初に行う。壊れたら中止して接続を外す。

### 3. 表示（`DISP-01`〜`03`）

`Window.open()` は既定で実画面を開く（テスト用アダプタ不要）。9 / 27 / 54 スロットで、位置・個数・見た目と、最終ページ・未使用スロットが空であることを確認する。各スロット数・入力方式・画面サイズ・UI スケール・言語を記録する。

### 4. アイテム保護（`PROT-01`〜`04`）

表示専用スロットで通常クリック、Shift クリック、ドラッグ、ダブルクリック、ドロップを試し、持ち出せない・増減しないことを確認する。現行コアは無保護なので、保護を組み込んだテストビルドでのみ合格できる。1 つでも持ち出せたら中止し、クリック通知へ進まない。

### 5. クリック通知（`CLICK-01`〜`11`）

透明ボタン等の入力経路がある場合のみ。1 クリック 1 通知、プレイヤーとスロットの特定、ページ変更・終了後の古い通知の破棄、通常チャットに表示されないこと、連投の重複処理、描画完了前の通知が実行されないことを確認する。

`button.send` → チャット通知は候補であり未確定。ライブラリ側は `world.beforeEvents.chatSend` で `!invui:<session-id>:<layout-generation>:<slot>:<sequence>` を受けて `handleClick()` へ流す受信経路のみ実装済み（Node.js テスト済み・実機未検証）。UI 側の自動生成はなく、通知は手入力で偽装できる。手入力プローブか、通知を生成するテストビルドでのみ実施する。候補の整理は [CLICK-NOTIFICATION-NOTES.md](CLICK-NOTIFICATION-NOTES.md)、カーソル案は [CURSOR-INPUT-NOTES.md](CURSOR-INPUT-NOTES.md) を参照。

### 6. `InventoryLink`（`INV-01`〜`05`）

必ず最後に、使い捨てアイテムだけで実施する。リンク先と保管領域の間でクリック・ドラッグ・カーソル上アイテム・画面終了・死亡を組み合わせ、増減が一致するか確認する。現行コアの `moveTo()` は常に `InventoryLinkMoveRejectedError` を投げるため、有効化したテストビルドでのみ実施できる。複製・消失が 1 件でもあれば中止し、無効のままにする。

### 7. ライフサイクル（`LIFE-01`〜`07`）

死亡、ディメンション移動、切断、スペクテイター切替、shutdown、スクリプト再読み込みを試す。退出は `PlayerLeft`、死亡は `PlayerDied`、ディメンション移動は `ServerClosed`、スペクテイターは `PlayerSpectating` で 1 回だけ close され、購読が解放され、自動再オープンしないことを確認する。shutdown は restricted execution のため close ハンドラーから `VirtualContainer.close()` や `unsubscribe()` を呼ばない。再読み込み時の後始末は未対応で、合格根拠にしない。

### 8. 競合（`COMPAT-01`〜`03`）

他の Resource Pack と併用し、通常チェスト・InvUI 画面・UI の表示崩れ、ボタン操作を接続の登録前後で比較する。`button-send-resource-pack/` は単独使用前提なので併用しない。

## プローブ一覧

| プローブ | 何を確かめるか | 導入方法 | 参照先 |
|---|---|---|---|
| `probe/` | `VirtualContainer` 単体の表示・close reason・itemChange、`!invui` チャット通知の受信観測 | BP をワールドへ配置（コア不要） | [README](probe/README.md) |
| `locked-click-probe/` | `ItemLockMode.slot` の通常クリックで itemChange が届くか（観測のみ） | `.mcpack` を取り込むかフォルダ配置 | [README](locked-click-probe/README.md) |
| `chest-resource-pack/` | `VirtualContainer` が chest 画面を使うか（ラベル） | RP として有効化（単独） | [README](chest-resource-pack/README.md) |
| `data-driven-resource-pack/` | `data_driven_container` 画面を使うか（ラベル） | RP として有効化（単独） | [README](data-driven-resource-pack/README.md) |
| `button-send-resource-pack/` | `button.send` が通知を発火するか（陽性対照付き） | RP として有効化（単独、`probe/` とペア） | [README](button-send-resource-pack/README.md) |
| `edit-box-resource-pack/` | `edit_box` + `button.send` で手入力が送信できるか | RP として有効化（単独。チャット入力を奪い得る） | [README](edit-box-resource-pack/README.md) |
| `protection-resource-pack/` | JSON UI の重ねだけでアイテム操作を止められるか | RP として有効化（単独。通常チェストにも作用し得る） | [README](protection-resource-pack/README.md) |

各プローブの警告・判定条件は各 README に従う。導入手順の詳細と試験的接続の扱いは [resource_pack/README.md](../../resource_pack/README.md) と [connect-data-driven](../../resource_pack/experimental/connect-data-driven/README.md) を参照。過去の調査経緯は [API-NOTES.md](API-NOTES.md) にある。

## 即時中止する条件

- 通常チェスト（InvUI 以外）で移動が壊れた、UI が崩れた。
- 表示専用アイテムが持ち出せた、または増減した。
- アイテムの複製・消失を確認した。
- `WindowItemChangeDangerError` が通知されない、または通知後も操作できた。
- 画面終了後・ページ変更後に古い通知がクリックとして実行された。
- 通知方式が通常チャットを壊した、または通知がプレイヤーに表示された。
- クラッシュした、ワールドが破損した。

## 判定と記録

- [CHECKLIST.md](CHECKLIST.md) をコピーして記入する。各項目は **合格 / 不合格 / 未実施 / N/A**（N/A は理由必須）。
- 入力方式ごとに結果を分ける。PC の合格をタッチ・コントローラーの合格にしない。
- `BASE-*` / `PROT-*` / `INV-*` が 1 つでも不合格なら、そのビルドは配布しない。
- 全項目合格でも、その版・環境での結果にすぎない。ゲーム版や `@minecraft/server` 版が変わったら再試験する。
- `InventoryLink` は安全試験を満たすまで無効のままにする。

## 自動テスト（実機テストの代替ではない）

```bash
node --test tests/manual-bedrock/cli.test.mjs
node tests/manual-bedrock/button-send-resource-pack/check.mjs
node tests/manual-bedrock/edit-box-resource-pack/check.mjs
node tests/manual-bedrock/protection-resource-pack/check.mjs
```

確認できるのは CLI の安全側の動作（既定で無変更、導入 3 ファイルのみ、競合時中断、`--json` の形式）と、各 Resource Pack の JSON 構造だけ。表示・押下・入力・アイテム保護・通常チェストへの影響は確認できない。
