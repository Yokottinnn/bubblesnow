#!/usr/bin/env bash
# 蓋を閉じたまま常時稼働できるようにする。要 sudo。
# 変更前の値を表示し、元に戻すコマンドも出す。
set -uo pipefail

command -v pmset >/dev/null 2>&1 || { echo "❌ macOS ではありません"; exit 1; }
[ "$(id -u)" = "0" ] || { echo "❌ sudo で実行してください: sudo bash mac/apply-power.sh"; exit 1; }

before="$(pmset -g custom | awk '/AC Power/{f=1;next}/Battery Power/{f=0}f')"
get() { printf '%s\n' "$before" | awk -v k="$1" '$1==k{print $2; exit}'; }

echo "=== 変更前（AC接続時）==="
echo "  disablesleep=$(get disablesleep) sleep=$(get sleep) disksleep=$(get disksleep) womp=$(get womp)"
echo
echo "=== 元に戻したくなったら ==="
echo "  sudo pmset -c disablesleep $(get disablesleep) sleep $(get sleep) disksleep $(get disksleep) womp $(get womp)"
echo

# -c は「電源アダプタ接続時のみ」。バッテリー動作時の挙動は変えないので、
# 持ち出したときに電池を食い潰すことはない。
pmset -c disablesleep 1
pmset -c sleep 0
pmset -c disksleep 0
pmset -c womp 1

echo "=== 変更後 ==="
pmset -g custom | awk '/AC Power/{f=1;next}/Battery Power/{f=0}f' | sed 's/^/  /'
echo
echo "✅ 電源接続中は蓋を閉じても起きたままになります。"
echo "   バッテリー動作時の設定は変更していません。"
