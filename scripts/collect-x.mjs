// X（Twitter）から recs の材料を集める。読み取りのみ・Firebaseには書かない・API課金なし。
//
// ★X API は使わない★
// X API は 2026-02 に無料枠が廃止され、投稿の読み取りは $0.005/件 の従量課金になった。
// ここで使うのは Web クライアントと同じ経路で、自分のログイン済みセッションで読む。
// 自分のアカウントで自分が見られるものを見るだけなので、未認証アクセスではない。
//
// ★2つの取り方を用意して、通ったほうを使う★
// 2026-08-16 に Actions ランナーから実測した結果:
//   x.com 検索ページ  … 200 だが JS シェルのみ（投稿リンクなし・ログイン壁の目印あり）
//   x.com プロフィール … ✅ 未認証でも投稿リンクが取れる
//   syndication       … 429
//   nitter.net        … 0バイト（機能していない）
// つまり塞がれているのは「検索」だけ。so:
//   A) 検索        … Cookie が要る。X_AUTH_TOKEN / X_CT0 があれば試す
//   B) プロフィール … Cookie 不要。特定アカウントの新着を拾う
// A が通らなくても B だけで材料は集まるので、鍵なしでも動く。
//
// ★静かにゼロ件になるのを防ぐ★
// X はこの種の経路を継続的に塞ぐ。壊れたときに「今日は何も無かった」と
// 区別がつかないのが一番まずいので、方式ごとの成否と件数を必ず出す。
//
// 実行: node scripts/collect-x.mjs

import { writeFile } from 'node:fs/promises';

const AUTH_TOKEN = process.env.X_AUTH_TOKEN || '';
const CT0 = process.env.X_CT0 || '';
const HAS_COOKIE = Boolean(AUTH_TOKEN && CT0);

// X の Web クライアントが使う公開ベアラ。秘密情報ではなく、誰のブラウザでも同じ値。
const WEB_BEARER = process.env.X_BEARER
  || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL の queryId は X 側の更新で変わる。変わったら 404 になるので、
// 環境変数で差し替えられるようにしておく（ここを直すだけで復旧できる）。
const SEARCH_QUERY_ID = process.env.X_SEARCH_QUERY_ID || 'nK1dw4oV3k4w5TdtcAdSww';

const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 14);
const PER_QUERY = Number(process.env.X_PER_QUERY || 20);

// 検索語と、拾いたいアカウント。アカウントは「告知が流れてくる場所」を選ぶ。
const TOPICS = [
  {
    key: 'ポイ活', category: 'お金', icon: '💰',
    queries: ['ポイ活 キャンペーン 還元 -is:retweet', 'キャッシュバック キャンペーン 開始'],
    accounts: ['payannounce', 'rakutenpay'],
    must: ['キャンペーン', '還元', 'ポイント', 'キャッシュバック', '増量'],
  },
  {
    key: 'クリプト', category: 'お金', icon: '🪙',
    queries: ['エアドロップ 配布 キャンペーン', '暗号資産 取引所 キャンペーン'],
    accounts: ['bitbank_inc', 'coincheckjp'],
    must: ['キャンペーン', 'エアドロップ', '配布', '付与', '上場'],
  },
  {
    key: 'サウナ', category: 'おでかけ', icon: '♨️',
    queries: ['サウナ 新店 オープン', 'サウナ オープン 東京'],
    accounts: ['saunaikitai'],
    must: ['サウナ', 'ととのい', '温浴', 'スパ'],
  },
  {
    key: 'テック', category: 'キャリア・学び', icon: '💻',
    queries: ['カンファレンス 開催 エンジニア', 'ハッカソン 募集'],
    accounts: ['connpass'],
    must: ['カンファレンス', '勉強会', 'ハッカソン', 'イベント', '登壇', '募集'],
  },
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function authHeaders() {
  const h = {
    'User-Agent': UA,
    'Accept-Language': 'ja,en;q=0.8',
    authorization: `Bearer ${decodeURIComponent(WEB_BEARER)}`,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'ja',
  };
  if (HAS_COOKIE) {
    h.cookie = `auth_token=${AUTH_TOKEN}; ct0=${CT0}`;
    h['x-csrf-token'] = CT0;
    h['x-twitter-auth-type'] = 'OAuth2Session';
  }
  return h;
}

async function get(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── A) 検索（Cookie が要る）──
async function searchX(query) {
  const variables = {
    rawQuery: query,
    count: PER_QUERY,
    querySource: 'typed_query',
    product: 'Latest', // 新着順。人気順だと古い告知が上に来る
  };
  const features = {
    responsive_web_graphql_timeline_navigation_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    longform_notetweets_rich_text_read_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };
  const url = `https://x.com/i/api/graphql/${SEARCH_QUERY_ID}/SearchTimeline`
    + `?variables=${encodeURIComponent(JSON.stringify(variables))}`
    + `&features=${encodeURIComponent(JSON.stringify(features))}`;

  const res = await get(url, authHeaders());
  if (!res.ok) return { ok: false, status: res.status, items: [] };
  try {
    return { ok: true, status: res.status, items: extractFromGraphql(JSON.parse(res.text)) };
  } catch {
    return { ok: false, status: res.status, items: [] };
  }
}

// GraphQL の入れ子は版によって変わるので、決め打ちで辿らずに
// 「legacy を持つオブジェクト」を再帰で拾う。多少の構造変更なら耐える。
function extractFromGraphql(root) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const lg = node.legacy;
    if (lg && (lg.full_text || lg.text) && (lg.id_str || node.rest_id)) {
      const id = lg.id_str || node.rest_id;
      if (!seen.has(id)) {
        seen.add(id);
        const handle = node.core?.user_results?.result?.legacy?.screen_name
          || node.core?.screen_name || '';
        out.push({
          id,
          text: String(lg.full_text || lg.text),
          createdAt: lg.created_at || '',
          handle,
          likes: Number(lg.favorite_count || 0),
          reposts: Number(lg.retweet_count || 0),
        });
      }
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(root);
  return out;
}

// ── B) プロフィール（Cookie 不要。実測で通ることを確認済み）──
async function fetchProfile(handle) {
  const res = await get(`https://x.com/${handle}`, authHeaders());
  if (!res.ok) return { ok: false, status: res.status, items: [] };
  // 埋め込まれた JSON から本文と ID を拾う
  const items = [];
  const seen = new Set();
  const re = /"full_text":"((?:[^"\\]|\\.)*)"/g;
  const ids = res.text.match(/"id_str":"(\d{8,})"/g) || [];
  let m;
  let i = 0;
  while ((m = re.exec(res.text)) !== null) {
    const idm = ids[i] && ids[i].match(/\d{8,}/);
    i += 1;
    const id = idm ? idm[0] : `${handle}-${i}`;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      items.push({ id, text: JSON.parse(`"${m[1]}"`), createdAt: '', handle, likes: 0, reposts: 0 });
    } catch { /* エスケープが壊れているものは飛ばす */ }
  }
  return { ok: true, status: res.status, items };
}

const norm = (s) => s.toLowerCase().replace(/[\s　"'“”‘’|｜・,、。．.]/g, '');

function withinAge(createdAt) {
  if (!createdAt) return true;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) / 86400000 <= MAX_AGE_DAYS;
}

// 投稿本文はそのままだと rec のタイトルに長すぎる。1行目を見出しとして使う。
function toTitle(text) {
  const first = text.split('\n').map((s) => s.trim()).find((s) => s.length >= 6) || text.trim();
  return first.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

async function main() {
  console.log('=== X から recs の材料を収集（読み取りのみ・X API不使用・課金なし）===');
  console.log(`Cookie: ${HAS_COOKIE ? 'あり（検索も試す）' : 'なし（プロフィールのみ）'}`);
  console.log(`対象期間: 直近 ${MAX_AGE_DAYS} 日\n`);

  const collected = [];
  const seen = new Set();
  const report = [];

  for (const topic of TOPICS) {
    let viaSearch = 0;
    let viaProfile = 0;
    const failures = [];

    if (HAS_COOKIE) {
      for (const q of topic.queries) {
        const r = await searchX(q);
        if (!r.ok) { failures.push(`検索 status ${r.status}`); continue; }
        for (const it of r.items) {
          if (!withinAge(it.createdAt)) continue;
          const title = toTitle(it.text);
          const key = norm(title);
          if (!key || seen.has(key)) continue;
          if (!topic.must.some((w) => it.text.includes(w))) continue;
          seen.add(key);
          collected.push({ ...pick(topic), title, url: `https://x.com/i/status/${it.id}`, via: 'search', likes: it.likes });
          viaSearch += 1;
        }
      }
    }

    for (const handle of topic.accounts) {
      const r = await fetchProfile(handle);
      if (!r.ok) { failures.push(`@${handle} status ${r.status}`); continue; }
      for (const it of r.items) {
        const title = toTitle(it.text);
        const key = norm(title);
        if (!key || seen.has(key)) continue;
        if (!topic.must.some((w) => it.text.includes(w))) continue;
        seen.add(key);
        collected.push({ ...pick(topic), title, url: `https://x.com/${handle}/status/${it.id}`, via: 'profile', likes: 0 });
        viaProfile += 1;
      }
    }

    report.push({ key: topic.key, viaSearch, viaProfile, failures });
  }

  console.log('── 方式別の取得件数 ──');
  for (const r of report) {
    console.log(`  ${r.key.padEnd(6, '　')} 検索 ${String(r.viaSearch).padStart(3)}件 / プロフィール ${String(r.viaProfile).padStart(3)}件`);
    for (const f of r.failures) console.log(`      ⚠️ ${f}`);
  }

  const totalSearch = report.reduce((a, r) => a + r.viaSearch, 0);
  const totalProfile = report.reduce((a, r) => a + r.viaProfile, 0);
  console.log(`\n  合計 ${collected.length}件（検索 ${totalSearch} / プロフィール ${totalProfile}）\n`);

  // ★静かにゼロ件で終わらせない★
  if (!collected.length) {
    console.error('❌ 1件も取れていません。X 側の仕様変更か Cookie の失効が疑われます。');
    console.error('   ・検索が全滅 → X_AUTH_TOKEN / X_CT0 の失効、または X_SEARCH_QUERY_ID の変更');
    console.error('   ・プロフィールも全滅 → X が未認証アクセスを塞いだ可能性');
    process.exit(1);
  }
  if (HAS_COOKIE && totalSearch === 0) {
    console.warn('⚠️ Cookie はあるのに検索が0件。失効か queryId の変更が疑われます（プロフィール分だけ使います）');
  }

  console.log('── 見出しの例（各カテゴリ最大3件）──');
  for (const topic of TOPICS) {
    const list = collected.filter((c) => c.key === topic.key).slice(0, 3);
    if (!list.length) continue;
    console.log(`  【${topic.key}】`);
    for (const c of list) console.log(`    ・${c.title}`);
  }

  await writeFile('collected-x.json', JSON.stringify({
    collectedAt: new Date().toISOString(),
    counts: { total: collected.length, search: totalSearch, profile: totalProfile },
    items: collected,
  }, null, 2));

  console.log(`\n📦 collected-x.json に ${collected.length}件を保存`);
  console.log('=== 収集完了・課金は発生していません（$0）===');
}

const pick = (t) => ({ key: t.key, category: t.category, icon: t.icon });

main().catch((e) => { console.error('❌ 失敗:', e); process.exit(1); });
