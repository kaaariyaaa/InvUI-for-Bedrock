# ロック済みアイテムのクリック観測プローブ（使い捨てワールド専用）

> [!WARNING]
> **実機未検証。使い捨てワールド専用（バックアップ必須）。** 観測のみで、復元は一切行いません。持ち出したアイテムがロック状態のままインベントリに残る可能性があります。持ち出せてしまったら即中止し、ワールドを破棄してください。

## 準備

1. `locked-click-probe.mcpack` を Minecraft Preview で開いて取り込み、使い捨てワールドで有効化する。`../install-test-packs.sh` でグローバルパックへ配置し、ワールド設定で有効化してもよい（実機未検証）。
2. ワールド設定で Beta APIs / Experimental API を有効化する。`manifest.json` の `min_engine_version` は仮置きの `[1, 26, 70]` なので、ゲーム版に合わせる。
3. 通常のチェストでアイテム移動が従来どおり動くこと、`!lockprobe help` がチャットに返ることを確認する（返らなければパックが読み込まれていない）。
4. 画面を開く前に、カーソルにアイテムを持たない。サーバー側 auto close でカーソル上のアイテムが失われ得る（未検証）。

## 実行コマンド

| コマンド | 動作 |
|---|---|
| `!lockprobe help` | コマンド一覧 |
| `!lockprobe open [size] [mode] [ticks]` | コンテナを作成・fill して `open()`。`size` は 1〜54（既定 9）、`mode` は `slot` / `inventory` / `plain`（既定 `slot`）、`ticks` は自動 close までの tick（既定 1200、20〜2400） |
| `!lockprobe close` | 実行者が最後に開いたコンテナを、実行者本人の画面で閉じる |
| `!lockprobe stop` | 全コンテナの全閲覧者に close を要求し、以降の open を拒否 |
| `!lockprobe dump` | コンテナの size・viewers・スロット内容をログ |

画面表示中はチャットを開けないため、通常は `ticks` の自動 close で終わる。`close` / `stop` は画面を閉じた後、または別プレイヤーから実行する。次の `open` の前に `CLOSE` を確認し、`OPEN_REJECTED ... previous open still pending` が返ったら少し待って再実行する。

## 確認項目（合否）

**通常クリック（PC: 左クリック / タッチ: タップ / コントローラー: 決定）1 回ごとに:**

- **陽性（経路候補）**: `title="Lock probe <size> <mode>"` 付きの `kind=SAME_ITEM_CANDIDATE` が 1 回だけ出て、スロットの内容と個数が変わらない。PC / タッチ / コントローラーで同じ。`CLOSE_CONTENTS` の `totals` が `FILLED` 直後の期待値（9 なら stick×5 / paper×4）と一致する。`before` と `after` の `lock=` が違う場合はロックが外れた証拠なので候補にしない。
- **陰性**: 通常クリックで `ITEM_CHANGE` がまったく出ない、または `REMOVED` / `CHANGED` / `INSERTED` になる。
- **判定不能**: 画面が表示されない / `open` が失敗する / 購読が `SUBSCRIBE_UNAVAILABLE` になる / `FILLED` の `locked=` が `slots=` より少ない / `FILL_LOCK_MISMATCH` が出る。

同一判定は `typeId` / `amount` / `nameTag` の一致で行い、`lockMode` は意図的に除外する（ロックが外れてもイベントを見落とさないため）。

陽性でも、設計7.2 により `ItemLockMode.slot` を表示スロットの読み取り専用化に使ってはいけません。通常クリックと Shift クリック・ドロップ・配置を itemChange の前後だけで区別できない場合も、この経路は採用しない。陽性なら同じスロットで Shift クリック・ドロップ・ドラッグ・配置も試し、`ITEM_CHANGE` の有無と種類を記録する。

## 記録するログ行

観測行は Content Log にだけ出る（チャットに返るのは `OPEN_REQUESTED` などのコマンド応答のみ）。設定の Creator セクションで「コンテンツログ GUI」を有効にするか、BDS / 開発環境のコンソールを使う。1 回の `open` につき `[invui-lockprobe]` 行を `FILLED` から `CLOSE_CONTENTS` まで切れ目なく保存する。

```text
FILLED size=9 mode=slot slots=9/9 locked=9/9
ITEM_CHANGE size=9 slot=0 title="Lock probe 9 slot" kind=SAME_ITEM_CANDIDATE sameItem=true
CANDIDATE_SAME_ITEM size=9 slot=0 title="Lock probe 9 slot"
CLOSE size=9 title="Lock probe 9 slot" reason=ServerClosed
CLOSE_CONTENTS size=9 title="Lock probe 9 slot" nonEmptySlots=9/9 totals=minecraft:stickx5, minecraft:paperx4
```

- `FILL_LOCK_MISMATCH` / `FILL_FAILED` / `CLOSE ... items=missing` もそのまま残す。
- `title=` は同じ size の mode 違いを区別するために、`ITEM_CHANGE` と `CLOSE_CONTENTS` を必ず対で記録する。

## 限界と詳細

- `event.container` の同一性は断定せず、作成時に固定される `title` の一致で自分のコンテナを引く。title 識別は観測上の近道で、同名他パックとの衝突は区別できない。
- close の重複・遅延配送は API が保証しない。このプローブは二重 close を区別しない。これらは観測結果であり、挙動の保証ではありません。
- 陽性/陰性の解釈は記録したゲーム版と環境でしか通用しない。このプローブは InvUI コアの `Window` を使わない。
- 詳細な経緯・候補の比較は [CLICK-NOTIFICATION-NOTES.md](../CLICK-NOTIFICATION-NOTES.md)、記録ヘッダーは [CHECKLIST.md](../CHECKLIST.md) を参照。
