# API 課金を事前確認なしに発生させない仕組み

## なぜ仕組みが要るのか

Console 経由の API 課金は、リサーチや動作確認の一環として**気軽に発生させてしまいやすい**。
「ちょっと試すだけ」の一回が実費になる。利用者の許可なくそれを起こさないため、
`CLAUDE.md` の最上位ルール 2 として明文化したうえで、実行の直前で機械的に止める。
**止めるのは「禁止するため」ではなく「見積もりと許可を先に挟むため」。**

文書に書くだけでは守られないことは、ダイアログのルールで実証済み
（[`docs/dialog-rule-enforcement.md`](./dialog-rule-enforcement.md) 参照）。同じ轍を踏まない。

## 何が対象で、何が対象外か

| | 例 | 扱い |
| --- | --- | --- |
| **対象** | `ANTHROPIC_API_KEY` を使うスクリプト、`api.openai.com` への curl、`ant messages` | **事前確認が必要** |
| **対象外** | Claude Code / Cowork の対話そのもの | プラン利用のため確認不要 |
| **対象外** | `npm run build`、`git`、画像生成などの通常作業 | 課金と無関係 |

この対話自体はサブスクリプションの枠内で動いており、Console には請求されない。
混同すると通常の作業まで止まるため、ガードは Console 課金だけを見ている。

## 仕組み

`PreToolUse` フック `.claude/hooks/guard-api-cost.py` が Bash コマンドを実行**前**に検査し、
課金の目印を見つけると `exit 2` で実行そのものをブロックする。標準エラー出力が
指示として渡り、確認を取るか課金しない方法に切り替えるまで先に進めない。

検出する目印:

- **課金エンドポイント** — `api.anthropic.com` / `api.openai.com` /
  `generativelanguage.googleapis.com` / `aiplatform.googleapis.com` /
  `bedrock-runtime` / `api.mistral.ai` / `api.cohere.ai`
- **API キー** — `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`
- **課金 CLI** — `ant messages` / `ant beta:` / `openai api`

パイプや `&&` で連結された場合も、**区切りごとに**実際に実行されるコマンドを見る。
`npm run build && ANTHROPIC_API_KEY=x node eval.mjs` は後段で止まる。

### 調査まで止めないための例外

`grep` や `cat` や `env` などの読み取り専用コマンドは、課金キーの名前を含んでいても通す。
`env | grep ANTHROPIC_API_KEY` でキーの有無を確認する行為まで止めると、
そもそも課金リスクの調査ができなくなる。環境変数代入（`FOO=bar cmd`）は読み飛ばし、
実際に起動されるコマンド名で判定する。

### 安全側に倒している箇所

作業そのものを壊さないよう、判断できない場合は素通しする。

- 標準入力が JSON として読めない
- `tool_name` が `Bash` 以外
- `command` が無い、または空

## 検証

**フックが黙って壊れると「守られているつもり」になる。変更したら必ず実行する。**

```bash
python3 .claude/hooks/test-guard-api-cost.py
```

24 ケースを検証する。**止めるべき場面**（各社 API への curl、キーを渡した実行、
パイプや `&&` の後段）と、**通すべき場面**（読み取り調査、通常のビルド・テスト・git、
判定不能時）の両方を含む。誤ってブロックしすぎると作業が止まるため、後者も同じ重みで見る。

## このリポジトリ固有の落とし穴

`scripts/generate-recs.mjs` は書き込み判定より**前**に Anthropic API を呼ぶ。
`dry-run` がスキップするのは Firebase への書き込みだけで、**API 課金は発生する**。
「dry run だから無料」という思い込みが最も危険なので、ここを最初に疑うこと。
無料なのは `validate` だけ。

**失敗しても課金は戻らない。** 実際に2回、払ったのに成果ゼロで終わっている。

| 日付 | 失敗 | 対策 |
| --- | --- | --- |
| 2026-08-13 | 出力が `max_tokens` (8000) に達して JSON が途中で切れた（約$0.39） | 上限を 24000 に。切れた配列からは完成分だけ救出する |
| 2026-08-14 | `UND_ERR_HEADERS_TIMEOUT`。ちょうど5分で切断 | ストリーミングで受ける |

2件目は Node の `fetch`（undici）が応答ヘッダを 300 秒しか待たないために起きた。
非ストリーミングだと生成が終わるまでヘッダが返らないので、出力が長いほど確実に踏む。
**`stream: true` は速度のためではなく、待ち時間で落として課金を捨てないため。**

どちらの対策も、課金の伴う経路でしか動かない。壊れても気づけないので、
`MODE=validate` が見本データで毎回検証する（切れたJSONの救出・SSEの組み立て）。

| 項目 | 値 |
| --- | --- |
| モデル | `claude-opus-5`（$5 / $25 per MTok） |
| `max_tokens` | 24000 |
| web検索 | `web_search_20260209` を最大 8 回（$10 / 1,000 検索） |
| 1回あたりの目安 | **$0.8〜$1.8** |
| 日次実行した場合 | **月 $24〜$54** |

設計書v2 が指定していた `claude-sonnet-4-20250514` は既に存在せず、404 で落ちる
（この 404 では課金は発生しない）。`CLAUDE_MODEL` で上書きでき、
`claude-sonnet-5` なら 1 回 **$0.4〜$0.8** 程度に下がる。

`.github/workflows/daily-recs.yml` の `schedule:` は現在コメントアウト済み。
有効化する前に見積もりを提示して承認を得ること。
