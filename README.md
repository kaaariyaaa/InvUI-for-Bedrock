# InvUI for Bedrock

Java版 [InvUI](https://github.com/NichtStudioCode/InvUI) の設計と公開 API をできるだけ維持した、Minecraft Bedrock Edition 向け GUI ライブラリです。

> [!WARNING]
> **ベータ / 実機未検証**
>
> - バージョンは `0.1.0-beta.1`。**npm には未公開**です。`npm install invui-bedrock` はまだ使えません。
> - **実機では一切検証していません。** ライブラリ経由の実機画面表示は現状すべて拒否され、実機ライフサイクル（close・死亡・退出・shutdown）と入力ブリッジは未実装です。クリック通知、アイテム保護、JSON UI 連携、`InventoryLink` のアイテム移動も未実装または未検証です。
> - **`Window.open()` は安全のため既定で拒否されます。** 画面のアイテム保護とクリック処理が実機未検証のため、実アダプタ（`minecraftVirtualContainerAdapter`）は `canOpenScreens = false` を返し、`open()` は `WindowOpenRejectedError` を投げます。Container の作成・表示より前に拒否されます。`openContainer()` / `closeContainer()` も同じ例外を投げます。
> - コア（レイアウト計算、アイテム表現、状態管理、Window の状態遷移）は実装・Node.js テスト済みですが、**差分描画、周期更新、永続ストアの schema migration・復旧は未完成**です。クリック入力を実機イベントへつなぐ仕組み、JSON UI テンプレート、Resource Pack は同梱していません。
> - この README は、実装済みの範囲と未完成・未検証の機能を区別して記載します。未検証の機能を「完成・動作確認済み」として扱わないでください。

## 現在の状態

| 項目 | 状態 |
|---|---|
| コア（`src/`） | **実装済み（実機非依存の範囲）**。`Structure` / `Gui`（normal・paged・scroll・tab）/ `GuiLink` / `Item` / `VirtualInventory` / `StateManager` / `Window`。ただし「[コアの未完成点](#コアの未完成点実コードで確認)」に挙げた項目は未完成 |
| ビルド（`npm run build`） | 成功する（Node 24.22.1 で確認）。TypeScript で `dist/` に ESM と `.d.ts` を出力 |
| 自動テスト（`npm test`） | 成功する（Node 24.22.1 で 95 件）。Node.js のユニットテスト・CLI の安全側テスト・パッケージ境界の検査 |
| 実機テスト | **未実施** |
| 実機画面の表示 | **全拒否**。実アダプタは `canOpenScreens = false` で、`Window.open()` は Container 作成前に `WindowOpenRejectedError` |
| 実機ライフサイクル（close・死亡・退出・shutdown・再読み込み） | **未実装**。`virtualContainerClose` 等の実機イベントを購読していない |
| 入力ブリッジ | **未実装**。JSON UI テンプレートもない |
| クリック通知・アイテム保護・JSON UI 連携 | **未実装** |
| 差分描画 | **未実装**。`refresh()` は毎回全スロットを再描画する |
| 周期更新（`updatePeriodically()`） | **未実装**。tick 値を保持するだけで、スケジューラに接続していない |
| 永続ストアの schema migration・復旧 | **未実装**。version/schema 不一致は拒否、破損は例外。移行・退避・復旧用の API はない |
| `InventoryLink` のアイテム移動 | **無効固定**。`moveTo()` は常に `InventoryLinkMoveRejectedError` を投げる |
| `Window.open()` | **既定拒否**。`WindowOpenRejectedError` を投げる |
| 配布補助 CLI（[bin/cli.js](bin/cli.js)） | 実装済み。読み取り専用の静的検査のみ |
| CLI の自動テスト（[cli.test.mjs](tests/manual-bedrock/cli.test.mjs)） | 実行可能（`npm test` に含まれる） |
| 実機テスト手順（[tests/manual-bedrock/README.md](tests/manual-bedrock/README.md)） | あり |
| 合否チェックリスト（[CHECKLIST.md](tests/manual-bedrock/CHECKLIST.md)） | あり |
| 利用イメージ（[examples/README.md](examples/README.md)） | 設計スケッチのみ。コンパイル・実行の対象外 |
| 全体設計（[設計書](InvUI_for_Bedrock_Design.md)） | あり（バージョン 1.2） |
| JSON UI テンプレート（`resource_pack/`） | 未提供（未検証のため意図的に同梱しない） |
| npm 公開 | 未実施 |
| ライセンス | 未設定 |

## コアの実装範囲（実機非依存）

実機に依存しない範囲は実装され、Node.js 上で `@minecraft/server` をモックしてテストされています。Bedrock 実機での動作を保証するものではありません。

- **レイアウト**: `Structure`（最大 9×6、Unicode 1 コードポイント = 1 スロット）、`Gui.normal()` / `Gui.paged()` / `Gui.scroll()` / `Gui.tab()`、`Markers.CONTENT_LIST_SLOT_HORIZONTAL` / `VERTICAL`、`GuiLink` による子 GUI の投影。ページ・行・タブは `GuiState` として外から渡し、GUI インスタンス自身は状態を持ちません。
- **アイテム**: `Item`、`ItemBuilder`、`Item.simple()`、`Item.builder()`、クリックハンドラーの登録と呼び出し順序。クリックを実機イベントから届ける仕組み（InputBridge / JSON UI）は未実装です。`updatePeriodically(ticks)` は tick 値を保持して `getUpdatePeriod()` で返すだけで、**周期実行するスケジューラには接続していません**。
- **インベントリ**: メモリ上の `VirtualInventory`（`Inventory` インターフェース実装）。`InventoryLink` はリンク先スロットの読み書きと購読のみ提供し、**別インベントリへの移動は実装していません**。
- **状態**: `StateManager`。`player` / `shared` のスコープ、`window` / `session` / `persistent` の保存期間、スキーマ不一致の拒否。永続化には注入した `StateStore` が必要です。**永続データは version/schema 不一致を検出して拒否し、破損時は `StateCorruptionError` を投げてレコードを残すところまでで、旧 schema からの移行、破損レコードの退避・復旧、`StateManager` からの削除、Bedrock 用 `StateStore` 実装はありません。**
- **Window**: `Window.builder()` の設定、状態の取得・更新、`close()`、クリックのルーティング（`Window.handleClick()`）まで。**画面を開く経路は未検証のため既定で拒否されます。** また、`virtualContainerClose` などの実機イベントは購読しておらず、`close(reason)` の `reason` は呼び出し側が渡す値です。死亡・退出・shutdown・スクリプト再読み込み時の後始末や再オープンは実装していません。

## コアの未完成点（実コードで確認）

「コア実装済み」は実機非依存の計算・状態遷移までを指します。次の項目は未完成です。

- **実機画面**: 実アダプタは `canOpenScreens = false` を返すため、`Window.open()` は状態取得・Container 作成より前に `WindowOpenRejectedError` で失敗します。`openContainer()` / `closeContainer()` も例外を投げます。ライブラリから実機で画面を表示する経路はありません。
- **実機ライフサイクル**: `world.afterEvents.virtualContainerClose` / `virtualContainerItemChange` / `system.beforeEvents.shutdown` などを購読していません。`Window` の `status` 遷移、状態ハンドルの解放、`close()` の明示呼び出しはありますが、ゲーム側の close・死亡・退出・shutdown・再読み込みに接続していません。
- **入力**: `Window.handleClick(slot)` は呼び出し側が論理スロットを直接渡す API です。Bedrock のイベントからスロットを特定して呼ぶ経路（InputBridge / JSON UI / `button.send`）はなく、左右・Shift・ダブルクリックの区別もありません。
- **差分描画**: `Window.refresh()` は `#renderAll()` で全スロットを順に `container.setItem()` します。前回との差分計算はなく、Window の更新は全スロット再描画です。要素の更新通知で該当スロットだけ再解決する経路はありますが、GUI 全体の差分描画ではありません。レイアウトサイズが変わった場合は再オープンが必要で、`refresh()` はエラーを報告するだけです。
- **周期更新**: `Item.updatePeriodically()` は tick 値を保存するだけで、`system.runInterval()` などのスケジューラを登録しません。`Window` も周期更新を開始しないため、時間経過で自動再描画はされません。
- **永続ストア**: `StateManager` は注入された同期 `StateStore` に JSON を読み書きします。`STATE_STORAGE_VERSION` と schema の不一致は `StateConflictError`、壊れた JSON や不正な `guiState` は `StateCorruptionError` で失敗し、レコードは変更しません。**旧 version/schema を変換する migration、破損レコードを退避して復旧する処理、StateManager からレコードを削除する処理は実装していません。** schema は Window では GUI 種別と Structure 行の文字列から作る簡易な識別子です。

## 必要環境

- **Node.js 24.22.1**（direnv の `flake.nix` が提供する `nodejs_24` で確認済み）
  - `.envrc` の `use flake` により、このリポジトリの direnv 環境は `flake.nix` の `nodejs_24` を提供します。その Node 24.22.1 で `npm test`（95 件）と `npm run build` が成功することを確認済みです。
  - テストは TypeScript の `.ts` を直接読み込みます。型ストリッピングが既定で有効な Node.js 23.6 以降が必要です（22.6〜23.5 では `--experimental-strip-types` が必要）。
- **Minecraft Bedrock Edition** の Preview/Beta と `@minecraft/server` Experimental（実機は未検証）
- **`@minecraft/server` の型は `2.13.0-beta.1.26.70-preview.24` に完全固定**（`devDependencies` / `peerDependencies` とも exact 指定）。`peerDependencies` は範囲ではなく exact です。
- **npm の `@minecraft/server` は型定義（`index.d.ts`）だけで、実行時 JS を含みません。** Node.js から直接 `import "@minecraft/server"` すると `ERR_MODULE_NOT_FOUND` になります。自動テストは `node:module` の `registerHooks` で `ItemStack` と `world.virtualContainerManager` の最小モックに差し替えています。したがって Node.js 上でコアを直接読み込むには、テストと同様のモック（または同等のスタブ）が必須です。実機ではゲーム本体がこのモジュールを提供します。
- Minecraft 本体の対応バージョンは**未確定**です。`@minecraft/server` の型バージョンと、実際に動くゲーム版は別物なので、実機で確認した組み合わせだけを記録してください。

## 導入・ビルド・テスト

npm 未公開のため、現時点ではリポジトリを取得してビルドします。

```bash
npm install
npm run build   # tsc -p tsconfig.json -> dist/（ESM + .d.ts）
npm test        # node --test（ユニットテスト + CLI の安全側テスト）
```

- ビルド成果物は `dist/index.js` と `dist/index.d.ts` です。`dist/` は git 管理外です。
- パッケージとして試す場合は `npm pack` で tarball を作り、アドオンのプロジェクトへローカル導入してください（`prepack` でビルドされます）。
- アドオンへ組み込むときは、`@minecraft/server` をバンドルに含めず外部化してください（`peerDependencies` として扱います）。例:

```bash
npx esbuild src/main.ts \
  --bundle \
  --format=esm \
  --platform=neutral \
  --external:@minecraft/server \
  --outfile=behavior_pack/scripts/main.js
```

- `manifest.json` の依存バージョンは、実際に確認したゲーム版・`@minecraft/server` 版に合わせてください。
- `npm test` は `@minecraft/server` をテスト内の最小モック（`ItemStack`、`world.virtualContainerManager.create` など）に差し替えます。モックは実機の挙動を再現しないため、テストが通っても実機の画面表示・入力・アイテム保護の検証にはなりません。
- `npm test` に実機テストは含まれません。クリック・アイテム保護・JSON UI の検証は [tests/manual-bedrock/](tests/manual-bedrock/README.md) の手順で行います。

## CLI（配布補助・読み取り専用の検査）

CLI は Behavior Pack / Resource Pack を**変更しません**。JSON UI の生成やマージも行いません。`package.json` の `bin` には登録されていますが、npm 未公開のため現時点ではリポジトリ内で直接実行します。

```bash
node bin/cli.js init \
  --behavior-pack ./behavior_pack \
  --resource-pack ./resource_pack
```

### コマンドとオプション

| 指定 | 内容 |
|---|---|
| `init` | Behavior Pack / Resource Pack を読み取り専用で検査し、手動で必要な作業を表示する |
| `--behavior-pack <dir>` | Behavior Pack のルート |
| `--resource-pack <dir>` | Resource Pack のルート |
| `--json` | 検査結果を JSON として標準出力へ出す |
| `-h`, `--help` | 使い方を表示する |
| `-v`, `--version` | バージョンを表示する |

`check` は設計書にある将来案であり、まだ仕様確定していません。CLI が受け付けるコマンドは `init` だけで、それ以外は不明なコマンドとして失敗します。現時点では `init` が静的検査を読み取り専用で行います。

### CLI が行うこと

- `manifest.json` の存在と JSON としての読み込みを検査する。
- Behavior Pack の script モジュール、`entry` の有無、`@minecraft/server` への dependency を確認する。
- Resource Pack の `ui/` ディレクトリと、既存の `chest_screen.json` / `invui.json` / `_ui_defs.json` の有無を報告する。
- 未検証機能と、手動で確認すべき手順を表示する。
- `--json` 指定時は、検査結果を JSON として標準出力へ出す。

### CLI が行わないこと

- **JSON UI を生成しない。** クリック通知とアイテム保護の方式が実機未検証のため、危険な UI ファイルを自動配置しません。
- **既存の `chest_screen.json` を上書きしない。** 競合を検出した場合は報告だけ行います。
- **`_ui_defs.json` を変更しない。** 参照追加は手動マージの対象です。
- **Behavior Pack / Resource Pack 内へ一切書き込まない。**
- **バックアップや復元を自動化しない。** UI を手動マージする場合は、利用者がバックアップを取ってください。

### 終了コード

| コード | 意味 |
|---|---|
| `0` | 検査完了（警告のみを含む） |
| `1` | 引数エラー、または検査エラー |

## 実機テスト

未検証機能を「提供済み」にしないため、実機テストの手順と合否基準を用意しています。

- 手順と安全上の注意: [tests/manual-bedrock/README.md](tests/manual-bedrock/README.md)
- 合否チェックリスト: [tests/manual-bedrock/CHECKLIST.md](tests/manual-bedrock/CHECKLIST.md)

CLI の安全側の動作は、次のコマンドで自動確認できます（`npm test` にも含まれます）。

```bash
node --test tests/manual-bedrock/cli.test.mjs
```

このテストは、CLI がパックを変更しないこと、壊れた manifest で失敗することなどを確認します。実機の入力・表示・アイテム安全試験の代わりにはなりません。

### 実機検証が終わるまで利用できない機能

| 機能 | 現状 | 扱い |
|---|---|---|
| `Window.open()` による画面表示 | 実装は既定拒否・実機未検証 | 実アダプタでは常に `WindowOpenRejectedError`。テスト用アダプタを注入しない限り開かない |
| クリック通知（`button.send` → チャット候補を含む） | 実装なし・実機未検証 | 安全に利用不可。有効な機能として案内しない |
| 表示専用・ボタン用スロットのアイテム保護 | 実装なし・実機未検証 | 安全に利用不可。アイテム移動を許可しない |
| JSON UI による入力抑制・画面識別 | テンプレート未提供・実機未検証 | 配布しない。通常チェストへの影響も未確認 |
| `InventoryLink` のアイテム移動 | 実装なし。`moveTo()` は常に例外 | 複製・消失の可能性を排除できないため無効 |
| 左・右・Shift・ダブルクリックの区別 | 初期リリース非目標 | 通常クリックのみを設計対象とする |

設計書の合格条件（InvUI 画面だけに適用される、通常チェストが壊れない、表示アイテムを持ち出せない、通知が 1 回だけ届く、通知からプレイヤーとスロットを特定できる、アイテムが消失・複製しない、PC・タッチ・コントローラーで成立する、終了後の遅延入力が処理されない）を満たすまで、クリック機能を正式機能として公開しません。

## Resource Pack がない場合

コアの型・レイアウト計算・状態管理は Resource Pack なしで利用できます（Node.js 上で `@minecraft/server` をモックしたテストで確認済み）。ただしクリック入力を必要とする Window は動作しません。実機では `Window.open()` 自体が拒否されるため、Resource Pack の有無にかかわらず画面は開きません。

## 設計上の前提（実機未検証）

以下は設計書の方針です。実機で確認されるまで動作保証として読み替えないでください。

- `VirtualContainer` は Bedrock Preview/Beta の Experimental API で、メモリ上のコンテナであり、ワールドに保存されない。
- `size` と `title` は生成後に変更できないため、変更時は画面を開き直す。
- スクリプト再読み込み時に画面は閉じ、通常の終了イベントに依存した永続化はできない。
- 状態の共有範囲は `player` / `shared`、保存期間は `window` / `session` / `persistent`。
- 更新は影響を受けたスロットの差分反映を原則とする（**未実装。現状の `Window.refresh()` は全スロット再描画**）。
- JSON UI の変更は必要最低限とし、通常チェストへの影響を避ける。
- `@bedrock-core/ui` には依存しない。

## ディレクトリ構成（現時点）

```text
InvUI-for-Bedrock/
├── package.json                  # 0.1.0-beta.1 / ESM / build・test・pack scripts
├── tsconfig.json
├── bin/
│   └── cli.js                    # 配布補助 CLI（読み取り専用の検査）
├── src/
│   ├── index.ts                  # 公開エントリ
│   ├── gui.ts                    # Structure / Gui / GuiLink / レイアウト計算
│   ├── item.ts                   # Item / ItemBuilder / クリックハンドラー
│   ├── inventory.ts              # VirtualInventory / InventoryLink（移動は拒否）
│   ├── state.ts                  # StateManager（scope / lifetime / 永続化）
│   └── window.ts                 # Window（open は既定拒否）
├── dist/                         # ビルド成果物（ESM + .d.ts、git 管理外）
├── tests/
│   ├── gui.test.mjs
│   ├── item-inventory.test.mjs
│   ├── state.test.mjs
│   ├── window.test.mjs           # Window と実アダプタの拒否経路
│   ├── package.test.mjs          # パッケージ境界の検査
│   └── manual-bedrock/
│       ├── README.md             # 実機テスト手順
│       ├── CHECKLIST.md          # 合否チェックリスト
│       ├── API-NOTES.md          # VirtualContainer の型・ドキュメント調査
│       └── cli.test.mjs          # CLI の自動テスト
├── examples/
│   ├── README.md
│   └── usage-sketch.ts           # 設計上の利用イメージ（実行不可）
└── InvUI_for_Bedrock_Design.md   # 全体設計書
```

`resource_pack/` と `LICENSE` はまだありません。`examples/usage-sketch.ts` は現行コアの公開型にほぼ一致するスケッチですが、ビルド・実行の対象外で、実アダプタでは `Window.open()` が拒否されます。詳細は [examples/README.md](examples/README.md) を参照してください。

## 対応バージョン

| 対象 | バージョン | 状態 |
|---|---|---|
| ライブラリ | `0.1.0-beta.1` | npm 未公開 |
| `@minecraft/server`（型・開発時） | `2.13.0-beta.1.26.70-preview.24`（固定） | ビルド・テストで使用 |
| `@minecraft/server`（peer） | `2.13.0-beta.1.26.70-preview.24`（exact） | 実機未検証 |
| Minecraft Bedrock Edition | 未確定 | 実機テストで確認した組み合わせのみ記録する |

CLI は manifest からゲーム版・Experimental の有効状態を確定できません。実機テストの記録欄に、実際に使用した版を残してください。

## ライセンス

未設定です。配布前に決定する必要があります。

## 参考

- [設計書](InvUI_for_Bedrock_Design.md)
- [Java版 InvUI](https://github.com/NichtStudioCode/InvUI)
- [Minecraft Creator ドキュメント（Script API）](https://learn.microsoft.com/minecraft/creator/scriptapi/)
