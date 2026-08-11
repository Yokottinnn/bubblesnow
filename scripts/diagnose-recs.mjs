// recs まわりの診断（読み取り専用）
//
//   ① Make.com が recommendations を更新しているかを ID から判定する
//   ② dismissedTitles の誤爆（新しいrecが黙って消える問題）を定量化する
//
// ★プライバシー方針★
// このリポジトリは public で Actions のログも公開される。
// dismissedTitles には個人的な内容が含まれうるので、**中身は絶対に出力しない**。
// 出すのは件数・文字数・ID・判定結果だけ。

import { readFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const BASE = 'users/yokota';
const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

const norm = (s) => String(s || '').trim().toLowerCase();

// index.html:213 と同じ判定（双方向部分一致）
function currentMatch(title, dts) {
  const t = norm(title);
  if (!t) return null;
  return dts.find((dt) => dt && (t.includes(dt) || dt.includes(t))) ?? null;
}

// 提案する判定: 完全一致、または「十分長く・十分近い」場合だけ部分一致を認める
function proposedMatch(title, dts, minLen, ratio) {
  const t = norm(title);
  if (!t) return null;
  return dts.find((dt) => {
    if (!dt) return false;
    if (dt === t) return true;
    const [short, long] = dt.length <= t.length ? [dt, t] : [t, dt];
    if (short.length < minLen) return false;              // 短すぎる語は針にしない
    if (short.length / long.length < ratio) return false; // 長さが離れすぎは別物とみなす
    return long.includes(short);
  }) ?? null;
}

async function main() {
  console.log('=== recs 診断（中身は出力しません）===\n');

  // ── ① Make.com は recommendations を更新しているか ──
  const recs = (await fbGet(`${BASE}/recommendations`)) || [];
  const arr = Array.isArray(recs) ? recs.filter(Boolean) : Object.values(recs).filter(Boolean);
  const ids = arr.map((r) => String(r.id || '(id無し)'));
  console.log('── ① recommendations の現状 ──');
  console.log(`  件数: ${arr.length}`);
  console.log(`  ID一覧: ${ids.join(', ')}`);

  const ours = ['r249', 'r250', 'r251', 'r252', 'r253', 'r254'];
  const surviving = ours.filter((id) => ids.includes(id));
  console.log(`  2026-08-09 に投入したポイ活rec: ${surviving.length}/6 件が生存`);

  const nums = ids.map((s) => (s.match(/^r(\d+)$/) || [])[1]).filter(Boolean).map(Number);
  if (nums.length) console.log(`  ID範囲: r${Math.min(...nums)} 〜 r${Math.max(...nums)}`);
  console.log(
    surviving.length === 6
      ? '  → 投入分がそのまま残っている。Make.com は recommendations を上書きしていない。'
      : '  → 投入分が失われている。何かが上書きしている。'
  );
  console.log(
    `  ※ Make.com のプロンプトは「15-25件」を指示している。現在 ${arr.length} 件という数自体も判断材料。\n`
  );

  // ── ② dismissedTitles の誤爆 ──
  const dtsRaw = (await fbGet(`${BASE}/dismissedTitles`)) || [];
  const dts = (Array.isArray(dtsRaw) ? dtsRaw : []).map(norm).filter(Boolean);
  console.log('── ② dismissedTitles の状態 ──');
  console.log(`  件数: ${dts.length}`);

  const lens = dts.map((s) => s.length).sort((a, b) => a - b);
  const pct = (p) => lens[Math.floor((lens.length - 1) * p)];
  console.log(`  文字数: 最短${lens[0]} / 中央${pct(0.5)} / 最長${lens[lens.length - 1]}`);
  for (const n of [2, 4, 6, 8]) {
    console.log(`    ${n}文字未満: ${lens.filter((l) => l < n).length}件`);
  }

  // 投入候補が現行ロジックで何件消えるか
  const payload = JSON.parse(await readFile('data/poikatsu-recs.json', 'utf8'));
  const titles = payload.recs.map((r) => r.title);

  console.log('\n  現行ロジック（双方向部分一致）での判定:');
  let curBlocked = 0;
  for (const t of titles) {
    const hit = currentMatch(t, dts);
    if (hit) {
      curBlocked++;
      // ★一致した dismissedTitle の中身は出さず、長さだけ報告する★
      console.log(`    ❌ 除外: 「${t}」 ← 一致した語は ${hit.length}文字（内容は非表示）`);
    }
  }
  console.log(`    除外された数: ${curBlocked}/${titles.length}`);

  console.log('\n  提案ロジックでの判定（しきい値ごと）:');
  for (const [minLen, ratio] of [[6, 0.6], [8, 0.6], [6, 0.75]]) {
    const blocked = titles.filter((t) => proposedMatch(t, dts, minLen, ratio));
    console.log(`    minLen=${minLen} ratio=${ratio} → 除外 ${blocked.length}/${titles.length}`);
  }

  // 本来消したいもの（既にdismiss済みのタイトル自身）は引き続き消えるか＝取りこぼし確認
  console.log('\n  回帰チェック（dismissedTitles 自身が提案ロジックでも除外されるか）:');
  for (const [minLen, ratio] of [[6, 0.6], [8, 0.6], [6, 0.75]]) {
    const kept = dts.filter((dt) => !proposedMatch(dt, dts, minLen, ratio));
    console.log(`    minLen=${minLen} ratio=${ratio} → 取りこぼし ${kept.length}/${dts.length}件`);
  }

  console.log('\n=== 診断完了 ===');
}

main().catch((err) => {
  console.error('❌ 失敗:', err);
  process.exit(1);
});
