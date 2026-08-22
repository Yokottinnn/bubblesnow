// 過去の採用・却下から語の重みを学習する。LLM 不使用・課金ゼロ。
//
// ★材料はすでに Firebase にあって、これまで捨てられていた★
//   正例: tasks のうち note に「おすすめから追加」が付いたもの
//         → recs から実際にタスク化した ＝ 当たりだった
//   負例: dismissedTitles（251件）
//         → 「−」で却下した ＝ 外れだった
//
// これまで dismissedTitles は「二度と出さない」ための除外リストとしてしか
// 使っていなかった。なぜ却下したのかは学んでいないし、採用された側は
// 一切見ていなかった。build-recs.mjs のスコアは私が手で決めた重みなので、
// そこに利用者の実際の行動を上乗せする。
//
// ★日本語なので文字 N-gram を使う★
// 形態素解析器を足すと依存が増え、launchd から動かす前提だと壊れやすい。
// 2〜3文字の連なりを数えるだけで「還元」「エアドロ」「まとめ」のような
// 効く語は十分に拾える。分かち書きの精度は要らない。
//
// ★出力は Mac のローカルに置く★
// 正例はタスク名から作る。タスクには確定申告や通院が含まれるので、
// 学習結果もリポジトリには入れない（.gitignore 済み）。
//
// 実行: node scripts/learn-preferences.mjs

import { writeFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const BASE = 'users/yokota';
const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

const OUT = 'learned-weights.json';

// 何回以上現れた語を採用するか。1〜2回の語は偶然なので効かせない。
const MIN_COUNT = Number(process.env.MIN_COUNT || 3);
// 上位いくつ残すか。多すぎると雑音を拾う。
const MAX_TERMS = Number(process.env.MAX_TERMS || 200);
// 学習分がスコア全体を支配しないための上限（build-recs 側でも clamp する）。
const MAX_WEIGHT = 3;

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

// 記号や数字は語として意味を持たないので落とす。数字を残すと
// 「20%」の 20 が効いてしまい、率そのものの評価と二重になる。
const clean = (s) => String(s || '')
  .toLowerCase()
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/[0-9０-９]+/g, ' ')
  .replace(/[\s　!-/:-@\[-`{-~、。・「」『』（）【】…〜✨🎏🌴]/gu, ' ')
  .trim();

// 2文字と3文字の連なりを取る。日本語は2文字で語になることが多く、
// 3文字を足すと「エアドロ」「キャンペ」のような塊も拾える。
export function ngrams(text) {
  const out = new Set();
  for (const chunk of clean(text).split(/\s+/)) {
    if (chunk.length < 2) continue;
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= chunk.length; i += 1) out.add(chunk.slice(i, i + n));
    }
  }
  return [...out];
}

function count(texts) {
  const m = new Map();
  for (const t of texts) for (const g of ngrams(t)) m.set(g, (m.get(g) || 0) + 1);
  return m;
}

// ★重みの決め方★
// 正例に多く負例に少ない語ほど高くする。件数が偏っているので、
// 生の回数ではなく「その集合の中での出現率」を比べる。
// 加算スムージングを入れて、1回しか出ない語が極端な値にならないようにする。
export function learnWeights(adopted, dismissed, opts = {}) {
  const minCount = opts.minCount ?? MIN_COUNT;
  const maxTerms = opts.maxTerms ?? MAX_TERMS;

  const pos = count(adopted);
  const neg = count(dismissed);
  const posTotal = Math.max(1, adopted.length);
  const negTotal = Math.max(1, dismissed.length);

  const terms = new Set([...pos.keys(), ...neg.keys()]);
  const scored = [];

  for (const term of terms) {
    const p = pos.get(term) || 0;
    const n = neg.get(term) || 0;
    if (p + n < minCount) continue;

    // 出現率の比の対数。正例側に偏れば正、負例側に偏れば負。
    const pRate = (p + 0.5) / (posTotal + 1);
    const nRate = (n + 0.5) / (negTotal + 1);
    let w = Math.log(pRate / nRate);

    // 確信度で減衰させる。3回の語と30回の語を同じ強さにしない。
    w *= Math.min(1, (p + n) / 10);
    w = Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, w));

    if (Math.abs(w) < 0.15) continue; // ほぼ中立の語は持たない
    scored.push({ term, weight: Number(w.toFixed(3)), pos: p, neg: n });
  }

  scored.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return scored.slice(0, maxTerms);
}

async function main() {
  console.log('=== 採用・却下からの学習（LLM不使用・課金なし）===\n');

  const tasksRaw = (await fbGet(`${BASE}/tasks`).catch(() => [])) || [];
  const tasks = (Array.isArray(tasksRaw) ? tasksRaw : Object.values(tasksRaw)).filter(Boolean);
  const dismissed = ((await fbGet(`${BASE}/dismissedTitles`).catch(() => [])) || []).filter(Boolean);

  // recs から追加したタスクだけが正例。手で足したタスクは
  // 「おすすめとして出したら当たりだった」の証拠にならないので混ぜない。
  const adopted = tasks
    .filter((t) => String(t.note || '').includes('おすすめから追加'))
    .map((t) => String(t.name || ''))
    .filter(Boolean);

  console.log(`正例（おすすめから追加したタスク）: ${adopted.length}件`);
  console.log(`負例（却下したタイトル）        : ${dismissed.length}件`);
  console.log('※ 中身はログに出しません（public リポジトリのため）\n');

  if (adopted.length < 5) {
    console.warn('⚠️ 正例が少なすぎます。負例だけで学習すると「嫌いな語」しか学べません。');
    console.warn('   おすすめから何件か採用すると精度が上がります。');
  }

  const weights = learnWeights(adopted, dismissed);
  const plus = weights.filter((w) => w.weight > 0);
  const minus = weights.filter((w) => w.weight < 0);

  console.log(`学習した語: ${weights.length}語（好む ${plus.length} / 避ける ${minus.length}）\n`);

  // 語そのものはキャンペーン名の断片なので出してよい。件数と重みで妥当性を見る。
  console.log('── 好む語 上位10 ──');
  for (const w of plus.slice(0, 10)) console.log(`  +${w.weight.toFixed(2)}  ${w.term}（採用${w.pos} / 却下${w.neg}）`);
  console.log('\n── 避ける語 上位10 ──');
  for (const w of minus.slice(0, 10)) console.log(`  ${w.weight.toFixed(2)}  ${w.term}（採用${w.pos} / 却下${w.neg}）`);

  await writeFile(OUT, JSON.stringify({
    learnedAt: new Date().toISOString(),
    counts: { adopted: adopted.length, dismissed: dismissed.length, terms: weights.length },
    weights,
  }, null, 2));

  console.log(`\n📦 ${OUT} に保存しました（リポジトリには入りません）`);
  console.log('=== 完了・課金は発生していません（$0）===');
}

const invoked = (process.argv[1] || '').split('/').pop();
if (invoked === 'learn-preferences.mjs') main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });
