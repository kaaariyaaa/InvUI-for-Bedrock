# InvUI for Bedrock: VirtualContainer / Chat Bridge

**状態: 技術検証用。製品版ではない。**

設計書 `InvUI_for_Bedrock_Design.md` の 10.3–10.4 節が指定する、第1候補 `button.send → world.beforeEvents.chatSend → Window.handleClick()` を対象にしたリソースパックと実行可能な確認用ビヘイビアパック。`ActionFormData` と `button.drop_one` は使用していない。

## 含まれるもの

- `resource_pack`: `data_driven_container.desktop_panel` と `pocket_containers.data_driven_container_panel` へのパッチ。別のコンテナUIを丸ごと置き換えない。UIには `common.text_edit_box` と `button.send` の両方を配置する。
- `behavior_pack`: `VirtualContainer` を27スロットで開き、設計書形式のチャット通知を取り込む実行用スクリプト。受信者・セッション・レイアウト世代・スロット・通し番号を検証する。`Window.handleClick()` の代わりに受信結果をチャットへ出す。
- `tests`: JSON、manifest、UUID、連携、protocol の構造検証。

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
