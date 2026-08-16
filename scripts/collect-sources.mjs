// recs の「材料」を無料で集める（読み取り専用・Firebaseには一切書かない）
//
// ★なぜこれを作るのか★
// 現行の generate-recs.mjs は Claude の web_search に検索させていて、1回 $0.4 かかる。
// その費用の8割超は入力トークン（実測 104,003）で、これは検索を8回まわす間に
// 検索結果を積み上げたまま会話を送り直すために膨らんでいる。
// つまり払っているのは判断力ではなく検索結果の運搬料。
//
// GitHub Actions のランナーには egress 制限がないので、検索は自分でできる。
// Google ニュースの RSS 検索と はてなブックマークの検索 RSS はどちらも
// APIキー不要。public リポジトリの Actions 実行時間も無料。つまり収集は $0 で済む。
//
// このスクリプトは材料を集めて JSON に落とすところまでを担当する。
// 「15〜25件に絞って rec に整形する」判断の部分はまだ持たせていない。
// まず何がどれだけ集まるかを見てから、その方式（Gemini無料枠 / Haiku / LLMなし）を決める。
//
// 実行: node scripts/collect-sources.mjs

import { writeFile } from 'node:fs/promises';

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const BASE = 'users/yokota';
const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

// 何日前までの記事を拾うか。古いキャンペーンは期限切れの可能性が高い。
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 21);
// URL解決は1件ずつHTTPを叩くので、上限を置かないと実行時間が伸びる。
const MAX_RESOLVE = Number(process.env.MAX_RESOLVE || 120);

// カテゴリはアプリ側の定義に合わせる（index.html の CC と同じ語）。
// icon は rec の見た目に使う。priority は後段で決めるのでここでは持たせない。
const SOURCES = [
  { key: 'サウナ',       category: 'おでかけ',       icon: '♨️', queries: ['東京 サウナ 新店', 'サウナ オープン 東京'] },
  { key: 'テック',       category: 'キャリア・学び', icon: '💻', queries: ['東京 テックカンファレンス', 'エンジニア 勉強会 東京'] },
  { key: 'アート',       category: 'おでかけ',       icon: '🎨', queries: ['東京 展覧会 開幕', '美術展 東京 開催'] },
  { key: 'ポイ活',       category: 'お金',           icon: '💰', queries: ['ポイ活 キャンペーン 還元', 'ポイント還元 キャンペーン 開始'] },
  { key: 'クリプト',     category: 'お金',           icon: '🪙', queries: ['仮想通貨 キャンペーン 配布', 'エアドロップ 暗号資産'] },
];

const UA = 'Mozilla/5.0 (compatible; BubblesNowBot/1.0; +https://github.com/Yokottinnn/bubblesnow)';

async function fetchText(url, { timeout = 15000, redirect = 'follow' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect, signal: ctrl.signal });
    return { ok: res.ok, status: res.status, url: res.url, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, url, text: '', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 依存を増やしたくないので RSS は最小限の取り出しで済ませる。
// item ごとに切り出してからタグを引く。CDATA と実体参照の両方に対応する。
function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const block of blocks) {
    const body = block.slice(0, block.indexOf('</item>') >= 0 ? block.indexOf('</item>') : block.length);
    const pick = (tag) => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeXml(m[1]) : '';
    };
    const title = pick('title');
    const link = pick('link');
    if (!title || !link) continue;
    items.push({ title, link, pubDate: pick('pubDate') || pick('dc:date'), source: pick('source') });
  }
  return items;
}

function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Google ニュースの見出しは「記事タイトル - 媒体名」の形で来る。媒体名は rec に要らない。
function stripOutlet(title) {
  return title.replace(/\s+-\s+[^-]{2,30}$/, '').trim();
}

function withinAge(pubDate) {
  if (!pubDate) return true; // 日付が取れないものは落とさない（後段で判断できる）
  const t = Date.parse(pubDate);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) / 86400000 <= MAX_AGE_DAYS;
}

// ★Google ニュースのリンクは news.google.com 経由★
// rec には実際の告知ページを載せたいので、リダイレクトを追って発行元URLにする。
// 追えなかったものは url を空にして残す（後段で「URLなし」として扱えるように）。
async function resolveUrl(link) {
  if (!/^https?:\/\/news\.google\.com\//.test(link)) return link;
  const res = await fetchText(link, { timeout: 12000 });
  if (res.ok && res.url && !/^https?:\/\/news\.google\.com\//.test(res.url)) return res.url;
  // JSでリダイレクトする形で返ってくることがあるので、HTML から発行元URLを拾う
  const m = res.text.match(/<c-wiz[\s\S]{0,4000}?href="(https?:\/\/(?!news\.google\.com)[^"]+)"/)
    || res.text.match(/url=(https?:\/\/(?!news\.google\.com)[^"'&]+)/)
    || res.text.match(/<link[^>]+rel="canonical"[^>]+href="(https?:\/\/(?!news\.google\.com)[^"]+)"/);
  return m ? decodeXml(m[1]) : '';
}

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

// index.html:213 と同じ判定。短い語での巻き込みだけ避ける。
function isDismissed(title, dismissedTitles) {
  const t = title.trim().toLowerCase();
  return dismissedTitles.some((dt) => {
    if (!dt) return false;
    const d = String(dt).toLowerCase();
    if (d === t) return true;
    const shorter = d.length <= t.length ? d : t;
    if (shorter.length < 6) return false;
    return t.indexOf(d) >= 0 || d.indexOf(t) >= 0;
  });
}

const norm = (s) => s.toLowerCase().replace(/[\s　"'“”‘’|｜・,、。．.]/g, '');

async function main() {
  console.log('=== recs 材料の収集（読み取り専用・課金なし）===');
  console.log(`対象期間: 直近 ${MAX_AGE_DAYS} 日 / URL解決の上限: ${MAX_RESOLVE} 件\n`);

  // 除外用。件数だけ出す（このリポジトリは public なので中身はログに出さない）。
  let dismissedTitles = [];
  let existingTitles = [];
  if (FIREBASE_URL) {
    dismissedTitles = (await fbGet(`${BASE}/dismissedTitles`).catch(() => [])) || [];
    const recs = (await fbGet(`${BASE}/recommendations`).catch(() => [])) || [];
    existingTitles = (Array.isArray(recs) ? recs : []).filter(Boolean).map((r) => String(r.title || ''));
    console.log(`除外リスト: dismissedTitles ${dismissedTitles.length}件 / 既存recs ${existingTitles.length}件\n`);
  } else {
    console.log('FIREBASE_URL 未設定のため除外はしません（収集だけ確認します）\n');
  }

  const collected = [];
  const seen = new Set();
  const stats = [];

  for (const src of SOURCES) {
    let raw = 0;
    for (const q of src.queries) {
      const feeds = [
        `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`,
        // はてなブックマークの検索RSSは発行元URLがそのまま入るのでリダイレクト解決が要らない
        `https://b.hatena.ne.jp/search/text?q=${encodeURIComponent(q)}&mode=rss&sort=recent`,
      ];
      for (const feed of feeds) {
        const res = await fetchText(feed);
        if (!res.ok) {
          console.log(`  ⚠️ 取得失敗 (${res.status || res.error}) ${feed.slice(0, 60)}...`);
          continue;
        }
        const items = parseRss(res.text);
        raw += items.length;
        for (const it of items) {
          if (!withinAge(it.pubDate)) continue;
          const title = stripOutlet(it.title);
          const key = norm(title);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          collected.push({ ...src, title, link: it.link, pubDate: it.pubDate });
        }
      }
    }
    stats.push({ key: src.key, raw });
  }

  console.log('── 収集結果（重複除去前 → 後）──');
  for (const s of stats) console.log(`  ${s.key.padEnd(6, '　')} 生 ${s.raw}件`);
  console.log(`  合計 ${collected.length}件（重複とタイトル正規化で除去済み）\n`);

  // 既出・却下済みを落とす
  const before = collected.length;
  const filtered = collected.filter((c) => {
    if (existingTitles.some((t) => norm(t) === norm(c.title))) return false;
    if (dismissedTitles.length && isDismissed(c.title, dismissedTitles)) return false;
    return true;
  });
  console.log(`── 既出・却下の除外 ──`);
  console.log(`  ${before}件 → ${filtered.length}件（${before - filtered.length}件を除外）\n`);

  // URL解決。Google経由のものだけ実URLに直す。
  const targets = filtered.slice(0, MAX_RESOLVE);
  let resolved = 0;
  let failed = 0;
  for (const c of targets) {
    c.url = await resolveUrl(c.link);
    if (c.url) resolved += 1; else failed += 1;
  }
  console.log('── URL解決 ──');
  console.log(`  解決 ${resolved}件 / 失敗 ${failed}件（対象 ${targets.length}件）`);
  if (filtered.length > MAX_RESOLVE) console.log(`  ※ ${filtered.length - MAX_RESOLVE}件は上限のため未解決のまま残しています`);
  console.log('');

  const usable = targets.filter((c) => c.url);

  console.log('── カテゴリ別の使える候補 ──');
  for (const src of SOURCES) {
    const n = usable.filter((c) => c.key === src.key).length;
    console.log(`  ${src.icon} ${src.key.padEnd(6, '　')} ${n}件`);
  }
  console.log('');

  console.log('── 見出しの例（各カテゴリ最大3件）──');
  console.log('  ※ ニュース見出しは公開情報。タスクの中身は一切読んでいません');
  for (const src of SOURCES) {
    const list = usable.filter((c) => c.key === src.key).slice(0, 3);
    if (!list.length) continue;
    console.log(`  【${src.key}】`);
    for (const c of list) console.log(`    ・${c.title}`);
  }

  await writeFile('collected-sources.json', JSON.stringify({
    collectedAt: new Date().toISOString(),
    maxAgeDays: MAX_AGE_DAYS,
    counts: { raw: collected.length, afterExclusion: filtered.length, resolved, usable: usable.length },
    items: usable.map((c) => ({ category: c.category, icon: c.icon, key: c.key, title: c.title, url: c.url, pubDate: c.pubDate })),
  }, null, 2));

  console.log(`\n📦 collected-sources.json に ${usable.length}件を保存（artifact で持ち帰れます）`);
  console.log('=== 収集完了・課金は発生していません（$0）===');
}

main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });
