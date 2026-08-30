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
#
# ★使い方★
#   bash mac/install-remote-control.sh
#       → このリポジトリを対象に常駐（既定）
#   bash mac/install-remote-control.sh ~/daily-hack "daily-hack"
#       → 別のディレクトリを対象に、別の常駐を追加する
#
#   複数入れても互いに干渉しない。ラベルが分かれ、セッション一覧にも
#   それぞれ別の名前で出る。まとめて見るときは
#   `launchctl list | grep bubblesnow` で全部拾える。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 第1引数で対象ディレクトリ、第2引数で表示名を変えられる。
# 省略時はこのリポジトリ（＝これまでと同じ動き）。
TARGET_DIR="${1:-$(cd "$HERE/.." && pwd)}"
REPO="$(cd "$TARGET_DIR" 2>/dev/null && pwd)" || { echo "❌ ディレクトリが見つかりません: $TARGET_DIR"; exit 1; }
DEFAULT_REPO="$(cd "$HERE/.." && pwd)"
DISPLAY_NAME="${2:-BubblesNow (Mac)}"

# ラベルは既定の1つだけ従来のまま。すでに動いているものを
# 改名すると入れ直しになり、いま繋がっている常駐を切ることになる。
# 追加ぶんは接尾辞で分ける。接頭辞を揃えてあるので grep で一括して見つかる。
if [ "$REPO" = "$DEFAULT_REPO" ] && [ -z "${2:-}" ]; then
  LABEL="com.bubblesnow.remote"
  LOG_DIR="$HERE/logs"
  LOG_BASE="remote"
else
  # 英数字以外を - に潰してラベルに使える形にする。
  SLUG="$(printf '%s' "$DISPLAY_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//')"
  [ -n "$SLUG" ] || SLUG="extra"
  LABEL="com.bubblesnow.remote.$SLUG"
  # 対象が別リポジトリだと mac/logs があるとは限らないので、ユーザーの
  # ログ置き場に出す。リポジトリの中にログを置かずに済む利点もある。
  LOG_DIR="$HOME/Library/Logs/claude-remote"
  LOG_BASE="$SLUG"
fi
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "  対象     : $REPO"
echo "  表示名   : $DISPLAY_NAME"
echo "  ラベル   : $LABEL"

command -v launchctl >/dev/null 2>&1 || { echo "❌ macOS ではありません"; exit 1; }

CLAUDE="$(command -v claude 2>/dev/null)"
if [ -z "$CLAUDE" ]; then
  echo "❌ claude が見つかりません。"
  echo "   インストール後、このスクリプトを実行しているシェルで"
  echo "   command -v claude が通ることを確かめてください。"
  exit 1
fi
echo "  claude: $CLAUDE"

echo "  version: $("$CLAUDE" --version 2>&1 | head -1)"

# 常駐させる前に使える状態かを見る。未ログインのまま KeepAlive に入れると
# 失敗し続け、ログを読むまで原因が分からない。
#
# ここで claude の出力を捨ててはいけない。最初の版は 2>&1 で握りつぶして
# 「未ログインの可能性」と推測を出していたが、それでは原因が分からず、
# 見当違いの対処に時間を使わせるだけだった。理由は claude 自身が知っている。
# 常駐と同じ条件で確かめる。plist は env -u で推論専用の資格情報を外して
# 起動するので、素の claude で判定すると「実際には動くのにチェックだけ落ちる」。
# 最初の版がまさにそれで、環境変数さえ外せば通る状態を「使えません」と
# 突き返していた。チェックは実行時を真似ないと意味がない。
RC_OUT="$(/usr/bin/env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  "$CLAUDE" remote-control --help 2>&1)"
RC_CODE=$?

# 通ったとしても、環境変数が残っていること自体は伝えておく。
# 常駐は無事でも、ターミナルで claude を直に使うときは同じ制限を受ける。
if [ "$RC_CODE" -eq 0 ] && [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "  ℹ️ CLAUDE_CODE_OAUTH_TOKEN が環境変数にあります。"
  echo "     常駐は env -u で外して起動するので問題ありません。"
  echo "     ただしターミナルで claude を直に使うときは推論専用のままです。"
  echo "     出所を探すなら: ~/.zshenv ~/.zprofile ~/.profile / launchctl getenv CLAUDE_CODE_OAUTH_TOKEN"
fi

if [ "$RC_CODE" -ne 0 ]; then
  echo "❌ Remote Control を使える状態ではありません。"
  echo
  echo "  --- claude の返答 ---"
  printf '%s\n' "$RC_OUT" | head -20 | sed 's/^/  /'
  echo "  ---------------------"
  echo

  # 実際にこの Mac で起きた原因。claude setup-token で作る長期トークンは
  # 推論専用にスコープが絞られていて、Remote Control には使えない。
  # 見た目には「ログイン済み」なので、これが理由だと気づきにくい。
  if printf '%s' "$RC_OUT" | grep -q "full-scope login token"; then
    # 環境変数は既に外したうえで失敗している。つまり保存済みの資格情報
    # そのものが長期トークン。ここは claude auth login でしか直らない。
    echo "  → 保存されている資格情報が長期トークンです。"
    echo "     環境変数は外して試したうえで拒否されているので、"
    echo "     資格情報そのものを入れ替える必要があります。"
    echo
    echo "     claude auth login"
    echo
    echo "  日次バッチは claude を使わない（node だけ）ので、"
    echo "  ログインを切り替えても mac/run-daily.sh には影響しません。"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "  ⚠️ ANTHROPIC_API_KEY が設定されています。"
    echo "     Remote Control は API キーでは使えません（サブスクリプションのログインが必要）。"
    echo "     シェルの設定（~/.zshrc など）から外して、もう一度実行してください。"
  else
    echo "  claude auth login を済ませてから、もう一度実行してください。"
    echo "  すでにログイン済みなら、上の返答をそのまま共有してください。"
  fi
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# launchd の PATH は痩せている。いまのシェルの PATH に、
# claude 本体のあるディレクトリを先頭で足しておく。
CLAUDE_DIR="$(dirname "$CLAUDE")"
FULL_PATH="$CLAUDE_DIR:$PATH"

# plist の雛形は1つ。対象ごとの違いは差し込みで吸収する。
sed -e "s|__REPO__|$REPO|g" \
    -e "s|__CLAUDE__|$CLAUDE|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$FULL_PATH|g" \
    -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NAME__|$DISPLAY_NAME|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__LOG_BASE__|$LOG_BASE|g" \
    "$HERE/com.bubblesnow.remote.plist" > "$DEST"

UID_="$(id -u)"

# bootout は非同期。返ってきた時点ではまだ後片付けが終わっておらず、
# そこへ bootstrap を撃つと "Bootstrap failed: 5: Input/output error" になる。
# 実際にこれで登録に失敗した。しかも bootout 自体は効いているので、
# 「動いていた常駐を落としたうえで入れ直せない」という一番まずい終わり方をする。
# 消えるまで待ってから入れる。
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null
for i in $(seq 1 20); do
  launchctl print "gui/$UID_/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done

BOOT_OUT="$(launchctl bootstrap "gui/$UID_" "$DEST" 2>&1)"
if [ $? -ne 0 ]; then
  # 待っても消えていない＝まだ読み込まれている。plist は今書き直したので、
  # 入れ直す代わりに再起動させれば同じ状態になる。
  if launchctl print "gui/$UID_/$LABEL" >/dev/null 2>&1; then
    echo "  既に読み込まれています。新しい設定で再起動します"
    launchctl kickstart -k "gui/$UID_/$LABEL" >/dev/null 2>&1 \
      || { echo "❌ 再起動に失敗しました"; printf '%s\n' "$BOOT_OUT" | sed 's/^/  /'; exit 1; }
  else
    echo "❌ 登録に失敗しました"
    printf '%s\n' "$BOOT_OUT" | sed 's/^/  /'
    echo "  plist: $DEST"
    exit 1
  fi
fi

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
echo "  ログ       : tail -f $LOG_DIR/$LOG_BASE.out.log"
echo "  一時停止   : launchctl bootout gui/$(id -u)/$LABEL"
echo "  外す       : launchctl bootout gui/$(id -u)/$LABEL && rm $DEST"
echo
echo "  これ以降、スマホや claude.ai/code のセッション一覧に"
echo "  「$DISPLAY_NAME」が出ます。そこから この Mac を動かせます。"
