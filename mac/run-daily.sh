#!/usr/bin/env bash
# Mac 上で日次の recs 生成を回す。launchd から呼ばれる。
#
# ★クラウドではなく Mac で回す理由★
#   - X をログイン済みセッションで読める（Cookie を public リポジトリの Secrets に置かずに済む）
#   - Firebase に直接届く（クラウドセッションは egress 403 で Actions 経由が必須だった）
#   - 一般サイトにも自由に出られる
#   - 費用は電気代のみ。LLM を使わないので API 課金はゼロ
#
# ★流れ★
#   ① 収集   collect-x.mjs      … X から材料を集める
#   ② 選別   build-recs.mjs     … 15〜25件を選んで整形し Firebase に反映
#
# 秘密は mac/.env に置く。リポジトリには入れない（.gitignore 済み）。
#
# 手で試すとき:
#   RECS_MODE=dry-run bash mac/run-daily.sh   … 書き込まずに結果だけ見る
#   bash mac/run-daily.sh                     … 本番と同じ（Firebase に書く）

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
mkdir -p "$HERE/logs"

# 既定は live。日次バッチは反映まで行って初めて意味があるため。
# 確かめたいときだけ RECS_MODE=dry-run を付ける。
MODE="${RECS_MODE:-live}"

echo ""
echo "=== $(date '+%Y-%m-%d %H:%M:%S') 日次バッチ開始（mode=${MODE}）==="

# ローカルの秘密を読む（X の Cookie など）。無くてもプロフィール経由で動く。
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

cd "$REPO" || { echo "❌ リポジトリに移動できません: $REPO"; exit 1; }

# 最新のコードを取り込む。失敗しても手元のコードで続行する。
# 一晩の実行をネットワークの瞬断で落とさないため。
if git pull --ff-only origin main >/dev/null 2>&1; then
  echo "  コード: $(git log --oneline -1)"
else
  echo "  ⚠️ git pull できませんでした。手元のコードで続けます"
fi

# ── ① 収集 ──
echo ""
echo "--- ① 収集 ---"
if ! node scripts/collect-x.mjs; then
  echo "❌ 収集に失敗しました。選別には進みません。"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 異常終了 ==="
  exit 1
fi

# ── ② 選別・整形・反映 ──
echo ""
echo "--- ② 選別・整形 ---"
if ! MODE="$MODE" node scripts/build-recs.mjs; then
  echo "❌ 選別・整形に失敗しました。"
  echo "   材料はあるので collected-x.json を見れば原因を追えます。"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 異常終了 ==="
  exit 1
fi

echo ""
echo "=== $(date '+%Y-%m-%d %H:%M:%S') 正常終了 ==="
