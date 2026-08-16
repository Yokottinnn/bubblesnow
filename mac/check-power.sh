#!/usr/bin/env bash
# Mac が「蓋を閉じたまま・電源接続で無期限に動く」状態かを確認する。
# 読むだけ。設定は変更しない（変更は apply-power.sh）。
#
# 前提の整理:
#   通常、外部ディスプレイを繋がずに蓋を閉じると Mac はスリープする。
#   これを止める決め手は `pmset -c disablesleep 1`。これが 1 なら
#   蓋を閉じても電源接続中は起きたままになり、launchd の定時実行が動く。
#   sleep 0 だけでは蓋閉じスリープ（clamshell sleep）は止まらない。
#
#   macOS 26 系の一部では `pmset -c/-a disablesleep 1` を実行しても
#   `pmset -g custom` に disablesleep 行そのものが出てこない（2026-08-16 実機確認）。
#   このとき値は「0 相当」ではなく「不明」。実機で蓋を閉じてスリープしないことを
#   確認済みなら、この行が無いだけで常時稼働は機能している。

set -uo pipefail

if ! command -v pmset >/dev/null 2>&1; then
  echo "❌ macOS ではありません（pmset が無い）。このスクリプトは Mac で実行してください。"
  exit 1
fi

echo "=== Mac 常時稼働の設定確認 ==="
echo "機種: $(sysctl -n hw.model 2>/dev/null || echo 不明)"
echo "macOS: $(sw_vers -productVersion 2>/dev/null || echo 不明)"
echo

echo "── 電源の状態 ──"
pmset -g batt | sed 's/^/  /'
echo

echo "── AC接続時の省電力設定 ──"
custom="$(pmset -g custom 2>/dev/null)"
ac="$(printf '%s' "$custom" | awk '/AC Power/{f=1;next}/Battery Power/{f=0}f')"
printf '%s\n' "$ac" | sed 's/^/  /'
echo

get() { printf '%s\n' "$ac" | awk -v k="$1" '$1==k{print $2; exit}'; }
has() { printf '%s\n' "$ac" | awk -v k="$1" '$1==k{found=1} END{exit !found}'; }

disablesleep="$(get disablesleep)"
sleepv="$(get sleep)"
disksleep="$(get disksleep)"
womp="$(get womp)"
powernap="$(get powernap)"

echo "── 判定 ──"
ok=1
if has disablesleep; then
  if [ "$disablesleep" = "1" ]; then
    echo "  ✅ disablesleep=1  … 蓋を閉じてもスリープしない（これが決め手）"
  else
    echo "  ❌ disablesleep=${disablesleep}  … 蓋を閉じるとスリープする"
    echo "       外部ディスプレイ無しのクラムシェル運用には 1 が必要"
    ok=0
  fi
else
  echo "  ℹ️ disablesleep=未検出  … このmacOSでは pmset -g custom に出てこない可能性がある"
  echo "       sudo bash mac/apply-power.sh 実行後も出ないなら、実際に蓋を閉じて確認するのが確実"
fi
[ "${sleepv:-1}" = "0" ] && echo "  ✅ sleep=0        … システムスリープ無効" || { echo "  ⚠️ sleep=${sleepv:-?}  … 0 が望ましい"; ok=0; }
[ "${disksleep:-1}" = "0" ] && echo "  ✅ disksleep=0    … ディスクを止めない" || echo "  ⚠️ disksleep=${disksleep:-?}  … 0 が望ましい"
[ "${womp:-0}" = "1" ] && echo "  ✅ womp=1         … ネットワーク経由で起こせる" || echo "  ℹ️ womp=${womp:-?}   … 任意"
[ "${powernap:-0}" = "1" ] && echo "  ℹ️ powernap=1     … スリープ中も一部処理。disablesleep があれば不要"

echo
echo "── いま眠らせない要因があるか ──"
pmset -g assertions 2>/dev/null | sed -n '1,12p' | sed 's/^/  /'

echo
if [ "$ok" = "1" ]; then
  echo "✅ 蓋を閉じたまま常時稼働できる状態です。"
else
  echo "⚠️ このままだと蓋を閉じたときに止まります。"
  echo "   設定するには: sudo bash mac/apply-power.sh"
fi
