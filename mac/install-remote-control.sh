#!/usr/bin/env bash
# Claude Code を常駐させ、スマホ／クラウドから この Mac を動かせるようにする。
# sudo 不要（ユーザー単位の LaunchAgent）。
#
# ★なぜ SSH ではなくこれなのか★
#   クラウドの Claude Code セッションは egress ポリシーで
#   api.github.com 以外に出られない。実測（2026-08-30）:
#     api.github.com          ✅ 200
#     example.com / Firebase / github.io   ❌ 到達不可
#     github.com:22           CONNECT は通り SSH のバナー交換まで成立するが
#                             6秒でゲートウェイに切られる（3回とも）
#   つまり Mac 側で sshd を立てても、ポートを開けても、固定IPにしても届かない。
#   壁は Mac ではなくクラウド側にある。
#
#   Remote Control は Mac から **外向きに** Anthropic へ繋ぐので、この制限を受けない。
#   ポート開放もファイアウォールの変更も不要で、結果として SSH より安全でもある
#   （自宅のネットワークに外から入る口を開けずに済む）。
#
# ★前提★
#   Mac の Claude Code で一度 /login を済ませておくこと。
#   未ログインだと claude remote-control はエラーで終了する。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LABEL="com.bubblesnow.remote"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v launchctl >/dev/null 2>&1 || { echo "❌ macOS ではありません"; exit 1; }

CLAUDE="$(command -v claude 2>/dev/null)"
if [ -z "$CLAUDE" ]; then
  echo "❌ claude が見つかりません。"
  echo "   インストール後、このスクリプトを実行しているシェルで"
  echo "   command -v claude が通ることを確かめてください。"
  exit 1
fi
echo "  claude: $CLAUDE"

# ログイン済みかを先に見る。未ログインのまま常駐させると
# KeepAlive で失敗し続け、ログを読むまで原因が分からない。
if ! "$CLAUDE" remote-control --help >/dev/null 2>&1; then
  echo "❌ Remote Control を使える状態ではありません（未ログインの可能性）。"
  echo "   claude を起動して /login を済ませてから、もう一度実行してください。"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HERE/logs"

# launchd の PATH は痩せている。いまのシェルの PATH に、
# claude 本体のあるディレクトリを先頭で足しておく。
CLAUDE_DIR="$(dirname "$CLAUDE")"
FULL_PATH="$CLAUDE_DIR:$PATH"

sed -e "s|__REPO__|$REPO|g" \
    -e "s|__CLAUDE__|$CLAUDE|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$FULL_PATH|g" \
    "$HERE/$LABEL.plist" > "$DEST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$DEST" || { echo "❌ 登録に失敗しました"; exit 1; }

echo "✅ 登録しました: $DEST"
echo "   ログイン時に自動起動し、落ちても起こし直します。"
echo

# 立ち上がりを見届ける。「登録できた」と「繋がった」は別なので、
# ここで確かめておかないと、次にスマホから叩いたときに初めて失敗が分かる。
echo "  起動を待っています..."
for i in $(seq 1 15); do
  sleep 2
  if launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q "state = running"; then
    echo "  ✅ 常駐しています"
    break
  fi
  [ "$i" -eq 15 ] && echo "  ⚠️ 30秒たっても running になりません。下のログを見てください。"
done

echo
echo "  状態を見る : launchctl print gui/$(id -u)/$LABEL | head -20"
echo "  ログ       : tail -f $HERE/logs/remote.out.log"
echo "  一時停止   : launchctl bootout gui/$(id -u)/$LABEL"
echo "  外す       : launchctl bootout gui/$(id -u)/$LABEL && rm $DEST"
echo
echo "  これ以降、スマホや claude.ai/code のセッション一覧に"
echo "  「BubblesNow (Mac)」が出ます。そこから この Mac を動かせます。"
