#!/usr/bin/env bash
# 手動テスト用パックを Minecraft (Bedrock) のグローバルパックフォルダへコピーする。
# ワールド選択も JSON 編集もしない。有効化はゲーム内のワールド設定で行う。
# 既存フォルダは上書きするが、削除はしない。実機未検証。
set -u

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GLOBAL=''

# 番号|種別|このスクリプト隣のコピー元|コピー先フォルダ名
PACKS=(
  '1|BP|probe/behavior_pack|invui_probe'
  '2|BP|locked-click-probe/behavior_pack|locked_click_probe'
  '3|RP|chest-resource-pack|invui_chest_probe'
  '4|RP|data-driven-resource-pack|invui_data_driven_probe'
  '5|RP|button-send-resource-pack|invui_button_send_probe'
  '6|RP|edit-box-resource-pack|invui_edit_box_probe'
  '7|RP|protection-resource-pack|invui_protection_probe'
)

# mcpelauncher 系の既定候補。behavior_packs と resource_packs の両方があるものだけ使う。
CANDIDATES=(
  "${HOME:-}/.local/share/mcpelauncher/games/com.mojang"
  "${HOME:-}/.var/app/io.mrarm.mcpelauncher/data/mcpelauncher/games/com.mojang"
  "${HOME:-}/snap/mcpelauncher/current/.local/share/mcpelauncher/games/com.mojang"
  "${HOME:-}/.config/mcpelauncher/games/com.mojang"
)

fail() {
  printf '\n[ERROR] %s\n' "$1" >&2
  exit 1
}

cancel() {
  echo '取消しました。何も変更していません。'
  exit 0
}

# --- com.mojang の場所を決める（引数 > MC_COMOJANG > 既知候補） -----------------

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  GLOBAL=$1
elif [ -n "${MC_COMOJANG:-}" ]; then
  GLOBAL=$MC_COMOJANG
else
  FOUND=()
  for candidate in "${CANDIDATES[@]}"; do
    if [ -d "$candidate/behavior_packs" ] && [ -d "$candidate/resource_packs" ]; then
      FOUND+=("$candidate")
    fi
  done

  case ${#FOUND[@]} in
    0)
      printf '[ERROR] com.mojang が見つかりません。次の場所を確認しました:\n' >&2
      for candidate in "${CANDIDATES[@]}"; do
        printf '  %s\n' "$candidate" >&2
      done
      printf 'Minecraft を一度起動してから再実行するか、MC_COMOJANG（または第 1 引数）で com.mojang を指定してください。\n' >&2
      exit 1
      ;;
    1)
      GLOBAL=${FOUND[0]}
      ;;
    *)
      echo 'com.mojang が複数見つかりました:'
      index=0
      for candidate in "${FOUND[@]}"; do
        index=$((index + 1))
        printf '  %d  %s\n' "$index" "$candidate"
      done
      printf '番号を選択: '
      if ! read -r pick; then cancel; fi
      if ! [[ "$pick" =~ ^[0-9]+$ ]] || [ "$pick" -lt 1 ] || [ "$pick" -gt "${#FOUND[@]}" ]; then
        fail "無効な選択: ${pick}. 何も変更していません。"
      fi
      GLOBAL=${FOUND[$((pick - 1))]}
      ;;
  esac
fi

GLOBAL=${GLOBAL%/}
if [ ! -d "$GLOBAL/behavior_packs" ] || [ ! -d "$GLOBAL/resource_packs" ]; then
  fail "behavior_packs と resource_packs がないため com.mojang として使えません: $GLOBAL"
fi

# --- パック一覧と選択 -----------------------------------------------------------

echo '利用可能なパック:'
for entry in "${PACKS[@]}"; do
  IFS='|' read -r index kind src dest <<< "$entry"
  if [ "$kind" = 'BP' ]; then root="$GLOBAL/behavior_packs"; else root="$GLOBAL/resource_packs"; fi
  tag=''
  if [ -d "$root/$dest" ]; then tag=' (installed)'; fi
  printf '  %s  [%s] %s%s\n' "$index" "$kind" "$src" "$tag"
done
echo
echo '番号をスペース区切りで入力（例: 1 3 5）、"all"、空 Enter で取消。'
printf '選択: '
if ! read -r selection; then selection=''; fi

if [[ "$selection" =~ ^[[:space:]]*$ ]]; then
  cancel
fi

SELECTED=()
case "$selection" in
  [Aa][Ll][Ll])
    SELECTED=(1 2 3 4 5 6 7)
    ;;
  *)
    if ! [[ "$selection" =~ ^[0-9[:space:]]+$ ]]; then
      fail "無効な選択: ${selection}. 1-7 の番号をスペース区切りで、または all。何も変更していません。"
    fi
    read -ra numbers <<< "$selection"
    for number in "${numbers[@]}"; do
      if [ "$number" -lt 1 ] || [ "$number" -gt 7 ]; then
        fail "範囲外の番号: ${number} (1-7)。何も変更していません。"
      fi
      case " ${SELECTED[*]} " in
        *" $number "*) ;;
        *) SELECTED+=("$number") ;;
      esac
    done
    if [ "${#SELECTED[@]}" -eq 0 ]; then
      fail '何も選択されていません。何も変更していません。'
    fi
    ;;
esac

# --- コピー前に全ソースを検証 ---------------------------------------------------

RP_COUNT=0
for entry in "${PACKS[@]}"; do
  IFS='|' read -r index kind src dest <<< "$entry"
  case " ${SELECTED[*]} " in
    *" $index "*) ;;
    *) continue ;;
  esac
  if [ ! -f "$HERE/$src/manifest.json" ]; then
    fail "パックが見つかりません（manifest.json がない）: $HERE/$src"
  fi
  if [ "$kind" = 'RP' ]; then RP_COUNT=$((RP_COUNT + 1)); fi
done
if [ "$RP_COUNT" -gt 1 ]; then
  echo '[WARN] Resource Pack を複数選択しています。1つずつ有効化してください。'
fi

# --- コピー（既存は上書き、削除はしない） ---------------------------------------

for entry in "${PACKS[@]}"; do
  IFS='|' read -r index kind src dest <<< "$entry"
  case " ${SELECTED[*]} " in
    *" $index "*) ;;
    *) continue ;;
  esac
  if [ "$kind" = 'BP' ]; then root="$GLOBAL/behavior_packs"; else root="$GLOBAL/resource_packs"; fi
  target="$root/$dest"
  if [ -d "$target" ]; then
    echo "[INFO] 更新: $target （既存ファイルは上書き）"
  fi
  mkdir -p "$target" || fail "フォルダを作成できません: $target"
  if ! cp -R "$HERE/$src/." "$target/"; then
    fail "コピー失敗: $HERE/$src -> $target。Minecraft を閉じて書き込み権限を確認してください。"
  fi
  echo "[OK] $target"
done

echo
echo '完了。ゲーム内のワールド設定で有効化してください（Behavior Packs / Resource Packs）。'
echo 'Resource Pack 同士は競合するので、1つずつ有効化してください。'
echo '注: 実機未検証。'
exit 0
