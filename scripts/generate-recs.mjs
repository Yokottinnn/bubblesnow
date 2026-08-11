// BubblesNow 日次レコメンド生成バッチ（Make.com make-body-v6 の移植）
//
// Make.com は「Claude API で生成 → recs.html の URL hash に載せて渡す →
// recs.html が Firebase に .set()」という経路だった。ここでは中継を省き、
// 生成したJSONをこのスクリプトが直接 Firebase に書き込む。
//
// 実行: node scripts/generate-recs.mjs
//   DRY_RUN=true （既定）… 生成して結果を表示するだけ。書き込まない
//   DRY_RUN=false        … Firebase に書き込む

import { writeFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const BASE = 'users/yokota';

// 実物に合わせる（設計書v2 「日次バッチの正確な仕様」より）
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4000;

if (!FIREBASE_URL) { console.error('FIREBASE_URL が未設定です'); process.exit(1); }
if (!CLAUDE_API_KEY) {
  console.error('CLAUDE_API_KEY が未設定です。');
  console.error('GitHub の Settings → Secrets and variables → Actions で CLAUDE_API_KEY を登録してください。');
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

// Make.com は encodeURL + substring で長さを詰めていた。同じ上限に揃える。
function clip(value, max) {
  return encodeURIComponent(JSON.stringify(value ?? [])).slice(0, max);
}

async function generateRecs(tasks, dismissed, existingRecs) {
  const userMessage = `TASKS=${clip(tasks, 8000)}&DISMISSED=${clip(dismissed, 2000)}&RECS=${clip(existingRecs, 8000)}

上記データを分析しておすすめJSON配列を返せ。Web検索で東京のサウナ新店・テックイベント・アート展・ポイ活キャンペーン・クリプトエアドロップ/NFTインセンティブの最新情報を調べろ。X(Twitter)の投稿で有益な情報があればそのURLを優先的に使え。JSON配列のみ。HTMLタグやciteタグは絶対に含めるな。`;

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

async function main() {
  console.log('=== BubblesNow 日次recs生成 ===');
  console.log(`モード: ${DRY_RUN ? '🧪 DRY RUN（書き込みなし）' : '🚀 本番書き込み'} / モデル: ${MODEL}`);

  const tasks = await fbGet(`${BASE}/tasks`).catch(() => null);
  const dismissed = (await fbGet(`${BASE}/dismissed`).catch(() => [])) || [];
  const existingRaw = (await fbGet(`${BASE}/recommendations`).catch(() => [])) || [];
  const existing = Array.isArray(existingRaw) ? existingRaw.filter(Boolean) : [];

  // ★件数のみ表示。中身は public ログに出さない★
  const taskCount = Array.isArray(tasks) ? tasks.length : Object.keys(tasks || {}).length;
  console.log(`入力: tasks ${taskCount}件 / dismissed ${dismissed.length}件 / 既存recs ${existing.length}件`);

  await writeFile('recs-backup.json', JSON.stringify(existingRaw, null, 2));
  console.log('📦 既存recsを recs-backup.json に保存');

  const response = await generateRecs(tasks, dismissed, existing);
  if (response.usage) {
    console.log(`トークン: in ${response.usage.input_tokens} / out ${response.usage.output_tokens}`);
  }

  const generated = extractRecs(response).map(sanitize).filter((r) => r.title);
  const withIds = assignIds(generated, existing);
  console.log(`\n生成: ${withIds.length}件`);
  for (const r of withIds) {
    console.log(`  ${r.id} ${r.icon} [${r.category}/${r.priority}] ${r.title}${r.url ? '' : ' （URLなし）'}`);
  }
  await writeFile('recs-generated-preview.json', JSON.stringify(withIds, null, 2));

  if (!withIds.length) throw new Error('生成結果が0件。書き込みを中止します。');

  if (DRY_RUN) {
    console.log('\n🧪 DRY RUN のため書き込みませんでした。');
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
