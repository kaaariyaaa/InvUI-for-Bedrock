/**
 * InvUI for Bedrock — 設計上の利用イメージ（実行不可）
 *
 * 重要:
 * - このファイルはビルド・テストの対象外のスケッチです。型検査のみ手動で行い、実行はしません。
 * - ここに現れる API は現行コアに存在しますが、実機での挙動を保証しません。
 *   実装との差は README.md の「現行実装との差」を参照してください。
 * - VirtualContainer は Bedrock Preview/Beta の Experimental API を前提とした設計です。
 * - クリック、アイテム保護、JSON UI、InventoryLink の移動は実機未検証であり、安全に利用できません。
 *   このスケッチのクリック処理を、動作する機能として本番設計へ持ち込まないでください。
 * - 既定の実アダプタは実画面を開きます（canOpenScreens = true、実機未検証）。
 *   canOpenScreens = false のアダプタを注入した場合だけ WindowOpenRejectedError で reject します。
 */

import type { Player } from "@minecraft/server";
import {
  Gui,
  Item,
  ItemBuilder,
  Markers,
  Structure,
  Window,
} from "invui-bedrock";

// --- アイテムとクリックのスケッチ -------------------------------------------------
// 設計書 6.2。クリック通知方式は実機未検証のため、このハンドラーが
// 呼ばれることを前提にした本番処理はまだ書けません。
const buyButton = Item.builder()
  .setItemProvider(
    new ItemBuilder("minecraft:diamond")
      .setName("購入")
      .addLoreLines("クリックして購入"),
  )
  .addClickHandler((click) => {
    // 設計上の通常クリック。左右・Shift・ダブルの区別はしない。
    const { player, slot, window } = click;

    // 実機試験が終わるまで、ここに課金・アイテム移動などの不可逆処理を置かない。
    void player;
    void slot;
    void window;
  })
  .updateOnClick()
  .build();

// --- 宣言型（Options）のスケッチ -------------------------------------------------
// 設計書 5.1。content には Item など SlotElement の配列を渡す。
// buyButton は content に含めるので、コンテンツ領域のスロットに並ぶ。
const shopGui = Gui.paged({
  structure: [
    "#########",
    "#xxxxxxx#",
    "#########",
  ],
  ingredients: {
    "#": Item.simple(new ItemBuilder("minecraft:gray_stained_glass_pane")),
    x: Markers.CONTENT_LIST_SLOT_HORIZONTAL,
  },
  content: [buyButton],
});

// --- Builder と Window のスケッチ -------------------------------------------------
// 設計書 5.2 / 8.2 / 9.1〜9.3。
const structure = new Structure(
  "#########",
  "#xxxxxxx#",
  "#########",
)
  .addIngredient("#", Item.simple(new ItemBuilder("minecraft:gray_stained_glass_pane")))
  .addIngredient("x", Markers.CONTENT_LIST_SLOT_HORIZONTAL);

const gui = Gui.paged()
  .setStructure(structure)
  .setContent([buyButton])
  .build();

export async function openShop(player: Player): Promise<void> {
  const window = Window.builder()
    .setViewer(player)
    .setTitle("ショップ")
    .setUpperGui(gui)
    .setStateScope("player")
    .setStateLifetime("window")
    .addCloseHandler((reason) => {
      // 設計書 13.1 の終了要因。終了イベントの重複実行は実機で確認する。
      void reason;
    })
    .setErrorHandler((error, context) => {
      // 設計書 14.3。Window 単位で隔離する想定。
      console.warn("InvUI error", error, context);
    })
    .build();

  // 実機未検証。既定の実アダプタ（canOpenScreens = true）は Container を作成して
  // VirtualContainer.open() を呼ぶ。canOpenScreens = false のアダプタでは
  // WindowOpenRejectedError で reject する。どちらも正常な経路なので、await して
  // catch し、未処理 rejection を残さない。
  try {
    await window.open();
  } catch (error) {
    // 画面を開けなかった（拒否、または実機で open が失敗した）。
    // ここでは状態を変えず、呼び出し元へ知らせるだけにする。
    console.warn("InvUI: 画面を開けませんでした", error);
  }
}

// --- 未検証機能の扱い -------------------------------------------------------------
// - JSON UI と Resource Pack:
//   設計書 16.4 / 16.5。invui.json を置くだけで既存チェストへ接続されるとは扱わない。
// - InventoryLink:
//   設計書 7.3 / 18.3。安全試験に合格するまで有効化しない。
//   このスケッチには移動処理を置かない。
// - 下側 GUI:
//   設計書 7.4。標準プレイヤーインベントリの見た目を自由に置換できるとは扱わない。
