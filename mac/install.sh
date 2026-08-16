#!/usr/bin/env bash
# launchd に日次ジョブを登録する。sudo 不要（ユーザー単位の LaunchAgent）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LABEL="com.bubblesnow.daily"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v launchctl >/dev/null 2>&1 || { echo "❌ macOS ではありません"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HERE/logs"

sed "s|__REPO__|$REPO|g" "$HERE/$LABEL.plist" > "$DEST"
chmod +x "$HERE/run-daily.sh"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$DEST" || { echo "❌ 登録に失敗しました"; exit 1; }

echo "✅ 登録しました: $DEST"
echo "   毎日 0:00（Mac のローカル時刻）に実行されます。"
echo
echo "  今すぐ試す : launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  状態を見る : launchctl print gui/$(id -u)/$LABEL | head -20"
echo "  ログ       : tail -f $HERE/logs/daily.out.log"
echo "  外す       : launchctl bootout gui/$(id -u)/$LABEL && rm $DEST"
