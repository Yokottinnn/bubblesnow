#!/usr/bin/env python3
"""PreToolUse フック: API 課金が発生しうるコマンドの実行を止める。

CLAUDE.md の最上位ルール 2「API 課金が発生する操作は必ず事前確認」を強制する。
文書に書くだけでは守られない前例があるため、実行の直前で機械的に止める。

止めるのは Console 経由で費用が発生しうる呼び出しだけ。Claude のサブスクリプション
枠内で動く対話そのものは対象外で、通常の開発コマンドも一切妨げない。

安全側の設計:
  - 入力が読めない場合は素通しする（作業を壊さない）。
  - grep や cat などの読み取り専用コマンドは、課金キーの名前を含んでいても通す。
    調査のために設定を覗く行為まで止めると、確認作業そのものができなくなる。
"""

import json
import re
import shlex
import sys

ALLOW = 0
BLOCK = 2

# 課金が発生する呼び出しの目印。エンドポイント・APIキー・課金CLI。
BILLABLE = [
    (r"api\.anthropic\.com", "Anthropic API エンドポイント"),
    (r"api\.openai\.com", "OpenAI API エンドポイント"),
    (r"generativelanguage\.googleapis\.com", "Google Generative Language API"),
    (r"aiplatform\.googleapis\.com", "Google Vertex AI"),
    (r"bedrock[-.]runtime", "Amazon Bedrock"),
    (r"api\.mistral\.ai", "Mistral API"),
    (r"api\.cohere\.(ai|com)", "Cohere API"),
    (r"\bANTHROPIC_API_KEY\b", "Anthropic APIキー"),
    (r"\bCLAUDE_API_KEY\b", "Claude APIキー"),
    (r"\bANTHROPIC_AUTH_TOKEN\b", "Anthropic 認証トークン"),
    (r"\bOPENAI_API_KEY\b", "OpenAI APIキー"),
    (r"\b(GEMINI|GOOGLE)_API_KEY\b", "Google APIキー"),
    (r"\bant\s+(messages|beta:)", "Anthropic CLI の課金エンドポイント呼び出し"),
    (r"\bopenai\s+api\b", "OpenAI CLI"),
]

# 中身を読むだけのコマンド。課金キーの名前を含んでも実行はしないので通す。
READ_ONLY = {
    "grep", "rg", "cat", "head", "tail", "less", "more", "ls", "find", "wc",
    "git", "jq", "diff", "stat", "file", "env", "printenv", "which", "type",
    "echo", "printf", "awk", "sed", "sort", "uniq", "tr", "cut", "basename",
    "dirname", "realpath", "test", "true", "false",
}

SEPARATORS = ("&&", "||")
SEPARATOR_CHARS = "|;\n"


def split_segments(command):
    """パイプや連結で区切る。ただしクォートの内側は区切らない。

    素朴に正規表現で `|` を割ると、grep の正規表現 'A|B' のような
    クォート内の `|` まで区切ってしまい、壊れた断片が読み取り専用judgeを
    すり抜けて誤ブロックになる（実際に起きた）。
    """
    segments, buf, quote, i = [], [], None, 0
    while i < len(command):
        char = command[i]
        if quote:
            buf.append(char)
            if char == quote:
                quote = None
            elif char == "\\" and quote == '"' and i + 1 < len(command):
                i += 1
                buf.append(command[i])
            i += 1
            continue
        if char in ("'", '"'):
            quote = char
            buf.append(char)
            i += 1
            continue
        if char == "\\" and i + 1 < len(command):
            buf.append(char)
            i += 1
            buf.append(command[i])
            i += 1
            continue
        if any(command.startswith(sep, i) for sep in SEPARATORS):
            segments.append("".join(buf))
            buf = []
            i += 2
            continue
        if char in SEPARATOR_CHARS:
            segments.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(char)
        i += 1
    segments.append("".join(buf))
    return segments

NOTICE = """CLAUDE.md 最上位ルール 2: API 課金が発生しうるコマンドを実行しようとしている。

検出: {reason}
対象: {segment}

**これは禁止ではない。** 費用がかかること自体は問題ない。防ぐべきなのは、
利用者が知らないところで費用が発生することだけ。順序を守れば実行してよい。

1. 先に見積もる。使うモデル・想定トークン数・単価から概算を出す。
   料金が分からなければ claude-api スキルを読むか、公式の料金ページを参照する。
2. AskUserQuestion のダイアログで「何のために、いくらかかる見込みか」を提示して許可を得る。
3. 許可を得てから、このコマンドを実行し直す。

見積もりが立てられない場合は、その旨を伝えて判断を仰ぐこと。黙って実行しない。
なお Claude Code / Cowork の対話そのものはプラン利用であり、このルールの対象外。"""


def leading_command(segment):
    """区切りの中で実際に実行されるコマンド名を返す。環境変数代入は読み飛ばす。"""
    try:
        tokens = shlex.split(segment)
    except ValueError:
        # クォートが閉じていない等。空白区切りで拾い直す。
        tokens = [t.strip("'\"") for t in segment.split()]
    for token in tokens:
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", token):
            continue  # FOO=bar cmd の形
        return token.rsplit("/", 1)[-1]
    return None


def find_violation(command):
    for segment in split_segments(command):
        segment = segment.strip()
        if not segment:
            continue
        for pattern, reason in BILLABLE:
            if not re.search(pattern, segment):
                continue
            if leading_command(segment) in READ_ONLY:
                break  # 読み取りだけ。この区切りは問題なし
            return reason, segment
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return ALLOW

    if payload.get("tool_name") != "Bash":
        return ALLOW

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return ALLOW

    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return ALLOW

    found = find_violation(command)
    if found:
        reason, segment = found
        print(NOTICE.format(reason=reason, segment=segment.strip()), file=sys.stderr)
        return BLOCK

    return ALLOW


if __name__ == "__main__":
    sys.exit(main())
