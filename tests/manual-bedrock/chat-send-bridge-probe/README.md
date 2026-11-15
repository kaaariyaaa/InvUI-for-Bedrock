# InvUI for Bedrock: VirtualContainer / Chat Bridge

**状態: 技術検証用。製品版ではない。**

設計書 `InvUI_for_Bedrock_Design.md` の 10.3–10.4 節が指定する、第1候補 `button.send → world.beforeEvents.chatSend → Window.handleClick()` を対象にしたリソースパックと実行可能な確認用ビヘイビアパック。`ActionFormData` と `button.drop_one` は使用していない。

## 含まれるもの

- `resource_pack`: `data_driven_container.desktop_panel` と `pocket_containers.data_driven_container_panel` へのパッチ。別のコンテナUIを丸ごと置き換えない。UIには `common.text_edit_box` と `button.send` の両方を配置する。
- `behavior_pack`: `VirtualContainer` を27スロットで開き、設計書形式のチャット通知を取り込む実行用スクリプト。受信者・セッション・レイアウト世代・スロット・通し番号を検証する。`Window.handleClick()` の代わりに受信結果をチャットへ出す。
- `tests`: JSON、manifest、UUID、連携、protocol の構造検証。

## クリック入力（実装段階）

**操作方法:** `!invui test` で開いた27スロットの画面のアイテムを1回押すと、PC用のJSON UIグリッドが `button.drop_one` を実行する。Script APIの `virtualContainerItemChange` に届いたイベントからプレイヤーとスロットを特定し、サーバーが管理するセッション・レイアウト世代・sequenceと照合したうえで `Received slot click: logical slot=...` と表示する（現状は受信確認用ハンドラー）。

**元の第1候補は継続:** 上部のテキスト欄と `button.send` は残してある。ただし、通常のチェスト画面で `button.send` がチャットを送信できるか、押したスロット番号をJSON UIからチャットへ渡せるかは確認できていない。現時点の1クリック経路は設計書10.3の第2候補であり、**チャット送信を用いた自動クリックの完成ではない**。

**安全制限:** 消費可能な棒/紙を各スロット64個だけ入れ、1クリックで1個を落とす。画面表示中は絶対に補充しない。変更前後のアイテム種類・名前・個数を検証し、異常な変更やアイテムを置く操作が起きたら画面を閉じる。ドロップしたマーカー付きアイテムは`entityItemDrop`で回収を試みる。ただしイベント未到達や画面終了と競合した場合はワールドに残ることがある。貴重品のあるワールドや共有サーバーでは使わないこと。1スロットあたり最大63回（残り1個まで）で、それ以降は閉じて再度 `!invui test` で開き直す。ゲーム内では右クリック・Shift等のバイパスとアイテム保護も未検証。

**対応範囲:** デスクトップ版 `data_driven_container.panel_top_half` の27スロットを対象にした実験実装。Pocket/UIスケール別のクリック座標と本番`Window.handleClick()`への接続は未検証で、まだ製品版ではない。

## 想定外のスロット変更を調べる

画面が閉じた後に、チャットへ `Click diagnostic: slot=... expected=... before=... after=...` が表示される。アイテムの種類、個数、名前・識別マーカーが一致したかを示す。

- `after=empty`：操作後にスロットが空になった。通常のアイテム取り出しが起きた可能性がある。
- `before=...x64` → `after=...x63`、`name=ok lore=ok`：1個減る操作の条件を満たしているが、その他の状態が一致していない可能性がある。
- `lore=none`または`lore=present`：マーカーが保存・引き継ぎされていない可能性がある。

これらは**診断情報であり、検証条件を緩めたり取り出したアイテムを自動補充したりはしない**。同じ内容がコンテンツログにも出る。

## テスト方法

`.mcaddon` をBedrock Preview/Betaのテストワールドへインポートし、BPとRPを有効にする。コンテンツログを有効にする。通常のチャットから `!invui test` を送る。チャットを閉じるまで画面が開けない場合に備え、**10 tick（通常約0.5秒）ごとに最大24回、通常約12秒間** `VirtualContainer.open()` を再試行する。`getViewers()` にプレイヤーが現れた時点で再試行を止め、`UserBusy` で画面が閉じた場合は残り回数で再開する。`!invui clear`・通常の画面クローズ・退出・再度の `!invui test` で古い再試行を停止する。最初の試行はチャットを閉じる時間を確保するため10 tick後に始まる。`getViewers()` は画面表示の確証ではないので、**実際に `InvUI Chat Probe` の画面が表示されたか目視で確認する**。画面上部の入力欄へチャットに表示された `!invui:<session-id>:0:0:0` を入力し、`SEND` を押す。Script側から `Received chat click` が表示されたか、コンテンツログを確認する。右側や上側にテストUIが現れなければ、画面接続に失敗したことになる。

`!invui info` で次の通知例を表示する。`!invui clear` で現在の画面を閉じる。通常のチャット欄から通知文を入力して成功しても、**JSON UI のボタンによる送信が成立したことにはならない**。

## 元のライブラリとの関係

元のリポジトリには `src/chat-input-bridge.ts`、`src/input.ts`、`src/window.ts` があり、`world.beforeEvents.chatSend` から `Window.handleClick()` へ送る受信部分は実装されている。このデモのBPは既存ライブラリを改変しない。`Window` 側の受信処理はすでにあるため、同時にデモBPを入れて双方が同じプレフィックスを受けるようにしてはいけない。

**解消していない点**

1. JSON UIが押された各スロットの番号を通知テキストへ自動設定する方法。
2. JSON UIが開いているWindowのランダムなsession ID、レイアウト世代、sequenceを取得する方法。
3. `button.send`がチャット画面以外（`ChestScreenController`）で送信処理を実行するか。
4. `VirtualContainer`だけに表示を限定するゲートの実機妥当性。現状、タイトル `InvUI Chat Probe` を式で照合する試験的バインディングにしている。
5. PC・タッチ・コントローラーすべてにおける操作結果。

この5点のうち1～3が埋まらなければ、リソースパックからの任意スロットの自動クリックを本番実装できない。`button.send`が動いたとしても、固定の入力文字列を画面から送るだけではライブラリの動的な通知形式に足りない。

## 情報源

- 設計書: https://github.com/kaaariyaaa/InvUI-for-Bedrock/blob/main/InvUI_for_Bedrock_Design.md
- Mojang公式 container: https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/ui/data_driven_container_screen.json
- Mojang公式 chat: https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/ui/chat_screen.json
- Mojang公式 common: https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/ui/ui_common.json
- Bedrock Wiki JSON UI: https://wiki.bedrock.dev/json-ui/json-ui-documentation
