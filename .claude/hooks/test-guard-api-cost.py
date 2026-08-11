#!/usr/bin/env python3
"""guard-api-cost.py の検証。

  python3 .claude/hooks/test-guard-api-cost.py

課金コマンドを止め、通常の開発コマンドを妨げないことを確認する。
誤ってブロックしすぎると作業が止まり、緩すぎると課金が漏れる。両方を見る。
"""

import json
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "guard-api-cost.py"
ALLOW, BLOCK = 0, 2


def run(payload):
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )


def bash(command):
    return {"tool_name": "Bash", "tool_input": {"command": command}}


CASES = [
    # --- 止めるべきもの ---
    (BLOCK, "Anthropic API への curl", bash("curl https://api.anthropic.com/v1/messages -d @req.json")),
    (BLOCK, "APIキーを渡すスクリプト実行", bash("ANTHROPIC_API_KEY=sk-xxx python3 bench.py")),
    (BLOCK, "CLAUDE_API_KEY を使う検証", bash("CLAUDE_API_KEY=$KEY node scripts/dry-run.mjs")),
    (BLOCK, "OpenAI API への curl", bash("curl https://api.openai.com/v1/chat/completions")),
    (BLOCK, "Google Generative Language API", bash("curl https://generativelanguage.googleapis.com/v1/models")),
    (BLOCK, "Anthropic CLI の課金呼び出し", bash("ant messages create --model claude-opus-5")),
    (BLOCK, "パイプの後段が課金コマンド", bash("cat prompt.txt | curl -d @- https://api.anthropic.com/v1/messages")),
    (BLOCK, "&& の後段が課金コマンド", bash("npm run build && ANTHROPIC_API_KEY=x node eval.mjs")),
    (BLOCK, "OPENAI_API_KEY を使う実行", bash("OPENAI_API_KEY=sk-x python3 -c 'import openai'")),

    # --- 通すべきもの（読み取り・調査） ---
    (ALLOW, "キーの有無を env で確認", bash("env | grep ANTHROPIC_API_KEY")),
    (ALLOW, "設定ファイルを grep で調査", bash("grep -rn 'ANTHROPIC_API_KEY' --include='*.sh' .")),
    (ALLOW, "課金箇所をファイル一覧で確認", bash("rg -l 'api.anthropic.com' scripts/")),
    (ALLOW, "ドキュメントを読む", bash("cat docs/api-cost-guard.md")),

    # --- 通すべきもの（通常の開発） ---
    (ALLOW, "ビルド", bash("npm run build")),
    (ALLOW, "テスト", bash("npm run test:hooks")),
    (ALLOW, "git 操作", bash("git commit -m 'fix: something'")),
    (ALLOW, "画像レンダリング", bash("node scripts/social/render-square.mjs a.html b.png 1200 1200")),

    # --- 回帰: クォート内の | で区切ってしまい誤ブロックした実例 ---
    (ALLOW, "grep の正規表現に | を含む調査", bash(
        "grep -rlnE 'ANTHROPIC_API_KEY|CLAUDE_API_KEY|OPENAI_API_KEY|api\\.openai\\.com' . ")),
    (ALLOW, "rg の正規表現に | を含む調査", bash(
        "rg -l 'api\\.anthropic\\.com|api\\.openai\\.com' scripts/")),
    (ALLOW, "複数行スクリプトでの調査", bash(
        "echo '=== 調査 ==='\ngrep -rn 'ANTHROPIC_API_KEY|OPENAI_API_KEY' --include='*.sh' .\necho done")),
    (BLOCK, "クォート内 | があっても実行は止める", bash(
        "grep -l 'a|b' . && ANTHROPIC_API_KEY=x node run.mjs")),

    # --- 安全側（判定できないものは通す） ---
    (ALLOW, "Bash 以外のツール", {"tool_name": "Read", "tool_input": {"file_path": "/x"}}),
    (ALLOW, "tool_input が無い", {"tool_name": "Bash"}),
    (ALLOW, "command が空", bash("   ")),
]


def main():
    failures = 0
    for expected, name, payload in CASES:
        result = run(payload)
        ok = result.returncode == expected
        note = ""
        if expected == BLOCK and ok and "最上位ルール 2" not in result.stderr:
            ok, note = False, " (差し戻し文にルール参照が無い)"
        print(f"{'  OK  ' if ok else ' FAIL '} {name}{note}")
        if not ok:
            failures += 1
            print(f"        expected exit={expected}, got exit={result.returncode}")
            if result.stderr:
                print(f"        stderr: {result.stderr.strip()[:160]}")

    total = len(CASES)
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
