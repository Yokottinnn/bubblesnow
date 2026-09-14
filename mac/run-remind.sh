#!/bin/bash
# launchd から呼ばれるラッパー。mac/.env を読み込んでリマインダーを起動する。
#
# launchd はシェルの環境を継承しないので、秘密情報を plist に書かずに済むよう
# ここで .env を読む。.env は gitignore 済みで、plist 側には何も入れない。
#
# 実行する枠（朝/夕）は時刻から決める。1つの plist に2つの
# StartCalendarInterval を持たせているため、どちらで起きたかを自分で判断する。

set -uo pipefail

REPO="/Users/ny/bubblesnow"
cd "$REPO" || exit 1

if [ ! -f "$REPO/mac/.env" ]; then
  echo "[$(date '+%F %T')] mac/.env が無いため中止"
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$REPO/mac/.env"
set +a

# 12時より前なら朝、それ以降は夕方。復帰後のまとめ実行で
# 意図しない枠になるのを避けるため、時刻そのもので判定する。
hour=$(date +%-H)
if [ "$hour" -lt 12 ]; then
  export SLOT=morning
else
  export SLOT=evening
fi

# Webhook が未設定ならここで止める。未設定のまま走らせても
# Firebase を読んでから失敗するだけで、毎回ログにエラーが積もる。
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  # ${} で括るのは必須。全角括弧のようなマルチバイト文字が直後に来ると
  # $SLOT だけでは変数名の一部として読まれ、set -u で unbound になる。
  echo "[$(date '+%F %T')] SLACK_WEBHOOK_URL が未設定のためスキップ（slot=${SLOT}）"
  exit 0
fi

export STATE_FILE="$REPO/mac/.remind-state.json"

exec /opt/homebrew/bin/node "$REPO/scripts/remind-deadlines.mjs"
