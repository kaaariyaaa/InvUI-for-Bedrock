# VirtualContainer 公式 API 調査ノート

> [!NOTE]
> これは設計書から独立した**調査記録**です。設計書および他のファイルは変更しません。
> 調査日: 2026-11-13。調査対象は `@minecraft/server` の npm beta と、公式ドキュメント（GitHub `MicrosoftDocs/minecraft-creator` main、`@minecraft/server` 型定義）。
> ここに書いた内容は**型定義と公式ドキュメントで確認できた範囲**であり、実機での動作を保証するものではありません。未検証点は第 8 節にまとめます。

## 1. 利用する版（リポジトリ内の指定）

| 項目 | 値 |
|---|---|
| パッケージ | `@minecraft/server` |
| 使用版 | **`2.13.0-beta.1.26.70-preview.24`** |
| npm の `beta` タグ | `2.13.0-beta.1.26.70-preview.24`（2026-11-13 時点） |
| npm 公開日 | 2026-11-10（npm registry の `time`） |
| このリポジトリの指定 | `package.json` の devDependencies と peerDependencies の**両方が `2.13.0-beta.1.26.70-preview.24` に完全固定**（レンジ指定ではない） |
| ドキュメント | `monikerRange: "=minecraft-bedrock-experimental"`（Experimental 専用） |
| 必要な設定 | Behavior Pack で Beta APIs（Experimental）を有効にする |

版の根拠と補足:

- `VirtualContainer` 関連の型は、この版の `index.d.ts` に存在する（`VirtualContainer` / `VirtualContainerManager` / `VirtualContainerOptions` / `VirtualContainerCloseAfterEvent` / `VirtualContainerItemChangeAfterEvent` / 各 Reason・Error）。
- 同じ 2.13.0-beta でも `1.26.70-preview.22` と `preview.23` には `class VirtualContainer` が**存在しない**。`2.13.0-beta.1.26.70-preview.24` が初出。
- `2.12.0-rc.1.26.70-preview.24` と安定版 `2.11.0` にも存在しない。したがって **rc / stable では使えず、この beta 固定が必須**。
- モジュール版の接尾辞 `1.26.70-preview.24` は Minecraft Preview のビルドに対応すると**推測**されるが、ゲーム側の表記との一致は実機で確認する（第 8 節）。ゲーム版をこのノートだけで確定しない。

## 2. 公式ドキュメント

- [VirtualContainer](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainer.md)
- [VirtualContainerManager](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerManager.md)
- [VirtualContainerOptions](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerOptions.md)
- [VirtualContainerCloseAfterEvent](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerCloseAfterEvent.md)
- [VirtualContainerCloseReason](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerCloseReason.md)
- [VirtualContainerOpenError](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerOpenError.md)
- [VirtualContainerItemChangeAfterEvent](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/ScriptAPI/minecraft/server/VirtualContainerItemChangeAfterEvent.md)

Microsoft Learn 側の入口: <https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/virtualcontainer>

## 3. コンテナの生成

`world.virtualContainerManager.create(options)` で生成する。

```ts
import { world } from "@minecraft/server";

const container = world.virtualContainerManager.create({
  size: 27,
  title: "InvUI", // 省略可。ローカライズキーも可
});
```

- `VirtualContainerOptions.size`: **1〜54**。画面は 9 個/行で並ぶ。9 / 27 / 54 に限定されない。
- `VirtualContainerOptions.title?`: 最大 **256 バイト**。ローカライズキーを指定した場合はキー長に適用。省略時は見出しなし。
- `size` と `title` は生成後に**変更できない**（`title` は読み取り専用）。
- 範囲外の `size` や長すぎる `title` は `minecraftcommon.PropertyOutOfBoundsError` を投げる。
- `create` は restricted-execution では呼べない。
- `VirtualContainer` は `Container` を継承し、通常の Container API（スロット操作など）が使える。ただし**ワールドに保存されない**。スクリプトからの参照がなくなり、かつ閲覧者もいなくなると破棄される。参照を保持すること。

## 4. 表示と終了

- `container.open(player)`: そのプレイヤーだけにチェスト風画面を表示する。同じコンテナを複数プレイヤーが同時に閲覧でき、画面はプレイヤーごとに独立。
- `container.close(player?)`: 指定プレイヤー、または省略時は全閲覧者の画面に閉鎖を**要求**する。戻り値は要求した画面数。すでに閉鎖中の画面は数えない。無効な `Player` を渡すと `InvalidEntityError`。
- `container.getViewers()`: 現在閲覧中の `Player[]`。
- `open` / `close` は restricted-execution では呼べない。

### close イベントが発生する条件

`world.afterEvents.virtualContainerClose` は、画面が閉じたときに `VirtualContainerCloseAfterEvent` を出す。`reason` は次のとおり。

| reason | 意味 |
|---|---|
| `PlayerClosed` | プレイヤーが閉じた、または端末が画面を表示できなかった |
| `PlayerDied` | 画面表示中に死亡した |
| `PlayerLeft` | 画面表示中に退出した（`event.player` は無効） |
| `PlayerSpectating` | スペクテイターに切り替えた |
| `ServerClosed` | `VirtualContainer.close()` による閉鎖、またはディメンション変更 |
| `UserBusy` | 端末が画面を表示しなかった（他のメニュー中など）。画面は一度も表示されていない |

**通常の close イベントは発生する。発生しないのはスクリプト再読み込み時とワールド shutdown 時だけ**（第 6 節）。イベントには閉鎖時点の全スロット内容 `items` が入る（空きは `undefined`、バンドル等はその時点の内容）。

### close の非同期性と再オープンの制約

- `close()` は「閉鎖を要求した」時点で返る。実際の `VirtualContainerCloseAfterEvent` は、**クライアントが UI を閉じ、保留中のインベントリ要求が完了した後**に発生する。**別 tick になることがある**。
- したがって `close()` の直後に同じプレイヤーへ `open()` してはいけない。前の画面が閉じ終わっていない場合、`VirtualContainerOpenError` の `PreviousScreenClosing` になる。**前の `virtualContainerClose` イベントを受け取ってから開く**か、後続 tick で再試行する。
- 1 人のプレイヤーが同時に開けるコンテナ画面は 1 つ。既にインベントリ・チェスト・別の VirtualContainer を開いている場合は `ContainerScreenOpen`。死亡中は `PlayerDead`、読み込み中・ディメンション変更中・ポータル内は `PlayerNotReady`、睡眠中は `PlayerSleeping`、スペクテイターは `PlayerSpectating`。
- `open()` が例外を投げなかったことは「画面が表示された」ことを意味しない。要求を送れただけであり、端末側が表示を拒否すると `UserBusy` で閉じる。
- プレイヤーが退出中・無効な場合は `open()` が `InvalidEntityError` を投げる。
- `close()` は既に閉鎖中の画面を二重に数えないため、多重呼び出しで close イベントが重複する設計にはなっていない（実機での重複有無は第 8 節）。

### スロット変更イベント

`world.afterEvents.virtualContainerItemChange` は、**プレイヤーが画面から**スロットを変更したときに発生する。`beforeItemStack` / `itemStack` / `player` / `slot` を持つ。**スクリプトによる変更では発生しない**。両イベントとも購読オプション `{ containers: [container] }` で対象コンテナを絞れる。

### 画面 UI の実装とその非推奨（`data_driven_container`）

Mojang 公式の Minecraft Preview 26.70.23 告知
（<https://minecraft.net/en-us/article/minecraft-preview-26-70-23>）は、
`data_driven_container_screen.json` と `data_driven_container` namespace への変更を
**非推奨（deprecated）**と明記し、**互換性を保証しない**としている。

このため、以下はこのノートの時点で**確認できていない**。

- `VirtualContainer` がこの UI（`data_driven_container_screen.json`）を使うかどうか。型定義にも公式ドキュメントにも画面の実装方式の記載はなく、**未確認**。仮に使っていたとしても、その JSON と namespace は互換保証の対象外である。
- `button.send` がチェスト風画面（VirtualContainer）で機能するか。**未確認**（チェスト画面では試していない）。
- 画面 ID・スロット番号をスクリプトから自動送信できる保証はない。`button.send` などの UI 連携に依存した自動操作を、実機検証が取れるまで実装・設計の前提にしないこと。

つまり、この画面は「見た目はチェスト」であっても、チェスト画面の JSON UI 挙動をそのまま流用できる保証はない。UI 連携に頼る案は、実機で成立を確認できるまで**候補扱い**にとどめる。

## 5. 最小利用例

```ts
import { world, system, type Player } from "@minecraft/server";

const container = world.virtualContainerManager.create({ size: 27, title: "InvUI" });

world.afterEvents.virtualContainerClose.subscribe(
  (event) => {
    if (event.container !== container) return;
    if (event.reason === "ServerClosed") return; // 意図した close
    // 閉鎖完了後にだけ再オープン・後片付けを行う
  },
  { containers: [container] },
);

export function show(player: Player): void {
  try {
    container.open(player);
  } catch (error) {
    // VirtualContainerOpenError.reason / InvalidEntityError を確認し、後続 tick で再試行
  }
}

export function hide(player: Player): void {
  const requested = container.close(player); // 非同期。完了は close イベントで知る
  void requested;
}
```

## 6. ライフサイクル（reload / shutdown）

`VirtualContainer` はメモリ上だけに存在し、ワールドに保存されない。公式ドキュメントの明記:

> When the world shuts down or scripts reload, open screens close without raising close events; save the contents from `system.beforeEvents.shutdown` if they need to outlive the session.

- **スクリプト再読み込み時とワールド shutdown 時は、開いていた画面が閉じても close イベントは発生しない。**
- セッションをまたいで内容を残すには、`system.beforeEvents.shutdown` で退避する。
- 再読み込み後は旧 `VirtualContainer` オブジェクトも旧セッションも無効。画面の自動再オープンは保証されない。
- `VirtualContainerItemChangeAfterEvent` も、スクリプトからの変更では発生しない点に注意。

## 7. 設計・実装への影響（このノート内の結論）

1. `package.json` の devDependencies / peerDependencies ともに `2.13.0-beta.1.26.70-preview.24` へ完全固定。rc / stable には API がないため、`manifest.json` の dependency も beta を指定する必要がある（具体的な manifest 表記は実機で確認）。他の版を受け入れるレンジ指定にはしていない。
2. 画面の再オープンは close イベント駆動にする。`close()` 直後の `open()` は `PreviousScreenClosing` を想定したリトライが必要。
3. close イベントは通常発生するので、終了処理は close イベントを基準にできる。ただし **reload / shutdown では来ない**ため、その経路だけ `system.beforeEvents.shutdown` と再読み込み時の初期化で補う。
4. `open()` の成功は表示成功ではない。`UserBusy` と `VirtualContainerOpenError` を異常系として扱う。
5. サイズは 1〜54 の任意。設計上の 9 / 27 / 54 は API 制約ではなく UI 側の選択。

## 8. 未実機検証点

型・ドキュメントで確認できても、実機で確認していない項目。実機試験では [CHECKLIST.md](CHECKLIST.md) の該当 ID と一緒に記録する。

| # | 未検証点 | 確認方法の候補 | 関連 ID |
|---|---|---|---|
| 1 | モジュール版 `1.26.70-preview.24` と実際の Minecraft Preview ビルドの対応 | ゲーム内の版表示と manifest を記録 | ENV-01 |
| 2 | Beta APIs を有効にした状態で `world.virtualContainerManager` が実際に生えるか | 最小 Behavior Pack で `create` を実行 | ENV-02 |
| 3 | チェスト風画面が各プラットフォームで表示され、`size` 1〜54 が正しく並ぶか | 9 / 27 / 54 と端数サイズを表示 | DISP-01〜03 |
| 4 | `open()` 直後の実際の表示タイミング、および `PreviousScreenClosing` の再試行間隔 | close イベント前後の open を試す | LIFE-05 |
| 5 | close イベントの実際の発火順・tick・重複有無（`PlayerClosed` / `ServerClosed`） | イベントログを時刻付きで記録 | LIFE-01〜05 |
| 6 | `UserBusy` のときに close イベントが発生するか（型・ドキュメントに明記なし） | 別メニューを開いた状態で `open()` | CLICK 系・LIFE |
| 7 | `PlayerLeft` の `event.player` 無効化の扱い（参照時例外の有無） | 退出時にイベント内容を記録 | LIFE-03 |
| 8 | reload / shutdown で close イベントが本当に来ないこと、`system.beforeEvents.shutdown` で内容を退避できること | 再読み込み・ワールド終了を実施 | LIFE-04、LIFE-06 |
| 9 | 同じコンテナを複数プレイヤーが同時閲覧したときの表示・更新の整合 | 2 人以上で同一コンテナを開く | INV-05 |
| 10 | 画面からの操作で `virtualContainerItemChange` が 1 操作 1 回届くか、スクリプト変更で来ないか | 操作ログとスクリプト変更を比較 | CLICK-01〜08 |
| 11 | JSON UI による操作抑制・透明ボタンが VirtualContainer 画面に適用できるか | Resource Pack を入れて確認 | BASE-04、PROT-* |
| 12 | `InventoryLink` の複製・消失（API 仕様ではなく実装の安全性） | 使い捨てアイテムで移動試験 | INV-01〜06 |
| 13 | VirtualContainer の画面が `data_driven_container_screen.json` を使うか（公式はこの JSON / namespace の変更を非推奨・互換保証なしと明記） | Resource Pack の有無で表示・挙動が変わるか比較 | BASE-04、COMPAT-01 |
| 14 | `button.send` がチェスト風画面で機能するか（チェストでの成立は未確認） | ボタンを押してチャット通知が出るか確認 | BASE-04、CLICK-09 |
| 15 | 画面 ID・スロット番号をスクリプトから自動送信できるか（保証なし） | 送信を試み、UI 側で受信できるか記録 | CLICK-09 |

> このノートの記述を理由に、未実施項目を「動作確認済み」にしないこと。版が変わったら再調査・再試験する。
