#!/usr/bin/env node
/* おすすめが画面に出ない／出たはずの件数と合わないときの診断。読み取り専用。
 *
 * ★なぜ要るのか★
 *   「何件作ったか」は心拍（mac/last-run.md）に出るが、**それが画面に出るか**は
 *   別の話。rec は次の4つの関門を通る。
 *
 *     ① 選別   build-recs.mjs の除外（既出・却下済み・タスク化済み・低得点）
 *     ② 整理   build-recs.mjs の prune（却下済み・締切切れ・重複・上限60）
 *     ③ 表示   index.html:306-307 のフィルタ（dismissed / added / タスク名 / 却下タイトル）
 *     ④ 上限   recommendations の 60枠
 *
 *   ②と③は**同じことを別の物差しで**判定している。ずれていると、作ったのに
 *   消える rec が出る。実際に 2026-10-03、①を通った 25件のうち 2件が②で
 *   殺されていた（原因は正規化の違い。isDismissedForBuild で修正済み）。
 *   2026-08-31 には④が却下済みの rec で 60枠中51枠埋まっていた。
 *
 *   どちらも「選別できた件数」には一切現れない。だから実データで突き合わせる。
 *
 * ★出していいもの・いけないもの★
 *   このリポジトリは public。**中身は一切出力しない。**
 *   件数・rec ID・判定理由・文字数だけ。タイトル・URL・メールアドレスは出さない。
 *   docs/CURRENT_SPEC.md と同じ方針（scripts/inspect-tasks.mjs が先例）。
 *
 * 実行（Firebase の読み取りのみ。API 課金なし＝$0）:
 *   set -a && . mac/.env && set +a && node scripts/diagnose-recs-filter.mjs
 */

import { readFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const BASE = 'users/yokota';
const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

if (!FIREBASE_URL) {
  console.error('FIREBASE_URL が無い。mac/.env を読み込んでから実行する:');
  console.error('  set -a && . mac/.env && set +a && node scripts/diagnose-recs-filter.mjs');
  process.exit(1);
}

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}
const asArray = (v) => (Array.isArray(v) ? v : v ? Object.values(v) : []);

/* ★二つの物差し★ ここが診断の要。
   app   … index.html:408 sanitizeRec + 213 の判定。空白と句読点を残す
   build … build-recs.mjs:76 norm。空白と句読点を除去する
   同じタイトルでも答えが変わる。変わる件数がそのまま「無駄になった枠」。 */
const appNorm = (t) => (t ? String(t).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : '');
const buildNorm = (s) => String(s || '').toLowerCase().replace(/[\s　"'“”‘’|｜・,、。．.!！?？]/g, '');

const recsRaw = await fbGet(`${BASE}/recommendations`);
const recs = asArray(recsRaw).filter(Boolean);
const dismissed = asArray(await fbGet(`${BASE}/dismissed`)).filter(Boolean).map(String);
const added = asArray(await fbGet(`${BASE}/added`)).filter(Boolean).map(String);
const dts = asArray(await fbGet(`${BASE}/dismissedTitles`)).filter(Boolean);
const tasks = asArray(await fbGet(`${BASE}/tasks`)).filter(Boolean);
const taskNames = new Set(tasks.map((t) => appNorm(String(t.name || '').replace(/\n/g, ''))));

console.log('## 入力の規模');
console.log(`  recommendations ${recs.length} / dismissed(ID) ${dismissed.length} / added(ID) ${added.length}`);
console.log(`  dismissedTitles ${dts.length} / tasks ${tasks.length}`);
const nums = recs.map((r) => Number((String(r.id).match(/^r(\d+)$/) || [])[1])).filter(Number.isFinite);
if (nums.length) console.log(`  rec ID範囲 r${Math.min(...nums)} 〜 r${Math.max(...nums)}`);

/* index.html:307 の titleDismissed をそのまま。短い針は巻き込まない。 */
function titleDismissedHit(titleLower) {
  for (const dt of dts) {
    const d = String(dt).toLowerCase();
    if (d === titleLower) return { dt: d, kind: 'exact' };
    const shorter = d.length <= titleLower.length ? d : titleLower;
    if (shorter.length < 6) continue;
    if (titleLower.indexOf(d) >= 0 || d.indexOf(titleLower) >= 0) return { dt: d, kind: 'partial' };
  }
  return null;
}

console.log('\n## ③表示フィルタ: 今 Firebase にある rec のうち画面に出るのは何件か');
const reasons = { dismissedId: 0, addedId: 0, taskName: 0, dtExact: 0, dtPartial: 0 };
const needleLens = [];
const perRec = [];
let visible = 0;

for (const r of recs) {
  const t = appNorm(r.title);
  const hit = titleDismissedHit(t);
  // index.html と同じ順序で最初に当たった理由を採る
  let reason = null;
  if (dismissed.includes(String(r.id))) reason = 'dismissedId';
  else if (added.includes(String(r.id))) reason = 'addedId';
  else if (taskNames.has(t)) reason = 'taskName';
  else if (hit) reason = hit.kind === 'exact' ? 'dtExact' : 'dtPartial';

  if (reason) {
    reasons[reason] += 1;
    if (reason === 'dtPartial') needleLens.push(hit.dt.length);
  } else visible += 1;
  perRec.push(`${r.id}=${reason || 'visible'}`);
}

console.log(`  表示 ${visible}件 / 落ちる ${recs.length - visible}件`);
console.log(`    dismissed(ID一致) ${reasons.dismissedId} / added(ID一致) ${reasons.addedId}`);
console.log(`    タスク名と完全一致 ${reasons.taskName}`);
console.log(`    却下タイトルと完全一致 ${reasons.dtExact} / 部分一致 ${reasons.dtPartial}`);
console.log(`  rec別: ${perRec.join(' ')}`);

/* ★部分一致の閾値は妥当か★
   「6文字以上なら部分一致で落とす」は、短い針が無関係な rec を巻き添えに
   する恐れがある。閾値を上げて表示件数が変わらないなら、害は出ていない。 */
console.log('\n## 部分一致の閾値を上げたら表示件数は変わるか');
for (const minLen of [6, 8, 9, 10, 12, 15, 20]) {
  let vis = 0;
  for (const r of recs) {
    const t = appNorm(r.title);
    let blocked = dismissed.includes(String(r.id)) || added.includes(String(r.id)) || taskNames.has(t);
    if (!blocked) {
      blocked = dts.some((dt) => {
        const d = String(dt).toLowerCase();
        if (d === t) return true;
        const shorter = d.length <= t.length ? d : t;
        if (shorter.length < minLen) return false;
        return t.indexOf(d) >= 0 || d.indexOf(t) >= 0;
      });
    }
    if (!blocked) vis += 1;
  }
  console.log(`  minLen=${minLen} → 表示 ${vis}/${recs.length}`);
}
if (needleLens.length) {
  const nl = needleLens.sort((a, b) => a - b);
  console.log(`  実際に落とした針の文字数: 最小${nl[0]} / 中央${nl[Math.floor((nl.length - 1) / 2)]} / 最大${nl[nl.length - 1]}`);
} else {
  console.log('  → 部分一致で落ちた rec は無い。閾値を触る理由は今は無い');
}

console.log('\n## 却下タイトルの文字数分布（短い針が多いほど巻き添えが起きやすい）');
const dl = dts.map((x) => String(x).length).sort((a, b) => a - b);
console.log(`  ${dl.length}本 / 最小${dl[0]} / 中央${dl[Math.floor((dl.length - 1) / 2)]} / 最大${dl[dl.length - 1]}`);
for (const [lo, hi] of [[1, 5], [6, 9], [10, 14], [15, 19], [20, Infinity]]) {
  console.log(`  ${lo}〜${hi === Infinity ? '' : hi}文字: ${dl.filter((n) => n >= lo && n <= hi).length}本`);
}
const collateral = dts.map((dt) => {
  const d = String(dt).toLowerCase();
  let c = 0;
  for (const r of recs) {
    const t = appNorm(r.title);
    if (!t || d === t) continue;
    const shorter = d.length <= t.length ? d : t;
    if (shorter.length < 6) continue;
    if (t.indexOf(d) >= 0 || d.indexOf(t) >= 0) c += 1;
  }
  return { len: d.length, c };
}).filter((x) => x.c > 0).sort((a, b) => b.c - a.c);
console.log(`  他の rec にも刺さる針: ${collateral.length}/${dl.length}本`);
if (collateral.length) {
  console.log(`  上位10（文字数:巻き添え数）: ${collateral.slice(0, 10).map((x) => `${x.len}文字:${x.c}件`).join(', ')}`);
}

/* ★①と②の食い違いを測る★
   選別を通った rec が、書き込み直前の prune で殺されていないか。
   殺されるなら、その枠には本来別の候補が入れられた＝無駄になった枠。 */
console.log('\n## ①選別 と ②整理 の食い違い（直近のバッチ）');
let preview = null;
try {
  preview = JSON.parse(await readFile('recs-built-preview.json', 'utf8'));
} catch {
  console.log('  recs-built-preview.json が無い。バッチを一度回してから見る');
}
if (preview) {
  const pv = (Array.isArray(preview) ? preview : preview.recs || []).filter(Boolean);
  const pvIds = pv.map((r) => String(r.id));
  const inFb = pvIds.filter((id) => recs.some((r) => String(r.id) === id));
  /* 「Firebase に存在」が 0件なら、たいていは preview が MODE=dry-run で
     上書きされたあと。dry-run は ID を振るが書き込まないので全部欠落に見える。
     この行が意味を持つのは、直近の実行が MODE=live だったときだけ。 */
  console.log(`  選定 ${pv.length}件 / Firebase に存在 ${inFb.length}件`
    + (inFb.length === 0 ? '（直近が dry-run なら 0件で正常。書き込んでいないため）' : ''));
  if (inFb.length > 0) {
    console.log(`  欠落ID: ${pvIds.filter((id) => !inFb.includes(id)).join(', ') || 'なし'}`);
  }

  // prune が落とす条件を、prune と同じ物差し（buildNorm）で再現する
  const deadKeys = new Set(dts.map(buildNorm));
  const iso = new Date().toISOString().slice(0, 10);
  const byDismiss = pv.filter((r) => deadKeys.has(buildNorm(r.title)));
  const byDeadline = pv.filter((r) => r.deadline && r.deadline < iso);
  const seenKeys = new Map();
  for (const r of pv) {
    const k = buildNorm(r.title);
    if (k) seenKeys.set(k, (seenKeys.get(k) || 0) + 1);
  }
  const byDup = [...seenKeys.values()].reduce((a, n) => a + (n - 1), 0);

  console.log(`  prune が捨てる見込み: 却下一致 ${byDismiss.length}件 / 締切切れ ${byDeadline.length}件 / 重複 ${byDup}件`);
  console.log(`    却下一致のID: ${byDismiss.map((r) => r.id).join(', ') || 'なし'}`);
  console.log(`    締切切れのID: ${byDeadline.map((r) => `${r.id}(${r.deadline})`).join(', ') || 'なし'}`);
  const wasted = byDismiss.length + byDeadline.length + byDup;
  console.log(`  → 選定 ${pv.length}件のうち利用者に届くのは ${pv.length - wasted}件（無駄になった枠 ${wasted}）`);
  if (byDismiss.length) {
    console.log('  ⚠️ 却下一致が残っている。選別が prune と同じ物差しで見ていない');
    console.log('     build-recs.mjs の isDismissedForBuild を確認する');
  }
  if (byDeadline.length) {
    console.log('  ⚠️ 締切切れが残っている。選別は締切を見ずに選び、prune が後で落としている');
  }
}

console.log('\n## ④枠');
console.log(`  ${recs.length} / 60${recs.length >= 60 ? '　⚠️ 上限に達している。古い rec が押し出されている' : ''}`);
console.log('\n（Firebase の読み取りのみ。API 課金は発生していない＝$0）');
