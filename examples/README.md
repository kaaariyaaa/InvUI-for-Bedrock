# 利用スケッチ

[usage-sketch.ts](usage-sketch.ts) は現行の公開 API に基づく利用イメージです。実行例や動作確認済みサンプルではありません。

> [!WARNING]
> `Window.open()` は既定で実画面を開こうとしますが、Bedrock 実機では未検証です。クリック通知を生成する UI や JSON UI 連携はなく、アイテムの事前保護もありません。表示アイテムの複製・消失が起こり得るため、本番ワールドでは実行しないでください。

スケッチには、`Gui.paged()`、`Structure`、`Item.builder()`、`Window.builder()`、状態スコープ、open/close ハンドラーの利用例が含まれます。ボタンの処理は説明用で、ゲーム内のクリックが自動的に届くわけではありません。`InventoryLink.moveTo()` によるアイテム移動は未実装です。

## 型の確認

`npm run build` の対象は `src/**/*.ts` のみです。`examples/` のスケッチは CI や通常ビルドでは検査しません。型を手動確認する場合は、まず `npm ci` と `npm run build` を実行し、リポジトリ直下に一時ファイル `tsconfig.examples-check.tmp.json` を作ります。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "paths": { "invui-bedrock": ["./dist/index.d.ts"] },
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "files": ["examples/usage-sketch.ts"]
}
```

```bash
npx tsc -p tsconfig.examples-check.tmp.json
```

型検査は API の名前と型を確認するものです。ゲーム内の表示・入力・安全性は確認できません。

詳しい制約は [実装状況と制約](../docs/status.md)、設計との対応は [全体設計書](../docs/design.md) を参照してください。
