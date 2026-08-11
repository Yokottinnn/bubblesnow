#!/usr/bin/env python3
"""enforce-dialog.py の検証。

  python3 .claude/hooks/test-enforce-dialog.py

差し戻すべき場面で差し戻し、素通しすべき場面で素通しすることを確認する。
フックが黙って壊れると「守られているつもり」になるため、変更時は必ず実行する。
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "enforce-dialog.py"
PASS, BLOCK = 0, 2


def user(text):
    return {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}


def assistant(*blocks):
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def text(value):
    return {"type": "text", "text": value}


def dialog():
    return {"type": "tool_use", "name": "AskUserQuestion", "id": "t1", "input": {}}


def tool_use(name):
    return {"type": "tool_use", "name": name, "id": "t2", "input": {}}


def tool_result():
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2"}]}}


def run(entries, *, stop_hook_active=False, transcript=True, raw_lines=None):
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as handle:
        if raw_lines is not None:
            handle.write(raw_lines)
        else:
            for entry in entries:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        path = handle.name

    payload = {"hook_event_name": "Stop", "stop_hook_active": stop_hook_active}
    if transcript:
        payload["transcript_path"] = path

    result = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    Path(path).unlink(missing_ok=True)
    return result


CASES = []


def case(name, expected, **kwargs):
    def register(build):
        CASES.append((name, expected, build, kwargs))
        return build

    return register


@case("本文で二択を提示したら差し戻す", BLOCK)
def _():
    return [user("画像を作って"), assistant(text("A. すぐ着手する\nB. Slack を直してから\n\nどちらにしますか？"))]


@case("ダイアログを使っていれば通す", PASS)
def _():
    return [user("画像を作って"), assistant(dialog()), assistant(text("承知しました。進めます。"))]


@case("疑問符が無い言い切りは通す", PASS)
def _():
    return [user("状況は"), assistant(text("PR #147 をマージしました。次は画像生成に着手します。"))]


@case("英語の疑問符も差し戻す", BLOCK)
def _():
    return [user("go"), assistant(text("Should I create a PR?"))]


@case("再入時（stop_hook_active）は通す", PASS, stop_hook_active=True)
def _():
    return [user("画像を作って"), assistant(text("どちらにしますか？"))]


@case("コードブロック内の疑問符は無視する", PASS)
def _():
    body = "次のコマンドで確認できます。\n\n```bash\ncurl 'https://example.com/?a=1'\n```"
    return [user("確認方法は"), assistant(text(body))]


@case("インラインコード内の疑問符は無視する", PASS)
def _():
    return [user("確認方法は"), assistant(text("`git log --oneline?` ではなく `git log` を使います。"))]


@case("引用行の疑問符は無視する", PASS)
def _():
    return [user("何と言われた"), assistant(text("利用者の発言:\n\n> これで良いですか？\n\n上記に対応済みです。"))]


@case("ツール実行を挟んでもターン内のダイアログを検出する", PASS)
def _():
    return [
        user("画像を作って"),
        assistant(dialog()),
        assistant(tool_use("Bash")),
        tool_result(),
        assistant(text("完了しました。追加はありますか？")),
    ]


@case("前ターンのダイアログは今ターンに流用されない", BLOCK)
def _():
    return [
        user("前の依頼"),
        assistant(dialog()),
        assistant(text("対応しました。")),
        user("次の依頼"),
        assistant(text("どうしますか？")),
    ]


@case("回帰: 未完了の作業を本文に並べたら差し戻す（疑問符なし）", BLOCK)
def _():
    body = ("同期完了しました。\n\n## 未完了の作業\n\n"
            "**① home-mac の復旧**\n**② 画像の Slack 掲載**\n**③ 日次バッチの有効化**")
    return [user("状況は"), assistant(text(body))]


@case("回帰: 「次のステップ」の提示も差し戻す", BLOCK)
def _():
    return [user("done"), assistant(text("マージしました。\n\n## 次のステップ\n\n- 記事を書く\n- 公開する"))]


@case("回帰: 「ご判断」を仰ぐ形も差し戻す", BLOCK)
def _():
    return [user("状況は"), assistant(text("有効化のご判断が必要になったタイミングでお伺いします。"))]


@case("判断を求めない完了報告は通す", PASS)
def _():
    return [user("やって"), assistant(text("main にマージしました。CI は success、テストは 36/36 通過しています。"))]


@case("判断マーカーを含んでもダイアログ済みなら通す", PASS)
def _():
    return [user("状況は"), assistant(dialog()), assistant(text("未完了の作業を上のダイアログで挙げました。"))]


@case("引用内の判断マーカーは無視する", PASS)
def _():
    return [user("何と言われた"), assistant(text("記録の再掲:\n\n> 次のアクション: 記事を書く\n\n以上を反映済みです。"))]


@case("transcript_path が無ければ通す", PASS, transcript=False)
def _():
    return [user("x"), assistant(text("どうしますか？"))]


@case("壊れた行が混ざっても判定できる", BLOCK, raw_lines="".join([
    json.dumps(user("画像を作って"), ensure_ascii=False) + "\n",
    "{壊れた JSON\n",
    "\n",
    json.dumps(assistant(text("どちらにしますか？")), ensure_ascii=False) + "\n",
]))
def _():
    return []


def main():
    failures = 0
    for name, expected, build, kwargs in CASES:
        result = run(build(), **kwargs)
        ok = result.returncode == expected
        if expected == BLOCK and ok and "AskUserQuestion" not in result.stderr:
            ok = False
            note = " (差し戻し文に AskUserQuestion の指示が無い)"
        else:
            note = ""
        print(f"{'  OK  ' if ok else ' FAIL '} {name}{note}")
        if not ok:
            failures += 1
            print(f"        expected exit={expected}, got exit={result.returncode}")
            if result.stderr:
                print(f"        stderr: {result.stderr.strip()[:200]}")

    total = len(CASES)
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
