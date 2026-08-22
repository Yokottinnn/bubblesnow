// 集めた材料から recs を選んで整形し、Firebase に反映する。LLM を使わないので課金ゼロ。
//
// ★これが最後の一段★
//   ① 収集      collect-x.mjs（X）/ collect-sources.mjs（RSS）… 済
//   ② URL解決   同上 … 済
//   ③ 既出除外  同上 … 済
//   ④ 選別・整形 ← ここ
//
// ★なぜ LLM を使わないか★
// Claude に web_search させる方式は 1回 $0.4 で、その8割超は検索結果の運搬料だった。
// 検索を自前でやる形にしたので、残るのは「77件から15〜25件を選ぶ」判断だけ。
// これはスコアリングで足りる。無料で、毎日回しても $0。
// 生成文の質が要るなら後から LLM を挟めるよう、選別と整形は分けてある。
//
// ★安全側の作り★
//   - 既定は書き込まない（MODE=dry-run）。書くのは MODE=live のときだけ
//   - 書く前に既存を recs-backup.json に保存する
//   - 既存を消さず末尾に足す（アプリの .set() 全置換とは違う）
//   - 0件なら書き込まない
//
// 実行: node scripts/build-recs.mjs            … 選ぶだけ（既定・$0・書かない）
//       MODE=live node scripts/build-recs.mjs  … Firebase に反映（$0）

import { readFile, writeFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const BASE = 'users/yokota';
const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

const MODE = String(process.env.MODE || 'dry-run').toLowerCase();
const WRITES = MODE === 'live';

// Make.com のプロンプトが「15-25件」を指示していたので、それに合わせる。
const MIN_RECS = Number(process.env.MIN_RECS || 15);
const MAX_RECS = Number(process.env.MAX_RECS || 25);
// 1カテゴリが枠を独占しないようにする。偏ると「おすすめ」として使い物にならない。
const MAX_PER_CATEGORY = Number(process.env.MAX_PER_CATEGORY || 8);
// recommendations 全体の上限。毎日追加するので、これが無いと無限に増える。
// 一覧をスクロールして眺められる量として 60 を既定にした。
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 60);

const SOURCE_FILES = ['collected-x.json', 'collected-sources.json'];

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

const norm = (s) => String(s || '').toLowerCase().replace(/[\s　"'“”‘’|｜・,、。．.!！?？]/g, '');
const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// ★スコアリング★
// 「タスク追加傾向を増やしdismiss傾向を減らす」が元プロンプトの狙い。
// LLM の代わりに、その狙いを分解可能な形にして数値で表す。
const SIGNALS = [
  // 行動できるものを上に。締切や金額がある告知は、読んで終わりの記事より価値が高い。
  { re: /(\d+(\.\d+)?\s*[%％]|\d+[,\d]*\s*円|\d+\s*ポイント|最大\s*\d)/, points: 3, why: '具体的な金額や率がある' },
  { re: /(まで|締切|期限|終了|〜\d+\/\d+|\d+月\d+日まで)/, points: 3, why: '期限が示されている' },
  { re: /(開始|スタート|開催|オープン|受付|募集|エントリー|開幕|新登場|リリース)/, points: 2, why: '始まる告知' },
  { re: /(限定|先着|抽選|無料|プレゼント|配布)/, points: 2, why: '取りに行く理由がある' },
  { re: /(新店|新規|初|リニューアル)/, points: 1, why: '新しい' },
];

// 逆に、おすすめとして出しても行動につながらないもの。
const PENALTIES = [
  { re: /(まとめ|ランキング|\d+選|振り返り|とは|徹底解説|比較してみた)/, points: -4, why: '読み物であって行動対象ではない' },
  { re: /(終了しました|受付終了|締め切りました|中止|延期)/, points: -8, why: '既に終わっている' },
  { re: /(詐欺|注意喚起|被害|流出|不正|逮捕|炎上)/, points: -8, why: 'ネガティブな話題' },
  { re: /^(RT|【PR】|\[PR\])/, points: -3, why: '転載や広告表記' },
];

export function score(item) {
  const text = `${item.title || ''} ${item.desc || ''}`;
  const reasons = [];
  let total = 0;

  for (const s of SIGNALS) {
    if (s.re.test(text)) { total += s.points; reasons.push(`+${s.points} ${s.why}`); }
  }
  for (const p of PENALTIES) {
    if (p.re.test(text)) { total += p.points; reasons.push(`${p.points} ${p.why}`); }
  }

  // URL があるものを優先する。設計書の「壊れたリンクは無リンクより悪い」の裏返しで、
  // 行き先が無い rec は採用しても何もできない。お金カテゴリは特に効く。
  if (item.url) { total += 3; reasons.push('+3 リンクがある'); }
  else if (item.category === 'お金') { total -= 5; reasons.push('-5 お金なのにリンクが無い'); }

  // 反応が多い投稿は当たりの確率が高い。ただし効きすぎないよう上限を置く。
  const engagement = Number(item.likes || 0) + Number(item.reposts || 0) * 2;
  if (engagement > 0) {
    const bonus = Math.min(3, Math.floor(Math.log10(engagement + 1) * 2));
    if (bonus > 0) { total += bonus; reasons.push(`+${bonus} 反応が多い（${engagement}）`); }
  }

  // 短すぎる見出しは意味が取れない。
  const len = strip(item.title).length;
  if (len < 10) { total -= 3; reasons.push('-3 見出しが短すぎる'); }

  return { total, reasons };
}

const CATEGORIES = ['契約・手続き', 'お金', 'ヘルスケア', 'グルメ', 'ショッピング', 'おでかけ', 'キャリア・学び', 'ヒト', 'その他'];
const PRIORITIES = ['🟢低', '🟡中', '🔴期限迫'];

// 見出しから締切が読めれば拾う。読めなければ空にする（でっち上げない）。
export function extractDeadline(text) {
  const now = new Date();
  const m = String(text).match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})\s*日?\s*(?:まで|締切|〆)/);
  if (!m) return '';
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  let year = now.getFullYear();
  // 過ぎた月なら来年のものとみなす
  if (month < now.getMonth() + 1) year += 1;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

export function toRec(item) {
  const title = strip(item.title).slice(0, 60);
  const deadline = extractDeadline(`${item.title} ${item.desc || ''}`);
  // 期限が近いものだけ上げる。全部を🔴にすると優先度が意味を失う。
  let priority = '🟡中';
  if (deadline) {
    const days = (Date.parse(deadline) - Date.now()) / 86400000;
    priority = days <= 7 ? '🔴期限迫' : '🟡中';
  }
  return {
    title,
    desc: strip(item.desc || item.title).slice(0, 120),
    category: CATEGORIES.includes(item.category) ? item.category : 'その他',
    source: item.via === 'search' || item.via === 'profile' ? 'x' : 'news',
    icon: item.icon || '📌',
    priority: PRIORITIES.includes(priority) ? priority : '🟡中',
    deadline,
    url: String(item.url || '').startsWith('http') ? item.url : '',
    location: strip(item.location || ''),
  };
}

// index.html:213 と同じ判定。短い語での巻き込みは避ける。
export function isDismissed(title, dismissedTitles) {
  const t = String(title).trim().toLowerCase();
  return dismissedTitles.some((dt) => {
    if (!dt) return false;
    const d = String(dt).toLowerCase();
    if (d === t) return true;
    const shorter = d.length <= t.length ? d : t;
    if (shorter.length < 6) return false;
    return t.indexOf(d) >= 0 || d.indexOf(t) >= 0;
  });
}

export function assignIds(recs, existing) {
  let max = 0;
  for (const r of existing) {
    const m = String(r?.id || '').match(/^r(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let next = max + 1;
  return recs.map((r) => ({ id: `r${next++}`, ...r }));
}

// ★溜まり続けないようにする★
// 落とす順番に意味がある。まず「もう役に立たない」ものを消し、
// それでも多いときだけ古い順に削る。新しさより有用性を優先する。
export function prune(recs, { limit = MAX_TOTAL, today = new Date() } = {}) {
  const iso = today.toISOString().slice(0, 10);

  // ① 締切を過ぎたものは、残しても押せない
  const alive = recs.filter((r) => !r?.deadline || r.deadline >= iso);

  // ② 同じタイトルが増えたら新しい方を残す（後勝ち）。
  //    毎日同じキャンペーンが流れてくるので、これが効く。
  const byTitle = new Map();
  for (const r of alive) {
    const k = norm(r?.title);
    if (k) byTitle.set(k, r);
  }
  const unique = [...byTitle.values()];

  // ③ それでも多ければ古い順に落とす。末尾が新しいので後ろから残す。
  return unique.length <= limit ? unique : unique.slice(unique.length - limit);
}

async function loadSources() {
  const items = [];
  const found = [];
  for (const f of SOURCE_FILES) {
    try {
      const data = JSON.parse(await readFile(f, 'utf8'));
      const list = Array.isArray(data.items) ? data.items : [];
      items.push(...list);
      found.push(`${f} (${list.length}件)`);
    } catch {
      // 片方しか無くても動く。両方無いときだけ後で止める。
    }
  }
  return { items, found };
}

async function main() {
  console.log('=== recs の選別・整形（LLM不使用・API課金なし）===');
  console.log(`モード: ${WRITES ? '🚀 LIVE（Firebaseに書き込む）' : '🧪 DRY RUN（書き込まない）'}\n`);

  const { items, found } = await loadSources();
  if (!found.length) {
    console.error('❌ 材料がありません。先に collect-x.mjs か collect-sources.mjs を実行してください。');
    process.exit(1);
  }
  console.log(`材料: ${found.join(' / ')} = 合計 ${items.length}件\n`);

  const existingRaw = (await fbGet(`${BASE}/recommendations`).catch(() => [])) || [];
  const existing = Array.isArray(existingRaw) ? existingRaw.filter(Boolean) : [];
  const dismissedTitles = (await fbGet(`${BASE}/dismissedTitles`).catch(() => [])) || [];
  const tasks = (await fbGet(`${BASE}/tasks`).catch(() => [])) || [];
  const taskNames = (Array.isArray(tasks) ? tasks : Object.values(tasks))
    .filter(Boolean).map((t) => norm(t.name));
  console.log(`既存recs ${existing.length}件 / dismissedTitles ${dismissedTitles.length}件 / tasks ${taskNames.length}件\n`);

  // ── 除外 ──
  const seen = new Set(existing.map((r) => norm(r.title)));
  const dropped = { dup: 0, dismissed: 0, alreadyTask: 0, lowScore: 0 };
  const scored = [];

  for (const item of items) {
    const key = norm(item.title);
    if (!key || seen.has(key)) { dropped.dup += 1; continue; }
    if (isDismissed(item.title, dismissedTitles)) { dropped.dismissed += 1; continue; }
    if (taskNames.includes(key)) { dropped.alreadyTask += 1; continue; }
    seen.add(key);
    const s = score(item);
    // 負の点は「出しても行動につながらない」と判定したもの。
    if (s.total < 0) { dropped.lowScore += 1; continue; }
    scored.push({ item, ...s });
  }

  console.log('── 除外 ──');
  console.log(`  既出・重複 ${dropped.dup}件 / 却下済み ${dropped.dismissed}件 / タスク化済み ${dropped.alreadyTask}件 / スコア不足 ${dropped.lowScore}件`);
  console.log(`  残り ${scored.length}件\n`);

  // ── 選別。点数順に取りつつ、1カテゴリが偏らないようにする ──
  scored.sort((a, b) => b.total - a.total);
  const perCategory = new Map();
  const picked = [];
  for (const s of scored) {
    if (picked.length >= MAX_RECS) break;
    const cat = s.item.category || 'その他';
    const n = perCategory.get(cat) || 0;
    if (n >= MAX_PER_CATEGORY) continue;
    perCategory.set(cat, n + 1);
    picked.push(s);
  }

  console.log('── 選別結果 ──');
  for (const [cat, n] of perCategory) console.log(`  ${cat.padEnd(8, '　')} ${n}件`);
  console.log(`  合計 ${picked.length}件（上限 ${MAX_RECS} / カテゴリ上限 ${MAX_PER_CATEGORY}）\n`);

  console.log('── 上位5件と選ばれた理由 ──');
  for (const s of picked.slice(0, 5)) {
    console.log(`  [${String(s.total).padStart(2)}点] ${strip(s.item.title).slice(0, 40)}`);
    console.log(`         ${s.reasons.join(' / ')}`);
  }
  console.log('');

  const recs = picked.map((s) => toRec(s.item)).filter((r) => r.title);
  const withIds = assignIds(recs, existing);

  await writeFile('recs-built-preview.json', JSON.stringify(withIds, null, 2));
  console.log(`📦 recs-built-preview.json に ${withIds.length}件を保存`);

  if (!withIds.length) {
    console.error('\n❌ 0件です。書き込みは行いません。');
    console.error('   材料が少ないか、除外が効きすぎている可能性があります。');
    process.exit(1);
  }
  if (withIds.length < MIN_RECS) {
    console.warn(`\n⚠️ ${withIds.length}件で、目標の ${MIN_RECS}件に届いていません（材料不足）。`);
  }

  if (!WRITES) {
    console.log('\n🧪 DRY RUN のため書き込んでいません。');
    console.log('   反映するには MODE=live node scripts/build-recs.mjs');
    console.log('=== 完了・課金は発生していません（$0）===');
    return;
  }

  // ★書き込む前に必ず退避する★
  await writeFile('recs-backup.json', JSON.stringify(existingRaw, null, 2));
  console.log('📦 既存recsを recs-backup.json に退避');

  // 既存を消さず末尾に足す。アプリ側の .set() は全置換なので、ここで消すと復元できない。
  // ただし毎日 20件超が積まれるので、放っておくと1週間で200件を超える。
  // 一覧として使えなくなるだけでなく、既出除外の照合も重くなる。
  const merged = prune(existing.concat(withIds));
  await fbPut(`${BASE}/recommendations`, merged);
  const removed = existing.length + withIds.length - merged.length;
  console.log(`\n✅ 書き込み完了: ${BASE}/recommendations（既存 ${existing.length} + 新規 ${withIds.length}${removed ? ` − 整理 ${removed}` : ''} = ${merged.length}件）`);

  const after = (await fbGet(`${BASE}/recommendations`).catch(() => null)) || [];
  const n = Array.isArray(after) ? after.filter(Boolean).length : 0;
  console.log(n === merged.length ? `✅ 反映を確認（${n}件）` : `⚠️ 反映後の件数が想定と違います（${n} vs ${merged.length}）`);
  console.log('=== 完了・課金は発生していません（$0）===');
}

// テストから import したときに本体が走らないよう、直接実行のときだけ動かす。
// endsWith だと test-build-recs.mjs も一致してしまうので、ファイル名を厳密に比べる。
const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'build-recs.mjs') main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });
