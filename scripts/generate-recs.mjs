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
//   MODE=dry-run          … 実際に API を呼ぶ（**$0.4〜1.0 の課金あり**）。
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

// 実物に合わせる（設計書v2 「日次バッチの正確な仕様」より）
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4000;

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

async function generateRecs(tasks, dismissedTitles, existingRecs) {
  const { message: userMessage } = buildUserMessage(tasks, dismissedTitles, existingRecs);

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
      messages: [{ role: 'user', content: userMessage }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API failed: ${res.status} ${await res.text()}`);
  return res.json();
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
  if (!m) throw new Error('recs配列が抽出できませんでした');
  return JSON.parse(m[0]);
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
    console.log(`  TASKS    : ${pctOf(stats.tasks)}  ${stats.tasks.json.length}/8000文字`);
    console.log(`  DISMISSED: ${pctOf(stats.dismissed)}  ${stats.dismissed.json.length}/2000文字`);
    console.log(`  RECS     : ${pctOf(stats.recs)}  ${stats.recs.json.length}/8000文字`);
    console.log(`  tools : web_search_20250305 (max_uses 8) / max_tokens ${MAX_TOKENS}`);

    response = JSON.parse(await readFile('data/sample-claude-response.json', 'utf8'));
    console.log('\n-- 見本レスポンスで抽出・正規化を検証 --');
    console.log(`  content ブロック: ${response.content.map((b) => b.type).join(', ')}`);
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
    console.log('   実際に生成させるには MODE=dry-run（$0.4〜1.0 の課金あり）。');
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
