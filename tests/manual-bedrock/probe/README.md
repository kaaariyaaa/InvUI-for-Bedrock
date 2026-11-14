# フェーズ0 最小プローブ（VirtualContainer 公式 beta API）

`tests/manual-bedrock/probe/` は、設計書フェーズ0の技術検証のうち、次の 3 点を**使い捨てワールドで手動確認**するための最小 Behavior Pack です。

1. `VirtualContainer` の基本表示（`create` / `open` / `close` / `getViewers`）
2. `virtualContainerClose` の `reason`
3. `virtualContainerItemChange`（画面からの操作でのみ発生するか）

加えて、`button.send` → チャット通知の**受信の観測だけ**を行います（`!invui:` prefix をキャンセルしてログに残す。クリック処理は一切しない）。

> [!WARNING]
> **使い捨てワールド専用。実行前にワールドとパックをバックアップする。**
>
> - 本番ワールド、配布用ワールド、通常プレイヤーが入るサーバーでは実行しない。試験後はワールドごと破棄してよい状態にする。
> - **JSON UI と InputBridge は未検証であり、このパックには含まれていない。** クリック入力や表示操作の抑制は検証できない。
> - **表示アイテムの保護はない。** `setItem()` で置いたアイテムは画面から取り出せる。このプローブが使うのは `minecraft:stick` と `minecraft:paper` だけであり、**ダイヤ等価値のあるアイテムは使わない**。それでも複製・消失が疑われたら即時中止する。
> - **画面を開いたままの `fill` は拒否する。** クライアント表示とサーバー側スロット状態がずれ、その後の移動でアイテムが複製し得るため。閲覧者がいる間は書き込まない。加えて、`open()` を要求した直後でまだ `getViewers()` に反映されていない間（pending）も **fail-closed で拒否する**。`fill` ができるのは画面を閉じて close イベントが届き、pending が解除された後だけ。全員が画面を閉じてから `fill` する。
> - **pending は close イベントでしか解除されない（実際の制限）。** `UserBusy` や未表示などで close イベントが来ない場合、その size の `open` と `fill` は再読み込みまで拒否され続ける。これは「誤って書き込むより安全側」に倒した結果であり、解除するにはスクリプト再読み込みが必要。`getViewers()` も表示成功を保証しないため、画面が実際に表示されたかは目視でしか判定できない。
> - **同一 size の共有コンテナを複数画面で同時に開かない。** 表示同期がずれて複製を作り得るため、`open` は既存の閲覧者（`getViewers()`）、表示未確認の `open`（pending）、`getViewers()` の失敗を拒否する。pending は close イベントまで解除されない。`UserBusy` 等で close イベントが来ない場合は再読み込みで解除する。
> - **サーバー側 close の前に cursor 退避を行う。** `AUTOCLOSE` や `!invui stop` は表示中の画面をサーバー側から閉じるため、カーソルに持っているアイテムは失われ得る（未検証）。プローブはカーソル上のアイテムを検出できず、退避も自動化しない。閉じる前にカーソル上のアイテムをスロットへ戻す。`AUTOCLOSE` の `ticks` は退避の時間を確保できる長さにする（短すぎると退避前に close する）。
> - **`STOP` はインベントリ側の複製を検知できない。** 会計が見るのはコンテナ内の `typeId` と `amount` の合計だけであり、プレイヤーインベントリ側で増えた複製・増加は検出しない。必ずインベントリの合計個数を目視で突き合わせる。
> - **画面からの操作 (itemChange) は危険ログを出す。** 投入物は画面外へ出る・消えることがあり、複製も未検証。`!invui dump` の `ACCOUNTING` と合計個数を必ず突き合わせる。会計不一致を検知したら自動で STOP し、以降の `open` / `fill` を拒否する。
> - **VirtualContainer の中身は保存されない。** 再読み込み、ワールド終了、パックの無効化で消える。**貴重品や実際に使うアイテムを預けない**。中身は使い捨ての stick/paper だけにする。
> - このパックは Resource Pack を含まないため、このままでは通常チェストの UI を変更しない。ただし手動で JSON UI を併用すると**通常チェストにも影響し得る**。併用する場合は JSON UI 導入前後で通常チェストの移動を確認する。
> - `open()` が例外を投げなくても、画面が表示されたことを意味しない（端末が `UserBusy` で閉じることがある）。
> - ベータ API と特定のプレビュー版に依存する。版が変わったら結果を流用しない。

## 1. 含まれるもの / 含まれないもの

含まれるもの:

- `behavior_pack/manifest.json`
  - 新規 UUID、依存 `@minecraft/server` **`2.13.0-beta`**、警告入り description
- `behavior_pack/scripts/main.js`
  - チャットコマンドでコンテナ作成・表示・close・アイテム書き込み・ダンプ・停止を行う
  - 閲覧者がいるコンテナへの `fill` を拒否する。さらに pending（`open` 後 close イベント前）でも拒否し、`fill` は close 後のみ可能
  - 同一 size の共有コンテナへ複数画面を開かないよう、既存閲覧者・表示未確認の open・`getViewers()` 失敗時の `open` を拒否する
  - close / itemChange をコンソールとチャットに記録する（itemChange は `DANGER` ログ + 警告）
  - close 時に `CLOSE_CONTENTS`（全スロット内容と種別ごとの合計）を出す
  - fill と itemChange から会計を維持し、close / dump で実スロットと突き合わせる。不一致は STOP
  - `!invui:` で始まるチャットを `beforeEvents.chatSend` でキャンセルし、`NOTIFY_OBSERVED` をコンソールに記録する（受信の観測のみ。click は実行しない）
- `probe.test.mjs`
  - JSON と JS 構文の静的チェック、tick 予約が close を呼ぶこと、および fill 拒否・危険ログ・会計 STOP のモック確認（ゲーム動作は検証しない）

含まれないもの:

- Resource Pack / JSON UI（`ui/chest_screen.json` など）
- InputBridge、透明ボタン、クリックの**処理**（`!invui:` 通知の受信観測は含むが、その内容に応じた操作は一切行わない）
- アイテム保護、`InventoryLink`、InvUI コアの読み込み
- 自動テストによる実機動作の保証

## 2. 前提

| 項目 | 要件 |
|---|---|
| ゲーム | `@minecraft/server` `2.13.0-beta.1.26.70-preview.24` に対応する Minecraft Preview/Beta |
| 設定 | ワールドで Beta APIs / Experimental API を有効化 |
| manifest dependency | `2.13.0-beta`（このプローブの固定値） |
| ワールド | 使い捨て。バックアップ済み |
| アイテム | プローブが置く stick / paper のみ。価値のあるアイテムを持ち込まない |

`manifest.json` の `min_engine_version` は `[1, 26, 70]` の仮置きです。実際のゲーム版に合わせて変更してください。モジュール版とゲーム版の対応は [API-NOTES.md](../API-NOTES.md) の未検証点 1 として記録します。

## 3. サーバーでの実行例

### 3.1 Dedicated Server (BDS) に配置する

> 安定版の BDS では `VirtualContainer` が存在せず、このプローブは動作しません。`VirtualContainer` が追加された Preview/Beta 26.70.24 以降に対応する BDS と、Beta APIs を有効にしたワールドが必要です。`2.13.0-beta` のモジュールがあるだけでは十分ではありません。

```text
<BDS>/
  behavior_packs/
    invui_phase0_probe/
      manifest.json
      scripts/
        main.js
  worlds/
    <world>/
      world_behavior_packs.json
```

`world_behavior_packs.json` の例（UUID は `behavior_pack/manifest.json` の header と一致させる）:

```json
[
  {
    "pack_id": "dceab83f-68ca-48fe-9d55-b9c187d53b9c",
    "version": [0, 1, 0]
  }
]
```

手順:

1. テスト用ワールドをクライアントで作成し、Beta APIs / Experimental API を有効にする（BDS 側だけでは実験設定を後から変えにくいため、設定済みワールドを用意する）。
2. BDS を停止した状態で上記の Behavior Pack と `world_behavior_packs.json` を配置する。
3. BDS を起動し、プレイヤーで参加する。サーバーコンソールに `[invui-probe] 読み込み完了...` が出ることを確認する。
4. ゲーム内チャットで `!invui help` を実行する。
5. 終了後は BDS を停止し、パックと `world_behavior_packs.json` の追加分を元に戻す。ワールドはバックアップから破棄または復元する。

### 3.2 クライアントのテストワールドに配置する

`behavior_pack/` を `development_behavior_packs/` または `behavior_packs/` にコピーし、テストワールドの設定で有効化します。以降の操作は同じです。

### 3.3 チャットコマンド

| コマンド | 動作 | 主な用途 |
|---|---|---|
| `!invui help` | コマンド一覧 | 読み込み確認 |
| `!invui open [size] [ticks]` | コンテナを作成し `open()` を要求（既定 27）。`ticks` 指定時は open からその tick 数後にサーバー側で `close()`。既存閲覧者・表示未確認の open・`getViewers()` 失敗時は拒否 | 表示・close reason（画面操作なしで `ServerClosed`） |
| `!invui fill` | 直近に開いたコンテナへ stick/paper を `setItem()`。**閲覧者または pending があると拒否** | itemChange の負の確認 |
| `!invui close` | 対象プレイヤーの画面に `close()` を要求 | `ServerClosed` の確認（画面を閉じている間しか実行できない） |
| `!invui dump` | viewers・スロット内容・`ACCOUNTING`（期待値と実際）を表示 | 状態確認・会計の突き合わせ |
| `!invui stop` | 停止扱いにし、全コンテナの画面に `close()` を要求。以降の `open` / `fill` を拒否 | 中止・危険検知後の後始末 |

補足:

- `!invui fill` は対象スロットを上書きする。価値のあるアイテムを置いた状態では実行しない。
- **`!invui fill` は閲覧者がいると実行しない（拒否する）。** 画面を開いたまま `setItem()` すると、クライアントの表示とサーバー側のスロット状態がずれて複製を作り得るため。全員が画面を閉じた後に実行する。加えて、`open()` 直後で未表示の pending 中も拒否する。fill ができるのは close イベントで pending が解除された後だけであり、`open` 直後の `fill` は行わない（実行しても拒否される）。
- **`open` は同一 size の共有コンテナで他プレイヤーが画面を開いていないことを確認してから行う。** 既存の閲覧者・表示未確認の open（pending）・`getViewers()` 失敗は拒否する。pending は close イベントで解除され、`UserBusy` などで close が来ない場合は再読み込みで解除する。
- 会計不一致（`DANGER ACCOUNTING`）を検知すると自動で STOP し、以降の `open` / `fill` を拒否する。`!invui stop` は手動停止。
- **`AUTOCLOSE` / `!invui stop` で強制 close する前に、カーソルに持っているアイテムをスロットへ戻す（cursor 退避）。** 表示中の画面をサーバー側から閉じると、カーソル上のアイテムが失われ得る。
- **STOP はプレイヤーインベントリ側の複製を検知できない。** 会計はコンテナ内の `typeId` / `amount` 合計だけを見る。インベントリと合計個数を目視で突き合わせる。
- **チャットは画面表示中に入力できない**ため、`!invui close` だけで `ServerClosed` を確認できない。`!invui open 27 40` のように `ticks` を付けると、open から 40 ticks（約 2 秒）後にサーバー側から `close()` される。20 ticks ≒ 1 秒、上限 2400 ticks。これを close reason の確認に使う。
- `ticks` タイマーは予約後に画面を手で閉じても残る。その場合の `close()` は `requested=0` になり、close イベントは発生しない。
- `size` は 1〜54。設計上の確認対象は 9 / 27 / 54。
- `open()` は非同期。`close()` 直後に再 `open()` すると `PreviousScreenClosing` になることがある。close イベントを待つか、後続 tick で再試行する。
- `close()` の戻り値は「要求した画面数」であり、完了数ではない。
- `size` ごとにコンテナをキャッシュする。同じサイズの再 `open` は同じコンテナを使う。

### 3.4 チャット通知（`!invui:`）の観測

`button.send` が送る想定の `!invui:<session-id>:<slot-index>:<sequence>` 形式のチャットを、`world.beforeEvents.chatSend` で**受信の観測だけ**行います。

- 対象は `!invui:` で始まるメッセージのみ。`event.cancel = true` で通常チャットへ流さない。`!invui `（空白区切り）のコマンドや、先頭以外に prefix を含む `say !invui:...` はキャンセルしない。
- `beforeEvents` 内では世界を変更できないため、記録は `system.run` で次 tick に回し、コンソールへ `NOTIFY_OBSERVED sender=... message="..." action=NONE（観測のみ。通知は偽装可能なため click action は実行しない）` の 1 行を出す。チャットへの返信はしない。
- ログは制御文字・引用符をエスケープし、160 文字で切り詰める。改行を含む通知でもログの行構造は壊れない。
- **通知文字列はプレイヤーが手入力できるため偽装可能。** `sender` も含め、session / slot / sequence の妥当性検証はしない。このプローブは受信の有無と内容の記録だけを行い、click action / `handleClick` / スロット操作 / アイテム移動を一切実行しない（設計書 10.5 の入力安全性）。
- このパックは JSON UI を含まないため、実機で `button.send` がこの prefix を送るか（そもそもチェスト画面で成立するか）は確認できない。手入力でも同じ観測経路を通るので、ログの有無は本物のクリック経路の証明にならない。

## 4. 手動試験

各項目は **合格 / 不合格 / 未実施 / N/A** で記録する。1 つでもアイテムの複製・消失を確認したら中止する。

### 4.1 基本表示（DISP 相当）

1. 通常チェストでアイテム移動が従来どおり動くことを先に確認する。
2. `!invui open 9` → 画面の見出しが `InvUI probe 9`、9 スロットが 1 行で表示されるか。
3. `!invui dump` → `viewers` に自分が入っているか。
4. `!invui open 27`、`!invui open 54` でも同様に、行数・列数・個数・見た目を確認する。
5. 画面を閉じ、`CLOSE ... reason=PlayerClosed` がコンソール/チャットに出るか。

期待と注意:

- `open()` の直後は表示前の可能性がある。描画完了を保証しない。
- `getViewers()` は次 tick 時点の参考値。表示成功の判定に単独で使わない。
- 画面サイズ・UI スケール・入力方式を記録する。PC の合格をタッチ/コントローラーの合格にしない。

### 4.2 close reason

画面表示中はチャットを開けないため、`ServerClosed` は `!invui open 27 40` の自動 close で発生させる（`AUTOCLOSE size=27 close() requested=...` の後に `CLOSE ... reason=ServerClosed` を確認する）。**自動 close の前に、カーソルに持っているアイテムをスロットへ戻しておく（cursor 退避）。強制 close 時にカーソル上のアイテムが失われるかを確認する場合は、使い捨ての stick/paper だけで行う。**

cursor リスクの実際の制限:

- プローブは**カーソル上のアイテムを検出できず、退避も自動化できない**。`getViewers()` / `close()` / `event.items` のいずれにもカーソル状態は現れない（このプローブでは未確認）。cursor 退避は試験者の手動操作だけに依存する。
- **`AUTOCLOSE` の `ticks` は退避の時間を確保できる長さにする。** 20 ticks ≒ 1 秒。退避操作の途中で close すると、その時点のカーソル内容が失われ得る。
- `!invui stop` も同じくサーバー側から即時 `close()` するため、**停止コマンド実行前に cursor を空にする**。
- カーソルにアイテムを持ったまま `close()` した場合にアイテムが戻る・消える・複製するのいずれかは**未検証**。確認する場合は使い捨てアイテムだけで行い、確認できたら README と [API-NOTES.md](../API-NOTES.md) に記録する。

| 操作 | 期待する `reason` | 記録 |
|---|---|---|
| 画面を自分で閉じる | `PlayerClosed` | |
| `!invui open 27 40`（ticks 後の自動 close） | `ServerClosed` | |
| `!invui close`（画面を閉じた状態で実行） | 変化なし（`requested=0`） | |
| 画面を開いたままディメンション移動 | `ServerClosed` | |
| 画面を開いたまま死亡 | `PlayerDied` | |
| 画面を開いたままスペクテイターへ変更 | `PlayerSpectating` | |
| 画面を開いたまま退出 | `PlayerLeft`（`event.player` は無効） | |
| 別メニュー等で表示できない状態の `open()` | `UserBusy`（発生有無自体が未確認） | |

確認すること:

- 1 回の close に対して close イベントが何回届くか。
- イベントの `items` の空きスロットが `undefined` か。
- `PlayerLeft` で `player` 参照時に例外が出ないか（プローブ側は例外を握ってコンソール記録だけにする）。
- スクリプト再読み込み / ワールド shutdown では close イベントが来ない（[API-NOTES.md](../API-NOTES.md) 第 6 節）。このプローブはその経路を検証しない。

### 4.3 itemChange

> [!IMPORTANT]
> **画面を開いたまま `!invui fill` は実行できない（プローブが拒否する）。** 表示中の `setItem()` は複製を作り得るため、fill は全員が画面を閉じた状態でだけ行う。

1. `!invui open 27` で画面を開き、確認したら画面を閉じる（`CLOSE ... reason=PlayerClosed`）。
2. 画面が閉じている状態で `!invui fill` を実行する。→ この時点では `ITEM_CHANGE` は出ない。
3. `!invui open 27` で再度画面を開く。
4. 画面内で stick/paper を別スロットへ移動する。→ `DANGER ITEM_CHANGE` が届くか、`slot` と before/after が実際の操作と一致するか確認する。初回はチャットに `§c[危険]` の警告が出る。
5. 画面からプレイヤーインベントリへ取り出す。→ 取り出し操作でも `ITEM_CHANGE` が届くか確認する。**この時点でアイテムは実際に持ち出せる（保護なし）。**
6. 取り出したアイテムを画面へ戻す。→ before/after が一致するか。
7. 画面を閉じ、`CLOSE_CONTENTS` の内容と合計が画面・インベントリと一致するか確認する。
8. チャットが使える状態になってから `!invui dump` を実行し、`ACCOUNTING` の expected と actual、記録した画面表示、プレイヤーインベントリの個数を突き合わせる。合計が一致しない、複製・消失した場合は即時中止する。

注意:

- itemChange の連続操作でチャットが多くなる。必要ならコンソールログだけを見る。
- プローブは **表示専用アイテムを保護しない**。取り出しと再描画の組み合わせによる複製は、InvUI コア側の既知の未解決事項であり、このプローブの合格をもって安全と判断しない。
- 会計は fill と itemChange の差分から作る。**itemChange が取りこぼされると expected と actual がずれ、`DANGER ACCOUNTING` になる。** これは「取りこぼし・消失・複製のいずれか」であり、原因を特定しない限り合格にしない。
- **会計が見ているのは `typeId` と `amount` の合計だけ。** 表示名、lore、耐久値、エンチャント、カスタムコンポーネントなどは比較しない。同じ `typeId` の別物は同一として合算され、スロット位置も追跡しない。したがって「合計が一致した」は**完全なアイテム一致の確認ではなく、安全の証明でもない**。合格判定には画面・プレイヤーインベントリ・`CLOSE_CONTENTS` / `DUMP` の目視突き合わせを必ず併用する。
- `CLOSE` イベントの `items` が配列でない版では会計を判定できないため、`CLOSE_ITEMS missing` を記録するだけで STOP しない。
- fill 拒否・STOP・会計突き合わせは危険な操作を避けるためのガードであり、複製・消失が起きないことやアイテムが保護されることの証明ではない。
- 移動操作が複数スロットにまたがる場合、途中状態では会計を突き合わせない。突き合わせは close / dump の時点で行う。
- `button` / クリック通知の**受信観測**は 3.4 で行うが、click の実行や本物のクリック経路は検証しない。JSON UI と InputBridge が未検証のため。

### 4.4 画面を開いたままの fill（複製リスクの確認）

レビュー指摘のとおり、修正前のプローブは **画面を開いたまま `fill` できた**。`setItem()` はサーバー側のスロットを直接書き換えるが、開いているクライアントは表示中の内容を保持しているため、その後の移動操作で古い表示と新しいサーバー状態が競合し、アイテムが複製し得る。特に `open()` 直後は `getViewers()` にまだ反映されておらず、閲覧者ガードだけでは表示直前に書き込めてしまう盲点があった。現在は pending でも拒否する。プローブはこの経路を安全に検証できないため、次の扱いにする。

1. `!invui open 27` で画面を開く。
2. 画面を開いたまま、または open 直後に別プレイヤーから `!invui fill` を試す。別プレイヤーは事前に同じ size を開いて閉じ、対象を選択しておく（このプローブは最後に開いた size を使用する）。→ **`fill を拒否しました: 閲覧中` または `表示を確認できていない open が残っています` が出て `setItem` されないこと**を確認する（後者は viewer がまだ反映されていなくても拒否する fail-closed の確認）。
3. 画面を閉じ、`CLOSE ... reason=PlayerClosed` が届いた後に `!invui fill` を実行し、`ACCOUNTING` が一致することを確認する。**close イベント前は同じプレイヤーの `fill` も拒否される。**

補足:

- 拒否の対象は「`getViewers()` に見えている閲覧者」と「pending（open 要求済みで close イベント未到達のプレイヤー）」の両方。どちらも `setItem` しない。
- **実際の制限 1: pending は close イベントでしか解除されない。** `open()` が表示されない（`UserBusy` 等）まま close イベントが来ないと、その size の `open` と `fill` は再読み込みまで拒否され続ける。プローブに解除コマンドはない。
- **実際の制限 2: pending はプレイヤー id 単位で解除する。** close イベントの `player` が別インスタンスで来ても `id` が同じなら解除するが、`id` を取得できない場合は解除されない。
- **実際の制限 3: `getViewers()` も pending も「表示成功」を保証しない。** 表示されたかどうかは目視でしか確認できない。返答が `open() を要求しました` でも表示済みとは限らない。
- **実際の制限 4: このガードはサーバー側の書き込みを止めるだけ。** 端末側の表示・複製・消失が起きないことの証明ではない。
- 複製が実際に起きるかは未検証。このプローブの拒否は「危険な操作をしない」ためのガードであり、複製が起きないことの証明ではない。

### 4.5 複数画面（同一 size の共有コンテナ）

1. プレイヤー A が `!invui open 27` を実行する（プレイヤー B も同じワールドに参加）。
2. プレイヤー B が `!invui open 27` を実行する。→ **`open を拒否しました: 既に閲覧中 (...)` または `表示を確認できていない open が残っています (...)` が出て、A の画面が壊れないこと**を確認する。
3. プレイヤー A が画面を閉じ、`CLOSE ... reason=PlayerClosed` を確認する。
4. プレイヤー B が再度 `!invui open 27` を実行する。→ 今度は開けることを確認する。
5. どちらかの open が `UserBusy` などで表示されないまま終わった場合、close イベントが来ないため pending が残る。以降の `open` が拒否されたら再読み込みで解除する。

注意:

- 同一 size のコンテナを複数画面で同時に開くと、表示同期のずれから複製を作り得る。このガードは拒否するだけで、複製が起きないことの証明ではない。
- `getViewers()` は表示完了を保証しない。表示直後の競合を完全には防げないため、手動試験でも複数プレイヤーで同時に open しない。

## 5. 中止条件

次のいずれかが起きたら試験を中止し、パックを無効化する。

- `DANGER ACCOUNTING`（会計不一致）が出た。itemChange の取りこぼし・投入物の消失・複製のいずれかであり、原因を特定するまで合格にしない。
- 通常チェストでアイテム移動が壊れた。
- stick/paper が複製・消失した、または想定外のアイテムが増減した。
- 通常プレイヤーが参加できるサーバーで実行してしまった。
- クラッシュ、ワールド破損、チャットの異常。
- JSON UI を併用した場合に、InvUI 以外の画面へ変更が漏れた。

プローブ側の自動停止:

- 会計不一致を検知すると `!!! STOP 停止条件に該当 !!!` を出し、以降の `open` / `fill` を拒否する（close / dump / help は使える）。画面は自動では閉じない。
- 手動停止は `!invui stop`。全コンテナへ `close()` を要求し、以降の `open` / `fill` を拒否する。**強制 close の前に cursor 退避（カーソル上のアイテムをスロットへ戻す）を行う。**
- **STOP はプレイヤーインベントリ側の複製・増加を検知できない。** 会計はコンテナ内の `typeId` / `amount` 合計だけを見るため、インベントリの合計個数を目視で突き合わせること。
- 停止状態はスクリプト再読み込みで初期化される。**停止したら原因を記録し、ワールドを破棄またはバックアップから復元する。**

## 6. Node での静的チェック

実機の代替ではありません。JSON として読めること、JS の構文が通ること、manifest の依存と危険警告が残っていることだけを確認します。

```bash
node tests/manual-bedrock/probe/probe.test.mjs
# または
node --test tests/manual-bedrock/probe/probe.test.mjs
```

確認できること:

- `manifest.json` が単体でパースできる。
- header / module の UUID が新規形式で、script entry が存在する。
- dependency が `@minecraft/server` **`2.13.0-beta`** である。
- `main.js` が `node --check` を通る。
- 危険警告と、`virtualContainerManager.create` / `virtualContainerClose` / `virtualContainerItemChange` の使用が残っている。
- `!invui open` の ticks 指定が `system.runTimeout` でサーバー close を予約する（モック上で close が 1 回呼ばれることを確認）。
- 閲覧者がいるコンテナへの `fill` が拒否され、`setItem` されない。
- `getViewers()` が失敗したときも `fill` を拒否する（fail-closed）。
- open 後の close イベント前（pending）も `fill` を拒否し、close イベント後のみ `setItem` する（viewer 反映前の盲点の回帰確認）。
- 閲覧者がいる、または表示未確認の open が残っている間は `open` を拒否する。`getViewers()` 失敗時も拒否し、close イベントで pending が解除される。
- `main.js` と README に、強制 close 前の cursor 退避と、STOP がインベントリ側の複製を検知できないことが明記されている。
- itemChange が `DANGER` ログと投入物消失の警告を出す。
- close 時に `CLOSE_CONTENTS` を出し、会計不一致なら STOP する。
- STOP 後は `open` / `fill` を拒否し、`!invui stop` が close を要求する。
- `!invui:` 通知をキャンセルして `NOTIFY_OBSERVED` だけを記録し、click action / open / fill / チャット返信を起こさない。制御文字はエスケープされ、長さは切り詰められる。
- 通知 prefix 以外（通常チャット、`!invui ` コマンド）はキャンセルしない。
- README と manifest に「VirtualContainer は保存されない・貴重品/実アイテムを預けない」警告が残っている。
- ダイヤ等価値のあるアイテム ID を含んでいない。
- Resource Pack / JSON UI を同梱していない。

確認できないこと:

- 実機での表示、close reason、itemChange の発火。
- アイテムの複製・消失が実際に起きるか（プローブの拒否・STOP は危険を避けるガードであり、安全の証明ではない）。
- **アイテムの完全な一致。** 会計は `typeId` と `amount` の合計だけを比較するため、表示名・lore・耐久値・エンチャント等が異なる同種アイテムを区別できない。
- **通知の偽装耐性と、本物のクリック経路。** 通知はプレイヤーが手入力でき、このプローブは検証も操作もせず記録だけを行う。JSON UI の `button.send` が実際にこの prefix を送るかは、JSON UI を併用した別の確認が必要。
- 通常チェストへの影響（このパック単体では UI を持たないが、併用時は別途確認）。

## 7. 後片付けと記録

- パックを無効化し、`world_behavior_packs.json` の追加分を戻す。
- 通常チェストで移動が従来どおり動くことを再確認する。
- 記録: ゲーム版、`@minecraft/server` 版、Experiments の状態、プラットフォーム、入力方式、画面サイズ、結果、ログ。
- 結果は [CHECKLIST.md](../CHECKLIST.md) の該当 ID（`DISP-*`、`LIFE-*`、`CLICK-*` のうち該当範囲）に転記する。JSON UI / クリック / アイテム保護が未検証のままなら、それらを「合格」にしない。
