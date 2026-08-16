#!/usr/bin/env bash
# Mac 上で日次の recs 生成を回す。launchd から呼ばれる。
#
# ★クラウドではなく Mac で回す理由★
#   - X をログイン済みセッションで読める（Cookie を public リポジトリの Secrets に置かずに済む）
#   - Firebase に直接届く（クラウドセッションは egress 403 で Actions 経由が必須だった）
#   - 一般サイトにも自由に出られる
#   - 費用は電気代のみ
#
# 秘密は mac/.env に置く。リポジトリには入れない（.gitignore 済み）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
mkdir -p "$HERE/logs"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 日次バッチ開始 ==="

# ローカルの秘密を読む（X の Cookie など）。無くても収集は動く。
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

cd "$REPO" || exit 1

# 最新のコードを取り込む。失敗しても手元のコードで続行する。
git pull --ff-only origin main >/dev/null 2>&1 || echo "  ⚠️ git pull できませんでした。手元のコードで続けます"

node scripts/collect-x.mjs
echo "=== $(date '+%Y-%m-%d %H:%M:%S') 終了 ==="
