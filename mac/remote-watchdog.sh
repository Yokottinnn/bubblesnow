#!/bin/bash
# Remote Control のゾンビ状態を検知して叩き起こす。
#
# なぜ必要か:
#   launchd の KeepAlive は「プロセスが終了したとき」しか再起動しない。
#   ところが Remote Control は 403 などで接続が恒久的に閉じても
#   プロセス自体は生きたまま Reconnecting を延々と繰り返す。
#   この状態は KeepAlive では検知できず、一覧上は offline のまま戻らない。
#   実際に PID 919 が生きているのに BubblesNow (Mac) が offline になっていた。
#
# やること:
#   各ジョブの out.log の末尾を見て、接続中を示す印が無く、かつ
#   切断状態が STALE_SEC 以上続いていたら launchctl kickstart -k で強制再起動する。
#
# 判定の考え方:
#   健全なときは末尾に "Ready ·" か "Connected ·" が出る。
#   死んでいるときは "Reconnecting" や "disconnected" だけが並ぶ。
#   ログが長時間更新されない場合も異常とみなす（スピナーすら回っていない）。

set -uo pipefail

STALE_SEC="${STALE_SEC:-300}"   # 切断が続いてよい上限（秒）
TAIL_BYTES=4000                 # 末尾の判定に使うバイト数

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# label:logpath の組
JOBS=(
  "com.bubblesnow.remote:/Users/ny/bubblesnow/mac/logs/remote.out.log"
  "com.bubblesnow.remote.daily-hack:/Users/ny/Library/Logs/claude-remote/daily-hack.out.log"
  "com.bubblesnow.remote.daily-hack-blog:/Users/ny/Library/Logs/claude-remote/daily-hack-blog.out.log"
)

now=$(date +%s)
uid=$(id -u)

# --- ログの上限管理 -------------------------------------------------------
# Reconnecting のスピナー再描画が延々と書き込まれるため放置すると際限なく育つ。
# 実測で remote.out.log が 149MB、daily-hack.out.log が 84MB まで膨らんでいた。
# 上限を超えたら直近だけ残して切り詰める（launchd が掴んだままの fd を壊さない
# よう、ファイルを差し替えずに in-place で切り詰める）。
MAX_BYTES="${MAX_BYTES:-20971520}"   # 20MB
KEEP_BYTES="${KEEP_BYTES:-2097152}"  # 切り詰め後に残す末尾 2MB

rotate() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size
  size=$(stat -f %z "$f")
  [ "$size" -le "$MAX_BYTES" ] && return 0
  local tmp="${f}.trim"
  tail -c "$KEEP_BYTES" "$f" > "$tmp" 2>/dev/null || return 0
  # cat で書き戻すことで inode を維持する。> だけだと追記中のプロセスが
  # 古い fd を持ち続けてファイルサイズが戻らない。
  cat "$tmp" > "$f"
  rm -f "$tmp"
  log "trim  $(basename "$f"): ${size} → $(stat -f %z "$f") bytes"
}

for job in "${JOBS[@]}"; do
  label="${job%%:*}"
  logfile="${job#*:}"

  # そもそもロードされていないジョブは対象外（意図的に外している場合がある）
  # launchctl list は「PID<TAB>status<TAB>label」。ラベル列の完全一致で見る。
  # grep -q は一致した時点で終了するので launchctl が SIGPIPE で落ち、
  # pipefail がそれを失敗として伝播して誤判定する。入力を読み切る awk を使う。
  if ! launchctl list | awk -v l="$label" '$3 == l { found = 1 } END { exit !found }'; then
    log "skip  $label (未ロード)"
    continue
  fi

  if [ ! -f "$logfile" ]; then
    log "WARN  $label: ログが無い ($logfile)"
    continue
  fi

  # 判定より先に切り詰める（tail する対象を小さく保つ）
  rotate "$logfile"
  rotate "${logfile%.out.log}.err.log"

  mtime=$(stat -f %m "$logfile")
  age=$(( now - mtime ))
  tailtxt=$(tail -c "$TAIL_BYTES" "$logfile" | tr -d '\000')

  # 末尾に接続中の印があれば健全
  if grep -qE "(Ready|Connected) ·" <<<"$tailtxt"; then
    log "ok    $label (接続中)"
    continue
  fi

  # 切断中。どれくらい続いているかで判断する。
  # スピナーが回っている間は mtime が更新され続けるので mtime だけでは測れない。
  # 初めて切断を見た時刻をマーカーに記録し、そこからの経過で判定する。
  if grep -qE "Reconnecting|disconnected" <<<"$tailtxt"; then
    # 切断表示が出ている。ログ末尾が STALE_SEC 以上更新されていない、
    # もしくはスピナーが回り続けているなら、再接続に失敗し続けているとみなす。
    marker="/tmp/remote-watchdog-${label}.since"
    if [ -f "$marker" ]; then
      since=$(cat "$marker" 2>/dev/null || echo "$now")
    else
      since="$now"
      echo "$since" > "$marker"
    fi
    stuck=$(( now - since ))
    if [ "$stuck" -ge "$STALE_SEC" ]; then
      log "KICK  $label: ${stuck}秒 切断が継続 → 強制再起動"
      launchctl kickstart -k "gui/${uid}/${label}" 2>&1 | sed 's/^/        /'
      rm -f "$marker"
    else
      log "watch $label: 切断中 ${stuck}秒（${STALE_SEC}秒で再起動）"
    fi
    continue
  fi

  # Ready でも Reconnecting でもない。長時間無更新なら異常。
  rm -f "/tmp/remote-watchdog-${label}.since"
  if [ "$age" -ge "$STALE_SEC" ]; then
    log "KICK  $label: ログが${age}秒更新なし → 強制再起動"
    launchctl kickstart -k "gui/${uid}/${label}" 2>&1 | sed 's/^/        /'
  else
    log "ok    $label (状態不明だがログは新しい: ${age}秒前)"
  fi
done
