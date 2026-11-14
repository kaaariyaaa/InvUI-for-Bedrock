# 設計10: ロック済みアイテムのクリック観測プローブ（使い捨てワールド専用）

> [!WARNING]
> **使い捨てワールド専用。実機未検証。観測のみで、クリック機能は実装していません。**
>
> - このプローブは、`ItemLockMode.slot` のアイテムを `VirtualContainer` のスロットに置き、**通常クリックで `VirtualContainerItemChangeAfterEvent` が発生するか**だけを記録します。
> - **復元（itemChange 後の `setItem` / `clear()`）を一切行いません。** 画面を開く前の初期配置にだけ `setItem` を使います。itemChange は after イベントであり、復元によるクリック判定は複製・消失の危険があるため、このプローブの対象外です（設計10の禁止案）。
> - **JSON UI / Resource Pack / チャット通知を含みません。** 入力抑制・アイテム保護・クリック実行もありません。
> - **アイテムは `minecraft:stick` と `minecraft:paper` だけ**を使います。価値のあるアイテムを持ち込まないでください。
> - **持ち出したアイテムがロック状態のままプレイヤーのインベントリに残る可能性があります（未検証）。** 特に `inventory` モードは、ロックが効かない場合に持ち出したアイテムが移動・破棄できなくなり得ます。`/clear` やワールド破棄でしか戻せない前提で、使い捨てワールドだけで行ってください。
> - `VirtualContainer` の中身は保存されません。再読み込み・ワールド終了で消えます。
> - **`.mcpack` のインポートは実機未検証です。** ファイルが正しい ZIP であることは自動テストで確認していますが、各プラットフォームの Minecraft Preview が取り込めるかは確認していません。取り込めない場合は下記 4.2 のフォルダ配置を使ってください。
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
- `behavior_pack/scripts/main.js`: コンテナ作成、ロック済みアイテムの配置とロック適用の読み戻し、観測イベントのログ、close 時点の内容合計、自動 close
- `locked-click-probe.mcpack`: `behavior_pack/` の `manifest.json` と `scripts/main.js` をそのまま ZIP にした導入用ファイル（実機取り込みは未検証）
- `locked-click-probe.test.mjs`: manifest / 構文 / 危険警告 / モック上の fill・ロックの読み戻し・分類・close 内容の記録の静的確認、`.mcpack` とソースの一致

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

### 4.1 `.mcpack` をインポートする（実機向け）

`locked-click-probe.mcpack` を Minecraft Preview で開いて取り込み、使い捨てワールドの設定で有効化し、Beta APIs / Experimental API を有効にします。Windows はファイルをダブルクリックするか「プログラムから開く」で Minecraft Preview を選びます。タブレット / スマホはファイルマネージャーや共有シートから Minecraft Preview で開きます。

- 取り込み先・パック一覧での表示名・有効化可否は**実機未検証**です。ワールド設定にパックが出ない、またはスクリプトが動かない場合は 4.2 のフォルダ配置を使ってください。
- `.mcpack` は `behavior_pack/manifest.json` と `behavior_pack/scripts/main.js` をそのまま ZIP にしたものです。内容の一致は `locked-click-probe.test.mjs` が確認します。`main.js` や `manifest.json` を変えたら次で再生成してください（テストは不一致で失敗します）。
  ```bash
  (cd tests/manual-bedrock/locked-click-probe/behavior_pack && \
    zip -X ../locked-click-probe.mcpack manifest.json scripts/main.js)
  ```

### 4.2 フォルダとして配置する（開発・専用サーバー向け）

`behavior_pack/` を `development_behavior_packs/invui_locked_click_probe/` などへコピーし、使い捨てワールドで有効化します。

Windows の Preview では、1.21.120 以降の GDK 版の保存先が安定版と分かれています。Preview の development pack は

```text
%APPDATA%\Minecraft Bedrock Preview\users\shared\games\com.mojang\development_behavior_packs\
```

に置きます（安定版は `Minecraft Bedrock Preview` ではなく `Minecraft Bedrock`）。古い UWP 版では `%LOCALAPPDATA%\Packages\<Preview のパッケージ>\LocalState\games\com.mojang\development_behavior_packs\` になります。どちらの構成かはゲーム版で確認してください（[GDK Migration on Windows](https://learn.microsoft.com/en-us/minecraft/creator/documents/gdkpcprojectfolder?view=minecraft-bedrock-stable)）。

専用サーバーの場合は `behavior_packs/` へ置き、ワールドの `world_behavior_packs.json` に次の項目を追加します（`pack_id` と `version` は `manifest.json` の header と一致させます）。

```json
[
  {
    "pack_id": "c980bbce-7652-4920-97a1-c5e3376a2428",
    "version": [0, 1, 0]
  }
]
```

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
2. `!lockprobe help` を実行し、チャットにコマンド一覧が返ることを確認する（返らなければパックが読み込まれていない）。
3. `!lockprobe open 9 slot 1200` を実行する。チャットに `OPEN_REQUESTED size=9 mode=slot ...` が返る。
4. 画面が表示されたら、**スロットを通常クリック（PC: 左クリック / タッチ: タップ / コントローラー: 決定）**する。Shift クリック・ドロップ・ドラッグは別操作として記録する。
5. 自動 close 後、Content Log のログを確認する。`FILLED ... locked=9/9`、`CLOSE`、`CLOSE_CONTENTS ... totals=...` が出ているか、内容がクリック前後で変わっていないかを記録する（ログの見方は下記）。
6. `CLOSE` を確認してから次の `open` を実行する。`OPEN_REJECTED ... previous open still pending` が返ったら、close イベントがまだ届いていないので少し待って再実行する。
7. `slot` / `inventory` / `plain` の 3 モード、9 / 27 / 54 スロット、PC / タッチ / コントローラーで繰り返す。
8. 画面を開いたまま死亡・切断・次元移動も行い、ログが壊れないことを確認する（任意）。

> [!TIP]
> **観測行は Content Log にだけ出ます。** チャットに返るのは `OPEN_REQUESTED` / `OPEN_REJECTED` などのコマンド応答だけです。`ITEM_CHANGE` / `CANDIDATE_SAME_ITEM` / `CLOSE_CONTENTS` を提出するには、設定の Creator（クリエイター）セクションで「コンテンツログ GUI」を有効にするか、BDS / 開発環境のコンソールを使ってください。1 回の `open` に対応する `[invui-lockprobe]` 行を、`FILLED` → `OPEN_REQUESTED` → `ITEM_CHANGE...` → `CLOSE` / `CLOSE_CONTENTS` のまとまりとして保存します。

**画面を開く前に、カーソルにアイテムを持たないでください。** サーバー側 auto close でカーソル上のアイテムが失われ得ます（未検証）。このプローブはカーソル退避を行いません。

**スロットからロック済みアイテムを持ち出せてしまったら、それ以上操作せず試験を中止してください。** 持ち出したアイテムがロック状態のままインベントリに残る可能性があり（未検証）、使い捨てワールドを破棄するのが確実です。

## 7. ログの読み方

| ログ | 意味 |
|---|---|
| `FILLED size=9 mode=slot slots=9/9 locked=9/9` | 9 スロットすべてにアイテムを置き、`getItem` で読み戻してロック適用も 9/9 確認できた。`locked` が `slots` より少ない場合は、その run の結果を判定に使わない |
| `FILL_LOCK_MISMATCH slot=... expected=... actual=...` | `setItem` 後にロックが読み戻せなかった。ロックが適用されていない可能性があるため、この run は判定不能として扱う |
| `FILLED size=9 mode=plain slots=9/9` | `plain` はロックを要求しないため `locked=` を出さない |
| `FILL_FAILED slot=...` | アイテムの `setItem` に失敗した（この時点で仮説は否定寄り） |
| `OPEN_REQUESTED ...` | `open()` を要求した。表示成功の保証ではない |
| `ITEM_CHANGE ... title="Lock probe 9 slot" kind=SAME_ITEM_CANDIDATE sameItem=true ...` | **通常クリックでロック済みアイテムが動かず、同じ内容の itemChange が届いた**。クリック源の候補。`title=` は size と mode を兼ねる |
| `CANDIDATE_SAME_ITEM ... title="Lock probe 9 slot"` | 上記の候補を明示した行。クリック実行はしていない |
| `ITEM_CHANGE ... kind=REMOVED` | アイテムがスロットから出た。ロックが効いていない、またはドロップ等 |
| `ITEM_CHANGE ... kind=CHANGED` / `INSERTED` | アイテムが入れ替わった／置かれた。通常クリック以外の操作か、ロックが効いていない |
| `CURSOR_GRAB` / `CURSOR_RELEASE` | カーソル移動。タッチでは発生しない想定（未検証） |
| `HOTBAR_SELECT` | ホットバー選択の変化。クリック以外の入力でも発生する |
| `INPUT_MODE` / `BUTTON_INPUT` | 生の入力デバイスとボタン状態。クリック以外でも大量に出る |
| `INVENTORY_CHANGE` | プレイヤーのインベントリ変化。クリックでアイテムが動いた場合の傍証 |
| `MESSAGE_RECEIVE` | 内部 API。現状は機能しない想定で、記録のみ（設計10の経路にはしない） |
| `CLOSE ... title="Lock probe 9 slot" reason=...` | 画面が閉じた理由。`ServerClosed` は自動 close。`items=array` は close 時内容を `event.items` から読めたことを示す |
| `CLOSE_CONTENTS ... nonEmptySlots=9/9 totals=minecraft:stickx5, minecraft:paperx4` | close 時点の空でないスロット数と typeId ごとの合計。クリック前後で合計が変わっていないことの記録に使う |
| `CLOSE ... unmatchedTitle="..."` | 自作した container と title が一致しない close。pending は消さない。逆に、別パックの同じ title の close はこの行が出ずに一致扱いになる（区別できない） |
| `AUTOCLOSE skip stale` | 同じキーを開き直したため、古いタイマーが新しい画面を閉じなかった |

`title=` は作成時に固定される `Lock probe <size> <mode>` です。size が同じでも mode が違う run を区別するために、`ITEM_CHANGE` と `CLOSE_CONTENTS` の `title=` を必ずセットで記録してください。`title=` が `Lock probe ...` でない行は、このプローブが作っていない container の観測なので、自分の結果として数えません（単独導入が前提です）。

### 判定

- **陽性（経路候補）**: 通常クリックごとに `title="Lock probe <size> <mode>"` 付きの `kind=SAME_ITEM_CANDIDATE` が 1 回だけ出て、スロットの内容と個数が変わらない。PC / タッチ / コントローラーで同じ。`CLOSE_CONTENTS` の `totals` が `FILLED` 直後の期待値（9 なら stick×5 / paper×4）と一致する。`SAME_ITEM_CANDIDATE` は `typeId` / `amount` / `nameTag` の一致で判定し、`lockMode` は意図的に除外している（ロックが外れてもイベントを見落とさないため）。`before` と `after` の `lock=` が異なる場合はロックが外れた証拠なので、ログが候補でもクリック源として採用しない。
- **陰性（ロックはクリック源に使えない）**: 通常クリックで `ITEM_CHANGE` がまったく出ない。または `REMOVED` / `CHANGED` / `INSERTED` になる。
- **判定不能**: 画面が表示されない、`open` が失敗する、イベント購読が `SUBSCRIBE_UNAVAILABLE` になる。`FILLED` の `locked=` が `slots=` より少ない、または `FILL_LOCK_MISMATCH` が出た run も判定不能として扱う。ゲーム版・Beta API・パック適用を確認して再試行する。

陽性でも、**通常クリックと Shift クリック・ドロップ・配置を itemChange の前後だけで完全に区別できるとは限りません。** ロックが全操作を拒否したように見えても、それを read-only 制御の根拠にしないでください（設計7.2）。区別できない操作が残るなら、この経路は採用しません。陽性の場合は、同じスロットで Shift クリック・ドロップ・ドラッグ・アイテム配置を試し、`ITEM_CHANGE` の有無と種類を記録してください。

## 8. 結果の記録

[CHECKLIST.md](../CHECKLIST.md) の記録ヘッダーに加え、次を残します。**1 回の run ごとに、`[invui-lockprobe]` のログを `FILLED` から `CLOSE_CONTENTS` まで切れ目なく保存してください。**

| 項目 | 記録 |
|---|---|
| ゲーム版 / `@minecraft/server` 版 | |
| モード（slot / inventory / plain）と、ログの `title=` | |
| スロット数（9 / 27 / 54） | |
| 入力方式（PC / タッチ / コントローラー） | |
| `FILLED ... slots=` と `locked=`（ロック適用の読み戻し） | |
| 通常クリック 1 回あたりの `ITEM_CHANGE` 回数 | |
| `kind` と `sameItem` | |
| クリック前後のスロット内容・個数（`CLOSE_CONTENTS` の `nonEmptySlots` / `totals`） | |
| Shift クリック / ドロップ / ドラッグ / 配置の結果 | |
| カーソル・ホットバー・インベントリのログ | |
| 異常（増減・画面が閉じない・クラッシュ） | |

## 9. このプローブの限界

- 実機のイベント順序・ロックの挙動は公式ドキュメントに保証がありません。**陽性/陰性は記録した版と環境でしか通用しません。**
- `ItemLockMode.slot` は「そのスロットから動かせない」と説明されていますが、**クリックイベントが発生するとは説明されていません**。このプローブはその未文書の挙動を確かめるためのものです。
- `VirtualContainerItemChangeAfterEvent` は after イベントです。このプローブは変更を止めず、復元もしません。
- `CLOSE_CONTENTS` は close 時点の `event.items` を合計した**記録だけ**で、会計・STOP 判定・復元は行いません。`event.items` が配列でない版では `CLOSE ... items=missing` になり、内容をログから確認できません。
- `title=` は mode の識別に使う観測上の近道で、保証ではありません（別パックが同じ title を作れば区別できません）。
- ロックが効かない場合、表示アイテムは通常どおり持ち出せます。**保護の検証ではありません。** 持ち出したアイテムがロック状態のままプレイヤーのインベントリに残る可能性があり（未検証）、その場合は移動・破棄できなくなり得ます。
- このプローブは InvUI コアの `Window` を使いません。結果をコアのクリック機能の合格根拠にしないでください。
- 設計7.2 により、`ItemLockMode.slot` は VirtualContainer のスロットを読み取り専用にする手段として使えません。陽性でも、このプローブの結果を表示スロット保護の根拠にしないでください。
- `VirtualContainer` に id はなく、Beta API は `event.container` が `create()` の戻り値と同一のオブジェクトであることを保証しません。**`event.container` の同一性は断定せず**、このプローブは参照（`===` / WeakMap）で自分の container を引かず、作成時に固定される `title` の一致で引きます。
- **title 識別は観測上の近道であり、保証ではありません。** 別のパックが同じ `title` の container を作った場合、このプローブは区別できず、その close を自分のものとして扱って pending を消す可能性があります（同名他パックとの衝突）。`title` を一意な ID として扱わないでください。
- **close の重複配送・遅延配送は API が保証しません。** このプローブは一致した close イベント 1 回につき pending を 1 回消すだけで、二重 close と古い close を区別しません。二重 close が来ないことも保証されません。これらは観測結果の記録であり、挙動の保証ではありません。

## 10. 陽性だった場合の次の実装候補（まだ実装しない）

以下は陽性時の**調査候補**であり、設計7.2（ロックを read-only 制御に使わない）を変更するものではありません。

1. `Window` の `button` / `display` スロットのクリック源として**観測結果だけ**を使う。`ItemLockMode.slot` を表示スロットの読み取り専用化には使わない（設計7.2）。
2. `virtualContainerItemChange` で `beforeItemStack` と `itemStack` が同じ内容のときだけ、`slot` をクリックとして `handleClick` に渡す pure resolver を作る。
3. ロックが効かない操作（Shift / ドロップ / 配置）の itemChange は従来どおり danger として close する。
4. PC / タッチ / コントローラーで、通常クリック 1 回 = 通知 1 回、アイテム増減 0 を確認する。
5. それでも「通常クリック」と「ロックを無視した操作」を区別できない場合は、この経路を採用しない。

陰性だった場合は、この経路を実装せず、[CLICK-NOTIFICATION-NOTES.md](../CLICK-NOTIFICATION-NOTES.md) の実機テスト（`button.send` / ホットバー選択 / カーソル）へ進みます。
