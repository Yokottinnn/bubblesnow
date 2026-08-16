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
// ★検索語だけでは絞り込めない★
// 初回は「東京 サウナ 新店」で静岡県の道の駅、「東京 展覧会 開幕」で神社の例大祭が
// 混ざった。RSS検索は語をAND扱いしてくれないので、取ったあとに見出しで足切りする。
//   must … このいずれかを含まない見出しは捨てる（そのカテゴリの話題かどうか）
//   deny … 含んでいたら捨てる（まとめ記事・ランキング・過去の振り返りなど）
export const SOURCES = [
  {
    key: 'サウナ', category: 'おでかけ', icon: '♨️',
    queries: ['サウナ 新店 オープン', 'サウナ 東京 オープン', 'サウナ 新規オープン'],
    must: ['サウナ', 'スパ', '温浴'],
    deny: ['道の駅', 'ランキング', '選', 'まとめ'],
  },
  {
    key: 'テック', category: 'キャリア・学び', icon: '💻',
    queries: ['エンジニア カンファレンス 開催', 'テックカンファレンス 参加募集', 'エンジニア 勉強会 募集'],
    must: ['カンファレンス', '勉強会', 'イベント', 'ミートアップ', 'ハッカソン', 'セミナー'],
    deny: ['ランキング', 'サイト100'],
  },
  {
    key: 'アート', category: 'おでかけ', icon: '🎨',
    queries: ['美術館 展覧会 開幕', '東京 個展 開催', 'アート展 東京 開幕'],
    must: ['展', '美術館', 'ギャラリー', 'ミュージアム'],
    deny: ['例大祭', '祭り', '記念日', '何の日'],
  },
  {
    key: 'ポイ活', category: 'お金', icon: '💰',
    queries: ['ポイント還元 キャンペーン 開始', 'キャッシュバック キャンペーン 実施', 'ポイ活 キャンペーン 期間限定'],
    must: ['キャンペーン', '還元', 'ポイント', 'キャッシュバック'],
    deny: ['なぜ', '調べてみる', '裏技', 'まとめ'],
  },
  {
    key: 'クリプト', category: 'お金', icon: '🪙',
    queries: ['暗号資産 キャンペーン 開始', '仮想通貨 取引所 キャンペーン', 'エアドロップ 配布 開始'],
    must: ['キャンペーン', 'エアドロップ', '配布', '付与'],
    deny: ['ハッカー', '流出', '不正', '逮捕', '被害'],
  },
];

// 見出しがそのカテゴリの話題として通るか。
export function isRelevant(title, src) {
  const t = title.toLowerCase();
  if ((src.deny || []).some((w) => t.includes(w.toLowerCase()))) return false;
  return (src.must || []).some((w) => t.includes(w.toLowerCase()));
}

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
export function parseRss(xml) {
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

// ★実体参照は「16進形式」と「二重エスケープ」の両方に当たる★
// はてブの RSS は &amp;#x9759; のように二重にエスケープして返してくることがあり、
// 1回デコードしただけだと &#x9759; が残って見出しが読めない（初回の実行で実際に起きた）。
// 加えて 10進の &#123; しか見ていなかったので 16進はそのまま残っていた。
// 変化しなくなるまで（最大3回）回す。
function decodeEntitiesOnce(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

export function decodeXml(s) {
  let out = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let i = 0; i < 3; i += 1) {
    const next = decodeEntitiesOnce(out);
    if (next === out) break;
    out = next;
  }
  return out.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Google ニュースの見出しは「記事タイトル - 媒体名」の形で来る。媒体名は rec に要らない。
export function stripOutlet(title) {
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

  // ①まず通信せずに解く。/articles/ の後ろは URL-safe base64 で、
  //   その中に発行元URLが素の文字列として入っていることが多い。
  //   初回実行では 92件中 11件しか解決できず、残りはネットワーク頼みで取りこぼしていた。
  //   ここで解ければHTTPを1往復も使わないので速いし失敗もしない。
  const offline = decodeGoogleNewsLink(link);
  if (offline) return offline;

  // ②ダメならリダイレクトを追う
  const res = await fetchText(link, { timeout: 12000 });
  if (res.ok && res.url && !/^https?:\/\/news\.google\.com\//.test(res.url)) return res.url;

  // ③JSでリダイレクトする形で返ってくることがあるので、HTML から発行元URLを拾う
  const m = res.text.match(/data-n-au="(https?:\/\/(?!news\.google\.com)[^"]+)"/)
    || res.text.match(/<c-wiz[\s\S]{0,4000}?href="(https?:\/\/(?!news\.google\.com)[^"]+)"/)
    || res.text.match(/url=(https?:\/\/(?!news\.google\.com)[^"'&]+)/)
    || res.text.match(/<link[^>]+rel="canonical"[^>]+href="(https?:\/\/(?!news\.google\.com)[^"]+)"/);
  return m ? decodeXml(m[1]) : '';
}

export function decodeGoogleNewsLink(link) {
  const m = link.match(/\/(?:articles|read)\/([A-Za-z0-9_-]{16,})/);
  if (!m) return '';
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(b64, 'base64').toString('utf8');
    const u = text.match(/https?:\/\/[^\s"'<>\\ --]{8,}/);
    if (!u) return '';
    // protobuf の区切りが末尾に混ざることがあるので、URLとして妥当な範囲まで削る
    return u[0].replace(/[^\w/?=&%.:#@~+-]+$/, '');
  } catch {
    return '';
  }
}

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json${auth}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}

// index.html:213 と同じ判定。短い語での巻き込みだけ避ける。
export function isDismissed(title, dismissedTitles) {
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
    let offTopic = 0;
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
          // 検索語が緩いぶん、ここで話題の合致を見る
          if (!isRelevant(title, src)) { offTopic += 1; continue; }
          collected.push({ ...src, title, link: it.link, pubDate: it.pubDate });
        }
      }
    }
    stats.push({ key: src.key, raw, offTopic, kept: collected.filter((c) => c.key === src.key).length });
  }

  console.log('── 収集結果 ──');
  for (const s of stats) {
    console.log(`  ${s.key.padEnd(6, '　')} 生 ${String(s.raw).padStart(4)}件 → 話題ずれ ${String(s.offTopic).padStart(3)}件を除外 → ${s.kept}件`);
  }
  console.log(`  合計 ${collected.length}件\n`);

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

// テストから import したときに収集が走らないよう、直接実行のときだけ動かす。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });
}
