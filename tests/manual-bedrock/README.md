# Bedrock 実機テスト手順（フェーズ0）

このディレクトリは、InvUI for Bedrock の**実機未検証機能**を安全に検証するための手順と合否基準をまとめたものです。設計書のフェーズ0（技術検証）に対応します。

> [!WARNING]
> **実機では未検証です。コアの画面は既定で開き、アイテム保護はありません。Resource Pack の画面接続は変更中です。**
>
> - **`Window.open()` は既定で実画面を開きます。** 実アダプタ（`minecraftVirtualContainerAdapter`）は `canOpenScreens = true` を返し、`Window.open()` が `world.virtualContainerManager.create()` で `VirtualContainer` を作成して `VirtualContainer.open()` を呼び、`Window.close()` が `VirtualContainer.close()` を呼びます。`open()` を許可するテスト用アダプタの注入は不要です。`WindowOpenRejectedError` は、利用者が `setContainerAdapter()` で `canOpenScreens = false` のアダプタを渡した場合にだけ発生します。
> - **この open 経路は実機未検証です。** 画面が実際に表示されるか、`close()` がいつ完了するかは確認していません。`close()` は要求時点で返り、close イベントは別 tick になることがあるため、直後の再 `open()` は失敗し得ます。
> - **表示専用アイテムの保護はありません。** 画面を開くと表示アイテムは実際の `VirtualContainer` に `setItem()` で書き込まれ、入力抑制も JSON UI もないためプレイヤーが取り出せます。さらに `refresh()` や状態更新の再描画で同じアイテムが再設定されるため、**取り出しと再描画の組み合わせでアイテムが複製され得ます**。逆に、プレイヤーが入れたアイテムを再描画が上書きすると**消失**し得ます。保護を実装するまで、この経路は安全ではありません。
> - **itemChange の検出は保護ではありません。** 既定のアダプタは `world.afterEvents.virtualContainerItemChange` を購読し、画面からの変更を `Window` が `WindowItemChangeDangerError` としてエラーハンドラーへ通知し、再描画を停止して close を要求します。ただし `after` イベントなので変更はすでに起きており、取り消しも変更前への復元もできません。close の成否も未検証です。
> - **raw probe とコアの試験は別物です。** [`probe/`](probe/README.md) の raw probe は InvUI コアもアダプタも使わず、`world.virtualContainerManager` から `VirtualContainer` を直接開くため、`VirtualContainer` 単体の表示・close reason・itemChange を確認できます（未実施）。一方、DISP 以降のコア試験は `Window.open()` 経由で、InvUI のレイアウト・描画・将来の保護を対象にします。**raw probe の結果をコアの合格に流用せず、その逆もしないでください。**
> - **Resource Pack の画面接続は変更中で、適用可否は未検証です。** `resource_pack/ui/invui_connect.json` と `invui_connect_data_driven.json`（[`resource_pack/experimental/connect-data-driven/`](../../resource_pack/experimental/connect-data-driven/README.md)）が `data_driven_container` の `desktop_panel` / `pocket_panel` へ差し込む試験的接続で、作業ツリーの `ui/_ui_defs.json` はこれを登録済みです。接続は警告ラベルと `invui_probe_root` を `insert_front` で、**透明ブロッカー**（`invui_connect_probe.grid_blocker`）を `insert_back` で差し込みます。ただし `VirtualContainer` を特定できないため、**そのパネルを使う全画面（通常のコンテナを含み得る）に適用され得ます**。接続が実際に効くか、ブロッカーが入力を遮断するか、適用範囲、通常チェストへの影響は未検証で、ファイル構成も変更中です。**試験時に実際の `_ui_defs.json` と導入ファイルを確認して記録し、「接続済み」「未接続」のどちらも既定事実として扱わないでください。**
> - **`InventoryLink.moveTo()` は常に拒否されます**（`InventoryLinkMoveRejectedError`）。クリック入力を実機イベントへつなぐ仕組みも未提供です。
> - **実機での実験は使い捨てワールドだけで行ってください。** 本番ワールド・配布用ワールド・共有サーバーでは実行しないでください。
> - [`button-send-resource-pack/`](button-send-resource-pack/README.md) は、クリック通知の候補である `button.send` を単独で観察する**実験用 Resource Pack（使い捨てワールド専用）**です。クリック通知は未検証であり、通知文字列を自動で設定する仕組みはなく、入力抑制・アイテム保護もありません。`chest-resource-pack/` や `data-driven-resource-pack/` など**他の Resource Pack との併用は禁止**です。このキットが存在することは、クリック通知の試験を実施済みという意味ではありません。
> - [`edit-box-resource-pack/`](edit-box-resource-pack/README.md) は、入力欄（`edit_box`）と `button.send` の組み合わせを観察する**実験用 Resource Pack（使い捨てワールド専用）**です。**未検証**であり、`#message_text_box` と `always_listening` を使うため**チャット入力を奪い得ます**。バニラのチェストパネルを対象とするため**通常のチェストにも表示される可能性があり、移動が壊れたら即時中止**してください。**アイテム保護はありません。** `button-send-resource-pack/` など**他の Resource Pack との併用は禁止**です。導入だけで試験実施済みにはなりません。
> - 現時点で自動で実施できるのは CLI と自動テストだけです。CLI は既定でどのファイルにも書き込まず、`--install-resource-pack` を明示した場合だけ `ui/invui.json` と試験的接続の `ui/invui_connect*.json` を追加します（`manifest.json`、`ui/_ui_defs.json`、`ui/chest_screen.json` は変更しません）。`generate-resource-pack` の生成物だけは接続登録済みの `ui/_ui_defs.json` を含みます。実機のクリック・アイテム保護・`InventoryLink` の安全性を、自動テストで代替しないでください。

## 1. 目的

次の未確定事項を、実際のゲームで確認します。

1. `VirtualContainer` のチェスト画面で、`button.send` などによる入力通知が成立するか。
2. JSON UI による通常操作の抑制と透明ボタンの重ね合わせが、PC・タッチ・コントローラーで機能するか。覆った範囲のボタンや inventory slot を巻き込まないか、プレイヤー側の操作を妨げないか。
3. InvUI の画面だけに JSON UI を適用し、通常のチェストへ影響させない判定ができるか。
4. `InventoryLink` のアイテム移動を有効化した場合に、重複・消失を防げるか（現行コアでは移動自体を拒否）。
5. 9 / 27 / 54 スロットと各入力方式で表示が整合するか。

これらは設計書の採用候補であり、**検証前の機能を「動作確認済み」として扱いません。** 個々の API の存在や挙動も、この手順の結果で確認する対象です。

## 2. 安全上の注意

- **使い捨てのテスト用ワールド**で実施する。本番ワールドや配布用ワールド、通常プレイヤーが入るサーバーでは行わない。試験後はワールドごと破棄してよい状態にする。
- 実施前にワールドと Resource Pack / Behavior Pack のバックアップを取る。
- 検証には価値のないアイテムだけを使う。`InventoryLink` の試験でも、回収不能になってもよいアイテムのみを使う。
- **表示専用アイテムは保護されていない。** 画面を開いたとき `setItem()` で置かれるだけで、プレイヤーは取り出せる。取り出した後に `refresh()` が走ると再設定され、複製が起こり得る。逆に、プレイヤーが入れたアイテムを再描画が上書きすると消失し得る。試験で表示アイテムを使う場合も、使い捨てアイテムだけにする。
- **コアの画面は既定で開く。テスト用アダプタの注入は不要になった。** `minecraftVirtualContainerAdapter.canOpenScreens` は `true` で、`Window.open()` がそのまま実画面を開こうとする。これは「実機で確認済み」という意味ではなく、使い捨てワールドでのみ行う理由そのものである。`setContainerAdapter()` で `canOpenScreens = false` のアダプタを渡した場合だけ `WindowOpenRejectedError` で拒否される。
- **Resource Pack の画面接続は変更中。** `ui/invui_connect.json` と `invui_connect_data_driven.json` は `data_driven_container` のパネルへ差し込む試験的接続で、`VirtualContainer` を特定できない。**透明ブロッカーは保護ではなく、覆った範囲のボタンや inventory slot も抑制し得る**一方、プレイヤー側のインベントリ・ホットバーは覆わず、controller・タッチ入力の遮断を保証しない。導入する場合は、実際の `ui/_ui_defs.json` とファイル構成を記録し、通常チェストへの影響を最初に確認する。**ブロッカーがあることを合格の根拠にしない。**
- マルチプレイで試す場合は、参加者を限定したテスト用サーバーを使う。通常プレイヤーが入れる場所では有効化しない。
- 既存の `ui/chest_screen.json` を直接書き換えない。バックアップと差分を保持する。CLI は `ui/invui.json` と試験的接続 2 ファイルだけを導入し、`ui/_ui_defs.json` への登録は自動化しない。
- クリック・アイテム保護・JSON UI・`InventoryLink` は、この手順の合格が確認できるまで**安全に利用できない機能**として扱う。

### 即時中止する条件

次のいずれかが発生したら、その場で試験を中止し、アドオンと Resource Pack を無効化します。続行して「たまたま動いた」を合格にしません。

- 通常のチェスト（InvUI 以外）でアイテム移動が壊れた、または UI が崩れた。
- 表示専用アイテムが持ち出せた、または操作で増減した。
- アイテムの複製・消失を確認した。
- 画面からの変更で `WindowItemChangeDangerError` が通知されなかった、または通知後も画面が操作できた。
- 画面終了後やページ変更後に、古い通知がクリックとして実行された。
- チャット通知方式が通常チャットを壊した、または通知がプレイヤーに表示された。
- クライアントがクラッシュした、またはワールドが破損した。

## 3. 実施環境の記録

試験ごとに次を記録します。CLI の検査結果だけでは、ゲーム版や Experimental の状態を確定できません。

| 項目 | 記録 |
|---|---|
| 実施日 | |
| 実施者 | |
| Minecraft の版（Preview/Beta の具体的なビルド） | |
| `@minecraft/server` の版 | |
| プラットフォーム（Windows / iOS / Android / Xbox など） | |
| 入力方式（PC マウス / タッチ / コントローラー） | |
| Behavior Pack の版・ハッシュ | |
| Resource Pack の版・ハッシュ（手動 UI を含む） | |
| `ui/invui_connect*.json` の導入有無 / `ui/_ui_defs.json` への登録有無（接続は変更中・未検証） | |
| 画面を開いた経路（既定アダプタの `Window.open()` / raw probe の `!invui open` / 独自アダプタ） | |
| 併用している他の Resource Pack | |
| ワールドのバックアップ取得 | 済 / 未 |

## 4. 準備

1. テスト用ワールドを複製し、バックアップを取る。
2. 対象の Preview/Beta で Experimental API を有効にする。必要な設定はゲーム版によって異なるため、実際の画面で確認して記録する。
3. Behavior Pack を配置する。現行コアの `Window.open()` は既定で実画面を開く（`VirtualContainer` を作成して `VirtualContainer.open()` を呼ぶ）ため、`open()` を許可するテスト用アダプタは不要。ただしこの経路は実機未検証でアイテム保護もない。使い捨てワールドでのみ実行する。**InvUI コアを使わない [`probe/`](probe/README.md) の raw probe は、`world.virtualContainerManager` を直接呼んで `VirtualContainer` を開くため、コアのビルドもアダプタも不要**（プローブ README の手順で `behavior_pack/` を配置する）。両者は対象が別であり、raw probe の結果を DISP 以降の合格に流用しない。
4. **`ui/_ui_defs.json` へ接続ファイルを登録する前に**、通常チェストの基準動作を確認する（手順 A、および CHECKLIST の BASE-04 で導入後に再確認）。
5. Resource Pack を用意する。`resource_pack/` には `manifest.json`、`ui/_ui_defs.json`、`ui/invui.json`、試験的接続の `ui/invui_connect.json` / `ui/invui_connect_data_driven.json`（[`resource_pack/experimental/connect-data-driven/`](../../resource_pack/experimental/connect-data-driven/README.md)）、**オプトインで未登録**の手入力・静的ペイロード送信プローブ `ui/invui_controls.json` / `ui/invui_controls_data_driven.json` がある。**接続は変更中で、適用可否は未検証**であり、`data_driven_container` のパネルを使う全画面に影響し得る。接続には透明ブロッカーが含まれ、覆った範囲では**ボタンや inventory slot も抑制し得る**一方、プレイヤー側や controller・タッチ入力の遮断は保証しない。手動プローブは chat と同じ text box 名を使い、固定例 `!invui:window-1:<slot>:1` を手入力して送信経路だけを観察するもので、slot / session / sequence の自動生成はできない。有効化するとキーボード入力を奪い得るため、既定の接続には含めず、使う場合だけ 2 ファイルを `_ui_defs.json` へ登録する。既存 Resource Pack へ入れる場合は、CLI の `--install-resource-pack` で 3 ファイルを追加し、`ui/_ui_defs.json` への登録はバックアップと差分を確認して手動で行う。**作業ツリーの `ui/_ui_defs.json` は接続 2 ファイルを登録済みだが、これは変更中の内容である。**試験時点の実ファイルを確認し、登録の有無を CHECKLIST に記録する。登録してもしなくても、実機で適用されるかは未検証。
6. 検査だけなら、次の CLI を実行して静的状態を確認できる。既定ではどのファイルにも書き込まない。

   ```bash
   node bin/cli.js init \
     --behavior-pack <Behavior Pack のパス> \
     --resource-pack <Resource Pack のパス> \
     --json
   ```

   既存 Resource Pack へ `ui/invui.json` と試験的接続 2 ファイルを追加する場合は、`--install-resource-pack` を明示する。追加されるのは `ui/invui.json`、`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` だけで、既存ファイルは上書きしない。内容が異なる同名ファイルが既にあれば競合として中断し、差分を表示して終了コード 1 になる（書き込み前に検査エラーがあれば `blocked` で書き込まない）。`manifest.json`、`ui/_ui_defs.json`、`ui/chest_screen.json` は変更しない。`--report` は廃止されており、指定すると引数エラーで失敗する。

   ```bash
   node bin/cli.js init \
     --resource-pack <Resource Pack のパス> \
     --install-resource-pack \
     --json
   ```

   `generate-resource-pack` は別コマンドで、`manifest.json`、接続登録済みの `ui/_ui_defs.json`、`ui/invui.json`、`ui/invui_connect.json`、`ui/invui_connect_data_driven.json` を新しい出力先へ生成する（既存パスへは書き込まない）。生成物は実機未検証。

   保存する場合は、利用者が標準出力をリダイレクトしてください。検査エラーがある場合は終了コード 1 になります。

7. 試験マトリクスを用意する。

| スロット数 | PC マウス | タッチ | コントローラー |
|---|---|---|---|
| 9 | 未実施 | 未実施 | 未実施 |
| 27 | 未実施 | 未実施 | 未実施 |
| 54 | 未実施 | 未実施 | 未実施 |

入力方式ごとに、対象画面のサイズ・UI スケール・言語設定も記録します。

## 5. 試験の順序

安全性の高い順に進めます。前の段階が不合格なら、後の段階へ進みません。

### A. 通常チェストの基準確認（JSON UI 導入前後）

通常のチェストを開き、チェスト間・プレイヤーインベントリ間でアイテムを移動する。`ui/_ui_defs.json` へ試験的接続（`ui/invui_connect*.json`）を登録した後も、InvUI 以外のチェストで従来どおり移動できることを確認する。接続は `data_driven_container` のパネルを使う画面全体に及び得るため、この段階を最初に置く。**透明ブロッカーはグリッド付近を覆うため、通常チェストでアイテム操作が止まった場合は、ブロッカーが効いている可能性がある。**その場合は「通常チェストが壊れた」として中止し、接続を外して再確認する。ブロッカーがボタンや inventory slot も抑制していないか、プレイヤー側のインベントリ・ホットバーは操作できるかを記録する。

- 対象 ID: `BASE-01` 〜 `BASE-03`
- 不合格の場合は中止。画面識別または入力抑制の設計を見直す。

### B. 表示の確認（9 / 27 / 54 スロット）

固定スロットのみの画面を開き、アイテムが正しい位置・個数・見た目で表示されるか、各スロット数・入力方式・画面サイズで確認する。現行コアの `Window.open()` は既定で実画面を開くため、独自アダプタなしで試せるが、**実機で表示されるかは未検証**で、表示アイテムは保護されていない。JSON UI の重ね合わせを使う場合は Resource Pack の接続が必要だが、**接続は変更中で適用可否は未検証**であり、`VirtualContainer` を特定できないため通常のコンテナ画面にも影響し得る（[`resource_pack/experimental/connect-data-driven/`](../../resource_pack/experimental/connect-data-driven/README.md)）。接続には透明ブロッカーが含まれるため、**表示は見えてもグリッド上の操作がブロッカーに吸われ、表示の確認と操作の確認を分けて行えない可能性がある**。ブロッカーがボタンや inventory slot も覆っていないか（desktop は `offset [7, 10]` / `size [162, "100%-24px"]`、pocket は右半分）、プレイヤー側が操作できるかを記録する。接続を使うかどうか、`ui/_ui_defs.json` の登録状態を記録する。**使い捨てワールドでのみ実施する。**

- 対象 ID: `DISP-01` 〜 `DISP-03`
- あわせて、最終ページ・未使用スロットが空であることを確認する（ページ・タブ・スクロールを使うテストビルドが用意できた場合）。

### C. アイテム保護（表示専用・ボタン用スロット）

表示専用スロットのアイテムについて、通常クリック、Shift クリック相当、ドラッグ、ダブルクリック相当、ドロップ操作を試す。持ち出せないこと、個数が変わらないこと、複製・消失しないことを確認する。現行コアにはアイテム保護の実装がないため、保護を組み込んだテストビルドでのみ合格できる。

現行コアの画面は、表示アイテムを `setItem()` で置くだけで、入力抑制も JSON UI もない。プレイヤーは表示アイテムを取り出せ、その後に `refresh()`（状態更新・購読）が走ると同じアイテムが再設定されるため、**取り出しと再描画の組み合わせで複製が起こり得る**。逆に、プレイヤーが入れたアイテムを再描画が上書きすると**消失し得る**。この試験では、取り出し後に画面を操作して再描画させる手順も試す。

画面からの変更は、既定アダプタの `world.afterEvents.virtualContainerItemChange` 購読によって `WindowItemChangeDangerError` としてエラーハンドラーへ通知され、再描画停止と close 要求が行われる。ただし `after` イベントのため保護ではなく、**通知が来てもアイテムは戻らない**。通知が来なかったこと・close が成功したことを合格根拠にしない。

JSON UI の上重ねだけでコンテナ側グリッドの操作を止められるかを切り分ける実験用 Resource Pack が [`protection-resource-pack/`](protection-resource-pack/README.md) です。**保護の実装ではなく、使い捨てワールド専用で、通常のチェストの操作にも影響し得ます。** 対象はグリッド全体で、スロット単位・InvUI 限定の抑制は検証できません。同梱の `check.mjs` は JSON 構造だけを検査します。

**既定の接続に含まれる透明ブロッカーも保護ではありません。** ブロッカーはコンテナ側グリッド付近を覆い、スロット系の入力を `button.invui_connect_blocked` へ流しますが、受け側のスクリプトはありません。覆った範囲では**ボタンや inventory slot も抑制し得る**一方、**プレイヤー側のインベントリ・ホットバーは範囲外**で、controller のフォーカス移動、タッチの長押し・ドラッグ、JSON UI を経由しない操作の遮断は保証しません。赤いホバー・押下表示はブロッカーが入力を受けた手がかりにすぎず、アイテムが動かないことの証明ではありません。**ブロッカーが効いたことを `PROT-*` の合格根拠にせず**、ブロッカーの範囲・入力方式ごとの結果をメモに残す。アイテム保護の実装・検証は別途必要です。

`VirtualContainer` の画面で JSON UI の上重ねだけを試す場合は、raw probe の `!invui fill` で中身を入れる。**`fill` は画面を開いていない状態でだけ実行でき（表示中・`open` 直後の pending 中は probe が拒否する）、その後に `!invui open` で開く**。逆順（開いてから fill）にしない。`fill` が拒否されずに書き込まれた場合は中止する。ただしこれは raw probe が開いたコンテナでの観察であり、**コアの `Window` が置く表示アイテムの保護試験ではない**。`PROT-*` はコアの画面に対して実施する。

- 対象 ID: `PROT-01` 〜 `PROT-04`
- **1 つでも持ち出せたら不合格。** クリック通知の試験へ進まない。

### D. クリック通知

透明ボタン等の入力経路が利用できる場合に限り、通常クリックが Script API へ 1 回だけ届くか確認する。`button.send` → チャット通知は候補であり、採用確定ではありません。現行コアにはクリック入力を実機イベントへつなぐ仕組みがなく、JSON UI の画面接続も変更中・未検証です。接続を有効にしても、通知を解釈して `Window.handleClick()` へ渡す処理はコアにないため、この試験は入力ブリッジと UI を実装したテストビルドでのみ実施できます。既定接続の透明ブロッカーは押下を `button.invui_connect_blocked` へ流すだけで、クリック通知を送りません。チェスト画面で成立しない場合は不合格として記録し、別方式を検討する。

この観察だけを切り出した実験用 Resource Pack が [`button-send-resource-pack/`](button-send-resource-pack/README.md) です。**使い捨てワールド専用**で、陽性対照ラベルと `button.send` を発火させるボタンを 1 つずつ通常チェスト画面へ差し込むだけで、**通知文字列を自動で設定する仕組みはなく**、入力抑制もアイテム保護もありません。**他の Resource Pack との併用はできません。** 同梱の `check.mjs` は JSON 構造だけを検査し、表示・押下・通知受信は確認しません。導入しただけでは `CLICK-01` 〜 `CLICK-09` を「実施済み」にしないでください。

確認項目:

- 1 クリックにつき通知が 1 回か（`CLICK-01` 〜 `CLICK-03`）
- 通知からプレイヤーとスロットを特定できるか（`CLICK-04`）
- ページ変更・画面終了後の古い通知が破棄されるか（`CLICK-05`）
- 通知文字列が通常チャットとして表示されないか（`CLICK-06`）
- 同じ通知の連続送信で処理が重複しないか（`CLICK-07`）

### E. `InventoryLink` の安全試験

**必ず最後に、使い捨てアイテムだけで実施する。** リンクされたスロットと保管領域の間で、クリック・ドラッグ・カーソル上アイテム・画面終了・死亡を組み合わせ、増減が一致するか確認する。現行コアの `InventoryLink.moveTo()` は常に `InventoryLinkMoveRejectedError` を投げるため、移動を実装・明示的に有効化したテストビルドでのみ実施できる。それまでは「未実施」のまま残す。

- 対象 ID: `INV-01` 〜 `INV-05`
- 複製・消失が 1 件でもあれば中止し、`InventoryLink` を無効のままにする。

### F. ライフサイクルと再読み込み

死亡、ディメンション移動、切断、スクリプト再読み込みを試す。終了イベントの重複、古い入力の実行、`persistent` 状態の復元を確認する。画面の自動再オープンは標準保証としない。

- 対象 ID: `LIFE-01` 〜 `LIFE-05`

### G. 競合確認

他の Resource Pack と併用し、通常チェスト・InvUI 画面・UI の表示崩れを確認する。競合をゼロにできるとは保証しない。試験的接続（`ui/invui_connect*.json`）も変更中・未検証の Resource Pack 変更であり、接続の登録前後で通常チェストを比較して影響を切り分ける。**ブロッカーにより通常チェストのボタンや inventory slot が押せなくなる場合がある**ため、アイテム移動だけでなくボタン操作も比較する。ただし [`button-send-resource-pack/`](button-send-resource-pack/README.md) は単独使用が前提の実験キットであり、この競合試験には併用しない（ラベルが同一位置で重なり、由来を切り分けられなくなる）。

- 対象 ID: `COMPAT-01` 〜 `COMPAT-03`

## 6. 判定ルール

- 各項目は **合格 / 不合格 / 未実施 / N/A** で記録する。N/A は理由を必ず書く。
- 入力方式ごとに結果を分ける。PC で合格しても、タッチ・コントローラーの合格にはしない。
- 安全性に関わる項目（`BASE-*`、`PROT-*`、`INV-*`）が 1 つでも不合格なら、そのビルドは配布対象にしない。
- 全項目合格でも、**その試験で使った特定のゲーム版・`@minecraft/server` 版・入力環境**での合格にすぎない。ベータである事実は変わらない。
- クリック機能は、設計書 10.8 の合格条件を満たすまで正式機能として公開しない。
- `InventoryLink` は、アイテム安全試験を満たすまで制限付き・無効のままとする。

## 7. 記録と報告

- [CHECKLIST.md](CHECKLIST.md) をコピーし、試験ごとに記入する。
- 各項目に、再現手順、期待結果、実際の結果、スクリーンショットやログの有無を残す。
- 不合格時は、どの条件で再現したか（入力方式、スロット数、画面サイズ、操作順）を具体的に書く。
- CLI の検査結果（`--json`）を残す場合は、標準出力を利用者がリダイレクトして保管する。CLI は既定でファイルを書きません。`--install-resource-pack` 指定時だけ `ui/invui.json` と試験的接続 2 ファイルを追加し、その結果は `resourcePackInstall` に入ります。ただし CLI は実機の入力・表示・アイテム安全を検証しません。
- ゲーム版や `@minecraft/server` 版が変わったら、同じ結果を流用せず再試験する。

## 8. 自動テスト（実機テストの代替ではない）

CLI の安全側の動作は、次のテストで確認できます。

```bash
node tests/manual-bedrock/cli.test.mjs
# または
node --test tests/manual-bedrock/cli.test.mjs
```

確認できること:

- 既定の CLI が Behavior Pack / Resource Pack を変更せず、どのファイルにも書き込まない。
- `--install-resource-pack` 明示時だけ `ui/invui.json` と試験的接続 2 ファイル（`ui/invui_connect.json`、`ui/invui_connect_data_driven.json`）を追加し、既存ファイル（`manifest.json`、`ui/_ui_defs.json`、`ui/chest_screen.json` を含む）を変更しない。
- 同内容の導入先ファイルは書き換えず、異なる内容は上書きせず差分を出して中断する。失敗時は追加済みファイル・一時ファイル・作成した空ディレクトリの削除（ロールバック）を**試みる**が、削除権限がない等の場合は**部分適用が残り得る**。自動テストが確認するのはシミュレートした失敗経路だけであり、すべてのファイルシステム障害を再現するものではない。
- `--json` が単体でパースできる JSON を標準出力へ出し、`status` に `beta-unverified` を含める。
- 廃止した `--report` を指定すると引数エラーで失敗し、レポートファイルも作らない。
- 壊れた `manifest.json` で失敗し、パックを変更しない。
- 未検証・ベータであることを出力に含める。

確認できないこと:

- ゲーム内のクリック、アイテム保護、JSON UI の適用範囲。
- Resource Pack の試験的接続が実際に画面へ適用されるか、VirtualContainer に限定されるか（VirtualContainer 画面が同パネルを使っているかは未確定）。
- 透明ブロッカーが入力を遮断するか、覆った範囲のボタンや inventory slot を巻き込まないか、プレイヤー側・controller・タッチでどう振る舞うか。
- アイテムの複製・消失。
- 入力方式ごとの挙動。

`button.send` 実験キットの構造検査は、次のコマンドで実行できます。

```bash
node tests/manual-bedrock/button-send-resource-pack/check.mjs
```

確認できるのは JSON の整合性（manifest の警告文、`_ui_defs` の参照先、`button.send` だけを発火するボタン、禁止した入力系 control の不在、`chest` / `pocket_containers` への `insert_front`）だけです。表示・押下・通知の受信・通常チェストへの影響は確認しません。

アイテム操作抑制プローブの構造検査は、次のコマンドで実行できます。

```bash
node tests/manual-bedrock/protection-resource-pack/check.mjs
```

確認できるのは JSON の整合性（manifest の警告文、ブロッカーがスロット系の入力だけを no-op へ流すこと、禁止した入力系 control の不在、対象パネルへの `insert_back` と座標、`chest_screen.json` を同梱・登録していないこと）だけです。パックの読み込み、描画、入力の遮断、アイテム保護、通常チェストへの影響は確認しません。

edit_box 実験キットの構造検査は、次のコマンドで実行できます（CI でも他の構造検査と一緒に実行されます）。

```bash
node tests/manual-bedrock/edit-box-resource-pack/check.mjs
```

確認できるのは JSON の整合性（manifest の警告文、`_ui_defs` の参照先、入力欄が `#message_text_box` を指定し固定文字・`bindings` を持たないこと、ボタンが `button.send` だけを発火すること、`chest` / `pocket_containers` への `insert_front`）だけです。表示・入力・送信、チャットや通常チェストへの影響、アイテム保護は確認しません。

## 9. 未確定のまま残す事項

以下は、この手順を実施して結果が出るまで確定しません。

- 入力通知方式（`button.send` → チャット通知を採用できるか）
- 表示専用スロットの操作抑制方法（現状は無保護で、取り出し＋再描画による複製、再描画による消失が起こり得る）
- 既定の `Window.open()` 経路で実機の画面が表示されるか、`close()` がいつ完了するか、直後の再 `open()` が成立するか
- itemChange 検出（`WindowItemChangeDangerError`）から close 要求までが実機で機能するか
- Resource Pack の試験的接続（`ui/invui_connect*.json` → `data_driven_container` のパネル）が適用されるか、`VirtualContainer` に限定できるか、通常チェストへの影響。VirtualContainer 画面が同パネルを使っているかは未確定。
- 透明ブロッカー（`invui_connect_probe.grid_blocker`）が実際にスロット系入力を遮断するか、ボタンや inventory slot も抑制してしまうか、プレイヤー側・controller・タッチ入力を止められるか。遮断は保証されておらず、アイテム保護ではない。
- 9 / 27 / 54 スロットと画面サイズの整合性
- raw probe とコアで確認できる範囲の境界（raw probe は `VirtualContainer` 単体、コアはレイアウト・描画・保護。相互に流用不可）
- テンプレートの `manifest.json`（`version` / `min_engine_version`）が対象ゲーム版で妥当か
- `InventoryLink` の安全な移動手順
- 対応する Minecraft / `@minecraft/server` の版

結果が出るまで、README や CLI の出力に「動作確認済み」「安全」と記載しないでください。実機で試す場合は、結果にかかわらず使い捨てワールドだけで行ってください。
