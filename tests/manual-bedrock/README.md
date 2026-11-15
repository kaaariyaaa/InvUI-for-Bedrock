# Bedrock 実機テスト

> [!WARNING]
> **すべて実機未検証。使い捨てワールドで行う。** 表示専用アイテムは保護されていない（取り出し・複製・消失し得る）。価値のあるアイテムは使わない。

前の段階が不合格なら次へ進まない。結果は [CHECKLIST.md](CHECKLIST.md) に **合格 / 不合格 / 未実施 / N/A** で記入する。

## やること

1. **準備** — ワールドを複製。Preview/Beta で Experimental API を有効化。試験するスロット数（9 / 27 / 54）と入力方式（PC / タッチ / コントローラー）を決める。
2. **通常チェスト（`BASE-01`〜`03`）** — 接続パックを入れる**前と後**で、普通のチェストの移動・ボタンが壊れないか。ここが最初。
3. **表示（`DISP-01`〜`03`）** — 9 / 27 / 54 で位置・個数・見た目・最終ページ・空スロット。
4. **アイテム保護（`PROT-01`〜`04`）** — 表示専用スロットをクリック / Shift / ドラッグ / ダブルクリック / ドロップしても持ち出せないか。現行コアは無保護なので、保護入りのテストビルドでのみ実施。
5. **クリック通知（`CLICK-01`〜`11`）** — 1 クリック 1 通知、スロット特定、ページ変更後・終了後の古い通知が捨てられるか、通常チャットに出ないか、描画完了前の通知が実行されないか。
6. **`InventoryLink`（`INV-01`〜`05`）** — 最後に使い捨てアイテムだけで。複製・消失が 1 件でも出たら中止。現行コアは `moveTo()` 常時拒否なのでテストビルドでのみ実施。
7. **ライフサイクル（`LIFE-01`〜`07`）** — 死亡・ディメンション移動・切断・スペクテイター・shutdown で close が 1 回だけ走り、購読が解放され、勝手に開き直さないか。

## 入れるパック

| パック | 何を見るか | 入れ方 |
|---|---|---|
| [`locked-click-probe/`](locked-click-probe/README.md) | ロックしたアイテムのクリックで通知が来るか（観測のみ） | `install-test-packs.bat` か `.mcpack` |
| [`probe/`](probe/README.md) | `VirtualContainer` 単体の表示・close・itemChange | BP を配置（コア不要） |
| [`chest-resource-pack/`](chest-resource-pack/README.md) | VirtualContainer がチェスト画面を使うか | RP を単独で有効化 |
| [`data-driven-resource-pack/`](data-driven-resource-pack/README.md) | `data_driven_container` 画面を使うか | RP を単独で有効化 |
| [`button-send-resource-pack/`](button-send-resource-pack/README.md) | `button.send` が通知を出すか（陽性対照） | RP を単独で有効化 + `probe/` |
| [`edit-box-resource-pack/`](edit-box-resource-pack/README.md) | 手入力で通知を送れるか（チャットを奪い得る） | RP を単独で有効化 |
| [`protection-resource-pack/`](protection-resource-pack/README.md) | UI の重ねだけで操作を止められるか（通常チェストにも作用し得る） | RP を単独で有効化 |

各パックの警告と判定条件は、その README に従う。

## 中止する条件

- 通常チェストの移動・UI が壊れた
- 表示専用アイテムを持ち出せた、増減した
- アイテムの複製・消失が出た
- 古い通知がクリックとして実行された
- 通知が通常チャットを壊した / プレイヤーに見えた
- クラッシュした

## 注意

- 入力方式ごとに結果を分ける（PC の合格をタッチの合格にしない）。
- 全項目合格でも、その版・環境での結果にすぎない。版が変われば再試験。
- `InventoryLink` は安全試験を通るまで無効のまま。
- 調査経緯・設計根拠は [API-NOTES.md](API-NOTES.md)、[CLICK-NOTIFICATION-NOTES.md](CLICK-NOTIFICATION-NOTES.md)、[CURSOR-INPUT-NOTES.md](CURSOR-INPUT-NOTES.md)。
