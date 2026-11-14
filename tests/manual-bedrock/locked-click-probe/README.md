# 設計10: ロック済みアイテムのクリック観測プローブ（使い捨てワールド専用）

> [!WARNING]
> **使い捨てワールド専用。実機未検証。観測のみで、クリック機能は実装していません。**
>
> - このプローブは、`ItemLockMode.slot` のアイテムを `VirtualContainer` のスロットに置き、**通常クリックで `VirtualContainerItemChangeAfterEvent` が発生するか**だけを記録します。
> - **復元（`setItem` / `clear()`）を一切行いません。** itemChange は after イベントであり、復元によるクリック判定は複製・消失の危険があるため、このプローブの対象外です（設計10の禁止案）。
> - **JSON UI / Resource Pack / チャット通知を含みません。** 入力抑制・アイテム保護・クリック実行もありません。
> - **アイテムは `minecraft:stick` と `minecraft:paper` だけ**を使います。価値のあるアイテムを持ち込まないでください。
> - `VirtualContainer` の中身は保存されません。再読み込み・ワールド終了で消えます。
> - 異常（通常チェストの操作が壊れた、アイテムが増減した、画面が閉じない等）が出たら**即時中止**し、ワールドを破棄またはバックアップから復元してください。

## 1. 何を確かめるか

設計10の自動クリック通知には、次の条件を同時に満たす経路が必要です。

- 自動（プレイヤーがチャット文字列を手入力しない）
- 非破壊（表示アイテムを動かさない・消費しない）
- スロットを区別できる
- PC / タッチ / コントローラーの通常クリックで成立する

このプローブが確かめる仮説は 1 つです。

> **`ItemLockMode.slot` を設定したアイテムを画面から通常クリックすると、アイテムが動かなくても `VirtualContainerItemChangeAfterEvent` が届き、`beforeItemStack` と `itemStack` が同じ内容になる。**

これが成立すれば、イベントの `player` / `container` / `slot` をそのまま使い、**復元もチャットも JSON UI も不要**なクリック源になります。成立しなければ、ロックはクリック源に使えない、という負の結果になります。

> [!IMPORTANT]
> 陽性でも、`ItemLockMode.slot` を**表示スロットの読み取り専用化に使ってはいけません**（設計7.2）。このプローブは「ロックしたアイテムのクリックが itemChange として届くか」だけを見る観測であり、ロックを操作抑制の安全機構として採用する根拠にはしません。陽性の場合も、表示スロットの操作抑制は JSON UI 側か、`inventory` と `display` を分ける既存方針で行います。

## 2. 含まれるもの / 含まれないもの

含まれるもの:

- `behavior_pack/manifest.json`: 新規 UUID、`@minecraft/server` `2.13.0-beta`、警告入り description
- `behavior_pack/scripts/main.js`: コンテナ作成、ロック済みアイテムの配置、観測イベントのログ、自動 close
- `locked-click-probe.test.mjs`: manifest / 構文 / 危険警告 / モック上の fill・ロック・分類の静的確認

含まれないもの:

- Resource Pack / JSON UI / `button.send` / `button.drop_one` / 透明ボタン
- クリックの実行（`handleClick` 相当）、アイテム復元、カーソル操作
- アイテム保護、`InventoryLink`、InvUI コア
- 実機の動作保証

## 3. 前提

| 項目 | 要件 |
|---|---|
| ゲーム | `@minecraft/server` `2.13.0-beta.1.26.70-preview.24` に対応する Minecraft Preview/Beta |
| 設定 | ワールドで Beta APIs / Experimental API を有効化 |
| ワールド | 使い捨て。バックアップ済み |
| アイテム | プローブが置く stick / paper のみ |
| InvUI コア | 不要。`world.virtualContainerManager` を直接使う |

`manifest.json` の `min_engine_version` は `[1, 26, 70]` の仮置きです。実際のゲーム版に合わせてください。

## 4. 配置

`behavior_pack/` を `development_behavior_packs/invui_locked_click_probe/` などへコピーし、使い捨てワールドで有効化します。専用サーバーの場合は `behavior_packs/` へ置き、`world_behavior_packs.json` に manifest の header UUID と version を追加します。

## 5. コマンド

| コマンド | 動作 |
|---|---|
| `!lockprobe help` | コマンド一覧 |
| `!lockprobe open [size] [mode] [ticks]` | コンテナを作成・fill して `open()`。`size` は 1〜54（既定 9）、`mode` は `slot` / `inventory` / `plain`（既定 `slot`）、`ticks` は自動 close までの tick（既定 1200、20〜2400）。既存コンテナを再利用する場合は開く直前に fill し直す |
| `!lockprobe close` | 実行者が最後に開いたコンテナの、実行者本人の画面に `close(player)` を要求 |
| `!lockprobe stop` | 全コンテナの全閲覧者に close を要求し、以降の open を拒否 |
| `!lockprobe dump` | コンテナの size・viewers・スロット内容をログ |

画面表示中はチャットを開けないため、通常は `ticks` の自動 close で終了します。`close` / `stop` は画面を閉じた後、または別プレイヤーから実行してください。

## 6. 手順

1. 通常のチェストでアイテム移動が従来どおり動くことを確認する。
2. `!lockprobe open 9 slot 1200` を実行する。
3. 画面が表示されたら、**スロットを通常クリック（PC: 左クリック / タッチ: タップ / コントローラー: 決定）**する。Shift クリック・ドロップ・ドラッグは別操作として記録する。
4. 自動 close 後にコンソール / チャットのログを確認する。
5. `slot` / `inventory` / `plain` の 3 モード、9 / 27 / 54 スロット、PC / タッチ / コントローラーで繰り返す。
6. 画面を開いたまま死亡・切断・次元移動も行い、ログが壊れないことを確認する（任意）。

**画面を開く前に、カーソルにアイテムを持たないでください。** サーバー側 auto close でカーソル上のアイテムが失われ得ます（未検証）。このプローブはカーソル退避を行いません。

## 7. ログの読み方

| ログ | 意味 |
|---|---|
| `FILLED size=9 mode=slot slots=9/9` | 9 スロットすべてにロック済みアイテムを置けた |
| `FILL_FAILED slot=...` | ロック済みアイテムの `setItem` に失敗した（この時点で仮説は否定寄り） |
| `OPEN_REQUESTED ...` | `open()` を要求した。表示成功の保証ではない |
| `ITEM_CHANGE ... kind=SAME_ITEM_CANDIDATE sameItem=true ...` | **通常クリックでロック済みアイテムが動かず、同じ内容の itemChange が届いた**。クリック源の候補 |
| `CANDIDATE_SAME_ITEM ...` | 上記の候補を明示した行。クリック実行はしていない |
| `ITEM_CHANGE ... kind=REMOVED` | アイテムがスロットから出た。ロックが効いていない、またはドロップ等 |
| `ITEM_CHANGE ... kind=CHANGED` / `INSERTED` | アイテムが入れ替わった／置かれた。通常クリック以外の操作か、ロックが効いていない |
| `CURSOR_GRAB` / `CURSOR_RELEASE` | カーソル移動。タッチでは発生しない想定（未検証） |
| `HOTBAR_SELECT` | ホットバー選択の変化。クリック以外の入力でも発生する |
| `INPUT_MODE` / `BUTTON_INPUT` | 生の入力デバイスとボタン状態。クリック以外でも大量に出る |
| `INVENTORY_CHANGE` | プレイヤーのインベントリ変化。クリックでアイテムが動いた場合の傍証 |
| `MESSAGE_RECEIVE` | 内部 API。現状は機能しない想定で、記録のみ（設計10の経路にはしない） |
| `CLOSE ... reason=...` | 画面が閉じた理由。`ServerClosed` は自動 close |
| `AUTOCLOSE skip stale` | 同じキーを開き直したため、古いタイマーが新しい画面を閉じなかった |

### 判定

- **陽性（経路候補）**: 通常クリックごとに `kind=SAME_ITEM_CANDIDATE` が 1 回だけ出て、スロットの内容と個数が変わらない。PC / タッチ / コントローラーで同じ。`SAME_ITEM_CANDIDATE` は `typeId` / `amount` / `nameTag` の一致で判定するので、`before` と `after` の `lock=` が異なる場合はロックが外れた証拠であり、候補として採用しない。
- **陰性（ロックはクリック源に使えない）**: 通常クリックで `ITEM_CHANGE` がまったく出ない。または `REMOVED` / `CHANGED` になる。
- **判定不能**: 画面が表示されない、`open` が失敗する、イベント購読が `SUBSCRIBE_UNAVAILABLE` になる。ゲーム版・Beta API・パック適用を確認して再試行する。

陽性でも、**通常クリックと Shift クリック・ドロップ・配置を itemChange の前後だけで完全に区別できるとは限りません。** ロックが全操作を拒否したように見えても、それを read-only 制御の根拠にしないでください（設計7.2）。区別できない操作が残るなら、この経路は採用しません。陽性の場合は、同じスロットで Shift クリック・ドロップ・ドラッグ・アイテム配置を試し、`ITEM_CHANGE` の有無と種類を記録してください。

## 8. 結果の記録

[CHECKLIST.md](../CHECKLIST.md) の記録ヘッダーに加え、次を残します。

| 項目 | 記録 |
|---|---|
| ゲーム版 / `@minecraft/server` 版 | |
| モード（slot / inventory / plain） | |
| スロット数（9 / 27 / 54） | |
| 入力方式（PC / タッチ / コントローラー） | |
| 通常クリック 1 回あたりの `ITEM_CHANGE` 回数 | |
| `kind` と `sameItem` | |
| クリック前後のスロット内容・個数 | |
| Shift クリック / ドロップ / ドラッグ / 配置の結果 | |
| カーソル・ホットバー・インベントリのログ | |
| 異常（増減・画面が閉じない・クラッシュ） | |

## 9. このプローブの限界

- 実機のイベント順序・ロックの挙動は公式ドキュメントに保証がありません。**陽性/陰性は記録した版と環境でしか通用しません。**
- `ItemLockMode.slot` は「そのスロットから動かせない」と説明されていますが、**クリックイベントが発生するとは説明されていません**。このプローブはその未文書の挙動を確かめるためのものです。
- `VirtualContainerItemChangeAfterEvent` は after イベントです。このプローブは変更を止めず、復元もしません。
- ロックが効かない場合、表示アイテムは通常どおり持ち出せます。**保護の検証ではありません。**
- このプローブは InvUI コアの `Window` を使いません。結果をコアのクリック機能の合格根拠にしないでください。
- 設計7.2 により、`ItemLockMode.slot` は VirtualContainer のスロットを読み取り専用にする手段として使えません。陽性でも、このプローブの結果を表示スロット保護の根拠にしないでください。

## 10. 陽性だった場合の次の実装候補（まだ実装しない）

以下は陽性時の**調査候補**であり、設計7.2（ロックを read-only 制御に使わない）を変更するものではありません。

1. `Window` の `button` / `display` スロットのクリック源として**観測結果だけ**を使う。`ItemLockMode.slot` を表示スロットの読み取り専用化には使わない（設計7.2）。
2. `virtualContainerItemChange` で `beforeItemStack` と `itemStack` が同じ内容のときだけ、`slot` をクリックとして `handleClick` に渡す pure resolver を作る。
3. ロックが効かない操作（Shift / ドロップ / 配置）の itemChange は従来どおり danger として close する。
4. PC / タッチ / コントローラーで、通常クリック 1 回 = 通知 1 回、アイテム増減 0 を確認する。
5. それでも「通常クリック」と「ロックを無視した操作」を区別できない場合は、この経路を採用しない。

陰性だった場合は、この経路を実装せず、[CLICK-NOTIFICATION-NOTES.md](../CLICK-NOTIFICATION-NOTES.md) の実機テスト（`button.send` / ホットバー選択 / カーソル）へ進みます。
