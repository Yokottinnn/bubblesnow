#!/usr/bin/env bash
# 「選択肢はダイアログで出す」ルールを、このリポジトリだけでなく
# ユーザー全体（~/.claude）に効かせるためのインストーラ。
#
# ★なぜ必要なのか★
# クラウドのセッションはコンテナが使い捨てで、~/.claude はセッション開始のたびに
# 作り直される。そこへ直接書いても次回には消える。一方リポジトリは毎回 clone される。
# そこで正本をリポジトリ（.claude/global/）に置き、SessionStart で ~/.claude へ入れ直す。
#
# ★壊さない★
# 既に ~/.claude/settings.json があっても上書きせず、hooks だけを混ぜる。
# 同じ command のフックが既にあれば足さないので、何度流しても増殖しない。
# 判断できないときは何もしない（設定を壊すより、入らないほうがまし）。
#
# 手動で流す場合: bash .claude/install-global-rules.sh

set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.claude"

mkdir -p "$DEST/hooks" 2>/dev/null || exit 0

# 1) 最上位ルールの文書。~/.claude/CLAUDE.md は全プロジェクトで読まれる。
if [ -f "$SRC/global/CLAUDE.md" ]; then
  if ! cmp -s "$SRC/global/CLAUDE.md" "$DEST/CLAUDE.md" 2>/dev/null; then
    # 別内容の CLAUDE.md が既にあるなら、消さずに退避してから置く
    if [ -f "$DEST/CLAUDE.md" ] && ! grep -q "最上位ルール（全プロジェクト共通・例外なし）" "$DEST/CLAUDE.md" 2>/dev/null; then
      cp "$DEST/CLAUDE.md" "$DEST/CLAUDE.md.bak.$(date +%s)" 2>/dev/null
    fi
    cp "$SRC/global/CLAUDE.md" "$DEST/CLAUDE.md" && echo "[install-global-rules] ~/.claude/CLAUDE.md を更新"
  fi
fi

# 2) Stop フック本体（ダイアログを出さずに終わろうとしたら差し戻す）
for f in enforce-dialog.py test-enforce-dialog.py; do
  [ -f "$SRC/hooks/$f" ] && cp "$SRC/hooks/$f" "$DEST/hooks/$f" 2>/dev/null && chmod +x "$DEST/hooks/$f" 2>/dev/null
done

# 3) settings.json の hooks を混ぜる
NEW="$SRC/global/settings.json"
[ -f "$NEW" ] || exit 0

if [ ! -f "$DEST/settings.json" ]; then
  cp "$NEW" "$DEST/settings.json" && echo "[install-global-rules] ~/.claude/settings.json を作成"
  exit 0
fi

command -v python3 >/dev/null 2>&1 || {
  echo "[install-global-rules] python3 が無いため既存の settings.json はそのままにしました" >&2
  exit 0
}

python3 - "$DEST/settings.json" "$NEW" <<'PY'
import json, sys, shutil, time

dest_path, new_path = sys.argv[1], sys.argv[2]

try:
    with open(dest_path, encoding="utf-8") as f:
        dest = json.load(f)
    with open(new_path, encoding="utf-8") as f:
        new = json.load(f)
except Exception as e:
    # 読めない・壊れている場合は触らない。設定を壊すより入らないほうがまし。
    print(f"[install-global-rules] 読み取りに失敗したため変更していません: {e}", file=sys.stderr)
    sys.exit(0)

if not isinstance(dest, dict) or not isinstance(new, dict):
    sys.exit(0)

added = []

def commands(groups):
    """フックグループの配列から、実際に走る command を全部集める。"""
    out = set()
    for g in groups or []:
        for h in (g or {}).get("hooks") or []:
            c = (h or {}).get("command")
            if c:
                out.add(c)
    return out

# permissions は「未設定なら入れる／既存があれば allow を足すだけ」。
# 既に絞り込んだ設定をしている人の意図を消さないよう、defaultMode は上書きしない。
new_perms = new.get("permissions") or {}
if new_perms:
    dp = dest.setdefault("permissions", {})
    if "defaultMode" not in dp and new_perms.get("defaultMode"):
        dp["defaultMode"] = new_perms["defaultMode"]
        added.append("permissions.defaultMode")
    if new_perms.get("allow"):
        cur = dp.setdefault("allow", [])
        for a in new_perms["allow"]:
            if a not in cur:
                cur.append(a)
                added.append("permissions.allow")

dest_hooks = dest.setdefault("hooks", {})

for event, incoming in (new.get("hooks") or {}).items():
    current = dest_hooks.get(event) or []
    have = commands(current)
    for group in incoming or []:
        # そのグループの command が1つでも未登録なら足す。全部あるなら飛ばす。
        cmds = commands([group])
        if cmds and cmds <= have:
            continue
        current.append(group)
        have |= cmds
        added.append(event)
    dest_hooks[event] = current

if not added:
    print("[install-global-rules] 既に入っています（変更なし）")
    sys.exit(0)

try:
    shutil.copy(dest_path, f"{dest_path}.bak.{int(time.time())}")
    with open(dest_path, "w", encoding="utf-8") as f:
        json.dump(dest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"[install-global-rules] ~/.claude/settings.json に追加: {', '.join(sorted(set(added)))}")
except Exception as e:
    print(f"[install-global-rules] 書き込みに失敗しました: {e}", file=sys.stderr)
PY

exit 0
