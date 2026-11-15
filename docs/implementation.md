# 実装の詳細

表示・状態・インベントリ処理の説明です。実機での安全性については [実装状況と制約](status.md) を参照してください。

## 差分描画の限界（状態更新）

状態更新では、前回描画したレイアウトと解決後のレイアウトを比較し、変更されたスロットだけを描きます。ただし「要素インスタンスが同じ」だけでは同値の証明になりません。Item の provider は `Window.getState()` を読んで表示を変えられるため、要素が同じスロットも、provider の入力が状態に依存しないと証明できる場合だけスキップします。

- **スキップできる要素**: 固定 `ItemStack` と `ItemBuilder` を provider に持つ Item は Window も state も受け取らないため、状態だけが変わった再描画では再評価しません。`InventoryLink` も state ではなくインベントリの通知で更新されるためスキップします。provider が関数または独自 `ItemProvider` の Item は state を読めるため、要素が同じでも再評価します。Bedrock の `ItemStack` を全 component まで比較して同値判定はしません。**provider が viewer と Window の state 以外（`window.upperGui` や外部の可変データなど）を読む場合や、`ItemBuilder` / 元の `ItemStack` を Item 作成後に変更する場合は、その変更後に `notifyWindows()` を呼んでください。**
- **全スロット再評価の経路**: GUI の内容変更（`setContent` など）と明示 `refresh()` は、要素参照が変わっていなくても全スロットの provider を再評価します。内容変更はレイアウト自体が変わるため、明示 `refresh()` は外部の可変データも読み直す強制描画として残しています。
- **同じサイズの `setUpperGui()`**: Container サイズと state schema が同じ GUI 差し替えでは、要素が変わったスロットと直前の `setItem()` に失敗したスロットだけを再評価します（設計 8.4 の差分更新）。この経路では Window の状態を変えないため（クランプが必要な場合は全スロット描画に回します）、要素が同じスロットは provider の入力も同じです。
- **コスト**: 状態を 1 回変えるたびに、要素が変わったスロット・状態に依存し得る Item・通知されたスロットの provider 呼び出しと `container.setItem()` が走ります。固定 `ItemStack` / `ItemBuilder` と `InventoryLink` だけの GUI では、ページ・タブ切替の書き込みが実際に変わったスロットに限定されます。provider は対象スロット分を同期的に開始して並列に解決するため、1 つの遅い provider が他の開始をブロックすることはありませんが、そのバッチ全体の完了は待ちます。
- **古い非同期結果**: 状態変更・GUI の内容変更・新しい描画バッチのたびに render epoch を進め、スロットごとの token と generation も検査します。変更前に開始した provider の結果は、後から解決しても書き込まれません。状態更新でスキップする要素は固定 `ItemStack` / `ItemBuilder` と `InventoryLink` だけで、いずれも同期的に解決するため、スキップによって失われる実行中の非同期結果はありません。同じサイズの `setUpperGui()` の差分描画は、変わっていないスロットの実行中 provider 結果をそのスロットのものとして有効に残すため epoch を進めません（変更したスロットは token で無効化します）。
- **要素の更新通知**: `Item.notifyWindows()` や `InventoryLink` の変更通知は、購読しているスロットだけを再描画します。レイアウト変更時は新しいレイアウトに購読を張り替えてから描画するため、移動先のスロットへ通知が届きます。
- **通知のバッチ**: 状態更新・GUI 変更は 1 つの microtask にまとめ、要素の更新通知はスロット単位で同じ flush に合流させます（設計 11.2 step 3 / 11.5）。同じタイミングの複数通知は 1 回の描画になり、full refresh が予約されていれば予約済みのスロット通知はそれに吸収されます。スロット通知は予約時点で描画 token を進めるため、flush 前に解決した古い provider 結果は書き込まれません。close・再オープン・明示 `refresh()` は予約を破棄します。microtask には `queueMicrotask` ではなく `Promise.then` を使います（Bedrock のスクリプト環境で `queueMicrotask` が常にあるとは限らないため）。
- **レイアウトサイズの変更**: 表示中の Window では `refresh()` がエラーを報告するだけで、サイズは変わりません。再オープンが必要です。`open()` の解決中にサイズが変わった場合は、画面を表示する前に Container を作り直します。
- **空→空の書き込み省略**: 直前に自分で空を書いた物理スロットを、次の描画でも空にする場合だけ `setItem()` をスキップします（`SlotWriteCache`）。記録は `setItem()` が例外を投げずに返った後だけ行い、失敗した書き込みは失敗として記録して次の描画（同じサイズの `setUpperGui()` の差分描画を含む）で再試行します。キャッシュは Container の作成（`open()` 中のサイズ変更を含む）で新しくなり、close の後始末と Container の差し替えで破棄されます。古い描画結果・古い generation・レイアウト変更後の結果は書き込み自体が破棄されるため、キャッシュにも記録されません。全スロット描画と差分描画の対象スロットでは空でない値の書き込みを決してスキップしないので、表示アイテムが出ない・消えることはありません。`setUpperGui()` の後も物理スロットの実際の内容についての記録として有効です。
- **書き込みキャッシュの前提と限界**: キャッシュは「その Container に書くのはこの Window だけ」という前提で、空→空の書き込みだけを省きます。そのため、itemChange を転送しないアダプタ（`subscribeItemChange` 未実装）や `window.container` を直接書き換える外部コードがあると、本来空にするスロットに外部のアイテムが残る可能性があります（表示のずれであり、この省略によるアイテムの消失・複製はありません）。自分の player の itemChange は再描画停止と close でキャッシュを破棄し、別 player の itemChange（この Window は無視して描画を続ける）ではキャッシュ全体を破棄します。実機未検証です。

## 開いている Window の GUI 差し替えと非同期プレースホルダー

`Window.setUpperGui(gui)` は、開いている Window の upper GUI を、同じ Container サイズなら既存の Container と画面を維持したまま差し替えます。差し替え後はレイアウトを再評価し、要素が変わったスロット（と直前の書き込みに失敗したスロット）だけを描画して、旧 GUI と旧要素の購読を新 GUI に張り替えます。サイズが違う場合は既存の Container を維持できないため、再生成キューで新しい Container を作って全スロットを描画してから旧画面を閉じて開き直します（`setTitle()` と同じ内部再生成で、open/close ハンドラーは再実行しません）。閉じている・まだ開いていない Window では、次回の `open()` に使う GUI を置き換えるだけです。

- **同じ Container サイズ・同じ state schema**: その場で差し替えます。要素が変わったスロットと、直前の `setItem()` に失敗したスロットだけを Provider から再評価して描画し、変わっていないスロットの表示と購読は維持します（設計 8.4 の差分更新）。同じスロットの同じ Item は viewer と Window の状態が同じなら同じ結果になる、という前提です（provider がそれ以外を読む場合は `notifyWindows()` を呼んでください）。schema の同一性は、GUI 種別・Structure 行・スクロール設定・タブ・`GuiLink` の子 GUI を再帰的に含む識別子で判定します。Structure 行が同じなら幅・高さも同じなので、論理スロットの物理位置は変わりません。
- **サイズが違う**: Container の `size` は生成後に変更できないため、再生成キューへ積んで新しい Container を作成・描画してから旧画面を閉じ、新しい画面を開きます（設計 8.4。`operation: "guiChange"`）。キューの順番が来た時点で再解決し、先行した state/title の再生成でサイズが一致していれば Container を作り直さずに差し替えます。また、より新しい `setUpperGui()` が呼ばれていた場合は古い候補を破棄します。Container の作成・描画に失敗した場合は ErrorHandler へ報告し、**現在の GUI・Container・画面を維持**し、この Window だけが持っていた `window` 期間の state を新しい登録の初期値として復元します。
- **サイズ変更に伴う state schema の再登録**: Structure 行が変わるため、サイズ変更は必ず state schema も変えます。Window は新しい Container を表示する前に、同じ identity（scope・key・ownerId）で state を新しい schema に再登録します。再登録できるかは `StateManager` の既存ルールが決めます。同じキーを別の Window が使用中、`session` の登録が残っている、`persistent` の登録がある場合は `SCHEMA_MISMATCH` で拒否され、**現在の GUI・画面・state をそのまま維持**してエラーハンドラーへ報告します（保存レコードは書き換えません。宣言型 migration は生きた登録がある状態では実行されません）。再登録が成功した場合、state の page・line・tab・selection・data は新しい schema の初期値として引き継がれ、新しいレイアウトの範囲外になった値はクランプされます。`state.tab` の切替などで Container サイズだけが変わる場合は schema が変わらないため、state はそのまま維持されます（下記）。
- **state schema が違う**: 取得済みの state が新しい GUI の形を説明しなくなるため、`WindowStateSchemaChangedError`（`INVUI_STATE_SCHEMA_CHANGED`）を報告して再描画を停止し、close します（fail closed）。GUI の構造変更と同じ経路です。
- **レイアウトの Container サイズが変わる（別サイズのタブへの切替など）**: `refresh()`・状態変更・GUI 変更の再評価で Container の `size` が変わった場合、`setTitle()` と同じ経路で新しい Container を生成して全スロットを描画してから旧画面を閉じ、新しい画面を開きます。state・購読と open/close ハンドラーは維持し、生成に失敗した場合は `operation: "resize"` として報告して現在の Container・画面を維持します。幅だけが変わって Container サイズが同じ場合は Container を維持したまま再描画し、旧レイアウトが使っていた 9 列のうち新しい幅の外側の列を空にします。

```ts
window.setUpperGui(nextGui); // 同じサイズなら即時、サイズ違いは内部再生成（schema 再登録の成否に依存）
```

`Item.setPlaceholder(stack)` と builder の `.setPlaceholder(stack)` は、非同期 provider が解決するまでの間に表示する `ItemStack` を設定します。設定値は clone して保持し、`undefined` で解除します。`getPlaceholder()` はコピーを返します。

- provider が同期のときは使われません。
- **placeholder 未指定**: 従来どおり、`open()`・`refresh()`・再描画は provider の promise 解決まで待ちます。入力ゲートも解決してスロットが書かれるまで closed のままです。
- **placeholder 指定あり**: promise を待たずに placeholder を表示し、解決後に同じスロットを最終結果で更新します。`open()` は待たされません。placeholder を書いたスロットは描画済みとして扱い、他のスロットの描画が完了すると入力ゲートが開きます（未解決の最終結果は後から同じスロットを上書きします）。解決が遅れて close・再描画・レイアウト変更・同じスロットの新しい解決が起きた場合、古い結果は書き込まずに破棄します。解決に失敗した場合は placeholder を含む直前の表示を残し、エラーハンドラーへ `itemProvider` として報告します。
- builder では `Item.builder().setItemProvider(...).setPlaceholder(stack).build()` のように指定できます。

```ts
const loading = new ItemBuilder("minecraft:clock").setName("読み込み中").build();

const item = Item.builder()
  .setItemProvider(async (viewer) => await fetchIcon(viewer))
  .setPlaceholder(loading)
  .build();

item.setPlaceholder(undefined); // 解除
```

`setUpperGui()` の差し替えと placeholder はどちらも Node.js 上で確認済みですが実機未検証です。**実機のアイテム保護・操作制限ではありません。** placeholder は非同期解決中の見た目を変えるだけで、プレイヤーの取り出しや変更を防ぎません。

## 永続状態の移行と Bedrock ストア（任意）

永続状態を使う場合、通常は `Window` の既定 `StateManager` がワールドの動的プロパティを `BedrockWorldStateStore` 経由で自動使用します（実機未検証）。独自のストアや `migrations` / `quarantineCorrupt` / `onError` を使う場合は、同期の `StateStore` を注入した `StateManager` を作り、`WindowBuilder.setStateManager()` で渡します。`BedrockWorldStateStore` は、ワールドの動的プロパティを 1 レコード 1 プロパティとして使います。どちらも `src/index.ts` から公開されています。動的プロパティを持たない環境（モックなど）では既定マネージャーはストアなしのままなので、`persistent` には `setStateManager()` での注入が必要です。

```ts
import { world } from "@minecraft/server";
import { BedrockWorldStateStore, StateManager } from "invui-bedrock";

const states = new StateManager(new BedrockWorldStateStore(world));

states.migrate(
  {
    ownerId: player.id,
    key: "shop",
    // 対象レコードの保存値に合わせる。旧形式の schema なしレコードは null。
    fromVersion: 0,
    fromSchema: null,
    schema: "shop-v2",
  },
  (legacy) => {
    const old = legacy as { guiState?: { pageNo?: number } };
    return { page: old.guiState?.pageNo ?? 0 };
  },
);
```

`StateManager.migrate(options, migrate)` の前提と制約:

- 注入した `StateStore` が必要です。対象は永続化済みレコードだけで、存在しなければ `MISSING_STATE` で失敗します。
- `fromVersion` / `fromSchema` / `schema` は必須です。`fromVersion` と `fromSchema` は保存済みレコードの version/schema と完全一致しなければ `VERSION_MISMATCH` / `SCHEMA_MISMATCH` で拒否され、`schema` は移行後のレコードに記録されます。すでに現在の version/schema と同じ組み合わせは「移行不要」として拒否されます。`fromSchema: null` は schema を持たない古い形式を表します。設計 9.6 形式（`lifetime` / `schema` を持たない）レコードは、`migrate()` と `acquire()` の両方で「保存期間 `persistent`・schema なし」として読むため、`acquire()` に既定の schema（`"default"`）を渡すと（version が現行なら）`SCHEMA_MISMATCH` になり、`fromSchema: null` の自動移行（`schema` は取得時の値）を宣言した場合だけ救済されます。`fromVersion` は保存値と一致させてください。明示的に `lifetime` / `schema` を持つレコードは従来どおり完全一致が必要です。
- `acquire()` の前、または同じ identity のハンドルをすべて `release()` した後に呼びます。表示中の状態や、`persistent` 以外で登録中の identity は `LIVE_STATE` で拒否されます。
- **migration 実行中の同一 identity は再入できません。** コールバックとストア書き込みの間、その identity の `acquire()` と `migrate()` は `LIVE_STATE` の `StateConflictError` で失敗します。他の identity は影響を受けません。コールバックが例外を投げてもロックは解放されます。
- コールバックにはデコード済みの旧レコードがそのまま渡されます。戻り値は現在の `GuiState` として検証・複製され、`STATE_STORAGE_VERSION` と指定した schema で上書き保存されます。
- コールバックまたは検証が失敗した場合、`StateManager` はストアに書き込みません。ストア書き込みの失敗時はロールバックされず、結果はストアの実装に依存します（次項参照）。失敗前に解放済みのメモリ上の entry は破棄されるため、次回の `acquire()` はストアから読み直します。壊れた JSON はコールバックに渡さず `StateCorruptionError` で失敗します。
- **永続化の保存失敗は握りつぶしません。** `acquire()` の初回保存、`set()` の保存、自動移行・明示移行の書き込みがストアで失敗すると、`StateManager` は `onError`（未指定ならログ）へ通知したうえで同じエラーを投げます。状態はコミットされず、直前まで正常に保存されたレコードが残るため、ストア復旧後に同じ変更を再試行でき、再読み込みではそのレコードが復元されます。`Window` の `open()` / クリック / 再描画経由の失敗は Window のエラーハンドラーにも報告されます（`setState()` を直接呼んだ場合の失敗は呼び出し側へ投げられ、状態マネージャーの `onError` に届きます）。
- **注入した外部 `StateStore` の失敗時の状態は、その実装の原子性に依存します。** `StateManager` は 1 レコードにつき `setItem()` を 1 回だけ呼び、失敗したときに再試行・ロールバック・部分書き込みの検出を行いません。したがって、`setItem()` が途中で失敗して値を部分的に残すストア実装では、**部分的な書き込みが残る可能性があります**。`BedrockWorldStateStore` は 1 つの動的プロパティへの単一 `setDynamicProperty()` 呼び出しですが、エンジン側で失敗したときに書き込みが残らないかは実機未検証です。
- 自動移行は、`StateManager` の `migrations` に宣言したものだけを `acquire()` が適用します。宣言は identity・`fromVersion`・`fromSchema`・移行後 `schema` の完全一致が必要で、対象は `persistent` レコードだけです。宣言のない version/schema 不一致は従来どおり `StateConflictError` で拒否します。設計 9.6 形式（`lifetime` / `schema` なし）のレコードは `persistent`・schema なしとして読むため、`fromSchema: null` の宣言が一致します。破損レコード（デコード不能な JSON、不正な `guiState`）の自動退避・復旧は `StateManager` の `quarantineCorrupt: true` を指定した場合だけ `acquire()` が行い、version/schema 不一致は対象外です。

```ts
const states = new StateManager(store, {
  migrations: [
    {
      ownerId: player.id,
      key: "shop",
      fromVersion: 0,
      fromSchema: null, // schema なしの旧形式
      schema: "shop-v2",
      migrate: (legacy) => ({ page: (legacy as any).guiState?.pageNo ?? 0 }),
    },
  ],
});

// acquire() が一致する旧レコードを検証後に 1 回だけ書き換え、その状態で再開する。
const state = states.acquire({
  ownerId: player.id,
  key: "shop",
  lifetime: "persistent",
  schema: "shop-v2",
});
```

自動移行の制約:

- 一致する宣言が複数ある組み合わせは、`StateManager` の生成時に `StateValidationError` で拒否されます。
- コールバックの例外・戻り値の検証失敗ではレコードを変更しません。コールバックは `StateManager.migrate()` と同じ identity ロックの下で実行され、再入 `acquire()` / `migrate()` / `remove()` は `LIVE_STATE` で失敗します。
- ストア書き込みの失敗はロールバックされません（次項参照）。

```ts
const states = new StateManager(store, {
  quarantineCorrupt: true, // 壊れた生値を ...:quarantine に退避して initial から再開
  onError: (error) => console.warn("InvUI state recovery", error),
});
```

退避は元キーの `...:quarantine`、使用済みなら `...:quarantine:2`、`...:quarantine:3` と空きキーへ行い、元キーを削除してから `initial` を保存します。退避の書き込みに失敗した場合は元レコードを残したままストアのエラーを投げ、復旧は行いません。
- `StateManager.remove({ scope?, key?, ownerId? })` で、その identity の永続レコードを削除できます。壊れた JSON や schema 不一致で `acquire()` が拒否するレコードを、初期状態からやり直すための明示操作です。格納値はデコード・検証せずに削除し、レコードが存在しなくてもエラーになりません。注入した `StateStore` が必要です。ハンドルが残っている状態、`persistent` 以外で登録中の identity、migration 実行中の identity は `LIVE_STATE` で拒否されます。ゼロハンドルの `persistent` entry は削除前に破棄されるため、`removeItem()` が失敗しても次回の `acquire()` はストアから読み直します。
- Window の state schema は GUI 種別・Structure 行・スクロール設定・タブ・`GuiLink` の子 GUI を再帰的に含む JSON 文字列から作る識別子です。Window を開いた後にこの構造が変わると、その Window は `WindowStateSchemaChangedError` を報告して close し、古い schema で新しい状態を保存しません。古い schema token のレコードは、一致する自動移行を宣言していない限り自動変換されず、移行する場合は `migrations` か `fromSchema` にその文字列を指定します。
- `BedrockWorldStateStore` は、キーを `%:` の世代 prefix に続けて固定幅の `%XXXX` 形式でエンコードした動的プロパティ識別子を使います（安全な ASCII はそのまま、それ以外は 1 UTF-16 コード単位 = `%` + 16 進4桁）。`%:` は旧エンコーダが生成しないため、新旧の識別子空間は分離されます。識別子は 1024 文字、値は UTF-8 換算で 32,767 バイトを既定の上限として、書き込み前に拒否します（`maxIdentifierLength` / `maxValueLength` で変更可）。32,767 はコミュニティ情報に基づくローカルガードで、エンジンの実上限は未検証です。文字列以外の保存値も拒否します。
- **以前の可変幅パーセントエンコード（例 `%E9`）で保存した動的プロパティは、このエンコーダでは読みません。** 現在の識別子が存在せず、旧エンコードの識別子に値がある場合、`LEGACY_IDENTIFIER_CONFLICT` で失敗し、旧エンコード側の値は返さず、どちらのプロパティも変更しません。旧エンコードは単射ではなく別キーの値と衝突し得るため、値をこのキーに帰属できません。手動で調査・移行してください。

## インベントリのシリアライズ（任意・実機非依存）

`VirtualInventory` は、永続化のために明示的な `InventoryItemCodec` で JSON 可能なスナップショットへ変換できます（設計 4.3 / 9.6）。Bedrock の `ItemStack` は component・dynamic property・タグなどを一つの値として全列挙できないため、既定の codec はありません。保持する情報は呼び出し側が codec で決めます。

```ts
import { ItemBuilder, VirtualInventory, type InventoryItemCodec } from "invui-bedrock";

interface PlainItem {
  typeId: string;
  amount: number;
}

const codec: InventoryItemCodec<PlainItem> = {
  encode: (item) => ({ typeId: item.typeId, amount: item.amount }),
  decode: (value) => new ItemBuilder(value.typeId, value.amount).build(),
};

const snapshot = inventory.serialize(codec); // 空スロットは含まない
const restored = VirtualInventory.deserialize(snapshot, codec);
```

**codec は情報を落とし得ます。** `ItemStack` の全状態は列挙できないため、codec が保存対象にしない component・dynamic property・タグ・名前・lore などは失われます。復元されるのは codec が encode で書き出し、decode で戻せる情報だけであり、元の `ItemStack` と同一にはなりません。上の例は typeId と個数だけを保存するので、名前・lore・component などは失われます。何を保持するかは呼び出し側の明示的な選択です（既定 codec は提供しません）。必要な情報を codec に追加してください。

`serialize()` は最初の `encode()` 呼び出しより前に全占有 slot の `ItemStack` を clone して固定するため、encode 中に codec がインベントリを変更しても、2 つの時点が混ざったスナップショットにはなりません。各 `encode()` の戻り値は strict な JSON 検証と deep clone を通します。`JSON.stringify` が黙って書き換える値（入れ子の `undefined`、`NaN` / `Infinity`、疎配列、配列の非インデックスキー、オブジェクトのシンボルキー・非列挙プロパティ・getter、`toJSON`、循環参照）は拒否します。

`serializeInventory(inventory, codec)` は同じスナップショットを任意の `Inventory` から作成します（設計 4.3 / 9.6 の「別の明示的なシリアライズ処理」）。`size` と `getItem()` だけを使い、`setItem()` / `clear()` は呼びません。読み取り専用の `PlayerInventory` も、`getItem()` が返す clone を保存する形でスナップショットにできます。占有 slot の clone と strict な JSON 検証は `serialize()` と同じで、復元先は引き続き `VirtualInventory.deserialize()` です。

```ts
import { serializeInventory } from "invui-bedrock";

// inventory は Inventory（読み取り専用の PlayerInventory も可）
const snapshot = serializeInventory(inventory, codec);
```

`deserialize()` は、decode や書き込みを始める前にスナップショット全体を strict な JSON として検証・deep clone します。そのため decode が呼び出し側のスナップショットを変更できず、不正なスナップショットから部分的に復元されたインベントリを返すこともありません。検証は snapshot の version・size・slot 範囲・重複 slot に加え、各 slot エントリが `slot` と `item` の両方を持つことを含みます。`item` を欠いたエントリは空 slot と解釈せず拒否します。decode の戻り値は `clone()` を持つ `ItemStack` として検証し、不正なら拒否します。実機に依存しないロジックですが、実機での永続化は未検証です。

## プレイヤーインベントリ（読み取り専用・実機未検証）

`PlayerInventory` は、プレイヤーの実インベントリ（`player.getComponent("inventory").container`）を `Inventory` として読むアダプタです（設計 3.6 / 7.4）。`InventoryLink` と組み合わせて、プレイヤー自身のスロットを upper GUI に表示できます。`src/index.ts` から公開しています。

```ts
import { InventoryLink, PlayerInventory } from "invui-bedrock";

const inventory = new PlayerInventory(player); // 読み取り専用。変更通知は接続しない
const link = new InventoryLink(inventory, 0);  // スロット 0 を GUI 要素として表示
```

- **読み取り専用です。** `getItem(slot)` は clone を返し、`slot` が非整数・負数・`size` 以上なら `RangeError` を投げます。clone は `VirtualInventory` と同じ検証を通るため、コンテナ上のスタックの `clone()` が `undefined` や非スタック、元のオブジェクト自身を返す場合は、占有スロットを空として返したり実スタックを渡したりせず `TypeError` を投げます（`Window` の描画はその slot を表示失敗として扱い、直前の表示を保持します）。`setItem()` と `clear()` は常に `PlayerInventoryReadOnlyError`（`INVUI_PLAYER_INVENTORY_READ_ONLY`）を投げ、実コンテナへは書き込みません。`PlayerInventory.writable` は `false` 固定です。
- **生成時の検証**: `new PlayerInventory(player, options)` は、`player.id` を空でない文字列として読めない場合に `TypeError`、`getComponent("inventory")` かその `container` を読めない場合に `Error` を投げます。`options` がオブジェクトでない場合、`changes` が `subscribe()` を持たない場合も `TypeError` です。`size` はそのコンテナの実際のサイズです。
- **移動はできません。** `PlayerInventory` を `InventoryLink` に渡すと、`link.setItem()` は `PlayerInventoryReadOnlyError` で失敗し、`link.moveTo()` は移動自体が無効なため `InventoryLinkMoveRejectedError` を投げます。`PlayerInventory` は `Inventory` の書き込みメソッドを実装していますが、それは `InventoryLink` の読み取り経路を通すためだけで、成功する書き込み経路ではありません。
- **変更通知は明示注入だけです。** Bedrock には、このアダプタが使う絶対スロット番号と一致することを保証する文書化された変更イベントがありません（`PlayerInventoryType` は hotbar と main inventory を分け、インデックス空間は未規定）。そのため自動接続はせず、`new PlayerInventory(player, { changes: source })` のように、イベントから絶対スロットへの変換を確認済みの `PlayerInventoryChangeSource` を呼び出し側が渡します。
- **任意のイベントブリッジ（`createPlayerInventoryChangeSource`）も用意しています。** `world.afterEvents.playerInventoryItemChange` を購読し、呼び出し側が渡した `mapSlot(inventoryType, slot)` の結果を絶対スロットとして転送します。対応表は Bedrock のドキュメントにないため、**実機で確認した mapper を明示的に渡す必要があり、既定の mapper はありません**（未検証の例をそのまま使わないでください）。このブリッジは通知の転送だけで、コンテナへの読み書き・アイテム移動は一切しません（`PlayerInventory` は読み取り専用のまま）。player id を読めないイベント、mapper の例外・非整数・負数の結果、`undefined` を返したイベント、イベントのスタックが安全に clone できないイベントは破棄します。`createPlayerInventoryChangeSource` も `src/index.ts` から公開しています。**実機未検証です。**

```ts
const inventory = new PlayerInventory(player, { changes: verifiedSource });
```

イベントから接続する場合（`mapSlot` は実機で確認した対応だけを書く）:

```ts
import { createPlayerInventoryChangeSource, PlayerInventory } from "invui-bedrock";
import { world } from "@minecraft/server";

const changes = createPlayerInventoryChangeSource(
  world.afterEvents.playerInventoryItemChange,
  (inventoryType, slot) => (inventoryType === "Hotbar" ? slot : slot + 9), // 例。実機未検証
);
const inventory = new PlayerInventory(player, { changes });
```

- **イベント解除は `subscribe()` の戻り値ではなく `signal.unsubscribe(callback)` で行います。** beta の `PlayerInventoryItemChangeAfterEventSignal.subscribe()` は解除関数ではなく**渡したコールバック自身**を返します（型も `(arg0: PlayerInventoryItemChangeAfterEvent) => void`）。戻り値を解除関数として呼ぶと、リスナーが解除されないまま偽イベントとして再実行されるため、ブリッジは戻り値を無視して `unsubscribe(callback)` を呼びます。ブリッジが返す購読解除関数は冪等で、二重解除でも `unsubscribe` は一度しか呼びません。`subscribe()` / `unsubscribe()` を持たない signal、関数でない `mapSlot`、関数でない listener を渡した場合も購読前に `TypeError` を投げ、`PlayerInventory` 側は `console.error` に記録して表示を継続します。
- `PlayerInventoryChangeSource.subscribe(listener)` は購読解除関数を返す必要があります。`changes` を省略した場合、`subscribe()` は購読解除関数を返しますが**一度も発火しません**（表示は `refresh()`・状態更新・GUI 変更時の再描画で更新されます）。
- 注入した source が投げた例外、購読解除関数を返さない場合、購読解除時の例外は `console.error` に記録し、表示は継続します。最後の購読者が解除されると source の購読も解除します。
- source から届いた変更のうち、`playerId` がこのインスタンスの `playerId` と一致し、`slot` が整数で `0 <= slot < size` のものだけを転送します。`previous` / `current` は `VirtualInventory` と同じ検証付き clone を経て渡し、安全に clone できない変更は `console.error` に記録して破棄します（実スタックをリスナーへ渡しません）。リスナーの例外は `console.error` に記録して他のリスナーへの配送を続けます。
- **実機未検証です。** 実装は Node.js 上のモックに対するもので、実機で `getComponent("inventory").container` から同じスロット番号で読めるか、注入した source のマッピングが正しいかは確認していません。`size` はコンテナの実際のサイズで、固定の 36 ではありません。実機のアイテム保護・移動の安全性を提供するものではありません。
