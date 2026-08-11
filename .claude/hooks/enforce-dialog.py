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

# 差し戻された後、検知語だけ避けて書き直す回避が実際に起きた。
# 「残件」を消して「〜まで進みません」、「どうしますか」を消して
# 「連絡をもらえた時点で再開します」と言い換えたが、
# 残作業がある状態でダイアログを出していない点は何も変わっていない。
# 待ち・保留を表明する形も、待つこと自体が利用者の選択なので同じ違反として扱う。
DEFERRAL_MARKERS = (
    "進みません", "進められません", "着手できません", "できない状態",
    "再開します", "再開する", "待ちです", "待ちます", "待っています",
    "待ち状態", "教えてください", "お知らせください", "ご連絡",
    "連絡をもらえ", "連絡をいただけ", "復旧したら", "復旧後に",
    "動くまで", "整い次第", "タイミングで",
)

REMINDER = """CLAUDE.md 最上位ルール違反: 残作業がある状態で、ダイアログを出さずに終了しようとしている。

最後の発言に疑問符、次の一手の提示（次のステップ・残件・未完了・選択肢など）、
または待ちの表明（〜まで進みません／連絡をもらえたら再開します など）が含まれているのに、
このターンで AskUserQuestion を使っていない。

**やることは一つ。AskUserQuestion で次の一手を提示すること。**
推奨があれば先頭に置き、ラベルに「(推奨)」を付ける。

検知語を避けて書き直すのは違反である。この差し戻しは「書き方を直せ」ではなく
「ダイアログを出せ」という指示。過去に「残件」を消して「〜まで進みません」と
言い換えた回避が実際に起きており、それも同じ違反として扱う。

他者・外部イベント待ちで止まる場合も同じ。待つこと自体が選択なので、
待つ以外の道（別手段・先に別作業・中止）を選べる形でダイアログに出すこと。

本文だけで終わってよいのは、残作業がゼロで利用者が次に何も決めなくてよいときに限る。"""


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
    """利用者に判断を投げているなら True。

    三本立てで見る。
      1. 疑問符
      2. 次の一手を提示する語（残件・次のステップなど）
      3. 待ち・保留を表明する語（〜まで進みません、連絡をもらえたら再開します など）

    3 は 1・2 を避けて書き直す回避への対処。待つこと自体が選択であり、
    残作業がある以上ダイアログで出すべき場面であることは変わらない。
    """
    for pattern in (FENCED_CODE, INLINE_CODE, QUOTE_LINE):
        text = pattern.sub(" ", text)
    if any(mark in text for mark in QUESTION_MARKS):
        return True
    if any(marker in text for marker in DECISION_MARKERS):
        return True
    return any(marker in text for marker in DEFERRAL_MARKERS)


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
