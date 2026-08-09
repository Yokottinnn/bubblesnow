// BubblesNow: リサーチ済みレコメンドを Firebase にマージ書き込みする
//
// 設計上の約束:
//   - 既存 recs は消さない（全置換ではなくマージ追記）
//   - 書き込み前に必ず現状をバックアップ出力する
//   - URL は HTTP 実チェックし、到達できないものは空文字にする
//     （設計書: 「不確かなURLは空文字にせよ。壊れたリンクは絶対に含めるな」）
//   - dismissed 済みのタイトルは再提示しない
//   - DRY_RUN=true（既定）では一切書き込まない
//
// 実行: node scripts/push-recs.mjs

import { readFile, writeFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const PAYLOAD = process.env.PAYLOAD || 'data/poikatsu-recs.json';
const BASE = 'users/yokota';

if (!FIREBASE_URL) {
  console.error('FIREBASE_URL が未設定です');
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

// Firebase から返る recs は配列/オブジェクト/文字列いずれもありうる。
// index.html の extractRecs と同じ寛容さで配列に正規化する。
function toRecArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.filter((r) => r && r.id);
  if (typeof data === 'string') {
    try { return toRecArray(JSON.parse(data)); } catch { return []; }
  }
  if (typeof data === 'object') {
    const vals = Object.values(data).filter((r) => r && typeof r === 'object' && r.id);
    if (vals.length) return vals;
  }
  return [];
}

// URL の実在確認。HEAD を試し、拒否されたら GET でフォールバック。
async function urlAlive(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BubblesNow/1.0)' },
      });
      clearTimeout(timer);
      if (res.ok) return true;
      // HEAD を塞いでいるサイトがあるので GET で再挑戦する
      if (method === 'HEAD' && (res.status === 405 || res.status === 403)) continue;
      return false;
    } catch {
      if (method === 'GET') return false;
    }
  }
  return false;
}

async function resolveUrl(candidates = []) {
  for (const url of candidates) {
    const ok = await urlAlive(url);
    console.log(`    ${ok ? '✅' : '❌'} ${url}`);
    if (ok) return url;
  }
  return '';
}

function nextIdAllocator(existing) {
  let max = 0;
  for (const r of existing) {
    const m = String(r.id || '').match(/^r(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let next = max + 1;
  return () => `r${next++}`;
}

const norm = (s) => String(s || '').trim().toLowerCase();

function isDismissedTitle(title, dismissedTitles) {
  const t = norm(title);
  if (!t) return false;
  // index.html の visible フィルタと同じ双方向部分一致
  return dismissedTitles.some((dt) => dt && (t.includes(dt) || dt.includes(t)));
}

async function main() {
  console.log('=== BubblesNow recs マージ書き込み ===');
  console.log(`モード: ${DRY_RUN ? '🧪 DRY RUN（書き込みなし）' : '🚀 本番書き込み'}`);

  const payload = JSON.parse(await readFile(PAYLOAD, 'utf8'));
  const incoming = payload.recs || [];
  console.log(`投入候補: ${incoming.length}件（researchedAt: ${payload.researchedAt}）\n`);

  // ── 1. 現状取得＋バックアップ ──
  const rawRecs = await fbGet(`${BASE}/recommendations`);
  const existing = toRecArray(rawRecs);
  const dismissed = (await fbGet(`${BASE}/dismissed`).catch(() => [])) || [];
  const dismissedTitles = ((await fbGet(`${BASE}/dismissedTitles`).catch(() => [])) || []).map(norm);

  await writeFile('recs-backup.json', JSON.stringify(rawRecs, null, 2));
  console.log(`📦 既存 recs: ${existing.length}件 → recs-backup.json に保存`);
  console.log(`   dismissed: ${Array.isArray(dismissed) ? dismissed.length : 0}件 / dismissedTitles: ${dismissedTitles.length}件\n`);

  // ── 2. URL 実チェック ──
  console.log('🔗 URL 到達確認:');
  const checked = [];
  for (const rec of incoming) {
    console.log(`  ${rec.title}`);
    const url = await resolveUrl(rec.urlCandidates);
    const { urlCandidates, ...rest } = rec;
    checked.push({ ...rest, url });
  }

  // ポイ活(お金)は告知ページURL必須。全滅したものは品質を満たさないので落とす。
  const urlOk = checked.filter((r) => {
    if (r.category === 'お金' && !r.url) {
      console.log(`\n⚠️  除外（URL全滅・お金カテゴリはURL必須）: ${r.title}`);
      return false;
    }
    return true;
  });

  // ── 3. 重複・dismissed 除外 ──
  const existingTitles = existing.map((r) => norm(r.title));
  const fresh = urlOk.filter((r) => {
    if (existingTitles.includes(norm(r.title))) {
      console.log(`\n⏭️  スキップ（既出）: ${r.title}`);
      return false;
    }
    if (isDismissedTitle(r.title, dismissedTitles)) {
      console.log(`\n⏭️  スキップ（dismiss済み）: ${r.title}`);
      return false;
    }
    return true;
  });

  // ── 4. ID採番＋マージ ──
  const allocId = nextIdAllocator(existing);
  const withIds = fresh.map((r) => ({
    id: allocId(),
    title: r.title,
    desc: r.desc,
    category: r.category,
    source: r.source,
    icon: r.icon,
    priority: r.priority,
    deadline: r.deadline || '',
    url: r.url || '',
    location: r.location || '',
  }));

  const merged = existing.concat(withIds);

  console.log(`\n=== 結果 ===`);
  console.log(`既存 ${existing.length}件 + 新規 ${withIds.length}件 = ${merged.length}件`);
  for (const r of withIds) {
    console.log(`  ${r.id} ${r.icon} ${r.title}${r.url ? ` → ${r.url}` : ' （URLなし）'}`);
  }
  await writeFile('recs-merged-preview.json', JSON.stringify(merged, null, 2));

  if (!withIds.length) {
    console.log('\n新規追加なし。書き込みをスキップします。');
    return;
  }

  // ── 5. 書き込み ──
  if (DRY_RUN) {
    console.log('\n🧪 DRY RUN のため書き込みませんでした。');
    console.log('   本番実行するには workflow の DRY_RUN を "false" にしてください。');
    return;
  }

  await fbPut(`${BASE}/recommendations`, merged);
  console.log(`\n✅ 書き込み完了: ${BASE}/recommendations（${merged.length}件）`);
}

main().catch((err) => {
  console.error('❌ 失敗:', err);
  process.exit(1);
});
