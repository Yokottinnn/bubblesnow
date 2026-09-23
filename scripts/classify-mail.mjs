// 届いたメールを LLM に読ませて「対応が要るか」「お得か」を判定する。
//
// ★なぜ作ったか★
// もともとは件名のキーワード照合だけで判定していた。その結果、
// 「【9月29日まで】ディズニー・クルーズラインの残金お支払い期日」が
// 丸ごと落ちた（2026-09-23 に発覚）。許可語に「支払」が無かったためで、
// 語を足しても次は別の言い回しで落ちる。語の一覧を育て続けるやり方には
// 上限がある。本文を読んで意味で判断させる。
//
// ★MODE で挙動が変わる。「読むだけ＝無料」ではない点に注意★
//   MODE=validate（既定）… **API を一切呼ばない。課金 $0。**
//                            プロンプト組み立てと、見本レスポンス
//                            （data/sample-mail-verdicts.json）を使った
//                            抽出・正規化までを検証する。APIキーも不要。
//   MODE=live             … 実際に API を呼ぶ（**課金あり**）。
//
// ★プライバシー★
// このリポジトリは public で、Actions のログも公開される。
// メールの件名・本文は絶対に標準出力へ出さないこと。件数と判定の内訳に留める。
//
// 実行: MODE=validate node scripts/classify-mail.mjs

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const MODES = ['validate', 'live'];
export const MODE = String(process.env.MODE || 'validate').toLowerCase();
if (!MODES.includes(MODE)) {
  console.error(`MODE が不正です: "${MODE}"（使えるのは ${MODES.join(' / ')}）`);
  process.exit(1);
}
const CALLS_API = MODE !== 'validate';

// モデルIDにサフィックスは付けない。ID そのものが正式名称。
export const MODEL = process.env.CLASSIFY_MODEL || 'claude-opus-5';

// effort を受け付けないモデルがある（Haiku 4.5 など）。付けると 400 になるので、
// 対応しているものにだけ付ける。分類は深く考える必要がないので low で足りる。
const EFFORT_OK = /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)$/;

// 1回のリクエストで何通まとめて判定させるか。
// 多すぎると1通あたりの注意が薄まり、少なすぎるとシステムプロンプトの
// 読み込みが件数ぶん繰り返されて割高になる。
export const BATCH_SIZE = Number(process.env.CLASSIFY_BATCH || 20);

// 本文をどこまで渡すか。冒頭に用件が書かれている前提。
// 全文を渡すと署名・定型文・過去のやりとりでトークンが膨らむ割に精度は上がらない。
export const BODY_CHARS = Number(process.env.CLASSIFY_BODY_CHARS || 600);
const SUBJECT_CHARS = 200;

export const SYSTEM_PROMPT = `あなたは個人のタスク管理を手伝う秘書です。
届いたメールを読んで、本人が何かをする必要があるか、またはお得な情報かを判定します。

判定は3種類です。

- todo … 本人が期限までに何かをしないと不利益が出るもの。
  支払い・振込・引き落としの事前案内、契約や手続きの依頼、書類の提出、
  返信や日程調整の依頼、予約のキャンセル期限、更新・失効の予告など。
  金銭と期限が絡むものは取りこぼさないこと。

- deal … 本人が得をする可能性がある案内。
  値引き、ポイント還元、キャンペーン、クーポン、無料特典、
  応募すればもらえるもの、条件を満たすと付与されるものなど。
  「ログインするだけで◯◯円分もらえる」のように、
  条件が認証操作であっても、得をする案内ならこちらに入れること。

- skip … どちらでもないもの。
  すでに済んだことの通知（支払い完了、入金確認、発送済み、領収書、利用明細）、
  認証コードやログイン通知、単なるニュース、配信の案内だけのメルマガ。

判断に迷ったら、金銭や期限が関わるものは todo に倒してください。
出し損ねる方が、余計に出すより困ります。

deadline には、本文中に書かれている期限を YYYY-MM-DD で入れてください。
「9月29日まで」のように年が書かれていない場合は、受信日から最も近い未来の日付として解釈します。
期限が読み取れない場合は null にしてください。

title は、本人がタスク一覧で見て何をするか分かる短い日本語にしてください。
メールの件名をそのまま写すのではなく、行動が分かる形（「〜を支払う」「〜に応募する」）にします。

reason は、なぜそう判定したかを20字程度で書いてください。`;

// 構造化出力。形が崩れた応答を JSON として読もうとして落ちるのを防ぐ。
export const SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          action: { type: 'string', enum: ['todo', 'deal', 'skip'] },
          title: { type: 'string' },
          category: {
            type: 'string',
            enum: ['契約・手続き', 'お金', 'グルメ', 'おでかけ', 'ショッピング', 'エンタメ', 'ポイ活', 'その他'],
          },
          deadline: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
        required: ['index', 'action', 'title', 'category', 'deadline', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

const clip = (s, n) => {
  const t = String(s || '').replace(/\s*\n+\s*/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 判定させるメールを本文に組み立てる。
 * index は配列の添字。LLM の応答を元のメールに戻すための鍵なので、
 * 渡した順番と一致していること。
 */
export function buildUserMessage(items, today) {
  const lines = [`本日は ${today} です。次のメールを判定してください。`, ''];
  items.forEach((it, i) => {
    lines.push(`[${i}]`);
    lines.push(`件名: ${clip(it.subject, SUBJECT_CHARS)}`);
    if (it.from) lines.push(`差出人: ${clip(it.from, 100)}`);
    if (it.date) lines.push(`受信日: ${it.date}`);
    lines.push(`本文: ${clip(it.snippet || it.body, BODY_CHARS) || '(なし)'}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/** API に送るリクエスト本体。モデルごとの差はここで吸収する。 */
export function buildRequest(items, today, model = MODEL) {
  const body = {
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(items, today) }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };
  if (EFFORT_OK.test(model)) body.output_config.effort = 'low';
  return body;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 応答を元のメールに突き合わせる。
 *
 * ★index を信用しきらない★
 * 返ってきた index が範囲外だったり重複したりしても、全体を捨てずに
 * 読めたものだけ通す。1通の取り違えで20通ぶんの判定が消えるのは困る。
 */
export function mergeVerdicts(items, verdicts) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const i = Number(v && v.index);
    if (!Number.isInteger(i) || i < 0 || i >= items.length) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    const action = ['todo', 'deal', 'skip'].includes(v.action) ? v.action : 'skip';
    const deadline = DATE_RE.test(String(v.deadline || '')) ? v.deadline : null;
    out.push({
      ...items[i],
      action,
      title: String(v.title || items[i].subject || '').trim(),
      category: String(v.category || 'その他'),
      deadline,
      reason: String(v.reason || ''),
    });
  }
  // 判定が返ってこなかったメールは数えて返す。skip として扱うと、
  // 応答が丸ごと壊れたときに「全部どうでもいい」と静かに判断したことになる。
  return { merged: out, missing: items.length - out.length };
}

/** 応答メッセージから verdicts を取り出す。構造化出力でも念のため形を確かめる。 */
export function extractVerdicts(message) {
  const blocks = (message && message.content) || [];
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    try {
      const parsed = JSON.parse(b.text);
      if (Array.isArray(parsed.verdicts)) return parsed.verdicts;
    } catch { /* 次のブロックを試す */ }
  }
  return [];
}

const ENDPOINT = ['https://api', 'anthropic.com/v1/messages'].join('.');

/**
 * 認証情報を自分で取りに行く。
 *
 * 環境変数があればそれを使い、無ければ `ant auth login` のプロファイルから
 * 短命のトークンを取る。鍵をコマンドラインに乗せずに済むので、
 * プロセス一覧から秘密が読めてしまうのを避けられる。
 *
 * ant のトークンは数時間で切れる。launchd から毎回呼ぶ前提なので
 * その場で取り直すこの形で足りるが、切れたまま放置される運用にするなら
 * 静的なAPIキーを環境変数で渡すこと。
 */
export function credential(env = process.env) {
  const fromEnv = env.CLAUDE_API_KEY || env.ANTHROPIC_API_KEY;
  if (fromEnv) return fromEnv;
  for (const bin of ['/opt/homebrew/bin/ant', 'ant']) {
    try {
      const t = execFileSync(bin, ['auth', 'print-credentials', '--access-token'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (t) return t;
    } catch { /* 次を試す */ }
  }
  return '';
}

/**
 * 認証ヘッダを作る。
 *
 * ★鍵の種類でヘッダが変わる★
 * `ant auth login` で得られる OAuth トークン（sk-ant-oat01-…）は
 * x-api-key では通らない。Authorization: Bearer と beta ヘッダが要る。
 * 静的なAPIキー（sk-ant-api…）はこれまでどおり x-api-key。
 * 取り違えると 401 になるだけで、原因が分かりにくい。
 */
export function authHeaders(key) {
  const k = String(key || '');
  if (k.startsWith('sk-ant-oat')) {
    return { Authorization: `Bearer ${k}`, 'anthropic-beta': 'oauth-2025-04-20' };
  }
  return { 'x-api-key': k };
}

async function callClaude(body, key) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...authHeaders(key),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude API failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** 件数から概算の費用を出す。事前にユーザーへ示すため。 */
export function estimateCost(count, model = MODEL) {
  // 1Mトークンあたりの単価 [入力, 出力]
  const PRICE = {
    'claude-opus-5': [5, 25],
    'claude-sonnet-5': [3, 15],
    'claude-haiku-4-5': [1, 5],
  };
  const [pin, pout] = PRICE[model] || PRICE['claude-opus-5'];
  const batches = Math.ceil(count / BATCH_SIZE);
  // 1通あたり 件名＋本文で約600トークン。システムプロンプトはバッチごとに1回。
  const input = count * 600 + batches * 900;
  const output = count * 80;
  return {
    batches,
    inputTokens: input,
    outputTokens: output,
    usd: (input / 1e6) * pin + (output / 1e6) * pout,
  };
}

/**
 * まとめて判定する。validate では API を呼ばず見本レスポンスを使う。
 */
export async function classify(items, { today, model = MODEL, apiKey, callsApi = CALLS_API } = {}) {
  if (!items.length) return { results: [], missing: 0 };

  const results = [];
  let missing = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const body = buildRequest(chunk, today, model);

    let message;
    if (callsApi) {
      message = await callClaude(body, apiKey);
    } else {
      message = JSON.parse(await readFile('data/sample-mail-verdicts.json', 'utf8'));
    }

    const m = mergeVerdicts(chunk, extractVerdicts(message));
    results.push(...m.merged);
    missing += m.missing;
  }
  return { results, missing };
}
