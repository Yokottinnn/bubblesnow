#!/usr/bin/env python3
"""Stop フック: 選択肢を本文で聞いて終わろうとしたら差し戻す。

CLAUDE.md の最上位ルール「選択肢はダイアログで出す」は、文書に書くだけでは守られない
ことが実際に起きた（記録した直後に本文で二択を提示した）。そのため文書ではなく
フックで強制する。

終了しようとしたターンの最後の発言に疑問符が残っていて、かつそのターンで
AskUserQuestion を使っていなければ、終了指示（exit 2）で差し戻す。
差し戻された側は AskUserQuestion で聞き直すか、疑問符を消して言い切る以外に進めない。

安全側の設計:
  - 入力やトランスクリプトが読めない場合は素通しする（会話を壊さない）。
  - stop_hook_active が立っている再入時は素通しする（無限ループ防止）。
"""

import json
import re
import sys

PASS = 0
BLOCK = 2

# 疑問符の判定前に取り除く部分。コード中や引用中の「?」で誤検知しないため。
FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`]*`")
# 引用（> で始まる行）は利用者の発言や既存文書の再掲であって、こちらの問いかけではない。
QUOTE_LINE = re.compile(r"^\s*>.*$", re.MULTILINE)

QUESTION_MARKS = ("?", "？")

# 疑問符が無くても、次の判断を利用者に投げている合図。
# 「残っているのは A と B と C です」と本文に並べる形は、疑問符が無いため
# 疑問符だけの判定をすり抜けていた（実際に起きた）。それも違反として扱う。
DECISION_MARKERS = (
    "次のステップ", "次のアクション", "次にやること", "残件", "未完了",
    "残っている作業", "残っています", "保留中", "選択肢", "どちらか",
    "いずれか", "ご判断", "お選び", "選んでください", "決めてください",
    "進め方", "検討ください", "ご確認ください", "指示ください",
)

REMINDER = """CLAUDE.md 最上位ルール違反: 判断を本文で投げて終了しようとしている。

最後の発言に疑問符、または次の一手の提示（次のステップ・残件・未完了・選択肢など）が
含まれているのに、このターンで AskUserQuestion を使っていない。
このルールに例外は無い。次のどちらかを必ず行うこと。

1. 利用者に選ばせたいのなら、AskUserQuestion ツールのダイアログで提示し直す。
   推奨があれば先頭に置き、ラベルに「(推奨)」を付ける。
2. 選択を求めていないのなら、疑問符を使わず言い切る形に書き直す。

本文に「A か B か」「どうしますか」と書いて終わるのは禁止。
「残っているのは A と B です」と並べて相手に選ばせるのも、疑問符が無くても同じ違反。"""


def load_transcript(path):
    entries = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # 壊れた行は無視して読み進める
    return entries


def content_blocks(entry):
    message = entry.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [block for block in content if isinstance(block, dict)]
    return []


def is_real_user_message(entry):
    """利用者本人の発言なら True。tool_result の差し戻しは含めない。"""
    if entry.get("type") != "user":
        return False
    blocks = content_blocks(entry)
    if not blocks:
        return False
    return any(block.get("type") == "text" for block in blocks)


def current_turn(entries):
    """直近の利用者発言より後ろ（＝今のターン）を返す。"""
    for index in range(len(entries) - 1, -1, -1):
        if is_real_user_message(entries[index]):
            return entries[index + 1 :]
    return entries


def used_dialog(turn):
    for entry in turn:
        for block in content_blocks(entry):
            if block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion":
                return True
    return False


def final_assistant_text(turn):
    for entry in reversed(turn):
        if entry.get("type") != "assistant":
            continue
        texts = [
            block.get("text", "")
            for block in content_blocks(entry)
            if block.get("type") == "text"
        ]
        joined = "\n".join(texts).strip()
        if joined:
            return joined
    return ""


def defers_a_decision(text):
    """利用者に判断を投げているなら True。疑問符と、次の一手の提示の両方を見る。"""
    for pattern in (FENCED_CODE, INLINE_CODE, QUOTE_LINE):
        text = pattern.sub(" ", text)
    if any(mark in text for mark in QUESTION_MARKS):
        return True
    return any(marker in text for marker in DECISION_MARKERS)


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return PASS

    if payload.get("stop_hook_active"):
        return PASS  # 差し戻し直後の再入。ここで止めるとループする

    path = payload.get("transcript_path")
    if not path:
        return PASS

    try:
        entries = load_transcript(path)
    except OSError:
        return PASS

    turn = current_turn(entries)
    if used_dialog(turn):
        return PASS

    if defers_a_decision(final_assistant_text(turn)):
        print(REMINDER, file=sys.stderr)
        return BLOCK

    return PASS


if __name__ == "__main__":
    sys.exit(main())
