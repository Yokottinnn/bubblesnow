// BubblesNow 日次レコメンド生成バッチ（Make.com make-body-v6 の移植）
//
// Make.com は「Claude API で生成 → recs.html の URL hash に載せて渡す →
// recs.html が Firebase に .set()」という経路だった。ここでは中継を省き、
// 生成したJSONをこのスクリプトが直接 Firebase に書き込む。
//
// ★MODE で挙動が変わる。「dry run＝無料」ではない点に注意★
//   MODE=validate （既定）… **API を一切呼ばない。課金 $0。**
//                           Firebase読み取り・プロンプト組み立て・見本レスポンスを使った
//                           抽出/正規化/ID採番までを検証する。配線の確認用。
//   MODE=dry-run          … 実際に API を呼ぶ（**$0.8〜1.8 の課金あり**）。
//                           生成結果を表示するが Firebase には書き込まない。
//   MODE=live             … API を呼び、Firebase にも書き込む。
//
// かつて DRY_RUN=true を「安全」と説明していたが誤りだった。DRY_RUN が省くのは
// 書き込みだけで API 課金は発生していた。名前ごと変えて誤解を断つ。
//
// 実行: MODE=validate node scripts/generate-recs.mjs

import { readFile, writeFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const BASE = 'users/yokota';

const MODES = ['validate', 'dry-run', 'live'];
const MODE = String(process.env.MODE || 'validate').toLowerCase();
if (!MODES.includes(MODE)) {
  console.error(`MODE が不正です: "${MODE}"（使えるのは ${MODES.join(' / ')}）`);
  process.exit(1);
}
const CALLS_API = MODE !== 'validate';
const WRITES = MODE === 'live';

// ★設計書v2 の claude-sonnet-4-20250514 は既に存在しない★
// 2026-08-13 の dry-run が 404 not_found_error で落ちた（課金は発生していない）。
// 日付サフィックス付きのIDは廃止され、現行は claude-opus-5 / claude-sonnet-5 のように
// サフィックス無しのIDそのものが正式名称。CLAUDE_MODEL で上書きできる。
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

// web_search はモデル世代ごとにツールのバージョンが違う。20260209 は dynamic filtering
// （検索結果をコンテキストに入れる前にモデル側で絞り込む）に対応していて、Opus 5 / Sonnet 5 /
// Opus 4.6以降 / Sonnet 4.6 で使える。code_execution を別途宣言する必要はない。
// 旧世代モデルを CLAUDE_MODEL で指定したときのために 20250305 へ落とせるようにしてある。
const WEB_SEARCH_TOOL = process.env.WEB_SEARCH_TOOL || 'web_search_20260209';

// 実物は 4000。8000 に上げてもまだ足りなかった。
// 2026-08-13 の dry-run は stop_reason: 'max_tokens' で JSON が途中で切れ、
// $0.39 払って成果ゼロで終わった（in 104003 / out 10037）。
// 日本語で 15〜25件ぶんの JSON は 8000 トークンに収まらない。
// Sonnet 5 / Opus 5 は 64K まで出せるので余裕をもって取る。
// 出力トークンは実際に生成した分しか課金されないため、上限を上げること自体の費用はゼロ。
//
// なお元の Make.com は 4000 だった。同じプロンプトならもっと強く切られていたはずで、
// recommendations が 15〜25件でなく9件しかないのはこれが原因かもしれない（未確認）。
const MAX_TOKENS = 24000;

// server tool が長引くと stop_reason: 'pause_turn' で一旦返ってくる。
// そのまま扱うと途中で切れた応答をJSONとして読もうとして失敗するので、続きを要求する。
const MAX_CONTINUATIONS = 5;

if (!FIREBASE_URL) { console.error('FIREBASE_URL が未設定です'); process.exit(1); }
// APIキーは実際に呼ぶモードでだけ必須。validate は鍵なしで通す。
if (CALLS_API && !CLAUDE_API_KEY) {
  console.error('CLAUDE_API_KEY が未設定です。');
  console.error('GitHub の Settings → Secrets and variables → Actions で CLAUDE_API_KEY を登録してください。');
  console.error('（鍵なしで配線だけ確かめたいなら MODE=validate を使ってください。課金は発生しません）');
  process.exit(1);
}

const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

async function fbPut(path, data) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Make.com make-body-v6 の system プロンプト（実物そのまま）
const SYSTEM_PROMPT = `BubblesNowリコメンドエンジン。タスク追加傾向を増やしdismiss傾向を減らす。サウナ好き、AI/テック好き、キャリア重視。JSON配列のみ返せ。説明文もmarkdownもHTMLタグもciteタグも絶対に含めるな。最初の文字は[、最後の文字は]であること。各要素: {id,title,desc,category,source,icon,priority,deadline,url,location}。title,descにはHTMLタグやciteタグを絶対に含めるな。プレーンテキストのみ。locationは場所名や住所。場所不明なら空文字。urlは確実に存在する公式サイトのみ。不確かなURLは空文字にせよ。壊れたリンクは絶対に含めるな。urlにはX(Twitter)の投稿URLも積極的に使え。公式サイトよりもXの投稿のほうが情報として分かりやすい場合はXのURLを優先せよ。誰かがPR・紹介・レビューしている投稿でもよい。source:gmail/calendar/news/x/instagram。category:契約・手続き/お金/ヘルスケア/グルメ/ショッピング/おでかけ/キャリア・学び/ヒト/その他。お金カテゴリにはポイ活・ポイント還元・キャッシュバックキャンペーン・クリプト関連(エアドロップ案件・NFT登録/購入インセンティブ・仮想通貨キャンペーン)も含め、必ずキャンペーン告知ページのURLを付けること。priority:🟢低/🟡中/🔴期限迫。15-25件。期限切れ除外。`;

// ★Make.com の encodeURL + substring はやめた★
//
// 元は `substring(encodeURL(data); 0; 8000)`。これは Make.com が HTTP フォームとして
// 送っていた名残で、JSON で API を叩く今は不要なうえ実害があった:
//   - 日本語が %E3%81%82 形式に展開され容量が 3.6 倍に膨張する
//     → 8000文字の枠に実質 10件/94件 しか入らなかった
//   - 文字数で機械的に切るので、末尾が "%E6%BB%9" のような
//     壊れたエスケープ列（＝壊れたJSON）になって届く
//
// 代わりに「① 素のJSONで送る ② 推薦に要らない項目は落とす
// ③ 重要な順に、要素の境目で切る」の3点にする。

// 配列を、要素の境目を守りながら予算内に詰める。
function pack(items, budget) {
  const out = [];
  for (const item of items) {
    // その要素を足しても予算内か、実際に組み立てて確かめる
    const candidate = JSON.stringify([...out, item]);
    if (candidate.length > budget) break;
    out.push(item);
  }
  return { json: JSON.stringify(out), included: out.length, total: items.length };
}

// 推薦の判断に効く項目だけ残す。merit/demerit/note/url/icon/detail は落とす。
const compactTask = (t) => ({
  name: String(t.name || '').replace(/\n/g, ' '),
  category: t.category,
  priority: t.priority,
  deadline: t.deadline || '',
  status: t.status,
});

// 未完了を優先し、完了済みは新しいものから（傾向の学習用）。
function orderTasks(tasks) {
  const arr = (Array.isArray(tasks) ? tasks : Object.values(tasks || {})).filter((t) => t && t.name);
  const active = arr.filter((t) => t.status === 'active');
  const done = arr
    .filter((t) => t.status !== 'active')
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  return [...active, ...done].map(compactTask);
}

// 組み立てだけを切り出す。validate から API を呼ばずに中身を確かめられるようにするため。
// 何件詰められたかを呼び出し側が報告できるよう stats も返す。
// ★枠は固定せず、合計を共有して融通する★
// 固定枠（TASKS 8000 / DISMISSED 2000 / RECS 8000）だと実データで偏りが出ていた:
//   RECS      471/8000 …… 7500文字あまる（recsは数が少ないので枠を使い切らない）
//   DISMISSED 1983/2000 …… 上限に張り付き 92/244件しか送れない
// 合計は Make.com 時代と同じ 18000 のままにして、余った分を必要な側へ回す。
const TOTAL_BUDGET = 18000;
// 先に詰める側が食い尽くさないよう、後続の最低枠を残しておく。
const FLOOR = { dismissed: 2000, tasks: 6000 };

function buildUserMessage(tasks, dismissedTitles, existingRecs) {
  let left = TOTAL_BUDGET;

  // 既出recsは重複回避が目的なのでタイトルとカテゴリで足りる。件数が少なく
  // 必ず入れたいので最初に確保する。
  const recs = (Array.isArray(existingRecs) ? existingRecs : []).filter(Boolean)
    .map((r) => ({ title: r.title, category: r.category }));
  const r = pack(recs, left - FLOOR.dismissed - FLOOR.tasks);
  left -= r.json.length;

  // ★DISMISSED には ID ではなくタイトルを送る★
  // 元は dismissed（"r12" のようなID配列）を送っていたが、IDだけ渡されても
  // 何を却下したのか判断できず「既出を再提示するな」の指示が機能しない。
  // 新しい却下ほど今の好みを表すので、後ろ（新しい方）から詰める。
  const titles = (Array.isArray(dismissedTitles) ? dismissedTitles : []).filter(Boolean).slice().reverse();
  const d = pack(titles, left - FLOOR.tasks);
  left -= d.json.length;

  // 残り全部をタスクに回す。
  const t = pack(orderTasks(tasks), left);

  const message = `TASKS=${t.json}&DISMISSED=${d.json}&RECS=${r.json}

上記データを分析しておすすめJSON配列を返せ。Web検索で東京のサウナ新店・テックイベント・アート展・ポイ活キャンペーン・クリプトエアドロップ/NFTインセンティブの最新情報を調べろ。X(Twitter)の投稿で有益な情報があればそのURLを優先的に使え。JSON配列のみ。HTMLタグやciteタグは絶対に含めるな。`;

  return { message, stats: { tasks: t, dismissed: d, recs: r } };
}

// ★必ずストリーミングで受ける★
// 非ストリーミングだと応答が全部できあがるまでヘッダが1バイトも返らない。
// Node の fetch（undici）は応答ヘッダを 300 秒しか待たないので、
// 2026-08-14 の dry-run はちょうど5分で UND_ERR_HEADERS_TIMEOUT で落ちた。
// max_tokens を 24000 に上げて生成が長くなったぶん、確実に踏むようになっていた。
// ストリーミングならヘッダは即座に返り、以降はイベントが届き続けるので時間切れしない。
async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      tools: [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 8 }],
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`Claude API failed: ${res.status} ${await res.text()}`);
  return readStream(res.body);
}

// SSE を読んで、非ストリーミングと同じ形の message オブジェクトに組み直す。
// 呼び出し側（extractRecs / pause_turn 判定）が形の違いを意識しなくて済むようにする。
async function readStream(source) {
  const message = { content: [], stop_reason: null, usage: {} };
  const pending = new Map(); // index -> { block, jsonBuf }
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of source) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    // SSE は行単位。data: 以外（event: / id: / 空行）は読み飛ばす。
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue; // 壊れた行は捨てる。落とすほどのことではない
      }
      applyEvent(ev, message, pending);
    }
  }

  // 途中で切れて content_block_stop が来なかったブロックも拾っておく。
  // ここで捨てると、せっかく届いた本文まで失って救出処理が働かない。
  for (const [index, slot] of pending) message.content[index] = slot.block;
  // 添字で入れているので歯抜けになりうる。詰めておく。
  message.content = message.content.filter(Boolean);
  return message;
}

function applyEvent(ev, message, pending) {
  switch (ev.type) {
    case 'message_start':
      Object.assign(message, {
        id: ev.message?.id,
        model: ev.message?.model,
        role: ev.message?.role,
        usage: { ...(ev.message?.usage || {}) },
      });
      break;

    case 'content_block_start':
      // web_search_tool_result はここで中身ごと届く。text / tool_use は delta で育つ。
      pending.set(ev.index, { block: { ...ev.content_block }, jsonBuf: '' });
      break;

    case 'content_block_delta': {
      const slot = pending.get(ev.index);
      if (!slot) break;
      const d = ev.delta || {};
      if (d.type === 'text_delta') slot.block.text = (slot.block.text || '') + d.text;
      else if (d.type === 'thinking_delta') slot.block.thinking = (slot.block.thinking || '') + d.thinking;
      else if (d.type === 'input_json_delta') slot.jsonBuf += d.partial_json || '';
      break;
    }

    case 'content_block_stop': {
      const slot = pending.get(ev.index);
      if (!slot) break;
      if (slot.jsonBuf) {
        try {
          slot.block.input = JSON.parse(slot.jsonBuf);
        } catch { /* 検索クエリの復元に失敗しても本題には影響しない */ }
      }
      message.content[ev.index] = slot.block;
      pending.delete(ev.index);
      break;
    }

    case 'message_delta':
      if (ev.delta?.stop_reason) message.stop_reason = ev.delta.stop_reason;
      if (ev.usage) Object.assign(message.usage, ev.usage);
      break;

    case 'error':
      throw new Error(`Claude API stream error: ${JSON.stringify(ev.error)}`);

    default:
      break; // ping / message_stop など
  }
}

async function generateRecs(tasks, dismissedTitles, existingRecs) {
  const { message: userMessage } = buildUserMessage(tasks, dismissedTitles, existingRecs);

  const messages = [{ role: 'user', content: userMessage }];
  let response = await callClaude(messages);

  // pause_turn は「まだ途中」の合図。assistant の途中経過をそのまま積んで再送すると
  // サーバ側が続きから再開する。回数を区切らないと無限に課金され続けるので上限を置く。
  let continuations = 0;
  while (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
    continuations += 1;
    console.log(`⏸ pause_turn。続きを要求します（${continuations}/${MAX_CONTINUATIONS}）`);
    messages.push({ role: 'assistant', content: response.content });
    response = await callClaude(messages);
  }
  if (response.stop_reason === 'pause_turn') {
    console.warn(`⚠️ pause_turn が ${MAX_CONTINUATIONS} 回続いたので打ち切りました。応答が不完全な可能性があります`);
  }
  if (response.stop_reason === 'max_tokens') {
    console.warn(`⚠️ 出力が max_tokens (${MAX_TOKENS}) に達しました。JSONが途中で切れている可能性があります`);
  }
  return response;
}

// web search 使用時は content に tool_use / tool_result も混ざるので text だけ集める
function extractRecs(response) {
  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct) && direct.length) return direct;
  } catch { /* 下の正規表現で拾う */ }

  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch { /* 途中で切れている。下で拾えるだけ拾う */ }
  }

  // ★切れた配列から、完成している要素だけ救う★
  // max_tokens に達すると配列は "...,{"id":"r14","title":"途中" のような形で終わる。
  // 丸ごと捨てると、課金だけ発生して成果ゼロになる（2026-08-13 に実際に起きた）。
  // 閉じ括弧の対応を数えながら、完全な要素の切れ目まで戻して配列を閉じ直す。
  const salvaged = salvageArray(cleaned);
  if (salvaged) {
    console.warn(`⚠️ JSONが途中で切れていたため、完成している ${salvaged.length}件のみ救出しました`);
    return salvaged;
  }
  throw new Error('recs配列が抽出できませんでした');
}

// 文字列リテラルとエスケープを見ながら走査し、深さ0に戻った要素の末尾を覚えておく。
// 引用符の中の { } [ ] を数えてしまうと位置がずれるので、in-string 状態を持つ。
function salvageArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastComplete = -1;

  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      // 深さ0に戻った = 要素ひとつが閉じきった
      if (depth === 0) lastComplete = i;
      else if (depth < 0) break; // 配列自体の ] に到達
    }
  }
  if (lastComplete < 0) return null;

  try {
    const arr = JSON.parse(`${text.slice(start, lastComplete + 1)}]`);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

// アプリ側の想定に合わせて整形する。壊れた値を Firebase に入れない。
const CATEGORIES = ['契約・手続き', 'お金', 'ヘルスケア', 'グルメ', 'ショッピング', 'おでかけ', 'キャリア・学び', 'ヒト', 'その他'];
const PRIORITIES = ['🟢低', '🟡中', '🔴期限迫'];
const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function sanitize(rec) {
  const url = String(rec.url ?? '');
  return {
    title: strip(rec.title),
    desc: strip(rec.desc),
    category: CATEGORIES.includes(rec.category) ? rec.category : 'その他',
    source: rec.source || 'news',
    icon: rec.icon || '📌',
    priority: PRIORITIES.includes(rec.priority) ? rec.priority : '🟡中',
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(rec.deadline || '') ? rec.deadline : '',
    url: url.startsWith('http') ? url : '',
    location: strip(rec.location),
  };
}

function assignIds(recs, existing) {
  let max = 0;
  for (const r of existing) {
    const m = String(r?.id || '').match(/^r(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let next = max + 1;
  return recs.map((r) => ({ id: `r${next++}`, ...r }));
}

// 見本のSSEを、あえて中途半端な位置で切りながら readStream に渡して結果を確かめる。
// ストリーミングは実際に課金の伴う経路でしか通らないので、無料のうちに壊れを検出する。
async function checkStreamParser() {
  const raw = await readFile('data/sample-claude-stream.sse');
  async function* chopped() {
    // 素数刻みで切ると、行の途中・イベントの途中・UTF-8の途中に満遍なく当たる。
    for (let i = 0; i < raw.length; i += 7) yield raw.subarray(i, i + 7);
  }
  const msg = await readStream(chopped());

  const types = msg.content.map((b) => b.type).join(', ');
  const recs = extractRecs(msg);
  const query = msg.content.find((b) => b.type === 'server_tool_use')?.input?.query;

  if (recs.length !== 2) throw new Error(`SSE組み立てが壊れています。2件のはずが ${recs.length}件`);
  if (msg.stop_reason !== 'end_turn') throw new Error(`stop_reason が拾えていません: ${msg.stop_reason}`);
  if (msg.usage.input_tokens !== 1234 || msg.usage.output_tokens !== 987) {
    throw new Error(`usage が拾えていません: ${JSON.stringify(msg.usage)}`);
  }
  if (query !== '東京 サウナ 2026') throw new Error(`分割された tool 入力を復元できていません: ${query}`);

  console.log(`  SSE組み立て: ${recs.length}件 / ブロック ${types} / usage in ${msg.usage.input_tokens} out ${msg.usage.output_tokens} ✔`);
}

const MODE_LABEL = {
  validate: '🔍 VALIDATE（APIを呼ばない・課金 $0）',
  'dry-run': '🧪 DRY RUN（API課金あり・Firebaseには書かない）',
  live: '🚀 LIVE（API課金あり・Firebaseに書き込む）',
};

async function main() {
  console.log('=== BubblesNow 日次recs生成 ===');
  console.log(`モード: ${MODE_LABEL[MODE]}`);
  if (CALLS_API) console.log(`モデル: ${MODEL}`);

  const tasks = await fbGet(`${BASE}/tasks`).catch(() => null);
  const dismissedTitles = (await fbGet(`${BASE}/dismissedTitles`).catch(() => [])) || [];
  const existingRaw = (await fbGet(`${BASE}/recommendations`).catch(() => [])) || [];
  const existing = Array.isArray(existingRaw) ? existingRaw.filter(Boolean) : [];

  // ★件数のみ表示。中身は public ログに出さない★
  const taskCount = Array.isArray(tasks) ? tasks.length : Object.keys(tasks || {}).length;
  console.log(`入力: tasks ${taskCount}件 / dismissedTitles ${dismissedTitles.length}件 / 既存recs ${existing.length}件`);

  await writeFile('recs-backup.json', JSON.stringify(existingRaw, null, 2));
  console.log('📦 既存recsを recs-backup.json に保存');

  let response;
  if (CALLS_API) {
    response = await generateRecs(tasks, dismissedTitles, existing);
    if (response.usage) {
      console.log(`トークン: in ${response.usage.input_tokens} / out ${response.usage.output_tokens}`);
    }
  } else {
    // ★API を呼ばない。組み立て内容を見せ、抽出以降は見本レスポンスで検証する★
    const { message, stats } = buildUserMessage(tasks, dismissedTitles, existing);
    const pctOf = (s) => `${s.included}/${s.total}件 (${s.total ? Math.round((s.included / s.total) * 100) : 100}%)`;
    console.log('\n-- 送信されるはずだった内容（実際には送っていない）--');
    console.log(`  system: ${SYSTEM_PROMPT.length}文字`);
    console.log(`  user  : ${message.length}文字`);
    const used = stats.tasks.json.length + stats.dismissed.json.length + stats.recs.json.length;
    console.log(`  TASKS    : ${pctOf(stats.tasks)}  ${stats.tasks.json.length}文字`);
    console.log(`  DISMISSED: ${pctOf(stats.dismissed)}  ${stats.dismissed.json.length}文字`);
    console.log(`  RECS     : ${pctOf(stats.recs)}  ${stats.recs.json.length}文字`);
    console.log(`  合計 ${used}/${TOTAL_BUDGET}文字（3セクションで共有）`);
    console.log(`  model : ${MODEL}（実際には呼ばない）`);
    console.log(`  tools : ${WEB_SEARCH_TOOL} (max_uses 8) / max_tokens ${MAX_TOKENS} / stream: true`);

    // ★SSE の組み立てをここで無料で確かめる★
    // 本番のストリームは分割位置が毎回変わるので、細かく・不揃いに・マルチバイト文字の
    // 途中で切って流し込む。行またぎとUTF-8の分断の両方を踏ませるのが狙い。
    await checkStreamParser();

    response = JSON.parse(await readFile('data/sample-claude-response.json', 'utf8'));
    console.log('\n-- 見本レスポンスで抽出・正規化を検証 --');
    console.log(`  content ブロック: ${response.content.map((b) => b.type).join(', ')}`);

    // ★救出処理は高い失敗のときにしか通らない経路なので、ここで無料で確かめておく★
    const cut = JSON.parse(await readFile('data/sample-claude-response-truncated.json', 'utf8'));
    const rescued = extractRecs(cut);
    if (rescued.length !== 2) {
      throw new Error(`救出処理が壊れています。2件のはずが ${rescued.length}件でした`);
    }
    console.log(`  切れたJSONからの救出: ${rescued.length}件 ✔`);
  }

  const generated = extractRecs(response).map(sanitize).filter((r) => r.title);
  const withIds = assignIds(generated, existing);
  console.log(`\n生成: ${withIds.length}件`);
  for (const r of withIds) {
    console.log(`  ${r.id} ${r.icon} [${r.category}/${r.priority}] ${r.title}${r.url ? '' : ' （URLなし）'}`);
  }
  await writeFile('recs-generated-preview.json', JSON.stringify(withIds, null, 2));

  if (!withIds.length) throw new Error('生成結果が0件。書き込みを中止します。');

  if (MODE === 'validate') {
    console.log('\n🔍 配線は正常。API は呼んでいないので課金は発生していません（$0）。');
    console.log('   上の結果は見本レスポンス由来のダミーです。実データではありません。');
    console.log('   実際に生成させるには MODE=dry-run（$0.8〜1.8 の課金あり）。');
    return;
  }

  if (!WRITES) {
    console.log('\n🧪 DRY RUN のため書き込みませんでした（API課金は発生済み）。');
    return;
  }

  // 実物の recs.html と同じく全置換（.set 相当）
  await fbPut(`${BASE}/recommendations`, withIds);
  console.log(`\n✅ 書き込み完了: ${BASE}/recommendations（${withIds.length}件）`);
}

main().catch((err) => {
  console.error('❌ バッチ失敗:', err);
  process.exit(1);
});
