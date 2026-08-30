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

# 実行した証拠をリポジトリに残す。
#
# クラウドのセッションは Firebase の鍵を持たず（鍵は mac/.env だけ）、
# Mac にも届かない（SSH 不可、Remote Control は Mac 側が起動していないと繋がらない）。
# つまり「昨夜動いたのか」を確かめる手段が無く、実際にそれで、
# 既に終わっている作業を未完了として報告する事故が起きた。
# GitHub になら双方から届くので、そこを合流点にする。
#
# 出すのは件数だけ。中身は書かない（public リポジトリのため）。
# 失敗した実行こそ知りたいので、途中で落ちても EXIT で必ず通る。
STATUS="中断（原因不明）"
GMAIL_WARN=""
heartbeat() {
  # trap は cd より前に仕掛けてある（cd 自体が失敗した場合も記録したいため）ので、
  # ここで自力でリポジトリに入る。入れないなら何もしない。
  cd "$REPO" 2>/dev/null || return 0

  HEARTBEAT_STATUS="${STATUS}${GMAIL_WARN}" \
  HEARTBEAT_MODE="$MODE" \
  HEARTBEAT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
    node scripts/write-heartbeat.mjs || true

  # mac/last-run.md だけを対象にする。収集物は .gitignore 済みだが、
  # 明示的に指定しておけば将来 ignore が漏れても巻き込まない。
  git diff --quiet -- mac/last-run.md 2>/dev/null
  local changed=$?
  local untracked
  untracked="$(git ls-files --others --exclude-standard -- mac/last-run.md)"
  [ "$changed" -eq 0 ] && [ -z "$untracked" ] && return 0

  git add mac/last-run.md
  git -c user.name="BubblesNow daily" -c user.email="noreply@localhost" \
    commit -q -m "Record the daily run ($(date '+%Y-%m-%d'))" -- mac/last-run.md || return 0

  # 昼間にクラウド側が main を進めていると push は弾かれる。
  # そこで諦めると心拍が溜まり続け、翌日の pull --ff-only も通らなくなって
  # 「ずっと動いていないように見える」状態に陥る。一度だけ rebase して押し直す。
  if ! git push -q origin main 2>/dev/null; then
    if git -c user.name="BubblesNow daily" -c user.email="noreply@localhost" \
         pull --rebase -q origin main 2>/dev/null && git push -q origin main 2>/dev/null; then
      echo "  心拍: rebase して push しました"
    else
      echo "  ⚠️ 心拍を push できませんでした（次回に持ち越します）"
    fi
  fi
}
trap heartbeat EXIT

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
  STATUS="異常終了（① X の収集）"
  echo "❌ 収集に失敗しました。選別には進みません。"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 異常終了 ==="
  exit 1
fi

# ── ①' Gmail から収集 ──
# 未設定なら丸ごと飛ばす。X だけでも成立するので、ここで止めない。
#
# 取り方が2通りある。mac/.env に書いてあるほうが選ばれる。
#   GMAIL_IMAP_ACCOUNTS  … アプリパスワード + IMAP。トークンが失効しない
#   GMAIL_REFRESH_TOKENS … OAuth。同意画面がテストモードだと7日で切れる
# 両方あれば IMAP を使う。切り替えは .env の書き換えだけで済み、
# 片方が Google 側の都合で使えなくなっても、もう片方に戻せる。
if [ -n "${GMAIL_IMAP_ACCOUNTS:-}" ]; then
  GMAIL_SCRIPT="scripts/collect-gmail-imap.mjs"
elif [ -n "${GMAIL_REFRESH_TOKENS:-}" ]; then
  GMAIL_SCRIPT="scripts/collect-gmail.mjs"
else
  GMAIL_SCRIPT=""
fi

if [ -n "$GMAIL_SCRIPT" ]; then
  echo ""
  echo "--- ①' Gmail から収集（$GMAIL_SCRIPT）---"
  if ! node "$GMAIL_SCRIPT"; then
    # 続行はする（X だけでも成立する）が、黙って続けない。
    # OAuth 同意画面がテストモードのままだとリフレッシュトークンは7日で切れる。
    # 切れても日次は「X だけ」で正常終了してしまうので、
    # ログを読む習慣が無い限り、連携が死んだことに何週間も気づけない。
    # 心拍の見出しに出して、GitHub を見れば分かる状態にする。
    GMAIL_WARN="（⚠️ Gmail の収集に失敗）"
    echo "  ⚠️ Gmail の収集に失敗しました。X の材料だけで続けます"
    echo "     invalid_grant なら docs/gmail-setup.md「失効したとき」を参照。"
    echo "     繰り返すなら、アプリパスワード + IMAP に切り替える手もあります。"
  fi
else
  echo ""
  echo "--- ①' Gmail は未設定のため省略（docs/gmail-setup.md）---"
fi

# ── ②' 学習 ──
# 昨日までの採用・却下から好みを学び直す。失敗しても選別は続ける
# （学習は「あれば効く」もので、無くても手書きの重みで動く）。
echo ""
echo "--- ②' 過去の採用・却下から学習 ---"
node scripts/learn-preferences.mjs || echo "  ⚠️ 学習に失敗しました。手書きの重みだけで選びます"

# ── ③ 選別・整形・反映 ──
echo ""
echo "--- ③ 選別・整形 ---"
if ! MODE="$MODE" node scripts/build-recs.mjs; then
  STATUS="異常終了（③ 選別・整形）"
  echo "❌ 選別・整形に失敗しました。"
  echo "   材料はあるので collected-x.json を見れば原因を追えます。"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 異常終了 ==="
  exit 1
fi

STATUS="正常終了"
echo ""
echo "=== $(date '+%Y-%m-%d %H:%M:%S') 正常終了 ==="
