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

# ★閾値を 300 秒から下げた理由★
# 実測すると、サーバ側のセッションが約12時間ごとに入れ替わり、そのたびに
# 2分20秒ほど切断される（13回の記録で間隔は 12.1 / 11.4 / 12.0 / 13.5 時間）。
# スリープでもローカルのネットワークでもない（caffeinate がスリープを抑止して
# おり、切断時刻の前後5分に Wi-Fi・DHCP・DNS いずれの記録も無い）。
#
# 問題は切断そのものより、復帰までの待ち方にある。再試行の間隔は
#   2.4s → 4.4s → 6.1s → 19.9s → 32.4s → 74.3s（合計 ≈ 139秒）
# と指数的に伸びる。つまり実際に繋がらないのは数十秒で、残り1分20秒は
# クライアントが黙って待っているだけ。この間スマホからは offline に見える。
#
# 300秒では一度も発火しなかった（2分20秒で自動復旧してしまうため）。
# 長い待ちに入る前に叩き起こす。
STALE_SEC="${STALE_SEC:-60}"    # 切断が続いてよい上限（秒）

# ★再起動の冷却時間★
# kickstart -k はプロセスを殺すので、そのフォルダで動いている作業も一緒に
# 消える。サーバ側が本当に落ちている間に繰り返し叩くと、復旧するまで
# 再起動を続けてしまう。一度叩いたらこの秒数は手を出さない。
KICK_COOLDOWN="${KICK_COOLDOWN:-300}"
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

# ★正常時は黙る★
# 30秒おきに回すので、毎回「接続中」と書くと1日2,880行たまって
# 肝心の切断の記録が埋もれる。状態が前回と変わったときだけ記録する。
note() {  # note <label> <state> <message>
  local lbl="$1" st="$2" msg="$3" f="/tmp/remote-watchdog-${1}.state" prev=""
  [ -f "$f" ] && prev=$(cat "$f" 2>/dev/null)
  echo "$st" > "$f"
  [ "$st" = "$prev" ] && return 0   # 同じ状態が続いている間は書かない
  log "$msg"
}

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

# 監視役自身のログも切り詰める。30秒おきに回るぶん、これを入れないと
# 見張る側が肥大する。
rotate "/Users/ny/bubblesnow/mac/logs/watchdog.log"

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
    note "$label" ok "ok    $label (接続中)"
    rm -f "/tmp/remote-watchdog-${label}.since"
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
      kickmark="/tmp/remote-watchdog-${label}.kicked"
      last_kick=0
      [ -f "$kickmark" ] && last_kick=$(cat "$kickmark" 2>/dev/null || echo 0)
      if [ $(( now - last_kick )) -lt "$KICK_COOLDOWN" ]; then
        log "hold  $label: 切断中 ${stuck}秒だが、$(( now - last_kick ))秒前に再起動済み（冷却中）"
      else
        # 再起動は必ず残す。状態変化の抑制に巻き込むと記録が消える。
        log "KICK  $label: ${stuck}秒 切断が継続 → 強制再起動"
        launchctl kickstart -k "gui/${uid}/${label}" 2>&1 | sed 's/^/        /'
        echo "$now" > "$kickmark"
        rm -f "$marker"
      fi
    else
      note "$label" cut "watch $label: 切断を検知（${STALE_SEC}秒続いたら再起動）"
    fi
    continue
  fi

  # Ready でも Reconnecting でもない。長時間無更新なら異常。
  rm -f "/tmp/remote-watchdog-${label}.since"
  if [ "$age" -ge "$STALE_SEC" ]; then
    log "KICK  $label: ログが${age}秒更新なし → 強制再起動"
    launchctl kickstart -k "gui/${uid}/${label}" 2>&1 | sed 's/^/        /'
  else
    note "$label" unknown "ok    $label (状態不明だがログは新しい: ${age}秒前)"
  fi
done
