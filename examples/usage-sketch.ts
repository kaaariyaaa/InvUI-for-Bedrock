/**
 * InvUI for Bedrock — usage sketch only. Not built or executed, and not
 * verified on a device. VirtualContainer is an Experimental API.
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

const buyButton = Item.builder()
  .setItemProvider(
    new ItemBuilder("minecraft:diamond")
      .setName("購入")
      .addLoreLines("クリックして購入"),
  )
  .addClickHandler(({ player, slot, window }) => {
    void player;
    void slot;
    void window;
  })
  .updateOnClick()
  .build();

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
      void reason;
    })
    .setErrorHandler((error, context) => {
      console.warn("InvUI error", error, context);
    })
    .build();

  try {
    await window.open();
  } catch (error) {
    console.warn("InvUI: 画面を開けませんでした", error);
  }
}
